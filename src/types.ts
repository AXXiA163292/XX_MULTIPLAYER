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

export type Env = {
    ROOM: DurableObjectNamespace
    LOBBY: DurableObjectNamespace
    CHAT: DurableObjectNamespace
    COMMUNITY_BUCKET: R2Bucket
    POSTS_BUCKET: R2Bucket
    SONOLUS_ASSETS_BUCKET?: R2Bucket
    SESSION_SECRET: string
    PUBLIC_ADDRESS?: string
    DEV_SKIP_SIGNATURE?: string
    REFRESH_KEY?: string
    CUSTOM_LEVELS_SHEET_ID?: string
    PLAYLISTS_SHEET_ID?: string
    RESEND_API_KEY?: string
    NOTIFY_FROM_EMAIL?: string
}