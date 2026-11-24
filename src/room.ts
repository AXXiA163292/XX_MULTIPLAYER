import { DurableObject } from 'cloudflare:workers'
import {
    calculateRatingDelta,
    computePp,
    formatPlayerStatsLine,
    isEligibleForRewind,
    isPlayerX,
} from './scoring.ts'
import type {
    GameplayResult,
    JoinSession,
    LevelItem,
    MatchMode,
    RoomMember,
    RoomSummary,
    Sil,
    UserProfile,
} from './types.ts'
import { verifyToken } from './crypto.ts'
import {
    DEFAULT_LEVEL,
    getCustomLevels,
    getPlaylists,
    loadLevelsByNames,
} from './sheets.ts'
import {
    ROUND_COUNT_OPTIONS,
    TIME_LIMIT_OPTIONS,
    TOURNAMENT_HOST_HANDLE,
} from './config.ts'
import {
    defaultCustomRoomTitle,
    type RoomSettings as FormRoomSettings,
} from './forms.ts'

type ConnectionMeta = {
    connId: string
    index: number
    handle: string
}

type SonolusRoomStatus = 'selecting' | 'preparing' | 'playing'
type SonolusUserStatus = 'selecting' | 'waiting' | 'ready' | 'playing'

type PersistedState = {
    name: string
    key: string
    configured: boolean
    hostId: string
    hostName: string
    hostHandle: string
    settings: FormRoomSettings
    status: SonolusRoomStatus
    level: LevelItem
    maxCount: number
    roundCount: number
    timeLimitSec: number
    members: RoomMember[]
    nextIndex: number
    roundNumber: number
    roundHistory: {
        round: number
        levelTitle: string
        results: {
            handle: string
            name: string
            score: number
            accuracy: number
            combo: number
            grade: GameplayResult['grade']
            pp: number
            ratingDelta: number
        }[]
    }[]
    chat: {
        id: string
        author: string
        handle: string
        text: string
        time: number
    }[]
    leaderboard: {
        handle: string
        name: string
        rating: number
        pp: number
        wins: number
        losses: number
        draws: number
        plays: number
    }[]
}

function defaultFormSettings(hostName = 'Host'): FormRoomSettings {
    return {
        type: 'casualRoom',
        scoring: 'rankedMatch',
        roundMode: 'tournament',
        group: 'A',
        title: defaultCustomRoomTitle(hostName),
        visibility: 'public',
        random: false,
        tier: 'master',
        customSongs: 'off',
    }
}

function serializeSettings(settings: FormRoomSettings): string {
    return Object.entries(settings)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join('&')
}

function levelToSil(level: LevelItem | undefined, publicAddress?: string): Sil {
    const fallbackLevel = level ?? DEFAULT_LEVEL
    const name = fallbackLevel?.name || DEFAULT_LEVEL.name
    const rawSource = typeof fallbackLevel?.source === 'string' ? fallbackLevel.source.trim() : ''

    if (rawSource.startsWith('sonolus://') || rawSource.startsWith('http://') || rawSource.startsWith('https://')) {
        return {
            address: rawSource,
            name,
        }
    }

    const base = (publicAddress || '').replace(/\/+$/, '')
    return {
        address: base ? `${base}/sonolus/levels/${encodeURIComponent(name)}` : `/sonolus/levels/${encodeURIComponent(name)}`,
        name,
    }
}

function normalizeGrade(raw: any): GameplayResult['grade'] {
    if (raw === 'X') return 'X'
    if (raw === 'allPerfect' || raw === 'AP') return 'allPerfect'
    if (raw === 'fullCombo' || raw === 'FC') return 'fullCombo'
    if (raw === 'pass') return 'pass'
    return 'fail'
}

function normalizeResult(raw: any): GameplayResult {
    const grade = normalizeGrade(raw?.grade)
    const perfect = Number(raw?.perfect) || 0
    const great = Number(raw?.great) || 0
    const good = Number(raw?.good) || 0
    const miss = Number(raw?.miss) || 0
    const score = Number(raw?.score ?? raw?.arcadeScore) || 0
    const accuracy = Math.max(0, Math.min(1, Number(raw?.accuracy) || 0))
    return {
        grade,
        score,
        accuracy,
        arcadeScore: Number(raw?.arcadeScore) || score,
        accuracyScore: Number(raw?.accuracyScore) || Math.round(accuracy * 10000),
        combo: Number(raw?.combo) || 0,
        perfect,
        great,
        good,
        miss,
        totalCount: Number(raw?.totalCount) || (perfect + great + good + miss),
    }
}

function formatGradeLabel(grade: GameplayResult['grade'] | undefined): string {
    if (grade === 'X') return 'X'
    if (grade === 'allPerfect') return 'AP'
    if (grade === 'fullCombo') return 'FC'
    if (grade === 'pass') return 'PASS'
    return 'FAIL'
}

function fmtDetail(member: RoomMember): string {
    const parts: string[] = []
    if (member.user.handle === TOURNAMENT_HOST_HANDLE) {
        parts.push('HOST')
    }
    parts.push(formatPlayerStatsLine(member))
    if (member.lastResult) {
        const r = member.lastResult
        const gradeText = formatGradeLabel(r.grade)
        const accPct = (r.accuracy * 100).toFixed(2)
        parts.push(
            `Last: ${r.score.toLocaleString()} pts · ${accPct}% · ${r.combo} combo · ${gradeText}`,
        )
    } else if (member.lastPlayCount > 0) {
        parts.push(`Plays: ${member.lastPlayCount}`)
    }
    if (member.playing) {
        parts.push('Playing')
    } else if (member.ready) {
        parts.push('Ready')
    } else {
        parts.push('Not ready')
    }
    return parts.join(' · ')
}

export class Room extends DurableObject {
    private envRoom: any
    private state: PersistedState | null = null
    private roundTimer: ReturnType<typeof setTimeout> | null = null
    private roundDeadline = 0

    constructor(ctx: DurableObjectState, env: any) {
        super(ctx, env)
        this.envRoom = env
        void ctx.blockConcurrencyWhile(async () => {
            const saved = await this.ctx.storage.get<PersistedState>('room')
            if (saved) {
                this.state = {
                    ...saved,
                    status: saved.status ?? 'selecting',
                }
                if (this.state.members.some((m) => m.playing)) {
                    this.scheduleRoundTimer()
                }
            }
        })
    }

    private async save(): Promise<void> {
        if (!this.state) return
        await this.ctx.storage.put('room', this.state)
    }

    private lobbyStub() {
        return this.envRoom.LOBBY.get(this.envRoom.LOBBY.idFromName('main'))
    }

    private async syncLobby(): Promise<void> {
        if (!this.state || !this.state.name) return
        try {
            if (this.state.configured) {
                await this.lobbyStub().register(this.state.name)
            } else {
                await this.lobbyStub().remove(this.state.name)
            }
        } catch (error) {
            console.error('Could not sync room with lobby:', error)
        }
    }

    private clearRoundTimer(): void {
        if (this.roundTimer !== null) {
            clearTimeout(this.roundTimer)
            this.roundTimer = null
        }
        this.roundDeadline = 0
    }

    private scheduleRoundTimer(): void {
        this.clearRoundTimer()
        if (!this.state) return
        const limitSec = this.state.timeLimitSec || 180
        this.roundDeadline = Date.now() + limitSec * 1000
        this.roundTimer = setTimeout(() => {
            void this.finishRound('timeout')
        }, limitSec * 1000)
    }

    private ensureLeaderboardEntry(user: UserProfile) {
        if (!this.state) return null
        let entry = this.state.leaderboard.find((e) => e.handle === user.handle)
        if (!entry) {
            entry = {
                handle: user.handle,
                name: user.name || user.handle,
                rating: 1000,
                pp: 0,
                wins: 0,
                losses: 0,
                draws: 0,
                plays: 0,
            }
            this.state.leaderboard.push(entry)
        }
        if (user.name) entry.name = user.name
        return entry
    }

    private async pickRandomLevel(poolName?: string): Promise<LevelItem> {
        try {
            const [customs, playlists] = await Promise.all([
                getCustomLevels(this.envRoom),
                getPlaylists(this.envRoom),
            ])

            let pool: LevelItem[] = []
            if (poolName && poolName !== 'all') {
                const matchedPlaylist = playlists.find(
                    (p) => p.name.toLowerCase() === poolName.toLowerCase(),
                )
                if (matchedPlaylist) {
                    pool = await loadLevelsByNames(
                        matchedPlaylist.charts.map((c) => c.name),
                        this.envRoom,
                    )
                }
            }

            if (pool.length === 0) {
                pool = await loadLevelsByNames(
                    customs.map((c) => c.name),
                    this.envRoom,
                )
            }

            if (pool.length > 0) {
                return pool[Math.floor(Math.random() * pool.length)]!
            }
        } catch (error) {
            console.error('Could not pick random level from sheet:', error)
        }

        return DEFAULT_LEVEL
    }

    async reserve(
        name: string,
        meta: {
            key: string
            hostId: string
            hostName: string
            hostHandle: string
        },
    ): Promise<void> {
        if (!this.state) {
            this.state = {
                name,
                key: meta.key,
                configured: false,
                hostId: meta.hostId,
                hostName: meta.hostName,
                hostHandle: meta.hostHandle,
                settings: defaultFormSettings(meta.hostName || meta.hostHandle),
                status: 'selecting',
                level: DEFAULT_LEVEL,
                maxCount: 4,
                roundCount: 3,
                timeLimitSec: 180,
                members: [],
                nextIndex: 1,
                roundNumber: 0,
                roundHistory: [],
                chat: [],
                leaderboard: [],
            }
        } else {
            this.state.key = meta.key
            this.state.hostId = meta.hostId
            this.state.hostName = meta.hostName
            this.state.hostHandle = meta.hostHandle
        }

        await this.save()
        await this.syncLobby()
    }

    async isOpen(): Promise<boolean> {
        return Boolean(this.state && this.state.configured)
    }

    async canJoin(user: UserProfile): Promise<string | null> {
        if (!this.state) return 'Room does not exist.'

        if (this.state.members.length >= this.state.maxCount) {
            const exists = this.state.members.some((m) => m.user.handle === user.handle)
            if (!exists) return 'Room is full.'
        }

        return null
    }

    async configure(
        key: string,
        settings: FormRoomSettings,
        user: UserProfile,
    ): Promise<boolean> {
        if (!this.state || this.state.key !== key) return false

        const isTournamentHost = user.handle === TOURNAMENT_HOST_HANDLE
        if (
            !isTournamentHost &&
            settings.type !== 'casualRoom' &&
            settings.type !== 'rankedRoom'
        ) {
            return false
        }

        const chosenLevel = await this.pickRandomLevel(
            settings.type === 'groupStage' ? settings.group : 'all',
        )

        const title =
            settings.title.trim() ||
            (settings.type === 'casualRoom'
                ? defaultCustomRoomTitle(user.name || user.handle)
                : `${settings.type === 'groupStage' ? `Group ${settings.group}` : settings.type === 'final' ? 'Final' : settings.tier.toUpperCase()} Room`)

        this.state.settings = {
            ...settings,
            title,
        }
        this.state.status = 'selecting'
        this.state.level = chosenLevel
        this.state.configured = true
        this.state.roundCount = ROUND_COUNT_OPTIONS.includes(3 as any) ? 3 : 3
        this.state.timeLimitSec = TIME_LIMIT_OPTIONS.includes(180 as any) ? 180 : 180

        await this.save()
        await this.syncLobby()
        this.broadcastRoomState()
        return true
    }

    async summary(): Promise<RoomSummary | null> {
        if (!this.state || !this.state.configured) return null
        const s = this.state.settings
        const matchMode: MatchMode = s.scoring === 'rankedMatch' || s.type === 'rankedRoom' ? 'ranked' : 'casual'
        const modeLabel = matchMode === 'ranked' ? 'RANKED' : 'CASUAL'
        const roundText = `R${Math.min(this.state.roundNumber + 1, this.state.roundCount)}/${this.state.roundCount}`
        const subtitleParts = [
            modeLabel,
            roundText,
            `${this.state.members.length}/${this.state.maxCount} players`,
            this.state.level?.title ? `♪ ${this.state.level.title}` : '',
        ].filter(Boolean)

        return {
            name: this.state.name,
            title: s.title,
            subtitle: subtitleParts.join(' · '),
            master: true,
            visibility: s.visibility,
            matchMode,
            roundCount: this.state.roundCount,
        }
    }

    private userStatusOf(member: RoomMember): SonolusUserStatus {
        if (member.playing || this.state?.status === 'playing') return 'playing'
        if (this.state?.status === 'selecting') return 'selecting'
        return member.ready ? 'ready' : 'waiting'
    }

    private roomSnapshot() {
        if (!this.state) return null
        const s = this.state.settings
        const masterMember =
            this.state.members.find((m) => m.user.handle === this.state!.hostHandle) ??
            this.state.members[0]
        const masterUserId = masterMember?.user.id ?? this.state.hostId

        const scores = [...this.state.leaderboard]
            .sort((a, b) => b.rating - a.rating || b.pp - a.pp)
            .slice(0, 20)
            .map((entry, idx) => ({
                rank: idx + 1,
                user: {
                    id: entry.handle,
                    handle: entry.handle,
                    name: entry.name || entry.handle,
                },
                score: `${entry.rating} RP · ${entry.pp} PP`,
            }))

        const users = this.state.members.map((m) => {
            const roomUser = (m as any).roomUser
            if (roomUser && typeof roomUser === 'object') {
                return roomUser
            }
            return {
                index: m.index,
                userProfile: m.user,
            }
        })

        return {
            type: 'update',
            allowOtherServers: true,
            reportUserOptions: [],
            title: s.title,
            status: this.state.status,
            master: masterUserId,
            lead: masterUserId,
            level: levelToSil(this.state.level, this.envRoom?.PUBLIC_ADDRESS),
            options: [],
            optionValues: serializeSettings(s),
            levelOptions: [],
            isSuggestionsLocked: false,
            suggestions: [],
            autoExit: 'off',
            users,
            userStatuses: this.state.members.map((m) => ({
                userId: m.user.id,
                status: this.userStatusOf(m),
            })),
            scoreboardDescription: fmtDetail(
                this.state.members[0] ?? ({
                    index: 0,
                    user: {
                        id: this.state.hostId,
                        handle: this.state.hostHandle,
                        name: this.state.hostName || this.state.hostHandle,
                    },
                    ready: false,
                    playing: false,
                    lastPlayCount: 0,
                } as RoomMember),
            ),
            scoreboardSections: [
                {
                    title: 'Standings',
                    icon: 'trophy',
                    scores,
                },
            ],
            results: [],
        }
    }

    private send(ws: WebSocket, payload: unknown): void {
        try {
            ws.send(JSON.stringify(payload))
        } catch {
            // ignore closed socket
        }
    }

    private broadcast(payload: unknown): void {
        for (const ws of this.ctx.getWebSockets()) {
            this.send(ws, payload)
        }
    }

    private broadcastRoomState(): void {
        const snap = this.roomSnapshot()
        if (!snap) return
        this.broadcast(snap)
    }

    private async finishRound(reason: 'allFinished' | 'timeout' | 'manual'): Promise<void> {
        if (!this.state) return
        this.clearRoundTimer()

        const activePlayers = this.state.members.filter((m) => m.playing)
        for (const m of activePlayers) {
            m.playing = false
            m.ready = false
            if (!m.lastResult) {
                m.lastResult = normalizeResult({
                    score: 0,
                    accuracy: 0,
                    combo: 0,
                    perfect: 0,
                    great: 0,
                    good: 0,
                    miss: 0,
                    grade: 'fail',
                })
            }
        }

        const s = this.state.settings
        const mode: MatchMode = s.scoring === 'rankedMatch' || s.type === 'rankedRoom' ? 'ranked' : 'casual'
        const participants = this.state.members.filter((m) => Boolean(m.lastResult))

        const roundEntries: {
            handle: string
            name: string
            score: number
            accuracy: number
            combo: number
            grade: GameplayResult['grade']
            pp: number
            ratingDelta: number
        }[] = []

        for (const player of participants) {
            const lb = this.ensureLeaderboardEntry(player.user)!
            const res = player.lastResult!
            const pp = computePp(res, lb.rating, mode)
            player.pp = pp
            lb.pp = Math.max(lb.pp, pp)
            lb.plays += 1

            let ratingDelta = 0
            const opponents = participants.filter((other) => other.user.handle !== player.user.handle)

            if (opponents.length > 0 && !isPlayerX(res)) {
                let totalDelta = 0
                for (const opp of opponents) {
                    const oppLb = this.ensureLeaderboardEntry(opp.user)!
                    const oppScore = isPlayerX(opp.lastResult) ? -1 : (opp.lastResult?.score ?? 0)
                    totalDelta += calculateRatingDelta(
                        lb.rating,
                        oppLb.rating,
                        res.score,
                        oppScore,
                        mode,
                    )
                }
                ratingDelta = Math.round(totalDelta / opponents.length)
            }

            if (opponents.length > 0 && !isPlayerX(res)) {
                const topOppScore = Math.max(
                    ...opponents.map((o) => (isPlayerX(o.lastResult) ? -1 : (o.lastResult?.score ?? 0))),
                )
                if (res.score > topOppScore) lb.wins += 1
                else if (res.score < topOppScore) lb.losses += 1
                else lb.draws += 1
            }

            lb.rating = Math.max(100, lb.rating + ratingDelta)
            player.rating = lb.rating
            player.wins = lb.wins
            player.losses = lb.losses
            player.draws = lb.draws

            roundEntries.push({
                handle: player.user.handle,
                name: player.user.name || player.user.handle,
                score: res.score,
                accuracy: res.accuracy,
                combo: res.combo,
                grade: res.grade,
                pp,
                ratingDelta,
            })
        }

        this.state.roundNumber += 1
        this.state.roundHistory.push({
            round: this.state.roundNumber,
            levelTitle: this.state.level?.title ?? DEFAULT_LEVEL.title,
            results: roundEntries.sort((a, b) => b.score - a.score),
        })
        this.state.roundHistory = this.state.roundHistory.slice(-20)

        const maxRounds = this.state.roundCount ?? 3
        if (this.state.roundNumber >= maxRounds) {
            this.state.roundNumber = 0
        }
        this.state.level = await this.pickRandomLevel(
            this.state.settings.type === 'groupStage' ? this.state.settings.group : 'all',
        )
        this.state.status = 'selecting'

        await this.save()
        await this.syncLobby()
        this.broadcastRoomState()
        void reason
    }

    async webSocketMessage(ws: WebSocket, rawData: string | ArrayBuffer): Promise<void> {
        if (!this.state) return

        const att = ws.deserializeAttachment() as ConnectionMeta | null
        if (!att) return

        let msg: any
        try {
            const text = typeof rawData === 'string'
                ? rawData
                : new TextDecoder().decode(rawData)
            msg = JSON.parse(text)
        } catch {
            return
        }

        const member = this.state.members.find((m) => m.index === att.index)
        if (!member) return

        const isHost =
            member.user.handle === this.state.hostHandle ||
            member.user.handle === TOURNAMENT_HOST_HANDLE

        if (msg?.type === 'updateUserStatus') {
            const status = String(msg.status ?? '')
            member.ready = status === 'ready'
            member.playing = status === 'playing'
            await this.save()
            this.broadcastRoomState()
            return
        }

        if (msg?.type === 'updateStatus') {
            if (!isHost) {
                this.send(ws, { type: 'error', message: 'Only the host can change room status.' })
                return
            }

            const nextStatus = String(msg.status ?? '')
            if (nextStatus === 'selecting' || nextStatus === 'preparing' || nextStatus === 'playing') {
                this.state.status = nextStatus
            }

            if (nextStatus === 'playing') {
                for (const m of this.state.members) {
                    m.previousResult = m.lastResult
                    m.lastResult = undefined
                    m.playing = true
                    m.ready = false
                    m.lastPlayCount += 1
                    m.lastPlayLevel = this.state.level
                    m.lastPlayAt = Date.now()
                }
                this.scheduleRoundTimer()
            }

            await this.save()
            await this.syncLobby()
            this.broadcastRoomState()
            return
        }

        if (msg?.type === 'startGameplay') {
            member.previousResult = member.lastResult
            member.lastResult = undefined
            member.playing = true
            member.ready = false
            member.lastPlayCount += 1
            member.lastPlayLevel = this.state.level
            member.lastPlayAt = Date.now()
            this.state.status = 'playing'
            this.scheduleRoundTimer()
            await this.save()
            this.broadcastRoomState()
            return
        }

        if (msg?.type === 'finishGameplay') {
            const result = normalizeResult(msg.result ?? msg)
            member.lastResult = result
            member.playing = false
            member.ready = false

            const s = this.state.settings
            const mode: MatchMode = s.scoring === 'rankedMatch' || s.type === 'rankedRoom' ? 'ranked' : 'casual'
            const lb = this.ensureLeaderboardEntry(member.user)!
            member.pp = computePp(result, lb.rating, mode)
            member.rating = lb.rating
            member.wins = lb.wins
            member.losses = lb.losses
            member.draws = lb.draws

            await this.save()
            this.broadcastRoomState()

            if (this.state.members.length > 0 && this.state.members.every((m) => !m.playing)) {
                await this.finishRound('allFinished')
            }
            return
        }

        if (msg?.type === 'rewind') {
            if (!isEligibleForRewind(member)) {
                this.send(ws, {
                    type: 'error',
                    message: 'Rewind is only available after a fail, miss, X, or accuracy under 95%.',
                })
                return
            }

            member.lastResult = undefined
            member.playing = true
            member.ready = false
            this.state.status = 'playing'
            this.scheduleRoundTimer()
            await this.save()
            this.broadcastRoomState()
            return
        }

        if (msg?.type === 'addChatMessage') {
            const text = String(msg.message ?? msg.text ?? '').trim().slice(0, 300)
            if (!text) return

            const entry = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                author: member.user.name || member.user.handle,
                handle: member.user.handle,
                text,
                time: Date.now(),
            }
            this.state.chat.push(entry)
            this.state.chat = this.state.chat.slice(-100)
            await this.save()
            this.broadcast({
                type: 'addChatMessage',
                nonce: typeof msg.nonce === 'number' ? msg.nonce : undefined,
                message: {
                    name: entry.id,
                    author: entry.author,
                    time: entry.time,
                    content: entry.text,
                },
            })
        }
    }

    private async dropSocket(ws: WebSocket): Promise<void> {
        const att = ws.deserializeAttachment() as ConnectionMeta | null
        if (!att || !this.state) return

        const remainingForIndex = this.ctx
            .getWebSockets()
            .filter((s) => s !== ws)
            .some((s) => (s.deserializeAttachment() as ConnectionMeta | null)?.index === att.index)

        if (remainingForIndex) return

        const member = this.state.members.find((m) => m.index === att.index)
        if (member) {
            if (member.playing && !member.lastResult) {
                member.lastResult = normalizeResult({
                    score: 0,
                    accuracy: 0,
                    combo: 0,
                    perfect: 0,
                    great: 0,
                    good: 0,
                    miss: 0,
                    grade: 'X',
                })
            }
            member.playing = false
            member.ready = false
        }

        this.state.members = this.state.members.filter((m) => m.index !== att.index)

        if (this.state.members.length === 0) {
            this.clearRoundTimer()
            this.state.status = 'selecting'
        } else if (this.state.members.every((m) => !m.playing) && this.roundTimer !== null) {
            await this.finishRound('allFinished')
            return
        }

        await this.save()
        await this.syncLobby()
        this.broadcastRoomState()
    }

    async webSocketClose(ws: WebSocket): Promise<void> {
        await this.dropSocket(ws)
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        await this.dropSocket(ws)
    }

    async fetch(req: Request): Promise<Response> {
        if (req.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket', { status: 426 })
        }

        if (!this.state || !this.state.configured) {
            return new Response('Room not found', { status: 404 })
        }

        const joinHeader = req.headers.get('x-join')
        let join: JoinSession | null = null

        if (joinHeader) {
            try {
                join = JSON.parse(decodeURIComponent(joinHeader))
            } catch {
                join = null
            }
        }

        if (!join) {
            const url = new URL(req.url)
            const token =
                req.headers.get('Sonolus-Room-Session') ??
                url.searchParams.get('session')
            if (token) {
                join = await verifyToken<JoinSession>(this.envRoom.SESSION_SECRET, token)
            }
        }

        if (!join || join.room !== this.state.name) {
            return new Response('Unauthorized', { status: 401 })
        }

        const pair = new WebSocketPair()
        const [client, server] = Object.values(pair)
        this.ctx.acceptWebSocket(server)

        const existing = this.state.members.find((m) => m.user.handle === join!.user.handle)
        const index = existing ? existing.index : this.state.nextIndex++
        const lb = this.ensureLeaderboardEntry(join.user)!

        const member: RoomMember = existing
            ? {
                ...existing,
                user: join.user,
                rating: lb.rating,
                pp: lb.pp,
                wins: lb.wins,
                losses: lb.losses,
                draws: lb.draws,
            }
            : {
                index,
                user: join.user,
                ready: false,
                playing: false,
                lastPlayCount: 0,
                rating: lb.rating,
                pp: lb.pp,
                wins: lb.wins,
                losses: lb.losses,
                draws: lb.draws,
            }

        ;(member as any).roomUser = join.roomUser

        this.state.members = [
            ...this.state.members.filter((m) => m.index !== index),
            member,
        ]

        const connId = `${index}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        server.serializeAttachment({
            connId,
            index,
            handle: join.user.handle,
        } satisfies ConnectionMeta)

        await this.save()
        await this.syncLobby()

        const snap = this.roomSnapshot()
        if (snap) {
            this.send(server, snap)
        }

        return new Response(null, {
            status: 101,
            webSocket: client,
        })
    }
}