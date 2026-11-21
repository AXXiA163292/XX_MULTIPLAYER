
export const PP_SETTINGS = {
    enabled: true,
    defaultSpeed: 1,
    minSpeed: 0.5,
    maxSpeed: 2,
    displayDecimals: 1,
    totalRounding: 'ceil' as 'ceil' | 'round' | 'floor',
    chartWeightCoefficient: 2.3335e-17,
    chartWeightExponent: 13.06,
    arc: {
        greatCoefficient: -27000,
        greatExponent: 0.45,
        goodCoefficient: -21952,
        goodExponent: 0.35,
        badCoefficient: -20000,
        badExponent: 0.2,
        ratingExponent: 3,
    },
    aim: {
        exponent: 1.16,
        multiplier: 2,
    },
    skill: {
        fullComboOffset: 17.9,
        fullComboDivisor: 21.2,
        fullComboExponent: 0.45,
        clearOffset: 21.9,
        clearDivisor: 17.2,
        clearExponent: 0.55,
        failedOffset: 28.9,
        failedDivisor: 10,
        failedExponent: 0.65,
        failedMissThreshold: 13,
    },
    append: {
        enabled: true,
        referenceRating: 39,
        divisor: 13,
    },
    speed: {
        exponent: 1.77,
        multiplier: 1.69852,
        constantExponent: 1 / 13.01,
    },
} as const

export type PPInput = {
    rating: number
    noteCount: number
    perfect: number
    great: number
    good: number
    bad: number
    miss: number
    combo: number
    difficulty?: string
    speed?: number
}

export type PPResult = {
    pp: number
    chartWeight: number
    chartRating: number
    arc: number
    aim: number
    skill: number
    perfect: number
    bad: number
}

export function calculateArc(
    rating: number,
    perfect: number,
    great: number,
    good: number,
    bad: number,
    miss: number,
    nc: number,
): number {
    if (!nc || rating <= 0) return 0

    const c = PP_SETTINGS.arc
    const grV = c.greatCoefficient / Math.pow(rating, c.ratingExponent)
    const gdV = c.goodCoefficient / Math.pow(rating, c.ratingExponent)
    const brV = c.badCoefficient / Math.pow(rating, c.ratingExponent)

    const grR = great / nc
    const gdR = good / nc
    const brR = (bad + miss) / nc

    return Math.max(
        0,
        (
            perfect +
            nc * grV * Math.pow(grR, c.greatExponent) +
            nc * gdV * Math.pow(gdR, c.goodExponent) +
            nc * brV * Math.pow(brR, c.badExponent)
        ) / nc,
    )
}

export function calculateAim(combo: number, nc: number): number {
    if (!nc) return 0

    const ratio = combo / nc
    const c = PP_SETTINGS.aim

    return Math.pow(ratio, c.exponent) * (c.multiplier - ratio)
}

export function calculateSkill(
    rating: number,
    great: number,
    combo: number,
    miss: number,
    nc: number,
): number {
    if (great === 0) return 1

    const c = PP_SETTINGS.skill

    if (combo === nc) {
        return Math.pow(
            (rating - c.fullComboOffset) / c.fullComboDivisor,
            c.fullComboExponent,
        )
    }

    if (miss <= c.failedMissThreshold) {
        return Math.pow(
            (rating - c.clearOffset) / c.clearDivisor,
            c.clearExponent,
        )
    }

    return Math.pow(
        (rating - c.failedOffset) / c.failedDivisor,
        c.failedExponent,
    )
}

export function calculatePP(input: PPInput): PPResult {
    const rating = input.rating
    const nc = input.noteCount
    const speed = input.speed ?? PP_SETTINGS.defaultSpeed
    const difficulty = (input.difficulty ?? 'MASTER').toUpperCase()

    if (
        !PP_SETTINGS.enabled ||
        !Number.isFinite(rating) ||
        rating <= 0 ||
        !Number.isInteger(nc) ||
        nc <= 0 ||
        speed < PP_SETTINGS.minSpeed ||
        speed > PP_SETTINGS.maxSpeed
    ) {
        return {
            pp: 0,
            chartWeight: 0,
            chartRating: rating,
            arc: 0,
            aim: 0,
            skill: 0,
            perfect: 0,
            bad: 0,
        }
    }

    const perfect = nc - input.great - input.good - input.bad - input.miss

    if (
        perfect < 0 ||
        input.great < 0 ||
        input.good < 0 ||
        input.bad < 0 ||
        input.miss < 0 ||
        input.combo < 0 ||
        input.combo > nc
    ) {
        return {
            pp: 0,
            chartWeight: 0,
            chartRating: rating,
            arc: 0,
            aim: 0,
            skill: 0,
            perfect: 0,
            bad: 0,
        }
    }

    const c = PP_SETTINGS
    const chartWeight =
        c.chartWeightCoefficient * Math.pow(rating, c.chartWeightExponent)

    const appendMultiplier =
        difficulty === 'APPEND' && c.append.enabled
            ? 1 + Math.pow(
                (c.append.referenceRating - rating) / c.append.divisor,
                2,
            )
            : 1

    const speedMultiplier = Math.exp(
        c.speed.multiplier * (Math.pow(speed, c.speed.exponent) - 1),
    )

    const chartRating = rating * Math.pow(
        speedMultiplier * appendMultiplier,
        c.speed.constantExponent,
    )

    const arc = calculateArc(
        rating,
        perfect,
        input.great,
        input.good,
        input.bad,
        input.miss,
        nc,
    )

    const aim = calculateAim(input.combo, nc)

    const skill = calculateSkill(
        rating,
        input.great,
        input.combo,
        input.miss,
        nc,
    )

    const pp = chartWeight * arc * aim * skill

    return {
        pp: Number.isFinite(pp) ? pp : 0,
        chartWeight,
        chartRating,
        arc,
        aim,
        skill,
        perfect,
        bad: input.bad,
    }
}

export function roundPP(value: number): number {
    switch (PP_SETTINGS.totalRounding) {
        case 'round':
            return Math.round(value)
        case 'floor':
            return Math.floor(value)
        default:
            return Math.ceil(value)
    }
}

export function formatPP(value: number): string {
    return `${value.toFixed(PP_SETTINGS.displayDecimals)} pp`
}