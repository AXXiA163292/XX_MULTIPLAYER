
import { DurableObject } from 'cloudflare:workers'
import {
    EMPTY_ROOM_TTL_MS,
    RESERVED_ROOM_TTL_MS,
    SCORING_MODES,
    SERVER_DESCRIPTION,
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
        scoring: 'rankedMatch',
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

const getRoomTitle = (settings: RoomSettings) =>
    settings.type === 'groupStage'
        ? `Group ${settings.group || 'A'}`
        : `${SERVER_DESCRIPTION} Final`

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
                    redirect: 'error',
                    signal: AbortSignal.timeout(5000),
                })

                if (!response.ok) continue

                const data: any = await response.json()
                const item = data.item ?? data

                return {
                    title: localize(item.title) || level.name,
                    firstTag: localize(item.tags?.[0]?.title),
                    rating: typeof item.rating === 'number'
                        ? item.rating
                        : null,
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
    ['allPerfect', 'fullCombo', 'pass', 'fail'].includes(r.grade) &&
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

    // ------------------------------------------------------------------
    // Room reservation and configuration
    // ------------------------------------------------------------------

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
            subtitle: SCORING_MODES[this.st.settings.scoring],
            master: this.st.hostName,
        }
    }

    // ------------------------------------------------------------------
    // WebSocket entry
    // ------------------------------------------------------------------

    async fetch(request: Request): Promise<Response> {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 })
        }

        const join = JSON.parse(
            decodeURIComponent(request.headers.get('x-join') ?? 'null'),
        ) as JoinSession | null

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

    // ------------------------------------------------------------------
    // WebSocket handlers
    // ------------------------------------------------------------------

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

    // ------------------------------------------------------------------
    // Command handling
    // ------------------------------------------------------------------

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

                this.sendAll({
                    type: 'updateLevel',
                    level: s.level,
                })

                this.pushScoreboard()
                return
            }

            case 'updateOptionValues': {
                const next =
                    typeof cmd.optionValues === 'string'
                        ? parseSettings(cmd.optionValues)
                        : null

                // Settings can only be changed by the host before
                // the first round begins.
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

                const titleChanged =
                    next.type !== s.settings.type ||
                    next.group !== s.settings.group

                s.settings = next

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
                    this.sendHost({
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

            // Only the host can manage suggestions.
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

            // Locked controls are rejected.
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

                if (valid) {
                    s.results[uid] = cmd.result
                    s.statuses[uid] = 'waiting'

                    this.sendAll({
                        type: 'updateUserStatus',
                        userStatus: {
                            userId: uid,
                            status: 'waiting',
                        },
                    })

                    this.sendHost({
                        type: 'addResult',
                        result: {
                            userId: uid,
                            result: cmd.result,
                        },
                    })

                    this.pushScoreboard()
                }

                return this.resync(uid)
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

    // ------------------------------------------------------------------
    // Status changes
    // ------------------------------------------------------------------

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
                s.history.push({
                    level: s.level,
                    levelTitle: s.levelInfo?.title,
                    levelTag: s.levelInfo?.firstTag,
                    levelRating: s.levelInfo?.rating ?? undefined,
                    results: { ...s.results },
                })
            }

            s.results = {}
            s.round = null
            s.status = 'selecting'
            waitAll()

            this.sendAll({
                type: 'updateStatus',
                status: 'selecting',
            })

            this.pushScoreboard()
        } else {
            return this.resync(uid)
        }
    }

    // ------------------------------------------------------------------
    // State views
    // ------------------------------------------------------------------

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

        const canEditSettings =
            isHost &&
            s.status === 'selecting' &&
            s.history.length === 0

        return {
            type: 'update',
            allowOtherServers: true,
            reportUserOptions: [],
            title: getRoomTitle(s.settings),
            status: s.status,
            master,
            lead: master,

            // Only the host sees settings, and only before round 1.
            options: canEditSettings ? roomForms() : [],
            optionValues: serializeSettings(s.settings),

            level: s.level,
            levelOptions: [],
            autoExit: 'off',

            isSuggestionsLocked: !isHost,
            suggestions: isHost ? s.suggestions : [],

            scoreboardDescription: isHost
                ? this.description()
                : undefined,

            scoreboardSections: isHost
                ? this.sections()
                : [],

            results: isHost
                ? Object.entries(s.results)
                    .filter(([id]) => present.has(id))
                    .map(([userId, result]) => ({
                        userId,
                        result,
                    }))
                : [],

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
                ? `PP scoring. ${tb}`
                : `PP scoring (formula not set yet, all 0). ${tb}`
        }

        return `Ranked Match: Perfect ×3, Great ×2, Good ×1. ${tb}`
    }

    private sections() {
        const s = this.st
        const mode = s.settings.scoring

        const present = new Set(
            s.members.map((m) => m.id),
        )

        const name = (id: string) =>
            s.members.find((m) => m.id === id)

        const live: RoundRecord | null =
            s.status === 'playing' &&
            Object.keys(s.results).length > 0
                ? {
                    level: s.level,
                    levelTitle: s.levelInfo?.title,
                    levelTag: s.levelInfo?.firstTag,
                    levelRating: s.levelInfo?.rating ?? undefined,
                    results: s.results,
                }
                : null

        const out: {
            title: string
            scores: {
                userId: string
                value: string
            }[]
        }[] = []

        out.push({
            title: `Total · ${SCORING_MODES[mode]}`,
            scores: totals(
                live
                    ? [...s.history, live]
                    : s.history,
                mode,
            )
                .filter((t) => present.has(t.userId))
                .map((t) => ({
                    userId: t.userId,
                    value: fmtScore(t.score, mode),
                })),
        })

        const roundSection = (
            r: RoundRecord,
            label: string,
        ) => {
            const song = r.levelTitle || r.level?.name

            const title = song
                ? `${label} · ${song}${r.levelTag ? ` ${r.levelTag}` : ''}${r.levelRating != null ? ` Lvl.${r.levelRating}` : ''}`
                : label

            return {
                title,
                scores: Object.entries(r.results)
                    .filter(
                        ([id]) =>
                            present.has(id) &&
                            name(id),
                    )
                    .sort(
                        ([, a], [, b]) =>
                            compareResults(a, b, mode),
                    )
                    .map(([userId, res]) => ({
                        userId,
                        value: fmtDetail(res, mode),
                    })),
            }
        }

        if (live) {
            out.push(
                roundSection(
                    live,
                    `Round ${s.history.length + 1} (live)`,
                ),
            )
        }

        for (let i = s.history.length - 1; i >= 0; i--) {
            out.push(
                roundSection(
                    s.history[i]!,
                    `Round ${i + 1}`,
                ),
            )
        }

        return out
    }

    private pushScoreboard(): void {
        this.sendHost({
            type: 'updateScoreboardSections',
            scoreboardSections: this.sections(),
        })
    }

    // ------------------------------------------------------------------
    // Plumbing
    // ------------------------------------------------------------------

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