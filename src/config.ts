
import type { EditionData, SheetChart } from './sheets.ts'

export const GROUP_ORDER = ['A','B','C','D','E','F','G','H','I','J','K','X','T'] as const

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
} as const

export const TOURNAMENT_HOST_HANDLE = '163292'

export type RoomType = keyof typeof ROOM_TYPES

export const SCORING_MODES = {
    pp: 'PP',
    rankedMatch: 'Ranked Match',
} as const

export type ScoringMode = keyof typeof SCORING_MODES

export const DEFAULT_TYPE: RoomType = 'groupStage'
export const DEFAULT_SCORING: ScoringMode = 'pp'

export const SERVER_TITLE = 'XX! Championship'
export const SERVER_DESCRIPTION = "https://discord.gg/xxsrG9G6f\nAXX!A's server!"

export const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000
export const RESERVED_ROOM_TTL_MS = 5 * 60 * 1000

export function getChartConstant(
    _address: string,
    _name: string,
    _type: 'groupStage' | 'final',
): number | null {
    return null
}

export function getDivision(
    _handle: string,
    _type: 'groupStage' | 'final',
): string | null {
    return null
}

export function getEditionChart(
    edition: EditionData,
    type: 'groupStage' | 'final',
): SheetChart[] {
    return type === 'groupStage'
        ? edition.groupStage
        : edition.final
}