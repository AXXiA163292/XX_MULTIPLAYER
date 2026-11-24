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

export type RoomUser = JoinSession['roomUser']

export type Sil = {
    address: string
    name: string
}

export type RoomStatus = 'selecting' | 'preparing' | 'playing'

export type UserStatus = 'waiting' | 'ready' | 'skipped' | 'playing'

export type RoomVisibility = 'public' | 'private'

export type MatchMode = 'casual' | 'ranked'

export type RoomSettings = {
    title: string
    master: boolean
    maxCount: number
    visibility: RoomVisibility
    type?: string
    scoring?: string
    roundMode?: string
    group?: string
    tier?: string
    customSongs?: string
    matchMode?: MatchMode
    roundCount?: number
    timeLimitSec?: number
    levelPool?: string
    level?: LevelItem
    ratingMin?: number
    ratingMax?: number
    grade?: string
    accuracyMin?: number
    accuracyMax?: number
    fullCombo?: boolean
    allPerfect?: boolean
}

export type GameplayResult = {
    grade: 'allPerfect' | 'fullCombo' | 'pass' | 'fail' | 'X'
    disqualified?: boolean
    arcadeScore: number
    accuracyScore: number
    score?: number
    accuracy: number
    combo: number
    perfect: number
    great: number
    good: number
    miss: number
    totalCount: number
}

export type RoomMember = {
    index: number
    user: UserProfile
    ready: boolean
    playing: boolean
    status?: UserStatus
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

export type RoomSummary = {
    name: string
    title: string
    subtitle: string
    master: boolean
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
    POSTS_BUCKET: R2Bucket
    COMMUNITY_BUCKET?: R2Bucket
    SESSION_SECRET: string
    PUBLIC_ADDRESS?: string
    DEV_SKIP_SIGNATURE?: string
    REFRESH_KEY?: string
    GOOGLE_SHEETS_SPREADSHEET_ID?: string
    GOOGLE_SHEETS_CUSTOM_RANGE?: string
    GOOGLE_SHEETS_PLAYLIST_RANGE?: string
    GOOGLE_SHEETS_API_KEY?: string
    GOOGLE_SERVICE_ACCOUNT_EMAIL?: string
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string
}