import type { Lobby } from './lobby.ts'
import type { Room } from './room.ts'

export interface UserProfile {
    id: string
    handle: string
    name: string
}

export interface AuthSession {
    user: UserProfile
    exp: number
}

export interface JoinSession {
    room: string
    user: UserProfile
    roomUser: {
        authentication: string
        signature: string
    }
    exp: number
}

export interface Sil {
    address: string
    name: string
}

export type RoomStatus = 'selecting' | 'preparing' | 'playing'
export type UserStatus = 'waiting' | 'ready' | 'skipped' | 'playing'

export interface GameplayResult {
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

export interface ChatMessage {
    id: string
    handle: string
    author: string
    text: string
    time: number
}

export interface Env {
    LOBBY: DurableObjectNamespace<Lobby>
    ROOM: DurableObjectNamespace<Room>
    POSTS_BUCKET: R2Bucket
    COMMUNITY_BUCKET: R2Bucket
    SESSION_SECRET: string
    PUBLIC_ADDRESS?: string
    DEV_SKIP_SIGNATURE?: string
    RESEND_API_KEY?: string
    CHAT_EMAIL_FROM?: string
    CHAT_WEBHOOK_SECRET?: string
}