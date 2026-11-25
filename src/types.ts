export type UserProfile = {
    id: string
    handle: string
    name: string
}

export type AuthSession = {
    user: UserProfile
    exp: number
}

export type JoinSession = {
    room: string
    user: UserProfile
    roomUser: {
        authentication: string
        signature: string
    }
    exp: number
}

export type RoomVisibility = 'public' | 'private' | 'locked'

export type MatchMode = 'casual' | 'ranked'

export type RoomStatus = 'selecting' | 'preparing' | 'playing'

export type UserStatus = 'waiting' | 'ready' | 'skipped' | 'playing'

export interface Sil {
    address: string
    name: string
}

export interface GameplayResult {
    grade: 'allPerfect' | 'fullCombo' | 'pass' | 'fail' | 'X'
    score: number
    accuracy: number
    arcadeScore: number
    accuracyScore: number
    combo: number
    perfect: number
    great: number
    good: number
    miss: number
    totalCount: number
}

export type LevelItem = {
    name: string
    version: 1
    title: string
    artists: string
    author: string
    rating: number
    engine: any
    cover: any
    bgm: any
    data: any
    source?: string
    tags?: { title: string; icon?: string }[]
}

export type ReplayResource = {
    hash: string
    url?: string
    [key: string]: unknown
}

export type ReplayItem = {
    name: string
    source?: string
    version: 1
    title: string | Record<string, string>
    subtitle: string | Record<string, string>
    author: string
    authorUser?: Record<string, unknown>
    tags: Record<string, unknown>[]
    level: Record<string, unknown>
    data: ReplayResource
    configuration: ReplayResource
}

export type ReplayCompetition =
    | 'groupStage'
    | 'final'
    | 'ultimateEdition'

export type ReplayRoundKind = 'tournament' | 'rewind'

export type ReplaySubmission = {
    edition: string
    competition: ReplayCompetition
    group?: string
    roundId: string
    roundNumber: number
    roundLabel: string
    roundKind: ReplayRoundKind
    songTitle: string
    difficulty: string
    levelName: string
    levelAddress: string
    levelRating?: number
    levelConstant?: number
    playerName: string
    playerHandle: string
    scoreLabel: string
    scoreValue: number
    grade: string
    combo: number
    perfect: number
    great: number
    good: number
    miss: number
    rewindIndex: number
}

export type ReplayRecord = {
    id: string
    handle: string
    replay: ReplayItem
    metadata: ReplaySubmission
    createdAt: number
}

export type RoomMember = {
    index: number
    user: UserProfile
    ready: boolean
    playing: boolean
    lastResult?: GameplayResult
    previousResult?: GameplayResult
    lastPlayCount: number
    lastPlayLevel?: LevelItem
    lastPlayAt?: number
    pp?: number
    rating?: number
    wins?: number
    losses?: number
    draws?: number
}

export type ChatMessage = {
    id: string
    handle: string
    author: string
    text: string
    time: number
}

export type RoomSummary = {
    name: string
    title: string
    subtitle: string
    master: string
    visibility: RoomVisibility
    matchMode?: MatchMode
    roundCount?: number
    ratingMin?: number
    ratingMax?: number
    grade?: string
    accuracyMin?: number
    accuracyMax?: number
    fullCombo?: boolean
    allPerfect?: boolean
}

export type Env = {
    ROOM: DurableObjectNamespace<import('./room.ts').Room>
    LOBBY: DurableObjectNamespace<import('./lobby.ts').Lobby>
    REPLAYS: DurableObjectNamespace<import('./replays.ts').Replays>
    SONOLUS_ASSETS_BUCKET: R2Bucket
    COMMUNITY_BUCKET?: R2Bucket
    SESSION_SECRET: string
    PUBLIC_ADDRESS?: string
    DEV_SKIP_SIGNATURE?: string
    GOOGLE_SHEETS_SPREADSHEET_ID?: string
    GOOGLE_SHEETS_CUSTOM_RANGE?: string
    GOOGLE_SHEETS_PLAYLIST_RANGE?: string
    GOOGLE_SHEETS_API_KEY?: string
    GOOGLE_SERVICE_ACCOUNT_EMAIL?: string
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string
}