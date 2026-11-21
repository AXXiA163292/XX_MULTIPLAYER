export interface Env {
    ROOM: DurableObjectNamespace<import('./room.ts').Room>
    LOBBY: DurableObjectNamespace<import('./lobby.ts').Lobby>
    SESSION_SECRET: string
    HOST_HANDLE: string
    /** Optional: force the public address (https://example.workers.dev). Defaults to request origin. */
    PUBLIC_ADDRESS?: string
    /** LOCAL TESTING ONLY. Skips Sonolus signature checks. Never set in production. */
    DEV_SKIP_SIGNATURE?: string
}

export type Sil = { address: string; name: string }

export type GameplayResult = {
    grade: 'allPerfect' | 'fullCombo' | 'pass' | 'fail'
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

export type RoomUser = { authentication: string; signature: string }
export type RoomStatus = 'selecting' | 'preparing' | 'playing'
export type UserStatus = 'waiting' | 'ready' | 'skipped' | 'playing'

/** Payload carried in the `Sonolus-Room-Session` header of the WebSocket. */
export type JoinSession = {
    room: string
    user: UserProfile
    roomUser: RoomUser
    exp: number
}

/** Payload of the HTTP `Sonolus-Session` header. */
export type AuthSession = { user: UserProfile; exp: number }
