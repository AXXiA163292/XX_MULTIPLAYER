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
    RoomMember,
    RoomSettings,
    RoomStatus,
    RoomSummary,
    UserProfile,
    UserStatus,
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

type Connection = {
    ws: WebSocket
    index: number
}

type PersistedState = {
    name: string
    key: string
    configured: boolean
    status: RoomStatus
    hostId: string
    hostName: string
    hostHandle: string
    settings: RoomSettings
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

function defaultSettings(title = 'XX! Room', hostName = 'Host'): RoomSettings {
    return {
        title,
        master: true,
        maxCount: 4,
        visibility: 'public',
        matchMode: 'casual',
        roundCount: 3,
        timeLimitSec: 180,
        levelPool: 'all',
        level: DEFAULT_LEVEL,
        ratingMin: 0,
        ratingMax: 9999,
        grade: 'any',
        accuracyMin: 0,
        accuracyMax: 100,
        fullCombo: false,
        allPerfect: false,
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
    const totalCount = Number(raw?.totalCount) || (perfect + great + good + miss)
    const score = Number(raw?.score ?? raw?.arcadeScore) || 0
    const accuracy = Math.max(0, Math.min(1, Number(raw?.accuracy) || 0))

    return {
        score,
        arcadeScore: Number(raw?.arcadeScore) || score,
        accuracyScore: Number(raw?.accuracyScore) || Math.round(accuracy * 10000),
        accuracy,
        combo: Number(raw?.combo) || 0,
        perfect,
        great,
        good,
        miss,
        totalCount,
        grade,
    }
}

function sanitizeWireResult(result: GameplayResult): GameplayResult {
    const wireGrade: Exclude<GameplayResult['grade'], 'X'> =
        result.grade === 'X' ? 'fail' : result.grade

    return {
        ...result,
        grade: wireGrade,
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
        const scoreVal = r.score ?? r.arcadeScore ?? 0
        parts.push(
            `Last: ${scoreVal.toLocaleString()} pts · ${accPct}% · ${r.combo} combo · ${gradeText}`,
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
    private conns = new Map<string, Connection>()
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
                    configured: Boolean(saved.configured),
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
        if (!this.state?.name) return
        try {
            if (this.state.configured && this.state.members.length > 0) {
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
        const limitSec = this.state.settings.timeLimitSec || 180
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
                status: 'selecting',
                hostId: meta.hostId,
                hostName: meta.hostName,
                hostHandle: meta.hostHandle,
                settings: defaultSettings(`${meta.hostName || meta.hostHandle}'s Room`, meta.hostName),
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
        if (!this.state || !this.state.configured) return 'Room does not exist.'

        const s = this.state.settings
        if (this.state.members.length >= s.maxCount) {
            const exists = this.state.members.some((m) => m.user.handle === user.handle)
            if (!exists) return 'Room is full.'
        }

        if (user.handle === TOURNAMENT_HOST_HANDLE) return null

        const lb = this.state.leaderboard.find((e) => e.handle === user.handle)
        const rating = lb?.rating ?? 1000

        if (typeof s.ratingMin === 'number' && rating < s.ratingMin) {
            return `Minimum rating required: ${s.ratingMin} (yours: ${rating}).`
        }
        if (typeof s.ratingMax === 'number' && rating > s.ratingMax) {
            return `Maximum rating allowed: ${s.ratingMax} (yours: ${rating}).`
        }

        return null
    }

    async configure(
        key: string,
        settings: RoomSettings,
        user: UserProfile,
    ): Promise<boolean> {
        if (!this.state || this.state.key !== key) return false

        const isTournamentHost = user.handle === TOURNAMENT_HOST_HANDLE
        if (
            !isTournamentHost &&
            settings.matchMode === 'ranked'
        ) {
            return false
        }

        const chosenLevel = settings.level ?? await this.pickRandomLevel(settings.levelPool)

        this.state.settings = {
            ...defaultSettings(settings.title, user.name || user.handle),
            ...settings,
            level: chosenLevel,
            roundCount: ROUND_COUNT_OPTIONS.includes(settings.roundCount as any)
                ? settings.roundCount
                : 3,
            timeLimitSec: TIME_LIMIT_OPTIONS.includes(settings.timeLimitSec as any)
                ? settings.timeLimitSec
                : 180,
        }
        this.state.configured = true
        this.state.status = 'selecting'

        await this.save()
        await this.syncLobby()
        this.broadcastRoomState()
        return true
    }

    async summary(): Promise<RoomSummary | null> {
        if (!this.state || !this.state.configured) return null
        const s = this.state.settings
        const modeLabel = s.matchMode === 'ranked' ? 'RANKED' : 'CASUAL'
        const roundText = s.roundCount ? `R${Math.min(this.state.roundNumber + 1, s.roundCount)}/${s.roundCount}` : ''
        const subtitleParts = [
            modeLabel,
            roundText,
            `${this.state.members.length}/${s.maxCount} players`,
            s.level?.title ? `♪ ${s.level.title}` : '',
        ].filter(Boolean)

        return {
            name: this.state.name,
            title: s.title,
            subtitle: subtitleParts.join(' · '),
            master: s.master,
            visibility: s.visibility,
            matchMode: s.matchMode,
            roundCount: s.roundCount,
            ratingMin: s.ratingMin,
            ratingMax: s.ratingMax,
            grade: s.grade,
            accuracyMin: s.accuracyMin,
            accuracyMax: s.accuracyMax,
            fullCombo: s.fullCombo,
            allPerfect: s.allPerfect,
        }
    }

    private roomSnapshot() {
        if (!this.state) return null
        const s = this.state.settings
        return {
            name: this.state.name,
            title: s.title,
            status: this.state.status,
            master: s.master,
            maxCount: s.maxCount,
            visibility: s.visibility,
            matchMode: s.matchMode ?? 'casual',
            roundCount: s.roundCount ?? 3,
            roundNumber: this.state.roundNumber,
            roundDeadline: this.roundDeadline,
            level: s.level,
            members: this.state.members.map((m) => ({
                index: m.index,
                user: m.user,
                ready: m.ready,
                playing: m.playing,
                status: m.status ?? (m.playing ? 'playing' : m.ready ? 'ready' : 'waiting'),
                detail: fmtDetail(m),
                lastResult: m.lastResult ? sanitizeWireResult(m.lastResult) : undefined,
                pp: m.pp ?? 0,
                rating: m.rating ?? 1000,
                wins: m.wins ?? 0,
                losses: m.losses ?? 0,
                draws: m.draws ?? 0,
            })),
            leaderboard: [...this.state.leaderboard]
                .sort((a, b) => b.rating - a.rating || b.pp - a.pp)
                .slice(0, 20),
            roundHistory: this.state.roundHistory.slice(-10),
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
        for (const conn of this.conns.values()) {
            this.send(conn.ws, payload)
        }
    }

    private broadcastRoomState(): void {
        const snap = this.roomSnapshot()
        if (!snap) return
        this.broadcast({ type: 'roomState', room: snap })
    }

    private async finishRound(reason: 'allFinished' | 'timeout' | 'manual'): Promise<void> {
        if (!this.state) return
        this.clearRoundTimer()
        this.state.status = 'selecting'

        const activePlayers = this.state.members.filter((m) => m.playing)
        for (const m of activePlayers) {
            m.playing = false
            m.ready = false
            m.status = 'waiting'
            if (!m.lastResult) {
                m.lastResult = {
                    score: 0,
                    arcadeScore: 0,
                    accuracyScore: 0,
                    accuracy: 0,
                    combo: 0,
                    perfect: 0,
                    great: 0,
                    good: 0,
                    miss: 0,
                    totalCount: 0,
                    grade: 'fail',
                }
            }
        }

        const mode = this.state.settings.matchMode ?? 'casual'
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
            const scoreVal = res.score ?? res.arcadeScore ?? 0
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
                    const oppScore = isPlayerX(opp.lastResult)
                        ? -1
                        : (opp.lastResult?.score ?? opp.lastResult?.arcadeScore ?? 0)
                    totalDelta += calculateRatingDelta(
                        lb.rating,
                        oppLb.rating,
                        scoreVal,
                        oppScore,
                        mode,
                    )
                }
                ratingDelta = Math.round(totalDelta / opponents.length)
            }

            if (opponents.length > 0 && !isPlayerX(res)) {
                const topOppScore = Math.max(
                    ...opponents.map((o) =>
                        isPlayerX(o.lastResult) ? -1 : (o.lastResult?.score ?? o.lastResult?.arcadeScore ?? 0),
                    ),
                )
                if (scoreVal > topOppScore) lb.wins += 1
                else if (scoreVal < topOppScore) lb.losses += 1
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
                score: scoreVal,
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
            levelTitle: this.state.settings.level?.title ?? DEFAULT_LEVEL.title,
            results: roundEntries.sort((a, b) => b.score - a.score),
        })
        this.state.roundHistory = this.state.roundHistory.slice(-20)

        const maxRounds = this.state.settings.roundCount ?? 3
        if (this.state.roundNumber >= maxRounds) {
            this.state.roundNumber = 0
        }
        this.state.settings.level = await this.pickRandomLevel(this.state.settings.levelPool)

        await this.save()
        await this.syncLobby()

        this.broadcast({
            type: 'roundEnded',
            reason,
            round: this.state.roundHistory[this.state.roundHistory.length - 1],
            room: this.roomSnapshot(),
        })
    }

    private async handleMessage(conn: Connection, rawData: string | ArrayBuffer): Promise<void> {
        if (!this.state) return

        let msg: any
        try {
            const text = typeof rawData === 'string'
                ? rawData
                : new TextDecoder().decode(rawData)
            msg = JSON.parse(text)
        } catch {
            return
        }

        const member = this.state.members.find((m) => m.index === conn.index)
        if (!member) return

        const isHost =
            member.user.handle === this.state.hostHandle ||
            member.user.handle === TOURNAMENT_HOST_HANDLE

        const msgType = String(msg?.type ?? '')

        if (msgType === 'setReady' || msgType === 'updateStatus') {
            const nextStatus: UserStatus = typeof msg.status === 'string'
                ? msg.status
                : msg.ready
                    ? 'ready'
                    : 'waiting'
            member.status = nextStatus
            member.ready = nextStatus === 'ready'
            member.playing = nextStatus === 'playing'
            await this.save()
            this.broadcastRoomState()
            return
        }

        if (msgType === 'updateOptionValues' && isHost && msg.options && typeof msg.options === 'object') {
            this.state.settings = {
                ...this.state.settings,
                ...msg.options,
            }
            await this.save()
            await this.syncLobby()
            this.broadcastRoomState()
            return
        }

        if (msgType === 'startRound' || msgType === 'startGameplay') {
            if (!isHost) {
                this.send(conn.ws, { type: 'error', message: 'Only the host can start the round.' })
                return
            }

            this.state.status = 'playing'
            for (const m of this.state.members) {
                m.previousResult = m.lastResult
                m.lastResult = undefined
                m.playing = true
                m.ready = false
                m.status = 'playing'
                m.lastPlayCount += 1
                m.lastPlayLevel = this.state.settings.level
                m.lastPlayAt = Date.now()
            }

            this.scheduleRoundTimer()
            await this.save()
            await this.syncLobby()
            this.broadcast({
                type: 'roundStarted',
                round: this.state.roundNumber + 1,
                deadline: this.roundDeadline,
                room: this.roomSnapshot(),
            })
            return
        }

        if (msgType === 'finishResult' || msgType === 'finishGameplay') {
            const result = normalizeResult(msg.result ?? msg)
            member.lastResult = result
            member.playing = false
            member.ready = false
            member.status = 'waiting'

            const lb = this.ensureLeaderboardEntry(member.user)!
            member.pp = computePp(result, lb.rating, this.state.settings.matchMode ?? 'casual')
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

        if (msgType === 'rewind') {
            if (!isEligibleForRewind(member)) {
                this.send(conn.ws, {
                    type: 'error',
                    message: 'Rewind is only available after a fail, miss, X, or accuracy under 95%.',
                })
                return
            }

            member.lastResult = undefined
            member.playing = true
            member.ready = false
            member.status = 'playing'
            this.state.status = 'playing'
            this.scheduleRoundTimer()
            await this.save()
            this.broadcast({
                type: 'playerRewound',
                handle: member.user.handle,
                room: this.roomSnapshot(),
            })
            return
        }

        if (msgType === 'chat') {
            const text = String(msg.text ?? '').trim().slice(0, 300)
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
            this.broadcast({ type: 'chat', message: entry })
        }
    }

    private async dropMember(connId: string, index: number): Promise<void> {
        this.conns.delete(connId)
        if (!this.state) return

        const member = this.state.members.find((m) => m.index === index)
        if (member) {
            if (member.playing && !member.lastResult) {
                member.lastResult = {
                    score: 0,
                    arcadeScore: 0,
                    accuracyScore: 0,
                    accuracy: 0,
                    combo: 0,
                    perfect: 0,
                    great: 0,
                    good: 0,
                    miss: 0,
                    totalCount: 0,
                    grade: 'X',
                }
            }
            member.playing = false
            member.ready = false
            member.status = 'waiting'
        }

        this.state.members = this.state.members.filter((m) => m.index !== index)

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

    async fetch(req: Request): Promise<Response> {
        if (!this.state) {
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
        server.accept()

        const existing = this.state.members.find((m) => m.user.handle === join!.user.handle)
        const index = existing ? existing.index : this.state.nextIndex++
        const lb = this.ensureLeaderboardEntry(join.user)!

        const member: RoomMember = existing
            ? {
                ...existing,
                user: join.user,
                status: existing.status ?? 'waiting',
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
                status: 'waiting',
                lastPlayCount: 0,
                rating: lb.rating,
                pp: lb.pp,
                wins: lb.wins,
                losses: lb.losses,
                draws: lb.draws,
            }

        this.state.members = [
            ...this.state.members.filter((m) => m.index !== index),
            member,
        ]

        const connId = `${index}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const conn: Connection = { ws: server, index }
        this.conns.set(connId, conn)

        await this.save()
        await this.syncLobby()

        const snap = this.roomSnapshot()
        this.send(server, {
            type: 'welcome',
            index,
            room: snap,
            chat: this.state.chat.slice(-50),
        })
        this.send(server, {
            type: 'update',
            room: snap,
            chat: this.state.chat.slice(-50),
        })
        this.broadcastRoomState()

        server.addEventListener('message', (event) => {
            void this.handleMessage(conn, event.data)
        })

        server.addEventListener('close', () => {
            void this.dropMember(connId, index)
        })

        server.addEventListener('error', () => {
            void this.dropMember(connId, index)
        })

        return new Response(null, {
            status: 101,
            webSocket: client,
        })
    }
}