
const CUSTOM_SHEET_ID = '1Fpp_sJbGjuKxUAcWhZOM1YqHJJrUHTWE56lO4dthhak'
const INDEX_SHEET_ID = '1mBDbWoTsZlg-tgdnX7DBCSX1bx6EdEFIaKW6Gb4SkC8'
const CACHE_MS = 30_000

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
}

export type PlaylistData = {
    name: string
    charts: SheetChart[]
}

let customCache: { time: number; rows: Row[] } | null = null
let indexCache: { time: number; rows: string[][] } | null = null
let customPending: Promise<Row[]> | null = null
let indexPending: Promise<string[][]> | null = null

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

async function fetchSheet(
    id: string,
    tab: string,
): Promise<string[][]> {
    const url = new URL(
        `https://docs.google.com/spreadsheets/d/${id}/gviz/tq`,
    )

    url.searchParams.set('tqx', 'out:csv')
    url.searchParams.set('sheet', tab)

    const response = await fetch(url.toString(), {
        headers: {
            Accept: 'text/csv,text/plain,*/*',
        },
        signal: AbortSignal.timeout(12_000),
    })

    if (!response.ok) {
        throw new Error(
            `Google Sheets returned HTTP ${response.status} for "${tab}".`,
        )
    }

    const content = await response.text()
    const trimmed = content.trimStart()

    if (
        !trimmed ||
        trimmed.startsWith('<!DOCTYPE') ||
        trimmed.startsWith('<html') ||
        trimmed.startsWith('google.visualization')
    ) {
        throw new Error(
            `Could not read the "${tab}" tab as CSV.`,
        )
    }

    return parseCSV(content)
}

async function customRows(): Promise<Row[]> {
    if (customCache && Date.now() - customCache.time < CACHE_MS) {
        return customCache.rows
    }

    if (customPending) return customPending

    customPending = (async () => {
        const values = await fetchSheet(CUSTOM_SHEET_ID, 'custom')

        if (!values.length) return []

        const headers = values[0]!.map((x) => x.trim().toLowerCase())
        const idIndex = headers.indexOf('id')
        const inputIndex = headers.indexOf('input')

        if (idIndex < 0 || inputIndex < 0) {
            throw new Error(
                'The custom tab needs columns named id and input.',
            )
        }

        const rows = values.slice(1).map((cells) => ({
            id: (cells[idIndex] ?? '').trim(),
            input: (cells[inputIndex] ?? '').trim(),
        }))

        customCache = {
            time: Date.now(),
            rows,
        }

        return rows
    })()

    try {
        return await customPending
    } finally {
        customPending = null
    }
}

async function indexRows(): Promise<string[][]> {
    if (indexCache && Date.now() - indexCache.time < CACHE_MS) {
        return indexCache.rows
    }

    if (indexPending) return indexPending

    indexPending = (async () => {
        const rows = await fetchSheet(INDEX_SHEET_ID, 'index')

        indexCache = {
            time: Date.now(),
            rows,
        }

        return rows
    })()

    try {
        return await indexPending
    } finally {
        indexPending = null
    }
}

function chartFromUrl(
    id: string,
    rawUrl: string,
): SheetChart | null {
    try {
        const url = new URL(rawUrl)

        if (url.protocol !== 'https:') return null

        const match = url.pathname.match(/\/levels\/([^/]+)\/?$/)
        if (!match) return null

        return {
            id,
            url: rawUrl,
            address: url.origin,
            name: decodeURIComponent(match[1]!),
        }
    } catch {
        return null
    }
}

function compareIdDescending(
    a: SheetChart,
    b: SheetChart,
): number {
    return b.id.localeCompare(a.id, undefined, {
        numeric: true,
        sensitivity: 'base',
    })
}

export async function getCustomLevels(): Promise<SheetChart[]> {
    const rows = await customRows()

    return rows
        .filter((row) => /^(60|X)/i.test(row.id))
        .map((row) => chartFromUrl(row.id, row.input))
        .filter((chart): chart is SheetChart => chart !== null)
        .sort(compareIdDescending)
}

export async function getPlaylists(): Promise<PlaylistData[]> {
    const rows = await customRows()

    const charts = rows
        .filter((row) => /^(X|D)/i.test(row.id))
        .map((row) => chartFromUrl(row.id, row.input))
        .filter((chart): chart is SheetChart => chart !== null)

    const groups = new Map<string, SheetChart[]>()

    for (const chart of charts) {
        const dMatch = chart.id.match(/^D(\d+)/i)
        const xMatch = chart.id.match(/^X(\d+)/i)

        let title: string | null = null

        if (dMatch) {
            title = `SUDU ${dMatch[1]}`
        } else if (xMatch) {
            title = `XX! Championship 20${xMatch[1]}`
        }

        if (!title) continue

        const group = groups.get(title) ?? []
        group.push(chart)
        groups.set(title, group)
    }

    return [...groups.entries()]
        .map(([name, items]) => ({
            name,
            charts: items.sort(compareIdDescending),
        }))
        .sort((a, b) => {
            const aD = a.name.match(/^SUDU (\d+)$/)
            const bD = b.name.match(/^SUDU (\d+)$/)

            if (aD && bD) {
                return Number(aD[1]) - Number(bD[1])
            }

            if (aD) return -1
            if (bD) return 1

            return a.name.localeCompare(
                b.name,
                undefined,
                { numeric: true },
            )
        })
}

export async function getEditionData(): Promise<EditionData> {
    const rows = await indexRows()

    if (rows.length < 3) {
        throw new Error(
            'The index tab needs headers on row 2 and edition data below.',
        )
    }

    const headers = rows[1]!.map((x) => x.trim())
    const dataRows = rows.slice(2)

    let activeRow: string[] | null = null

    for (let i = dataRows.length - 1; i >= 0; i--) {
        if ((dataRows[i]?.[0] ?? '').trim()) {
            activeRow = dataRows[i]!
            break
        }
    }

    if (!activeRow) {
        throw new Error(
            'No current edition was found in column A of the index tab.',
        )
    }

    const edition = (activeRow[0] ?? '').trim()
    const groupStage: SheetChart[] = []
    const final: SheetChart[] = []

    for (let i = 0; i < headers.length; i++) {
        const header = headers[i]!.trim().toUpperCase()
        const rawUrl = (activeRow[i] ?? '').trim()

        if (!rawUrl) continue

        const groupMatch = header.match(/^G(\d+)$/)
        const finalMatch = header.match(/^F(\d+)$/)

        if (!groupMatch && !finalMatch) continue

        const id = groupMatch
            ? `G${groupMatch[1]}`
            : `F${finalMatch![1]}`

        const chart = chartFromUrl(id, rawUrl)
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
    }
}

export async function getCurrentEdition(): Promise<string> {
    return (await getEditionData()).edition
}

export function clearSheetCache(): void {
    customCache = null
    indexCache = null
}