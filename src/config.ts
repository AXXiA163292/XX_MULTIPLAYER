// ---- Things you will probably want to tweak ----

/** Points per judgment for "Ranked Match" scoring. Sonolus reports perfect / great / good / miss. */
export const RANKED_POINTS = { perfect: 3, great: 2, good: 1 } as const

export const ROOM_TYPES = {
    groupStage: 'Group Stage',
    final: 'Final',
} as const
export type RoomType = keyof typeof ROOM_TYPES

export const SCORING_MODES = {
    rankedMatch: 'Ranked Match',
    pp: 'PP',
} as const
export type ScoringMode = keyof typeof SCORING_MODES

export const DEFAULT_TYPE: RoomType = 'groupStage'
export const DEFAULT_SCORING: ScoringMode = 'rankedMatch'

export const SERVER_TITLE = 'XX! Championship'
export const SERVER_DESCRIPTION = 'WINTER 2027'

/** Empty rooms are deleted after this long. */
export const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000
/** A reserved-but-never-joined room is deleted after this long. */
export const RESERVED_ROOM_TTL_MS = 5 * 60 * 1000
