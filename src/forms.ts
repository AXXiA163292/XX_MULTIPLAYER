import type { RoundKind } from './scoring.ts'

export type RoomType = 'groupStage' | 'final' | 'casualRoom' | 'rankedRoom'
export type ScoringMode = 'pp' | 'rankedMatch'
export type RoomAccess = 'public' | 'private' | 'locked'
export type CustomSongsMode = 'off' | 'on' | 'customOnly'

export type RoomSettings = {
    type: RoomType
    scoring: ScoringMode
    roundMode: RoundKind
    group: string
    title: string
    visibility: RoomAccess
    random: boolean
    tier: string
    customSongs: CustomSongsMode
}

export const defaultCustomRoomTitle = (hostName?: string): string => {
    const clean = String(hostName ?? '').trim()
    return clean ? `${clean}'s Room` : 'Custom Room'
}

export function normalizeRoundMode(raw: unknown): RoundKind {
    if (raw === 'warmup' || raw === 'freeplay' || raw === 'rewind' || raw === 'tournament') {
        return raw
    }
    return 'tournament'
}

export function normalizeCustomSongsMode(raw: unknown): CustomSongsMode {
    if (raw === 'on' || raw === 'customOnly' || raw === 'off') {
        return raw
    }
    if (raw === true || raw === 'true' || raw === '1') return 'on'
    return 'off'
}

const VALID_TIERS = new Set([
    'master',
    'diamond',
    'platinum',
    'gold',
    'silver',
    'bronze',
    'beginner',
])

const tierOption = {
    query: 'tier',
    name: 'Tier',
    description: 'Pick the rank of this room.',
    required: false,
    type: 'select' as const,
    def: 'master',
    values: [
        { name: 'MASTER', title: 'MASTER' },
        { name: 'DIAMOND', title: 'DIAMOND' },
        { name: 'PLATINUM', title: 'PLATINUM' },
        { name: 'GOLD', title: 'GOLD' },
        { name: 'SILVER', title: 'SILVER' },
        { name: 'BRONZE', title: 'BRONZE' },
        { name: 'BEGINNER', title: 'BEGINNER' },
    ],
}

const customSongsOption = {
    query: 'customSongs',
    name: 'Custom songs',
    description: 'Include custom charts in ranked pool.',
    required: false,
    type: 'select' as const,
    def: 'off',
    values: [
        { name: 'off', title: 'Off' },
        { name: 'on', title: 'On' },
        { name: 'customOnly', title: 'Custom only' },
    ],
}

const scoringOption = {
    query: 'scoring',
    name: 'Scoring',
    description: 'Select room scoring system.',
    required: false,
    type: 'select' as const,
    def: 'pp',
    values: [
        { name: 'pp', title: 'PP' },
        { name: 'rankedMatch', title: 'Ranked Match' },
    ],
}

const accessOption = {
    query: 'visibility',
    name: 'Access',
    description: 'Control who can join.',
    required: false,
    type: 'select' as const,
    def: 'public',
    values: [
        { name: 'public', title: 'Public' },
        { name: 'private', title: 'Private' },
        { name: 'locked', title: 'Locked' },
    ],
}

const randomOption = {
    query: 'random',
    name: 'Random song',
    description: 'Pick a song randomly.',
    required: false,
    type: 'toggle' as const,
    def: false,
}

const titleOption = {
    query: 'title',
    name: 'Room title',
    description: 'Custom room name.',
    required: false,
    type: 'text' as const,
    def: '',
    placeholder: 'Enter room title',
    limit: 60,
    shortcuts: [],
}

const groupOption = {
    query: 'group',
    name: 'Group',
    description: 'Tournament group letter.',
    required: false,
    type: 'text' as const,
    def: 'A',
    placeholder: 'A',
    limit: 8,
    shortcuts: [],
}

export const closeRoomForm = {
    name: 'closeRoom',
    type: 'closeRoom',
    title: 'Close Room',
    icon: 'delete',
    requireConfirmation: true,
    options: [],
}

export function roomForms(isTournamentHost: boolean) {
    const forms: any[] = [
        {
            name: 'rankedRoom',
            type: 'rankedRoom',
            title: 'Create Ranked Room',
            requireConfirmation: false,
            options: [tierOption, customSongsOption],
        },
        {
            name: 'casualRoom',
            type: 'casualRoom',
            title: 'Create Casual Room',
            requireConfirmation: false,
            options: [titleOption, scoringOption, accessOption, randomOption],
        },
    ]

    if (isTournamentHost) {
        forms.push(
            {
                name: 'groupStage',
                type: 'groupStage',
                title: 'Create Group Stage Room',
                requireConfirmation: false,
                options: [groupOption, scoringOption, accessOption, randomOption],
            },
            {
                name: 'final',
                type: 'final',
                title: 'Create Final Room',
                requireConfirmation: false,
                options: [scoringOption, accessOption, randomOption],
            },
        )
    }

    return forms
}

export function roomFormsForType(
    type: RoomType,
    isTournamentHost: boolean,
    isExistingRoom = false,
) {
    if (type === 'rankedRoom') {
        return [
            {
                name: 'rankedRoom',
                type: 'rankedRoom',
                title: isExistingRoom ? 'Ranked Settings' : 'Create Ranked Room',
                requireConfirmation: false,
                options: isExistingRoom
                    ? [customSongsOption]
                    : [tierOption, customSongsOption],
            },
        ]
    }

    if (type === 'casualRoom') {
        return [
            {
                name: 'casualRoom',
                type: 'casualRoom',
                title: 'Casual Settings',
                requireConfirmation: false,
                options: [titleOption, scoringOption, accessOption, randomOption],
            },
        ]
    }

    if (!isTournamentHost) {
        return []
    }

    if (type === 'groupStage') {
        return [
            {
                name: 'groupStage',
                type: 'groupStage',
                title: 'Group Stage Settings',
                requireConfirmation: false,
                options: [groupOption, scoringOption, accessOption, randomOption],
            },
        ]
    }

    return [
        {
            name: 'final',
            type: 'final',
            title: 'Final Settings',
            requireConfirmation: false,
            options: [scoringOption, accessOption, randomOption],
        },
    ]
}

export function parseSettings(
    raw: string | URLSearchParams,
    fallback?: Partial<RoomSettings>,
    hostName?: string,
): RoomSettings | null {
    const params = typeof raw === 'string' ? new URLSearchParams(raw) : raw

    const rawType = params.get('type') ?? fallback?.type
    if (
        rawType !== 'groupStage' &&
        rawType !== 'final' &&
        rawType !== 'casualRoom' &&
        rawType !== 'rankedRoom'
    ) {
        return null
    }

    const type: RoomType = rawType

    const rawTier = String(params.get('tier') ?? fallback?.tier ?? 'master').trim().toLowerCase()
    const tier = VALID_TIERS.has(rawTier) ? rawTier : 'master'

    const customSongs = normalizeCustomSongsMode(
        params.get('customSongs') ?? fallback?.customSongs ?? 'off',
    )

    const rawScoring = params.get('scoring') ?? fallback?.scoring
    const scoring: ScoringMode = type === 'rankedRoom'
        ? 'rankedMatch'
        : rawScoring === 'rankedMatch' || rawScoring === 'pp'
            ? rawScoring
            : 'pp'

    const rawVis = params.get('visibility') ?? fallback?.visibility
    const visibility: RoomAccess = type === 'rankedRoom'
        ? 'public'
        : rawVis === 'public' || rawVis === 'private' || rawVis === 'locked'
            ? rawVis
            : type === 'casualRoom'
                ? 'public'
                : 'locked'

    const rawRandom = params.get('random')
    const random = type === 'rankedRoom'
        ? false
        : rawRandom !== null
            ? rawRandom === 'true' || rawRandom === '1'
            : Boolean(fallback?.random)

    const group = String(params.get('group') ?? fallback?.group ?? 'A').trim().slice(0, 8) || 'A'
    const title = type === 'casualRoom'
        ? (String(params.get('title') ?? fallback?.title ?? '').trim().slice(0, 60) || defaultCustomRoomTitle(hostName))
        : String(params.get('title') ?? fallback?.title ?? '').trim().slice(0, 60)

    return {
        type,
        scoring,
        roundMode: normalizeRoundMode(fallback?.roundMode ?? 'tournament'),
        group,
        title,
        visibility,
        random,
        tier,
        customSongs,
    }
}

export function serializeSettings(settings: RoomSettings): string {
    const params = new URLSearchParams()
    params.set('type', settings.type)
    params.set('tier', settings.tier)
    params.set('customSongs', settings.customSongs)
    params.set('scoring', settings.scoring)
    params.set('visibility', settings.visibility)
    params.set('random', settings.random ? 'true' : 'false')
    if (settings.group) params.set('group', settings.group)
    if (settings.title) params.set('title', settings.title)
    return params.toString()
}
