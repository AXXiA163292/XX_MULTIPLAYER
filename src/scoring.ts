import { RANKED_POINTS, type ScoringMode } from './config.ts'
import { calculatePP, formatPP, roundPP, PP_SETTINGS } from './pp.ts'
import type { GameplayResult } from './types.ts'

export const PP_CONFIGURED = true

export type RoundKind = 'tournament' | 'rewind' | 'warmup' | 'freeplay'

export type RoundRecord = {
    level: { address: string; name: string } | null
    levelTitle?: string
    levelTag?: string
    levelRating?: number
    levelConstant?: number
    noteCount?: number
    difficulty?: string
    roundKind?: RoundKind
    roundLabel?: string
    countsTowardScore?: boolean
    isReplay?: boolean
    results: Record<string, GameplayResult>
}

export type Total = {
    userId: string
    score: number
    perfect: number
    bestCombo: number
}

export const isXResult = (r: GameplayResult) =>
    r.disqualified === true || r.grade === 'X'

export const rankedScore = (r: GameplayResult): number =>
    isXResult(r)
        ? 0
        : (Number(r.perfect) || 0) * RANKED_POINTS.perfect +
          (Number(r.great) || 0) * RANKED_POINTS.great +
          (Number(r.good) || 0) * RANKED_POINTS.good

export function ppScore(
    r: GameplayResult,
    round?: RoundRecord,
): number {
    if (!round || isXResult(r)) return 0

    const rating = round.levelConstant ?? round.levelRating
    const noteCount = round.noteCount ?? r.totalCount

    if (
        typeof rating !== 'number' ||
        !Number.isFinite(rating) ||
        rating <= 0 ||
        !Number.isInteger(noteCount) ||
        noteCount <= 0
    ) return 0

    const great = Number(r.great) || 0
    const good = Number(r.good) || 0
    const miss = Number(r.miss) || 0
    const combo = Number(r.combo) || 0

    const value = calculatePP({
        rating,
        noteCount,
        perfect: Math.max(0, noteCount - great - good - miss),
        great,
        good,
        bad: 0,
        miss,
        combo,
        difficulty: round.difficulty ?? round.levelTag ?? 'MASTER',
    }).pp

    return Number.isFinite(value) ? value : 0
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
        Number(isXResult(a)) - Number(isXResult(b)) ||
        (Number(b.perfect) || 0) - (Number(a.perfect) || 0) ||
        (Number(b.combo) || 0) - (Number(a.combo) || 0)
    )
}

function levelKey(level: RoundRecord['level']): string {
    if (!level) return ''
    return `${level.address.replace(/\/+$/, '')}::${level.name}`
}

/**
 * Computes cumulative totals across rounds:
 * - Warmup rounds never add to score.
 * - When a song is played more than once:
 *   - Only the first result counts UNLESS that first result was 0 due to X,
 *     in which case the first non-X result counts instead.
 */
export function totals(
    history: RoundRecord[],
    mode: ScoringMode,
): Total[] {
    const map = new Map<string, Total>()
    const countedSongForUser = new Set<string>()
    const hadFirstXForSongUser = new Set<string>()

    for (const round of history) {
        if (round.roundKind === 'warmup' || round.countsTowardScore === false) {
            continue
        }

        const songKey = levelKey(round.level) || round.levelTitle || 'unknown'

        for (const [userId, result] of Object.entries(round.results)) {
            const total = map.get(userId) ?? {
                userId,
                score: 0,
                perfect: 0,
                bestCombo: 0,
            }
            map.set(userId, total)

            const pairKey = `${userId}::${songKey}`
            const isX = isXResult(result)
            const rawPoints = roundScore(result, mode, round)
            const added = mode === 'pp' ? roundPP(rawPoints) : rawPoints
            const validPoints = !isX && Number.isFinite(added) ? added : 0

            if (!countedSongForUser.has(pairKey)) {
                if (isX || validPoints === 0) {
                    hadFirstXForSongUser.add(pairKey)
                } else {
                    total.score += validPoints
                    total.perfect += Number(result.perfect) || 0
                    total.bestCombo = Math.max(total.bestCombo, Number(result.combo) || 0)
                    countedSongForUser.add(pairKey)
                }
            } else if (hadFirstXForSongUser.has(pairKey) && !isX && validPoints > 0) {
                total.score += validPoints
                total.perfect += Number(result.perfect) || 0
                total.bestCombo = Math.max(total.bestCombo, Number(result.combo) || 0)
                countedSongForUser.add(pairKey)
                hadFirstXForSongUser.delete(pairKey)
            }
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
    _mode: ScoringMode,
) => `${Math.round(Number.isFinite(n) ? n : 0)}`

export function fmtDetail(
    result: GameplayResult,
    mode: ScoringMode,
    round?: RoundRecord,
): string {
    const great = Number(result.great) || 0
    const good = Number(result.good) || 0
    const miss = Number(result.miss) || 0
    const combo = Number(result.combo) || 0

    if (isXResult(result)) {
        const zeroLabel = mode === 'pp' ? formatPP(0) : '0'
        return `${zeroLabel} | X • ${combo}x (${great}/${good}/${miss})`
    }

    const score = roundScore(result, mode, round)

    const grade = result.grade === 'allPerfect'
        ? 'AP'
        : result.grade === 'fullCombo'
            ? 'FC'
            : mode === 'pp'
                ? miss > PP_SETTINGS.skill.failedMissThreshold
                    ? 'F'
                    : 'P'
                : result.grade === 'pass'
                    ? 'P'
                    : 'F'

    const formattedScore = mode === 'pp'
        ? formatPP(score)
        : `${score}`

    return `${formattedScore} | ${grade} • ${combo}x (${great}/${good}/${miss})`
}