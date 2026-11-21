
import { RANKED_POINTS, type ScoringMode } from './config.ts'
import { calculatePP, formatPP, roundPP } from './pp.ts'
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
    r.perfect * RANKED_POINTS.perfect +
    r.great * RANKED_POINTS.great +
    r.good * RANKED_POINTS.good

export function ppScore(
    r: GameplayResult,
    round?: RoundRecord,
): number {
    if (!round) return 0

    const rating = round.levelConstant ?? round.levelRating
    const noteCount = round.noteCount

    if (!rating || !noteCount) return 0

    const bad = Math.max(
        0,
        noteCount - r.perfect - r.great - r.good - r.miss,
    )

    return calculatePP({
        rating,
        noteCount,
        perfect: r.perfect,
        great: r.great,
        good: r.good,
        bad,
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
) =>
    mode === 'pp'
        ? formatPP(n)
        : `${n} pts`

export function fmtDetail(
    result: GameplayResult,
    mode: ScoringMode,
    round?: RoundRecord,
): string {
    const score = roundScore(result, mode, round)

    return mode === 'pp'
        ? `${formatPP(score)} | P ${result.perfect} · Gr ${result.great} · Gd ${result.good} · M ${result.miss} | ${result.combo}x`
        : `${fmtScore(score, mode)} | P ${result.perfect} · Gr ${result.great} · Gd ${result.good} · M ${result.miss} | ${result.combo}x`
}