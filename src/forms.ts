import {
    DEFAULT_OPEN_SCORING,
    DEFAULT_SCORING,
    DEFAULT_TYPE,
    RANKED_TIER_NAMES,
    ROOM_TYPES,
    SCORING_MODES,
    type RoomType,
    type ScoringMode,
} from './config.ts'

const tournamentScoringOption = {
    query: 'scoring',
    name: 'Round scoring',
    required: false,
    type: 'select' as const,
    def: DEFAULT_SCORING,
    values: Object.entries(SCORING_MODES).map(([name, title]) => ({ name, title })),
}

const customScoringOption = {
    ...tournamentScoringOption,
    def: DEFAULT_OPEN_SCORING,
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

const tierOption = {
    query: 'tier',
    name: 'Rank',
    description: 'Pick the rank of this room.',
    required: false,
    type: 'select' as const,
    def: 'master',
    values: RANKED_TIER_NAMES.map((name) => ({
        name,
        title: name.toUpperCase(),
    })),
}

const customSongsOption = {
    query: 'customSongs',
    name: 'Custom songs',
    required: false,
    type: 'toggle' as const,
    def: false,
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

const isOpenType = (type: RoomType) =>
    type === 'casualRoom' || type === 'rankedRoom'

/** `only` = just the form of that room type (used inside a room: current type settings only). */
export const roomForms = (isTournamentHost = false, only?: RoomType) =>
    (Object.keys(ROOM_TYPES) as RoomType[])
        .filter((type) => (only ? type === only : isTournamentHost || isOpenType(type)))
        .map((type) => ({
            type,
            title: ROOM_TYPES[type],
            requireConfirmation: false,
            options: type === 'groupStage'
                ? [groupOption, tournamentScoringOption, tournamentVisibilityOption]
                : type === 'casualRoom'
                    ? [titleOption, customScoringOption, customVisibilityOption, randomOption]
                    : type === 'rankedRoom'
                        // Ranked Match: always public, always Ranked scoring, never random.
                        ? [tierOption, customSongsOption]
                        : [tournamentScoringOption, tournamentVisibilityOption],
        }))

export type RoomSettings = {
    type: RoomType
    scoring: ScoringMode
    group: string
    title: string
    visibility: 'public' | 'private' | 'locked'
    random: boolean
    tier: string
    customSongs: boolean
}

export const serializeSettings = (s: RoomSettings) => {
    const values = [`type=${s.type}`]

    // Only the options that exist in the form of this room type.
    if (s.type !== 'rankedRoom') {
        values.push(`scoring=${s.scoring}`)
        values.push(`visibility=${s.visibility}`)
    }

    if (s.type === 'groupStage') values.push(`group=${encodeURIComponent(s.group || 'A')}`)
    if (s.type === 'casualRoom') {
        values.push(`title=${encodeURIComponent(s.title || '')}`)
        values.push(`random=${s.random ? '1' : '0'}`)
    }
    if (s.type === 'rankedRoom') {
        values.push(`tier=${encodeURIComponent(s.tier || 'master')}`)
        values.push(`customSongs=${s.customSongs ? '1' : '0'}`)
    }

    return values.join('&')
}

const isOn = (value: string | null) =>
    ['true', '1', 'on'].includes((value || '').toLowerCase())

/** "Group B", "group b" and "b" all become "B" (the title adds the word Group itself). */
const normalizeGroup = (value: string | null) => {
    const cleaned = (value || '').trim().replace(/^group\s*/i, '').trim()
    return (cleaned.length === 1 ? cleaned.toUpperCase() : cleaned) || 'A'
}

export function parseSettings(input: string | URLSearchParams): RoomSettings | null {
    const p = typeof input === 'string' ? new URLSearchParams(input) : input

    const type = p.get('type') || DEFAULT_TYPE

    if (!(type in ROOM_TYPES)) return null

    const open = isOpenType(type as RoomType)
    const scoring = p.get('scoring') || (open ? DEFAULT_OPEN_SCORING : DEFAULT_SCORING)
    const group = normalizeGroup(p.get('group'))
    const title = (p.get('title') || '').trim()
    const rawVisibility = p.get('visibility')
    const rawTier = (p.get('tier') || 'master').trim().toLowerCase()

    const tier = (RANKED_TIER_NAMES as readonly string[]).includes(rawTier)
        ? rawTier
        : 'master'

    // Ranked Match rooms are always public.
    const visibility = type === 'rankedRoom'
        ? 'public'
        : type === 'casualRoom'
            ? (rawVisibility === 'private' ? 'private' : 'public')
            : (rawVisibility === 'public' ? 'public' : 'locked')

    const random = type === 'casualRoom' && isOn(p.get('random'))
    const customSongs = type === 'rankedRoom' && isOn(p.get('customSongs'))

    if (!(scoring in SCORING_MODES)) return null
    if (type === 'groupStage' && group.length > 24) return null
    if (title.length > 48) return null

    return {
        type: type as RoomType,
        // Ranked Match rooms always use Ranked scoring.
        scoring: type === 'rankedRoom' ? 'rankedMatch' : (scoring as ScoringMode),
        group,
        title,
        visibility,
        random,
        tier,
        customSongs,
    }
}