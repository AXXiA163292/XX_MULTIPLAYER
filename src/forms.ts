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

const SEASON_RANK: Record<string, number> = {
    WINTER: 1,
    SPRING: 2,
    SUMMER: 3,
    FALL: 4,
}

export const SEASONAL_EDITION_RE = /^(WINTER|SPRING|SUMMER|FALL)\s+(\d{4})$/
export const ULTIMATE_EDITION_RE = /^ULTIMATE\s+(\d{4})$/
export const ANY_EDITION_RE = /^(WINTER|SPRING|SUMMER|FALL|ULTIMATE)\s+(\d{4})$/

export function isUltimateEdition(edition: string): boolean {
    return ULTIMATE_EDITION_RE.test(edition.trim().toUpperCase())
}

function editionTimestamp(edition: string, now = new Date()): number {
    const clean = edition.trim().toUpperCase()
    const seasonal = clean.match(SEASONAL_EDITION_RE)
    if (seasonal) {
        const season = seasonal[1]!
        const year = Number(seasonal[2]!)
        const monthBySeason: Record<string, number> = {
            WINTER: 0,
            SPRING: 3,
            SUMMER: 6,
            FALL: 9,
        }
        return Date.UTC(year, monthBySeason[season] ?? 0, 1)
    }

    const ultimate = clean.match(ULTIMATE_EDITION_RE)
    if (ultimate) {
        const year = Number(ultimate[1]!)
        return Date.UTC(year, 10, 25)
    }

    return now.getTime()
}

export function pickClosestEdition(
    candidates: string[],
    now = new Date(),
): string {
    if (candidates.length === 0) return ''
    const targetMs = now.getTime()

    return [...candidates].sort((a, b) => {
        const diffA = Math.abs(editionTimestamp(a, now) - targetMs)
        const diffB = Math.abs(editionTimestamp(b, now) - targetMs)
        if (diffA !== diffB) return diffA - diffB

        const matchA = a.match(SEASONAL_EDITION_RE)
        const matchB = b.match(SEASONAL_EDITION_RE)
        if (matchA && matchB) {
            const yearDiff = Number(matchB[2]) - Number(matchA[2])
            if (yearDiff !== 0) return yearDiff
            return (SEASON_RANK[matchB[1]!] ?? 0) - (SEASON_RANK[matchA[1]!] ?? 0)
        }
        return b.localeCompare(a)
    })[0]!
}

export function resolvePreselectedEdition(
    availableEditions: string[],
    currentEdition?: string,
    now = new Date(),
): string {
    const editions = normalizeEditionsList(availableEditions)
    if (editions.length === 0) return ''

    const cleanCurrent = String(currentEdition ?? '').trim().toUpperCase()
    if (cleanCurrent && editions.includes(cleanCurrent)) {
        return cleanCurrent
    }

    return pickClosestEdition(editions, now)
}

export function normalizeEditionsList(availableEditions: string[]): string[] {
    return [
        ...new Set(
            availableEditions
                .map((edition) => String(edition).trim().toUpperCase())
                .filter((edition) => ANY_EDITION_RE.test(edition)),
        ),
    ]
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

const editionOption = (editions: string[], defaultEdition?: string) => ({
    query: 'edition',
    name: 'Edition',
    required: false,
    type: 'select' as const,
    def: defaultEdition && editions.includes(defaultEdition)
        ? defaultEdition
        : pickClosestEdition(editions) || editions[0] || '',
    values: editions.map((edition) => ({
        name: edition,
        title: edition,
    })),
})

const groupOption = {
    query: 'group',
    name: 'Group',
    required: false,
    type: 'text' as const,
    def: '',
    placeholder: '',
    limit: 24,
    shortcuts: [],
}

const titleOption = {
    query: 'title',
    name: 'Room title',
    required: false,
    type: 'text' as const,
    def: '',
    placeholder: '',
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

export const isOpenType = (type: RoomType) =>
    type === 'casualRoom' || type === 'rankedRoom'

export const roomForms = (
    isTournamentHost = false,
    availableEditions: string[] = [],
    currentEdition?: string,
) => {
    const editions = normalizeEditionsList(availableEditions)
    const defaultEdition = resolvePreselectedEdition(editions, currentEdition)

    return (Object.keys(ROOM_TYPES) as RoomType[])
        .filter((type) => isTournamentHost || isOpenType(type))
        .map((type) => ({
            type,
            title: ROOM_TYPES[type],
            requireConfirmation: false,
            options: type === 'tournament'
                ? [
                    editionOption(editions, defaultEdition),
                    groupOption,
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

/**
 * Inside an already-opened room:
 * - Only Room access can be edited for tournament / casualRoom
 * - On rankedRoom, no option forms are shown (only closeRoomForm for the host)
 */
export const roomFormsForType = (
    type: RoomType,
    isTournamentHost = false,
    availableEditions: string[] = [],
) => {
    if (type === 'rankedRoom') {
        return []
    }

    return roomForms(isTournamentHost, availableEditions)
        .filter((form) => form.type === type)
        .map((form) => ({
            ...form,
            options: type === 'tournament'
                ? [tournamentVisibilityOption]
                : type === 'casualRoom'
                    ? [customVisibilityOption]
                    : [],
        }))
}

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
        values.push(`group=${encodeURIComponent(s.group || '')}`)
    }

    if (s.type === 'casualRoom') {
        values.push(`title=${encodeURIComponent(s.title || '')}`)
        values.push(`random=${s.random ? '1' : '0'}`)
    }

    if (s.type === 'rankedRoom') {
        values.push(`tier=${encodeURIComponent(s.tier || 'master')}`)
        values.push(`customSongs=${encodeURIComponent(s.customSongs || 'off')}`)
        values.push(`vocalType=${encodeURIComponent(s.vocalType || 'sekai')}`)
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

    const rawType = p.get('type') || existing?.type || DEFAULT_TYPE
    const type =
        rawType === 'groupStage' || rawType === 'final' || rawType === 'ultimateEdition'
            ? 'tournament'
            : rawType

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
        ).trim().replace(/\s+/g, ' ').toUpperCase()

    if (!open && edition && !ANY_EDITION_RE.test(edition)) {
        return null
    }

    const group = open
        ? ''
        : (
            p.has('group')
                ? (p.get('group') ?? '')
                : (existing?.group ?? '')
        ).trim()

    if (!open && group.length > 24) {
        return null
    }

    if (!open && isUltimateEdition(edition) && group.length > 0) {
        return null
    }

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