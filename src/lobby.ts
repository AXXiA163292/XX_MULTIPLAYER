import { DurableObject } from 'cloudflare:workers'
import { randomId } from './crypto.ts'
import type { Env, RoomVisibility, UserProfile } from './types.ts'

export type PostCategory = 'announcements' | 'posts' | 'results'

export type PostItem = {
    name: string
    version: 1
    title: string
    time: number
    author: string
    tags: { title: string; icon?: string }[]
    thumbnail?: {
        hash: string
        url: string
    }
}

export type PostComment = {
    id: string
    handle: string
    author: string
    text: string
    time: number
}

export type StoredPost = {
    category: PostCategory
    item: PostItem
    description: string
    uploadKey: string
    thumbnailHash: string
    likes: string[]
    comments: PostComment[]
    pinned?: boolean
}

export type RoomDirectoryEntry = {
    name: string
    title: string
    subtitle: string
    master: string
    hostId?: string
    visibility: RoomVisibility
    updatedAt: number
}

type LobbyState = {
    rooms: string[]
    roomEntries?: Record<string, RoomDirectoryEntry>
    posts: StoredPost[]
}

const MAX_POSTS = 200
const CATEGORIES: PostCategory[] = ['announcements', 'posts', 'results']
const MIN_R2_WRITE_INTERVAL_MS = 1100

const categoryIndexKey = (category: PostCategory) => `${category}/index.json`

function normalizeCategory(raw: unknown): PostCategory {
    if (raw === 'announcements' || raw === 'results' || raw === 'posts') {
        return raw
    }
    return 'posts'
}

function normalizePost(raw: any, forcedCategory?: PostCategory): StoredPost {
    const category = forcedCategory ?? normalizeCategory(raw?.category)
    const item: PostItem = {
        name: String(raw?.item?.name ?? randomId(12)),
        version: 1,
        title: String(raw?.item?.title ?? '').slice(0, 100),
        time: Number(raw?.item?.time) || Date.now(),
        author: String(raw?.item?.author ?? ''),
        tags: Array.isArray(raw?.item?.tags) ? raw.item.tags : [],
        ...(raw?.item?.thumbnail?.hash && raw?.item?.thumbnail?.url
            ? {
                thumbnail: {
                    hash: String(raw.item.thumbnail.hash),
                    url: String(raw.item.thumbnail.url),
                },
            }
            : {}),
    }

    return {
        category,
        item,
        description: String(raw?.description ?? '').slice(0, 2000),
        uploadKey: String(raw?.uploadKey ?? ''),
        thumbnailHash: String(raw?.thumbnailHash ?? item.thumbnail?.hash ?? ''),
        likes: Array.isArray(raw?.likes) ? raw.likes.map(String) : [],
        comments: Array.isArray(raw?.comments)
            ? raw.comments.map((c: any) => ({
                id: String(c?.id ?? randomId(10)),
                handle: String(c?.handle ?? ''),
                author: String(c?.author ?? ''),
                text: String(c?.text ?? '').slice(0, 500),
                time: Number(c?.time) || Date.now(),
            }))
            : [],
        pinned: Boolean(raw?.pinned),
    }
}

export class Lobby extends DurableObject<Env> {
    private rooms = new Set<string>()
    private st: LobbyState = {
        rooms: [],
        roomEntries: {},
        posts: [],
    }
    private loaded = false
    private r2Queue: Promise<void> = Promise.resolve()
    private r2Dirty = false
    private lastR2WriteAt = 0

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        void ctx.blockConcurrencyWhile(async () => {
            await this.ensureLoaded()
        })
    }

    private async loadPostsFromR2(): Promise<StoredPost[]> {
        const bucket = this.env.COMMUNITY_BUCKET
        if (!bucket) return []

        const [annObj, postsObj, resObj] = await Promise.all([
            bucket.get(categoryIndexKey('announcements')).catch(() => null),
            bucket.get(categoryIndexKey('posts')).catch(() => null),
            bucket.get(categoryIndexKey('results')).catch(() => null),
        ])

        const loadedPosts: StoredPost[] = []
        const seenNames = new Set<string>()

        for (const [category, obj] of [
            ['announcements', annObj],
            ['posts', postsObj],
            ['results', resObj],
        ] as const) {
            if (!obj) continue
            try {
                const text = (await obj.text()).trim()
                if (!text) continue
                const parsed = JSON.parse(text) as { posts?: StoredPost[] } | StoredPost[]
                const list = Array.isArray(parsed)
                    ? parsed
                    : Array.isArray(parsed?.posts)
                        ? parsed.posts
                        : []
                for (const raw of list) {
                    const normalized = normalizePost(raw, category)
                    if (!seenNames.has(normalized.item.name)) {
                        seenNames.add(normalized.item.name)
                        loadedPosts.push(normalized)
                    }
                }
            } catch {
                // ignore empty/invalid placeholder JSON
            }
        }

        return loadedPosts
            .sort((a, b) => Number(a.item.time || 0) - Number(b.item.time || 0))
            .slice(-MAX_POSTS)
    }

    private async writeR2Now(): Promise<void> {
        const bucket = this.env.COMMUNITY_BUCKET
        if (!bucket) return

        const elapsed = Date.now() - this.lastR2WriteAt
        if (elapsed < MIN_R2_WRITE_INTERVAL_MS) {
            await new Promise((resolve) => setTimeout(resolve, MIN_R2_WRITE_INTERVAL_MS - elapsed))
        }

        const now = Date.now()
        const allPosts = this.st.posts
            .sort((a, b) => Number(a.item.time || 0) - Number(b.item.time || 0))
            .slice(-MAX_POSTS)

        try {
            await Promise.all(
                CATEGORIES.map((category) => {
                    const categoryPosts = allPosts.filter((p) => p.category === category)
                    return bucket.put(
                        categoryIndexKey(category),
                        JSON.stringify({
                            updatedAt: now,
                            category,
                            posts: categoryPosts,
                        }),
                        { httpMetadata: { contentType: 'application/json' } },
                    )
                }),
            )
            this.lastR2WriteAt = Date.now()
        } catch (error) {
            console.error('Could not persist category posts to R2:', error)
        }
    }

    private scheduleR2Persist(): Promise<void> {
        this.r2Dirty = true
        this.r2Queue = this.r2Queue
            .then(async () => {
                if (!this.r2Dirty) return
                this.r2Dirty = false
                await this.writeR2Now()
            })
            .catch((error) => {
                console.error('R2 queue error:', error)
            })
        return this.r2Queue
    }

    private async ensureLoaded(): Promise<void> {
        if (this.loaded) return

        const r2Posts = await this.loadPostsFromR2()
        const stored = await this.ctx.storage.get<LobbyState>('state')
        if (stored) {
            const roomNames = Array.isArray(stored.rooms) ? stored.rooms.map(String).filter(Boolean) : []
            this.rooms = new Set(roomNames)
            const storedPosts = Array.isArray(stored.posts)
                ? stored.posts.map((post) => normalizePost(post))
                : []
            const mergedPosts = r2Posts.length > 0
                ? [
                    ...r2Posts,
                    ...storedPosts.filter((sp) => !r2Posts.some((rp) => rp.item.name === sp.item.name)),
                ]
                    .sort((a, b) => Number(a.item.time || 0) - Number(b.item.time || 0))
                    .slice(-MAX_POSTS)
                : storedPosts
                    .sort((a, b) => Number(a.item.time || 0) - Number(b.item.time || 0))
                    .slice(-MAX_POSTS)

            this.st = {
                rooms: [...this.rooms],
                roomEntries: stored.roomEntries && typeof stored.roomEntries === 'object'
                    ? stored.roomEntries
                    : {},
                posts: mergedPosts,
            }
            this.loaded = true
            return
        }

        this.st = {
            rooms: [],
            roomEntries: {},
            posts: r2Posts,
        }
        await this.ctx.storage.put('state', this.st)
        this.loaded = true
    }

    private async save(persistR2 = false): Promise<void> {
        this.st.rooms = [...this.rooms]
        this.st.posts = this.st.posts
            .sort((a, b) => Number(a.item.time || 0) - Number(b.item.time || 0))
            .slice(-MAX_POSTS)
        await this.ctx.storage.put('state', this.st)
        if (persistR2) {
            await this.scheduleR2Persist()
        }
    }

    async syncAllToR2(): Promise<void> {
        await this.ensureLoaded()
        await this.scheduleR2Persist()
    }

    async list(): Promise<{ name: string }[]> {
        await this.ensureLoaded()
        return [...this.rooms].map((name) => ({ name }))
    }

    async upsert(entry: {
        name: string
        title: string
        subtitle: string
        master: string
        hostId?: string
        visibility: RoomVisibility
    }): Promise<void> {
        await this.ensureLoaded()
        if (!entry?.name) return
        this.rooms.add(entry.name)
        this.st.roomEntries ??= {}
        this.st.roomEntries[entry.name] = {
            ...entry,
            updatedAt: Date.now(),
        }
        await this.save(false)
    }

    async register(name: string): Promise<void> {
        await this.ensureLoaded()
        if (!name) return
        this.rooms.add(name)
        await this.save(false)
    }

    async remove(name: string): Promise<void> {
        await this.ensureLoaded()
        if (!name) return
        this.rooms.delete(name)
        if (this.st.roomEntries) {
            delete this.st.roomEntries[name]
        }
        await this.save(false)
    }

    async listPosts(category?: PostCategory): Promise<StoredPost[]> {
        await this.ensureLoaded()
        const all = this.st.posts.map((post) => normalizePost(post))
        if (!category) return all
        return all.filter((post) => post.category === category)
    }

    async getPost(name: string): Promise<StoredPost | null> {
        await this.ensureLoaded()
        const found = this.st.posts.find((post) => post.item.name === name)
        return found ? normalizePost(found) : null
    }

    async createPost(input: {
        category: PostCategory
        item: PostItem
        description: string
        uploadKey: string
        thumbnailHash: string
        likes?: string[]
        comments?: PostComment[]
        pinned?: boolean
    }): Promise<StoredPost> {
        await this.ensureLoaded()

        const post = normalizePost({
            category: input.category,
            item: input.item,
            description: input.description,
            uploadKey: input.uploadKey,
            thumbnailHash: input.thumbnailHash,
            likes: input.likes ?? [],
            comments: input.comments ?? [],
            pinned: input.pinned ?? false,
        })

        this.st.posts = [
            ...this.st.posts.filter((existing) => existing.item.name !== post.item.name),
            post,
        ]
            .sort((a, b) => Number(a.item.time || 0) - Number(b.item.time || 0))
            .slice(-MAX_POSTS)

        await this.save(true)
        return post
    }

    async updatePost(
        name: string,
        patch: { title?: string; description?: string; clearThumbnail?: boolean },
    ): Promise<StoredPost | null> {
        await this.ensureLoaded()

        const index = this.st.posts.findIndex((post) => post.item.name === name)
        if (index === -1) return null

        const current = normalizePost(this.st.posts[index])
        const nextItem: PostItem = {
            ...current.item,
            ...(patch.title !== undefined ? { title: patch.title.slice(0, 100) } : {}),
        }

        if (patch.clearThumbnail) {
            delete nextItem.thumbnail
        }

        const updated: StoredPost = {
            ...current,
            item: nextItem,
            description: patch.description !== undefined
                ? patch.description.slice(0, 2000)
                : current.description,
            ...(patch.clearThumbnail ? { thumbnailHash: '', uploadKey: '' } : {}),
        }

        this.st.posts[index] = updated
        await this.save(true)
        return updated
    }

    async clearPostThumbnail(name: string): Promise<StoredPost | null> {
        return this.updatePost(name, { clearThumbnail: true })
    }

    async findPostByUploadKey(uploadKey: string): Promise<StoredPost | null> {
        await this.ensureLoaded()
        const found = this.st.posts.find((post) => post.uploadKey === uploadKey)
        return found ? normalizePost(found) : null
    }

    async setPostThumbnail(
        name: string,
        hash: string,
        url: string,
    ): Promise<StoredPost | null> {
        await this.ensureLoaded()

        const index = this.st.posts.findIndex((post) => post.item.name === name)
        if (index === -1) return null

        const updated = normalizePost({
            ...this.st.posts[index],
            thumbnailHash: hash,
            item: {
                ...this.st.posts[index]!.item,
                thumbnail: { hash, url },
            },
        })

        this.st.posts[index] = updated
        await this.save(true)
        return updated
    }

    async removePost(name: string): Promise<boolean> {
        await this.ensureLoaded()
        const before = this.st.posts.length
        this.st.posts = this.st.posts.filter((post) => post.item.name !== name)
        if (this.st.posts.length === before) return false
        await this.save(true)
        return true
    }

    async togglePostLike(name: string, handle: string): Promise<StoredPost | null> {
        await this.ensureLoaded()
        const index = this.st.posts.findIndex((post) => post.item.name === name)
        if (index === -1) return null

        const current = normalizePost(this.st.posts[index])
        const hasLike = current.likes.includes(handle)
        current.likes = hasLike
            ? current.likes.filter((h) => h !== handle)
            : [...current.likes, handle]

        this.st.posts[index] = current
        await this.save(true)
        return current
    }

    async togglePostPin(name: string): Promise<StoredPost | null> {
        await this.ensureLoaded()
        const index = this.st.posts.findIndex((post) => post.item.name === name)
        if (index === -1) return null

        const current = normalizePost(this.st.posts[index])
        current.pinned = !current.pinned
        this.st.posts[index] = current
        await this.save(true)
        return current
    }

    async addPostComment(
        name: string,
        input: { handle: string; author: string; text: string },
    ): Promise<PostComment | null> {
        await this.ensureLoaded()
        const index = this.st.posts.findIndex((post) => post.item.name === name)
        if (index === -1) return null

        const comment: PostComment = {
            id: randomId(10),
            handle: input.handle,
            author: input.author,
            text: input.text.slice(0, 500),
            time: Date.now(),
        }

        const current = normalizePost(this.st.posts[index])
        current.comments = [...current.comments, comment]
        this.st.posts[index] = current
        await this.save(true)
        return comment
    }

    async deletePostComment(name: string, commentId: string): Promise<boolean> {
        await this.ensureLoaded()
        const index = this.st.posts.findIndex((post) => post.item.name === name)
        if (index === -1) return false

        const current = normalizePost(this.st.posts[index])
        const nextComments = current.comments.filter((c) => c.id !== commentId)
        if (nextComments.length === current.comments.length) return false

        current.comments = nextComments
        this.st.posts[index] = current
        await this.save(true)
        return true
    }

    async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url)

        if (req.method === 'POST' && url.pathname === '/register') {
            const { name } = await req.json<{ name: string }>()
            await this.register(name)
            return new Response(null, { status: 204 })
        }

        if (req.method === 'POST' && url.pathname === '/remove') {
            const { name } = await req.json<{ name: string }>()
            await this.remove(name)
            return new Response(null, { status: 204 })
        }

        if (req.method === 'GET' && url.pathname === '/list') {
            return Response.json(await this.list())
        }

        return new Response('Not found', { status: 404 })
    }
}

export type LobbyUser = UserProfile