import { normalizeCustomSongsMode, type CustomSongsMode } from './forms.ts'
import type { Env, LevelItem } from './types.ts'

const CUSTOM_SHEET_ID = '1Fpp_sJbGjuKxUAcWhZOM1YqHJJrUHTWE56lO4dthhak'
const INDEX_SHEET_ID = '1mBDbWoTsZlg-tgdnX7DBCSX1bx6EdEFIaKW6Gb4SkC8'
const INDEX_SHEET_TAB = 'index'
const METADATA_TAB = 'METADATA_RAW'

const R2_LEVEL_LIST_KEY = 'server/level-list/index.json'
const R2_PLAYLISTS_KEY = 'server/playlists/index.json'
const R2_CONSTANTS_KEY = 'server/constants/index.json'
const rankedTierKey = (tier: RankedTier) => `ranked-match/${tier.toUpperCase()}/pool.json`
const R2_RANKED_CUSTOM_KEY = 'ranked-match/CUSTOM/pool.json'
const DAY_MS = 24 * 60 * 60 * 1000
const MEMORY_CACHE_TTL_MS = 45_000
const SHEET_FETCH_TIMEOUT_MS = 25_000

export const DEFAULT_LEVEL: LevelItem = {
    name: 'default',
    version: 1,
    title: 'Default Level',
    artists: 'XX!',
    author: 'XX!',
    rating: 25,
    engine: 'pjsekai',
    cover: { hash: '', url: '' },
    bgm: { hash: '', url: '' },
    data: { hash: '', url: '' },
    tags: [],
}

type Row = {
    id: string
    input: string
    serverId: string
    privacy: string
    ranked: string
    playLevel: string
    difficulty: string
    constant: string
}

export type RankedCustomChart = SheetChart & {
    playLevel: number
    isAppend: boolean
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

export type RankedPoolResult = {
    tier: RankedTier
    customSongs: CustomSongsMode
    charts: SheetChart[]
    source: 'memory' | 'r2' | 'sheet' | 'stale-cache'
    durationMs: number
}

export async function refreshDailyAssets(
    env?: Env,
): Promise<{
    customLevelsCount: number
    playlistsCount: number
    errors: string[]
}> {
    const errors: string[] = []
    let customLevelsCount = 0
    let playlistsCount = 0

    // Force fresh read from Google Sheets by clearing in-memory cache first
    memoryCache.delete('custom-levels')
    memoryCache.delete('playlists')
    memoryCache.delete('edition-data')

    try {
        const rows = await customRows()

        const freshCharts = sanitizeCharts(buildCustomLevels(rows))
        if (freshCharts.length > 0) {
            writeMemory('custom-levels', freshCharts)
            customLevelsCount = freshCharts.length
            if (env?.SONOLUS_ASSETS_BUCKET) {
                await writeBucketJson(env, R2_LEVEL_LIST_KEY, freshCharts).catch((err) => {
                    errors.push(`R2 level list write failed: ${err instanceof Error ? err.message : String(err)}`)
                })
            }
        } else {
            const fallbackCharts = await getCustomLevels(env)
            customLevelsCount = fallbackCharts.length
        }

        const freshPlaylists = buildPlaylists(rows)
        if (freshPlaylists.length > 0) {
            writeMemory('playlists', freshPlaylists)
            playlistsCount = freshPlaylists.length
            if (env?.SONOLUS_ASSETS_BUCKET) {
                await writeBucketJson(env, R2_PLAYLISTS_KEY, freshPlaylists).catch((err) => {
                    errors.push(`R2 playlists write failed: ${err instanceof Error ? err.message : String(err)}`)
                })
            }
        } else {
            const fallbackPlaylists = await getPlaylists(env)
            playlistsCount = fallbackPlaylists.length
        }

        const constantsMap = buildConstantsMap(rows)
        if (Object.keys(constantsMap).length > 0 && env?.SONOLUS_ASSETS_BUCKET) {
            await writeBucketJson(env, R2_CONSTANTS_KEY, constantsMap).catch((err) => {
                errors.push(`R2 constants write failed: ${err instanceof Error ? err.message : String(err)}`)
            })
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`Sheet refresh failed: ${msg}`)

        const [fallbackCharts, fallbackPlaylists] = await Promise.all([
            getCustomLevels(env).catch(() => []),
            getPlaylists(env).catch(() => []),
        ])
        customLevelsCount = fallbackCharts.length
        playlistsCount = fallbackPlaylists.length
    }

    return {
        customLevelsCount,
        playlistsCount,
        errors,
    }
}

type StoredSnapshot<T> = {
    updatedAt: number
    data: T
}

type MemoryEntry<T> = {
    expiresAt: number
    data: T
}

const memoryCache = new Map<string, MemoryEntry<unknown>>()
const inFlightCache = new Map<string, Promise<unknown>>()

function readMemory<T>(key: string): T | null {
    const entry = memoryCache.get(key) as MemoryEntry<T> | undefined
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
        memoryCache.delete(key)
        return null
    }
    return entry.data
}

function writeMemory<T>(key: string, data: T, ttlMs = MEMORY_CACHE_TTL_MS): T {
    memoryCache.set(key, {
        expiresAt: Date.now() + ttlMs,
        data,
    })
    return data
}

async function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inFlightCache.get(key) as Promise<T> | undefined
    if (existing) return existing

    const promise = fn().finally(() => {
        if (inFlightCache.get(key) === promise) {
            inFlightCache.delete(key)
        }
    })

    inFlightCache.set(key, promise)
    return promise
}

export const stripTrailingSlash = (value: string) =>
    value.trim().replace(/\/+$/, '')

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
            signal: AbortSignal.timeout(SHEET_FETCH_TIMEOUT_MS),
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
    const raw = stripTrailingSlash(rawInput)
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
            address: stripTrailingSlash(url.origin),
            name,
        }
    } catch (error) {
        console.warn('[Sheets] Invalid level URL:', id, raw, error)
        return null
    }
}

function sanitizeCharts(raw: unknown): SheetChart[] {
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const valid: SheetChart[] = []

    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue
        const c = entry as Partial<SheetChart>
        const address = typeof c.address === 'string' ? stripTrailingSlash(c.address) : ''
        const name = typeof c.name === 'string' ? c.name.trim() : ''
        if (!address || !name) continue
        if (!/^https?:\/\//i.test(address)) continue
        const key = `${address.toLowerCase()}::${name.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        valid.push({
            id: typeof c.id === 'string' && c.id.trim() ? c.id.trim() : name,
            url: typeof c.url === 'string' && c.url.trim()
                ? c.url.trim()
                : `${address}/sonolus/levels/${encodeURIComponent(name)}`,
            address,
            name,
        })
    }

    return valid
}

function compareIdDescending(a: SheetChart, b: SheetChart): number {
    return b.id.localeCompare(a.id, undefined, {
        numeric: true,
        sensitivity: 'base',
    })
}

function findConstantColumn(headers: string[]): number {
    const exact = headers.indexOf('constant')
    if (exact >= 0) return exact

    return headers.findIndex((h) =>
        ['constant', 'const', 'song constant', 'chart constant', 'cc'].includes(h),
    )
}

function parseConstantValue(raw: string): number | null {
    const cleaned = normalizeId(raw).replace(',', '.')
    if (!cleaned) return null
    const num = Number(cleaned)
    if (!Number.isFinite(num) || num <= 0) return null
    return Math.round(num * 10) / 10
}

function parseCustomRows(values: string[][]): Row[] {
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
    const col = (name: string) => headers.indexOf(name)

    const idIndex = col('id')
    const inputIndex = col('input')
    const serverIdIndex = col('serverid')
    const privacyIndex = col('privacy')
    const rankedIndex = col('ranked')
    const playLevelIndex = col('playlevel')
    const difficultyIndex = col('difficulty')
    const constantIndex = findConstantColumn(headers)

    return values
        .slice(headerIndex + 1)
        .map((cells) => ({
            id: normalizeId(cells[idIndex]),
            input: stripTrailingSlash(normalizeId(cells[inputIndex])),
            serverId: normalizeId(cells[serverIdIndex]),
            privacy: normalizeId(cells[privacyIndex]),
            ranked: rankedIndex >= 0 ? normalizeId(cells[rankedIndex]) : '',
            playLevel: playLevelIndex >= 0 ? normalizeId(cells[playLevelIndex]) : '',
            difficulty: difficultyIndex >= 0 ? normalizeId(cells[difficultyIndex]) : '',
            constant: constantIndex >= 0 ? normalizeId(cells[constantIndex]) : '',
        }))
        .filter((row) => row.id && row.input)
}

async function customRows(): Promise<Row[]> {
    return parseCustomRows(await fetchSheet(CUSTOM_SHEET_ID, 'custom'))
}

function isCustomLevelId(id: string): boolean {
    const normalized = normalizeId(id).toUpperCase()
    return normalized.startsWith('60') || normalized.startsWith('X')
}

function isPublicLevel(row: Pick<Row, 'privacy' | 'serverId'>): boolean {
    const privacy = normalizeId(row.privacy).toLowerCase()
    const serverId = normalizeId(row.serverId)
    return privacy !== 'unlisted' && serverId !== '-'
}

export const CUSTOM_LEVEL_PAGE_SIZE = 10

function unwrapSnapshotData<T>(raw: unknown): { updatedAt: number; data: T } | null {
    if (!raw || typeof raw !== 'object') return null
    const snap = raw as Partial<StoredSnapshot<T>>
    if (typeof snap.updatedAt === 'number' && 'data' in snap) {
        return { updatedAt: snap.updatedAt, data: snap.data as T }
    }
    return null
}

async function readBucketJson<T>(
    env: Env | undefined,
    key: string,
    maxAgeMs = DAY_MS,
    allowExpired = false,
): Promise<T | null> {
    const bucket = env?.SONOLUS_ASSETS_BUCKET
    if (!bucket) return null

    try {
        const obj = await bucket.get(key)
        if (!obj) return null

        const rawJson = await obj.json()
        const snap = unwrapSnapshotData<T>(rawJson)
        if (!snap) {
            return rawJson as T
        }

        if (!allowExpired && Date.now() - snap.updatedAt > maxAgeMs) {
            return null
        }

        return snap.data
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
    const bucket = env?.SONOLUS_ASSETS_BUCKET
    if (!bucket) throw new Error('SONOLUS_ASSETS_BUCKET R2 binding is missing.')

    const payload: StoredSnapshot<T> = {
        updatedAt: Date.now(),
        data,
    }

    await bucket.put(key, JSON.stringify(payload), {
        httpMetadata: { contentType: 'application/json' },
    })
}

function buildCustomLevels(rows: Row[]): SheetChart[] {
    return rows
        .filter((row) => isCustomLevelId(row.id) && isPublicLevel(row))
        .map((row) => chartFromUrl(row.id, row.input))
        .filter((chart): chart is SheetChart => chart !== null)
        .sort(compareIdDescending)
}

function buildConstantsMap(rows: Row[]): Record<string, number> {
    const map: Record<string, number> = {}
    for (const row of rows) {
        const cleanInput = stripTrailingSlash(row.input)
        const val = parseConstantValue(row.constant)
        if (cleanInput && val !== null) {
            map[cleanInput] = val
        }
    }
    return map
}

export async function getConstantForAddress(
    address: string,
    env?: Env,
): Promise<number | null> {
    const cleanAddr = stripTrailingSlash(address)
    if (!cleanAddr) return null

    const cached = await readBucketJson<Record<string, number>>(env, R2_CONSTANTS_KEY)
    if (cached && typeof cached[cleanAddr] === 'number') {
        return cached[cleanAddr]!
    }

    const rows = await customRows()
    const map = buildConstantsMap(rows)
    if (Object.keys(map).length > 0) {
        await writeBucketJson(env, R2_CONSTANTS_KEY, map).catch(() => {})
    }
    return map[cleanAddr] ?? null
}

export async function getCustomLevels(env?: Env): Promise<SheetChart[]> {
    const mem = readMemory<SheetChart[]>('custom-levels')
    if (mem) return [...mem].sort(compareIdDescending)

    return dedupe('custom-levels', async () => {
        const cached = sanitizeCharts(await readBucketJson<unknown>(env, R2_LEVEL_LIST_KEY))
        if (cached.length > 0) {
            return writeMemory('custom-levels', cached)
        }

        try {
            const charts = sanitizeCharts(buildCustomLevels(await customRows()))
            if (charts.length > 0) {
                await writeBucketJson(env, R2_LEVEL_LIST_KEY, charts).catch((e) =>
                    console.warn('[R2] Could not cache level list:', e),
                )
                return writeMemory('custom-levels', charts)
            }
        } catch (err) {
            console.warn('[Sheets] Falling back to stale R2 level list:', err)
        }

        const stale = sanitizeCharts(
            await readBucketJson<unknown>(env, R2_LEVEL_LIST_KEY, DAY_MS * 30, true),
        )
        return writeMemory('custom-levels', stale)
    })
}

export async function loadLevelsByNames(
    names: string[],
    env?: Env,
): Promise<LevelItem[]> {
    if (!names.length) return []
    const charts = await getCustomLevels(env)
    const byName = new Map(charts.map((c) => [c.name, c]))
    const loaded: LevelItem[] = []

    for (const name of names) {
        const chart = byName.get(name)
        if (!chart) continue
        try {
            const endpoint = `${stripTrailingSlash(chart.address)}/sonolus/levels/${encodeURIComponent(chart.name)}`
            const res = await fetch(endpoint, {
                headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
                signal: AbortSignal.timeout(10000),
            })
            if (!res.ok) continue
            const data: any = await res.json()
            const item = data?.item ?? data
            if (item && typeof item.name === 'string') {
                loaded.push({
                    ...DEFAULT_LEVEL,
                    ...item,
                    source: chart.address,
                })
            }
        } catch {
            // skip unreachable level
        }
    }

    return loaded
}

export async function getCustomLevelPage(
    page: number,
    env?: Env,
): Promise<{ charts: SheetChart[]; pageCount: number }> {
    const all = await getCustomLevels(env)
    const safePage = Number.isInteger(page) && page >= 0 ? page : 0
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

function buildPlaylists(rows: Row[]): PlaylistData[] {
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
    const mem = readMemory<PlaylistData[]>('playlists')
    if (mem) return mem

    return dedupe('playlists', async () => {
        const cached = await readBucketJson<PlaylistData[]>(env, R2_PLAYLISTS_KEY)
        if (Array.isArray(cached) && cached.length > 0) {
            return writeMemory('playlists', cached)
        }

        try {
            const playlists = buildPlaylists(await customRows())
            if (playlists.length > 0) {
                await writeBucketJson(env, R2_PLAYLISTS_KEY, playlists).catch((e) =>
                    console.warn('[R2] Could not cache playlists:', e),
                )
                return writeMemory('playlists', playlists)
            }
        } catch (err) {
            console.warn('[Sheets] Falling back to stale R2 playlists:', err)
        }

        const stale = await readBucketJson<PlaylistData[]>(
            env,
            R2_PLAYLISTS_KEY,
            DAY_MS * 30,
            true,
        )
        return writeMemory('playlists', Array.isArray(stale) ? stale : [])
    })
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
    const mem = readMemory<EditionData>('edition-data')
    if (mem) return mem

    return dedupe('edition-data', async () => {
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

        return writeMemory('edition-data', {
            edition,
            groupStage: groupStage.sort(sortByNumber),
            final: final.sort(sortByNumber),
            divisions,
        }, 15_000)
    })
}

export async function getCurrentEdition(): Promise<string> {
    return (await getEditionData()).edition
}

export function clearSheetCache(): void {
    memoryCache.clear()
    inFlightCache.clear()
}

export const RANKED_TIERS = {
    master:   { main: [30, 37] as const, append: [28, 39] as const },
    diamond:  { main: [29, 32] as const, append: [27, 30] as const },
    platinum: { main: [28, 31] as const, append: null },
    gold:     { main: [26, 30] as const, append: null },
    silver:   { main: [25, 28] as const, append: null },
    bronze:   { main: [23, 27] as const, append: null },
    beginner: { main: [18, 25] as const, append: null },
} as const

export type RankedTier = keyof typeof RANKED_TIERS

/** Only inspect HR, EX, MS, and AP columns — never EZ or NM. */
const OFFICIAL_DIFFS = ['hr', 'ex', 'ms', 'ap'] as const
type OfficialDiff = typeof OFFICIAL_DIFFS[number]

const OFFICIAL_DIFF_ALIASES: Record<OfficialDiff, readonly string[]> = {
    hr: ['hr', 'hard'],
    ex: ['ex', 'expert'],
    ms: ['ms', 'master'],
    ap: ['ap', 'append'],
}

function inRange(level: number, range: readonly [number, number] | null): boolean {
    return !!range && level >= Math.max(18, range[0]) && level <= Math.min(39, range[1])
}

function resolveOfficialColumns(headers: string[]): Record<OfficialDiff, { levelCol: number; linkCol: number }> {
    const resolved = {} as Record<OfficialDiff, { levelCol: number; linkCol: number }>

    for (const diff of OFFICIAL_DIFFS) {
        const aliases = OFFICIAL_DIFF_ALIASES[diff]

        const levelCol = headers.findIndex((h) =>
            aliases.some((alias) =>
                h === `${alias}playlevel` ||
                h === `${alias}_playlevel` ||
                h === `${alias}level` ||
                h === `${alias}_level` ||
                h === `${alias}lvl` ||
                h === `${alias}_lvl`,
            ),
        )

        const linkCol = headers.findIndex((h) =>
            aliases.some((alias) =>
                h === alias ||
                h === `${alias}levellinksbuga` ||
                h === `${alias}_levellinksbuga` ||
                h === `${alias}link` ||
                h === `${alias}_link` ||
                h === `${alias}url` ||
                h === `${alias}_url` ||
                h === `${alias}chart` ||
                h === `${alias}_chart`,
            ),
        )

        resolved[diff] = { levelCol, linkCol }
    }

    return resolved
}

function buildOfficialTierPoolFromRows(values: string[][], tier: RankedTier): SheetChart[] {
    const cfg = RANKED_TIERS[tier]
    if (!cfg || !values.length) return []

    const headerRowIdx = values.findIndex((r) =>
        r.some((c) => ['hr', 'ex', 'ms', 'ap', 'master', 'append'].includes(normalizeId(c).toLowerCase())),
    )
    if (headerRowIdx < 0) return []

    const headers = values[headerRowIdx]!.map((c) => normalizeId(c).toLowerCase())
    const cols = resolveOfficialColumns(headers)
    const charts: SheetChart[] = []

    for (let r = headerRowIdx + 1; r < values.length; r++) {
        const cells = values[r]!
        for (const diff of OFFICIAL_DIFFS) {
            const { levelCol, linkCol } = cols[diff]
            if (levelCol < 0 || linkCol < 0) continue

            const lvl = Number(normalizeId(cells[levelCol]).replace(',', '.'))
            if (!Number.isFinite(lvl)) continue

            const isAppend = diff === 'ap'
            const allowed = isAppend ? inRange(lvl, cfg.append) : inRange(lvl, cfg.main)
            if (!allowed) continue

            const rawLink = normalizeId(cells[linkCol])
            if (!rawLink) continue

            const chart = chartFromUrl(`${tier.toUpperCase()}-${diff.toUpperCase()}-${r}`, rawLink)
            if (chart) charts.push(chart)
        }
    }

    return sanitizeCharts(charts)
}

function buildCustomRankedPoolFromRows(rows: Row[]): SheetChart[] {
    return sanitizeCharts(
        rows
            .filter((row) => {
                if (!isCustomLevelId(row.id) || !isPublicLevel(row)) return false
                const flag = normalizeId(row.ranked).toLowerCase()
                return flag === 'true' || flag === 'yes' || flag === '1' || flag === 'ranked'
            })
            .map((row) => chartFromUrl(row.id, row.input))
            .filter((chart): chart is SheetChart => chart !== null),
    )
}

export async function getRankedTierOfficialPool(
    tier: RankedTier,
    env?: Env,
): Promise<{ charts: SheetChart[]; source: 'memory' | 'r2' | 'sheet' | 'stale-cache' }> {
    const cleanTier: RankedTier = RANKED_TIERS[tier] ? tier : 'master'
    const key = rankedTierKey(cleanTier)
    const memKey = `ranked-official:${cleanTier}`

    const mem = readMemory<SheetChart[]>(memKey)
    if (mem && mem.length > 0) {
        return { charts: mem, source: 'memory' }
    }

    return dedupe(memKey, async () => {
        const cached = sanitizeCharts(await readBucketJson<unknown>(env, key))
        if (cached.length > 0) {
            return { charts: writeMemory(memKey, cached), source: 'r2' as const }
        }

        try {
            const rows = await fetchSheet(INDEX_SHEET_ID, METADATA_TAB)
            const built = buildOfficialTierPoolFromRows(rows, cleanTier)
            if (built.length > 0) {
                await writeBucketJson(env, key, built).catch((e) =>
                    console.warn(`[R2] Could not cache official pool ${key}:`, e),
                )
                return { charts: writeMemory(memKey, built), source: 'sheet' as const }
            }
        } catch (err) {
            console.warn(`[Ranked] Sheet fetch failed for ${cleanTier}, checking stale R2 cache:`, err)
        }

        const stale = sanitizeCharts(
            await readBucketJson<unknown>(env, key, DAY_MS * 30, true),
        )
        return {
            charts: stale.length > 0 ? writeMemory(memKey, stale) : [],
            source: 'stale-cache' as const,
        }
    })
}

export async function getRankedCustomPool(
    env?: Env,
): Promise<{ charts: SheetChart[]; source: 'memory' | 'r2' | 'sheet' | 'stale-cache' }> {
    const memKey = 'ranked-custom'
    const mem = readMemory<SheetChart[]>(memKey)
    if (mem && mem.length > 0) {
        return { charts: mem, source: 'memory' }
    }

    return dedupe(memKey, async () => {
        const cached = sanitizeCharts(await readBucketJson<unknown>(env, R2_RANKED_CUSTOM_KEY))
        if (cached.length > 0) {
            return { charts: writeMemory(memKey, cached), source: 'r2' as const }
        }

        try {
            const rows = await customRows()
            const built = buildCustomRankedPoolFromRows(rows)
            if (built.length > 0) {
                await writeBucketJson(env, R2_RANKED_CUSTOM_KEY, built).catch((e) =>
                    console.warn('[R2] Could not cache ranked custom pool:', e),
                )
                return { charts: writeMemory(memKey, built), source: 'sheet' as const }
            }
        } catch (err) {
            console.warn('[Ranked] Sheet fetch failed for custom pool, checking stale R2 cache:', err)
        }

        const stale = sanitizeCharts(
            await readBucketJson<unknown>(env, R2_RANKED_CUSTOM_KEY, DAY_MS * 30, true),
        )
        return {
            charts: stale.length > 0 ? writeMemory(memKey, stale) : [],
            source: 'stale-cache' as const,
        }
    })
}

export async function loadRankedPool(
    tier: RankedTier,
    customSongs: CustomSongsMode | boolean | string,
    env?: Env,
): Promise<RankedPoolResult> {
    const start = Date.now()
    const cleanTier: RankedTier = RANKED_TIERS[tier] ? tier : 'master'
    const mode = normalizeCustomSongsMode(customSongs)

    if (mode === 'off') {
        const offRes = await getRankedTierOfficialPool(cleanTier, env)
        return {
            tier: cleanTier,
            customSongs: mode,
            charts: offRes.charts,
            source: offRes.source,
            durationMs: Date.now() - start,
        }
    }

    if (mode === 'customOnly') {
        const customRes = await getRankedCustomPool(env)
        return {
            tier: cleanTier,
            customSongs: mode,
            charts: customRes.charts,
            source: customRes.source,
            durationMs: Date.now() - start,
        }
    }

    const [offRes, customRes] = await Promise.all([
        getRankedTierOfficialPool(cleanTier, env),
        getRankedCustomPool(env),
    ])

    const combined = sanitizeCharts([...offRes.charts, ...customRes.charts])
    const source: RankedPoolResult['source'] =
        offRes.source === 'memory' && customRes.source === 'memory'
            ? 'memory'
            : offRes.source === 'sheet' || customRes.source === 'sheet'
                ? 'sheet'
                : offRes.source === 'r2' || customRes.source === 'r2'
                    ? 'r2'
                    : 'stale-cache'

    return {
        tier: cleanTier,
        customSongs: mode,
        charts: combined,
        source,
        durationMs: Date.now() - start,
    }
}

export async function pickRankedLevel(
    tier: RankedTier,
    customSongs: CustomSongsMode | boolean | string,
    env?: Env,
    preloadedPool?: SheetChart[],
): Promise<SheetChart | null> {
    const start = Date.now()
    const cleanTier: RankedTier = RANKED_TIERS[tier] ? tier : 'master'
    const mode = normalizeCustomSongsMode(customSongs)

    const validPreloaded = sanitizeCharts(preloadedPool)
    if (validPreloaded.length > 0) {
        const picked = validPreloaded[Math.floor(Math.random() * validPreloaded.length)]!
        console.log('[Ranked] Selected chart from DO pool', {
            tier: cleanTier,
            customSongs: mode,
            poolSize: validPreloaded.length,
            source: 'do-storage',
            durationMs: Date.now() - start,
            chart: `${picked.address}/${picked.name}`,
        })
        return picked
    }

    const loaded = await loadRankedPool(cleanTier, mode, env)
    if (loaded.charts.length === 0) {
        console.warn('[Ranked] No charts available in pool', {
            tier: cleanTier,
            customSongs: mode,
            source: loaded.source,
            durationMs: loaded.durationMs,
        })
        return null
    }

    const picked = loaded.charts[Math.floor(Math.random() * loaded.charts.length)]!
    console.log('[Ranked] Selected chart', {
        tier: cleanTier,
        customSongs: mode,
        poolSize: loaded.charts.length,
        source: loaded.source,
        durationMs: loaded.durationMs,
        chart: `${picked.address}/${picked.name}`,
    })
    return picked
}