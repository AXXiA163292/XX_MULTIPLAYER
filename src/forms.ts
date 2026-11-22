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
    description: 'Choose a name for your Custom Room.',
    required: false,
    type: 'text' as const,
    def: 'Custom Room',
    placeholder: 'Custom Room',
    limit: 48,
    shortcuts: [],
}

const tournamentVisibilityOption = {
    query: 'visibility',
    name: 'Room access',
    required: false,
    type: 'select' as const,
    def: 'locked',
    values: [
        { name: 'public', title: 'Public' },
        { name: 'locked', title: 'Locked' },
    ],
}

const customVisibilityOption = {
    query: 'visibility',
    name: 'Room access',
    required: false,
    type: 'select' as const,
    def: 'public',
    values: [
        { name: 'public', title: 'Public' },
        { name: 'private', title: 'Private' },
    ],
}

const randomOption = {
    query: 'random',
    name: 'Random level',
    required: false,
    type: 'toggle' as const,
    def: false,
}

export const closeRoomForm = {
    type: 'closeRoom',
    title: 'Close Room',
    icon: 'delete',
    requireConfirmation: true,
    options: [],
}

export const roomForms = (isTournamentHost = false) =>
    (Object.keys(ROOM_TYPES) as RoomType[])
        .filter((type) => isTournamentHost || type === 'casualRoom')
        .map((type) => ({
            type,
            title: ROOM_TYPES[type],
            requireConfirmation: false,
            options: type === 'groupStage'
                ? [groupOption, scoringOption, tournamentVisibilityOption]
                : type === 'casualRoom'
                    ? [titleOption, scoringOption, customVisibilityOption, randomOption]
                    : [scoringOption, tournamentVisibilityOption],
        }))

export type RoomSettings = {
    type: RoomType
    scoring: ScoringMode
    group: string
    title: string
    visibility: 'public' | 'private' | 'locked'
    random: boolean
}

export const serializeSettings = (s: RoomSettings) => {
    const values = [
        `type=${s.type}`,
        `scoring=${s.scoring}`,
        `visibility=${s.visibility}`,
    ]

    if (s.type === 'groupStage') values.push(`group=${encodeURIComponent(s.group || 'A')}`)
    if (s.type === 'casualRoom') {
        values.push(`title=${encodeURIComponent(s.title || '')}`)
        values.push(`random=${s.random ? '1' : '0'}`)
    }

    return values.join('&')
}

export function parseSettings(input: string | URLSearchParams): RoomSettings | null {
    const p = typeof input === 'string' ? new URLSearchParams(input) : input

    const type = p.get('type') || DEFAULT_TYPE
    const scoring = p.get('scoring') || DEFAULT_SCORING
    const group = (p.get('group') || 'A').trim() || 'A'
    const title = (p.get('title') || '').trim()
    const rawVisibility = p.get('visibility')

    const visibility = type === 'casualRoom'
        ? (rawVisibility === 'private' ? 'private' : 'public')
        : (rawVisibility === 'public' ? 'public' : 'locked')

    const random = type === 'casualRoom' &&
        ['true', '1', 'on'].includes((p.get('random') || '').toLowerCase())

    if (!(type in ROOM_TYPES) || !(scoring in SCORING_MODES)) return null
    if (type === 'groupStage' && group.length > 24) return null
    if (title.length > 48) return null

    return {
        type: type as RoomType,
        scoring: scoring as ScoringMode,
        group,
        title,
        visibility,
        random,
    }
}