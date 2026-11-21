
const CUSTOM_SHEET_ID = '1Fpp_sJbGjuKxUAcWhZOM1YqHJJrUHTWE56lO4dthhak'
const INDEX_SHEET_ID = '1mBDbWoTsZlg-tgdnX7DBCSX1bx6EdEFIaKW6Gb4SkC8'

type Row = {
    id: string
    input: string
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
    const urls = [
        `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&sheet=${encodeURIComponent(tab)}&t=${Date.now()}`,
        `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}&t=${Date.now()}`,
    ]

    let lastError: unknown = null

    for (const endpoint of urls) {
        try {
            const response = await fetch(endpoint, {
                headers: {
                    Accept: 'text/csv,text/plain,*/*',
                    'Cache-Control': 'no-cache',
                },
                signal: AbortSignal.timeout(15000),
                cache: 'no-store',
            })

            if (!response.ok) {
                throw new Error(`Google Sheets HTTP ${response.status}`)
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
            lastError = error
            console.warn(`Could not read Google Sheet tab "${tab}" from endpoint:`, error)
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error(`Could not read Google Sheet tab "${tab}".`)
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
            console.warn(`Invalid protocol for chart ${id}:`, raw)
            return null
        }

        const match = url.pathname.match(/\/levels\/([^/]+)\/?$/i)

        if (!match) {
            console.warn(`Chart ${id} has no valid /levels/{name} URL:`, raw)
            return null
        }

        const name = decodeURIComponent(match[1]!)

        if (!name) {
            console.warn(`Chart ${id} has an empty level name:`, raw)
            return null
        }

        return {
            id,
            url: raw,
            address: url.origin,
            name,
        }
    } catch (error) {
        console.warn(`Invalid level URL for chart ${id}:`, raw, error)
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
        return headers.includes('id') && headers.includes('input')
    })

    if (headerIndex < 0) {
        throw new Error('The custom tab must contain headers named id and input.')
    }

    const headers = values[headerIndex]!.map((cell) =>
        normalizeId(cell).toLowerCase(),
    )

    const idIndex = headers.indexOf('id')
    const inputIndex = headers.indexOf('input')

    const result = values
        .slice(headerIndex + 1)
        .map((cells) => ({
            id: normalizeId(cells[idIndex]),
            input: String(cells[inputIndex] ?? '').trim(),
        }))
        .filter((row) => row.id && row.input)

    console.log(
        `[Sheets] Read ${result.length} usable rows from custom tab.`,
        `First IDs: ${result.slice(0, 10).map((row) => row.id).join(', ')}`,
    )

    return result
}

function isCustomLevelId(id: string): boolean {
    const normalized = normalizeId(id).toUpperCase()
    return normalized.startsWith('60') || normalized.startsWith('X')
}

export async function getCustomLevels(): Promise<SheetChart[]> {
    const rows = await customRows()

    const matchingRows = rows.filter((row) => isCustomLevelId(row.id))

    const charts = matchingRows
        .map((row) => chartFromUrl(row.id, row.input))
        .filter((chart): chart is SheetChart => chart !== null)
        .sort(compareIdDescending)

    console.log(
        `[Sheets] Custom levels: ${charts.length} valid charts from ${matchingRows.length} matching IDs.`,
        `IDs: ${charts.map((chart) => chart.id).join(', ')}`,
    )

    return charts
}

function suduPlaylistName(id: string): string | null {
    const match = normalizeId(id).toUpperCase().match(/^D(\d{2})/)

    if (!match) return null

    const editionNumber = Number(match[1])

    if (!Number.isFinite(editionNumber)) return null

    return `SUDU-${String(editionNumber).padStart(3, '0')}`
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
    const rows = await fetchSheet(INDEX_SHEET_ID, 'index')

    if (rows.length < 3) {
        throw new Error('The index tab needs headers on row 2 and edition data below.')
    }

    const headers = rows[1]!.map((cell) => cell.trim())
    const normalized = headers.map((cell) => cell.toUpperCase())
    const dataRows = rows.slice(2)

    let editionColumn = normalized.findIndex((header) =>
        ['EDITION', 'SEASON', 'TOURNAMENT'].includes(header),
    )

    if (
        editionColumn < 0 &&
        headers.length > 0 &&
        !isGroupHeader(normalized[0] ?? '') &&
        !['UB', 'LB'].includes(normalized[0] ?? '') &&
        !/^G\d+$/.test(normalized[0] ?? '') &&
        !/^F\d+$/.test(normalized[0] ?? '')
    ) {
        editionColumn = 0
    }

    const hasSongColumns = normalized.some((header) =>
        /^G\d+$/.test(header) || /^F\d+$/.test(header),
    )

    let activeRow: string[] | null = null

    if (editionColumn >= 0) {
        for (let i = dataRows.length - 1; i >= 0; i--) {
            if ((dataRows[i]?.[editionColumn] ?? '').trim()) {
                activeRow = dataRows[i]!
                break
            }
        }
    }

    if (!activeRow && hasSongColumns) {
        for (let i = dataRows.length - 1; i >= 0; i--) {
            const row = dataRows[i]!
            const hasSongs = normalized.some((header, column) =>
                (/^G\d+$/.test(header) || /^F\d+$/.test(header)) &&
                Boolean((row[column] ?? '').trim()),
            )

            if (hasSongs) {
                activeRow = row
                break
            }
        }
    }

    if (!activeRow) {
        throw new Error('Could not determine the current edition row in the index tab.')
    }

    const edition =
        editionColumn >= 0
            ? (activeRow[editionColumn] ?? '').trim()
            : 'CURRENT EDITION'

    const groupStage: SheetChart[] = []
    const final: SheetChart[] = []
    const divisions: Record<string, string> = {}

    for (let column = 0; column < headers.length; column++) {
        const header = normalized[column] ?? ''
        const value = (activeRow[column] ?? '').trim()

        if (!value) continue

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
            continue
        }

        const groupMatch = header.match(/^G(\d+)$/)
        const finalMatch = header.match(/^F(\d+)$/)

        if (!groupMatch && !finalMatch) continue

        const id = groupMatch
            ? `G${groupMatch[1]}`
            : `F${finalMatch![1]}`

        const chart = chartFromUrl(id, value)
        if (!chart) continue

        if (groupMatch) {
            groupStage.push(chart)
        } else {
            final.push(chart)
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
    // Sheets are read fresh on every request.
}