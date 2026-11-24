import type { CustomSongsMode, RankedVocalType } from './forms.ts'
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
const SHEET_FETCH_TIMEOUT_MS = 90000

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
    musicVocalIds?: number[]
    sekaiVocalVersion?: number
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

async function readBucketJson<T>(
    env: Env | undefined,
    key: string,
    maxAgeMs = DAY_MS,
): Promise<T | null> {
    const bucket = env?.SONOLUS_ASSETS_BUCKET
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
    await writeBucketJson(env, R2_CONSTANTS_KEY, map).catch(() => {})
    return map[cleanAddr] ?? null
}

export async function getCustomLevels(env?: Env): Promise<SheetChart[]> {
    const cached = await readBucketJson<SheetChart[]>(env, R2_LEVEL_LIST_KEY)
    if (cached) return [...cached].sort(compareIdDescending)

    const charts = buildCustomLevels(await customRows())
    await writeBucketJson(env, R2_LEVEL_LIST_KEY, charts).catch((e) =>
        console.warn('[R2] Could not cache level list:', e),
    )
    return charts
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
    const cached = await readBucketJson<PlaylistData[]>(env, R2_PLAYLISTS_KEY)
    if (cached) return cached

    const playlists = buildPlaylists(await customRows())
    await writeBucketJson(env, R2_PLAYLISTS_KEY, playlists).catch((e) =>
        console.warn('[R2] Could not cache playlists:', e),
    )
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
                h === `${alias}_url`,
            ),
        )

        resolved[diff] = { levelCol, linkCol }
    }

    return resolved
}

function parseMusicVocalIds(raw: string): number[] {
    return (raw.match(/\d+/g) ?? [])
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0)
}

function applyRankedVocalType(
    chart: SheetChart,
    vocalType: RankedVocalType,
): SheetChart {
    if (vocalType !== 'sekai' || !chart.sekaiVocalVersion || !chart.musicVocalIds) {
        return chart
    }

    const vocalId = chart.musicVocalIds[chart.sekaiVocalVersion - 1]
    if (!vocalId) return chart

    const match = chart.name.match(/^(.*-\d+)-\d+-(hard|expert|master|append)$/i)
    if (!match) return chart

    return {
        ...chart,
        name: `${match[1]}-${vocalId}-${match[2]}`,
    }
}

function officialRankedPoolFromSheet(
    values: string[][],
    tier: RankedTier,
): SheetChart[] {
    const headerIndex = values.findIndex((row) => {
        const lower = row.map((cell) => normalizeId(cell).toLowerCase())
        return (
            lower.includes('hrlevellinksbuga') ||
            lower.includes('hr') ||
            lower.includes('hrplaylevel')
        )
    })
    if (headerIndex < 0) throw new Error('METADATA_RAW header row not found.')

        const headers = values[headerIndex]!.map((cell) => normalizeId(cell).toLowerCase())
    const idCol = headers.indexOf('id')
    const musicVocalIdsCol = headers.indexOf('musicvocalids')
    const vocalTypeCols = Array.from(
        { length: 12 },
        (_, index) => headers.indexOf(`v${index + 2}musicvocaltype`),
    )
    const cols = resolveOfficialColumns(headers)
    const rules = RANKED_TIERS[tier]
    const pool: SheetChart[] = []

    for (let rowIdx = headerIndex + 1; rowIdx < values.length; rowIdx++) {
        const cells = values[rowIdx]!
                const musicVocalIds = musicVocalIdsCol >= 0
            ? parseMusicVocalIds(normalizeId(cells[musicVocalIdsCol]))
            : []

        const sekaiVocalVersionIndex = vocalTypeCols.findIndex((col) =>
            col >= 0 && normalizeId(cells[col]).toLowerCase().includes('sekai'),
        )

        const sekaiVocalVersion = sekaiVocalVersionIndex >= 0
            ? sekaiVocalVersionIndex + 2
            : undefined
        const rowId = idCol >= 0 && normalizeId(cells[idCol])
            ? normalizeId(cells[idCol])
            : String(rowIdx)

        for (const diff of OFFICIAL_DIFFS) {
            const { levelCol, linkCol } = cols[diff]
            if (levelCol < 0 || linkCol < 0) continue

            const level = Number(normalizeId(cells[levelCol]))
            const link = stripTrailingSlash(normalizeId(cells[linkCol]))
            if (!Number.isFinite(level) || !link || link === '-') continue

            const fits = diff === 'ap'
                ? inRange(level, rules.append)
                : inRange(level, rules.main)
            if (!fits) continue

                        const chart = chartFromUrl(`${rowId}-${diff}`, link)
            if (chart) {
                pool.push({
                    ...chart,
                    musicVocalIds,
                    ...(sekaiVocalVersion ? { sekaiVocalVersion } : {}),
                })
            }
        }
    }

    return pool
}

function buildAllCustomRanked(rows: Row[]): RankedCustomChart[] {
    const ALLOWED_CUSTOM_DIFFS = new Set(['hr', 'hard', 'ex', 'expert', 'ms', 'master', 'ap', 'append'])
    const pool: RankedCustomChart[] = []

    for (const row of rows) {
        if (!isCustomLevelId(row.id)) continue
        if (row.ranked.toLowerCase() !== 'true') continue
        if (!isPublicLevel(row)) continue

        const diffLower = row.difficulty.trim().toLowerCase()
        if (diffLower && !ALLOWED_CUSTOM_DIFFS.has(diffLower)) continue

        const playLevel = Number(row.playLevel)
        if (!Number.isFinite(playLevel) || playLevel < 18 || playLevel > 39) continue

        const chart = chartFromUrl(row.id, row.input)
        if (!chart) continue

        pool.push({
            ...chart,
            playLevel,
            isAppend: diffLower === 'append' || diffLower === 'ap',
        })
    }

    return pool
}

function filterCustomRankedForTier(
    allCustom: RankedCustomChart[],
    tier: RankedTier,
): SheetChart[] {
    const rules = RANKED_TIERS[tier]
    return allCustom.filter((item) =>
        inRange(item.playLevel, item.isAppend ? rules.append : rules.main),
    )
}

async function getRankedTierOfficialPool(tier: RankedTier, env?: Env): Promise<SheetChart[]> {
    const cached = await readBucketJson<SheetChart[]>(env, rankedTierKey(tier))
    if (cached) return cached

    const metaRows = await fetchSheet(CUSTOM_SHEET_ID, METADATA_TAB)
    const charts = officialRankedPoolFromSheet(metaRows, tier)
    await writeBucketJson(env, rankedTierKey(tier), charts).catch((e) =>
        console.warn(`[R2] Could not cache ranked tier ${tier}:`, e),
    )
    return charts
}

async function getRankedCustomPool(tier: RankedTier, env?: Env): Promise<SheetChart[]> {
    const cached = await readBucketJson<RankedCustomChart[]>(env, R2_RANKED_CUSTOM_KEY, Number.POSITIVE_INFINITY)
    if (cached === null) throw new Error(`R2 ranked custom pool missing: ${R2_RANKED_CUSTOM_KEY}`)
    return filterCustomRankedForTier(cached, tier)
}

export async function pickRankedLevel(
    tier: RankedTier,
    customSongs: CustomSongsMode,
    vocalType: RankedVocalType,
    env?: Env,
): Promise<SheetChart | null> {
    const official = customSongs === 'customOnly'
        ? []
        : await getRankedTierOfficialPool(tier, env)
    const custom = customSongs === 'off'
        ? []
        : await getRankedCustomPool(tier, env)

    const pool = [...official, ...custom]
    if (pool.length === 0) return null

    const selected = pool[Math.floor(Math.random() * pool.length)]!
    return applyRankedVocalType(selected, vocalType)
}

export type RefreshSummary = {
    levels: number | null
    playlists: number | null
    constants: number | null
    rankedCustom: number | null
    rankedTiers: Partial<Record<RankedTier, number>>
    errors: string[]
}

export async function refreshDailyAssets(env: Env): Promise<RefreshSummary> {
    console.log('[Refresh] Starting R2 refresh on SONOLUS_ASSETS_BUCKET...')
    const summary: RefreshSummary = {
        levels: null,
        playlists: null,
        constants: null,
        rankedCustom: null,
        rankedTiers: {},
        errors: [],
    }

    try {
        const rows = await customRows()

        const customCharts = buildCustomLevels(rows)
        await writeBucketJson(env, R2_LEVEL_LIST_KEY, customCharts)
        summary.levels = customCharts.length

        const playlists = buildPlaylists(rows)
        await writeBucketJson(env, R2_PLAYLISTS_KEY, playlists)
        summary.playlists = playlists.length

        const constantsMap = buildConstantsMap(rows)
        await writeBucketJson(env, R2_CONSTANTS_KEY, constantsMap)
        summary.constants = Object.keys(constantsMap).length

        const allCustomRanked = buildAllCustomRanked(rows)
        await writeBucketJson(env, R2_RANKED_CUSTOM_KEY, allCustomRanked)
        summary.rankedCustom = allCustomRanked.length
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error('[Refresh] Failed custom tab step:', msg)
        summary.errors.push(`custom: ${msg}`)
    }

    try {
        const metaRows = await fetchSheet(CUSTOM_SHEET_ID, METADATA_TAB)
        for (const tier of Object.keys(RANKED_TIERS) as RankedTier[]) {
            const charts = officialRankedPoolFromSheet(metaRows, tier)
            await writeBucketJson(env, rankedTierKey(tier), charts)
            summary.rankedTiers[tier] = charts.length
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error('[Refresh] Failed METADATA_RAW step:', msg)
        summary.errors.push(`metadata: ${msg}`)
    }

    return summary
}
