import { DurableObject } from 'cloudflare:workers'
import { randomId } from './crypto.ts'
import type { ChatMessage, Env, UserProfile } from './types.ts'

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

type LobbyState = {
    posts: StoredPost[]
    chat: StoredChatMessage[]
    pinnedChatId: string | null
}

const MAX_POSTS = 200
const MAX_CHAT = 200
const POSTS_INDEX_KEY = 'posts/index.json'
const CHAT_INDEX_KEY = 'chat/index.json'

function normalizeCategory(raw: unknown): PostCategory {
    if (raw === 'announcements' || raw === 'results' || raw === 'posts') {
        return raw
    }
    return 'posts'
}

function normalizePost(raw: any): StoredPost {
    const category = normalizeCategory(raw?.category)
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
    private rooms = new Map<string, { name: string }>()
    private st: LobbyState = {
        posts: [],
        chat: [],
        pinnedChatId: null,
    }
    private loaded = false

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        void ctx.blockConcurrencyWhile(async () => {
            await this.ensureLoaded()
        })
    }

    private async loadFromR2(): Promise<LobbyState | null> {
        const bucket = this.env.COMMUNITY_BUCKET
        if (!bucket) return null

        try {
            const [postsObj, chatObj] = await Promise.all([
                bucket.get(POSTS_INDEX_KEY),
                bucket.get(CHAT_INDEX_KEY),
            ])

            let posts: StoredPost[] = []
            let chat: StoredChatMessage[] = []
            let pinnedChatId: string | null = null

            if (postsObj) {
                const parsedPosts = await postsObj.json() as { posts?: StoredPost[] }
                if (Array.isArray(parsedPosts.posts)) {
                    posts = parsedPosts.posts
                        .slice(-MAX_POSTS)
                        .map((post) => normalizePost(post))
                }
            }

            if (chatObj) {
                const parsedChat = await chatObj.json() as {
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

            return { posts, chat, pinnedChatId }
        } catch (error) {
            console.error('Could not load lobby state from R2:', error)
            return null
        }
    }

    private async persistToR2(): Promise<void> {
        const bucket = this.env.COMMUNITY_BUCKET
        if (!bucket) return

        try {
            await Promise.all([
                bucket.put(
                    POSTS_INDEX_KEY,
                    JSON.stringify({
                        updatedAt: Date.now(),
                        posts: this.st.posts.slice(-MAX_POSTS),
                    }),
                    { httpMetadata: { contentType: 'application/json' } },
                ),
                bucket.put(
                    CHAT_INDEX_KEY,
                    JSON.stringify({
                        updatedAt: Date.now(),
                        pinnedChatId: this.st.pinnedChatId,
                        messages: this.st.chat.slice(-MAX_CHAT),
                    }),
                    { httpMetadata: { contentType: 'application/json' } },
                ),
            ])
        } catch (error) {
            console.error('Could not persist lobby state to R2:', error)
        }
    }

    private async ensureLoaded(): Promise<void> {
        if (this.loaded) return

        const stored = await this.ctx.storage.get<LobbyState>('state')
        if (stored) {
            this.st = {
                posts: Array.isArray(stored.posts)
                    ? stored.posts.slice(-MAX_POSTS).map((post) => normalizePost(post))
                    : [],
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

    private async save(): Promise<void> {
        this.st.posts = this.st.posts.slice(-MAX_POSTS)
        this.st.chat = this.st.chat.slice(-MAX_CHAT)
        if (
            this.st.pinnedChatId &&
            !this.st.chat.some((m) => m.id === this.st.pinnedChatId)
        ) {
            this.st.pinnedChatId = null
        }
        await this.ctx.storage.put('state', this.st)
        await this.persistToR2()
    }

    async syncAllToR2(): Promise<void> {
        await this.ensureLoaded()
        await this.persistToR2()
    }

    async list(): Promise<{ name: string }[]> {
        return [...this.rooms.values()]
    }

    async register(name: string): Promise<void> {
        this.rooms.set(name, { name })
    }

    async remove(name: string): Promise<void> {
        this.rooms.delete(name)
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

        await this.save()
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
        await this.save()
        return updated
    }

    async removePost(name: string): Promise<boolean> {
        await this.ensureLoaded()
        const before = this.st.posts.length
        this.st.posts = this.st.posts.filter((post) => post.item.name !== name)
        if (this.st.posts.length === before) return false
        await this.save()
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
        await this.save()
        return current
    }

    async togglePostPin(name: string): Promise<StoredPost | null> {
        await this.ensureLoaded()
        const index = this.st.posts.findIndex((post) => post.item.name === name)
        if (index === -1) return null

        const current = normalizePost(this.st.posts[index])
        current.pinned = !current.pinned
        this.st.posts[index] = current
        await this.save()
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
        await this.save()
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
        await this.save()
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
        await this.save()
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
        await this.save()
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
        await this.save()
        return current
    }

    async togglePinChatMessage(id: string): Promise<string | null> {
        await this.ensureLoaded()
        const exists = this.st.chat.some((m) => m.id === id)
        if (!exists) return this.st.pinnedChatId
        this.st.pinnedChatId = this.st.pinnedChatId === id ? null : id
        await this.save()
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