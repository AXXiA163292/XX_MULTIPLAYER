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
    normalizeRoundMode,
    parseSettings,
    roomFormsForType,
    serializeSettings,
    type RoomSettings,
} from './forms.ts'
import {
    compareResults,
    fmtDetail,
    fmtScore,
    formatGradeShortcut,
    isPlayerX,
    rawPpPoints,
    roundPoints,
    songKeyOf,
    totals,
    unresolvedXUsersForSong,
    type RoundKind,
    type RoundRecord,
} from './scoring.ts'
import {
    getAvailableEditions,
    getLiveEdition,
    getEditionData,
    getUltimateEditionData,
    getSavedUltimatePicks,
    saveUltimatePicks,
    pickRankedLevel,
    type EditionData,
    type RankedTier,
    type SheetChart,
    type UltimatePicks,
} from './sheets.ts'
import type {
    Env,
    GameplayResult,
    JoinSession,
    ReplaySubmission,
    RoomStatus,
    Sil,
    UserStatus,
} from './types.ts'

type RoomUser = {
    authentication: string
    signature: string
}

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
    coverUrl?: string | null
}

type RoomState = {
    name: string
    createdAt: number
    edition: string
    editionOptions: string[]
    divisions: Record<string, string>
    poolCharts: SheetChart[]
    reserved: Reservation | null
    configured: boolean
    hostId: string
    hostName: string
    settings: RoomSettings
    hostHandle: string
    status: RoomStatus
    level: Sil | null
    levelInfo: LevelInfo | null
    levelOptions: { name: string; value: number }[]
    suggestions: { userId: string; level: Sil }[]
    members: Member[]
    ultimateParticipants: string[]
    ultimateRoundIndex: number
    ultimatePicksSaved: boolean
    statuses: Record<string, UserStatus>
    round: { state: string; seed: number; kind: RoundKind; label: string } | null
    results: Record<string, GameplayResult>
    history: RoundRecord[]
}

const fresh = (): RoomState => ({
    name: '',
    createdAt: 0,
    edition: '',
    editionOptions: [],
    divisions: {},
    poolCharts: [],
    reserved: null,
    configured: false,
    hostId: '',
    hostName: '',
    hostHandle: '',
    settings: {
        type: 'groupStage',
        edition: '',
        scoring: 'pp',
        roundMode: 'tournament',
        group: 'A',
        title: '',
        visibility: 'locked',
        random: false,
        tier: 'master',
        customSongs: 'off',
        vocalType: 'sekai',
    },
    status: 'selecting',
    level: null,
    levelInfo: null,
    levelOptions: [],
    suggestions: [],
    members: [],
    ultimateParticipants: [],
    ultimateRoundIndex: 0,
    ultimatePicksSaved: false,
    statuses: {},
    round: null,
    results: {},
    history: [],
})

const isOpenType = (type: RoomSettings['type']) =>
    type === 'casualRoom' || type === 'rankedRoom'

const ROUND_SLOT_ID_RE = /^(?:G[1-6]|F[1-4])$/i

const getRoomTitle = (settings: RoomSettings, edition = '', hostName = '') => {
    const selectedEdition = (edition || settings.edition || getLiveEdition()).trim().toUpperCase()
    const year = selectedEdition.match(/\d{4}/)?.[0] ?? String(new Date().getFullYear())

    if (settings.type === 'rankedRoom') {
        return String(settings.tier || 'master').toUpperCase()
    }

    if (settings.type === 'groupStage') {
        return `XX! Championship ${year} • Group ${settings.group || 'A'}`
    }

    if (settings.type === 'final') {
        return `XX! Championship ${selectedEdition} • Final`
    }

    if (settings.type === 'ultimateEdition') {
        return `XX! Ultimate Championship ${year}`
    }

    if (settings.type === 'casualRoom') {
        return settings.title || defaultCustomRoomTitle(hostName)
    }

    return 'XX! Championship'
}

function buildRoundLabel(
    level: Sil | null | undefined,
    kind: RoundKind,
    priorHistory: RoundRecord[],
    isOpen: boolean,
    ultimateRounds: SheetChart[] = [],
): string {
    if (isOpen) {
        return `Round ${priorHistory.length + 1}`
    }

    if (kind === 'warmup') {
        const warmupCount = priorHistory.filter((r) => (r.roundKind ?? 'tournament') === 'warmup').length + 1
        return `Warmup ${warmupCount}`
    }

    if (kind === 'freeplay') {
        const freeplayCount = priorHistory.filter((r) => (r.roundKind ?? 'tournament') === 'freeplay').length + 1
        return `Freeplay ${freeplayCount}`
    }

    const ultimateIndex = ultimateRounds.findIndex((chart) => sameLevel(level, chart))

    if (ultimateIndex >= 0) {
        const chartId = ultimateRounds[ultimateIndex]!.id.toUpperCase()

        const name = chartId.startsWith('WINTER-')
            ? 'Winter'
            : chartId.startsWith('SPRING-')
                ? 'Spring'
                : chartId.startsWith('SUMMER-')
                    ? 'Summer'
                    : chartId.startsWith('FALL-')
                        ? 'Fall'
                        : chartId === 'F1'
                            ? 'Contest Winner'
                            : 'XX! Ultimate'

        const base = `Round ${ultimateIndex + 1} · ${name}`

        if (kind === 'tournament') return base

        const rewindCount = priorHistory.filter(
            (record) => (record.roundKind ?? 'tournament') === 'rewind' && sameLevel(record.level, level),
        ).length + 1

        return rewindCount === 1 ? `${base} • Rewind` : `${base} • Rewind ${rewindCount}`
    }

    const targetKey = songKeyOf(level)
    const tournamentRounds = priorHistory.filter((r) => (r.roundKind ?? 'tournament') === 'tournament')

    if (kind === 'tournament') {
        return `Round ${tournamentRounds.length + 1}`
    }

    let baseRoundIndex = -1
    for (let i = 0; i < priorHistory.length; i++) {
        const rec = priorHistory[i]!
        if ((rec.roundKind ?? 'tournament') === 'tournament' && songKeyOf(rec.level) === targetKey) {
            baseRoundIndex = priorHistory.slice(0, i + 1).filter(
                (r) => (r.roundKind ?? 'tournament') === 'tournament',
            ).length
            break
        }
    }

    const baseLabel = baseRoundIndex > 0 ? `Round ${baseRoundIndex}` : `Round ${Math.max(1, tournamentRounds.length)}`
    const priorRewindCount = priorHistory.filter(
        (r) => (r.roundKind ?? 'tournament') === 'rewind' && songKeyOf(r.level) === targetKey,
    ).length
    const rewindIndex = priorRewindCount + 1

    return rewindIndex === 1
        ? `${baseLabel} • Rewind`
        : `${baseLabel} • Rewind ${rewindIndex}`
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
        score: Number(result.score) || 0,
        accuracy: Number(result.accuracy) || 0,
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

function chartsForType(edition: EditionData, type: RoomSettings['type']): SheetChart[] {
    if (type === 'groupStage') return edition.groupStage
    if (type === 'final') return edition.final
    return []
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

function randomChart(charts: SheetChart[]): SheetChart {
    if (!charts.length) throw new Error('Ultimate seasonal pool is empty.')
    return charts[Math.floor(Math.random() * charts.length)]!
}

function sameLevel(
    a: Sil | null | undefined,
    b: { address?: string; name?: string } | null | undefined,
): boolean {
    if (!a || !b || !a.address || !a.name || !b.address || !b.name) return false
    return (
        a.address.replace(/\/+$/, '').toLowerCase() === b.address.replace(/\/+$/, '').toLowerCase() &&
        a.name.trim().toLowerCase() === b.name.trim().toLowerCase()
    )
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

function extractDescriptionNumber(
    description: string,
    label: string,
): number | null {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = description.match(
        new RegExp(`${escaped}\\s*(?:•|:)\\s*(\\d+(?:\\.\\d+)?)`, 'i'),
    )

    if (!match) return null
    const value = Number(match[1])
    return Number.isFinite(value) ? value : null
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

async function fetchLevelInfo(level: Sil): Promise<LevelInfo | null> {
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

                const descriptionConstant = extractDescriptionNumber(description, 'Constant')
                const constant = descriptionConstant ?? rating

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

function cleanPoolCharts(value: unknown): SheetChart[] {
    if (!Array.isArray(value)) return []
    return value.filter(
        (entry): entry is SheetChart =>
            !!entry &&
            typeof entry === 'object' &&
            typeof (entry as SheetChart).address === 'string' &&
            typeof (entry as SheetChart).name === 'string',
    )
}

export class Room extends DurableObject<Env> {
    st: RoomState = fresh()

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)

        this.ctx.setWebSocketAutoResponse(
            new WebSocketRequestResponsePair('ping', 'pong'),
        )

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
                editionOptions: Array.isArray(saved?.editionOptions)
                    ? saved.editionOptions.filter((value): value is string => typeof value === 'string')
                    : [],
                divisions: cleanDivisions(saved?.divisions),
                poolCharts: cleanPoolCharts(saved?.poolCharts),
                ultimateParticipants: Array.isArray(saved?.ultimateParticipants)
                    ? saved.ultimateParticipants.filter((x): x is string => typeof x === 'string')
                    : [],
                ultimateRoundIndex: Number.isInteger(saved?.ultimateRoundIndex)
                    ? Math.max(0, Math.min(6, saved!.ultimateRoundIndex as number))
                    : 0,
                ultimatePicksSaved: saved?.ultimatePicksSaved === true,
                reserved: saved?.reserved ?? null,
                configured: saved?.configured === true,
                hostId: typeof saved?.hostId === 'string' ? saved.hostId : '',
                hostName: typeof saved?.hostName === 'string' ? saved.hostName : '',
                hostHandle: typeof saved?.hostHandle === 'string' ? saved.hostHandle : '',
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
                    ? {
                        state: saved.round.state,
                        seed: saved.round.seed,
                        kind: normalizeRoundMode(saved.round.kind),
                        label: typeof saved.round.label === 'string' ? saved.round.label : '',
                    }
                    : null,
            }

            this.st.settings.group ||= 'A'
            this.st.settings.edition ||= this.st.edition || getLiveEdition()
            this.st.settings.title ??= ''
            this.st.settings.random = this.st.settings.random === true

            if (!['public', 'private', 'locked'].includes(this.st.settings.visibility)) {
                this.st.settings.visibility =
                    this.st.settings.type === 'casualRoom' ? 'public' : 'locked'
            }

            if (!['groupStage', 'final', 'casualRoom', 'rankedRoom', 'ultimateEdition'].includes(this.st.settings.type)) {
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

            if (!['pp', 'rankedMatch'].includes(this.st.settings.scoring)) {
                this.st.settings.scoring = 'pp'
            }

            const uniqueMembers = new Map<string, Member>()
            for (const member of this.st.members) {
                uniqueMembers.set(member.id, member)
            }
            this.st.members = [...uniqueMembers.values()]

            for (const member of this.st.members) {
                this.st.statuses[member.id] ??= 'waiting'
            }

            const memberIds = new Set(this.st.members.map((member) => member.id))
            for (const id of Object.keys(this.st.statuses)) {
                if (!memberIds.has(id)) delete this.st.statuses[id]
            }
            for (const id of Object.keys(this.st.results)) {
                if (!memberIds.has(id)) delete this.st.results[id]
            }

            if (this.st.status === 'playing' && !this.st.round) {
                this.st.status = 'selecting'
                for (const member of this.st.members) {
                    this.st.statuses[member.id] = 'waiting'
                }
            }

            if (this.st.status === 'playing') {
                for (const member of this.st.members) {
                    if (this.st.statuses[member.id] === 'skipped') {
                        this.st.statuses[member.id] = 'waiting'
                    }
                }
            }

            await ctx.storage.put('st', this.st)
        })
    }

    private isPoolSong(
        level: Sil | null | undefined,
        pool: SheetChart[] = this.st.poolCharts,
    ): boolean {
        if (!level) return false
        return pool.some(
            (chart) =>
                ROUND_SLOT_ID_RE.test(chart.id) &&
                sameLevel(level, chart),
        )
    }

    private computeRoundKind(
        level: Sil | null | undefined,
        priorHistory: RoundRecord[],
        pool: SheetChart[] = this.st.poolCharts,
    ): RoundKind {
        const editionHistory = priorHistory.filter(
            (record) => !record.edition || record.edition === this.st.edition,
        )

        if (this.st.settings.type === 'ultimateEdition') {
            const index = pool.findIndex((chart) => sameLevel(level, chart))
            if (index < 0) return 'freeplay'

            const alreadyPlayed = editionHistory.some(
                (record) => sameLevel(record.level, level),
            )

            if (alreadyPlayed) return 'rewind'
            return index === this.st.ultimateRoundIndex ? 'tournament' : 'freeplay'
        }

        if (isOpenType(this.st.settings.type)) {
            return 'tournament'
        }

        if (pool.length === 0) return 'freeplay'

        const inPool = this.isPoolSong(level, pool)
        const hasPlayedPoolSongBefore = editionHistory.some((record) =>
            this.isPoolSong(record.level, pool),
        )

        if (inPool) {
            const alreadyPlayedThisSong = editionHistory.some((record) =>
                sameLevel(record.level, level),
            )

            return alreadyPlayedThisSong ? 'rewind' : 'tournament'
        }

        return hasPlayedPoolSongBefore ? 'freeplay' : 'warmup'
    }

    private activeSocketCount(): number {
        return this.ctx.getWebSockets().filter((ws) => !this.closing.has(ws)).length
    }

    private remainingLifespanMs(now = Date.now()): number {
        if (!this.st.createdAt) return MAX_ROOM_LIFESPAN_MS
        return Math.max(0, this.st.createdAt + MAX_ROOM_LIFESPAN_MS - now)
    }

    private isExpired(now = Date.now()): boolean {
        return this.st.createdAt > 0 && now >= this.st.createdAt + MAX_ROOM_LIFESPAN_MS
    }

    private async scheduleNextAlarm(delayMs?: number): Promise<void> {
        const now = Date.now()
        const maxRemaining = this.remainingLifespanMs(now)

        if (maxRemaining <= 0) {
            await this.expireAndDestroy('room max lifespan reached')
            return
        }

        const connected = this.activeSocketCount()
        const defaultIdleDelay = connected === 0 ? EMPTY_ROOM_TTL_MS : maxRemaining
        const targetDelay = delayMs === undefined
            ? defaultIdleDelay
            : Math.min(Math.max(1000, delayMs), maxRemaining)

        await this.ctx.storage.setAlarm(now + targetDelay)
    }

    private async expireAndDestroy(reason = 'room closed'): Promise<void> {
        const roomName = this.st.name
        const sockets = this.ctx.getWebSockets()

        this.st = fresh()
        await this.ctx.storage.deleteAll()

        if (roomName) {
            await this.env.LOBBY
                .get(this.env.LOBBY.idFromName('main'))
                .remove(roomName)
                .catch(() => {})
        }

        for (const socket of sockets) {
            try {
                socket.close(4002, reason)
            } catch {
                // Socket may already be closed.
            }
        }
    }

    private diag(event: string, extra?: Record<string, unknown>) {
        const connectedIds = this.st.members
            .filter((m) => this.socketsOf(m.id).length > 0)
            .map((m) => m.id)

        console.log(`[Room:${this.st.name || 'init'}] ${event}`, {
            type: this.st.settings.type,
            scoring: this.st.settings.scoring,
            status: this.st.status,
            round: this.st.round?.state ?? null,
            roundKind: this.st.round?.kind ?? null,
            historyLen: this.st.history.length,
            resultsKeys: Object.keys(this.st.results),
            connectedIds,
            statuses: this.st.statuses,
            ...extra,
        })
    }

    async closeForOwner(ownerId: string): Promise<void> {
        const currentOwner = this.st.configured
            ? this.st.hostId
            : this.st.reserved?.hostId

        if (!currentOwner || currentOwner !== ownerId) return

        await this.expireAndDestroy('replaced by a newer room')
    }

    async reserve(name: string, reservation: Reservation): Promise<void> {
        this.st = {
            ...fresh(),
            name,
            createdAt: Date.now(),
            reserved: reservation,
        }

        await this.save()
        await this.scheduleNextAlarm(RESERVED_ROOM_TTL_MS)
    }

    async configure(
        key: string,
        settings: RoomSettings,
        host: { id: string; name: string; handle: string },
    ): Promise<boolean> {
        if (this.isExpired()) {
            await this.expireAndDestroy('room expired')
            return false
        }

        const reservation = this.st.reserved

        if (
            !reservation ||
            reservation.key !== key ||
            reservation.hostId !== host.id ||
            reservation.hostHandle !== host.handle
        ) {
            console.error('[ROOM CONFIG] Reservation rejected:', {
                hasReservation: !!reservation,
                keyMatches: reservation?.key === key,
                hostIdMatches: reservation?.hostId === host.id,
                hostHandleMatches: reservation?.hostHandle === host.handle,
                expired: this.isExpired(),
            })
            return false
        }

        if (
            !isOpenType(settings.type) &&
            host.handle !== TOURNAMENT_HOST_HANDLE
        ) {
            console.error('[ROOM CONFIG] Tournament room creation denied:', {
                handle: host.handle,
                type: settings.type,
            })
            return false
        }

        if (settings.type === 'casualRoom' && !settings.title) {
            settings.title = defaultCustomRoomTitle(host.name)
        }

        if (!isOpenType(settings.type)) {
            settings.edition = settings.edition || getLiveEdition()
        }

        const editionOptions = await getAvailableEditions().catch((error) => {
            console.error('[ROOM CONFIG] Could not load edition options:', error)
            return [settings.edition || getLiveEdition()]
        })

        this.st.editionOptions = editionOptions

        let editionData: EditionData | null = null
        let ultimateData: Awaited<ReturnType<typeof getUltimateEditionData>> | null = null
        let hadSavedUltimatePicks = false
        let poolCharts: SheetChart[] = []

        try {
            if (settings.type === 'ultimateEdition') {
                ultimateData = await getUltimateEditionData(settings.edition)

                const savedPicks = await getSavedUltimatePicks(
                    this.env,
                    ultimateData.edition,
                )

                hadSavedUltimatePicks = !!savedPicks

                const seasonalPicks: Partial<UltimatePicks> = {}

                for (const season of ['winter', 'spring', 'summer', 'fall'] as const) {
                    const saved = savedPicks?.[season]
                    const available = ultimateData.seasons[season]

                    if (saved) {
                        seasonalPicks[season] = saved
                    } else if (available.length > 0) {
                        seasonalPicks[season] = randomChart(available)
                    }
                }

                poolCharts = [
                    ...(['winter', 'spring', 'summer', 'fall'] as const)
                        .flatMap((season) =>
                            seasonalPicks[season] ? [seasonalPicks[season]!] : [],
                        ),
                    ...(ultimateData.contestWinner ? [ultimateData.contestWinner] : []),
                    ...(ultimateData.ultimate ? [ultimateData.ultimate] : []),
                ]
            } else if (settings.type === 'groupStage' || settings.type === 'final') {
                editionData = await getEditionData(settings.edition)
                poolCharts = chartsForType(editionData, settings.type)
            }
        } catch (error) {
            console.error(
                '[ROOM CONFIG] Edition sheet failure. Opening room without edition data:',
                error instanceof Error ? error.message : String(error),
                error instanceof Error ? error.stack : '',
            )

            editionData = null
            ultimateData = null
            hadSavedUltimatePicks = false
            poolCharts = []
        }

        this.st.edition = isOpenType(settings.type) ? '' : settings.edition
        this.st.divisions = editionData
            ? cleanDivisions(editionData.divisions)
            : {}
        this.st.ultimateParticipants = ultimateData?.participants ?? []
        this.st.ultimateRoundIndex = 0
        this.st.ultimatePicksSaved = hadSavedUltimatePicks
        this.st.poolCharts = poolCharts
        this.st.suggestions = suggestionsFromCharts(poolCharts, host.id)

        const firstPoolChart = !isOpenType(settings.type)
            ? (poolCharts[0] ?? null)
            : null

        this.st.createdAt = Date.now()
        this.st.configured = true
        this.st.hostId = host.id
        this.st.hostName = host.name
        this.st.hostHandle = host.handle
        this.st.settings = {
            ...settings,
            roundMode: 'tournament',
        }
        this.st.reserved = null
        this.st.status = 'selecting'
        this.st.level = firstPoolChart
            ? { address: firstPoolChart.address, name: firstPoolChart.name }
            : null
        this.st.levelInfo = this.st.level
            ? await fetchLevelInfo(this.st.level)
            : null
        this.st.levelOptions = []
        this.st.round = null
        this.st.results = {}
        this.st.history = []

        await this.save()
        await this.syncLobby()
        await this.scheduleNextAlarm(EMPTY_ROOM_TTL_MS)
        this.diag('configured')

        return true
    }

    async isOpen(): Promise<boolean> {
        if (this.isExpired()) {
            await this.expireAndDestroy('room expired')
            return false
        }
        return this.st.configured
    }

    async summary() {
        if (this.isExpired()) {
            await this.expireAndDestroy('room expired')
            return null
        }

        if (!this.st.configured) return null

        return {
            name: this.st.name,
            title: getRoomTitle(this.st.settings, this.st.edition, this.st.hostName),
            subtitle: this.subtitle(),
            master: this.st.hostName,
            hostId: this.st.hostId,
            hostHandle: this.st.hostHandle || this.st.members.find((member) => member.id === this.st.hostId)?.handle || '',
            visibility: this.st.settings.visibility,
            type: this.st.settings.type,
            tier: this.st.settings.tier,
            level: this.st.level,
            coverUrl: this.st.levelInfo?.coverUrl ?? null,
        }
    }

    async canJoin(user: { id: string; handle: string }): Promise<string | null> {
        if (this.isExpired()) {
            await this.expireAndDestroy('room expired')
            return 'This room has expired.'
        }

        if (!this.st.configured) return 'This room does not exist.'

        const s = this.st.settings
        if (user.id === this.st.hostId || user.handle === TOURNAMENT_HOST_HANDLE) return null
        if (s.visibility === 'locked') return 'This room is locked.'

        return null
    }

    private subtitle(): string {
        const s = this.st.settings
        const access = s.visibility === 'locked' ? 'Locked' : s.visibility === 'private' ? 'Private' : 'Public'
        return `${SCORING_MODES[s.scoring]} · ${access}${s.random ? ' · Random' : ''}`
    }

    async fetch(request: Request): Promise<Response> {
        if (this.isExpired()) {
            await this.expireAndDestroy('room expired')
            return new Response('Room expired', { status: 404 })
        }

        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 })
        }

        let join: JoinSession | null
        try {
            join = JSON.parse(
                decodeURIComponent(request.headers.get('x-join') ?? 'null'),
            ) as JoinSession | null
        } catch {
            return new Response('Invalid join session', { status: 400 })
        }

        if (
            !join ||
            !this.st.configured ||
            join.room !== this.st.name ||
            !join.user ||
            typeof join.user.id !== 'string' ||
            !join.roomUser ||
            typeof join.roomUser.authentication !== 'string' ||
            typeof join.roomUser.signature !== 'string'
        ) {
            return new Response('No such room', { status: 404 })
        }

        const { 0: client, 1: server } = new WebSocketPair()
        const user = join.user

        const oldSockets = this.socketsOf(user.id)
        const wasConnected = oldSockets.length > 0

        const existingMember = this.st.members.find((member) => member.id === user.id)
        const member: Member = existingMember ?? {
            id: user.id,
            name: user.name,
            handle: user.handle,
            roomUser: join.roomUser,
        }

        member.name = user.name
        member.handle = user.handle
        member.roomUser = join.roomUser

        this.st.members = this.st.members.filter((entry) => entry.id !== user.id)
        this.st.members.push(member)
        this.st.statuses[user.id] = 'waiting'

        this.ctx.acceptWebSocket(server)
        server.serializeAttachment({ userId: user.id })

        for (const oldSocket of oldSockets) {
            this.closing.add(oldSocket)
            try {
                oldSocket.close(4000, 'replaced')
            } catch {
                // Previous socket may already be closed.
            }
        }

        await this.save()

        this.send(server, this.view(user.id))

        if (!wasConnected) {
            this.sendExcept(user.id, {
                type: 'addUser',
                user: member.roomUser,
            })
        }

        if (user.id === this.st.hostId) {
            this.sendExcept(user.id, {
                type: 'updateMaster',
                master: this.st.hostId,
            })

            this.sendExcept(user.id, {
                type: 'updateLead',
                lead: this.st.hostId,
            })
        }

        this.pushScoreboard()
        await this.maybeSaveUltimatePicks()

        this.send(server, {
            type: 'updateTitle',
            title: getRoomTitle(this.st.settings, this.st.edition, this.st.hostName),
        })

        this.diag('ws-join', { userId: user.id, wasConnected })
        await this.maybeFinishRound(true)
        await this.save()
        await this.scheduleNextAlarm()

        return new Response(null, {
            status: 101,
            webSocket: client,
        })
    }

    async webSocketMessage(
        ws: WebSocket,
        raw: string | ArrayBuffer,
    ): Promise<void> {
        if (this.isExpired()) {
            await this.expireAndDestroy('room expired')
            return
        }

        const attachment = ws.deserializeAttachment() as { userId: string } | null
        if (!attachment || typeof raw !== 'string') return

        let command: Cmd
        try {
            command = JSON.parse(raw)
        } catch {
            return
        }

        if (!this.st.members.some((member) => member.id === attachment.userId)) {
            return
        }

        try {
            await this.handle(attachment.userId, command)
        } catch (error) {
            console.error('Room command failed:', command?.type, error)
            this.diag('command-error', {
                userId: attachment.userId,
                cmdType: command?.type,
                error: error instanceof Error ? error.message : String(error),
            })
            this.resync(attachment.userId)
        }

        await this.save()
        await this.scheduleNextAlarm()
    }

    async webSocketClose(ws: WebSocket): Promise<void> {
        const attachment = ws.deserializeAttachment() as { userId: string } | null
        if (!attachment) return

        this.closing.add(ws)

        if (this.socketsOf(attachment.userId).some((socket) => socket !== ws)) {
            return
        }

        this.diag('ws-close', { userId: attachment.userId })
        await this.dropMember(attachment.userId, true, true)
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        this.diag('ws-error')
        await this.webSocketClose(ws)
    }

    async alarm(): Promise<void> {
        this.diag('alarm-fired')

        if (this.isExpired()) {
            await this.expireAndDestroy('room max lifespan reached')
            return
        }

        await this.maybeFinishRound(true)
        await this.save()

        if (this.activeSocketCount() === 0) {
            await this.expireAndDestroy('empty room closed after 3m')
            return
        }

        await this.scheduleNextAlarm()
    }

    private async closeRoom(uid: string): Promise<void> {
        if (uid !== this.st.hostId) {
            return this.resync(uid)
        }

        await this.expireAndDestroy('room closed by host')
    }

    private async handle(uid: string, cmd: Cmd): Promise<void> {
        const state = this.st
        const isHost = uid === state.hostId

        switch (cmd.type) {
            case 'updateLevel': {
                if (
                    !isHost ||
                    state.status !== 'selecting' ||
                    !isSil(cmd.level)
                ) {
                    return this.resync(uid)
                }

                if (
                    state.settings.type === 'rankedRoom' ||
                    (state.settings.type === 'casualRoom' && state.settings.random) ||
                    (state.settings.type === 'ultimateEdition' && state.hostHandle !== TOURNAMENT_HOST_HANDLE)
                ) {
                    return this.resync(uid)
                }

                if (state.levelOptions.length > 0) {
                    state.levelOptions = []
                    this.sendAll({ type: 'updateLevelOptions', levelOptions: [] })
                }

                state.level = {
                    address: cmd.level.address,
                    name: cmd.level.name,
                }
                state.levelInfo = null

                this.sendLevel()
                this.pushScoreboard()

                state.levelInfo = await fetchLevelInfo(state.level)
                this.pushScoreboard()
                return
            }

            case 'updateOptionValues': {
                if (
                    typeof cmd.optionValues === 'string' &&
                    new URLSearchParams(cmd.optionValues).get('type') === 'closeRoom'
                ) {
                    return this.closeRoom(uid)
                }

                const next =
                    typeof cmd.optionValues === 'string'
                        ? parseSettings(cmd.optionValues, state.settings, state.hostName)
                        : null

                const member = state.members.find((entry) => entry.id === uid)
                const tournamentHost = member?.handle === TOURNAMENT_HOST_HANDLE

                if (
                    !isHost ||
                    !next ||
                    next.type !== state.settings.type ||
                    (!tournamentHost && !isOpenType(next.type)) ||
                    state.status !== 'selecting'
                ) {
                    return this.resync(uid)
                }

                const editionChanged =
                    next.edition !== state.settings.edition &&
                    !isOpenType(next.type)

                if (editionChanged) {
                    try {
                        let nextPool: SheetChart[] = []
                        let nextDivisions: Record<string, string> = {}
                        let nextParticipants: string[] = []
                        let nextPicksSaved = false

                        if (next.type === 'ultimateEdition') {
                            const data = await getUltimateEditionData(next.edition)
                            const saved = await getSavedUltimatePicks(this.env, data.edition)

                            nextPicksSaved = !!saved
                            const picks: Partial<UltimatePicks> = {}

                            for (const season of ['winter', 'spring', 'summer', 'fall'] as const) {
                                if (saved?.[season]) {
                                    picks[season] = saved[season]
                                } else if (data.seasons[season].length > 0) {
                                    picks[season] = randomChart(data.seasons[season])
                                }
                            }

                            nextPool = [
                                ...(['winter', 'spring', 'summer', 'fall'] as const)
                                    .flatMap((season) => picks[season] ? [picks[season]!] : []),
                                ...(data.contestWinner ? [data.contestWinner] : []),
                                ...(data.ultimate ? [data.ultimate] : []),
                            ]

                            nextParticipants = data.participants
                        } else {
                            const data = await getEditionData(next.edition)
                            nextPool = chartsForType(data, next.type)
                            nextDivisions = cleanDivisions(data.divisions)
                        }

                        state.edition = next.edition
                        state.poolCharts = nextPool
                        state.divisions = nextDivisions
                        state.ultimateParticipants = nextParticipants
                        state.ultimateRoundIndex = 0
                        state.ultimatePicksSaved = nextPicksSaved
                        state.suggestions = suggestionsFromCharts(nextPool, state.hostId)
                        state.level = nextPool[0]
                            ? {
                                address: nextPool[0].address,
                                name: nextPool[0].name,
                            }
                            : null
                        state.levelInfo = state.level
                            ? await fetchLevelInfo(state.level)
                            : null
                        state.levelOptions = []
                        state.results = {}
                        state.round = null

                        this.sendAll({
                            type: 'updateLevel',
                            level: state.level,
                        })
                    } catch (error) {
                        console.error(
                            '[ROOM] Could not load selected edition. Continuing without edition data:',
                            error,
                        )

                        state.edition = next.edition
                        state.poolCharts = []
                        state.divisions = {}
                        state.ultimateParticipants = []
                        state.ultimateRoundIndex = 0
                        state.ultimatePicksSaved = false
                        state.suggestions = []
                        state.level = null
                        state.levelInfo = null
                        state.levelOptions = []
                        state.results = {}
                        state.round = null

                        this.sendAll({
                            type: 'updateLevel',
                            level: null,
                        })
                    }
                }

                if (next.type === 'rankedRoom') {
                    next.tier = state.settings.tier
                    next.customSongs = state.settings.customSongs
                }

                const randomChanged = next.random !== state.settings.random
                const modeChanged = next.scoring !== state.settings.scoring

                if (next.type === 'casualRoom' && !next.title) {
                    next.title = defaultCustomRoomTitle(state.hostName)
                }

                state.settings = {
                    ...next,
                    roundMode: 'tournament',
                }

                this.sendAll({
                    type: 'updateOptionValues',
                    optionValues: serializeSettings(state.settings),
                })

                this.sendAll({
                    type: 'updateTitle',
                    title: getRoomTitle(state.settings, state.edition, state.hostName),
                })

                if (modeChanged || editionChanged) {
                    this.sendAll({
                        type: 'updateScoreboardDescription',
                        scoreboardDescription: '',
                    })

                    this.pushScoreboard()
                }

                if (randomChanged) await this.applyRandomLevel(true)

                await this.syncLobby()
                return
            }

            case 'updateStatus': {
                this.diag('updateStatus-command', {
                    userId: uid,
                    requested: cmd.status,
                    current: state.status,
                    isHost,
                })
                return isHost
                    ? this.changeStatus(uid, cmd.status)
                    : this.resync(uid)
            }

            case 'removeUser': {
                if (
                    !isHost ||
                    cmd.userId === uid ||
                    !state.members.some((member) => member.id === cmd.userId)
                ) {
                    return this.resync(uid)
                }

                const target = cmd.userId as string

                for (const socket of this.socketsOf(target)) {
                    this.closing.add(socket)
                    try {
                        socket.close(4001, 'kicked')
                    } catch {
                        // Socket may already be closed.
                    }
                }

                await this.dropMember(target, true, true)
                return
            }

            case 'resetScoreboard': {
                if (!isHost) return this.resync(uid)

                state.history = []
                state.results = {}
                this.pushScoreboard()
                return
            }

            case 'addSuggestion': {
                if (
                    state.settings.type === 'rankedRoom' ||
                    (!isHost && state.settings.type !== 'casualRoom') ||
                    !isSil(cmd.level)
                ) {
                    return this.resync(uid)
                }

                const alreadyExists = state.suggestions.some(
                    (entry) =>
                        entry.level.address === cmd.level.address &&
                        entry.level.name === cmd.level.name,
                )

                if (!alreadyExists) {
                    const suggestion = {
                        userId: uid,
                        level: {
                            address: cmd.level.address,
                            name: cmd.level.name,
                        },
                    }

                    state.suggestions.push(suggestion)

                    const event = {
                        type: 'addSuggestion',
                        suggestion,
                    }

                    if (state.settings.type === 'casualRoom') {
                        this.sendAll(event)
                    } else {
                        this.sendHost(event)
                    }
                }

                await this.applyRandomLevel(false)
                return
            }

            case 'removeSuggestion': {
                const index = state.suggestions.findIndex(
                    (entry) =>
                        entry.userId === cmd.suggestion?.userId &&
                        entry.level.address === cmd.suggestion?.level?.address &&
                        entry.level.name === cmd.suggestion?.level?.name,
                )

                if (!isHost || index < 0) {
                    return this.resync(uid)
                }

                const [removed] = state.suggestions.splice(index, 1)

                this.sendHost({
                    type: 'removeSuggestion',
                    suggestion: removed,
                })

                return
            }

            case 'clearSuggestions': {
                if (!isHost) return this.resync(uid)

                state.suggestions = []
                this.sendHost({ type: 'clearSuggestions' })
                return
            }

            case 'swapSuggestions': {
                const find = (suggestion: any) =>
                    state.suggestions.findIndex(
                        (entry) =>
                            entry.userId === suggestion?.userId &&
                            entry.level.address === suggestion?.level?.address &&
                            entry.level.name === suggestion?.level?.name,
                    )

                const a = find(cmd.suggestionA)
                const b = find(cmd.suggestionB)

                if (!isHost || a < 0 || b < 0 || a === b) {
                    return this.resync(uid)
                }

                ;[state.suggestions[a], state.suggestions[b]] = [
                    state.suggestions[b]!,
                    state.suggestions[a]!,
                ]

                this.sendHost({
                    type: 'swapSuggestions',
                    suggestionA: cmd.suggestionA,
                    suggestionB: cmd.suggestionB,
                })

                return
            }

            case 'updateLead':
            case 'updateMaster':
            case 'updateAutoExit':
            case 'updateIsSuggestionsLocked':
                return this.resync(uid)

            case 'updateLevelOption': {
                const entry = cmd.levelOption

                if (
                    !isHost ||
                    state.settings.type !== 'casualRoom' ||
                    state.status !== 'selecting' ||
                    !entry ||
                    typeof entry.name !== 'string' ||
                    typeof entry.value !== 'number' ||
                    !Number.isFinite(entry.value)
                ) {
                    return this.resync(uid)
                }

                const next = { name: entry.name, value: entry.value }
                const at = state.levelOptions.findIndex((x) => x.name === next.name)

                if (at >= 0) state.levelOptions[at] = next
                else state.levelOptions.push(next)

                this.sendAll({ type: 'updateLevelOption', levelOption: next })
                return
            }

            case 'updateUserStatus': {
                const wanted = cmd.status as UserStatus
                const allowed: UserStatus[] = isHost
                    ? ['waiting', 'ready', 'skipped']
                    : ['waiting', 'ready']

                if (
                    state.status !== 'preparing' ||
                    !allowed.includes(wanted)
                ) {
                    return this.resync(uid)
                }

                state.statuses[uid] = wanted

                this.sendAll({
                    type: 'updateUserStatus',
                    userStatus: {
                        userId: uid,
                        status: wanted,
                    },
                })

                return
            }

            case 'startGameplay': {
                if (
                    state.status !== 'playing' ||
                    !state.round ||
                    cmd.state !== state.round.state ||
                    state.statuses[uid] !== 'ready'
                ) {
                    return this.resync(uid)
                }

                state.statuses[uid] = 'playing'

                this.sendAll({
                    type: 'updateUserStatus',
                    userStatus: {
                        userId: uid,
                        status: 'playing',
                    },
                })

                return
            }

            case 'finishGameplay': {
                const valid =
                    state.status === 'playing' &&
                    state.round &&
                    cmd.state === state.round.state &&
                    isResult(cmd.result) &&
                    !state.results[uid]

                if (!valid) {
                    this.diag('finishGameplay-rejected', { userId: uid })
                    return this.resync(uid)
                }

                const result: GameplayResult = {
                    ...cmd.result,
                    grade: cmd.result.grade === 'X' ? 'fail' : cmd.result.grade,
                }

                state.results[uid] = result
                state.statuses[uid] = 'waiting'

                this.sendAll({
                    type: 'updateUserStatus',
                    userStatus: {
                        userId: uid,
                        status: 'waiting',
                    },
                })

                this.sendResult(uid, result)
                this.pushScoreboard()
                this.diag('finishGameplay-accepted', {
                    userId: uid,
                    grade: result.grade,
                })

                await this.stageReplayMetadata(uid, result)

                await this.maybeFinishRound(true)
                return
            }

            case 'addChatMessage': {
                const incoming = cmd.message
                let message: Ev | null = null

                if (
                    incoming?.type === 'quick' &&
                    ['hello', 'glhf', 'gg', 'ns', 'ty'].includes(incoming.value)
                ) {
                    message = {
                        userId: uid,
                        type: 'quick',
                        value: incoming.value,
                    }
                } else if (
                    incoming?.type === 'text' &&
                    typeof incoming.value === 'string' &&
                    incoming.value.trim()
                ) {
                    message = {
                        userId: uid,
                        type: 'text',
                        value: incoming.value.slice(0, 200),
                    }
                }

                if (!message) return

                for (const member of state.members) {
                    const event: Ev = {
                        type: 'addChatMessage',
                        message,
                    }

                    if (member.id === uid && typeof cmd.nonce === 'number') {
                        event.nonce = cmd.nonce
                    }

                    this.sendTo(member.id, event)
                }

                return
            }

            case 'reportUser':
            default:
                return
        }
    }

    private async changeStatus(
        uid: string,
        next: RoomStatus,
    ): Promise<void> {
        const state = this.st
        const current = state.status

        const waitAll = () => {
            for (const member of state.members) {
                state.statuses[member.id] = 'waiting'
            }
        }

        if (current === 'selecting' && next === 'preparing') {
            if (state.settings.type === 'rankedRoom') {
                let pick: SheetChart | null = null

                try {
                    pick = await pickRankedLevel(
                        state.settings.tier as RankedTier,
                        state.settings.customSongs,
                        state.settings.vocalType ?? 'virtualSinger',
                        this.env,
                    )
                } catch (error) {
                    console.error('Could not pick a ranked level:', error)
                }

                if (state.status !== 'selecting' || !pick) {
                    return this.resync(uid)
                }

                state.level = { address: pick.address, name: pick.name }
                state.levelInfo = await fetchLevelInfo(state.level)
                state.levelOptions = []

                this.sendAll({ type: 'updateLevel', level: state.level })
                this.sendAll({ type: 'updateLevelOptions', levelOptions: [] })
            } else if (
                state.settings.type === 'casualRoom' &&
                state.settings.random
            ) {
                await this.applyRandomLevel(true)
                if (state.status !== 'selecting') return this.resync(uid)
            }
        }

        if (current === 'selecting' && next === 'preparing' && state.level) {
            state.status = 'preparing'
            waitAll()

            if (!isOpenType(state.settings.type)) {
                for (const member of state.members) {
                    if (member.id !== state.hostId) {
                        this.sendTo(member.id, {
                            type: 'updateLevel',
                            level: state.level,
                        })
                    }
                }
            }

            this.sendAll({
                type: 'updateStatus',
                status: 'preparing',
            })
            this.diag('status-preparing', { level: state.level.name })
        } else if (current === 'preparing' && next === 'selecting') {
            state.status = 'selecting'
            waitAll()

            this.sendAll({
                type: 'updateStatus',
                status: 'selecting',
            })
            this.diag('status-selecting-from-preparing')
        } else if (current === 'preparing' && next === 'playing') {
            const readyMembers = state.members.filter(
                (member) =>
                    this.socketsOf(member.id).length > 0 &&
                    state.statuses[member.id] === 'ready',
            )

            if (!state.level || readyMembers.length === 0) {
                return this.resync(uid)
            }

            const editionHistory = state.history.filter(
                (record) => !record.edition || record.edition === this.st.edition,
            )

            const kind = this.computeRoundKind(state.level, editionHistory)
            const label = buildRoundLabel(
                state.level,
                kind,
                editionHistory,
                isOpenType(state.settings.type),
                state.settings.type === 'ultimateEdition' ? state.poolCharts : [],
            )

            state.settings.roundMode = kind
            state.status = 'playing'
            state.results = {}
            state.round = {
                state: crypto.randomUUID(),
                seed: Math.random(),
                kind,
                label,
            }

            for (const member of state.members) {
                if (state.statuses[member.id] === 'skipped') {
                    state.statuses[member.id] = 'waiting'
                }
            }

            this.sendAll({
                type: 'updateStatus',
                status: 'playing',
            })

            const start = {
                type: 'startRound',
                state: state.round.state,
                seed: state.round.seed,
            }

            for (const member of readyMembers) {
                this.sendTo(member.id, start)
            }

            this.pushScoreboard()
            this.diag('status-playing', { readyCount: readyMembers.length, kind, label })
        } else if (current === 'playing' && next === 'selecting') {
            let completedRound: RoundRecord | null = null

            if (Object.keys(state.results).length > 0) {
                completedRound = this.makeRoundRecord(state.history)
                state.history.push(completedRound)
            }

            state.round = null
            state.status = 'selecting'
            waitAll()

            if (state.settings.type === 'rankedRoom') {
                state.level = null
                state.levelInfo = null
                this.sendAll({ type: 'updateLevel', level: null })
            }

            if (state.settings.type === 'ultimateEdition' && completedRound?.roundKind === 'tournament') {
                const completedIndex = state.poolCharts.findIndex(
                    (chart) => sameLevel(completedRound!.level, chart),
                )

                if (completedIndex === state.ultimateRoundIndex) {
                    state.ultimateRoundIndex++

                    if (state.ultimateRoundIndex < state.poolCharts.length) {
                        const nextChart = state.poolCharts[state.ultimateRoundIndex]!
                        state.level = { address: nextChart.address, name: nextChart.name }
                        state.levelInfo = await fetchLevelInfo(state.level)
                        state.levelOptions = []
                        this.sendLevel()
                    } else {
                        await this.maybeSaveUltimatePicks()
                    }
                }
            }

            this.sendAll({ type: 'updateStatus', status: 'selecting' })
            this.pushScoreboard()
            await this.applyRandomLevel(true)

            for (const member of state.members) {
                if (this.socketsOf(member.id).length > 0) this.resync(member.id)
            }

            this.diag('status-selecting-from-playing')
        }
    }

    private async stageReplayMetadata(
        uid: string,
        result: GameplayResult,
    ): Promise<void> {
        const state = this.st
        const competition = state.settings.type

        if (
            competition !== 'groupStage' &&
            competition !== 'final' &&
            competition !== 'ultimateEdition'
        ) {
            return
        }

        if (
            !state.round ||
            !state.level ||
            (state.round.kind !== 'tournament' && state.round.kind !== 'rewind')
        ) {
            return
        }

        const member = state.members.find((entry) => entry.id === uid)
        if (!member?.handle) return

        const edition = String(
            state.edition || state.settings.edition || getLiveEdition(),
        ).trim().toUpperCase()

        const originalRoundLabel = state.round.label.trim()

        const rewindMatch = originalRoundLabel.match(
            /Rewind(?:\s+(\d+))?$/i,
        )

        const rewindIndex =
            state.round.kind === 'rewind'
                ? Number(rewindMatch?.[1] ?? 1)
                : 0

        const roundLabel = originalRoundLabel
            .replace(/\s*[•·]\s*Rewind(?:\s+\d+)?$/i, '')
            .trim()

        const roundNumber = Number(
            roundLabel.match(/^Round\s+(\d+)/i)?.[1] ?? 1,
        )

        const group =
            competition === 'groupStage'
                ? String(state.settings.group || 'A').trim()
                : undefined

        const roundId = [
            edition,
            competition,
            group ?? '',
            roundLabel,
            state.level.address.replace(/\/+$/, ''),
            state.level.name,
        ].join('::')

        const roundData = {
            levelConstant: state.levelInfo?.constant ?? undefined,
            levelRating: state.levelInfo?.rating ?? undefined,
            noteCount: state.levelInfo?.noteCount ?? undefined,
        }

        const scoreValue =
            state.settings.scoring === 'pp'
                ? rawPpPoints(result, roundData)
                : roundPoints(result, state.settings.scoring, roundData)

        const scoreText =
            state.settings.scoring === 'pp'
                ? `${scoreValue.toFixed(1)}pp`
                : `${Math.round(scoreValue)}`

        const grade = formatGradeShortcut(result)
        const combo = Number(result.combo) || 0
        const great = Number(result.great) || 0
        const good = Number(result.good) || 0
        const miss = Number(result.miss) || 0

        const metadata: ReplaySubmission = {
            edition,
            competition,
            ...(group ? { group } : {}),
            roundId,
            roundNumber,
            roundLabel,
            roundKind: state.round.kind,
            songTitle: state.levelInfo?.title || state.level.name,
            difficulty:
                state.levelInfo?.difficulty ||
                state.levelInfo?.firstTag ||
                'UNKNOWN',
            levelName: state.level.name,
            levelAddress: state.level.address,
            ...(state.levelInfo?.rating != null
                ? { levelRating: state.levelInfo.rating }
                : {}),
            ...(state.levelInfo?.constant != null
                ? { levelConstant: state.levelInfo.constant }
                : {}),
            playerName: member.name || member.handle,
            playerHandle: member.handle,
            scoreLabel: `${scoreText} ${grade} ${combo}x (${great}-${good}-${miss})`,
            scoreValue,
            grade,
            combo,
            perfect: Number(result.perfect) || 0,
            great,
            good,
            miss,
            rewindIndex,
        }

        try {
            const stub = this.env.REPLAYS.get(
                this.env.REPLAYS.idFromName('xx-replays'),
            )

            const response = await stub.fetch(
                new Request('https://replays/pending', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        handle: member.handle,
                        metadata,
                    }),
                }),
            )

            if (!response.ok) {
                console.error(
                    '[Replays] Could not stage replay metadata:',
                    response.status,
                    await response.text(),
                )
            }
        } catch (error) {
            console.error('[Replays] Metadata staging failed:', error)
        }
    }

    private makeRoundRecord(priorHistory: RoundRecord[] = this.st.history): RoundRecord {
        const info = this.st.levelInfo
        const editionHistory = priorHistory.filter(
            (record) => !record.edition || record.edition === this.st.edition,
        )
        const kind: RoundKind =
            this.st.round?.kind ?? this.computeRoundKind(this.st.level, editionHistory)
        const label =
            this.st.round?.label ||
            buildRoundLabel(
                this.st.level,
                kind,
                editionHistory,
                isOpenType(this.st.settings.type),
                this.st.settings.type === 'ultimateEdition' ? this.st.poolCharts : [],
            )
        const rewindEligibleUserIds =
            kind === 'rewind'
                ? [...unresolvedXUsersForSong(this.st.level, editionHistory)]
                : []

        return {
            level: this.st.level,
            edition: this.st.edition,
            levelTitle: info?.title,
            levelTag: info?.firstTag,
            levelRating: info?.rating ?? undefined,
            levelConstant: info?.constant ?? undefined,
            noteCount: info?.noteCount ?? undefined,
            difficulty: info?.difficulty || info?.firstTag || undefined,
            roundKind: kind,
            roundLabel: label,
            countsTowardScore: kind === 'tournament' || kind === 'rewind',
            isReplay: kind === 'rewind' || kind === 'freeplay',
            rewindEligibleUserIds,
            results: { ...this.st.results },
        }
    }

    private canSee(_uid: string): boolean {
        return true
    }

    private async maybeSaveUltimatePicks(): Promise<void> {
        const state = this.st

        if (
            state.settings.type !== 'ultimateEdition' ||
            state.ultimateRoundIndex < state.poolCharts.length ||
            state.ultimatePicksSaved
        ) return

        const assignedPresent = state.members.some(
            (member) =>
                state.ultimateParticipants.includes(member.handle) &&
                this.socketsOf(member.id).length > 0,
        )

        if (!assignedPresent) return

        const findSeason = (season: 'winter' | 'spring' | 'summer' | 'fall') =>
            state.poolCharts.find((chart) =>
                chart.id.toUpperCase().startsWith(`${season.toUpperCase()}-`),
            )

        const winter = findSeason('winter')
        const spring = findSeason('spring')
        const summer = findSeason('summer')
        const fall = findSeason('fall')

        if (!winter || !spring || !summer || !fall) return

        const picks: UltimatePicks = {
            winter,
            spring,
            summer,
            fall,
        }

        try {
            await saveUltimatePicks(this.env, state.edition, picks)
            state.ultimatePicksSaved = true
            await this.save()
        } catch (error) {
            console.error('[Ultimate] Could not save completed picks:', error)
        }
    }

    private sendLevel(): void {
        if (!this.st.level) return

        const event = { type: 'updateLevel', level: this.st.level }
        if (isOpenType(this.st.settings.type)) this.sendAll(event)
        else this.sendHost(event)
    }

    private sendResult(uid: string, result: GameplayResult): void {
        const activeIds = new Set(
            this.st.members
                .filter((member) => this.socketsOf(member.id).length > 0)
                .map((member) => member.id),
        )
        if (!activeIds.has(uid)) return

        const wireResult = sanitizeWireResult(result)

        for (const member of this.st.members) {
            if (activeIds.has(member.id) && this.canSee(member.id)) {
                this.sendTo(member.id, {
                    type: 'addResult',
                    result: { userId: uid, result: wireResult },
                })
            }
        }
    }

    private async applyRandomLevel(force: boolean): Promise<void> {
        const s = this.st

        if (
            s.settings.type !== 'casualRoom' ||
            !s.settings.random ||
            s.status !== 'selecting' ||
            s.suggestions.length === 0
        ) return

        if (s.level && !force) return

        const pool = s.suggestions.filter(
            (x) =>
                !(
                    s.level &&
                    x.level.address === s.level.address &&
                    x.level.name === s.level.name
                ),
        )

        const list = pool.length > 0 ? pool : s.suggestions
        const pick = list[Math.floor(Math.random() * list.length)]!.level

        s.level = { address: pick.address, name: pick.name }
        s.levelInfo = null

        if (s.levelOptions.length > 0) {
            s.levelOptions = []
            this.sendAll({ type: 'updateLevelOptions', levelOptions: [] })
        }

        this.sendLevel()
        this.pushScoreboard()

        s.levelInfo = await fetchLevelInfo(s.level)
        this.pushScoreboard()
    }

    private hostIsTournament(): boolean {
        const host = this.st.members.find((m) => m.id === this.st.hostId)
        return (host?.handle ?? '') === TOURNAMENT_HOST_HANDLE
    }

    private roundBusy(): boolean {
        const s = this.st

        return s.members.some(
            (member) =>
                this.socketsOf(member.id).length > 0 &&
                (s.statuses[member.id] === 'ready' ||
                    s.statuses[member.id] === 'playing'),
        )
    }

    private async maybeFinishRound(immediate: boolean): Promise<void> {
        const s = this.st

        if (s.status !== 'playing' || !s.round || this.roundBusy()) return

        if (!immediate) {
            if (this.activeSocketCount() > 0) {
                await this.scheduleNextAlarm(8000)
            }
            return
        }

        await this.changeStatus(s.hostId, 'selecting')
    }

    private hostPresent = () =>
        this.socketsOf(this.st.hostId).length > 0

    private view(uid: string): Ev {
        const state = this.st
        const isHost = uid === state.hostId
        const master = this.hostPresent() ? state.hostId : null

        const activeMembers = state.members.filter(
            (member) => this.socketsOf(member.id).length > 0,
        )
        const canEditLevelOptions = state.settings.type === 'casualRoom' && state.status === 'selecting'

        return {
            type: 'update',
            allowOtherServers: true,
            reportUserOptions: [],
            title: getRoomTitle(state.settings, state.edition, state.hostName),
            status: state.status,
            master,
            lead: master,
            options: [
                ...roomFormsForType(
                    state.settings.type,
                    this.hostIsTournament(),
                    state.editionOptions,
                ),
                ...(isHost ? [closeRoomForm] : []),
            ],
            optionValues: serializeSettings(state.settings),
            level: isHost ||
                isOpenType(state.settings.type) ||
                state.status !== 'selecting'
                ? state.level
                : null,
            levelOptions: canEditLevelOptions
                ? state.levelOptions
                : [],
            autoExit: 'off',
            isSuggestionsLocked: state.settings.type === 'rankedRoom' ||
                (state.settings.type !== 'casualRoom' && !isHost),
            suggestions: isHost || state.settings.type === 'casualRoom'
                ? state.suggestions
                : [],
            scoreboardDescription: '',
            scoreboardSections: this.canSee(uid) ? this.sections() : [],
            results: Object.entries(state.results)
                .filter(([id]) => this.canSee(uid) || id === uid)
                .map(([userId, result]) => ({
                    userId,
                    result: sanitizeWireResult(result),
                })),
            users: activeMembers.map((member) => member.roomUser),
            userStatuses: activeMembers.map((member) => ({
                userId: member.id,
                status: state.statuses[member.id] ?? 'waiting',
            })),
        }
    }

    private effectiveRoundScore(
        userId: string,
        result: GameplayResult,
        round: RoundRecord,
        priorHistory: RoundRecord[],
        mode: RoomSettings['scoring'],
    ): number {
        if (isOpenType(this.st.settings.type)) {
            return roundPoints(result, mode, round)
        }

        const kind = round.roundKind ?? 'tournament'
        if (kind === 'warmup' || kind === 'freeplay') {
            return 0
        }

        if (kind === 'rewind') {
            const eligible = unresolvedXUsersForSong(round.level, priorHistory)
            if (!eligible.has(userId) || isPlayerX(result)) {
                return 0
            }
        }

        return roundPoints(result, mode, round)
    }

    private sections() {
        try {
            const state = this.st
            const mode = state.settings.scoring
            const open = isOpenType(state.settings.type)

            const presentMembers = state.members.filter(
                (member) => this.socketsOf(member.id).length > 0,
            )
            const present = new Set(presentMembers.map((member) => member.id))

            const live: RoundRecord | null =
                state.status === 'playing' &&
                Object.keys(state.results).length > 0
                    ? this.makeRoundRecord(state.history)
                    : null

            const history = live ? [...state.history, live] : state.history
            const allTotals = open ? totals(history, mode) : (() => {
                const map = new Map<string, number>()
                for (const member of state.members) {
                    map.set(member.id, 0)
                }

                for (let idx = 0; idx < history.length; idx++) {
                    const rec = history[idx]!
                    const prior = history.slice(0, idx)
                    for (const [userId, res] of Object.entries(rec.results ?? {})) {
                        const gained = this.effectiveRoundScore(userId, res, rec, prior, mode)
                        map.set(userId, (map.get(userId) ?? 0) + gained)
                    }
                }

                return [...map.entries()]
                    .map(([userId, score]) => ({ userId, score }))
                    .sort((a, b) => b.score - a.score)
            })()

            const output: {
                title: string
                scores: {
                    userId: string
                    value: string
                }[]
            }[] = []

            const divisions = this.getDivisions(presentMembers)

            for (const division of divisions) {
                const divisionIds = new Set(division.members.map((member) => member.id))
                const divisionTotals = allTotals
                    .filter((total) => divisionIds.has(total.userId) && present.has(total.userId))

                output.push({
                    title: division.title
                        ? `Standings · ${division.title}`
                        : 'Standings',
                    scores: divisionTotals.map((total) => ({
                        userId: total.userId,
                        value: fmtScore(total.score, mode),
                    })),
                })
            }

            if (state.settings.type !== 'casualRoom') {
                for (const member of state.members) {
                    if (present.has(member.id)) continue

                    const total = allTotals.find((t) => t.userId === member.id)
                    if (!total) continue

                    output.push({
                        title: `Left · ${member.name || member.handle} · ${fmtScore(total.score, mode)}`,
                        scores: [],
                    })
                }
            }

            const roundSection = (
                round: RoundRecord,
                priorHistory: RoundRecord[],
                isLive = false,
            ) => {
                const kind = round.roundKind ?? 'tournament'
                const baseLabel =
                    round.roundLabel ||
                    buildRoundLabel(round.level, kind, priorHistory, open, state.settings.type === 'ultimateEdition' ? state.poolCharts : [])
                const label = isLive ? `${baseLabel} (live)` : baseLabel
                const song = round.levelTitle || round.level?.name
                const title = song
                    ? `${label} · ${song}${round.levelTag ? ` ${round.levelTag}` : ''}${round.levelRating != null ? ` Lvl.${round.levelRating}` : ''}`
                    : label

                const scores = Object.entries(round.results)
                    .sort(([, a], [, b]) => compareResults(a, b, mode, round))
                    .map(([userId, result]) => ({
                        userId,
                        value: fmtDetail(result, mode, round),
                    }))

                output.push({ title, scores })
            }

            if (live) {
                roundSection(live, state.history, true)
            }

            for (let index = state.history.length - 1; index >= 0; index--) {
                const rec = state.history[index]!
                roundSection(rec, state.history.slice(0, index), false)
            }

            return output
        } catch (error) {
            console.error('[Room] Failed building scoreboard sections:', error)
            return []
        }
    }

    private getDivisions(members: Member[]) {
        const type = this.st.settings.type

        if (isOpenType(type)) {
            return [{ title: '', members }]
        }

        if (type === 'ultimateEdition') {
            const assigned = members.filter(
                (member) => this.st.ultimateParticipants.includes(member.handle),
            )
            const unassigned = members.filter(
                (member) => !this.st.ultimateParticipants.includes(member.handle),
            )

            return [
                ...(assigned.length ? [{ title: '', members: assigned }] : []),
                ...(unassigned.length ? [{ title: 'Unassigned', members: unassigned }] : []),
            ]
        }

        if (type === 'groupStage') {
            const groupNames = [
                ...new Set(
                    Object.values(this.st.divisions)
                        .filter((division) => /^Group\s+/i.test(division))
                        .map((division) => division.replace(/^Group\s+/i, '').trim()),
                ),
            ].sort((a, b) => a.localeCompare(b, undefined, {
                numeric: true,
                sensitivity: 'base',
            }))

            const groups = groupNames.map((group) => ({
                title: `Group ${group}`,
                members: members.filter(
                    (member) => this.st.divisions[member.handle] === `Group ${group}`,
                ),
            })).filter((division) => division.members.length > 0)

            const assigned = new Set(
                groups.flatMap((division) => division.members.map((member) => member.id)),
            )

            const unassigned = members.filter((member) => !assigned.has(member.id))
            if (unassigned.length > 0) {
                groups.push({ title: 'Unassigned', members: unassigned })
            }

            return groups
        }

        const brackets = [
            {
                title: 'Upper Bracket',
                members: members.filter(
                    (member) => this.st.divisions[member.handle] === 'Upper Bracket',
                ),
            },
            {
                title: 'Lower Bracket',
                members: members.filter(
                    (member) => this.st.divisions[member.handle] === 'Lower Bracket',
                ),
            },
        ].filter((division) => division.members.length > 0)

        const assigned = new Set(
            brackets.flatMap((division) => division.members.map((member) => member.id)),
        )

        const unassigned = members.filter((member) => !assigned.has(member.id))
        if (unassigned.length > 0) {
            brackets.push({ title: 'Unassigned', members: unassigned })
        }

        return brackets
    }

    private pushScoreboard(): void {
        const scoreboardSections = this.sections()

        for (const member of this.st.members) {
            if (this.canSee(member.id)) {
                this.sendTo(member.id, {
                    type: 'updateScoreboardSections',
                    scoreboardSections,
                })
            }
        }
    }

    private async dropMember(
        uid: string,
        announce: boolean,
        retain = false,
    ): Promise<void> {
        const state = this.st
        const member = state.members.find((entry) => entry.id === uid)
        if (!member) return

        if (retain) {
            if (
                state.status === 'playing' &&
                (state.statuses[uid] === 'playing' || state.statuses[uid] === 'ready') &&
                !state.results[uid]
            ) {
                const result: GameplayResult = {
                    grade: 'fail',
                    score: 0,
                    accuracy: 0,
                    arcadeScore: 0,
                    accuracyScore: 0,
                    combo: 0,
                    perfect: 0,
                    great: 0,
                    good: 0,
                    miss: 0,
                    totalCount: 0,
                }

                state.results[uid] = result
                if (announce) this.sendResult(uid, result)
            }

            state.statuses[uid] = 'waiting'

            if (announce) {
                this.sendAll({
                    type: 'removeUser',
                    user: member.roomUser,
                })
            }
        } else {
            state.members = state.members.filter((entry) => entry.id !== uid)
            delete state.statuses[uid]
            delete state.results[uid]

            if (announce) {
                this.sendAll({
                    type: 'removeUser',
                    user: member.roomUser,
                })
            }
        }

        if (announce) this.pushScoreboard()

        await this.save()
        await this.maybeFinishRound(true)
        await this.save()

        if (this.activeSocketCount() === 0) {
            await this.scheduleNextAlarm(EMPTY_ROOM_TTL_MS)
        } else {
            await this.scheduleNextAlarm()
        }
    }

    private closing = new WeakSet<WebSocket>()

    private socketsOf = (uid: string) =>
        this.ctx.getWebSockets().filter(
            (socket) =>
                !this.closing.has(socket) &&
                (socket.deserializeAttachment() as { userId?: string } | null)?.userId === uid,
        )

    private send(ws: WebSocket, event: Ev) {
        try {
            ws.send(JSON.stringify(event))
        } catch {
            // Socket already closed.
        }
    }

    private sendTo(uid: string, event: Ev) {
        for (const socket of this.socketsOf(uid)) {
            this.send(socket, event)
        }
    }

    private sendAll(event: Ev) {
        for (const member of this.st.members) {
            this.sendTo(member.id, event)
        }
    }

    private sendExcept(uid: string, event: Ev) {
        for (const member of this.st.members) {
            if (member.id !== uid) {
                this.sendTo(member.id, event)
            }
        }
    }

    private sendHost(event: Ev) {
        this.sendTo(this.st.hostId, event)
    }

    private resync(uid: string) {
        this.sendTo(uid, this.view(uid))
    }

    private async save(): Promise<void> {
        await this.ctx.storage.put('st', this.st)
    }

    private async syncLobby(): Promise<void> {
        const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('main'))

        await lobby.upsert({
            name: this.st.name,
            title: getRoomTitle(this.st.settings, this.st.edition, this.st.hostName),
            subtitle: this.subtitle(),
            master: this.st.hostName,
            hostId: this.st.hostId,
            visibility: this.st.settings.visibility,
        })
    }
}