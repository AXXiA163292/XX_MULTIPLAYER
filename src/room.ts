import { DurableObject } from 'cloudflare:workers'
import {
    EMPTY_ROOM_TTL_MS,
    RESERVED_ROOM_TTL_MS,
    SCORING_MODES,
    SERVER_DESCRIPTION,
    ACTIVE_EDITION,
    EDITIONS,
    GROUP_ORDER,
    getChartConstant,
    getDivision,
} from './config.ts'
import {
    parseSettings,
    roomForms,
    serializeSettings,
    type RoomSettings,
} from './forms.ts'
import {
    PP_CONFIGURED,
    compareResults,
    fmtDetail,
    fmtScore,
    totals,
    type RoundRecord,
} from './scoring.ts'
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

type RoomState = {
    name: string
    reserved: Reservation | null
    configured: boolean
    hostId: string
    hostName: string
    settings: RoomSettings
    status: RoomStatus
    level: Sil | null
    levelInfo: LevelInfo | null
    suggestions: { userId: string; level: Sil }[]
    members: Member[]
    statuses: Record<string, UserStatus>
    round: { state: string; seed: number } | null
    results: Record<string, GameplayResult>
    history: RoundRecord[]
}

const fresh = (): RoomState => ({
    name: '',
    reserved: null,
    configured: false,
    hostId: '',
    hostName: '',
    settings: {
        type: 'groupStage',
        scoring: 'pp',
        group: 'A',
    },
    status: 'selecting',
    level: null,
    levelInfo: null,
    suggestions: [],
    members: [],
    statuses: {},
    round: null,
    results: {},
    history: [],
})

const getRoomTitle = (settings: RoomSettings) => {
    if (settings.type === 'groupStage') {
        return `Group ${settings.group || 'A'}`
    }

    if (settings.type === 'casualRoom') {
        return 'Casual Room'
    }

    return `${SERVER_DESCRIPTION} Final`
}

function songPoolSuggestions(
    type: RoomSettings['type'],
    userId: string,
) {
    if (type === 'casualRoom') return []

    const edition = EDITIONS[ACTIVE_EDITION]
    const charts = type === 'groupStage'
        ? edition?.groupStage
        : edition?.final

    if (!Array.isArray(charts)) return []

    return charts.flatMap((chart) => {
        if (!chart || typeof chart.url !== 'string') return []

        try {
            const url = new URL(chart.url)
            const match = url.pathname.match(/^\/levels\/([^/]+)\/?$/)

            if (
                url.protocol !== 'https:' ||
                url.hostname !== 'untitledcharts.com' ||
                !match
            ) return []

            return [{
                userId,
                level: {
                    address: url.origin,
                    name: decodeURIComponent(match[1]!),
                },
            }]
        } catch {
            return []
        }
    })
}

const localize = (value: any): string => {
    if (typeof value === 'string') return value

    if (value && typeof value === 'object') {
        if (typeof value.en === 'string') return value.en

        const first = Object.values(value).find(
            (v) => typeof v === 'string',
        )

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
        new RegExp(`${escaped}\\s*•\\s*(\\d+(?:\\.\\d+)?)`, 'i'),
    )

    if (!match) return null

    const value = Number(match[1])
    return Number.isFinite(value) ? value : null
}

function extractDifficulty(description: string): string {
    const match = description.match(
        /Difficulty\s*•\s*(EASY|NORMAL|HARD|EXPERT|MASTER|APPEND)/i,
    )

    return match?.[1]?.toUpperCase() ?? ''
}

async function fetchLevelInfo(level: Sil): Promise<LevelInfo | null> {
    try {
        const base = new URL(level.address)

        if (
            base.protocol !== 'https:' ||
            base.username ||
            base.password
        ) return null

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
                    signal: AbortSignal.timeout(5000),
                })

                if (!response.ok) continue

                const data: any = await response.json()
                const item = data.item ?? data
                const description = descriptionText(item.description)

                const firstTag = localize(
                    item.tags?.find((tag: any) =>
                        ['EASY', 'NORMAL', 'HARD', 'EXPERT', 'MASTER', 'APPEND']
                            .some((difficulty) =>
                                localize(tag?.title)
                                    .toUpperCase()
                                    .startsWith(difficulty),
                            ),
                    )?.title,
                )

                const difficulty =
                    extractDifficulty(description) ||
                    firstTag.toUpperCase().match(
                        /EASY|NORMAL|HARD|EXPERT|MASTER|APPEND/,
                    )?.[0] ||
                    ''

                const noteCount = extractDescriptionNumber(
                    description,
                    'Combo',
                )

                const rawRating = item.rating
                const parsedRating = typeof rawRating === 'number'
                    ? rawRating
                    : typeof rawRating === 'string'
                        ? Number(rawRating)
                        : NaN

                const rating = Number.isFinite(parsedRating) && parsedRating > 0
                    ? Math.round(parsedRating * 10) / 10
                    : null

                const configuredConstant =
                    getChartConstant(
                        level.address,
                        level.name,
                        'groupStage',
                    ) ??
                    getChartConstant(
                        level.address,
                        level.name,
                        'final',
                    )

                const descriptionConstant = extractDescriptionNumber(
                    description,
                    'Constant',
                )

                const constant =
                    configuredConstant ??
                    descriptionConstant ??
                    rating

                return {
                    title: localize(item.title) || level.name,
                    firstTag: difficulty || firstTag,
                    rating,
                    constant,
                    noteCount,
                    difficulty,
                }
            } catch {
                continue
            }
        }
    } catch {
        return null
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

export class Room extends DurableObject<Env> {
    st: RoomState = fresh()

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)

        ctx.blockConcurrencyWhile(async () => {
            this.st = (await ctx.storage.get<RoomState>('st')) ?? fresh()
            this.st.settings.group ||= 'A'
            this.st.levelInfo ??= null
        })
    }

    async reserve(name: string, reservation: Reservation): Promise<void> {
        this.st = {
            ...fresh(),
            name,
            reserved: reservation,
        }

        await this.save()
        await this.ctx.storage.setAlarm(
            Date.now() + RESERVED_ROOM_TTL_MS,
        )
    }

    async configure(
        key: string,
        settings: RoomSettings,
        host: { id: string; name: string; handle: string },
    ) {
        const r = this.st.reserved

        if (
            !r ||
            r.key !== key ||
            r.hostId !== host.id ||
            r.hostHandle !== host.handle
        ) return false

        this.st.configured = true
        this.st.hostId = host.id
        this.st.hostName = host.name
        this.st.settings = settings
        this.st.suggestions = songPoolSuggestions(settings.type, host.id)
        this.st.reserved = null

        await this.save()
        await this.syncLobby()

        return true
    }

    async isOpen(): Promise<boolean> {
        return this.st.configured
    }

    async summary() {
        if (!this.st.configured) return null

        return {
            name: this.st.name,
            title: getRoomTitle(this.st.settings),
            subtitle: '',
            master: this.st.hostName,
        }
    }

    async fetch(request: Request): Promise<Response> {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 })
        }

        let join: JoinSession | null

        try {
            join = JSON.parse(
                decodeURIComponent(
                    request.headers.get('x-join') ?? 'null',
                ),
            ) as JoinSession | null
        } catch {
            return new Response('Invalid join session', { status: 400 })
        }

        if (
            !join ||
            !this.st.configured ||
            join.room !== this.st.name
        ) {
            return new Response('No such room', { status: 404 })
        }

        const { 0: client, 1: server } = new WebSocketPair()
        const user = join.user

        if (this.st.members.some((m) => m.id === user.id)) {
            for (const ws of this.socketsOf(user.id)) {
                ws.close(4000, 'replaced')
            }

            await this.dropMember(user.id, false)
        }

        this.ctx.acceptWebSocket(server)
        server.serializeAttachment({ userId: user.id })

        await this.ctx.storage.deleteAlarm()

        const member: Member = {
            id: user.id,
            name: user.name,
            handle: user.handle,
            roomUser: join.roomUser,
        }

        this.st.members.push(member)
        this.st.statuses[user.id] = 'waiting'

        await this.save()

        this.send(server, this.view(user.id))

        this.sendExcept(user.id, {
            type: 'addUser',
            user: member.roomUser,
        })

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

        return new Response(null, {
            status: 101,
            webSocket: client,
        })
    }

    async webSocketMessage(
        ws: WebSocket,
        raw: string | ArrayBuffer,
    ): Promise<void> {
        const att = ws.deserializeAttachment() as {
            userId: string
        } | null

        if (!att || typeof raw !== 'string') return

        let cmd: Cmd

        try {
            cmd = JSON.parse(raw)
        } catch {
            return
        }

        if (!this.st.members.some((m) => m.id === att.userId)) return

        try {
            await this.handle(att.userId, cmd)
        } catch (e) {
            console.error('command failed', cmd?.type, e)
            this.resync(att.userId)
        }

        await this.save()
    }

    async webSocketClose(ws: WebSocket): Promise<void> {
        const att = ws.deserializeAttachment() as {
            userId: string
        } | null

        if (!att) return

        if (this.socketsOf(att.userId).some((s) => s !== ws)) return

        await this.dropMember(att.userId, true)
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        await this.webSocketClose(ws)
    }

    async alarm(): Promise<void> {
        const empty = this.ctx.getWebSockets().length === 0

        if (!empty) return

        await this.env.LOBBY
            .get(this.env.LOBBY.idFromName('main'))
            .remove(this.st.name)

        await this.ctx.storage.deleteAll()
        this.st = fresh()
    }

    private async handle(uid: string, cmd: Cmd): Promise<void> {
        const s = this.st
        const isHost = uid === s.hostId

        switch (cmd.type) {
            case 'updateLevel': {
                if (
                    !isHost ||
                    s.status !== 'selecting' ||
                    !isSil(cmd.level)
                ) {
                    return this.resync(uid)
                }

                s.level = {
                    address: cmd.level.address,
                    name: cmd.level.name,
                }

                s.levelInfo = await fetchLevelInfo(s.level)

                this.sendHost({
                    type: 'updateLevel',
                    level: s.level,
                })

                if (s.settings.type === 'casualRoom') {
                    this.sendExcept(uid, {
                        type: 'updateLevel',
                        level: s.level,
                    })
                } else {
                    this.sendExcept(uid, {
                        type: 'updateLevel',
                        level: null,
                    })
                }

                this.pushScoreboard()
                return
            }

            case 'updateOptionValues': {
                const next =
                    typeof cmd.optionValues === 'string'
                        ? parseSettings(cmd.optionValues)
                        : null

                if (
                    !isHost ||
                    !next ||
                    s.status !== 'selecting' ||
                    s.history.length > 0
                ) {
                    return this.resync(uid)
                }

                const modeChanged =
                    next.scoring !== s.settings.scoring

                const typeChanged =
                    next.type !== s.settings.type

                const titleChanged =
                    typeChanged ||
                    next.group !== s.settings.group

                s.settings = next

                if (typeChanged) {
                    s.suggestions = songPoolSuggestions(next.type, uid)

                    this.sendHost({
                        type: 'updateSuggestions',
                        suggestions: s.suggestions,
                    })

                    if (next.type !== 'casualRoom' && s.level) {
                        this.sendExcept(uid, {
                            type: 'updateLevel',
                            level: null,
                        })
                    } else if (s.level) {
                        this.sendExcept(uid, {
                            type: 'updateLevel',
                            level: s.level,
                        })
                    }
                }

                this.sendAll({
                    type: 'updateOptionValues',
                    optionValues: serializeSettings(next),
                })

                if (titleChanged) {
                    this.sendAll({
                        type: 'updateTitle',
                        title: getRoomTitle(next),
                    })
                }

                if (modeChanged) {
                    this.sendAll({
                        type: 'updateScoreboardDescription',
                        scoreboardDescription: this.description(),
                    })

                    this.pushScoreboard()
                }

                await this.syncLobby()
                return
            }

            case 'updateStatus':
                return isHost
                    ? this.changeStatus(uid, cmd.status)
                    : this.resync(uid)

            case 'removeUser': {
                if (
                    !isHost ||
                    cmd.userId === uid ||
                    !s.members.some((m) => m.id === cmd.userId)
                ) {
                    return this.resync(uid)
                }

                const target = cmd.userId as string

                for (const ws of this.socketsOf(target)) {
                    ws.close(4001, 'kicked')
                }

                await this.dropMember(target, true)
                return
            }

            case 'resetScoreboard': {
                if (!isHost) return this.resync(uid)

                s.history = []
                this.pushScoreboard()
                return
            }

            case 'addSuggestion': {
                if (!isHost || !isSil(cmd.level)) {
                    return this.resync(uid)
                }

                if (
                    !s.suggestions.some(
                        (x) =>
                            x.level.address === cmd.level.address &&
                            x.level.name === cmd.level.name,
                    )
                ) {
                    const suggestion = {
                        userId: uid,
                        level: {
                            address: cmd.level.address,
                            name: cmd.level.name,
                        },
                    }

                    s.suggestions.push(suggestion)

                    this.sendHost({
                        type: 'addSuggestion',
                        suggestion,
                    })
                }

                return
            }

            case 'removeSuggestion': {
                const i = s.suggestions.findIndex(
                    (x) =>
                        x.userId === cmd.suggestion?.userId &&
                        x.level.address === cmd.suggestion?.level?.address &&
                        x.level.name === cmd.suggestion?.level?.name,
                )

                if (!isHost || i < 0) return this.resync(uid)

                const [removed] = s.suggestions.splice(i, 1)

                this.sendHost({
                    type: 'removeSuggestion',
                    suggestion: removed,
                })

                return
            }

            case 'clearSuggestions': {
                if (!isHost) return this.resync(uid)

                s.suggestions = []

                this.sendHost({
                    type: 'clearSuggestions',
                })

                return
            }

            case 'swapSuggestions': {
                const find = (q: any) =>
                    s.suggestions.findIndex(
                        (x) =>
                            x.userId === q?.userId &&
                            x.level.address === q?.level?.address &&
                            x.level.name === q?.level?.name,
                    )

                const a = find(cmd.suggestionA)
                const b = find(cmd.suggestionB)

                if (!isHost || a < 0 || b < 0 || a === b) {
                    return this.resync(uid)
                }

                ;[s.suggestions[a], s.suggestions[b]] = [
                    s.suggestions[b]!,
                    s.suggestions[a]!,
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
            case 'updateLevelOption':
            case 'updateIsSuggestionsLocked':
                return this.resync(uid)

            case 'updateUserStatus': {
                const want = cmd.status as UserStatus

                const allowed: UserStatus[] = isHost
                    ? ['waiting', 'ready', 'skipped']
                    : ['waiting', 'ready']

                if (
                    s.status !== 'preparing' ||
                    !allowed.includes(want)
                ) {
                    return this.resync(uid)
                }

                s.statuses[uid] = want

                this.sendAll({
                    type: 'updateUserStatus',
                    userStatus: {
                        userId: uid,
                        status: want,
                    },
                })

                return
            }

            case 'startGameplay': {
                if (
                    s.status !== 'playing' ||
                    !s.round ||
                    cmd.state !== s.round.state ||
                    s.statuses[uid] !== 'ready'
                ) {
                    return
                }

                s.statuses[uid] = 'playing'

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
                    s.status === 'playing' &&
                    s.round &&
                    cmd.state === s.round.state &&
                    isResult(cmd.result) &&
                    !s.results[uid]

                if (!valid) {
                    return this.resync(uid)
                }

                s.results[uid] = cmd.result
                s.statuses[uid] = 'waiting'

                this.sendAll({
                    type: 'updateUserStatus',
                    userStatus: {
                        userId: uid,
                        status: 'waiting',
                    },
                })

                this.sendAll({
                    type: 'addResult',
                    result: {
                        userId: uid,
                        result: cmd.result,
                    },
                })

                this.pushScoreboard()
                return
            }

            case 'addChatMessage': {
                const m = cmd.message
                let message: Ev | null = null

                if (
                    m?.type === 'quick' &&
                    ['hello', 'glhf', 'gg', 'ns', 'ty'].includes(m.value)
                ) {
                    message = {
                        userId: uid,
                        type: 'quick',
                        value: m.value,
                    }
                } else if (
                    m?.type === 'text' &&
                    typeof m.value === 'string' &&
                    m.value.trim()
                ) {
                    message = {
                        userId: uid,
                        type: 'text',
                        value: m.value.slice(0, 200),
                    }
                }

                if (!message) return

                for (const member of s.members) {
                    const ev: Ev = {
                        type: 'addChatMessage',
                        message,
                    }

                    if (
                        member.id === uid &&
                        typeof cmd.nonce === 'number'
                    ) {
                        ev.nonce = cmd.nonce
                    }

                    this.sendTo(member.id, ev)
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
        const s = this.st
        const cur = s.status

        const waitAll = () => {
            for (const m of s.members) {
                s.statuses[m.id] = 'waiting'
            }
        }

        if (
            cur === 'selecting' &&
            next === 'preparing' &&
            s.level
        ) {
            s.status = 'preparing'
            waitAll()

            this.sendAll({
                type: 'updateStatus',
                status: 'preparing',
            })
        } else if (
            cur === 'preparing' &&
            next === 'selecting'
        ) {
            s.status = 'selecting'
            waitAll()

            this.sendAll({
                type: 'updateStatus',
                status: 'selecting',
            })

            if (s.settings.type !== 'casualRoom') {
                for (const member of s.members) {
                    if (member.id !== s.hostId) {
                        this.sendTo(member.id, {
                            type: 'updateLevel',
                            level: null,
                        })
                    }
                }
            }
        } else if (
            cur === 'preparing' &&
            next === 'playing'
        ) {
            if (
                !s.members.some(
                    (m) =>
                        m.id !== s.hostId &&
                        s.statuses[m.id] === 'ready',
                ) &&
                s.statuses[s.hostId] !== 'ready'
            ) {
                return this.resync(uid)
            }

            s.status = 'playing'
            s.results = {}
            s.round = {
                state: crypto.randomUUID(),
                seed: Math.random(),
            }

            for (const m of s.members) {
                if (s.statuses[m.id] === 'skipped') {
                    s.statuses[m.id] = 'waiting'
                }
            }

            this.sendAll({
                type: 'updateStatus',
                status: 'playing',
            })

            if (s.settings.type !== 'casualRoom' && s.level) {
                for (const member of s.members) {
                    if (member.id !== s.hostId) {
                        this.sendTo(member.id, {
                            type: 'updateLevel',
                            level: s.level,
                        })
                    }
                }
            }

            const start = {
                type: 'startRound',
                state: s.round.state,
                seed: s.round.seed,
            }

            for (const m of s.members) {
                if (s.statuses[m.id] === 'ready') {
                    this.sendTo(m.id, start)
                }
            }

            this.pushScoreboard()
        } else if (
            cur === 'playing' &&
            next === 'selecting'
        ) {
            if (Object.keys(s.results).length > 0) {
                s.history.push(this.makeRoundRecord())
            }

            s.results = {}
            s.round = null
            s.status = 'selecting'
            waitAll()

            this.sendAll({
                type: 'updateStatus',
                status: 'selecting',
            })

            if (s.settings.type !== 'casualRoom') {
                for (const member of s.members) {
                    if (member.id !== s.hostId) {
                        this.sendTo(member.id, {
                            type: 'updateLevel',
                            level: null,
                        })
                    }
                }
            }

            this.pushScoreboard()
        } else {
            return this.resync(uid)
        }
    }

    private makeRoundRecord(): RoundRecord {
        const info = this.st.levelInfo

        return {
            level: this.st.level,
            levelTitle: info?.title,
            levelTag: info?.firstTag,
            levelRating: info?.rating ?? undefined,
            levelConstant: info?.constant ?? undefined,
            noteCount: info?.noteCount ?? undefined,
            difficulty: info?.difficulty || info?.firstTag || undefined,
            results: { ...this.st.results },
        }
    }

    private hostPresent = () =>
        this.st.members.some(
            (m) => m.id === this.st.hostId,
        )

    private view(uid: string): Ev {
        const s = this.st
        const isHost = uid === s.hostId
        const master = this.hostPresent()
            ? s.hostId
            : null

        const present = new Set(
            s.members.map((m) => m.id),
        )

        const canSeeLevel =
            isHost ||
            s.settings.type === 'casualRoom' ||
            s.status === 'playing'

        return {
            type: 'update',
            allowOtherServers: true,
            reportUserOptions: [],
            title: getRoomTitle(s.settings),
            status: s.status,
            master,
            lead: master,
            options: roomForms(),
            optionValues: serializeSettings(s.settings),
            level: canSeeLevel ? s.level : null,
            levelOptions: [],
            autoExit: 'off',
            isSuggestionsLocked: !isHost,
            suggestions: isHost ? s.suggestions : [],
            scoreboardDescription: this.description(),
            scoreboardSections: this.sections(),
            results: Object.entries(s.results)
                .filter(([id]) => present.has(id))
                .map(([userId, result]) => ({
                    userId,
                    result,
                })),
            users: s.members.map((m) => m.roomUser),
            userStatuses: s.members.map((m) => ({
                userId: m.id,
                status: s.statuses[m.id] ?? 'waiting',
            })),
        }
    }

    private description(): string {
        const mode = this.st.settings.scoring
        const tb = 'Tiebreakers: most perfects, then highest combo.'

        if (mode === 'pp') {
            return PP_CONFIGURED
                ? `PP scoring. Each round is rounded up before the total. ${tb}`
                : `PP scoring unavailable. ${tb}`
        }

        return `Ranked Match: Perfect ×3, Great ×2, Good ×1. ${tb}`
    }

    private sections() {
        const s = this.st
        const mode = s.settings.scoring

        const presentMembers = s.members
        const present = new Set(presentMembers.map((m) => m.id))

        const live: RoundRecord | null =
            s.status === 'playing' &&
            Object.keys(s.results).length > 0
                ? this.makeRoundRecord()
                : null

        const history = live
            ? [...s.history, live]
            : s.history

        const out: {
            title: string
            scores: {
                userId: string
                value: string
            }[]
        }[] = []

        const divisions = this.getDivisions(presentMembers)

        for (const division of divisions) {
            const divisionIds = new Set(
                division.members.map((m) => m.id),
            )

            const divisionTotals = totals(history, mode)
                .filter((t) => divisionIds.has(t.userId))

            out.push({
                title: `Total · ${division.title}`,
                scores: divisionTotals.map((t) => ({
                    userId: t.userId,
                    value: fmtScore(t.score, mode),
                })),
            })
        }

        const roundSection = (
            round: RoundRecord,
            label: string,
        ) => {
            const song = round.levelTitle || round.level?.name

            const title = song
                ? `${label} · ${song}${round.levelTag ? ` ${round.levelTag}` : ''}${round.levelRating != null ? ` Lvl.${round.levelRating}` : ''}`
                : label

            for (const division of divisions) {
                const ids = new Set(
                    division.members.map((m) => m.id),
                )

                const scores = Object.entries(round.results)
                    .filter(
                        ([id]) =>
                            present.has(id) &&
                            ids.has(id),
                    )
                    .sort(
                        ([, a], [, b]) =>
                            compareResults(a, b, mode, round),
                    )
                    .map(([userId, result]) => ({
                        userId,
                        value: fmtDetail(result, mode, round),
                    }))

                out.push({
                    title: `${title} · ${division.title}`,
                    scores,
                })
            }
        }

        if (live) {
            roundSection(
                live,
                `Round ${s.history.length + 1} (live)`,
            )
        }

        for (let i = s.history.length - 1; i >= 0; i--) {
            roundSection(
                s.history[i]!,
                `Round ${i + 1}`,
            )
        }

        return out
    }

    private getDivisions(members: Member[]) {
        const type = this.st.settings.type

        if (type === 'casualRoom') {
            return [{
                title: 'All Players',
                members,
            }]
        }

        if (type === 'groupStage') {
            const groups = GROUP_ORDER.map((group) => ({
                title: `Group ${group}`,
                members: members.filter(
                    (member) =>
                        getDivision(member.handle, 'groupStage') === `Group ${group}`,
                ),
            })).filter((division) => division.members.length > 0)

            const assigned = new Set(
                groups.flatMap((division) =>
                    division.members.map((member) => member.id),
                ),
            )

            const unassigned = members.filter(
                (member) => !assigned.has(member.id),
            )

            if (unassigned.length > 0) {
                groups.push({
                    title: 'Unassigned',
                    members: unassigned,
                })
            }

            return groups
        }

        const brackets = [
            {
                title: 'Upper Bracket',
                members: members.filter(
                    (member) =>
                        getDivision(member.handle, 'final') === 'Upper Bracket',
                ),
            },
            {
                title: 'Lower Bracket',
                members: members.filter(
                    (member) =>
                        getDivision(member.handle, 'final') === 'Lower Bracket',
                ),
            },
        ].filter((division) => division.members.length > 0)

        const assigned = new Set(
            brackets.flatMap((division) =>
                division.members.map((member) => member.id),
            ),
        )

        const unassigned = members.filter(
            (member) => !assigned.has(member.id),
        )

        if (unassigned.length > 0) {
            brackets.push({
                title: 'Unassigned',
                members: unassigned,
            })
        }

        return brackets
    }

    private pushScoreboard(): void {
        this.sendAll({
            type: 'updateScoreboardSections',
            scoreboardSections: this.sections(),
        })
    }

    private async dropMember(
        uid: string,
        announce: boolean,
    ): Promise<void> {
        const s = this.st
        const m = s.members.find((x) => x.id === uid)

        if (!m) return

        s.members = s.members.filter(
            (x) => x.id !== uid,
        )

        delete s.statuses[uid]

        if (announce) {
            this.sendAll({
                type: 'removeUser',
                user: m.roomUser,
            })

            this.pushScoreboard()
        }

        await this.save()

        const otherSockets = this.ctx.getWebSockets().filter(
            (w) =>
                (w.deserializeAttachment() as {
                    userId?: string
                } | null)?.userId !== uid,
        )

        if (otherSockets.length === 0) {
            await this.ctx.storage.setAlarm(
                Date.now() + EMPTY_ROOM_TTL_MS,
            )
        }
    }

    private socketsOf = (uid: string) =>
        this.ctx.getWebSockets().filter(
            (w) =>
                (
                    w.deserializeAttachment() as {
                        userId?: string
                    } | null
                )?.userId === uid,
        )

    private send(ws: WebSocket, ev: Ev) {
        try {
            ws.send(JSON.stringify(ev))
        } catch {
            // Socket already closed.
        }
    }

    private sendTo(uid: string, ev: Ev) {
        for (const ws of this.socketsOf(uid)) {
            this.send(ws, ev)
        }
    }

    private sendAll(ev: Ev) {
        for (const m of this.st.members) {
            this.sendTo(m.id, ev)
        }
    }

    private sendExcept(uid: string, ev: Ev) {
        for (const m of this.st.members) {
            if (m.id !== uid) {
                this.sendTo(m.id, ev)
            }
        }
    }

    private sendHost(ev: Ev) {
        this.sendTo(this.st.hostId, ev)
    }

    private resync(uid: string) {
        this.sendTo(uid, this.view(uid))
    }

    private save() {
        return this.ctx.storage.put('st', this.st)
    }

    private async syncLobby() {
        const sum = await this.summary()

        if (sum) {
            await this.env.LOBBY
                .get(this.env.LOBBY.idFromName('main'))
                .upsert(sum)
        }
    }
}