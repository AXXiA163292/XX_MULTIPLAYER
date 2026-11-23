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
import type { RoundKind } from './scoring.ts'

export type CustomSongsMode = 'off' | 'on' | 'customOnly'

export const CUSTOM_SONGS_MODES: Record<CustomSongsMode, string> = {
    off: 'Off',
    on: 'On',
    customOnly: 'Custom only',
}

export const ROUND_MODES: Record<RoundKind, string> = {
    tournament: 'Round',
    warmup: 'Warmup',
    rewind: 'Rewind',
    freeplay: 'Freeplay',
}

export function defaultCustomRoomTitle(hostName?: string): string {
    const clean = String(hostName ?? '').trim()
    return clean ? `${clean}'s room` : 'Custom Room'
}

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
    def: '',
    placeholder: "Player's room",
    limit: 48,
    shortcuts: [],
}

const tierOption = {
    query: 'tier',
    name: 'Room title',
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
    type: 'select' as const,
    def: 'off' as CustomSongsMode,
    values: (Object.keys(CUSTOM_SONGS_MODES) as CustomSongsMode[]).map((name) => ({
        name,
        title: CUSTOM_SONGS_MODES[name],
    })),
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

export const roomForms = (isTournamentHost = false) =>
    (Object.keys(ROOM_TYPES) as RoomType[])
        .filter((type) => isTournamentHost || isOpenType(type))
        .map((type) => ({
            type,
            title: ROOM_TYPES[type],
            requireConfirmation: false,
            options: type === 'groupStage'
                ? [groupOption, tournamentScoringOption, tournamentVisibilityOption]
                : type === 'casualRoom'
                    ? [titleOption, customScoringOption, customVisibilityOption, randomOption]
                    : type === 'rankedRoom'
                        ? [tierOption, customSongsOption]
                        : [tournamentScoringOption, tournamentVisibilityOption],
        }))

export const roomFormsForType = (
    type: RoomType,
    isTournamentHost = false,
) => roomForms(isTournamentHost).filter((form) => form.type === type)

export type RoomSettings = {
    type: RoomType
    scoring: ScoringMode
    roundMode: RoundKind
    group: string
    title: string
    visibility: 'public' | 'private' | 'locked'
    random: boolean
    tier: string
    customSongs: CustomSongsMode
}

export const serializeSettings = (s: RoomSettings) => {
    const values = [
        `type=${s.type}`,
        `scoring=${s.scoring}`,
        `visibility=${s.visibility}`,
    ]

    if (s.type === 'groupStage') {
        values.push(`group=${encodeURIComponent(s.group || 'A')}`)
    }
    if (s.type === 'casualRoom') {
        values.push(`title=${encodeURIComponent(s.title || '')}`)
        values.push(`random=${s.random ? '1' : '0'}`)
    }
    if (s.type === 'rankedRoom') {
        values.push(`tier=${encodeURIComponent(s.tier || 'master')}`)
        values.push(`customSongs=${encodeURIComponent(s.customSongs || 'off')}`)
    }

    return values.join('&')
}

const isOn = (value: string | null) =>
    ['true', '1', 'on'].includes((value || '').toLowerCase())

export function normalizeCustomSongsMode(value: unknown): CustomSongsMode {
    if (typeof value === 'boolean') return value ? 'on' : 'off'
    const normalized = String(value ?? '').trim().toLowerCase()
    if (normalized === 'customonly' || normalized === 'custom_only' || normalized === 'only') {
        return 'customOnly'
    }
    if (normalized === 'on' || normalized === 'true' || normalized === '1') {
        return 'on'
    }
    return 'off'
}

export function normalizeRoundMode(value: unknown): RoundKind {
    const normalized = String(value ?? '').trim().toLowerCase()
    if (normalized === 'warmup' || normalized === 'rewind' || normalized === 'freeplay') {
        return normalized
    }
    return 'tournament'
}

export function parseSettings(
    input: string | URLSearchParams,
    existing?: RoomSettings,
    fallbackHostName?: string,
): RoomSettings | null {
    const p = typeof input === 'string' ? new URLSearchParams(input) : input

    const type = p.get('type') || existing?.type || DEFAULT_TYPE
    if (!(type in ROOM_TYPES)) return null

    const open = isOpenType(type as RoomType)
    const scoring = p.get('scoring') || existing?.scoring || (open ? DEFAULT_OPEN_SCORING : DEFAULT_SCORING)
    const roundMode: RoundKind = !open
        ? normalizeRoundMode(p.get('roundMode') ?? existing?.roundMode)
        : 'tournament'
    const group = (p.get('group') ?? existing?.group ?? 'A').trim() || 'A'
    const rawTitle = p.has('title') ? (p.get('title') ?? '').trim() : (existing?.title ?? '').trim()
    const title = type === 'casualRoom'
        ? (rawTitle || defaultCustomRoomTitle(fallbackHostName))
        : rawTitle
    const rawVisibility = p.get('visibility') ?? existing?.visibility ?? null
    const rawTier = (p.get('tier') ?? existing?.tier ?? 'master').trim().toLowerCase()

    const tier = (RANKED_TIER_NAMES as readonly string[]).includes(rawTier)
        ? rawTier
        : 'master'

    const visibility = type === 'rankedRoom'
        ? 'public'
        : type === 'casualRoom'
            ? (rawVisibility === 'private' ? 'private' : 'public')
            : (rawVisibility === 'public' ? 'public' : 'locked')

    const random = type === 'casualRoom' && (p.has('random') ? isOn(p.get('random')) : Boolean(existing?.random))
    const customSongs: CustomSongsMode = type === 'rankedRoom'
        ? normalizeCustomSongsMode(p.get('customSongs') ?? existing?.customSongs)
        : 'off'

    if (!(scoring in SCORING_MODES)) return null
    if (type === 'groupStage' && group.length > 24) return null
    if (title.length > 48) return null

    return {
        type: type as RoomType,
        scoring: type === 'rankedRoom' ? 'rankedMatch' : (scoring as ScoringMode),
        roundMode,
        group,
        title,
        visibility,
        random,
        tier,
        customSongs,
    }
}