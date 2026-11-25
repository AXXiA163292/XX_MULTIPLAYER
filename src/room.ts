import { DurableObject } from 'cloudflare:workers'
import {
    DEFAULT_OPEN_SCORING,
    DEFAULT_SCORING,
    DEFAULT_TYPE,
    RANKED_TIER_NAMES,
    ROOM_TYPES,
    SCORING_MODES,
    TOURNAMENT_HOST_HANDLE,
    type RoomType,
    type ScoringMode,
} from './config.ts'
import {
    getAvailableEditions,
    getEditionData,
    getUltimateEditionData,
    getSavedUltimatePicks,
    saveUltimatePicks,
    pickRankedLevel,
    getConstantForAddress,
    type EditionData,
    type RankedTier,
    type SheetChart,
    type UltimatePoolSong,
} from './sheets.ts'
import {
    closeRoomForm,
    defaultCustomRoomTitle,
    filterEditionsForRoomType,
    parseSettings,
    pickClosestEdition,
    ROUND_MODES,
    roomForms,
    roomFormsForType,
    serializeSettings,
    type CustomSongsMode,
    type RankedVocalType,
    type RoomSettings,
} from './forms.ts'
import {
    compareResults,
    fmtDetail,
    fmtScore,
    isPlayerX,
    PP_CONFIGURED,
    rawPpPoints,
    roundPoints,
    songKeyOf,
    totals,
    unresolvedXUsersForSong,
    type RoundKind,
    type RoundRecord,
} from './scoring.ts'
import { randomId } from './crypto.ts'
import type { Env, GameplayResult, JoinSession, Sil, UserProfile } from './types.ts'

type Member = {
    user: UserProfile
    ready: boolean
    playing: boolean
    joinedAt: number
    leaveTimer?: ReturnType<typeof setTimeout>
}

type LevelInfo = {
    title: string
    firstTag: string
    rating: number | null
    constant: number | null
    noteCount: number | null
    difficulty: string
    coverUrl: string | null
}

type State = {
    initialized: boolean
    name: string
    key: string
    hostId: string
    hostName: string
    hostHandle: string
    settings: RoomSettings
    editionOptions: string[]
    editionData: EditionData | null
    poolCharts: SheetChart[]
    ultimatePool: UltimatePoolSong[]
    ultimateFixedCharts: SheetChart[]
    rankedSongPool: SheetChart[]
    level: Sil | null
    levelInfo: LevelInfo | null
    playing: boolean
    history: RoundRecord[]
    lastResults: Record<string, GameplayResult>
    lastResultLevel: Sil | null
    lastResultRound?: RoundRecord
    lastRoundWasWarmup: boolean
    lastRoundKind?: RoundKind
    lastRoundLabel?: string
    lastRoundEligibleUserIds: string[]
}

const isOpenType = (type: RoomType) =>
    type === 'casualRoom' || type === 'rankedRoom'

const isTournamentType = (type: RoomType) =>
    type === 'groupStage' || type === 'final' || type === 'ultimateEdition'

const hasRoundControls = (type: RoomType) =>
    type === 'groupStage' || type === 'final' || type === 'ultimateEdition'

const isNum = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v)

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
        ...(r.bad === undefined ? [] : [r.bad]),
    ].every(isNum)

function sanitizeWireResult(result: GameplayResult): GameplayResult {
    const wireGrade: GameplayResult['grade'] =
        result.grade === 'allPerfect' ||
        result.grade === 'fullCombo' ||
        result.grade === 'pass' ||
        result.grade === 'fail' ||
        result.grade === 'X'
            ? result.grade
            : 'fail'

    return {
        grade: wireGrade,
        score: Number(result.score) || 0,
        accuracy: Number(result.accuracy) || 0,
        arcadeScore: Number(result.arcadeScore) || 0,
        accuracyScore: Number(result.accuracyScore) || 0,
        combo: Number(result.combo) || 0,
        perfect: Number(result.perfect) || 0,
        great: Number(result.great) || 0,
        good: Number(result.good) || 0,
        bad: Number(result.bad) || 0,
        miss: Number(result.miss) || 0,
        totalCount: Number(result.totalCount) || 0,
        disqualified: result.disqualified === true,
    }
}

const sameLevel = (a: Sil | null | undefined, b: Sil | null | undefined) =>
    !!a &&
    !!b &&
    a.address.replace(/\/+$/, '') === b.address.replace(/\/+$/, '') &&
    a.name === b.name

function localize(v: unknown): string {
    if (typeof v === 'string') return v
    if (v && typeof v === 'object') {
        const obj = v as Record<string, unknown>
        for (const key of ['en', 'default', 'ja', 'ko', 'zhs', 'zht']) {
            if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string
        }
        for (const val of Object.values(obj)) {
            if (typeof val === 'string' && val) return val
        }
    }
    return ''
}

function descriptionText(v: unknown): string {
    if (typeof v === 'string') return v
    if (Array.isArray(v)) {
        return v.map((entry) => localize(entry)).filter(Boolean).join('\n')
    }
    return localize(v)
}

function extractDifficulty(description: string): string {
    const match = description.match(/\b(APPEND|MASTER|EXPERT|HARD|NORMAL|EASY)\b/i)
    return match ? match[1]!.toUpperCase() : ''
}

function extractComboCount(description: string): number | null {
    const patterns = [
        /(?:total\s*)?(?:combo|notes?)\s*[:=\-]?\s*(\d{2,5})/i,
        /(\d{2,5})\s*(?:total\s*)?(?:combo|notes?)/i,
    ]
    for (const pattern of patterns) {
        const match = description.match(pattern)
        if (match) {
            const val = Number(match[1])
            if (Number.isFinite(val) && val > 0 && val < 20000) return val
        }
    }
    return null
}

function extractDescriptionNumber(description: string, label: string): number | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = description.match(new RegExp(`(?:^|\\n|\\s)${escaped}\\s*[:=]\\s*(\\d+(?:\\.\\d+)?)`, 'i'))
    if (!match) return null
    const val = Number(match[1])
    return Number.isFinite(val) && val > 0 ? Math.round(val * 100) / 100 : null
}

async function fetchLevelInfo(
    level: Sil,
    env?: Env,
    tournamentConstant?: number,
): Promise<LevelInfo | null> {
    try {
        const base = new URL(level.address)

        if (
            (base.protocol !== 'https:' && base.protocol !== 'http:') ||
            base.username ||
            base.password
        ) {
            return null
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

                const spreadsheetConstant = tournamentConstant == null
                    ? await getConstantForAddress(level.address, env, level.name)
                    : null

                const descriptionConstant = extractDescriptionNumber(description, 'Constant')
                const constant =
                    tournamentConstant ??
                    spreadsheetConstant ??
                    descriptionConstant ??
                    rating

                const rawCoverUrl = typeof item?.cover?.url === 'string' && item.cover.url
                    ? (item.cover.url.startsWith('/')
                        ? `${root.replace(/\/sonolus$/, '')}${item.cover.url}`
                        : item.cover.url)
                    : null

                return {
                    title: localize(item.title) || level.name,
                    firstTag: difficulty || firstTag,
                    rating,
                    constant,
                    noteCount,
                    difficulty,
                    coverUrl: rawCoverUrl,
                }
            } catch (error) {
                console.warn('Could not fetch level metadata:', path, error)
            }
        }
    } catch (error) {
        console.warn('Invalid level address:', level.address, error)
    }

    return null
}

function roundLabelFor(
    type: RoomType,
    roundKind: RoundKind,
    roundNumber: number,
    group: string,
    customLabel?: string,
): string {
    if (customLabel && customLabel.trim()) return customLabel.trim()
    if (type === 'casualRoom') return 'Freeplay'
    if (type === 'rankedRoom') return 'Ranked Match'
    if (roundKind === 'warmup') return 'Warmup'
    if (roundKind === 'freeplay') return 'Freeplay'
    if (roundKind === 'rewind') return 'Rewind'

    if (type === 'groupStage') {
        const g = (group || 'A').trim().toUpperCase()
        return `Group ${g} · Round ${roundNumber}`
    }
    if (type === 'final') {
        return `Final · Round ${roundNumber}`
    }
    if (type === 'ultimateEdition') {
        return `Ultimate · Round ${roundNumber}`
    }
    return `Round ${roundNumber}`
}

export class Room extends DurableObject<Env> {
    private st!: State
    private members = new Map<string, Member>()
    private sockets = new Map<WebSocket, string>()
    private ready: Promise<void> | null = null
    private nextRoundSeq = 1
    private roundFinished = false

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.ctx.blockConcurrencyWhile(async () => {
            const saved = await this.ctx.storage.get<State>('state')
            this.st = saved ?? this.freshState()
            if (Array.isArray(this.st.history)) {
                this.nextRoundSeq = this.st.history.length + 1
            }
        })
    }

    private freshState(): State {
        return {
            initialized: false,
            name: '',
            key: '',
            hostId: '',
            hostName: '',
            hostHandle: '',
            settings: {
                type: DEFAULT_TYPE,
                edition: '',
                scoring: DEFAULT_OPEN_SCORING,
                roundMode: 'tournament',
                group: 'A',
                title: '',
                visibility: 'public',
                random: false,
                tier: 'master',
                customSongs: 'off',
                vocalType: 'sekai',
            },
            editionOptions: [],
            editionData: null,
            poolCharts: [],
            ultimatePool: [],
            ultimateFixedCharts: [],
            rankedSongPool: [],
            level: null,
            levelInfo: null,
            playing: false,
            history: [],
            lastResults: {},
            lastResultLevel: null,
            lastResultRound: undefined,
            lastRoundWasWarmup: false,
            lastRoundKind: undefined,
            lastRoundLabel: undefined,
            lastRoundEligibleUserIds: [],
        }
    }

    private async persist() {
        await this.ctx.storage.put('state', this.st)
    }

    private lobby() {
        return this.env.LOBBY.get(this.env.LOBBY.idFromName('main'))
    }

    private async loadLevelInfo(level: Sil | null): Promise<LevelInfo | null> {
        if (!level) return null

        const tournamentChart = this.st.poolCharts.find(
            (chart) => sameLevel(level, chart),
        )

        return fetchLevelInfo(
            level,
            this.env,
            tournamentChart?.constant,
        )
    }

    private isHostUser(userId: string, handle?: string): boolean {
        if (this.st.hostId && userId === this.st.hostId) return true
        if (this.st.hostHandle && handle && handle === this.st.hostHandle) return true
        return false
    }

    private isTournamentHost(user: UserProfile): boolean {
        return user.handle === TOURNAMENT_HOST_HANDLE
    }

    private canControlRoom(user: UserProfile): boolean {
        if (isOpenType(this.st.settings.type)) {
            return this.isHostUser(user.id, user.handle)
        }
        return this.isTournamentHost(user) || this.isHostUser(user.id, user.handle)
    }

    private isPlayerUser(userId: string): boolean {
        if (isOpenType(this.st.settings.type)) return true
        return !this.isHostUser(userId)
    }

    private activePlayers(): Member[] {
        return [...this.members.values()].filter((m) => this.isPlayerUser(m.user.id))
    }

    private roomTitle(): string {
        const s = this.st.settings
        if (s.type === 'casualRoom') {
            return s.title.trim() || defaultCustomRoomTitle(this.st.hostName || this.st.hostHandle)
        }
        if (s.type === 'rankedRoom') {
            return `Ranked · ${s.tier.toUpperCase()}`
        }
        if (s.type === 'groupStage') {
            return `${s.edition} · Group ${s.group || 'A'}`
        }
        if (s.type === 'final') {
            return `${s.edition} · Final`
        }
        return `${s.edition} · Ultimate`
    }

    private roomSubtitle(): string {
        const s = this.st.settings
        const modeLabel = SCORING_MODES[s.scoring] ?? s.scoring
        const playerCount = this.activePlayers().length

        if (s.type === 'casualRoom') {
            return `${modeLabel} · ${playerCount} player${playerCount === 1 ? '' : 's'}`
        }
        if (s.type === 'rankedRoom') {
            const vocalLabel = s.vocalType === 'sekai' ? 'SEKAI' : 'VIRTUAL SINGER'
            return `${modeLabel} · ${vocalLabel} · ${playerCount} player${playerCount === 1 ? '' : 's'}`
        }
        const roundLabel = roundLabelFor(
            s.type,
            s.roundMode,
            this.nextRoundSeq,
            s.group,
        )
        return `${roundLabel} · ${modeLabel}`
    }

    private async publishLobby() {
        if (!this.st.initialized || !this.st.name) return
        if (this.st.settings.visibility === 'private') {
            await this.lobby().remove(this.st.name).catch(() => {})
            return
        }
        await this.lobby().upsert({
            name: this.st.name,
            title: this.roomTitle(),
            subtitle: this.roomSubtitle(),
            master: this.st.hostName || this.st.hostHandle || 'Host',
            visibility: this.st.settings.visibility,
            updatedAt: Date.now(),
        }).catch(() => {})
    }

    async reserve(
        name: string,
        meta: {
            key: string
            hostId: string
            hostName: string
            hostHandle: string
        },
    ) {
        this.st = {
            ...this.freshState(),
            initialized: true,
            name,
            key: meta.key,
            hostId: meta.hostId,
            hostName: meta.hostName,
            hostHandle: meta.hostHandle,
        }
        await this.persist()
    }

    async configure(
        key: string,
        settings: RoomSettings,
        host: UserProfile,
    ): Promise<boolean> {
        if (!this.st.initialized || this.st.key !== key) return false

        this.st.hostId = host.id
        this.st.hostName = host.name
        this.st.hostHandle = host.handle

        const editionOptions = await getAvailableEditions(this.env).catch((error) => {
            console.error('[ROOM CONFIG] Could not load edition options:', error)
            return [] as string[]
        })

        this.st.editionOptions = editionOptions

        if (!isOpenType(settings.type)) {
            const eligibleEditions = filterEditionsForRoomType(editionOptions, settings.type)
            if (eligibleEditions.length === 0) {
                console.error('[ROOM CONFIG] No eligible editions found:', {
                    type: settings.type,
                    editionOptions,
                })
                return false
            }

            const normalizedEdition = String(settings.edition ?? '').trim().toUpperCase()
            settings.edition = eligibleEditions.includes(normalizedEdition)
                ? normalizedEdition
                : pickClosestEdition(eligibleEditions)
        }

        this.st.settings = settings
        this.st.editionData = null
        this.st.poolCharts = []
        this.st.ultimatePool = []
        this.st.ultimateFixedCharts = []
        this.st.rankedSongPool = []

        if (settings.type === 'groupStage' || settings.type === 'final') {
            const data = await getEditionData(settings.edition, this.env).catch(() => null)
            this.st.editionData = data
            if (data) {
                this.st.poolCharts = settings.type === 'groupStage'
                    ? [...data.group1, ...data.group2]
                    : [...data.final]
            }
        } else if (settings.type === 'ultimateEdition') {
            const ult = await getUltimateEditionData(settings.edition, this.env).catch(() => null)
            if (ult) {
                this.st.ultimateFixedCharts = ult.fixedCharts
                this.st.ultimatePool = ult.pool
                this.st.poolCharts = [
                    ...ult.fixedCharts,
                    ...ult.pool.map((p) => p.chart),
                ]
            }
        } else if (settings.type === 'rankedRoom') {
            const tier = (RANKED_TIER_NAMES as readonly string[]).includes(settings.tier)
                ? settings.tier as RankedTier
                : 'master'
            const picked = await pickRankedLevel(this.env, tier, settings.customSongs)
            if (picked) {
                this.st.level = { address: picked.address, name: picked.name }
                this.st.levelInfo = await this.loadLevelInfo(this.st.level)
            }
        } else if (settings.type === 'casualRoom' && settings.random) {
            const picked = await pickRankedLevel(this.env, 'master', 'customOnly')
            if (picked) {
                this.st.level = { address: picked.address, name: picked.name }
                this.st.levelInfo = await this.loadLevelInfo(this.st.level)
            }
        }

        await this.persist()
        await this.publishLobby()
        this.broadcastState()
        return true
    }

    async summary() {
        if (!this.st.initialized || !this.st.name) return null
        return {
            name: this.st.name,
            title: this.roomTitle(),
            subtitle: this.roomSubtitle(),
            master: this.st.hostName || this.st.hostHandle || 'Host',
            visibility: this.st.settings.visibility,
        }
    }

    async isOpen(): Promise<boolean> {
        return this.st.initialized && Boolean(this.st.name)
    }

    async canJoin(user: UserProfile): Promise<string | null> {
        if (!this.st.initialized || !this.st.name) return 'Room does not exist.'
        if (this.st.playing) return 'Match is currently in progress.'
        if (
            this.st.settings.visibility === 'private' &&
            !this.isHostUser(user.id, user.handle) &&
            !this.isTournamentHost(user)
        ) {
            return 'This room is private.'
        }
        return null
    }

    async closeForOwner(userId: string): Promise<boolean> {
        if (!this.isHostUser(userId)) return false
        await this.closeRoom()
        return true
    }

    private async closeRoom() {
        for (const m of this.members.values()) {
            if (m.leaveTimer) clearTimeout(m.leaveTimer)
        }
        this.members.clear()
        if (this.st.name) {
            await this.lobby().remove(this.st.name).catch(() => {})
        }
        this.st = this.freshState()
        await this.persist()
        for (const ws of [...this.sockets.keys()]) {
            try { ws.close(1000, 'Room closed') } catch {}
        }
        this.sockets.clear()
    }

    override async fetch(req: Request): Promise<Response> {
        if (req.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 })
        }

        const rawJoin = req.headers.get('x-join')
        if (!rawJoin) return new Response('Unauthorized', { status: 401 })

        let join: JoinSession
        try {
            join = JSON.parse(decodeURIComponent(rawJoin))
        } catch {
            return new Response('Unauthorized', { status: 401 })
        }

        const pair = new WebSocketPair()
        const [client, server] = Object.values(pair)
        server.accept()

        const uid = join.user.id
        this.sockets.set(server, uid)

        const existing = this.members.get(uid)
        if (existing?.leaveTimer) {
            clearTimeout(existing.leaveTimer)
            existing.leaveTimer = undefined
        }

        this.members.set(uid, {
            user: join.user,
            ready: existing?.ready ?? false,
            playing: existing?.playing ?? false,
            joinedAt: existing?.joinedAt ?? Date.now(),
        })

        await this.publishLobby()
        this.sendTo(server, this.roomDataMessage(uid))
        this.broadcastState()

        server.addEventListener('message', (event) => {
            void this.onMessage(server, event.data)
        })

        const onClose = () => {
            this.sockets.delete(server)
            const stillConnected = [...this.sockets.values()].includes(uid)
            if (!stillConnected) {
                const member = this.members.get(uid)
                if (member) {
                    member.leaveTimer = setTimeout(() => {
                        void this.dropMember(uid)
                    }, 3000)
                }
            }
        }

        server.addEventListener('close', onClose)
        server.addEventListener('error', onClose)

        return new Response(null, { status: 101, webSocket: client })
    }

    private async dropMember(uid: string) {
        const member = this.members.get(uid)
        if (!member) return
        if (member.leaveTimer) clearTimeout(member.leaveTimer)
        this.members.delete(uid)

        if (this.st.playing && this.isPlayerUser(uid)) {
            const result: GameplayResult = {
                grade: 'X',
                score: 0,
                accuracy: 0,
                arcadeScore: 0,
                accuracyScore: 0,
                combo: 0,
                perfect: 0,
                great: 0,
                good: 0,
                bad: 0,
                miss: 0,
                totalCount: 0,
                disqualified: true,
            }
            this.st.lastResults[uid] = result
            await this.maybeFinishRound()
        }

        if (this.members.size === 0) {
            await this.closeRoom()
            return
        }

        await this.publishLobby()
        this.broadcastState()
    }

    private sendTo(ws: WebSocket, payload: unknown) {
        try {
            ws.send(JSON.stringify(payload))
        } catch {}
    }

    private broadcast(payload: unknown) {
        for (const ws of this.sockets.keys()) {
            this.sendTo(ws, payload)
        }
    }

    private broadcastState() {
        const users = [...this.members.values()].map((m) => ({
            userProfile: m.user,
            ready: m.ready,
            playing: m.playing,
        }))

        for (const [ws, uid] of this.sockets.entries()) {
            this.sendTo(ws, {
                type: 'roomState',
                master: this.st.hostId,
                users,
                level: this.st.level,
                playing: this.st.playing,
                options: this.optionsFor(uid),
            })
        }
    }

    private optionsFor(uid: string) {
        const member = this.members.get(uid)
        const user = member?.user ?? { id: uid, handle: uid, name: uid }
        const canControl = this.canControlRoom(user)

        if (!canControl) return []

        const s = this.st.settings
        const forms: any[] = []

        if (isOpenType(s.type)) {
            forms.push(...roomFormsForType(s.type, this.isTournamentHost(user), this.st.editionOptions))
        } else {
            forms.push(...roomForms(this.isTournamentHost(user), this.st.editionOptions))
        }

        if (hasRoundControls(s.type) && !this.st.playing) {
            forms.push({
                type: 'roundKind',
                title: 'Round Type',
                requireConfirmation: false,
                options: [
                    {
                        query: 'roundMode',
                        name: 'Round mode',
                        required: false,
                        type: 'select',
                        def: s.roundMode,
                        values: Object.entries(ROUND_MODES).map(([name, title]) => ({ name, title })),
                    },
                ],
            })
        }

        if (this.st.history.length > 0 && !this.st.playing) {
            forms.push({
                type: 'undoRound',
                title: 'Undo Last Round',
                icon: 'undo',
                requireConfirmation: true,
                options: [],
            })
        }

        forms.push(closeRoomForm)
        return forms
    }

    private leaderboardText(): string {
        const s = this.st.settings
        if (this.st.history.length === 0) {
            return 'No rounds played yet.'
        }

        const standings = totals(this.st.history, s.scoring)
        if (standings.length === 0) {
            return 'No scores recorded yet.'
        }

        return standings
            .map((entry, idx) => {
                const name = this.members.get(entry.userId)?.user.name || entry.userId
                return `${idx + 1}. ${name} — ${fmtScore(entry.score, s.scoring)}`
            })
            .join('\n')
    }

    private roomDataMessage(uid: string) {
        const s = this.st.settings
        const info = this.st.levelInfo
        const title = info?.title || this.st.level?.name || 'No song selected'
        const ratingPart = info?.constant != null
            ? `Const ${info.constant}`
            : info?.rating != null
                ? `Lv.${info.rating}`
                : ''
        const diffPart = info?.difficulty || info?.firstTag || ''
        const metaLine = [diffPart, ratingPart].filter(Boolean).join(' · ')

        const lines: string[] = [
            `<b>${this.roomTitle()}</b>`,
            this.st.level ? `${title}${metaLine ? ` (${metaLine})` : ''}` : 'Waiting for level selection...',
        ]

        if (s.type === 'ultimateEdition' && this.st.ultimatePool.length > 0) {
            const picks = this.st.ultimatePool.slice(0, 6).map((p) => `${p.season[0]}${p.slot}`).join(' ')
            lines.push(`Pool: ${picks}`)
        }

        if (!isOpenType(s.type) || s.scoring === 'pp') {
            lines.push(PP_CONFIGURED ? 'PP Scoring Active' : 'PP Scoring Inactive')
        }

        lines.push(this.leaderboardText())

        return {
            type: 'roomData',
            name: this.st.name,
            title: this.roomTitle(),
            cover: info?.coverUrl ? { url: info.coverUrl } : undefined,
            bgm: undefined,
            master: this.st.hostId,
            users: [...this.members.values()].map((m) => ({
                userProfile: m.user,
                ready: m.ready,
                playing: m.playing,
            })),
            level: this.st.level,
            playing: this.st.playing,
            options: this.optionsFor(uid),
            description: lines.join('\n'),
        }
    }

    private async onMessage(ws: WebSocket, rawData: unknown) {
        const uid = this.sockets.get(ws)
        if (!uid) return
        const member = this.members.get(uid)
        if (!member) return

        let cmd: any
        try {
            cmd = JSON.parse(typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData as ArrayBuffer))
        } catch {
            return
        }

        if (this.ready) {
            await this.ready
        }

        this.ready = this.handleCommand(ws, uid, member, cmd)
        try {
            await this.ready
        } finally {
            this.ready = null
        }
    }

    private async handleCommand(
        ws: WebSocket,
        uid: string,
        member: Member,
        cmd: any,
    ) {
        const type = cmd?.type

        if (type === 'setReady') {
            member.ready = Boolean(cmd.ready)
            this.broadcastState()
            return
        }

        if (type === 'chatMessage') {
            const text = String(cmd.message ?? '').trim().slice(0, 240)
            if (!text) return
            this.broadcast({
                type: 'chatMessage',
                userProfile: member.user,
                message: text,
                time: Date.now(),
            })
            return
        }

        if (type === 'selectLevel') {
            if (!this.canControlRoom(member.user)) return
            const nextLevel: Sil | null = cmd.level && typeof cmd.level.address === 'string' && typeof cmd.level.name === 'string'
                ? { address: cmd.level.address, name: cmd.level.name }
                : null

            if (nextLevel && this.st.poolCharts.length > 0 && !isOpenType(this.st.settings.type)) {
                const allowed = this.st.poolCharts.some((c) => sameLevel(c, nextLevel))
                if (!allowed) {
                    this.sendTo(ws, {
                        type: 'chatMessage',
                        userProfile: { id: 'system', handle: 'system', name: 'System' },
                        message: 'That song is not in the current round pool.',
                        time: Date.now(),
                    })
                    return
                }
            }

            this.st.level = nextLevel
            this.st.levelInfo = await this.loadLevelInfo(nextLevel)
            await this.persist()
            await this.publishLobby()
            this.broadcastState()
            return
        }

        if (type === 'startGameplay') {
            if (!this.canControlRoom(member.user)) return
            if (!this.st.level) return

            if (!this.st.levelInfo) {
                this.st.levelInfo = await this.loadLevelInfo(this.st.level)
            }

            this.st.playing = true
            this.roundFinished = false
            this.st.lastResults = {}
            this.st.lastResultLevel = this.st.level

            const s = this.st.settings
            const eligible = s.roundMode === 'rewind'
                ? [...unresolvedXUsersForSong(this.st.level, this.st.history)]
                : []

            this.st.lastRoundWasWarmup = s.roundMode === 'warmup' || s.roundMode === 'freeplay'
            this.st.lastRoundKind = s.roundMode
            this.st.lastRoundLabel = roundLabelFor(s.type, s.roundMode, this.nextRoundSeq, s.group)
            this.st.lastRoundEligibleUserIds = eligible

            for (const m of this.members.values()) {
                m.playing = this.isPlayerUser(m.user.id)
            }

            await this.persist()
            await this.publishLobby()
            this.broadcast({
                type: 'startGameplay',
                level: this.st.level,
            })
            this.broadcastState()
            return
        }

        if (type === 'finishGameplay') {
            if (!isResult(cmd.result)) return

            const expectedCount = this.st.levelInfo?.noteCount ?? null

            const judgedCount =
                (Number(cmd.result.perfect) || 0) +
                (Number(cmd.result.great) || 0) +
                (Number(cmd.result.good) || 0) +
                (Number(cmd.result.bad) || 0) +
                (Number(cmd.result.miss) || 0)

            const incomplete =
                expectedCount !== null && judgedCount < expectedCount

            const isX =
                incomplete ||
                cmd.result.grade === 'X' ||
                cmd.result.disqualified === true

            const result: GameplayResult = {
                ...cmd.result,
                grade: isX ? 'X' : cmd.result.grade,
                disqualified: isX,
            }

            member.playing = false
            member.ready = false
            this.st.lastResults[uid] = result
            await this.persist()
            await this.maybeFinishRound()
            this.broadcastState()
            return
        }

        if (type === 'updateOptionValues') {
            if (!this.canControlRoom(member.user)) return
            const parsed = parseSettings(
                String(cmd.values ?? ''),
                this.st.settings,
                member.user.name || member.user.handle,
            )
            if (!parsed) return

            const next: RoomSettings = {
                ...this.st.settings,
                ...parsed,
            }

            if (next.type === 'casualRoom') {
                next.scoring = 'pp'
            }

            const eligibleForNext = !isOpenType(next.type)
                ? filterEditionsForRoomType(this.st.editionOptions, next.type)
                : []

            if (!isOpenType(next.type) && eligibleForNext.length === 0) {
                return
            }

            if (!isOpenType(next.type)) {
                const normalizedNextEdition = String(next.edition ?? '').trim().toUpperCase()
                next.edition = eligibleForNext.includes(normalizedNextEdition)
                    ? normalizedNextEdition
                    : pickClosestEdition(eligibleForNext)
            }

            const editionChanged =
                !isOpenType(next.type) &&
                next.edition !== this.st.settings.edition

            this.st.settings = next

            if (editionChanged) {
                if (next.type === 'groupStage' || next.type === 'final') {
                    const data = await getEditionData(next.edition, this.env).catch(() => null)
                    this.st.editionData = data
                    this.st.poolCharts = data
                        ? (next.type === 'groupStage' ? [...data.group1, ...data.group2] : [...data.final])
                        : []
                } else if (next.type === 'ultimateEdition') {
                    const ult = await getUltimateEditionData(next.edition, this.env).catch(() => null)
                    if (ult) {
                        this.st.ultimateFixedCharts = ult.fixedCharts
                        this.st.ultimatePool = ult.pool
                        this.st.poolCharts = [...ult.fixedCharts, ...ult.pool.map((p) => p.chart)]
                    }
                }
            }

            await this.persist()
            await this.publishLobby()
            this.broadcastState()
            return
        }

        if (type === 'optionAction') {
            if (!this.canControlRoom(member.user)) return
            const actionType = String(cmd.action ?? cmd.typeAction ?? '')
            if (actionType === 'closeRoom') {
                await this.closeRoom()
                return
            }
            if (actionType === 'undoRound' && this.st.history.length > 0) {
                this.st.history.pop()
                this.nextRoundSeq = Math.max(1, this.st.history.length + 1)
                await this.persist()
                await this.publishLobby()
                this.broadcastState()
            }
        }
    }

    private async maybeFinishRound() {
        if (!this.st.playing || this.roundFinished) return

        const stillPlaying = [...this.members.values()].filter((m) => m.playing)
        if (stillPlaying.length > 0) return

        this.roundFinished = true
        this.st.playing = false

        const s = this.st.settings
        const info = this.st.levelInfo
        const roundKind: RoundKind = this.st.lastRoundKind ?? s.roundMode ?? 'tournament'
        const roundLabel = this.st.lastRoundLabel ?? roundLabelFor(s.type, roundKind, this.nextRoundSeq, s.group)

        const record: RoundRecord = {
            level: this.st.level,
            edition: s.edition || undefined,
            levelTitle: info?.title || this.st.level?.name || undefined,
            levelTag: info?.firstTag || undefined,
            levelRating: info?.rating ?? undefined,
            levelConstant: info?.constant ?? undefined,
            noteCount: info?.noteCount ?? undefined,
            difficulty: info?.difficulty || undefined,
            roundKind,
            roundLabel,
            countsTowardScore: roundKind === 'tournament' || roundKind === 'rewind',
            rewindEligibleUserIds: this.st.lastRoundEligibleUserIds,
            results: { ...this.st.lastResults },
        }

        this.st.history.push(record)
        this.st.lastResultRound = record
        if (roundKind === 'tournament') {
            this.nextRoundSeq += 1
        }

        if (s.type === 'ultimateEdition' && this.st.ultimatePool.length > 0) {
            await saveUltimatePicks(this.env, s.edition, this.st.ultimatePool).catch(() => {})
            await getSavedUltimatePicks(this.env, s.edition).catch(() => {})
        }

        const wireResults: Record<string, GameplayResult> = {}
        for (const [userId, res] of Object.entries(record.results)) {
            wireResults[userId] = sanitizeWireResult(res)
        }

        const summaryLines = Object.entries(record.results)
            .sort(([, a], [, b]) => compareResults(a, b, s.scoring, record))
            .map(([userId, res]) => {
                const name = this.members.get(userId)?.user.name || userId
                const pts = roundPoints(res, s.scoring, record)
                const raw = rawPpPoints(res, record)
                void raw
                return `${name}: ${fmtDetail(res, s.scoring, record)} (${fmtScore(pts, s.scoring)})`
            })

        await this.persist()
        await this.publishLobby()

        this.broadcast({
            type: 'finishGameplay',
            results: wireResults,
            summary: summaryLines.join('\n'),
        })
    }
}