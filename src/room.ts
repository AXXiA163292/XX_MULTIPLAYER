import { DurableObject } from 'cloudflare:workers'
import {
    EMPTY_ROOM_TTL_MS,
    MAX_ROOM_LIFESPAN_MS,
    RESERVED_ROOM_TTL_MS,
    SCORING_MODES,
    TOURNAMENT_HOST_HANDLE,
} from './config.ts'
import {
    closeRoomForm,
    defaultCustomRoomTitle,
    normalizeCustomSongsMode,
    parseSettings,
    roomFormsForType,
    serializeSettings,
    type RoomSettings,
} from './forms.ts'
import {
    PP_CONFIGURED,
    compareResults,
    fmtDetail,
    fmtScore,
    totals,
    type RoundKind,
    type RoundRecord,
} from './scoring.ts'
import {
    getEditionData,
    pickRankedLevel,
    type EditionData,
    type RankedTier,
    type SheetChart,
} from './sheets.ts'
import type {
    Env,
    GameplayResult,
    JoinSession,
    RoomStatus,
    RoomUser,
    Sil,
    UserStatus,
} from './types.ts'

type Member = {
    id: string
    name: string
    handle: string
    roomUser: RoomUser
}

type Reservation = {
    key: string
    hostId: string
    hostName: string
    hostHandle: string
}

type LevelInfo = {
    title: string
    firstTag: string
    rating: number | null
    constant: number | null
    noteCount: number | null
    difficulty: string
}

type ConstantEntry = {
    constant: number
    difficulty?: string
}

type RoomState = {
    name: string
    createdAt: number
    edition: string
    divisions: Record<string, string>
    poolSongKeys: string[]
    primarySongKey: string
    playedSongCounts: Record<string, number>
    playedTournamentSong: boolean
    warmupCount: number
    freeplayCount: number
    reserved: Reservation | null
    configured: boolean
    hostId: string
    hostName: string
    settings: RoomSettings
    status: RoomStatus
    level: Sil | null
    levelInfo: LevelInfo | null
    levelOptions: { name: string; value: number }[]
    suggestions: { userId: string; level: Sil }[]
    members: Member[]
    statuses: Record<string, UserStatus>
    round: { state: string; seed: number } | null
    results: Record<string, GameplayResult>
    history: RoundRecord[]
}

const fresh = (): RoomState => ({
    name: '',
    createdAt: 0,
    edition: '',
    divisions: {},
    poolSongKeys: [],
    primarySongKey: '',
    playedSongCounts: {},
    playedTournamentSong: false,
    warmupCount: 0,
    freeplayCount: 0,
    reserved: null,
    configured: false,
    hostId: '',
    hostName: '',
    settings: {
        type: 'groupStage',
        scoring: 'pp',
        group: 'A',
        title: '',
        visibility: 'locked',
        random: false,
        tier: 'master',
        customSongs: 'off',
    },
    status: 'selecting',
    level: null,
    levelInfo: null,
    levelOptions: [],
    suggestions: [],
    members: [],
    statuses: {},
    round: null,
    results: {},
    history: [],
})

const isOpenType = (type: RoomSettings['type']) =>
    type === 'casualRoom' || type === 'rankedRoom'

const stripTrailingSlash = (value: string) => value.trim().replace(/\/+$/, '')

const songKeyOf = (level: Sil | null | undefined): string => {
    if (!level) return ''
    return `${stripTrailingSlash(level.address)}::${level.name.trim()}`
}

const getRoomTitle = (settings: RoomSettings, edition = '', hostName = '') => {
    if (settings.type === 'rankedRoom') {
        return String(settings.tier || 'master').toUpperCase()
    }

    if (settings.type === 'groupStage') {
        return `Group ${settings.group || 'A'}`
    }

    if (settings.type === 'casualRoom') {
        return settings.title || defaultCustomRoomTitle(hostName)
    }

    return `${edition || 'Final'} Final`
}

function sanitizeWireResult(result: GameplayResult): GameplayResult {
    const wireGrade: GameplayResult['grade'] =
        result.grade === 'allPerfect' ||
        result.grade === 'fullCombo' ||
        result.grade === 'pass' ||
        result.grade === 'fail'
            ? result.grade
            : 'fail'

    return {
        grade: wireGrade,
        arcadeScore: Number(result.arcadeScore) || 0,
        accuracyScore: Number(result.accuracyScore) || 0,
        combo: Number(result.combo) || 0,
        perfect: Number(result.perfect) || 0,
        great: Number(result.great) || 0,
        good: Number(result.good) || 0,
        miss: Number(result.miss) || 0,
        totalCount: Number(result.totalCount) || 0,
    }
}

function chartsForType(
    edition: EditionData,
    type: RoomSettings['type'],
): SheetChart[] {
    if (isOpenType(type)) return []
    return type === 'groupStage' ? edition.groupStage : edition.final
}

function suggestionsFromCharts(
    charts: SheetChart[],
    userId: string,
) {
    return charts.map((chart) => ({
        userId,
        level: {
            address: chart.address,
            name: chart.name,
        },
    }))
}

async function songPoolSuggestions(
    type: RoomSettings['type'],
    userId: string,
) {
    if (isOpenType(type)) return []

    try {
        const edition = await getEditionData()
        return suggestionsFromCharts(chartsForType(edition, type), userId)
    } catch (error) {
        console.error('Could not load tournament songs:', error)
        return []
    }
}

const localize = (value: any): string => {
    if (typeof value === 'string') return value

    if (value && typeof value === 'object') {
        if (typeof value.en === 'string') return value.en

        const first = Object.values(value).find((v) => typeof v === 'string')
        return typeof first === 'string' ? first : ''
    }

    return ''
}

function descriptionText(value: any): string {
    if (typeof value === 'string') return value

    if (Array.isArray(value)) {
        return value.map(descriptionText).join('\n')
    }

    if (value && typeof value === 'object') {
        if (typeof value.en === 'string') return value.en

        return Object.values(value)
            .filter((v) => typeof v === 'string')
            .join('\n')
    }

    return ''
}

function extractDifficulty(description: string): string {
    const match = description.match(
        /(?:^|\n)\s*Difficulty\s*(?:•|:)\s*(EASY|NORMAL|HARD|EXPERT|MASTER|APPEND)\b/i,
    )
    return match?.[1]?.toUpperCase() ?? ''
}

function extractComboCount(description: string): number | null {
    const match = description.match(
        /(?:^|\n)\s*(?:#COMBO\s*:\s*#SEPARATOR_COLON\s*:\s*|#COMBO\s*:\s*|Combo\s*(?:•|:)\s*)([\d,]+)/i,
    )
    if (!match) return null

    const value = Number(match[1].replace(/,/g, ''))
    return Number.isSafeInteger(value) && value > 0 ? value : null
}

async function lookupConstantFromR2(
    env: Env,
    level: Sil,
): Promise<ConstantEntry | null> {
    const bucket = env.POSTS_BUCKET
    if (!bucket) return null

    const normalizedAddress = stripTrailingSlash(level.address)
    const candidates = [
        normalizedAddress,
        `${normalizedAddress}/levels/${level.name}`,
        `${normalizedAddress}/sonolus/levels/${level.name}`,
    ]

    for (const key of ['server/constants/index.json', 'constants.json', 'custom-songs.json']) {
        try {
            const obj = await bucket.get(key)
            if (!obj) continue
            const parsed = await obj.json<any>()
            const raw = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed

            if (Array.isArray(raw)) {
                for (const row of raw) {
                    const rowInput = stripTrailingSlash(String(row?.input ?? row?.url ?? ''))
                    if (!rowInput) continue
                    if (candidates.includes(rowInput)) {
                        const c = Number(row?.Constant ?? row?.constant)
                        if (Number.isFinite(c) && c > 0) {
                            return {
                                constant: Math.round(c * 10) / 10,
                                difficulty: typeof row?.Difficulty === 'string'
                                    ? row.Difficulty.toUpperCase()
                                    : typeof row?.difficulty === 'string'
                                        ? row.difficulty.toUpperCase()
                                        : undefined,
                            }
                        }
                    }
                }
            } else if (raw && typeof raw === 'object') {
                for (const cand of candidates) {
                    const entry = raw[cand]
                    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) {
                        return { constant: Math.round(entry * 10) / 10 }
                    }
                    if (entry && typeof entry === 'object') {
                        const c = Number(entry.Constant ?? entry.constant)
                        if (Number.isFinite(c) && c > 0) {
                            return {
                                constant: Math.round(c * 10) / 10,
                                difficulty: typeof entry.difficulty === 'string'
                                    ? entry.difficulty.toUpperCase()
                                    : undefined,
                            }
                        }
                    }
                }
            }
        } catch {
            // Ignore malformed constant table in R2.
        }
    }

    return null
}

async function fetchLevelInfo(level: Sil, env: Env): Promise<LevelInfo | null> {
    const r2Constant = await lookupConstantFromR2(env, level)

    try {
        const base = new URL(level.address)

        if (
            (base.protocol !== 'https:' && base.protocol !== 'http:') ||
            base.username ||
            base.password
        ) {
            return r2Constant
                ? {
                    title: level.name,
                    firstTag: r2Constant.difficulty ?? '',
                    rating: r2Constant.constant,
                    constant: r2Constant.constant,
                    noteCount: null,
                    difficulty: r2Constant.difficulty ?? '',
                }
                : null
        }

        const encodedName = encodeURIComponent(level.name)
        const root = base.toString().replace(/\/+$/, '')

        const paths = root.endsWith('/sonolus')
            ? [
                `${root}/levels/${encodedName}`,
                `${root}/sonolus/levels/${encodedName}`,
            ]
            : [
                `${root}/sonolus/levels/${encodedName}`,
                `${root}/levels/${encodedName}`,
            ]

        for (const path of paths) {
            try {
                const response = await fetch(path, {
                    headers: {
                        Accept: 'application/json',
                        'Cache-Control': 'no-cache',
                    },
                    cache: 'no-store',
                    signal: AbortSignal.timeout(8000),
                })

                if (!response.ok) continue

                const data: any = await response.json()
                const item = data.item ?? data
                if (!item || typeof item !== 'object') continue

                const description = descriptionText(data.description ?? item.description)

                const difficultyTags = Array.isArray(item.tags)
                    ? item.tags
                        .map((tag: any) => localize(tag?.title).trim())
                        .filter((tag: string) =>
                            /^(EASY|NORMAL|HARD|EXPERT|MASTER|APPEND)\b/i.test(tag),
                        )
                    : []

                const taggedDifficulty = difficultyTags[0] ?? ''
                const difficulty =
                    extractDifficulty(description) ||
                    taggedDifficulty.toUpperCase().match(
                        /EASY|NORMAL|HARD|EXPERT|MASTER|APPEND/,
                    )?.[0] ||
                    r2Constant?.difficulty ||
                    ''

                const firstTag = difficulty || taggedDifficulty
                const noteCount = extractComboCount(description)

                const rawRating = item.rating
                const parsedRating = typeof rawRating === 'number'
                    ? rawRating
                    : typeof rawRating === 'string'
                        ? Number(rawRating)
                        : NaN

                const rating = Number.isFinite(parsedRating) && parsedRating > 0
                    ? Math.round(parsedRating * 10) / 10
                    : null

                const constant = r2Constant?.constant ?? rating

                return {
                    title: localize(item.title) || level.name,
                    firstTag: difficulty || firstTag,
                    rating,
                    constant,
                    noteCount,
                    difficulty,
                }
            } catch (error) {
                console.warn('Could not fetch level metadata:', path, error)
            }
        }
    } catch (error) {
        console.warn('Invalid level address:', level.address, error)
    }

    if (r2Constant) {
        return {
            title: level.name,
            firstTag: r2Constant.difficulty ?? '',
            rating: r2Constant.constant,
            constant: r2Constant.constant,
            noteCount: null,
            difficulty: r2Constant.difficulty ?? '',
        }
    }

    return null
}

type Ev = Record<string, unknown>
type Cmd = Record<string, any>

const isSil = (x: any): x is Sil =>
    !!x &&
    typeof x.address === 'string' &&
    typeof x.name === 'string'

const isNum = (x: unknown): x is number =>
    typeof x === 'number' &&
    Number.isFinite(x) &&
    x >= 0

const isResult = (r: any): r is GameplayResult =>
    !!r &&
    ['allPerfect', 'fullCombo', 'pass', 'fail', 'X'].includes(r.grade) &&
    [
        r.arcadeScore,
        r.accuracyScore,
        r.combo,
        r.perfect,
        r.great,
        r.good,
        r.miss,
        r.totalCount,
    ].every(isNum)

function isRoomStatus(value: unknown): value is RoomStatus {
    return ['selecting', 'preparing', 'playing'].includes(String(value))
}

function isUserStatus(value: unknown): value is UserStatus {
    return ['waiting', 'ready', 'skipped', 'playing'].includes(String(value))
}

function cleanDivisions(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {}
    }

    const result: Record<string, string> = {}

    for (const [handle, division] of Object.entries(value)) {
        if (
            typeof handle === 'string' &&
            typeof division === 'string' &&
            division.trim()
        ) {
            result[handle.trim()] = division.trim()
        }
    }

    return result
}

export class Room extends DurableObject<Env> {
    st: RoomState = fresh()

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)

        ctx.blockConcurrencyWhile(async () => {
            const saved = await ctx.storage.get<Partial<RoomState>>('st')
            const base = fresh()

            this.st = {
                ...base,
                ...(saved ?? {}),
                createdAt: typeof saved?.createdAt === 'number' && saved.createdAt > 0
                    ? saved.createdAt
                    : Date.now(),
                settings: {
                    ...base.settings,
                    ...(saved?.settings ?? {}),
                },
                edition: typeof saved?.edition === 'string' ? saved.edition : '',
                divisions: cleanDivisions(saved?.divisions),
                poolSongKeys: Array.isArray(saved?.poolSongKeys)
                    ? saved.poolSongKeys.filter((k): k is string => typeof k === 'string')
                    : [],
                primarySongKey: typeof saved?.primarySongKey === 'string'
                    ? saved.primarySongKey
                    : '',
                playedSongCounts: saved?.playedSongCounts && typeof saved.playedSongCounts === 'object'
                    ? saved.playedSongCounts as Record<string, number>
                    : {},
                playedTournamentSong: saved?.playedTournamentSong === true,
                warmupCount: typeof saved?.warmupCount === 'number' ? saved.warmupCount : 0,
                freeplayCount: typeof saved?.freeplayCount === 'number' ? saved.freeplayCount : 0,
                reserved: saved?.reserved ?? null,
                configured: saved?.configured === true,
                hostId: typeof saved?.hostId === 'string' ? saved.hostId : '',
                hostName: typeof saved?.hostName === 'string' ? saved.hostName : '',
                status: isRoomStatus(saved?.status) ? saved.status : 'selecting',
                level: saved?.level && isSil(saved.level) ? saved.level : null,
                levelInfo: saved?.levelInfo ?? null,
                levelOptions: Array.isArray(saved?.levelOptions)
                    ? saved.levelOptions.filter(
                        (x) =>
                            x &&
                            typeof x.name === 'string' &&
                            typeof x.value === 'number' &&
                            Number.isFinite(x.value),
                    )
                    : [],
                suggestions: Array.isArray(saved?.suggestions)
                    ? saved.suggestions.filter(
                        (x) =>
                            x &&
                            typeof x.userId === 'string' &&
                            isSil(x.level),
                    )
                    : [],
                members: Array.isArray(saved?.members)
                    ? saved.members.filter(
                        (x) =>
                            x &&
                            typeof x.id === 'string' &&
                            typeof x.name === 'string' &&
                            typeof x.handle === 'string' &&
                            x.roomUser &&
                            typeof x.roomUser.authentication === 'string' &&
                            typeof x.roomUser.signature === 'string',
                    )
                    : [],
                statuses: saved?.statuses && typeof saved.statuses === 'object'
                    ? Object.fromEntries(
                        Object.entries(saved.statuses).filter(
                            ([, value]) => isUserStatus(value),
                        ),
                    ) as Record<string, UserStatus>
                    : {},
                results: saved?.results && typeof saved.results === 'object'
                    ? Object.fromEntries(
                        Object.entries(saved.results).filter(
                            ([, value]) => isResult(value),
                        ),
                    )
                    : {},
                history: Array.isArray(saved?.history) ? saved.history : [],
                round: saved?.round &&
                    typeof saved.round.state === 'string' &&
                    typeof saved.round.seed === 'number'
                    ? saved.round
                    : null,
            }

            this.st.settings.group ||= 'A'
            this.st.settings.title ??= ''
            this.st.settings.random = this.st.settings.random === true

            if (!['public', 'private', 'locked'].includes(this.st.settings.visibility)) {
                this.st.settings.visibility =
                    this.st.settings.type === 'casualRoom' ? 'public' : 'locked'
            }

            if (!['groupStage', 'final', 'casualRoom', 'rankedRoom'].includes(this.st.settings.type)) {
                this.st.settings.type = 'casualRoom'
            }

            if (!['master', 'diamond', 'platinum', 'gold', 'silver', 'bronze', 'beginner'].includes(this.st.settings.tier)) {
                this.st.settings.tier = 'master'
            }

            this.st.settings.customSongs = normalizeCustomSongsMode(this.st.settings.customSongs)

            if (this.st.settings.type === 'rankedRoom') {
                this.st.settings.scoring = 'rankedMatch'
                this.st.settings.visibility = 'public'
                this.st.settings.random = false
            }

            if (!this.st.hostName && this.st.hostId) {
                const hostMember = this.st.members.find((m) => m.id === this.st.hostId)
                if (hostMember?.name) this.st.hostName = hostMember.name
            }

            if (this.st.status === 'selecting' && this.st.suggestions.length === 0 && this.st.hostId) {
                this.st.suggestions = await songPoolSuggestions(this.st.settings.type, this.st.hostId)
                this.st.poolSongKeys = this.st.suggestions.map((s) => songKeyOf(s.level)).filter(Boolean)
                if (!this.st.primarySongKey && this.st.poolSongKeys.length > 0) {
                    this.st.primarySongKey = this.st.poolSongKeys[0]!
                }
                if (!this.st.level && this.st.suggestions.length > 0) {
                    this.st.level = this.st.suggestions[0]!.level
                }
            }

            this.syncRoomAlarm()
        })
    }

    private syncRoomAlarm(): void {
        if (!this.st.name || !this.st.createdAt) return
        const deadline = this.st.createdAt + MAX_ROOM_LIFESPAN_MS
        void this.ctx.storage.setAlarm(deadline)
    }

    async alarm(): Promise<void> {
        if (this.st.round && this.st.status === 'playing') {
            this.syncRoomAlarm()
            return
        }

        if (Date.now() - this.st.createdAt < MAX_ROOM_LIFESPAN_MS) {
            this.syncRoomAlarm()
            return
        }

        this.st.members = []
        this.st.statuses = {}
        this.st.round = null
        await this.ctx.storage.deleteAll()
        await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).remove(this.st.name).catch(() => {})
    }

    private save() {
        this.syncRoomAlarm()
        void this.ctx.storage.put('st', this.st)
        void this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).upsert({
            name: this.st.name,
            title: getRoomTitle(this.st.settings, this.st.edition, this.st.hostName),
            subtitle: `${this.st.members.length} players • ${SCORING_MODES[this.st.settings.scoring]}`,
            master: this.st.hostId,
            hostId: this.st.hostId,
            visibility: this.st.settings.visibility,
        })
    }

    async reserve(name: string, r: Reservation) {
        if (!this.st.createdAt) {
            this.st.createdAt = Date.now()
        }
        this.st.name = name
        this.st.reserved = r
        this.st.hostId = r.hostId
        this.st.hostName = r.hostName
        this.save()
    }

    async configure(
        key: string,
        settings: RoomSettings,
        host?: { id: string; name?: string; handle?: string },
    ): Promise<boolean> {
        if (!this.st.reserved || this.st.reserved.key !== key) return false
        if (!isOpenType(settings.type) && host?.handle !== TOURNAMENT_HOST_HANDLE) {
            return false
        }

        const effectiveHostName = host?.name || this.st.reserved.hostName || this.st.hostName
        this.st.configured = true
        this.st.hostId = host?.id || this.st.reserved.hostId
        this.st.hostName = effectiveHostName
        this.st.settings = {
            ...settings,
            title: settings.type === 'casualRoom'
                ? (settings.title || defaultCustomRoomTitle(effectiveHostName))
                : settings.title,
        }

        if (!isOpenType(settings.type)) {
            try {
                const edition = await getEditionData()
                this.st.edition = edition.edition
                this.st.divisions = cleanDivisions(edition.divisions)
                const charts = chartsForType(edition, settings.type)
                this.st.suggestions = suggestionsFromCharts(charts, this.st.hostId)
                this.st.poolSongKeys = this.st.suggestions.map((s) => songKeyOf(s.level)).filter(Boolean)
                this.st.primarySongKey = this.st.poolSongKeys[0] ?? ''
                this.st.level = this.st.suggestions[0]?.level ?? null
            } catch (error) {
                console.error('Could not load tournament edition:', error)
            }
        } else if (settings.type === 'rankedRoom') {
            const picked = await pickRankedLevel(
                settings.tier as RankedTier,
                settings.customSongs,
                this.env,
            )
            this.st.level = picked
                ? { address: picked.address, name: picked.name }
                : null
        }

        this.st.reserved = null
        this.save()
        return true
    }

    async canJoin(user: { id: string; handle?: string }): Promise<string | null> {
        if (!this.st.configured) return 'Room is not ready.'
        if (Date.now() - this.st.createdAt >= MAX_ROOM_LIFESPAN_MS) {
            return 'Room has expired.'
        }
        if (
            this.st.settings.visibility === 'locked' &&
            user.id !== this.st.hostId &&
            user.handle !== TOURNAMENT_HOST_HANDLE
        ) {
            return 'Room is locked.'
        }
        return null
    }

    async summary() {
        return {
            name: this.st.name,
            title: getRoomTitle(this.st.settings, this.st.edition, this.st.hostName),
            subtitle: `${this.st.members.length} players • ${SCORING_MODES[this.st.settings.scoring]}`,
            master: this.st.hostId,
        }
    }

    private member(userId: string) {
        return this.st.members.find((m) => m.id === userId)
    }

    private isHost(userId: string) {
        return Boolean(userId && userId === this.st.hostId)
    }

    private sockets = new Map<WebSocket, string>()

    private send(ws: WebSocket, ev: Ev) {
        try {
            ws.send(JSON.stringify(ev))
        } catch {
            // Ignore closed socket.
        }
    }

    private broadcast(ev: Ev) {
        const msg = JSON.stringify(ev)
        for (const ws of this.sockets.keys()) {
            try {
                ws.send(msg)
            } catch {
                // Ignore closed socket.
            }
        }
    }

    private syncRoom() {
        this.broadcast({
            type: 'roomState',
            state: this.roomState(),
        })
    }

    private syncUsers() {
        this.broadcast({
            type: 'roomUsers',
            users: this.st.members.map((m) => ({
                user: m.roomUser,
                status: this.st.statuses[m.id] ?? 'waiting',
            })),
        })
    }

    private roomState() {
        return {
            title: getRoomTitle(this.st.settings, this.st.edition, this.st.hostName),
            master: this.st.hostId,
            lead: this.st.hostId,
            status: this.st.status,
            options: serializeSettings(this.st.settings, this.st.hostName),
            level: this.st.level ?? { address: '', name: '' },
            levelOptions: this.st.levelOptions,
            suggestions: this.st.suggestions,
        }
    }

    private userDivisionLabel(handle: string): string | null {
        const division = this.st.divisions[handle]
        if (!division) return null

        if (this.st.settings.type === 'groupStage') {
            return division.startsWith('Group ') ? division : null
        }

        if (this.st.settings.type === 'final') {
            return division === 'Upper Bracket' || division === 'Lower Bracket'
                ? division
                : null
        }

        return null
    }

    private formatPlayerName(member: Member): string {
        const division = this.userDivisionLabel(member.handle)
        return division ? `${member.name} [${division}]` : member.name
    }

    private classifyNextRound(level: Sil | null): {
        roundKind: RoundKind
        roundLabel: string
        countsTowardScore: boolean
        isReplay: boolean
    } {
        const key = songKeyOf(level)
        const priorCount = key ? (this.st.playedSongCounts[key] ?? 0) : 0
        const isReplay = priorCount > 0

        if (this.st.settings.type === 'casualRoom') {
            if (this.st.settings.random) {
                const idx = ++this.st.warmupCount
                return {
                    roundKind: 'warmup',
                    roundLabel: `Warmup - Round ${idx}`,
                    countsTowardScore: false,
                    isReplay,
                }
            }

            if (this.st.settings.scoring === 'pp') {
                const idx = ++this.st.freeplayCount
                return {
                    roundKind: 'freeplay',
                    roundLabel: `Freeplay • Round ${idx}`,
                    countsTowardScore: true,
                    isReplay,
                }
            }
        }

        const tournamentNumber = this.st.history.filter(
            (r) => r.roundKind === 'tournament' || r.roundKind === 'rewind',
        ).length + 1

        if (isReplay) {
            return {
                roundKind: 'rewind',
                roundLabel: `Round ${tournamentNumber} - Rewind`,
                countsTowardScore: true,
                isReplay: true,
            }
        }

        return {
            roundKind: 'tournament',
            roundLabel: `Round ${tournamentNumber}`,
            countsTowardScore: true,
            isReplay: false,
        }
    }

    private scoreboardRows(mode: RoomSettings['scoring'], round?: RoundRecord) {
        if (!round) {
            return totals(this.st.history, mode).map((t) => {
                const m = this.member(t.userId)
                return {
                    user: m?.roomUser ?? { authentication: '', signature: '' },
                    title: m ? this.formatPlayerName(m) : t.userId,
                    score: fmtScore(t.score, mode),
                }
            })
        }

        return Object.entries(round.results)
            .sort(([, a], [, b]) => compareResults(a, b, mode, round))
            .map(([userId, r]) => {
                const m = this.member(userId)
                return {
                    user: m?.roomUser ?? { authentication: '', signature: '' },
                    title: m ? this.formatPlayerName(m) : userId,
                    score: fmtDetail(r, mode, round),
                }
            })
    }

    private scoreboard(mode: RoomSettings['scoring'], round?: RoundRecord) {
        const rows = this.scoreboardRows(mode, round)
        const sectionTitle = round?.roundLabel
            ? `              ${round.roundLabel}              `
            : '              Standings              '

        return [
            {
                title: sectionTitle,
                description: '',
                hasInfluence: false,
                users: rows.map((row) => ({
                    user: row.user,
                    score: row.score,
                })),
            },
        ]
    }

    private async handleCommand(userId: string, cmd: Cmd) {
        if (!cmd || typeof cmd.type !== 'string') return

        if (cmd.type === 'selectLevel') {
            if (!this.isHost(userId) || this.st.status !== 'selecting') return
            if (!isSil(cmd.level)) return

            if (this.st.settings.type === 'casualRoom' && this.st.settings.random) {
                return
            }

            this.st.level = { address: cmd.level.address, name: cmd.level.name }
            this.st.levelInfo = await fetchLevelInfo(this.st.level, this.env)
            this.save()
            this.syncRoom()
            return
        }

        if (cmd.type === 'suggestLevel') {
            if (!isSil(cmd.level)) return
            if (this.st.settings.type !== 'casualRoom') return
            if (this.st.settings.random) return

            this.st.suggestions = [
                ...this.st.suggestions.filter((s) => !(s.userId === userId && songKeyOf(s.level) === songKeyOf(cmd.level))),
                { userId, level: { address: cmd.level.address, name: cmd.level.name } },
            ]
            this.save()
            this.syncRoom()
            return
        }

        if (cmd.type === 'updateOptions') {
            if (!this.isHost(userId) || this.st.status !== 'selecting') return
            const hostMember = this.member(userId)
            const next = parseSettings(
                String(cmd.options ?? ''),
                this.st.settings,
                hostMember?.name || this.st.hostName,
            )
            if (!next) return

            // Type is locked after room creation.
            next.type = this.st.settings.type
            if (next.type === 'rankedRoom') {
                next.scoring = 'rankedMatch'
                next.visibility = 'public'
                next.random = false
            }

            this.st.settings = next
            if (next.type === 'rankedRoom') {
                const picked = await pickRankedLevel(
                    next.tier as RankedTier,
                    next.customSongs,
                    this.env,
                )
                this.st.level = picked ? { address: picked.address, name: picked.name } : null
            }

            this.save()
            this.syncRoom()
            return
        }

        if (cmd.type === 'ready') {
            if (this.st.status !== 'selecting') return
            this.st.statuses[userId] = 'ready'
            this.save()
            this.syncUsers()
            return
        }

        if (cmd.type === 'cancelReady') {
            if (this.st.status !== 'selecting') return
            this.st.statuses[userId] = 'waiting'
            this.save()
            this.syncUsers()
            return
        }

        if (cmd.type === 'startRound') {
            if (!this.isHost(userId) || this.st.status !== 'selecting') return

            if (this.st.settings.type === 'rankedRoom') {
                const picked = await pickRankedLevel(
                    this.st.settings.tier as RankedTier,
                    this.st.settings.customSongs,
                    this.env,
                )
                if (picked) {
                    this.st.level = { address: picked.address, name: picked.name }
                }
            }

            if (!this.st.level) return

            this.st.levelInfo = await fetchLevelInfo(this.st.level, this.env)
            this.st.status = 'preparing'
            this.st.results = {}
            this.st.round = {
                state: 'preparing',
                seed: Math.floor(Math.random() * 1_000_000_000),
            }

            for (const m of this.st.members) {
                this.st.statuses[m.id] = 'playing'
            }

            this.save()
            this.syncUsers()
            this.broadcast({
                type: 'startRound',
                level: this.st.level,
                seed: this.st.round.seed,
            })
            return
        }

        if (cmd.type === 'finishResult') {
            if (!isResult(cmd.result)) return
            const isDisqualified =
                cmd.result.grade === 'X' || cmd.result.disqualified === true
            const storedResult: GameplayResult = {
                ...sanitizeWireResult(cmd.result),
                grade: isDisqualified ? 'X' : sanitizeWireResult(cmd.result).grade,
                disqualified: isDisqualified,
                arcadeScore: isDisqualified ? 0 : sanitizeWireResult(cmd.result).arcadeScore,
                accuracyScore: isDisqualified ? 0 : sanitizeWireResult(cmd.result).accuracyScore,
            }

            this.st.results[userId] = storedResult
            this.st.statuses[userId] = 'waiting'
            this.save()
            this.syncUsers()

            const activePlayers = this.st.members.map((m) => m.id)
            const allFinished = activePlayers.every((id) => Boolean(this.st.results[id]))

            if (allFinished && this.st.status !== 'selecting') {
                const classification = this.classifyNextRound(this.st.level)
                const key = songKeyOf(this.st.level)
                if (key) {
                    this.st.playedSongCounts[key] = (this.st.playedSongCounts[key] ?? 0) + 1
                }

                const record: RoundRecord = {
                    level: this.st.level ? { ...this.st.level } : null,
                    levelTitle: this.st.levelInfo?.title,
                    levelTag: this.st.levelInfo?.firstTag,
                    levelRating: this.st.levelInfo?.rating ?? undefined,
                    levelConstant: this.st.levelInfo?.constant ?? undefined,
                    noteCount: this.st.levelInfo?.noteCount ?? undefined,
                    difficulty: this.st.levelInfo?.difficulty,
                    roundKind: classification.roundKind,
                    roundLabel: classification.roundLabel,
                    countsTowardScore: classification.countsTowardScore,
                    isReplay: classification.isReplay,
                    results: { ...this.st.results },
                }

                this.st.history.push(record)
                this.st.status = 'selecting'
                this.st.round = null

                for (const m of this.st.members) {
                    this.st.statuses[m.id] = 'waiting'
                }

                if (this.st.settings.type === 'rankedRoom') {
                    const nextPicked = await pickRankedLevel(
                        this.st.settings.tier as RankedTier,
                        this.st.settings.customSongs,
                        this.env,
                    )
                    this.st.level = nextPicked ? { address: nextPicked.address, name: nextPicked.name } : null
                }

                this.save()
                this.syncRoom()
                this.syncUsers()
                this.broadcast({
                    type: 'finishRound',
                    results: Object.fromEntries(
                        Object.entries(record.results).map(([uid, res]) => [
                            uid,
                            sanitizeWireResult(res),
                        ]),
                    ),
                    scoreboard: this.scoreboard(this.st.settings.scoring, record),
                })
            }
            return
        }

        if (cmd.type === 'kick') {
            if (!this.isHost(userId)) return
            const targetId = String(cmd.userId ?? '')
            if (!targetId || targetId === this.st.hostId) return

            this.st.members = this.st.members.filter((m) => m.id !== targetId)
            delete this.st.statuses[targetId]
            delete this.st.results[targetId]

            for (const [sock, uid] of this.sockets.entries()) {
                if (uid === targetId) {
                    try {
                        sock.close(4001, 'Kicked by host')
                    } catch {
                        // Ignore
                    }
                    this.sockets.delete(sock)
                }
            }

            this.save()
            this.syncUsers()
            return
        }

        if (cmd.type === 'closeRoom') {
            if (!this.isHost(userId)) return
            this.st.members = []
            this.st.statuses = {}
            this.st.round = null
            await this.ctx.storage.deleteAll()
            await this.env.LOBBY.get(this.env.LOBBY.idFromName('main')).remove(this.st.name).catch(() => {})
            for (const sock of this.sockets.keys()) {
                try {
                    sock.close(1000, 'Room closed')
                } catch {
                    // Ignore
                }
            }
            this.sockets.clear()
        }
    }

    async fetch(request: Request): Promise<Response> {
        const rawJoin = request.headers.get('x-join')
        if (!rawJoin) {
            return new Response('Missing join payload', { status: 400 })
        }

        let session: JoinSession
        try {
            session = JSON.parse(decodeURIComponent(rawJoin)) as JoinSession
        } catch {
            return new Response('Invalid join payload', { status: 400 })
        }

        const upgrade = request.headers.get('Upgrade')
        if (upgrade?.toLowerCase() !== 'websocket') {
            return new Response('Expected WebSocket upgrade', { status: 426 })
        }

        const pair = new WebSocketPair()
        const [client, server] = Object.values(pair)
        server.accept()

        const uid = session.user.id
        const handle = session.user.handle
        const name = session.user.name || handle

        if (!this.st.createdAt) {
            this.st.createdAt = Date.now()
        }
        if (!this.st.name) {
            this.st.name = session.room
        }
        if (!this.st.hostId) {
            this.st.hostId = uid
            this.st.hostName = name
        }

        const existing = this.member(uid)
        const roomUser: RoomUser = {
            id: uid,
            name,
            handle,
            authentication: session.roomUser?.authentication ?? '',
            signature: session.roomUser?.signature ?? '',
        }

        if (existing) {
            existing.name = name
            existing.handle = handle
            existing.roomUser = roomUser
        } else {
            this.st.members.push({
                id: uid,
                name,
                handle,
                roomUser,
            })
        }

        if (!this.st.statuses[uid]) {
            this.st.statuses[uid] = 'waiting'
        }

        if (!isOpenType(this.st.settings.type) && this.st.suggestions.length === 0 && this.st.hostId) {
            this.st.suggestions = await songPoolSuggestions(this.st.settings.type, this.st.hostId)
            this.st.poolSongKeys = this.st.suggestions.map((s) => songKeyOf(s.level)).filter(Boolean)
            if (!this.st.primarySongKey && this.st.poolSongKeys.length > 0) {
                this.st.primarySongKey = this.st.poolSongKeys[0]!
            }
            if (!this.st.level && this.st.suggestions.length > 0) {
                this.st.level = this.st.suggestions[0]!.level
            }
        }

        this.sockets.set(server, uid)
        this.save()

        this.send(server, {
            type: 'roomState',
            state: this.roomState(),
        })
        this.syncUsers()

        server.addEventListener('message', (event) => {
            void (async () => {
                try {
                    const data = JSON.parse(String(event.data))
                    await this.handleCommand(uid, data)
                } catch {
                    // Ignore malformed client message.
                }
            })()
        })

        server.addEventListener('close', () => {
            this.sockets.delete(server)
            this.st.members = this.st.members.filter((m) => m.id !== uid)
            delete this.st.statuses[uid]
            this.save()
            this.syncUsers()
        })

        return new Response(null, { status: 101, webSocket: client })
    }
}