import { RANKED_POINTS, type ScoringMode } from './config.ts'
import type { GameplayResult } from './types.ts'

export const rankedScore = (r: GameplayResult): number =>
    r.perfect * RANKED_POINTS.perfect + r.great * RANKED_POINTS.great + r.good * RANKED_POINTS.good

/**
 * PP is not defined yet. Plug the formula in here when it exists.
 * Until then every result is worth 0 PP and ties fall through to the tiebreakers.
 */
export const PP_CONFIGURED = false
export const ppScore = (_r: GameplayResult): number => 0

export const roundScore = (r: GameplayResult, mode: ScoringMode): number =>
    mode === 'pp' ? ppScore(r) : rankedScore(r)

/** Tiebreakers are fixed: 1) more perfects, 2) higher combo. Highest first. */
export function compareResults(a: GameplayResult, b: GameplayResult, mode: ScoringMode): number {
    return (
        roundScore(b, mode) - roundScore(a, mode) ||
        b.perfect - a.perfect ||
        b.combo - a.combo
    )
}

export type RoundRecord = {
    level: { address: string; name: string } | null
    levelTitle?: string
    levelTag?: string
    levelRating?: number
    results: Record<string, GameplayResult>
}

export type Total = { userId: string; score: number; perfect: number; bestCombo: number }

export function totals(history: RoundRecord[], mode: ScoringMode): Total[] {
    const map = new Map<string, Total>()
    for (const round of history) {
        for (const [userId, r] of Object.entries(round.results)) {
            const t = map.get(userId) ?? { userId, score: 0, perfect: 0, bestCombo: 0 }
            t.score += roundScore(r, mode)
            t.perfect += r.perfect
            t.bestCombo = Math.max(t.bestCombo, r.combo)
            map.set(userId, t)
        }
    }
    return [...map.values()].sort((a, b) => b.score - a.score || b.perfect - a.perfect || b.bestCombo - a.bestCombo)
}

export const fmtScore = (n: number, mode: ScoringMode) => (mode === 'pp' ? `${n.toFixed(2)} pp` : `${n} pts`)

export const fmtDetail = (r: GameplayResult, mode: ScoringMode) =>
    `${fmtScore(roundScore(r, mode), mode)} | P ${r.perfect} · Gr ${r.great} · Gd ${r.good} · M ${r.miss} | ${r.combo}x`
