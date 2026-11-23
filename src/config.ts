import type { EditionData, SheetChart } from './sheets.ts'

export const GROUP_ORDER = [
    'A', 'B', 'C', 'D', 'E', 'F', 'G',
    'H', 'I', 'J', 'K', 'X', 'T',
] as const

export type GroupName = typeof GROUP_ORDER[number]
export type BracketName = 'Upper Bracket' | 'Lower Bracket'

export type SongPoolChart = {
    url: string | null
    constant: number | null
}

export type EditionComposition = {
    groupStage: {
        groups: Record<GroupName, string[]>
    }
    final: {
        brackets: {
            upperBracket: string[]
            lowerBracket: string[]
        }
    }
}

export type Edition = {
    groupStage: (SongPoolChart | null)[]
    final: (SongPoolChart | null)[]
    composition: EditionComposition
}

export const ACTIVE_EDITION = 'CURRENT EDITION'
export const EDITIONS: Record<string, Edition> = {}

export const RANKED_POINTS = {
    perfect: 3,
    great: 2,
    good: 1,
} as const

export const ROOM_TYPES = {
    groupStage: 'Group Stage',
    final: 'Final',
    casualRoom: 'Custom Room',
    rankedRoom: 'Ranked Match',
} as const

export const RANKED_TIER_NAMES = [
    'master',
    'diamond',
    'platinum',
    'gold',
    'silver',
    'bronze',
    'beginner',
] as const

export const RANKED_MIN_RATING = 18
export const RANKED_MAX_RATING = 39

export const RANKED_ALLOWED_DIFFICULTIES = new Set([
    'HARD',
    'EXPERT',
    'MASTER',
    'APPEND',
])

export const TOURNAMENT_HOST_HANDLE = '163292'

export const STAFF_CHAT_HANDLES = [
    '163292',
    '283420',
    '3227470',
] as const

export const STAFF_CHAT_SHORTCUTS = [
    '@Bell',
    '@Noct',
    '@Ʌstra',
] as const

export const SCOREBOARD_PUBLIC = true

export type RoomType = keyof typeof ROOM_TYPES

export const SCORING_MODES = {
    pp: 'PP',
    rankedMatch: 'Ranked Match',
} as const

export type ScoringMode = keyof typeof SCORING_MODES

export const DEFAULT_TYPE: RoomType = 'groupStage'
export const DEFAULT_SCORING: ScoringMode = 'pp'
export const DEFAULT_OPEN_SCORING: ScoringMode = 'rankedMatch'

export const SERVER_TITLE = 'XX!'
export const SERVER_DESCRIPTION = "https://discord.gg/xxsrG9G6f\n\nAXX!A's server!"

/** Maximum room lifespan is 3 minutes. */
export const MAX_ROOM_LIFESPAN_MS = 3 * 60 * 1000
export const EMPTY_ROOM_TTL_MS = 3 * 60 * 1000
export const RESERVED_ROOM_TTL_MS = 3 * 60 * 1000

let sheetDivisions: Record<string, string> = {}

export function setSheetDivisions(
    divisions: Record<string, string>,
): void {
    sheetDivisions = { ...divisions }
}

export function getChartConstant(
    _address: string,
    _name: string,
    _type: 'groupStage' | 'final',
): number | null {
    return null
}

export function getDivision(
    handle: string,
    type: 'groupStage' | 'final',
): string | null {
    const division = sheetDivisions[handle]

    if (!division) return null

    if (type === 'groupStage') {
        return division.startsWith('Group ')
            ? division
            : null
    }

    return division === 'Upper Bracket' ||
        division === 'Lower Bracket'
        ? division
        : null
}

export function getEditionChart(
    edition: EditionData,
    type: 'groupStage' | 'final',
): SheetChart[] {
    return type === 'groupStage'
        ? edition.groupStage
        : edition.final
}
