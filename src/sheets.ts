import type { Env } from './types.ts'

export type SheetChart = {
    id: string
    url: string
    address: string
    name: string
    constant?: number
    playLevel?: number
    musicVocalIds?: number[]
    sekaiVocalVersion?: number
}

export type SheetPlaylist = {
    name: string
    charts: SheetChart[]
}

export type EditionData = {
    edition: string
    group1: SheetChart[]
    group2: SheetChart[]
    final: SheetChart[]
}

export type RankedTier =
    | 'beginner'
    | 'bronze'
    | 'silver'
    | 'gold'
    | 'platinum'
    | 'diamond'
    | 'master'

export type UltimateSeason = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL'

export type UltimatePoolSong = {
    season: UltimateSeason
    slot: string
    playLevel: number
    chart: SheetChart
}

export type UltimateEditionData = {
    edition: string
    fixedCharts: SheetChart[]
    pool: UltimatePoolSong[]
}

export type UltimatePicks = {
    picks: UltimatePoolSong[]
    updatedAt: number
}

export type RefreshSummary = {
    refreshedAt: number
    editions: string[]
    customLevelsCount: number
    playlistsCount: number
    constantsCount: number
    errors: string[]
}

type Row = {
    id: string
    input: string
    constant: string
}

const SHEET_ID = '18e5uQ5eY7e0o31V76k7d9j7G02gX_L5o6_8P3v60X6o'
const INDEX_GID = '0'
const CUSTOM_GID = '1065787429'
const LIVE_EDITION_FALLBACK = 'FALL 2026'
const CUSTOM_LEVEL_PAGE_SIZE = 20

const R2_INDEX_ROWS_KEY = 'server/sheets/index.json'
const R2_CUSTOM_ROWS_KEY = 'server/sheets/custom.json'
const R2_CONSTANTS_KEY = 'server/constants/v2/index.json'
const R2_LEVEL_LIST_KEY = 'server/level-list/index.json'
const R2_RANKED_POOLS_KEY = 'server/ranked/pools.json'

const ULTIMATE_SEASONS: UltimateSeason[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL']

function stripTrailingSlash(value: string): string {
    return value.trim().replace(/\/+$/, '')
}

function normalizeId(value: unknown): string {
    return String(value ?? '').trim()
}

function parseConstantValue(raw: unknown): number | null {
    if (typeof raw === 'number') {
        return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) / 100 : null
    }
    const clean = String(raw ?? '').trim().replace(',', '.')
    if (!clean) return null
    const parsed = Number(clean)
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null
}

function chartFromUrl(id: string, rawUrl: string): SheetChart | null {
    const cleanUrl = rawUrl.trim()
    if (!cleanUrl) return null

    try {
        const parsed = new URL(cleanUrl)
        const parts = parsed.pathname.split('/').filter(Boolean)
        const levelIndex = parts.findIndex((p) => p === 'levels')
        const name = levelIndex >= 0 && parts[levelIndex + 1]
            ? decodeURIComponent(parts[levelIndex + 1]!)
            : parts[parts.length - 1] ?? ''

        if (!name) return null

        const sonolusIdx = parts.indexOf('sonolus')
        const basePath = sonolusIdx >= 0
            ? `/${parts.slice(0, sonolusIdx).join('/')}`
            : ''
        const address = `${parsed.origin}${basePath}`.replace(/\/+$/, '')

        return {
            id: id.trim() || name,
            url: cleanUrl,
            address,
            name,
        }
    } catch {
        return null
    }
}

async function readBucketJson<T>(env: Env | undefined, key: string): Promise<T | null> {
    const bucket = env?.SONOLUS_ASSETS_BUCKET ?? env?.COMMUNITY_BUCKET
    if (!bucket) return null

    try {
        const obj = await bucket.get(key)
        if (!obj) return null
        return await obj.json() as T
    } catch {
        return null
    }
}

async function writeBucketJson(env: Env | undefined, key: string, data: unknown): Promise<void> {
    const bucket = env?.SONOLUS_ASSETS_BUCKET ?? env?.COMMUNITY_BUCKET
    if (!bucket) return

    await bucket.put(key, JSON.stringify(data), {
        httpMetadata: { contentType: 'application/json' },
    })
}

async function fetchCsvRows(gid: string): Promise<string[][]> {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`
    const res = await fetch(url, {
        headers: { 'Cache-Control': 'no-cache' },
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
    })

    if (!res.ok) {
        throw new Error(`Sheet export ${gid} returned ${res.status}`)
    }

    const csv = await res.text()
    const rows: string[][] = []
    let row: string[] = []
    let cell = ''
    let inQuotes = false

    for (let i = 0; i < csv.length; i++) {
        const ch = csv[i]!
        const next = csv[i + 1]

        if (inQuotes) {
            if (ch === '"' && next === '"') {
                cell += '"'
                i++
            } else if (ch === '"') {
                inQuotes = false
            } else {
                cell += ch
            }
            continue
        }

        if (ch === '"') {
            inQuotes = true
        } else if (ch === ',') {
            row.push(cell)
            cell = ''
        } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
            row.push(cell)
            rows.push(row)
            row = []
            cell = ''
            if (ch === '\r') i++
        } else if (ch !== '\r') {
            cell += ch
        }
    }

    if (cell.length > 0 || row.length > 0) {
        row.push(cell)
        rows.push(row)
    }

    return rows
}

function tableToRows(table: string[][]): Row[] {
    if (table.length < 2) return []
    const headers = table[0]!.map((h) => h.trim().toLowerCase())

    const idIdx = headers.findIndex((h) => h === 'id' || h === 'name' || h === 'key')
    const urlIdx = headers.findIndex((h) => h === 'url' || h === 'link' || h === 'level')
    const constIdx = headers.findIndex((h) => h === 'constant' || h === 'const')

    const rows: Row[] = []
    for (let i = 1; i < table.length; i++) {
        const r = table[i]!
        const id = normalizeId(idIdx >= 0 ? r[idIdx] : r[0])
        const input = normalizeId(urlIdx >= 0 ? r[urlIdx] : r[1])
        const constant = normalizeId(constIdx >= 0 ? r[constIdx] : '')
        if (!id && !input) continue
        rows.push({ id, input, constant })
    }
    return rows
}

async function indexTable(env?: Env): Promise<string[][]> {
    const cached = await readBucketJson<string[][]>(env, R2_INDEX_ROWS_KEY)
    if (Array.isArray(cached) && cached.length > 0) return cached

    const rows = await fetchCsvRows(INDEX_GID)
    await writeBucketJson(env, R2_INDEX_ROWS_KEY, rows).catch(() => {})
    return rows
}

async function customRows(env?: Env): Promise<Row[]> {
    const cached = await readBucketJson<Row[]>(env, R2_CUSTOM_ROWS_KEY)
    if (Array.isArray(cached) && cached.length > 0) return cached

    const table = await fetchCsvRows(CUSTOM_GID)
    const rows = tableToRows(table)
    await writeBucketJson(env, R2_CUSTOM_ROWS_KEY, rows).catch(() => {})
    return rows
}

function buildConstantsMap(rows: Row[]): Record<string, number> {
    const map: Record<string, number> = {}

    for (const row of rows) {
        const chart = chartFromUrl(row.id, row.input)
        const value = parseConstantValue(row.constant)

        if (chart && value !== null) {
            map[`${chart.address}::${chart.name}`] = value
        }
    }

    return map
}

export async function getConstantForAddress(
    address: string,
    env?: Env,
    name?: string,
): Promise<number | null> {
    const cleanAddr = stripTrailingSlash(address)
    if (!cleanAddr) return null

    const key = name
        ? `${cleanAddr}::${name.trim()}`
        : cleanAddr

    const cached = await readBucketJson<Record<string, number>>(
        env,
        R2_CONSTANTS_KEY,
    )

    if (cached && typeof cached[key] === 'number') {
        return cached[key]!
    }

    const rows = await customRows(env)
    const map = buildConstantsMap(rows)

    await writeBucketJson(env, R2_CONSTANTS_KEY, map).catch(() => {})

    return map[key] ?? null
}

export function getLiveEdition(): string {
    return LIVE_EDITION_FALLBACK
}

export async function getAvailableEditions(env?: Env): Promise<string[]> {
    const table = await indexTable(env).catch(() => [])
    const editions = new Set<string>([LIVE_EDITION_FALLBACK])

    for (let i = 1; i < table.length; i++) {
        const first = normalizeId(table[i]?.[0]).toUpperCase()
        if (/^(WINTER|SPRING|SUMMER|FALL|ULTIMATE)\s+\d{4}$/.test(first)) {
            editions.add(first)
        }
    }

    return [...editions]
}

export async function getEditionData(
    edition: string,
    env?: Env,
): Promise<EditionData> {
    const target = normalizeId(edition).toUpperCase()
    const table = await indexTable(env)
    const result: EditionData = {
        edition: target,
        group1: [],
        group2: [],
        final: [],
    }

    if (table.length < 2) return result

    const headers = table[0]!
    const normalized = headers.map((h) => h.trim().toUpperCase())
    const editionCol = normalized.findIndex((h) => h === 'EDITION' || h === 'SEASON' || h === 'NAME' || h === 'ID')

    for (let i = 1; i < table.length; i++) {
        const row = table[i]!
        const rowEdition = normalizeId(editionCol >= 0 ? row[editionCol] : row[0]).toUpperCase()
        if (rowEdition !== target) continue

        for (let c = 0; c < normalized.length; c++) {
            const colName = normalized[c]!
            const val = normalizeId(row[c])
            if (!val) continue

            const groupMatch = colName.match(/^G([12])_?(\d+)$/)
            const finalMatch = colName.match(/^F_?(\d+)$/)
            const match = groupMatch ?? finalMatch
            if (!match) continue

            const chart = chartFromUrl(colName, val)
            if (!chart) continue

            const constantColumn = normalized.indexOf(`${colName}CONSTANT`)
            const constant = constantColumn >= 0
                ? parseConstantValue(normalizeId(row[constantColumn]))
                : null

            if (constant !== null) {
                chart.constant = constant
            }

            if (groupMatch) {
                if (groupMatch[1] === '1') result.group1.push(chart)
                else result.group2.push(chart)
            } else {
                result.final.push(chart)
            }
        }
    }

    return result
}

export async function getUltimateEditionData(
    edition: string,
    env?: Env,
): Promise<UltimateEditionData> {
    const target = normalizeId(edition).toUpperCase()
    const table = await indexTable(env)
    const pool: UltimatePoolSong[] = []
    const fixedCharts: SheetChart[] = []

    if (table.length < 2) {
        return { edition: target, fixedCharts, pool }
    }

    const headers = table[0]!
    const normalized = headers.map((h) => h.trim().toUpperCase())

    const ultimateRow = table.slice(1).find((row) =>
        normalizeId(row[0]).toUpperCase() === target,
    )

    const getFixedChart = (slot: 'F1' | 'F2'): SheetChart | null => {
        if (!ultimateRow) return null

        const column = normalized.indexOf(slot)
        if (column < 0) return null

        const chart = chartFromUrl(slot, normalizeId(ultimateRow[column]))
        if (!chart) return null

        const constantColumn = normalized.indexOf(`${slot}CONSTANT`)
        const constant = constantColumn >= 0
            ? parseConstantValue(normalizeId(ultimateRow[constantColumn]))
            : null

        if (constant !== null) {
            chart.constant = constant
        }

        return chart
    }

    const f1 = getFixedChart('F1')
    const f2 = getFixedChart('F2')
    if (f1) fixedCharts.push(f1)
    if (f2) fixedCharts.push(f2)

    const buildSeasonPool = (season: UltimateSeason) => {
        const seasonRow = table.slice(1).find((row) => {
            const first = normalizeId(row[0]).toUpperCase()
            return first.startsWith(season)
        })
        if (!seasonRow) return

        for (let c = 0; c < normalized.length; c++) {
            const slot = normalized[c]!
            const rawUrl = normalizeId(seasonRow[c])
            if (!rawUrl || !/^(G\d+|F\d+)$/.test(slot)) continue

            const chart = chartFromUrl(slot, rawUrl)
            if (!chart) continue

            const constantColumn = normalized.indexOf(`${slot}CONSTANT`)
            const constant = constantColumn >= 0
                ? parseConstantValue(normalizeId(seasonRow[constantColumn]))
                : null

            const levelCol = normalized.indexOf(`${slot}LEVEL`)
            const playLevel = levelCol >= 0
                ? (parseConstantValue(normalizeId(seasonRow[levelCol])) ?? undefined)
                : undefined

            chart.id = `${season}-${slot}`
            if (playLevel !== undefined) {
                chart.playLevel = playLevel
            }
            if (constant !== null) {
                chart.constant = constant
            }

            pool.push({
                season,
                slot,
                playLevel: playLevel ?? 30,
                chart,
            })
        }
    }

    for (const s of ULTIMATE_SEASONS) {
        buildSeasonPool(s)
    }

    return { edition: target, fixedCharts, pool }
}

export async function getSavedUltimatePicks(
    env: Env,
    edition: string,
): Promise<UltimatePicks | null> {
    return readBucketJson<UltimatePicks>(
        env,
        `server/ultimate/${encodeURIComponent(edition.toUpperCase())}/picks.json`,
    )
}

export async function saveUltimatePicks(
    env: Env,
    edition: string,
    picks: UltimatePoolSong[],
): Promise<UltimatePicks> {
    const payload: UltimatePicks = {
        picks,
        updatedAt: Date.now(),
    }
    await writeBucketJson(
        env,
        `server/ultimate/${encodeURIComponent(edition.toUpperCase())}/picks.json`,
        payload,
    )
    return payload
}

export async function getCustomLevels(env?: Env): Promise<SheetChart[]> {
    const rows = await customRows(env)
    const charts: SheetChart[] = []
    for (const row of rows) {
        const chart = chartFromUrl(row.id, row.input)
        if (!chart) continue
        const constant = parseConstantValue(row.constant)
        if (constant !== null) {
            chart.constant = constant
        }
        charts.push(chart)
    }
    return charts
}

export async function getCustomLevelPage(
    page: number,
    env?: Env,
    pageSize = CUSTOM_LEVEL_PAGE_SIZE,
    keywords = '',
): Promise<{ charts: SheetChart[]; pageCount: number }> {
    const all = await getCustomLevels(env)
    const safePage = Number.isInteger(page) && page >= 0 ? page : 0
    const safePageSize = Number.isInteger(pageSize)
        ? Math.max(1, Math.min(50, pageSize))
        : CUSTOM_LEVEL_PAGE_SIZE

    const query = keywords.trim().toLowerCase()
    const filtered = query
        ? all.filter((chart) =>
            `${chart.name} ${chart.id} ${chart.url}`
                .toLowerCase()
                .includes(query),
        )
        : all

    const pageCount = Math.max(
        1,
        Math.ceil(filtered.length / safePageSize),
    )

    const start = safePage * safePageSize

    return {
        charts: filtered.slice(start, start + safePageSize),
        pageCount,
    }
}

export async function getPlaylists(env?: Env): Promise<SheetPlaylist[]> {
    const customCharts = await getCustomLevels(env).catch(() => [])
    if (customCharts.length === 0) return []
    return [
        {
            name: 'Custom Levels',
            charts: customCharts,
        },
    ]
}

export async function pickRankedLevel(
    env: Env,
    tier: RankedTier,
    customSongs: 'off' | 'on' | 'customOnly' = 'off',
): Promise<SheetChart | null> {
    const pools = await readBucketJson<Record<string, SheetChart[]>>(env, R2_RANKED_POOLS_KEY)
    const customCharts = await getCustomLevels(env).catch(() => [])

    const tierPool = Array.isArray(pools?.[tier]) ? pools[tier]! : []
    const candidates = customSongs === 'customOnly'
        ? customCharts
        : customSongs === 'on'
            ? [...tierPool, ...customCharts]
            : tierPool.length > 0
                ? tierPool
                : customCharts

    if (candidates.length === 0) return null
    const idx = Math.floor(Math.random() * candidates.length)
    return candidates[idx] ?? null
}

export async function refreshDailyAssets(env: Env): Promise<RefreshSummary> {
    const errors: string[] = []
    let editions: string[] = []
    let customCharts: SheetChart[] = []
    let playlists: SheetPlaylist[] = []
    let constantsCount = 0

    try {
        const indexCsv = await fetchCsvRows(INDEX_GID)
        await writeBucketJson(env, R2_INDEX_ROWS_KEY, indexCsv)
        editions = await getAvailableEditions(env)
    } catch (error) {
        errors.push(`Index refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
        const customCsv = await fetchCsvRows(CUSTOM_GID)
        const parsedRows = tableToRows(customCsv)
        await writeBucketJson(env, R2_CUSTOM_ROWS_KEY, parsedRows)

        const constantsMap = buildConstantsMap(parsedRows)
        constantsCount = Object.keys(constantsMap).length
        await writeBucketJson(env, R2_CONSTANTS_KEY, constantsMap)

        customCharts = await getCustomLevels(env)
        playlists = await getPlaylists(env)

        const existingList = await readBucketJson<any>(env, R2_LEVEL_LIST_KEY)
        if (!existingList) {
            await writeBucketJson(env, R2_LEVEL_LIST_KEY, { items: [] })
        }
    } catch (error) {
        errors.push(`Custom refresh failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    return {
        refreshedAt: Date.now(),
        editions,
        customLevelsCount: customCharts.length,
        playlistsCount: playlists.length,
        constantsCount,
        errors,
    }
}