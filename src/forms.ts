
import {
    DEFAULT_SCORING,
    DEFAULT_TYPE,
    ROOM_TYPES,
    SCORING_MODES,
    type RoomType,
    type ScoringMode,
} from './config.ts'

const scoringOption = {
    query: 'scoring',
    name: 'Round scoring',
    required: false,
    type: 'select' as const,
    def: DEFAULT_SCORING,
    values: Object.entries(SCORING_MODES).map(([name, title]) => ({ name, title })),
}

const groupOption = {
    query: 'group',
    name: 'Group',
    description: 'Enter the group name, for example A.',
    required: false,
    type: 'text' as const,
    def: 'A',
    placeholder: 'A',
    limit: 24,
    shortcuts: [],
}

export const roomForms = () =>
    (Object.keys(ROOM_TYPES) as RoomType[]).map((type) => ({
        type,
        title: ROOM_TYPES[type],
        requireConfirmation: false,
        options: type === 'groupStage'
            ? [groupOption, scoringOption]
            : [scoringOption],
    }))

export type RoomSettings = {
    type: RoomType
    scoring: ScoringMode
    group: string
}

export const serializeSettings = (s: RoomSettings) =>
    `type=${s.type}&scoring=${s.scoring}&group=${encodeURIComponent(s.group || 'A')}`

export function parseSettings(input: string | URLSearchParams): RoomSettings | null {
    const p = typeof input === 'string' ? new URLSearchParams(input) : input

    const type = p.get('type') || DEFAULT_TYPE
    const scoring = p.get('scoring') || DEFAULT_SCORING
    const group = (p.get('group') || 'A').trim() || 'A'

    if (!(type in ROOM_TYPES) || !(scoring in SCORING_MODES)) return null
    if (type === 'groupStage' && group.length > 24) return null

    return {
        type: type as RoomType,
        scoring: scoring as ScoringMode,
        group,
    }
}