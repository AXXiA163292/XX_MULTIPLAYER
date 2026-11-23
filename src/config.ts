export const SERVER_TITLE = 'XX!'
export const SERVER_DESCRIPTION = 'XX! Sonolus multiplayer server'

export const TOURNAMENT_HOST_HANDLE = '163292'
export const STAFF_CHAT_HANDLES = ['163292', '283420', '3227470'] as const
export const STAFF_CHAT_URL =
    'https://discord.com/channels/1436062333817626835/1436063195462152263'
export const STAFF_CHAT_ALERT_EMAIL = 'axxia163292@gmail.com'

export type ScoringMode = 'pp' | 'rankedMatch'

export const SCORING_MODES: Record<ScoringMode, string> = {
    pp: 'PP',
    rankedMatch: 'Ranked Match',
}

export const RANKED_POINTS = {
    perfect: 3,
    great: 2,
    good: 1,
} as const

export const EMPTY_ROOM_TTL_MS = 3 * 60_000
export const RESERVED_ROOM_TTL_MS = 2 * 60_000
export const MAX_ROOM_LIFESPAN_MS = 6 * 60 * 60_000