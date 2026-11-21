import { DurableObject } from 'cloudflare:workers'
import {
    EMPTY_ROOM_TTL_MS,
    RESERVED_ROOM_TTL_MS,
    SCORING_MODES,
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
import { getEditionData, type EditionData, type SheetChart } from './sheets.ts'
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

const getRoomTitle = (settings: RoomSettings, edition = '') => {
    if (settings.type === 'groupStage') {
        return `Group ${settings.group || 'A'}`
    }

    if (settings.type === 'casualRoom') {
        return settings.title || 'Custom Room'
    }

    return `${edition || 'Final'} Final`
}

function chartsForType(
    edition: EditionData,
    type: RoomSettings['type'],
): SheetChart[] {
    if (type === 'casualRoom') return []
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
    if (type === 'casualRoom') return []

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
        new RegExp(`${escaped}\\s*•\\s*(\\d+(?:\\.\\d+)?)`, 'i'),
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

                const description = descriptionText(item.description)

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

                // Ignore tags such as "Spoiler". The difficulty is the
                // actual chart tag, not necessarily the first tag.
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

            if (!['groupStage', 'final', 'casualRoom'].includes(this.st.settings.type)) {
                this.st.settings.type = 'casualRoom'
            }

            if (!['pp', 'rankedMatch'].includes(this.st.settings.scoring)) {
                this.st.settings.scoring = 'pp'
            }

            for (const member of this.st.members) {
                this.st.statuses[member.id] ??= 'waiting'
            }

            if (this.st.status === 'playing' && !this.st.round) {
                this.st.status = 'selecting'
                this.st.results = {}

                for (const member of this.st.members) {
                    this.st.statuses[member.id] = 'waiting'
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
            settings.type !== 'casualRoom'
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
        this.st.round = null
        this.st.results = {}
        this.st.history = []

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
            join.room !== this.st.name ||
            !join.user ||
            typeof join.user.id !== 'string' ||
            !join.roomUser
        ) {
            return new Response('No such room', { status: 404 })
        }

        const { 0: client, 1: server } = new WebSocketPair()
        const user = join.user

        const existingMember = this.st.members.find(
            (member) => member.id === user.id,
        )

        if (existingMember) {
            for (const oldSocket of this.socketsOf(user.id)) {
                try {
                    oldSocket.close(4000, 'replaced')
                } catch {
                    // The previous connection may already be closed.
                }
            }

            existingMember.name = user.name
            existingMember.handle = user.handle
            existingMember.roomUser = join.roomUser
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

        if (!existingMember) {
            this.st.members.push(member)
        }

        this.st.statuses[user.id] = 'waiting'

        await this.save()

        // Send the complete room state to the reconnecting client.
        this.send(server, this.view(user.id))

        // Existing users are not removed and re-added on reconnect.
        if (!existingMember) {
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

        // A replaced socket must not affect the new connection.
        if (this.socketsOf(attachment.userId).some((socket) => socket !== ws)) {
            return
        }

        await this.dropMember(attachment.userId, true, true)
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        await this.webSocketClose(ws)
    }

    async alarm(): Promise<void> {
        if (this.ctx.getWebSockets().length > 0) return

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

        // Clear the member list before closing sockets. Their close callbacks
        // then cannot create disconnect results or alter the closed room.
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

                state.level = {
                    address: cmd.level.address,
                    name: cmd.level.name,
                }
                state.levelInfo = null

                this.sendHost({
                    type: 'updateLevel',
                    level: state.level,
                })

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

                const member = state.members.find(
                    (entry) => entry.id === uid,
                )

                const tournamentHost =
                    member?.handle === TOURNAMENT_HOST_HANDLE

                if (
                    !isHost ||
                    !next ||
                    (!tournamentHost && next.type !== 'casualRoom') ||
                    state.status !== 'selecting' ||
                    state.history.length > 0
                ) {
                    return this.resync(uid)
                }

                const modeChanged =
                    next.scoring !== state.settings.scoring

                const typeChanged =
                    next.type !== state.settings.type

                const titleChanged =
                    typeChanged ||
                    next.group !== state.settings.group ||
                    next.title !== state.settings.title

                if (next.type === 'casualRoom' && !next.title) {
                    next.title = 'Custom Room'
                }

                state.settings = next

                if (typeChanged) {
                    let editionData: EditionData | null = null

                    if (next.type !== 'casualRoom') {
                        try {
                            editionData = await getEditionData()
                        } catch (error) {
                            console.error('Could not reload edition sheet:', error)
                        }
                    }

                    if (editionData) {
                        state.edition = editionData.edition
                        state.divisions = cleanDivisions(editionData.divisions)
                        state.suggestions = suggestionsFromCharts(
                            chartsForType(editionData, next.type),
                            uid,
                        )
                    } else {
                        state.suggestions = await songPoolSuggestions(
                            next.type,
                            uid,
                        )
                    }

                    const updateSuggestions = {
                        type: 'updateSuggestions',
                        suggestions: state.suggestions,
                    }

                    if (next.type === 'casualRoom') {
                        this.sendAll(updateSuggestions)
                    } else {
                        this.sendHost(updateSuggestions)
                    }

                    this.sendAll({
                        type: 'updateIsSuggestionsLocked',
                        isSuggestionsLocked: next.type !== 'casualRoom',
                    })

                    if (next.type !== 'casualRoom' && state.level) {
                        this.sendExcept(uid, {
                            type: 'updateLevel',
                            level: null,
                        })
                    } else if (state.level) {
                        this.sendExcept(uid, {
                            type: 'updateLevel',
                            level: state.level,
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

                // Keep kicked users in the room's member list and standings.
                for (const socket of this.socketsOf(target)) {
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
            case 'updateLevelOption':
            case 'updateIsSuggestionsLocked':
                return this.resync(uid)

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
                    return
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

                this.sendAll({
                    type: 'addResult',
                    result: {
                        userId: uid,
                        result,
                    },
                })

                this.pushScoreboard()
                this.finishRoundIfIdle()
                this.resync(uid)
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

    private finishRoundIfIdle(): boolean {
        const state = this.st

        if (state.status !== 'playing') return false

        const active = state.members.some((member) =>
            ['ready', 'playing'].includes(
                state.statuses[member.id] ?? 'waiting',
            ),
        )

        if (active) return false

        if (Object.keys(state.results).length > 0) {
            state.history.push(this.makeRoundRecord())
        }

        state.results = {}
        state.round = null
        state.status = 'selecting'

        for (const member of state.members) {
            state.statuses[member.id] = 'waiting'
        }

        this.sendAll({
            type: 'updateStatus',
            status: 'selecting',
        })

        if (state.settings.type !== 'casualRoom') {
            this.sendExcept(state.hostId, {
                type: 'updateLevel',
                level: null,
            })
        }

        this.pushScoreboard()
        return true
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

        if (
            current === 'selecting' &&
            next === 'preparing' &&
            state.level
        ) {
            state.status = 'preparing'
            waitAll()

            if (!state.levelInfo) {
                state.levelInfo = await fetchLevelInfo(state.level)
            }

            if (state.settings.type !== 'casualRoom') {
                this.sendAll({
                    type: 'updateLevel',
                    level: null,
                })
            }

            this.sendAll({
                type: 'updateStatus',
                status: 'preparing',
            })
        } else if (
            current === 'preparing' &&
            next === 'selecting'
        ) {
            state.status = 'selecting'
            waitAll()

            this.sendAll({
                type: 'updateStatus',
                status: 'selecting',
            })

            if (state.settings.type !== 'casualRoom') {
                this.sendExcept(uid, {
                    type: 'updateLevel',
                    level: null,
                })
                if (state.level) {
                    this.sendHost({
                        type: 'updateLevel',
                        level: state.level,
                    })
                }
            }
        } else if (
            current === 'preparing' &&
            next === 'playing'
        ) {
            if (
                !state.level ||
                !state.members.some(
                    (member) =>
                        state.statuses[member.id] === 'ready',
                )
            ) {
                return this.resync(uid)
            }

            state.status = 'playing'
            state.results = {}
            state.round = {
                state: crypto.randomUUID(),
                seed: Math.random(),
            }

            for (const member of state.members) {
                if (state.statuses[member.id] === 'skipped') {
                    state.statuses[member.id] = 'waiting'
                }
            }

            if (state.settings.type !== 'casualRoom') {
                this.sendAll({
                    type: 'updateLevel',
                    level: state.level,
                })
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

            for (const member of state.members) {
                if (state.statuses[member.id] === 'ready') {
                    this.sendTo(member.id, start)
                }
            }

            this.pushScoreboard()
        } else if (
            current === 'playing' &&
            next === 'selecting'
        ) {
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

            if (state.settings.type !== 'casualRoom') {
                this.sendExcept(uid, {
                    type: 'updateLevel',
                    level: null,
                })
            }
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
        this.socketsOf(this.st.hostId).length > 0

    private view(uid: string): Ev {
        const state = this.st
        const isHost = uid === state.hostId
        const master = this.hostPresent()
            ? state.hostId
            : null

        const present = new Set(
            state.members.map((member) => member.id),
        )

        const canSeeLevel =
            state.settings.type === 'casualRoom' ||
            state.status === 'playing' ||
            (isHost && state.status === 'selecting')

        return {
            type: 'update',
            allowOtherServers: true,
            reportUserOptions: [],
            title: getRoomTitle(state.settings, state.edition),
            status: state.status,
            master,
            lead: master,
            options: [
                ...roomForms(
                    state.members.find((member) => member.id === uid)?.handle === TOURNAMENT_HOST_HANDLE,
                ),
                ...(isHost ? [closeRoomForm] : []),
            ],
            optionValues: serializeSettings(state.settings),
            level: canSeeLevel ? state.level : null,
            levelOptions: [],
            autoExit: 'off',
            isSuggestionsLocked: state.settings.type !== 'casualRoom' && !isHost,
            suggestions: isHost || state.settings.type === 'casualRoom'
                ? state.suggestions
                : [],
            scoreboardDescription: this.description(),
            scoreboardSections: this.sections(),
            results: Object.entries(state.results)
                .filter(([id]) => present.has(id))
                .map(([userId, result]) => ({
                    userId,
                    result,
                })),
            users: state.members.map((member) => member.roomUser),
            userStatuses: state.members.map((member) => ({
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

    private sections() {
        const state = this.st
        const mode = state.settings.scoring

        const presentMembers = state.members
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
                title: state.settings.type === 'casualRoom'
                    ? 'Standings'
                    : `Standings · ${division.title}`,
                scores: divisionTotals.map((total) => ({
                    userId: total.userId,
                    value: fmtScore(total.score, mode),
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

        if (type === 'casualRoom') {
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
        this.sendAll({
            type: 'updateScoreboardSections',
            scoreboardSections: this.sections(),
        })
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
            // A player who disconnects after gameplay started receives X.
            // The server cannot inspect the client's remaining note chart,
            // so an active gameplay disconnect is treated as an incomplete run.
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

                if (announce) {
                    this.sendAll({
                        type: 'addResult',
                        result: {
                            userId: uid,
                            result,
                        },
                    })
                }
            }

            state.statuses[uid] = 'waiting'

            if (announce) {
                this.sendAll({
                    type: 'updateUserStatus',
                    userStatus: {
                        userId: uid,
                        status: 'waiting',
                    },
                })
            }

            this.finishRoundIfIdle()
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

        const otherSockets = this.ctx.getWebSockets().filter(
            (socket) =>
                (socket.deserializeAttachment() as {
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
            (socket) =>
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

    private save() {
        return this.ctx.storage.put('st', this.st)
    }

    private async syncLobby() {
        const summary = await this.summary()

        if (summary) {
            await this.env.LOBBY
                .get(this.env.LOBBY.idFromName('main'))
                .upsert(summary)
        }
    }
}