import { DEFAULT_SCORING, DEFAULT_TYPE, ROOM_TYPES, SCORING_MODES, type RoomType, type ScoringMode } from './config.ts'

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

const titleOption = {
    query: 'title',
    name: 'Room title',
    description: 'Choose a name for your Casual Room.',
    required: false,
    type: 'text' as const,
    def: '',
    placeholder: 'Room title',
    limit: 48,
    shortcuts: [],
}

export const roomForms = (isTournamentHost = false) =>
    (Object.keys(ROOM_TYPES) as RoomType[])
        .filter((type) => isTournamentHost || type === 'casualRoom')
        .map((type) => ({
            type,
            title: ROOM_TYPES[type],
            requireConfirmation: false,
            options: type === 'groupStage'
                ? [groupOption, scoringOption]
                : type === 'casualRoom'
                    ? [titleOption, scoringOption]
                    : [scoringOption],
        }))

export type RoomSettings = {
    type: RoomType
    scoring: ScoringMode
    group: string
    title: string
}

export const serializeSettings = (s: RoomSettings) =>
    `type=${s.type}&scoring=${s.scoring}&group=${encodeURIComponent(s.group || 'A')}&title=${encodeURIComponent(s.title || '')}`

export function parseSettings(input: string | URLSearchParams): RoomSettings | null {
    const p = typeof input === 'string' ? new URLSearchParams(input) : input

    const type = p.get('type') || DEFAULT_TYPE
    const scoring = p.get('scoring') || DEFAULT_SCORING
    const group = (p.get('group') || 'A').trim() || 'A'
    const title = (p.get('title') || '').trim()

    if (!(type in ROOM_TYPES) || !(scoring in SCORING_MODES)) return null
    if (type === 'groupStage' && group.length > 24) return null
    if (title.length > 48) return null

    return { type: type as RoomType, scoring: scoring as ScoringMode, group, title }
}