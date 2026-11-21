
export interface Env {
    ROOM: DurableObjectNamespace<import('./room.ts').Room>
    LOBBY: DurableObjectNamespace<import('./lobby.ts').Lobby>
    POSTS_BUCKET: R2Bucket
    SESSION_SECRET: string
    HOST_HANDLE: string
    PUBLIC_ADDRESS?: string
    DEV_SKIP_SIGNATURE?: string
}

export type Sil = { address: string; name: string }

export type GameplayResult = {
    grade: 'allPerfect' | 'fullCombo' | 'pass' | 'fail' | 'X'
    arcadeScore: number
    accuracyScore: number
    combo: number
    perfect: number
    great: number
    good: number
    miss: number
    totalCount: number
}

export type UserProfile = {
    id: string
    handle: string
    name: string
}

export type RoomUser = {
    authentication: string
    signature: string
}

export type RoomStatus = 'selecting' | 'preparing' | 'playing'
export type UserStatus = 'waiting' | 'ready' | 'skipped' | 'playing'

export type JoinSession = {
    room: string
    user: UserProfile
    roomUser: RoomUser
    exp: number
}

export type AuthSession = {
    user: UserProfile
    exp: number
}