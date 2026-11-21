
// ============================================================
// EDITION CONFIGURATION
// Change this section when preparing a new championship.
// ============================================================

export const ACTIVE_EDITION = 'WINTER 2027'

export const GROUP_ORDER = ['A','B','C','D','E','F','G','H','I','J','K','X','T'] as const

export type GroupName = typeof GROUP_ORDER[number]
export type BracketName = 'Upper Bracket' | 'Lower Bracket'

export type SongPoolChart = {
    url: string
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

// ------------------------------------------------------------
// WINTER 2027
// ------------------------------------------------------------

export const EDITIONS: Record<string, Edition> = {
    'WINTER 2027': {

        // GROUP STAGE
        // Six song slots. Use null for an empty slot.
        groupStage: [
            null,
            null,
            null,
            null,
            null,
            {
                url: 'https://untitledcharts.com/levels/UnCh-3d7bd1a1a8c14f058b4e56d45e315c32',
                constant: null,
            },
        ],

        // FINAL
        // Four song slots. Use null for an empty slot.
        final: [
            null,
            {
                url: 'https://untitledcharts.com/levels/UnCh-27582388d8bc42b0b6afcc12faf8871b',
                constant: 33.0,
            },
            null,
            null,
        ],

        // PLAYER ASSIGNMENTS
        composition: {
            groupStage: {
                groups: {
                    A: [],
                    B: [],
                    C: [],
                    D: [],
                    E: [],
                    F: [],
                    G: [],
                    H: [],
                    I: [],
                    J: [],
                    K: [],
                    X: [],
                    T: [],
                },
            },

            final: {
                brackets: {
                    upperBracket: [],
                    lowerBracket: [],
                },
            },
        },
    },
}

// ============================================================
// SCORING AND ROOM SETTINGS
// ============================================================

/** Points per judgment for Ranked Match. */
export const RANKED_POINTS = {
    perfect: 3,
    great: 2,
    good: 1,
} as const

export const ROOM_TYPES = {
    groupStage: 'Group Stage',
    final: 'Final',
} as const

export type RoomType = keyof typeof ROOM_TYPES

export const SCORING_MODES = {
    rankedMatch: 'Ranked Match',
    pp: 'PP',
} as const

export type ScoringMode = keyof typeof SCORING_MODES

export const DEFAULT_TYPE: RoomType = 'groupStage'
export const DEFAULT_SCORING: ScoringMode = 'rankedMatch'

export const SERVER_TITLE = 'XX! Championship'
export const SERVER_DESCRIPTION = ACTIVE_EDITION

/** Empty rooms are deleted after this long. */
export const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000

/** Reserved rooms that are never joined are deleted after this long. */
export const RESERVED_ROOM_TTL_MS = 5 * 60 * 1000

// ============================================================
// CONFIGURATION HELPERS
// ============================================================

export function getChartConstant(
    address: string,
    name: string,
    type: 'groupStage' | 'final',
): number | null {
    const edition = EDITIONS[ACTIVE_EDITION]

    const charts = type === 'groupStage'
        ? edition.groupStage
        : edition.final

    const target = `${address.replace(/\/+$/, '')}/levels/${name}`

    for (const chart of charts) {
        if (!chart) continue

        try {
            const url = new URL(chart.url)

            const id = decodeURIComponent(
                url.pathname.match(/^\/levels\/([^/]+)\/?$/)?.[1] ?? '',
            )

            if (`${url.origin}/levels/${id}` === target) {
                return chart.constant
            }
        } catch {
            continue
        }
    }

    return null
}

export function getDivision(
    handle: string,
    type: 'groupStage' | 'final',
): string | null {
    const composition = EDITIONS[ACTIVE_EDITION]?.composition

    if (!composition) return null

    if (type === 'groupStage') {
        for (const group of GROUP_ORDER) {
            if (composition.groupStage.groups[group].includes(handle)) {
                return `Group ${group}`
            }
        }

        return null
    }

    if (composition.final.brackets.upperBracket.includes(handle)) {
        return 'Upper Bracket'
    }

    if (composition.final.brackets.lowerBracket.includes(handle)) {
        return 'Lower Bracket'
    }

    return null
}