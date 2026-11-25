import { DurableObject } from 'cloudflare:workers'
import type {
    Env,
    ReplayItem,
    ReplayRecord,
    ReplaySubmission,
} from './types.ts'

const CHUNK_SIZE = 1024 * 1024
const MAX_UPLOAD_SIZE = 32 * 1024 * 1024
const PENDING_TTL_MS = 30 * 60 * 1000
const HASH_RE = /^[a-f0-9]{40}$/i

type PendingReplay = {
    handle: string
    metadata: ReplaySubmission
    createdAt: number
}

type StoredSubmission = {
    key: string
    handle: string
    replay: ReplayItem
    metadata: ReplaySubmission
    hashes: string[]
    createdAt: number
}

type StoredReplay = ReplayRecord & {
    resourceHashes: string[]
}

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        },
    })

const cleanString = (value: unknown, max = 500): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : ''

const makeId = (): string => crypto.randomUUID().replace(/-/g, '')

const safeId = (value: string): string =>
    /^[a-f0-9]{32}$/i.test(value) ? value.toLowerCase() : ''

const safeHash = (value: string): string =>
    HASH_RE.test(value) ? value.toLowerCase() : ''

const resourceHash = (resource: unknown): string => {
    if (!resource || typeof resource !== 'object') return ''
    return safeHash(cleanString((resource as Record<string, unknown>).hash, 128))
}

const normalizeAddress = (value: unknown): string => {
    const clean = cleanString(value, 1000)
    if (!clean) return ''

    try {
        const parsed = new URL(clean)
        parsed.pathname = parsed.pathname
            .replace(/\/sonolus\/?$/i, '')
            .replace(/\/+$/, '')
        parsed.search = ''
        parsed.hash = ''

        return parsed.toString().replace(/\/+$/, '').toLowerCase()
    } catch {
        return clean
            .replace(/\/sonolus\/?$/i, '')
            .replace(/\/+$/, '')
            .toLowerCase()
    }
}

function isValidMetadata(value: unknown): value is ReplaySubmission {
    if (!value || typeof value !== 'object') return false

    const metadata = value as ReplaySubmission

    return (
        ['groupStage', 'final', 'ultimateEdition'].includes(metadata.competition) &&
        ['tournament', 'rewind'].includes(metadata.roundKind) &&
        typeof metadata.edition === 'string' &&
        typeof metadata.roundId === 'string' &&
        typeof metadata.levelName === 'string' &&
        typeof metadata.levelAddress === 'string' &&
        typeof metadata.playerHandle === 'string' &&
        typeof metadata.playerName === 'string' &&
        typeof metadata.scoreLabel === 'string' &&
        Number.isFinite(metadata.scoreValue) &&
        Number.isFinite(metadata.roundNumber)
    )
}

export class Replays extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)
        const path = url.pathname.replace(/\/+$/, '') || '/'

        if (request.method === 'POST' && path === '/pending') {
            return this.addPending(request)
        }

        if (request.method === 'GET' && path === '/pending') {
            return this.hasPending(url.searchParams.get('handle') ?? '')
        }

        if (request.method === 'POST' && path === '/stage') {
            return this.stage(request)
        }

        if (request.method === 'POST' && path === '/upload') {
            return this.upload(request)
        }

        if (request.method === 'GET' && path === '/list') {
            return this.list()
        }

        if (request.method === 'GET' && path.startsWith('/get/')) {
            return this.get(decodeURIComponent(path.slice('/get/'.length)))
        }

        if (request.method === 'GET' && path.startsWith('/resource/')) {
            const parts = path.slice('/resource/'.length).split('/')
            return this.getResource(
                decodeURIComponent(parts[0] ?? ''),
                decodeURIComponent(parts[1] ?? ''),
            )
        }

        if (request.method === 'DELETE' && path.startsWith('/delete/')) {
            return this.deleteReplay(
                decodeURIComponent(path.slice('/delete/'.length)),
            )
        }

        return new Response('Not found', { status: 404 })
    }

    private async addPending(request: Request): Promise<Response> {
        let body: {
            handle?: unknown
            metadata?: unknown
        }

        try {
            body = await request.json() as typeof body
        } catch {
            return json({ message: 'Invalid pending replay metadata.' }, 400)
        }

        const handle = cleanString(body.handle, 40)
        const metadata = body.metadata

        if (!handle || !isValidMetadata(metadata)) {
            return json({ message: 'Invalid replay metadata.' }, 400)
        }

        if (metadata.playerHandle !== handle) {
            return json({ message: 'Replay player does not match.' }, 400)
        }

        const id = makeId()

        await this.ctx.storage.put(`pending:${handle}:${id}`, {
            handle,
            metadata,
            createdAt: Date.now(),
        } satisfies PendingReplay)

        return json({ ok: true })
    }

    private async hasPending(handleInput: string): Promise<Response> {
        const handle = cleanString(handleInput, 40)
        if (!handle) return json({ pending: false })

        const entries = await this.ctx.storage.list<PendingReplay>({
            prefix: `pending:${handle}:`,
        })

        const now = Date.now()
        let pending = false

        for (const [key, value] of entries) {
            if (now - value.createdAt > PENDING_TTL_MS) {
                await this.ctx.storage.delete(key)
                continue
            }

            pending = true
        }

        return json({ pending })
    }

    private async stage(request: Request): Promise<Response> {
        let body: {
            handle?: unknown
            replay?: ReplayItem
        }

        try {
            body = await request.json() as typeof body
        } catch {
            return json({ message: 'Invalid replay submission.' }, 400)
        }

        const handle = cleanString(body.handle, 40)
        const replay = body.replay

        if (!handle || !replay || typeof replay !== 'object') {
            return json({ message: 'Missing replay or player handle.' }, 400)
        }

        const levelName = cleanString(replay.level?.name, 300)
        const levelSource = normalizeAddress(replay.level?.source)

        if (!levelName) {
            return json({ message: 'Replay has no level name.' }, 400)
        }

        const dataHash = resourceHash(replay.data)
        const configurationHash = resourceHash(replay.configuration)

        if (!dataHash || !configurationHash) {
            return json({ message: 'Replay data or configuration is invalid.' }, 400)
        }

        const hashes = [...new Set([dataHash, configurationHash])]

        const entries = await this.ctx.storage.list<PendingReplay>({
            prefix: `pending:${handle}:`,
        })

        const now = Date.now()
        const candidates: {
            key: string
            pending: PendingReplay
        }[] = []

        for (const [key, pending] of entries) {
            if (now - pending.createdAt > PENDING_TTL_MS) {
                await this.ctx.storage.delete(key)
                continue
            }

            if (pending.metadata.levelName !== levelName) continue

            const expectedSource = normalizeAddress(pending.metadata.levelAddress)

            if (
                levelSource &&
                expectedSource &&
                levelSource !== expectedSource
            ) {
                continue
            }

            candidates.push({ key, pending })
        }

        candidates.sort(
            (a, b) => b.pending.createdAt - a.pending.createdAt,
        )

        const selected = candidates[0]

        if (!selected) {
            return json({
                message: 'No matching XX! Championship result was found for this replay.',
            }, 409)
        }

        const key = makeId()

        const submission: StoredSubmission = {
            key,
            handle,
            replay: {
                ...replay,
                source: cleanString(replay.source, 1000) || undefined,
            },
            metadata: selected.pending.metadata,
            hashes,
            createdAt: now,
        }

        await this.ctx.storage.put(`submission:${key}`, submission)
        await this.ctx.storage.delete(selected.key)

        return json({
            key,
            hashes,
        })
    }

    private async upload(request: Request): Promise<Response> {
        const uploadKey = safeId(
            request.headers.get('Sonolus-Upload-Key') ?? '',
        )

        if (!uploadKey) {
            return json({ message: 'Missing or invalid upload key.' }, 400)
        }

        const submission = await this.ctx.storage.get<StoredSubmission>(
            `submission:${uploadKey}`,
        )

        if (!submission) {
            return json({ message: 'Upload session not found or expired.' }, 404)
        }

        let form: FormData

        try {
            form = await request.formData()
        } catch {
            return json({ message: 'Invalid multipart upload.' }, 400)
        }

        const uploaded = new Map<string, Uint8Array>()
        let totalSize = 0

        for (const value of form.getAll('files')) {
            if (!(value instanceof File)) continue

            const hash = safeHash(value.name)
            if (!hash || !submission.hashes.includes(hash)) continue

            totalSize += value.size

            if (totalSize > MAX_UPLOAD_SIZE) {
                return json({ message: 'Replay upload exceeds the 32 MB limit.' }, 413)
            }

            uploaded.set(hash, new Uint8Array(await value.arrayBuffer()))
        }

        for (const hash of submission.hashes) {
            if (!uploaded.has(hash)) {
                return json({ message: `Missing replay resource: ${hash}` }, 400)
            }
        }

        const replayId = makeId()
        const now = Date.now()
        const resourceHashes: string[] = []
        const writtenKeys: string[] = []

        try {
            for (const [hash, bytes] of uploaded) {
                const chunkCount = Math.ceil(bytes.byteLength / CHUNK_SIZE)

                for (let index = 0; index < chunkCount; index++) {
                    const start = index * CHUNK_SIZE
                    const end = Math.min(start + CHUNK_SIZE, bytes.byteLength)
                    const key = `resource:${replayId}:${hash}:${index}`

                    await this.ctx.storage.put(key, bytes.slice(start, end))
                    writtenKeys.push(key)
                }

                const metaKey = `resource-meta:${replayId}:${hash}`

                await this.ctx.storage.put(metaKey, {
                    size: bytes.byteLength,
                    chunks: chunkCount,
                })

                writtenKeys.push(metaKey)
                resourceHashes.push(hash)
            }
        } catch (error) {
            console.error('[Replays] Resource storage failed:', error)

            for (const key of writtenKeys) {
                await this.ctx.storage.delete(key).catch(() => undefined)
            }

            return json({ message: 'Could not store replay resources.' }, 500)
        }

        const previousEntries = await this.ctx.storage.list<StoredReplay>({
            prefix: 'replay:',
        })

        const previous = [...previousEntries.values()].filter(
            (record) =>
                record.handle === submission.handle &&
                record.metadata.roundId === submission.metadata.roundId,
        )

        const previousRecord = previous
            .sort((a, b) => b.createdAt - a.createdAt)[0]

        let rewindIndex = submission.metadata.rewindIndex

        if (previousRecord && submission.metadata.roundKind === 'rewind') {
            rewindIndex = previousRecord.metadata.rewindIndex + 1
        } else if (previousRecord) {
            rewindIndex = previousRecord.metadata.rewindIndex
        }

        const metadata: ReplaySubmission = {
            ...submission.metadata,
            rewindIndex,
        }

        const rewindLabel = rewindIndex > 0
            ? rewindIndex === 1
                ? ' [Rewind]'
                : ` [Rewind ${rewindIndex}]`
            : ''

        const competitionLabel =
            metadata.competition === 'groupStage'
                ? `Group ${metadata.group ?? 'A'}`
                : metadata.competition === 'final'
                    ? 'Final'
                    : 'Ultimate Edition'

        const replay: ReplayItem = {
            ...submission.replay,
            name: replayId,
            version: 1,
            title: `${metadata.scoreLabel}${rewindLabel}`,
            subtitle: `${metadata.edition} • ${competitionLabel} • ${metadata.roundLabel} • ${metadata.songTitle} • ${metadata.difficulty}`,
            author: `${metadata.playerName}#${metadata.playerHandle}`,
            tags: [
                ...(Array.isArray(submission.replay.tags)
                    ? submission.replay.tags
                    : []),
                { title: 'XX! Championship', icon: 'trophy' },
                ...(rewindIndex > 0
                    ? [{ title: 'Rewind', icon: 'replay' }]
                    : []),
            ],
        }

        const record: StoredReplay = {
            id: replayId,
            handle: submission.handle,
            replay,
            metadata,
            resourceHashes,
            createdAt: now,
        }

        try {
            await this.ctx.storage.put(`replay:${replayId}`, record)
            await this.ctx.storage.delete(`submission:${uploadKey}`)

            for (const old of previous) {
                await this.deleteStoredReplay(old)
            }
        } catch (error) {
            console.error('[Replays] Could not finish saving replay:', error)

            for (const key of writtenKeys) {
                await this.ctx.storage.delete(key).catch(() => undefined)
            }

            await this.ctx.storage.delete(`replay:${replayId}`).catch(() => undefined)

            return json({ message: 'Could not finish saving replay.' }, 500)
        }

        return json({})
    }

    private publicRecord(record: StoredReplay): ReplayRecord {
        const dataHash = resourceHash(record.replay.data)
        const configurationHash = resourceHash(record.replay.configuration)

        return {
            id: record.id,
            handle: record.handle,
            metadata: record.metadata,
            createdAt: record.createdAt,
            replay: {
                ...record.replay,
                data: {
                    ...record.replay.data,
                    url: `/sonolus/replays/resource/${record.id}/${dataHash}`,
                },
                configuration: {
                    ...record.replay.configuration,
                    url: `/sonolus/replays/resource/${record.id}/${configurationHash}`,
                },
            },
        }
    }

    private async list(): Promise<Response> {
        const entries = await this.ctx.storage.list<StoredReplay>({
            prefix: 'replay:',
        })

        const records = [...entries.values()]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((record) => this.publicRecord(record))

        return json({ items: records })
    }

    private async get(idInput: string): Promise<Response> {
        const id = safeId(idInput)
        if (!id) return new Response(null, { status: 404 })

        const record = await this.ctx.storage.get<StoredReplay>(`replay:${id}`)

        if (!record) return new Response(null, { status: 404 })

        return json(this.publicRecord(record))
    }

    private async getResource(
        replayIdInput: string,
        hashInput: string,
    ): Promise<Response> {
        const replayId = safeId(replayIdInput)
        const hash = safeHash(hashInput)

        if (!replayId || !hash) {
            return new Response(null, { status: 404 })
        }

        const record = await this.ctx.storage.get<StoredReplay>(
            `replay:${replayId}`,
        )

        if (!record || !record.resourceHashes.includes(hash)) {
            return new Response(null, { status: 404 })
        }

        const meta = await this.ctx.storage.get<{
            size: number
            chunks: number
        }>(`resource-meta:${replayId}:${hash}`)

        if (
            !meta ||
            !Number.isSafeInteger(meta.size) ||
            meta.size < 0 ||
            !Number.isSafeInteger(meta.chunks) ||
            meta.chunks < 1
        ) {
            return new Response(null, { status: 404 })
        }

        const output = new Uint8Array(meta.size)
        let offset = 0

        for (let index = 0; index < meta.chunks; index++) {
            const chunk = await this.ctx.storage.get<Uint8Array>(
                `resource:${replayId}:${hash}:${index}`,
            )

            if (!chunk || offset + chunk.byteLength > output.byteLength) {
                return new Response(null, { status: 500 })
            }

            output.set(chunk, offset)
            offset += chunk.byteLength
        }

        if (offset !== output.byteLength) {
            return new Response(null, { status: 500 })
        }

        return new Response(output, {
            headers: {
                'Content-Type': 'application/gzip',
                'Content-Length': String(output.byteLength),
                'Cache-Control': 'public, max-age=31536000, immutable',
            },
        })
    }

    private async deleteStoredReplay(record: StoredReplay): Promise<void> {
        await this.ctx.storage.delete(`replay:${record.id}`)

        for (const hash of record.resourceHashes) {
            const meta = await this.ctx.storage.get<{
                size: number
                chunks: number
            }>(`resource-meta:${record.id}:${hash}`)

            if (meta) {
                for (let index = 0; index < meta.chunks; index++) {
                    await this.ctx.storage.delete(
                        `resource:${record.id}:${hash}:${index}`,
                    )
                }
            }

            await this.ctx.storage.delete(
                `resource-meta:${record.id}:${hash}`,
            )
        }
    }

    private async deleteReplay(idInput: string): Promise<Response> {
        const id = safeId(idInput)
        if (!id) return new Response(null, { status: 404 })

        const record = await this.ctx.storage.get<StoredReplay>(`replay:${id}`)

        if (!record) return new Response(null, { status: 404 })

        await this.deleteStoredReplay(record)

        return json({ ok: true })
    }
}