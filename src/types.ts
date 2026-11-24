export type RoomVisibility = 'public' | 'private'

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

export type ChatMessage = {
    id: string
    handle: string
    author: string
    text: string
    time: number
    replyTo?: {
        id: string
        author: string
        handle: string
        text: string
    }
    likes?: string[]
}

export type RoomCover = {
    hash?: string
    url: string
}

export type RoomSummary = {
    name: string
    title: string
    subtitle: string
    master: string
    hostId?: string
    visibility: RoomVisibility
    type?: string
    tier?: string
    level?: {
        address: string
        name: string
    } | null
    coverUrl?: string | null
}

export type RoomStatus = 'selecting' | 'preparing' | 'playing'

export type UserStatus = 'waiting' | 'ready' | 'skipped' | 'playing'

export type Sil = {
    address: string
    name: string
}

export type LevelItem = {
    name: string
    version: number
    title: string
    artists: string
    author: string
    rating: number
    engine: string
    cover: { hash: string; url: string }
    bgm: { hash: string; url: string }
    data: { hash: string; url: string }
    tags: { title: string }[]
    source?: string
}

export type GameplayResult = {
    grade: 'allPerfect' | 'fullCombo' | 'pass' | 'fail' | 'X'
    disqualified?: boolean
    arcadeScore: number
    accuracyScore: number
    combo: number
    perfect: number
    great: number
    good: number
    miss: number
    totalCount: number
}

export type Env = {
    ROOM: DurableObjectNamespace
    LOBBY: DurableObjectNamespace
    CHAT: DurableObjectNamespace
    COMMUNITY_BUCKET: R2Bucket
    SONOLUS_ASSETS_BUCKET: R2Bucket
    SESSION_SECRET: string
    PUBLIC_ADDRESS?: string
    DEV_SKIP_SIGNATURE?: string
    REFRESH_KEY?: string
    CUSTOM_LEVELS_SHEET_ID?: string
    PLAYLISTS_SHEET_ID?: string
}
