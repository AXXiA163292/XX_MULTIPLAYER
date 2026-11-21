import {
    DEFAULT_SCORING,
    DEFAULT_TYPE,
    ROOM_TYPES,
    SCORING_MODES,
    type RoomType,
    type ScoringMode,
} from './config.ts'

/**
 * Sonolus models room types as a list of forms: the form's `type` becomes the `type=` query parameter
 * and the options inside it are the settings for that type. Group Stage and Final share the same settings.
 * Tiebreakers, random, auto exit and level options are intentionally NOT exposed.
 */
const scoringOption = {
    query: 'scoring',
    name: 'Round scoring',
    required: true,
    type: 'select' as const,
    def: DEFAULT_SCORING,
    values: Object.entries(SCORING_MODES).map(([name, title]) => ({ name, title })),
}

export const roomForms = () =>
    (Object.keys(ROOM_TYPES) as RoomType[]).map((type) => ({
        type,
        title: ROOM_TYPES[type],
        requireConfirmation: false,
        options: [scoringOption],
    }))

export type RoomSettings = { type: RoomType; scoring: ScoringMode }

export const serializeSettings = (s: RoomSettings) => `type=${s.type}&scoring=${s.scoring}`

/** Parses `type=groupStage&scoring=pp` (or create query params). Returns null when invalid. */
export function parseSettings(input: string | URLSearchParams): RoomSettings | null {
    const p = typeof input === 'string' ? new URLSearchParams(input) : input
    const type = p.get('type') ?? DEFAULT_TYPE
    const scoring = p.get('scoring') ?? DEFAULT_SCORING
    if (!(type in ROOM_TYPES) || !(scoring in SCORING_MODES)) return null
    return { type: type as RoomType, scoring: scoring as ScoringMode }
}
