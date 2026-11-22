import { DurableObject } from 'cloudflare:workers'
import {
    EMPTY_ROOM_TTL_MS,
    RESERVED_ROOM_TTL_MS,
    SCORING_MODES,
    SERVER_TITLE,
    TOURNAMENT_HOST_HANDLE,
} from './config.ts'
import {
    closeRoomForm,
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
import { getEditionData, pickRankedLevel, type EditionData, type RankedTier, type SheetChart } from './sheets.ts'
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
    edition: string
    divisions: Record<string, string>
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
    edition: '',
    divisions: {},
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
        customSongs: false,
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

/** Room types anyone can create (no tournament host needed). */
const isOpenType = (type: RoomSettings['type']) =>
    type === 'casualRoom' || type === 'rankedRoom'

const getRoomTitle = (settings: RoomSettings, edition = '') => {
    if (settings.type === 'rankedRoom') {
        return String(settings.tier || 'master').toUpperCase()
    }

    if (settings.type === 'groupStage') {
        return `Group ${settings.group || 'A'}`
    }

    if (settings.type === 'casualRoom') {
        return settings.title || 'Custom Room'
    }

    return edition
        ? `${SERVER_TITLE} • ${edition} Final`
        : `${SERVER_TITLE} • Final`
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

                const description = descriptionText(
                    data.description ?? item.description,
                )

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

                const descriptionConstant = extractDescriptionNumber(
                    description,
                    'Constant',
                )

                const constant = descriptionConstant ?? rating

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

    return null
}

type ScoreboardSection = {
    title: string
    scores: { userId: string; value: string }[]
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
                settings: {
                    ...base.settings,
                    ...(saved?.settings ?? {}),
                },
                edition: typeof saved?.edition === 'string'
                    ? saved.edition
                    : '',
                divisions: cleanDivisions(saved?.divisions),
                reserved: saved?.reserved ?? null,
                configured: saved?.configured === true,
                hostId: typeof saved?.hostId === 'string'
                    ? saved.hostId
                    : '',
                hostName: typeof saved?.hostName === 'string'
                    ? saved.hostName
                    : '',
                status: isRoomStatus(saved?.status)
                    ? saved.status
                    : 'selecting',
                level: saved?.level && isSil(saved.level)
                    ? saved.level
                    : null,
                levelInfo: saved?.levelInfo ?? null,
                levelOptions: Array.isArray(saved?.levelOptions)
                    ? saved.levelOptions.filter(
                        (x) =>
                            x &&
                            typeof x.name === 'string' &&
                            typeof x.value === 'number',
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
                history: Array.isArray(saved?.history)
                    ? saved.history
                    : [],
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

            this.st.settings.customSongs = this.st.settings.customSongs === true

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

            const memberIds = new Set(
                this.st.members.map((member) => member.id),
            )

            for (const id of Object.keys(this.st.statuses)) {
                if (!memberIds.has(id)) {
                    delete this.st.statuses[id]
                }
            }

            for (const id of Object.keys(this.st.results)) {
                if (!memberIds.has(id)) {
                    delete this.st.results[id]
                }
            }

            if (this.st.status === 'playing' && !this.st.round) {
                this.st.status = 'selecting'
                this.st.results = {}

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
    ): Promise<boolean> {
        const reservation = this.st.reserved

        if (
            !reservation ||
            reservation.key !== key ||
            reservation.hostId !== host.id ||
            reservation.hostHandle !== host.handle
        ) {
            return false
        }

        if (
            host.handle !== TOURNAMENT_HOST_HANDLE &&
            !isOpenType(settings.type)
        ) {
            return false
        }

        if (settings.type === 'casualRoom' && !settings.title) {
            settings.title = 'Custom Room'
        }

        let editionData: EditionData | null = null

        try {
            editionData = await getEditionData()
        } catch (error) {
            console.error('Could not load edition sheet while configuring room:', error)
        }

        if (editionData) {
            this.st.edition = editionData.edition
            this.st.divisions = cleanDivisions(editionData.divisions)
            this.st.suggestions = suggestionsFromCharts(
                chartsForType(editionData, settings.type),
                host.id,
            )
        } else {
            this.st.edition ||= 'Final'
            this.st.divisions = {}
            this.st.suggestions = await songPoolSuggestions(
                settings.type,
                host.id,
            )
        }

        this.st.configured = true
        this.st.hostId = host.id
        this.st.hostName = host.name
        this.st.settings = { ...settings }
        this.st.reserved = null
        this.st.status = 'selecting'
        this.st.level = null
        this.st.levelInfo = null
        this.st.levelOptions = []
        this.st.round = null
        this.st.results = {}
        this.st.history = []

        // Ranked Match: the room starts with a random ranked level already in place.
        if (settings.type === 'rankedRoom') await this.rollRankedLevel(false)

        await this.ctx.storage.deleteAlarm()
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
            title: getRoomTitle(this.st.settings, this.st.edition),
            subtitle: this.subtitle(),
            master: this.st.hostName,
            hostId: this.st.hostId,
            visibility: this.st.settings.visibility,
        }
    }

    /** Returns null when the user may join, otherwise the message to show. */
    async canJoin(user: { id: string; handle: string }): Promise<string | null> {
        if (!this.st.configured) return 'This room does not exist.'

        const s = this.st.settings

        if (user.id === this.st.hostId || user.handle === TOURNAMENT_HOST_HANDLE) return null

        // Locked rooms are closed for everybody (even registered players) until they are made public.
        if (s.visibility === 'locked') return 'This room is locked.'

        return null
    }

    private subtitle(): string {
        const s = this.st.settings
        const access = s.visibility === 'locked' ? 'Locked' : s.visibility === 'private' ? 'Private' : 'Public'
        return `${SCORING_MODES[s.scoring]} · ${access}${s.random ? ' · Random' : ''}`
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

        const existingMember = this.st.members.find(
            (member) => member.id === user.id,
        )

        const member: Member = existingMember ?? {
            id: user.id,
            name: user.name,
            handle: user.handle,
            roomUser: join.roomUser,
        }

        member.name = user.name
        member.handle = user.handle
        member.roomUser = join.roomUser

        this.st.members = this.st.members.filter(
            (entry) => entry.id !== user.id,
        )
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

        await this.ctx.storage.deleteAlarm()
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

        // Some clients keep showing the room id until a title event arrives.
        this.send(server, {
            type: 'updateTitle',
            title: getRoomTitle(this.st.settings, this.st.edition),
        })

        // A round that nobody is playing any more must not keep the room stuck in "playing".
        await this.maybeFinishRound(true)

        return new Response(null, {
            status: 101,
            webSocket: client,
        })
    }

    async webSocketMessage(
        ws: WebSocket,
        raw: string | ArrayBuffer,
    ): Promise<void> {
        const attachment = ws.deserializeAttachment() as {
            userId: string
        } | null

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
            this.resync(attachment.userId)
        }

        await this.save()
    }

    async webSocketClose(ws: WebSocket): Promise<void> {
        const attachment = ws.deserializeAttachment() as {
            userId: string
        } | null

        if (!attachment) return

        this.closing.add(ws)

        if (this.socketsOf(attachment.userId).some((socket) => socket !== ws)) {
            return
        }

        await this.dropMember(attachment.userId, true, true)
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        await this.webSocketClose(ws)
    }

    async alarm(): Promise<void> {
        if (this.ctx.getWebSockets().length > 0) {
            await this.maybeFinishRound(true)
            await this.save()
            return
        }

        await this.env.LOBBY
            .get(this.env.LOBBY.idFromName('main'))
            .remove(this.st.name)

        await this.ctx.storage.deleteAll()
        this.st = fresh()
    }

    private async closeRoom(uid: string): Promise<void> {
        if (uid !== this.st.hostId) {
            return this.resync(uid)
        }

        const roomName = this.st.name
        const sockets = this.ctx.getWebSockets()

        this.st = fresh()
        await this.save()
        await this.ctx.storage.deleteAlarm()

        await this.env.LOBBY
            .get(this.env.LOBBY.idFromName('main'))
            .remove(roomName)

        for (const socket of sockets) {
            try {
                socket.close(4002, 'room closed')
            } catch {
                // Socket may already be closed.
            }
        }
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

                // Ranked Match: "select" always gives a random level of the room's tier.
                if (state.settings.type === 'rankedRoom') {
                    if (!(await this.rollRankedLevel(true))) return this.resync(uid)
                    return
                }

                if (state.settings.type === 'casualRoom' && state.settings.random) {
                    return this.resync(uid)
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
                        ? parseSettings(cmd.optionValues)
                        : null

                // Only the form of the current room type is offered: the type never changes.
                if (
                    !isHost ||
                    !next ||
                    next.type !== state.settings.type ||
                    state.status !== 'selecting'
                ) {
                    return this.resync(uid)
                }

                if (next.type === 'casualRoom' && !next.title) {
                    next.title = 'Custom Room'
                }

                const prev = state.settings

                const structural =
                    next.scoring !== prev.scoring ||
                    next.group !== prev.group ||
                    next.title !== prev.title ||
                    next.tier !== prev.tier ||
                    next.customSongs !== prev.customSongs

                if (structural && state.history.length > 0) {
                    return this.resync(uid)
                }

                const randomChanged = next.random !== prev.random
                const modeChanged = next.scoring !== prev.scoring

                const poolChanged =
                    next.tier !== prev.tier ||
                    next.customSongs !== prev.customSongs

                const titleChanged =
                    next.group !== prev.group ||
                    next.title !== prev.title ||
                    next.tier !== prev.tier

                state.settings = next

                this.sendAll({
                    type: 'updateOptionValues',
                    optionValues: serializeSettings(next),
                })

                if (titleChanged) {
                    this.sendAll({
                        type: 'updateTitle',
                        title: getRoomTitle(next, state.edition),
                    })
                }

                if (modeChanged) {
                    this.sendAll({
                        type: 'updateScoreboardDescription',
                        scoreboardDescription: this.description(),
                    })

                    this.pushScoreboard()
                }

                if (poolChanged && next.type === 'rankedRoom') {
                    await this.rollRankedLevel(true)
                }

                if (randomChanged) await this.applyRandomLevel(true)

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

                this.sendHost({
                    type: 'clearSuggestions',
                })

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

                // Level options (speed, ...): Group Stage, Final and Ranked Match only (not Custom Rooms).
                if (
                    !isHost ||
                    state.settings.type === 'casualRoom' ||
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
                    return this.resync(uid)
                }

                const expectedCount = state.levelInfo?.noteCount ?? null
                const judgedCount =
                    cmd.result.perfect +
                    cmd.result.great +
                    cmd.result.good +
                    cmd.result.miss

                const result: GameplayResult =
                    expectedCount !== null && judgedCount < expectedCount
                        ? { ...cmd.result, grade: 'X' }
                        : cmd.result

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

                // Do not automatically leave the result screen.
                // The host changes the room back to selecting manually.
                this.resync(uid)
                await this.maybeFinishRound(false)
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

                    if (
                        member.id === uid &&
                        typeof cmd.nonce === 'number'
                    ) {
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
                // The level is normally already there (select / previous round); pick one if not.
                if (!state.level) await this.rollRankedLevel(true)

                if (state.status !== 'selecting' || !state.level) {
                    return this.resync(uid)
                }
            } else if (
                state.settings.type === 'casualRoom' &&
                state.settings.random
            ) {
                // Random level: every round gets a fresh random suggestion.
                await this.applyRandomLevel(true)
                if (state.status !== 'selecting') return this.resync(uid)
            }
        }

        if (current === 'selecting' && next === 'preparing' && state.level) {
            if (!state.levelInfo) {
                state.levelInfo = await fetchLevelInfo(state.level)
            }

            // The room may have changed while the level metadata was loading.
            if (state.status !== 'selecting' || !state.level) {
                return this.resync(uid)
            }

            state.status = 'preparing'
            waitAll()

            // Tournament players do not know the level while selecting. The protocol forbids
            // "preparing" without a level (clients disconnect with a fatal error), so reveal it now.
            // UpdateLevel is only valid while the room is still "selecting", so it goes first.
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
        } else if (current === 'preparing' && next === 'selecting') {
            state.status = 'selecting'
            waitAll()

            this.sendAll({
                type: 'updateStatus',
                status: 'selecting',
            })
        } else if (current === 'preparing' && next === 'playing') {
            const readyMembers = state.members.filter(
                (member) =>
                    this.socketsOf(member.id).length > 0 &&
                    state.statuses[member.id] === 'ready',
            )

            if (!state.level || readyMembers.length === 0) {
                return this.resync(uid)
            }

            state.status = 'playing'
            state.results = {}
            state.round = {
                state: crypto.randomUUID(),
                seed: Math.random(),
            }

            // Same rule as the client: skipped users go back to waiting when the round starts.
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
        } else if (current === 'playing' && next === 'selecting') {
            if (Object.keys(state.results).length > 0) {
                state.history.push(this.makeRoundRecord())
            }

            state.results = {}
            state.round = null
            state.status = 'selecting'
            waitAll()

            this.sendAll({
                type: 'updateStatus',
                status: 'selecting',
            })

            this.pushScoreboard()

            if (state.settings.type === 'rankedRoom') await this.rollRankedLevel(true)
            else await this.applyRandomLevel(true)
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

    /** Everybody sees the scoreboard and everybody's results. */
    private canSee(_uid: string): boolean {
        return true
    }

    /** Custom / Ranked rooms show the level to everybody; tournament rooms only to the host until preparing. */
    private sendLevel(): void {
        if (!this.st.level) return

        const event = { type: 'updateLevel', level: this.st.level }

        if (isOpenType(this.st.settings.type)) this.sendAll(event)
        else this.sendHost(event)
    }

    private sendResult(uid: string, result: GameplayResult): void {
        for (const member of this.st.members) {
            if (this.canSee(member.id)) {
                this.sendTo(member.id, {
                    type: 'addResult',
                    result: { userId: uid, result },
                })
            }
        }
    }

    /** Custom Room "Random level": pick a random suggestion. */
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

        this.sendLevel()
        this.pushScoreboard()

        s.levelInfo = await fetchLevelInfo(s.level)
        this.pushScoreboard()
    }

    /** Ranked Match: put a random level of the room's tier (from the ranked list) as the current level. */
    private async rollRankedLevel(announce: boolean): Promise<boolean> {
        if (this.st.settings.type !== 'rankedRoom') return false

        let pick: SheetChart | null = null

        try {
            pick = await pickRankedLevel(
                this.st.settings.tier as RankedTier,
                this.st.settings.customSongs,
                this.st.level,
            )
        } catch (error) {
            console.error('Could not pick a ranked level:', error)
        }

        if (!pick) {
            console.warn('Ranked pool is empty for tier', this.st.settings.tier)
            return false
        }

        if (this.st.status !== 'selecting' || this.st.settings.type !== 'rankedRoom') {
            return false
        }

        const level = { address: pick.address, name: pick.name }

        this.st.level = level
        this.st.levelInfo = null

        if (announce) {
            this.sendLevel()
            this.pushScoreboard()
        }

        // Metadata is loaded later (when playing) if the room is only being created.
        if (announce) {
            const info = await fetchLevelInfo(level)

            if (this.st.level === level) {
                this.st.levelInfo = info
                this.pushScoreboard()
            }
        }

        return true
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

    /**
     * The show is over when nobody is loading or playing any more.
     * immediate = false waits a few seconds so players can still look at their result.
     */
    private async maybeFinishRound(immediate: boolean): Promise<void> {
        const s = this.st

        if (s.status !== 'playing' || !s.round || this.roundBusy()) return

        if (!immediate) {
            if (this.ctx.getWebSockets().length > 0) {
                await this.ctx.storage.setAlarm(Date.now() + 8000)
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
        const master = this.hostPresent()
            ? state.hostId
            : null

        const activeMembers = state.members.filter(
            (member) => this.socketsOf(member.id).length > 0,
        )

        const activeIds = new Set(
            activeMembers.map((member) => member.id),
        )

        return {
            type: 'update',
            allowOtherServers: true,
            reportUserOptions: [],
            title: getRoomTitle(state.settings, state.edition),
            status: state.status,
            master,
            lead: master,

            // Every client receives the form matching the room's settings.
            // Server-side checks below still restrict who can change settings.
            options: [
                // Only the settings of the current room type (+ the close button for the host).
                ...roomForms(this.hostIsTournament(), state.settings.type),
                ...(isHost ? [closeRoomForm] : []),
            ],

            optionValues: serializeSettings(state.settings),

            // Tournament players only know the level from "preparing" on (the protocol requires it).
            level: isHost ||
                isOpenType(state.settings.type) ||
                state.status !== 'selecting'
                ? state.level
                : null,

            // Level options exist in Group Stage, Final and Ranked Match only.
            levelOptions: state.settings.type === 'casualRoom'
                ? []
                : state.levelOptions,
            autoExit: 'off',
            isSuggestionsLocked: state.settings.type === 'rankedRoom' ||
                (state.settings.type !== 'casualRoom' && !isHost),
            suggestions: isHost || state.settings.type === 'casualRoom'
                ? state.suggestions
                : [],
            scoreboardDescription: this.description(),
            scoreboardSections: this.canSee(uid) ? this.safeSections() : [],

            // Players always get their own result, everyone's only if they may see the scoreboard.
            results: Object.entries(state.results)
                .filter(([id]) => activeIds.has(id) && (this.canSee(uid) || id === uid))
                .map(([userId, result]) => ({
                    userId,
                    result,
                })),

            // Only send currently connected users and their current credentials.
            users: activeMembers.map((member) => member.roomUser),

            userStatuses: activeMembers.map((member) => ({
                userId: member.id,
                status: state.statuses[member.id] ?? 'waiting',
            })),
        }
    }

    private description(): string {
        const mode = this.st.settings.scoring
        const tieBreakers = 'Tiebreakers: most perfects, then highest combo.'

        if (mode === 'pp') {
            return PP_CONFIGURED
                ? `PP scoring. Each round is rounded up before the total. ${tieBreakers}`
                : `PP scoring unavailable. ${tieBreakers}`
        }

        return `Ranked Match: Perfect ×3, Great ×2, Good ×1. ${tieBreakers}`
    }

    /** A scoring error must never break the room (the client would show a fatal error). */
    private safeSections(): ScoreboardSection[] {
        try {
            return this.sections()
        } catch (error) {
            console.error('Could not build the scoreboard:', error)
            return []
        }
    }

    private sections(): ScoreboardSection[] {
        const state = this.st
        const mode = state.settings.scoring

        // The client raises a fatal error for scoreboard entries of users that are not in the room,
        // so only connected players are shown. Their records stay on the server.
        const presentMembers = state.members.filter(
            (member) => this.socketsOf(member.id).length > 0,
        )
        const present = new Set(presentMembers.map((member) => member.id))

        const live: RoundRecord | null =
            state.status === 'playing' &&
            Object.keys(state.results).length > 0
                ? this.makeRoundRecord()
                : null

        const history = live
            ? [...state.history, live]
            : state.history

        const output: {
            title: string
            scores: {
                userId: string
                value: string
            }[]
        }[] = []

        const divisions = this.getDivisions(presentMembers)

        for (const division of divisions) {
            const divisionIds = new Set(
                division.members.map((member) => member.id),
            )

            const divisionTotals = totals(history, mode)
                .filter((total) => divisionIds.has(total.userId))

            output.push({
                title: isOpenType(state.settings.type) && state.settings.type === 'casualRoom'
                    ? 'Standings'
                    : `Standings · ${division.title}`,
                scores: divisionTotals.map((total) => ({
                    userId: total.userId,
                    value: fmtScore(total.score, mode),
                })),
            })
        }

        // Players who left: the client cannot show scoreboard entries of users that are not in the
        // room, so their totals are kept as text sections instead of being dropped.
        if (state.settings.type !== 'casualRoom') {
            const allTotals = totals(history, mode)

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
            label: string,
        ) => {
            const song = round.levelTitle || round.level?.name

            const title = song
                ? `${label} · ${song}${round.levelTag ? ` ${round.levelTag}` : ''}${round.levelRating != null ? ` Lvl.${round.levelRating}` : ''}`
                : label

            const scores = Object.entries(round.results)
                .filter(([id]) => present.has(id))
                .sort(([, a], [, b]) => compareResults(a, b, mode, round))
                .map(([userId, result]) => ({
                    userId,
                    value: fmtDetail(result, mode, round),
                }))

            output.push({
                title,
                scores,
            })
        }

        if (live) {
            roundSection(
                live,
                `Round ${state.history.length + 1} (live)`,
            )
        }

        for (let index = state.history.length - 1; index >= 0; index--) {
            roundSection(
                state.history[index]!,
                `Round ${index + 1}`,
            )
        }

        return output
    }

    private getDivisions(members: Member[]) {
        const type = this.st.settings.type

        if (isOpenType(type)) {
            return [{
                title: '',
                members,
            }]
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
                    (member) =>
                        this.st.divisions[member.handle] === `Group ${group}`,
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
                        this.st.divisions[member.handle] === 'Upper Bracket',
                ),
            },
            {
                title: 'Lower Bracket',
                members: members.filter(
                    (member) =>
                        this.st.divisions[member.handle] === 'Lower Bracket',
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
        const scoreboardSections = this.safeSections()

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
                state.statuses[uid] === 'playing' &&
                !state.results[uid]
            ) {
                const result: GameplayResult = {
                    grade: 'X',
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
                // Remove the disconnected user's old Sonolus credentials
                // from the live room roster while keeping their score record.
                this.sendAll({
                    type: 'removeUser',
                    user: member.roomUser,
                })
            }
        } else {
            state.members = state.members.filter(
                (entry) => entry.id !== uid,
            )

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
        await this.maybeFinishRound(false)

        const otherSockets = this.ctx.getWebSockets().filter(
            (socket) =>
                (socket.deserializeAttachment() as {
                    userId?: string
                } | null)?.userId !== uid,
        )

        if (otherSockets.length === 0) {
            // Empty room: kept (with the results of players who left) for EMPTY_ROOM_TTL_MS, then deleted.
            await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS)
        }
    }

    /** Sockets that are being closed still show up in getWebSockets(); never treat them as connected. */
    private closing = new WeakSet<WebSocket>()

    private socketsOf = (uid: string) =>
        this.ctx.getWebSockets().filter(
            (socket) =>
                !this.closing.has(socket) &&
                (
                    socket.deserializeAttachment() as {
                        userId?: string
                    } | null
                )?.userId === uid,
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
        const lobby = this.env.LOBBY.get(
            this.env.LOBBY.idFromName('main'),
        )

        await lobby.upsert({
            name: this.st.name,
            title: getRoomTitle(this.st.settings, this.st.edition),
            subtitle: this.subtitle(),
            master: this.st.hostName,
            hostId: this.st.hostId,
            visibility: this.st.settings.visibility,
        })
    }
}