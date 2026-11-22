import type { CustomSongsMode } from './forms.ts'
import type { Env } from './types.ts'

const CUSTOM_SHEET_ID = '1Fpp_sJbGjuKxUAcWhZOM1YqHJJrUHTWE56lO4dthhak'
const INDEX_SHEET_ID = '1mBDbWoTsZlg-tgdnX7DBCSX1bx6EdEFIaKW6Gb4SkC8'
const INDEX_SHEET_TAB = 'index'
const METADATA_TAB = 'METADATA_RAW'

const R2_LEVEL_LIST_KEY = 'level-list/index.json'
const R2_PLAYLISTS_KEY = 'playlists/index.json'
const R2_RANKED_POOLS_KEY = 'ranked/pools.json'
const DAY_MS = 24 * 60 * 60 * 1000

type Row = {
    id: string
    input: string
    serverId: string
    privacy: string
}

export type SheetChart = {
    id: string
    url: string
    address: string
    name: string
}

export type EditionData = {
    edition: string
    groupStage: SheetChart[]
    final: SheetChart[]
    divisions: Record<string, string>
}

export type PlaylistData = {
    name: string
    charts: SheetChart[]
}

type StoredSnapshot<T> = {
    updatedAt: number
    data: T
}

export type RankedPoolsSnapshot = Record<
    RankedTier,
    {
        official: SheetChart[]
        custom: SheetChart[]
    }
>

function parseCSV(input: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let value = ''
    let quoted = false

    for (let i = 0; i < input.length; i++) {
        const char = input[i]!

        if (quoted) {
            if (char === '"' && input[i + 1] === '"') {
                value += '"'
                i++
            } else if (char === '"') {
                quoted = false
            } else {
                value += char
            }
        } else if (char === '"') {
            quoted = true
        } else if (char === ',') {
            row.push(value)
            value = ''
        } else if (char === '\n') {
            row.push(value.replace(/\r$/, ''))
            if (row.some((cell) => cell.trim())) rows.push(row)
            row = []
            value = ''
        } else {
            value += char
        }
    }

    row.push(value.replace(/\r$/, ''))
    if (row.some((cell) => cell.trim())) rows.push(row)

    return rows
}

async function fetchSheet(id: string, tab: string): Promise<string[][]> {
    const url = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}&t=${Date.now()}`

    try {
        console.log(`[Sheets] Requesting spreadsheet ${id}, tab "${tab}".`)
        const response = await fetch(url, {
            headers: {
                Accept: 'text/csv,text/plain,*/*',
                'Cache-Control': 'no-cache',
            },
            signal: AbortSignal.timeout(15000),
            cache: 'no-store',
        })

        if (!response.ok) {
            throw new Error(`Google Sheets HTTP ${response.status} for tab "${tab}".`)
        }

        const content = (await response.text()).replace(/^\uFEFF/, '')
        const trimmed = content.trimStart()

        if (
            !trimmed ||
            trimmed.startsWith('<!DOCTYPE') ||
            trimmed.startsWith('<html') ||
            trimmed.startsWith('google.visualization')
        ) {
            throw new Error(`Google Sheets did not return CSV for tab "${tab}".`)
        }

        const parsed = parseCSV(content)
        if (!parsed.length) {
            throw new Error(`The "${tab}" tab is empty.`)
        }

        return parsed
    } catch (error) {
        console.error(`[Sheets] Failed to read spreadsheet ${id}, tab "${tab}".`, error)
        throw error instanceof Error
            ? error
            : new Error(`Could not read Google Sheet tab "${tab}".`)
    }
}

function normalizeId(value: unknown): string {
    return String(value ?? '')
        .replace(/^\uFEFF/, '')
        .replace(/[\u200B-\u200D\u2060]/g, '')
        .trim()
        .replace(/^'/, '')
        .trim()
}

function chartFromUrl(id: string, rawInput: string): SheetChart | null {
    const raw = rawInput.trim()
    if (!raw) return null

    try {
        let candidate = raw

        if (candidate.startsWith('sonolus://')) {
            candidate = candidate.replace(/^sonolus:\/\//i, 'https://')
        } else if (!/^https?:\/\//i.test(candidate)) {
            candidate = `https://${candidate}`
        }

        const url = new URL(candidate)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

        const match = url.pathname.match(/\/levels\/([^/]+)\/?$/i)
        if (!match) return null

        const name = decodeURIComponent(match[1]!)
        if (!name) return null

        return {
            id,
            url: raw,
            address: url.origin,
            name,
        }
    } catch (error) {
        console.warn('[Sheets] Invalid level URL:', id, raw, error)
        return null
    }
}

function compareIdDescending(a: SheetChart, b: SheetChart): number {
    return b.id.localeCompare(a.id, undefined, {
        numeric: true,
        sensitivity: 'base',
    })
}

async function customRows(): Promise<Row[]> {
    const values = await fetchSheet(CUSTOM_SHEET_ID, 'custom')

    const headerIndex = values.findIndex((row) => {
        const headers = row.map((cell) => normalizeId(cell).toLowerCase())
        return (
            headers.includes('id') &&
            headers.includes('input') &&
            headers.includes('serverid') &&
            headers.includes('privacy')
        )
    })

    if (headerIndex < 0) {
        throw new Error('The custom tab must contain id, input, serverId and privacy headers.')
    }

    const headers = values[headerIndex]!.map((cell) => normalizeId(cell).toLowerCase())
    const idIndex = headers.indexOf('id')
    const inputIndex = headers.indexOf('input')
    const serverIdIndex = headers.indexOf('serverid')
    const privacyIndex = headers.indexOf('privacy')

    return values
        .slice(headerIndex + 1)
        .map((cells) => ({
            id: normalizeId(cells[idIndex]),
            input: normalizeId(cells[inputIndex]),
            serverId: normalizeId(cells[serverIdIndex]),
            privacy: normalizeId(cells[privacyIndex]),
        }))
        .filter((row) => row.id && row.input)
}

function isCustomLevelId(id: string): boolean {
    const normalized = normalizeId(id).toUpperCase()
    return normalized.startsWith('60') || normalized.startsWith('X')
}

function isPublicLevel(row: Row): boolean {
    const privacy = normalizeId(row.privacy).toLowerCase()
    const serverId = normalizeId(row.serverId)
    return privacy !== 'unlisted' && serverId !== '-'
}

export const CUSTOM_LEVEL_PAGE_SIZE = 10

async function readBucketJson<T>(
    env: Env | undefined,
    key: string,
    maxAgeMs = DAY_MS,
): Promise<T | null> {
    const bucket = env?.POSTS_BUCKET
    if (!bucket) return null

    try {
        const obj = await bucket.get(key)
        if (!obj) return null

        const parsed = (await obj.json()) as StoredSnapshot<T>
        if (!parsed || typeof parsed.updatedAt !== 'number' || !('data' in parsed)) {
            return null
        }

        if (Date.now() - parsed.updatedAt > maxAgeMs) {
            return null
        }

        return parsed.data
    } catch (error) {
        console.warn(`[R2] Failed reading ${key}:`, error)
        return null
    }
}

async function writeBucketJson<T>(
    env: Env | undefined,
    key: string,
    data: T,
): Promise<void> {
    const bucket = env?.POSTS_BUCKET
    if (!bucket) return

    const payload: StoredSnapshot<T> = {
        updatedAt: Date.now(),
        data,
    }

    await bucket.put(key, JSON.stringify(payload), {
        httpMetadata: { contentType: 'application/json' },
    })
}

async function fetchCustomLevelsFromSheet(): Promise<SheetChart[]> {
    const rows = await customRows()
    return rows
        .filter((row) => isCustomLevelId(row.id) && isPublicLevel(row))
        .map((row) => chartFromUrl(row.id, row.input))
        .filter((chart): chart is SheetChart => chart !== null)
        .sort(compareIdDescending)
}

export async function getCustomLevels(env?: Env): Promise<SheetChart[]> {
    const cached = await readBucketJson<SheetChart[]>(env, R2_LEVEL_LIST_KEY)
    if (cached) return cached

    const charts = await fetchCustomLevelsFromSheet()
    await writeBucketJson(env, R2_LEVEL_LIST_KEY, charts)
    return charts
}

export async function getCustomLevelPage(
    page: number,
    env?: Env,
): Promise<{ charts: SheetChart[]; pageCount: number }> {
    const all = await getCustomLevels(env)
    const safePage = Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0
    const pageCount = Math.max(1, Math.ceil(all.length / CUSTOM_LEVEL_PAGE_SIZE))
    const start = safePage * CUSTOM_LEVEL_PAGE_SIZE

    return {
        charts: all.slice(start, start + CUSTOM_LEVEL_PAGE_SIZE),
        pageCount,
    }
}

function suduPlaylistName(id: string): string | null {
    const match = normalizeId(id).toUpperCase().match(/^D(\d{2})/)
    if (!match) return null
    return `SUDU-${match[1]!.padStart(3, '0')}`
}

async function fetchPlaylistsFromSheet(): Promise<PlaylistData[]> {
    const rows = await customRows()
    const charts = rows
        .filter((row) => {
            const id = normalizeId(row.id).toUpperCase()
            return id.startsWith('X') || id.startsWith('D')
        })
        .map((row) => chartFromUrl(row.id, row.input))
        .filter((chart): chart is SheetChart => chart !== null)

    const groups = new Map<string, SheetChart[]>()

    for (const chart of charts) {
        const id = normalizeId(chart.id).toUpperCase()
        let title: string | null = null

        if (id.startsWith('D')) {
            title = suduPlaylistName(id)
        } else {
            const xMatch = id.match(/^X(\d+)/)
            if (xMatch) title = `XX! Championship 20${xMatch[1]}`
        }

        if (!title) continue
        const list = groups.get(title) ?? []
        list.push(chart)
        groups.set(title, list)
    }

    return [...groups.entries()]
        .map(([name, items]) => ({
            name,
            charts: items.sort(compareIdDescending),
        }))
        .sort((a, b) => {
            const aSudu = a.name.match(/^SUDU-(\d+)$/)
            const bSudu = b.name.match(/^SUDU-(\d+)$/)

            if (aSudu && bSudu) return Number(aSudu[1]) - Number(bSudu[1])
            if (aSudu) return -1
            if (bSudu) return 1

            return a.name.localeCompare(b.name, undefined, { numeric: true })
        })
}

export async function getPlaylists(env?: Env): Promise<PlaylistData[]> {
    const cached = await readBucketJson<PlaylistData[]>(env, R2_PLAYLISTS_KEY)
    if (cached) return cached

    const playlists = await fetchPlaylistsFromSheet()
    await writeBucketJson(env, R2_PLAYLISTS_KEY, playlists)
    return playlists
}

function splitHandles(value: string): string[] {
    return value
        .split(',')
        .map((handle) => handle.trim())
        .filter(Boolean)
}

function isGroupHeader(header: string): boolean {
    return /^[A-Z]$/i.test(header)
}

export async function getEditionData(): Promise<EditionData> {
    const rows = await fetchSheet(INDEX_SHEET_ID, INDEX_SHEET_TAB)

    if (rows.length < 2) {
        throw new Error(`The "${INDEX_SHEET_TAB}" tab must contain a header row and at least one edition row.`)
    }

    const headers = rows[0]!.map((cell) => normalizeId(cell))
    const normalized = headers.map((cell) => cell.toUpperCase())

    if (normalizeId(headers[0]).toLowerCase() !== 'index') {
        throw new Error(`[INDEX] Expected cell A1 to be "Index", received "${headers[0] ?? ''}".`)
    }

    if (!normalized.includes('G1') || !normalized.includes('F1')) {
        throw new Error(`[INDEX] Expected G1 and F1 columns in "${INDEX_SHEET_TAB}".`)
    }

    let activeRow: string[] | null = null
    for (let i = rows.length - 1; i >= 1; i--) {
        if (normalizeId(rows[i]![0])) {
            activeRow = rows[i]!
            break
        }
    }

    if (!activeRow) {
        throw new Error(`No edition found in column A of "${INDEX_SHEET_TAB}".`)
    }

    const edition = normalizeId(activeRow[0])
    if (!edition) {
        throw new Error(`Current edition name in column A of "${INDEX_SHEET_TAB}" is empty.`)
    }

    const groupStage: SheetChart[] = []
    const final: SheetChart[] = []
    const divisions: Record<string, string> = {}

    for (let column = 0; column < headers.length; column++) {
        const header = normalized[column] ?? ''
        const value = String(activeRow[column] ?? '').trim()
        if (!header || !value) continue

        const groupMatch = header.match(/^G(\d+)$/)
        const finalMatch = header.match(/^F(\d+)$/)

        if (groupMatch || finalMatch) {
            const id = groupMatch ? `G${groupMatch[1]}` : `F${finalMatch![1]}`
            const chart = chartFromUrl(id, value)
            if (!chart) continue

            if (groupMatch) groupStage.push(chart)
            else final.push(chart)
            continue
        }

        if (isGroupHeader(header)) {
            for (const handle of splitHandles(value)) {
                divisions[handle] = `Group ${header}`
            }
            continue
        }

        if (header === 'UB' || header === 'LB') {
            const division = header === 'UB' ? 'Upper Bracket' : 'Lower Bracket'
            for (const handle of splitHandles(value)) {
                divisions[handle] = division
            }
        }
    }

    const sortByNumber = (a: SheetChart, b: SheetChart) =>
        Number(a.id.slice(1)) - Number(b.id.slice(1))

    return {
        edition,
        groupStage: groupStage.sort(sortByNumber),
        final: final.sort(sortByNumber),
        divisions,
    }
}

export async function getCurrentEdition(): Promise<string> {
    return (await getEditionData()).edition
}

export function clearSheetCache(): void {
    // R2 acts as the persistent daily cache.
}

export const RANKED_TIERS = {
    master:   { main: [30, 37] as const, append: [28, 99] as const },
    diamond:  { main: [29, 32] as const, append: [27, 30] as const },
    platinum: { main: [28, 31] as const, append: null },
    gold:     { main: [26, 30] as const, append: null },
    silver:   { main: [25, 28] as const, append: null },
    bronze:   { main: [23, 27] as const, append: null },
    beginner: { main: [18, 25] as const, append: null },
} as const

export type RankedTier = keyof typeof RANKED_TIERS

const OFFICIAL_DIFFS = ['ez', 'nm', 'hr', 'ex', 'ms', 'ap'] as const

function inRange(level: number, range: readonly [number, number] | null): boolean {
    return !!range && level >= range[0] && level <= range[1]
}

async function officialRankedPoolFromSheet(
    values: string[][],
    tier: RankedTier,
): Promise<SheetChart[]> {
    const headerIndex = values.findIndex((row) =>
        row.some((cell) => normalizeId(cell).toLowerCase() === 'hrlevellinksbuga'),
    )
    if (headerIndex < 0) throw new Error('METADATA_RAW header row not found.')

    const headers = values[headerIndex]!.map((cell) => normalizeId(cell).toLowerCase())
    const idCol = headers.indexOf('id')
    const rules = RANKED_TIERS[tier]
    const pool: SheetChart[] = []

    for (const cells of values.slice(headerIndex + 1)) {
        for (const diff of OFFICIAL_DIFFS) {
            const levelCol = headers.indexOf(`${diff}playlevel`)
            const linkCol = headers.indexOf(`${diff}levellinksbuga`)
            if (levelCol < 0 || linkCol < 0) continue

            const level = Number(normalizeId(cells[levelCol]))
            const link = normalizeId(cells[linkCol])
            if (!Number.isFinite(level) || !link || link === '-') continue

            const fits = diff === 'ap'
                ? inRange(level, rules.append)
                : inRange(level, rules.main)
            if (!fits) continue

            const chart = chartFromUrl(`${normalizeId(cells[idCol])}-${diff}`, link)
            if (chart) pool.push(chart)
        }
    }

    return pool
}

async function customRankedPoolFromSheet(
    values: string[][],
    tier: RankedTier,
): Promise<SheetChart[]> {
    const headerIndex = values.findIndex((row) =>
        row.some((cell) => normalizeId(cell).toLowerCase() === 'ranked'),
    )
    if (headerIndex < 0) return []

    const headers = values[headerIndex]!.map((cell) => normalizeId(cell).toLowerCase())
    const col = (name: string) => headers.indexOf(name)
    const rules = RANKED_TIERS[tier]
    const pool: SheetChart[] = []

    for (const cells of values.slice(headerIndex + 1)) {
        const id = normalizeId(cells[col('id')])
        if (!isCustomLevelId(id)) continue
        if (normalizeId(cells[col('ranked')]).toLowerCase() !== 'true') continue

        const row: Row = {
            id,
            input: normalizeId(cells[col('input')]),
            serverId: normalizeId(cells[col('serverid')]),
            privacy: normalizeId(cells[col('privacy')]),
        }
        if (!isPublicLevel(row)) continue

        const level = Number(normalizeId(cells[col('playlevel')]))
        const isAppend = normalizeId(cells[col('difficulty')]).toLowerCase() === 'append'
        if (!inRange(level, isAppend ? rules.append : rules.main)) continue

        const chart = chartFromUrl(id, row.input)
        if (chart) pool.push(chart)
    }

    return pool
}

async function buildRankedPoolsSnapshot(): Promise<RankedPoolsSnapshot> {
    const [metaRows, customSheetRows] = await Promise.all([
        fetchSheet(CUSTOM_SHEET_ID, METADATA_TAB),
        fetchSheet(CUSTOM_SHEET_ID, 'custom'),
    ])

    const tiers = Object.keys(RANKED_TIERS) as RankedTier[]
    const snapshot = {} as RankedPoolsSnapshot

    for (const tier of tiers) {
        snapshot[tier] = {
            official: await officialRankedPoolFromSheet(metaRows, tier),
            custom: await customRankedPoolFromSheet(customSheetRows, tier),
        }
    }

    return snapshot
}

export async function getRankedPools(env?: Env): Promise<RankedPoolsSnapshot> {
    const cached = await readBucketJson<RankedPoolsSnapshot>(env, R2_RANKED_POOLS_KEY)
    if (cached) return cached

    const snapshot = await buildRankedPoolsSnapshot()
    await writeBucketJson(env, R2_RANKED_POOLS_KEY, snapshot)
    return snapshot
}

export async function refreshDailyAssets(env: Env): Promise<void> {
    console.log('[Cron] Refreshing daily R2 assets (level-list, playlists, ranked pools)...')

    const [customCharts, playlists, rankedPools] = await Promise.all([
        fetchCustomLevelsFromSheet(),
        fetchPlaylistsFromSheet(),
        buildRankedPoolsSnapshot(),
    ])

    await Promise.all([
        writeBucketJson(env, R2_LEVEL_LIST_KEY, customCharts),
        writeBucketJson(env, R2_PLAYLISTS_KEY, playlists),
        writeBucketJson(env, R2_RANKED_POOLS_KEY, rankedPools),
    ])

    console.log(
        `[Cron] Refreshed R2 assets: ${customCharts.length} levels, ${playlists.length} playlists.`,
    )
}

export async function pickRankedLevel(
    tier: RankedTier,
    customSongs: CustomSongsMode | boolean,
    env?: Env,
): Promise<SheetChart | null> {
    const mode: CustomSongsMode =
        typeof customSongs === 'boolean'
            ? (customSongs ? 'on' : 'off')
            : customSongs

    const pools = await getRankedPools(env)
    const tierPool = pools[tier] ?? { official: [], custom: [] }

    const pool = mode === 'customOnly'
        ? tierPool.custom
        : mode === 'on'
            ? [...tierPool.official, ...tierPool.custom]
            : tierPool.official

    if (pool.length === 0) return null
    return pool[Math.floor(Math.random() * pool.length)]!
}