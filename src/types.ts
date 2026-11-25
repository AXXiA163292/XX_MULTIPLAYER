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
    bad?: number
    miss: number
    totalCount: number
    disqualified?: boolean
}

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

export interface RoomCover {
    url: string
    hash?: string
}

export interface ChatMessage {
    id: string
    handle: string
    author: string
    text: string
    time: number
    likes?: string[]
    replyTo?: {
        id: string
        author: string
        handle: string
        text: string
    }
}

export type ReplayCompetition = 'groupStage' | 'final' | 'ultimateEdition'

export interface ReplayMetadata {
    competition: ReplayCompetition
    edition: string
    group?: string
    roundId: string
    roundNumber: number
    roundLabel: string
    songTitle: string
    difficulty: string
    levelRating?: number | null
    playerHandle: string
    playerName: string
    scoreLabel: string
    scoreValue: number
    perfect: number
    great: number
    good: number
    miss: number
    combo: number
}

export interface ReplayRecord {
    id: string
    createdAt: number
    metadata: ReplayMetadata
    replay: Record<string, any>
}

export interface Env {
    SESSION_SECRET: string
    PUBLIC_ADDRESS?: string
    DEV_SKIP_SIGNATURE?: string
    ROOM: DurableObjectNamespace
    LOBBY: DurableObjectNamespace
    CHAT: DurableObjectNamespace
    REPLAYS: DurableObjectNamespace
    COMMUNITY_BUCKET?: R2Bucket
    SONOLUS_ASSETS_BUCKET?: R2Bucket
}