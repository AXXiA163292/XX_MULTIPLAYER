import type { GameplayResult, MatchMode, RoomMember } from './types.ts'

export type RoundKind = 'tournament' | 'warmup' | 'rewind' | 'freeplay'

export type RoundRecord = {
    round: number
    levelTitle: string
    results: {
        handle: string
        name: string
        score: number
        accuracy: number
        combo: number
        grade: GameplayResult['grade']
        pp: number
        ratingDelta: number
    }[]
}

export function calculateRatingDelta(
    ratingA: number,
    ratingB: number,
    scoreA: number,
    scoreB: number,
    matchMode: MatchMode = 'casual',
): number {
    const scale = matchMode === 'ranked' ? 36 : 24
    const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400))

    let actualA = 0.5
    if (scoreA > scoreB) actualA = 1
    else if (scoreA < scoreB) actualA = 0

    return Math.round(scale * (actualA - expectedA))
}

export function isPlayerX(result: GameplayResult | undefined): boolean {
    return result?.grade === 'X'
}

export function computePp(
    result: GameplayResult | undefined,
    rating: number,
    matchMode: MatchMode = 'casual',
): number {
    if (!result || isPlayerX(result)) return 0

    const accuracy = Math.max(0, Math.min(1, result.accuracy ?? 0))
    const accFactor = Math.pow(accuracy, 4)

    const gradeMultiplier =
        result.grade === 'allPerfect'
            ? 1.15
            : result.grade === 'fullCombo'
                ? 1.07
                : result.grade === 'pass'
                    ? 1.0
                    : 0.55

    const modeMultiplier = matchMode === 'ranked' ? 1.2 : 1.0
    const base = Math.max(10, rating * 2.5)

    return Math.max(0, Math.round(base * accFactor * gradeMultiplier * modeMultiplier))
}

export function isEligibleForRewind(member: RoomMember): boolean {
    const res = member.lastResult
    if (!res) return false
    if (isPlayerX(res)) return true
    if (res.grade === 'fail') return true
    if (res.miss > 0) return true
    if (res.accuracy < 0.95) return true
    return false
}

export function formatPlayerStatsLine(member: RoomMember): string {
    const rating = member.rating ?? 1000
    const pp = member.pp ?? 0
    const wins = member.wins ?? 0
    const losses = member.losses ?? 0
    const draws = member.draws ?? 0
    return `Rating ${rating} · ${pp} PP · ${wins}W/${losses}L/${draws}D`
}