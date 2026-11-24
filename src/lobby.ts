import { DurableObject } from 'cloudflare:workers'
import { randomId } from './crypto.ts'
import type { ChatMessage, Env, RoomVisibility, UserProfile } from './types.ts'

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

export type StoredChatMessage = ChatMessage & {
    likes?: string[]
    replyTo?: {
        id: string
        author: string
        handle: string
        text: string
    }
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
    chat: StoredChatMessage[]
    pinnedChatId: string | null
}

const MAX_POSTS = 200
const MAX_CHAT = 200
const CATEGORIES: PostCategory[] = ['announcements', 'posts', 'results']
const CHAT_INDEX_KEY = 'chat/index.json'
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

function normalizeChatMessage(raw: any): StoredChatMessage {
    const replyTo = raw?.replyTo && typeof raw.replyTo === 'object'
        ? {
            id: String(raw.replyTo.id ?? ''),
            author: String(raw.replyTo.author ?? ''),
            handle: String(raw.replyTo.handle ?? ''),
            text: String(raw.replyTo.text ?? '').slice(0, 120),
        }
        : undefined

    return {
        id: String(raw?.id ?? randomId(10)),
        handle: String(raw?.handle ?? ''),
        author: String(raw?.author ?? ''),
        text: String(raw?.text ?? '').slice(0, 500),
        time: Number(raw?.time) || Date.now(),
        likes: Array.isArray(raw?.likes)
            ? Array.from(new Set(raw.likes.map(String).filter(Boolean)))
            : [],
        ...(replyTo ? { replyTo } : {}),
    }
}

export class Lobby extends DurableObject<Env> {
    private rooms = new Set<string>()
    private st: LobbyState = {
        rooms: [],
        roomEntries: {},
        posts: [],
        chat: [],
        pinnedChatId: null,
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
                // ignore empty/invalid manual placeholder JSON
            }
        }

        return loadedPosts.slice(-MAX_POSTS)
    }

    private async loadFromR2(): Promise<LobbyState | null> {
        const bucket = this.env.COMMUNITY_BUCKET
        if (!bucket) return null

        try {
            const [loadedPosts, chatObj] = await Promise.all([
                this.loadPostsFromR2(),
                bucket.get(CHAT_INDEX_KEY).catch(() => null),
            ])

            let chat: StoredChatMessage[] = []
            let pinnedChatId: string | null = null

            if (chatObj) {
                try {
                    const text = (await chatObj.text()).trim()
                    if (text) {
                        const parsedChat = JSON.parse(text) as {
                            messages?: StoredChatMessage[]
                            pinnedChatId?: string | null
                        }
                        if (Array.isArray(parsedChat.messages)) {
                            chat = parsedChat.messages
                                .slice(-MAX_CHAT)
                                .map((message) => normalizeChatMessage(message))
                        }
                        if (typeof parsedChat.pinnedChatId === 'string') {
                            pinnedChatId = parsedChat.pinnedChatId
                        }
                    }
                } catch {
                    // ignore empty/invalid chat JSON
                }
            }

            return {
                rooms: [],
                roomEntries: {},
                posts: loadedPosts,
                chat,
                pinnedChatId,
            }
        } catch (error) {
            console.error('Could not load lobby state from R2:', error)
            return null
        }
    }

    private async writeR2Now(): Promise<void> {
        const bucket = this.env.COMMUNITY_BUCKET
        if (!bucket) return

        const elapsed = Date.now() - this.lastR2WriteAt
        if (elapsed < MIN_R2_WRITE_INTERVAL_MS) {
            await new Promise((resolve) => setTimeout(resolve, MIN_R2_WRITE_INTERVAL_MS - elapsed))
        }

        const now = Date.now()
        const allPosts = this.st.posts.slice(-MAX_POSTS)

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

        const stored = await this.ctx.storage.get<LobbyState>('state')
        if (stored) {
            const roomNames = Array.isArray(stored.rooms) ? stored.rooms.map(String).filter(Boolean) : []
            this.rooms = new Set(roomNames)
            const r2Posts = await this.loadPostsFromR2()
            const storedPosts = Array.isArray(stored.posts)
                ? stored.posts.slice(-MAX_POSTS).map((post) => normalizePost(post))
                : []
            const mergedPosts = r2Posts.length > 0
                ? [
                    ...r2Posts,
                    ...storedPosts.filter((sp) => !r2Posts.some((rp) => rp.item.name === sp.item.name)),
                ].slice(-MAX_POSTS)
                : storedPosts

            this.st = {
                rooms: [...this.rooms],
                roomEntries: stored.roomEntries && typeof stored.roomEntries === 'object'
                    ? stored.roomEntries
                    : {},
                posts: mergedPosts,
                chat: Array.isArray(stored.chat)
                    ? stored.chat.slice(-MAX_CHAT).map((message) => normalizeChatMessage(message))
                    : [],
                pinnedChatId: typeof stored.pinnedChatId === 'string'
                    ? stored.pinnedChatId
                    : null,
            }
            this.loaded = true
            return
        }

        const fromR2 = await this.loadFromR2()
        if (fromR2) {
            this.st = fromR2
            await this.ctx.storage.put('state', this.st)
        }

        this.loaded = true
    }

    private async save(persistR2 = false): Promise<void> {
        this.st.rooms = [...this.rooms]
        this.st.posts = this.st.posts.slice(-MAX_POSTS)
        this.st.chat = this.st.chat.slice(-MAX_CHAT)
        if (
            this.st.pinnedChatId &&
            !this.st.chat.some((m) => m.id === this.st.pinnedChatId)
        ) {
            this.st.pinnedChatId = null
        }
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
        ].slice(-MAX_POSTS)

        await this.save(true)
        return post
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

    async listChatMessages(): Promise<StoredChatMessage[]> {
        await this.ensureLoaded()
        return this.st.chat.map((message) => normalizeChatMessage(message))
    }

    async getChatMessagesFromR2(): Promise<StoredChatMessage[]> {
        const bucket = this.env.COMMUNITY_BUCKET
        if (!bucket) return this.st.chat

        const object = await bucket.get(CHAT_INDEX_KEY)
        if (!object) return this.st.chat

        const parsed = await object.json() as {
            messages?: StoredChatMessage[]
        }

        if (!Array.isArray(parsed.messages)) return this.st.chat

        return parsed.messages
            .slice(-MAX_CHAT)
            .map((message) => normalizeChatMessage(message))
    }

    async getPinnedChatId(): Promise<string | null> {
        await this.ensureLoaded()
        return this.st.pinnedChatId
    }

    async addChatMessage(input: {
        handle: string
        author: string
        text: string
        replyTo?: {
            id: string
            author: string
            handle: string
            text: string
        }
    }): Promise<StoredChatMessage> {
        await this.ensureLoaded()

        const message: StoredChatMessage = normalizeChatMessage({
            id: randomId(10),
            handle: input.handle,
            author: input.author,
            text: input.text.slice(0, 500),
            time: Date.now(),
            likes: [],
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        })

        this.st.chat = [...this.st.chat, message].slice(-MAX_CHAT)
        await this.save(false)
        return message
    }

    async deleteChatMessage(id: string): Promise<boolean> {
        await this.ensureLoaded()
        const before = this.st.chat.length
        this.st.chat = this.st.chat.filter((message) => message.id !== id)
        if (this.st.pinnedChatId === id) {
            this.st.pinnedChatId = null
        }
        if (this.st.chat.length === before) return false
        await this.save(false)
        return true
    }

    async toggleChatLike(id: string, handle: string): Promise<StoredChatMessage | null> {
        await this.ensureLoaded()
        const idx = this.st.chat.findIndex((m) => m.id === id)
        if (idx === -1) return null

        const current = normalizeChatMessage(this.st.chat[idx])
        const hasLike = (current.likes ?? []).includes(handle)
        current.likes = hasLike
            ? (current.likes ?? []).filter((h) => h !== handle)
            : [...(current.likes ?? []), handle]

        this.st.chat[idx] = current
        await this.save(false)
        return current
    }

    async togglePinChatMessage(id: string): Promise<string | null> {
        await this.ensureLoaded()
        const exists = this.st.chat.some((m) => m.id === id)
        if (!exists) return this.st.pinnedChatId
        this.st.pinnedChatId = this.st.pinnedChatId === id ? null : id
        await this.save(false)
        return this.st.pinnedChatId
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