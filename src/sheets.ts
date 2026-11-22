const CUSTOM_SHEET_ID = '1Fpp_sJbGjuKxUAcWhZOM1YqHJJrUHTWE56lO4dthhak'
const INDEX_SHEET_ID = '1mBDbWoTsZlg-tgdnX7DBCSX1bx6EdEFIaKW6Gb4SkC8'
const INDEX_SHEET_TAB = 'index'

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
        console.log(`[Sheets] Exact tab request: ${url}`)

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

        console.log(`[Sheets] Successfully read ${parsed.length} rows from tab "${tab}".`)

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

        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return null
        }

        const match = url.pathname.match(/\/levels\/([^/]+)\/?$/i)

        if (!match) {
            console.warn('[Sheets] Level URL has no /levels/{name} path:', id, raw)
            return null
        }

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

    const headers = values[headerIndex]!.map((cell) =>
        normalizeId(cell).toLowerCase(),
    )

    const idIndex = headers.indexOf('id')
    const inputIndex = headers.indexOf('input')
    const serverIdIndex = headers.indexOf('serverid')
    const privacyIndex = headers.indexOf('privacy')

    const result = values
        .slice(headerIndex + 1)
        .map((cells) => ({
            id: normalizeId(cells[idIndex]),
            input: normalizeId(cells[inputIndex]),
            serverId: normalizeId(cells[serverIdIndex]),
            privacy: normalizeId(cells[privacyIndex]),
        }))
        .filter((row) => row.id && row.input)

    console.log(`[Sheets] Read ${result.length} rows from custom tab.`)

    return result
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

export async function getCustomLevelPage(page: number): Promise<{ charts: SheetChart[]; pageCount: number }> {
    const all = await getCustomLevels()
    const safePage = Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0
    const pageCount = Math.max(1, Math.ceil(all.length / CUSTOM_LEVEL_PAGE_SIZE))
    const start = safePage * CUSTOM_LEVEL_PAGE_SIZE

    return {
        charts: all.slice(start, start + CUSTOM_LEVEL_PAGE_SIZE),
        pageCount,
    }
}

export async function getCustomLevels(): Promise<SheetChart[]> {
    const rows = await customRows()

    const matchingRows = rows.filter((row) => isCustomLevelId(row.id))
    const publicRows = matchingRows.filter(isPublicLevel)

    const charts = publicRows
        .map((row) => chartFromUrl(row.id, row.input))
        .filter((chart): chart is SheetChart => chart !== null)
        .sort(compareIdDescending)

    console.log(
        `[Sheets] Levels: ${charts.length} valid public charts from ${matchingRows.length} matching IDs. ${matchingRows.length - publicRows.length} excluded by privacy/serverId.`,
    )

    console.log(
        '[Sheets] Public level IDs:',
        charts.map((chart) => chart.id).join(', '),
    )

    return charts
}

function suduPlaylistName(id: string): string | null {
    const match = normalizeId(id).toUpperCase().match(/^D(\d{2})/)

    if (!match) return null

    return `SUDU-${match[1]!.padStart(3, '0')}`
}

export async function getPlaylists(): Promise<PlaylistData[]> {
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

            if (xMatch) {
                title = `XX! Championship 20${xMatch[1]}`
            }
        }

        if (!title) continue

        const list = groups.get(title) ?? []
        list.push(chart)
        groups.set(title, list)
    }

    const playlists = [...groups.entries()]
        .map(([name, items]) => ({
            name,
            charts: items.sort(compareIdDescending),
        }))
        .sort((a, b) => {
            const aSudu = a.name.match(/^SUDU-(\d+)$/)
            const bSudu = b.name.match(/^SUDU-(\d+)$/)

            if (aSudu && bSudu) {
                return Number(aSudu[1]) - Number(bSudu[1])
            }

            if (aSudu) return -1
            if (bSudu) return 1

            return a.name.localeCompare(b.name, undefined, {
                numeric: true,
            })
        })

    console.log(
        `[Sheets] Playlists: ${playlists.length}.`,
        playlists.map((playlist) => `${playlist.name} (${playlist.charts.length})`).join(', '),
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
    console.log(`[INDEX] Reading spreadsheet ${INDEX_SHEET_ID}, tab "${INDEX_SHEET_TAB}".`)

    const rows = await fetchSheet(INDEX_SHEET_ID, INDEX_SHEET_TAB)

    if (rows.length < 2) {
        throw new Error(`The "${INDEX_SHEET_TAB}" tab must contain a header row and at least one edition row.`)
    }

    const headers = rows[0]!.map((cell) => normalizeId(cell))
    const normalized = headers.map((cell) => cell.toUpperCase())

    if (normalizeId(headers[0]).toLowerCase() !== 'index') {
        throw new Error(
            `[INDEX] Wrong tab data received. Expected cell A1 to be "Index" from the "${INDEX_SHEET_TAB}" tab, received "${headers[0] ?? ''}". Refusing to load another tab.`,
        )
    }

    if (!normalized.includes('G1') || !normalized.includes('F1')) {
        throw new Error(
            `[INDEX] The "${INDEX_SHEET_TAB}" tab has an unexpected header row. Expected G1 and F1 columns.`,
        )
    }

    console.log(`[INDEX] Verified tab "${INDEX_SHEET_TAB}". A1="${headers[0]}". Headers:`, headers)

    let activeRow: string[] | null = null

    for (let i = rows.length - 1; i >= 1; i--) {
        const row = rows[i]!

        if (normalizeId(row[0])) {
            activeRow = row
            break
        }
    }

    if (!activeRow) {
        throw new Error(`No edition was found in column A of the "${INDEX_SHEET_TAB}" tab.`)
    }

    const edition = normalizeId(activeRow[0])

    if (!edition) {
        throw new Error(`The current edition name in column A of the "${INDEX_SHEET_TAB}" tab is empty.`)
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
            const id = groupMatch
                ? `G${groupMatch[1]}`
                : `F${finalMatch![1]}`

            const chart = chartFromUrl(id, value)

            if (!chart) {
                console.warn(`[INDEX] Invalid ${id} URL:`, value)
                continue
            }

            if (groupMatch) {
                groupStage.push(chart)
            } else {
                final.push(chart)
            }

            continue
        }

        if (isGroupHeader(header)) {
            for (const handle of splitHandles(value)) {
                divisions[handle] = `Group ${header}`
            }

            continue
        }

        if (header === 'UB' || header === 'LB') {
            const division = header === 'UB'
                ? 'Upper Bracket'
                : 'Lower Bracket'

            for (const handle of splitHandles(value)) {
                divisions[handle] = division
            }
        }
    }

    const sortByNumber = (a: SheetChart, b: SheetChart) =>
        Number(a.id.slice(1)) - Number(b.id.slice(1))

    const result: EditionData = {
        edition,
        groupStage: groupStage.sort(sortByNumber),
        final: final.sort(sortByNumber),
        divisions,
    }

    console.log(`[INDEX] Current edition from "${INDEX_SHEET_TAB}"!A${rows.indexOf(activeRow) + 1}:`, edition)
    console.log('[INDEX] Group Stage songs:', groupStage.length, groupStage)
    console.log('[INDEX] Final songs:', final.length, final)
    console.log('[INDEX] Divisions:', divisions)

    return result
}

export async function getCurrentEdition(): Promise<string> {
    return (await getEditionData()).edition
}

export function clearSheetCache(): void {
    // Sheets are read fresh on every request.
}


// ───────────────────────── Ranked Match song pool ─────────────────────────

const METADATA_TAB = 'METADATA_RAW'

/** [min, max] play level per tier. `append` = range for APPEND charts (only master and diamond use them). */
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

// Short cache so clicking "select" several times does not re-download the whole metadata sheet.
const METADATA_CACHE_MS = 2 * 60_000
let metadataCache: { at: number; values: string[][] } | null = null

async function metadataRows(): Promise<string[][]> {
    if (metadataCache && Date.now() - metadataCache.at < METADATA_CACHE_MS) {
        return metadataCache.values
    }

    const values = await fetchSheet(CUSTOM_SHEET_ID, METADATA_TAB)
    metadataCache = { at: Date.now(), values }

    return values
}

/** Official songs: every difficulty whose play level fits the tier (links from <diff>LevelLinkSbuga). */
async function officialRankedPool(tier: RankedTier): Promise<SheetChart[]> {
    const values = await metadataRows()

    const headerIndex = values.findIndex((row) =>
        row.some((cell) => normalizeId(cell).toLowerCase().endsWith('levellinksbuga')),
    )

    if (headerIndex < 0) throw new Error('METADATA_RAW header row not found.')

    const headers = values[headerIndex]!.map((cell) => normalizeId(cell).toLowerCase())
    const idCol = headers.indexOf('id')
    const rules = RANKED_TIERS[tier]
    const pool: SheetChart[] = []

    const usable = OFFICIAL_DIFFS.filter(
        (diff) =>
            headers.includes(`${diff}playlevel`) &&
            headers.includes(`${diff}levellinksbuga`),
    )

    for (const cells of values.slice(headerIndex + 1)) {
        for (const diff of usable) {
            const levelCol = headers.indexOf(`${diff}playlevel`)
            const linkCol = headers.indexOf(`${diff}levellinksbuga`)

            const rawLevel = normalizeId(cells[levelCol])
            const link = normalizeId(cells[linkCol])

            if (!rawLevel || !link || link === '-') continue

            const level = Number(rawLevel)

            if (!Number.isFinite(level)) continue

            const fits = diff === 'ap'
                ? inRange(level, rules.append)
                : inRange(level, rules.main)

            if (!fits) continue

            const chart = chartFromUrl(`${normalizeId(cells[idCol])}-${diff}`, link)
            if (chart) pool.push(chart)
        }
    }

    console.log(
        `[Ranked] Official pool for ${tier}: ${pool.length} charts (difficulty columns found: ${usable.join(', ') || 'none'}).`,
    )

    return pool
}

/** Custom songs: rows of the custom tab with Ranked = true (playLevel + difficulty columns). */
async function customRankedPool(tier: RankedTier): Promise<SheetChart[]> {
    const values = await fetchSheet(CUSTOM_SHEET_ID, 'custom')

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

        if (!Number.isFinite(level)) continue
        if (!inRange(level, isAppend ? rules.append : rules.main)) continue

        const chart = chartFromUrl(id, row.input)
        if (chart) pool.push(chart)
    }

    console.log(`[Ranked] Custom pool for ${tier}: ${pool.length} charts.`)

    return pool
}

/** Random level of the ranked list for this tier. `exclude` (the current level) is avoided when possible. */
export async function pickRankedLevel(
    tier: RankedTier,
    includeCustom: boolean,
    exclude?: { address: string; name: string } | null,
): Promise<SheetChart | null> {
    const official = await officialRankedPool(tier)

    let custom: SheetChart[] = []

    if (includeCustom) {
        try {
            custom = await customRankedPool(tier)
        } catch (error) {
            console.error('[Ranked] Could not read the custom ranked pool:', error)
        }
    }

    const all = [...official, ...custom]

    if (all.length === 0) return null

    const others = exclude
        ? all.filter(
            (chart) => !(chart.address === exclude.address && chart.name === exclude.name),
        )
        : all

    const pool = others.length > 0 ? others : all

    return pool[Math.floor(Math.random() * pool.length)]!
}
