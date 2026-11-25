import { DurableObject } from 'cloudflare:workers'
import type {
    Env,
    ReplayItem,
    ReplayRecord,
    ReplaySubmission,
} from './types.ts'

const CHUNK_SIZE = 6 * 1024 * 1024
const MAX_UPLOAD_SIZE = 64 * 1024 * 1024

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        },
    })

const readJson = async <T>(request: Request): Promise<T | null> => {
    try {
        return await request.json() as T
    } catch {
        return null
    }
}

const cleanString = (value: unknown, max = 500): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : ''

const makeId = (): string => crypto.randomUUID().replace(/-/g, '')

const resourceHash = (resource: unknown): string => {
    if (!resource || typeof resource !== 'object') return ''
    const value = resource as Record<string, unknown>
    return cleanString(value.hash, 128)
}

const getReplayHashes = (replay: ReplayItem): string[] =>
    [...new Set([
        resourceHash(replay.data),
        resourceHash(replay.configuration),
    ].filter(Boolean))]

const safeKey = (value: string): string =>
    value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100)

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

export class Replays extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url)
        const path = url.pathname.replace(/\/+$/, '') || '/'

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

    private async stage(request: Request): Promise<Response> {
        const body = await readJson<{
            handle: string
            replay: ReplayItem
            metadata: ReplaySubmission
        }>(request)

        if (!body) return json({ message: 'Invalid replay submission.' }, 400)

        const handle = cleanString(body.handle, 40)
        const replay = body.replay
        const metadata = body.metadata

        if (!handle || !replay || typeof replay !== 'object') {
            return json({ message: 'Missing replay or player handle.' }, 400)
        }

        if (
            typeof replay.title !== 'string' ||
            typeof replay.author !== 'string' ||
            !replay.level ||
            typeof replay.level !== 'object'
        ) {
            return json({ message: 'Invalid Sonolus replay item.' }, 400)
        }

        if (!metadata || typeof metadata !== 'object') {
            return json({ message: 'Missing replay metadata.' }, 400)
        }

        const hashes = getReplayHashes(replay)
        if (hashes.length === 0) {
            return json({ message: 'Replay has no uploadable resources.' }, 400)
        }

        const key = makeId()
        const submission: StoredSubmission = {
            key,
            handle,
            replay,
            metadata,
            hashes,
            createdAt: Date.now(),
        }

        await this.ctx.storage.put(`submission:${key}`, submission)

        return json({
            key,
            hashes,
        })
    }

    private async upload(request: Request): Promise<Response> {
        const uploadKey = safeKey(
            request.headers.get('Sonolus-Upload-Key') ?? '',
        )

        if (!uploadKey) {
            return json({ message: 'Missing upload key.' }, 400)
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

        for (const [fieldName, value] of form.entries()) {
            if (!(value instanceof File)) continue

            const hash = safeKey(value.name || fieldName)
            if (!submission.hashes.includes(hash)) continue

            totalSize += value.size
            if (totalSize > MAX_UPLOAD_SIZE) {
                return json({ message: 'Replay upload exceeds the size limit.' }, 413)
            }

            uploaded.set(hash, new Uint8Array(await value.arrayBuffer()))
        }

        for (const hash of submission.hashes) {
            if (!uploaded.has(hash)) {
                return json({
                    message: `Missing replay resource: ${hash}`,
                }, 400)
            }
        }

        const replayId = makeId()
        const resourceHashes: string[] = []

        for (const [hash, bytes] of uploaded.entries()) {
            const chunkCount = Math.ceil(bytes.byteLength / CHUNK_SIZE)

            for (let index = 0; index < chunkCount; index++) {
                const start = index * CHUNK_SIZE
                const end = Math.min(start + CHUNK_SIZE, bytes.byteLength)
                const chunk = bytes.slice(start, end)

                await this.ctx.storage.put(
                    `resource:${replayId}:${hash}:${index}`,
                    chunk,
                )
            }

            await this.ctx.storage.put(
                `resource-meta:${replayId}:${hash}`,
                {
                    size: bytes.byteLength,
                    chunks: chunkCount,
                },
            )

            resourceHashes.push(hash)
        }

        const record: StoredReplay = {
            id: replayId,
            handle: submission.handle,
            replay: submission.replay,
            metadata: submission.metadata,
            resourceHashes,
            createdAt: Date.now(),
        }

        await this.ctx.storage.put(`replay:${replayId}`, record)
        await this.ctx.storage.delete(`submission:${uploadKey}`)

        return json({})
    }

    private async list(): Promise<Response> {
        const entries = await this.ctx.storage.list<StoredReplay>({
            prefix: 'replay:',
        })

        const records = [...entries.values()]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((record) => ({
                id: record.id,
                handle: record.handle,
                metadata: record.metadata,
                createdAt: record.createdAt,
                replay: {
                    ...record.replay,
                    data: {
                        ...record.replay.data,
                        url: `/sonolus/replays/resource/${record.id}/${resourceHash(record.replay.data)}`,
                    },
                    configuration: {
                        ...record.replay.configuration,
                        url: `/sonolus/replays/resource/${record.id}/${resourceHash(record.replay.configuration)}`,
                    },
                },
            }))

        return json({ items: records })
    }

    private async get(id: string): Promise<Response> {
        const record = await this.ctx.storage.get<StoredReplay>(
            `replay:${safeKey(id)}`,
        )

        if (!record) return new Response(null, { status: 404 })

        const replay = {
            ...record.replay,
            data: {
                ...record.replay.data,
                url: `/sonolus/replays/resource/${record.id}/${resourceHash(record.replay.data)}`,
            },
            configuration: {
                ...record.replay.configuration,
                url: `/sonolus/replays/resource/${record.id}/${resourceHash(record.replay.configuration)}`,
            },
        }

        return json({
            id: record.id,
            handle: record.handle,
            metadata: record.metadata,
            createdAt: record.createdAt,
            replay,
        })
    }

    private async getResource(
        replayId: string,
        hash: string,
    ): Promise<Response> {
        const id = safeKey(replayId)
        const cleanHash = safeKey(hash)

        const record = await this.ctx.storage.get<StoredReplay>(`replay:${id}`)
        if (!record || !record.resourceHashes.includes(cleanHash)) {
            return new Response(null, { status: 404 })
        }

        const meta = await this.ctx.storage.get<{
            size: number
            chunks: number
        }>(`resource-meta:${id}:${cleanHash}`)

        if (!meta || meta.chunks < 1) {
            return new Response(null, { status: 404 })
        }

        const chunks: Uint8Array[] = []

        for (let index = 0; index < meta.chunks; index++) {
            const chunk = await this.ctx.storage.get<Uint8Array>(
                `resource:${id}:${cleanHash}:${index}`,
            )

            if (!chunk) return new Response(null, { status: 500 })
            chunks.push(chunk)
        }

        const output = new Uint8Array(meta.size)
        let offset = 0

        for (const chunk of chunks) {
            output.set(chunk, offset)
            offset += chunk.byteLength
        }

        return new Response(output, {
            headers: {
                'Content-Type': 'application/gzip',
                'Content-Length': String(output.byteLength),
                'Cache-Control': 'public, max-age=31536000, immutable',
            },
        })
    }

    private async deleteReplay(id: string): Promise<Response> {
        const replayId = safeKey(id)
        const record = await this.ctx.storage.get<StoredReplay>(
            `replay:${replayId}`,
        )

        if (!record) return new Response(null, { status: 404 })

        await this.ctx.storage.delete(`replay:${replayId}`)

        for (const hash of record.resourceHashes) {
            const meta = await this.ctx.storage.get<{
                size: number
                chunks: number
            }>(`resource-meta:${replayId}:${hash}`)

            if (meta) {
                for (let index = 0; index < meta.chunks; index++) {
                    await this.ctx.storage.delete(
                        `resource:${replayId}:${hash}:${index}`,
                    )
                }
            }

            await this.ctx.storage.delete(
                `resource-meta:${replayId}:${hash}`,
            )
        }

        return json({ ok: true })
    }
}