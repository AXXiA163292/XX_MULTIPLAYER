
import { RANKED_POINTS, type ScoringMode } from './config.ts'
import { calculatePP, formatPP, roundPP, PP_SETTINGS } from './pp.ts'
import type { GameplayResult } from './types.ts'

export const PP_CONFIGURED = true

export type RoundRecord = {
    level: { address: string; name: string } | null
    levelTitle?: string
    levelTag?: string
    levelRating?: number
    levelConstant?: number
    noteCount?: number
    difficulty?: string
    results: Record<string, GameplayResult>
}

export type Total = {
    userId: string
    score: number
    perfect: number
    bestCombo: number
}

export const rankedScore = (r: GameplayResult): number =>
    r.grade === 'X'
        ? 0
        : r.perfect * RANKED_POINTS.perfect +
          r.great * RANKED_POINTS.great +
          r.good * RANKED_POINTS.good

export function ppScore(
    r: GameplayResult,
    round?: RoundRecord,
): number {
    if (!round || r.grade === 'X') return 0

    const rating = round.levelConstant ?? round.levelRating
    const noteCount = round.noteCount ?? r.totalCount

    if (
        typeof rating !== 'number' ||
        !Number.isFinite(rating) ||
        rating <= 0 ||
        !Number.isInteger(noteCount) ||
        noteCount <= 0
    ) return 0

    return calculatePP({
        rating,
        noteCount,
        perfect: noteCount - r.great - r.good - r.miss,
        great: r.great,
        good: r.good,
        bad: 0,
        miss: r.miss,
        combo: r.combo,
        difficulty: round.difficulty ?? round.levelTag ?? 'MASTER',
    }).pp
}

export const roundScore = (
    r: GameplayResult,
    mode: ScoringMode,
    round?: RoundRecord,
): number =>
    mode === 'pp'
        ? ppScore(r, round)
        : rankedScore(r)

export function compareResults(
    a: GameplayResult,
    b: GameplayResult,
    mode: ScoringMode,
    round?: RoundRecord,
): number {
    return (
        roundScore(b, mode, round) -
        roundScore(a, mode, round) ||
        b.perfect - a.perfect ||
        b.combo - a.combo
    )
}

export function totals(
    history: RoundRecord[],
    mode: ScoringMode,
): Total[] {
    const map = new Map<string, Total>()

    for (const round of history) {
        for (const [userId, result] of Object.entries(round.results)) {
            if (result.grade === 'X') continue

            const total = map.get(userId) ?? {
                userId,
                score: 0,
                perfect: 0,
                bestCombo: 0,
            }

            total.score += mode === 'pp'
                ? roundPP(ppScore(result, round))
                : rankedScore(result)

            total.perfect += result.perfect
            total.bestCombo = Math.max(total.bestCombo, result.combo)

            map.set(userId, total)
        }
    }

    return [...map.values()].sort(
        (a, b) =>
            b.score - a.score ||
            b.perfect - a.perfect ||
            b.bestCombo - a.bestCombo,
    )
}

export const fmtScore = (
    n: number,
    mode: ScoringMode,
) => `${Math.round(n)}`

export function fmtDetail(
    result: GameplayResult,
    mode: ScoringMode,
    round?: RoundRecord,
): string {
    if (result.grade === 'X') return 'X'

    const score = roundScore(result, mode, round)

    const grade = result.grade === 'allPerfect'
        ? 'AP'
        : result.grade === 'fullCombo'
            ? 'FC'
            : mode === 'pp'
                ? result.miss > PP_SETTINGS.skill.failedMissThreshold
                    ? 'F'
                    : 'P'
                : result.grade === 'pass'
                    ? 'P'
                    : 'F'

    const formattedScore = mode === 'pp'
        ? formatPP(score)
        : `${score}`

    return `${formattedScore} | ${grade} • ${result.combo}x (${result.great}/${result.good}/${result.miss})`
}