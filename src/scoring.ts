import type { ScoringMode } from './config.ts'
import type { GameplayResult, Sil } from './types.ts'

export type RoundKind = 'tournament' | 'warmup' | 'rewind' | 'freeplay'

export type RoundRecord = {
    level: Sil | null
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
    rewindEligibleUserIds?: string[]
    results: Record<string, GameplayResult>
}

export const PP_CONFIGURED = true

export function isPlayerX(result: GameplayResult | undefined): boolean {
    if (!result) return false
    return result.disqualified === true || (result.grade as string) === 'X'
}

export function roundPoints(
    result: GameplayResult | undefined,
    mode: ScoringMode,
    round?: Pick<RoundRecord, 'levelConstant' | 'levelRating' | 'noteCount'>,
): number {
    if (!result || isPlayerX(result)) return 0

    if (mode === 'rankedMatch') {
        const p = Number(result.perfect) || 0
        const g = Number(result.great) || 0
        const gd = Number(result.good) || 0
        return p * 3 + g * 2 + gd
    }

    const baseConstant =
        typeof round?.levelConstant === 'number' && Number.isFinite(round.levelConstant) && round.levelConstant > 0
            ? round.levelConstant
            : typeof round?.levelRating === 'number' && Number.isFinite(round.levelRating) && round.levelRating > 0
                ? round.levelRating
                : 30

    const totalNotes = Math.max(
        1,
        Number(round?.noteCount) ||
            (Number(result.perfect) || 0) +
                (Number(result.great) || 0) +
                (Number(result.good) || 0) +
                (Number(result.miss) || 0),
    )

    const p = Number(result.perfect) || 0
    const g = Number(result.great) || 0
    const gd = Number(result.good) || 0
    const weightedNotes = p + g * 0.7 + gd * 0.3
    const accuracyRatio = Math.max(0, Math.min(1, weightedNotes / totalNotes))

    const gradeBonus =
        result.grade === 'allPerfect' ? 1.05 :
        result.grade === 'fullCombo' ? 1.02 :
        1.0

    const rawPp = baseConstant * Math.pow(accuracyRatio, 2) * gradeBonus * 10
    return Math.ceil(rawPp)
}

export function fmtScore(score: number, mode: ScoringMode): string {
    const safe = Number.isFinite(score) ? score : 0
    return mode === 'rankedMatch' ? `${Math.round(safe)} pts` : `${Math.ceil(safe)} PP`
}

export function fmtDetail(
    result: GameplayResult,
    mode: ScoringMode,
    round?: Pick<RoundRecord, 'levelConstant' | 'levelRating' | 'noteCount'>,
): string {
    const pts = roundPoints(result, mode, round)
    const gradeTag = isPlayerX(result) ? 'X' : result.grade.toUpperCase()
    const combo = Number(result.combo) || 0
    return `${gradeTag} · ${fmtScore(pts, mode)} · ${combo}c`
}

export function compareResults(
    a: GameplayResult,
    b: GameplayResult,
    mode: ScoringMode,
    round?: Pick<RoundRecord, 'levelConstant' | 'levelRating' | 'noteCount'>,
): number {
    const ptsDiff = roundPoints(b, mode, round) - roundPoints(a, mode, round)
    if (ptsDiff !== 0) return ptsDiff

    const perfDiff = (Number(b.perfect) || 0) - (Number(a.perfect) || 0)
    if (perfDiff !== 0) return perfDiff

    return (Number(b.combo) || 0) - (Number(a.combo) || 0)
}

export function totals(
    history: RoundRecord[],
    mode: ScoringMode,
): { userId: string; score: number }[] {
    const map = new Map<string, number>()
    const scoredRewindKeys = new Set<string>()

    for (let i = 0; i < history.length; i++) {
        const rec = history[i]!
        const kind: RoundKind = rec.roundKind ?? 'tournament'
        const songKey = rec.level
            ? `${rec.level.address.replace(/\/+$/, '').toLowerCase()}::${rec.level.name.trim().toLowerCase()}`
            : ''

        const priorEligible = new Set<string>(rec.rewindEligibleUserIds ?? [])
        if (kind === 'rewind' && priorEligible.size === 0 && songKey) {
            for (let j = i - 1; j >= 0; j--) {
                const prev = history[j]!
                const prevKey = prev.level
                    ? `${prev.level.address.replace(/\/+$/, '').toLowerCase()}::${prev.level.name.trim().toLowerCase()}`
                    : ''
                if (prevKey === songKey) {
                    for (const [uid, res] of Object.entries(prev.results ?? {})) {
                        if (isPlayerX(res)) priorEligible.add(uid)
                    }
                    break
                }
            }
        }

        for (const [userId, res] of Object.entries(rec.results ?? {})) {
            map.set(userId, map.get(userId) ?? 0)

            if (kind === 'warmup' || kind === 'freeplay') {
                continue
            }

            if (kind === 'tournament') {
                map.set(userId, (map.get(userId) ?? 0) + roundPoints(res, mode, rec))
                continue
            }

            if (kind === 'rewind') {
                const claimKey = `${songKey}::${userId}`
                if (priorEligible.has(userId) && !isPlayerX(res) && !scoredRewindKeys.has(claimKey)) {
                    scoredRewindKeys.add(claimKey)
                    map.set(userId, (map.get(userId) ?? 0) + roundPoints(res, mode, rec))
                }
            }
        }
    }

    return [...map.entries()]
        .map(([userId, score]) => ({ userId, score }))
        .sort((a, b) => b.score - a.score)
}