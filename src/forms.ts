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

const editionOption = (editions: string[]) => ({
    query: 'edition',
    name: 'Edition',
    description: 'Choose the championship edition.',
    required: false,
    type: 'select' as const,
    def: editions[0] ?? '',
    values: editions.map((edition) => ({
        name: edition,
        title: edition,
    })),
})

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
    name: 'Division',
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

export type RankedVocalType = 'virtualSinger' | 'sekai'

const vocalTypeOption = {
    query: 'vocalType',
    name: 'Vocal Type',
    required: false,
    type: 'select' as const,
    def: 'sekai' as RankedVocalType,
    values: [
        { name: 'virtualSinger', title: 'VIRTUAL SINGER' },
        { name: 'sekai', title: 'SEKAI' },
    ],
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

export const roomForms = (
    isTournamentHost = false,
    availableEditions: string[] = [],
) => {
    const editions = [...new Set(
        availableEditions
            .map((edition) => String(edition).trim().toUpperCase())
            .filter(Boolean),
    )]

    return (Object.keys(ROOM_TYPES) as RoomType[])
        .filter((type) => isTournamentHost || isOpenType(type))
        .map((type) => ({
            type,
            title: ROOM_TYPES[type],
            requireConfirmation: false,
            options: type === 'groupStage'
                ? [
                    editionOption(editions),
                    groupOption,
                    tournamentScoringOption,
                    tournamentVisibilityOption,
                ]
                : type === 'final' || type === 'ultimateEdition'
                    ? [
                        editionOption(editions),
                        tournamentScoringOption,
                        tournamentVisibilityOption,
                    ]
                    : type === 'casualRoom'
                        ? [
                            titleOption,
                            customScoringOption,
                            customVisibilityOption,
                            randomOption,
                        ]
                        : [
                            tierOption,
                            customSongsOption,
                            vocalTypeOption,
                        ],
        }))
}

export const roomFormsForType = (
    type: RoomType,
    isTournamentHost = false,
    availableEditions: string[] = [],
) =>
    roomForms(isTournamentHost, availableEditions)
        .filter((form) => form.type === type)
        .map((form) =>
            type === 'rankedRoom'
                ? { ...form, options: [vocalTypeOption] }
                : form,
        )

export type RoomSettings = {
    type: RoomType
    edition: string
    scoring: ScoringMode
    roundMode: RoundKind
    group: string
    title: string
    visibility: 'public' | 'private' | 'locked'
    random: boolean
    tier: string
    customSongs: CustomSongsMode
    vocalType: RankedVocalType
}

export const serializeSettings = (s: RoomSettings) => {
    const values = [
        `type=${s.type}`,
        `scoring=${s.scoring}`,
        `visibility=${s.visibility}`,
    ]

    if (!isOpenType(s.type)) {
        values.push(`edition=${encodeURIComponent(s.edition || '')}`)
    }

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
        values.push(`vocalType=${encodeURIComponent(s.vocalType || 'virtualSinger')}`)
    }

    return values.join('&')
}

const isOn = (value: string | null) =>
    ['true', '1', 'on'].includes((value || '').toLowerCase())

export function normalizeCustomSongsMode(value: unknown): CustomSongsMode {
    if (typeof value === 'boolean') return value ? 'on' : 'off'

    const normalized = String(value ?? '').trim().toLowerCase()

    if (
        normalized === 'customonly' ||
        normalized === 'custom_only' ||
        normalized === 'only'
    ) {
        return 'customOnly'
    }

    if (
        normalized === 'on' ||
        normalized === 'true' ||
        normalized === '1'
    ) {
        return 'on'
    }

    return 'off'
}

export function normalizeRoundMode(value: unknown): RoundKind {
    const normalized = String(value ?? '').trim().toLowerCase()

    if (
        normalized === 'warmup' ||
        normalized === 'rewind' ||
        normalized === 'freeplay'
    ) {
        return normalized
    }

    return 'tournament'
}

export function parseSettings(
    input: string | URLSearchParams,
    existing?: RoomSettings,
    fallbackHostName?: string,
): RoomSettings | null {
    const p = typeof input === 'string'
        ? new URLSearchParams(input)
        : input

    const type = p.get('type') || existing?.type || DEFAULT_TYPE

    if (!Object.prototype.hasOwnProperty.call(ROOM_TYPES, type)) {
        return null
    }

    const roomType = type as RoomType
    const open = isOpenType(roomType)

    const scoring =
        p.get('scoring') ||
        existing?.scoring ||
        (open ? DEFAULT_OPEN_SCORING : DEFAULT_SCORING)

    const roundMode: RoundKind = existing?.roundMode ?? 'tournament'

    const edition = open
        ? ''
        : (
            p.get('edition') ??
            existing?.edition ??
            ''
        ).trim().toUpperCase()

    const group = (
        p.get('group') ??
        existing?.group ??
        'A'
    ).trim() || 'A'

    const rawTitle = p.has('title')
        ? (p.get('title') ?? '').trim()
        : (existing?.title ?? '').trim()

    const title = roomType === 'casualRoom'
        ? (rawTitle || defaultCustomRoomTitle(fallbackHostName))
        : rawTitle

    const rawVisibility =
        p.get('visibility') ??
        existing?.visibility ??
        null

    const rawTier = (
        p.get('tier') ??
        existing?.tier ??
        'master'
    ).trim().toLowerCase()

    const tier = (RANKED_TIER_NAMES as readonly string[]).includes(rawTier)
        ? rawTier
        : 'master'

    const visibility = roomType === 'rankedRoom'
        ? 'public'
        : roomType === 'casualRoom'
            ? (rawVisibility === 'private' ? 'private' : 'public')
            : (rawVisibility === 'public' ? 'public' : 'locked')

    const random = roomType === 'casualRoom' && (
        p.has('random')
            ? isOn(p.get('random'))
            : Boolean(existing?.random)
    )

    const customSongs: CustomSongsMode = roomType === 'rankedRoom'
        ? normalizeCustomSongsMode(
            p.get('customSongs') ?? existing?.customSongs,
        )
        : 'off'

    const rawVocalType = (
        p.get('vocalType') ??
        existing?.vocalType ??
        'sekai'
    ).trim()

    const vocalType: RankedVocalType =
        rawVocalType === 'sekai'
            ? 'sekai'
            : 'virtualSinger'

    if (!Object.prototype.hasOwnProperty.call(SCORING_MODES, scoring)) {
        return null
    }

    if (roomType === 'groupStage' && group.length > 24) {
        return null
    }

    if (title.length > 48) {
        return null
    }

    return {
        type: roomType,
        edition,
        scoring: roomType === 'rankedRoom'
            ? 'rankedMatch'
            : scoring as ScoringMode,
        roundMode,
        group,
        title,
        visibility,
        random,
        tier,
        customSongs,
        vocalType,
    }
}