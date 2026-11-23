import { DurableObject } from 'cloudflare:workers'
import { STAFF_CHAT_ALERT_EMAIL } from './config.ts'
import type { ChatMessage, Env } from './types.ts'

export type LobbyRoom = {
    name: string
    title: string
    subtitle: string
    master: string
    hostId: string
    visibility: 'public' | 'private' | 'locked'
}

export type PostComment = {
    id: string
    handle: string
    author: string
    text: string
    time: number
}

export type PostCategory = 'announcements' | 'posts' | 'results'

export type StoredPost = {
    category: PostCategory
    item: {
        name: string
        version: 1
        title: string
        subtitle?: string
        time: number
        author: string
        tags: { title: string; icon?: string }[]
        thumbnail?: { hash: string; url: string }
    }
    description: string
    uploadKey?: string
    thumbnailHash?: string
    likes?: string[]
    comments?: PostComment[]
    pinned?: boolean
}

type LobbyState = {
    rooms: Record<string, LobbyRoom>
    posts: Record<string, StoredPost>
    chat: ChatMessage[]
    pinnedChatId: string | null
}

const POST_CATEGORIES: readonly PostCategory[] = [
    'announcements',
    'posts',
    'results',
]

const CHAT_INDEX_KEY = 'chat/index.json'
const LEGACY_CHAT_KEY = 'chat.json'

const freshLobby = (): LobbyState => ({
    rooms: {},
    posts: {},
    chat: [],
    pinnedChatId: null,
})

function sortPostsList(posts: StoredPost[]): StoredPost[] {
    return [...posts].sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) {
            return a.pinned ? -1 : 1
        }
        return b.item.time - a.item.time
    })
}

function normalizePost(post: StoredPost): StoredPost {
    const category: PostCategory =
        post.category === 'announcements' || post.category === 'results'
            ? post.category
            : 'posts'

    const likes = Array.isArray(post.likes) ? post.likes : []
    const comments = Array.isArray(post.comments) ? post.comments : []
    const pinned = Boolean(post.pinned)
    const likeCount = likes.length
    const commentCount = comments.length

    const parts: string[] = []
    if (pinned) parts.push('Pinned')
    parts.push(`${likeCount} ${likeCount === 1 ? 'like' : 'likes'}`)
    parts.push(`${commentCount} ${commentCount === 1 ? 'comment' : 'comments'}`)

    const tags: { title: string; icon?: string }[] = []
    if (pinned) tags.push({ title: 'Pinned', icon: 'pin' })
    tags.push({ title: String(likeCount), icon: 'heart' })
    if (commentCount > 0) {
        tags.push({ title: String(commentCount), icon: 'comment' })
    }

    return {
        ...post,
        category,
        likes,
        comments,
        pinned,
        item: {
            ...post.item,
            subtitle: parts.join(' · '),
            tags,
        },
    }
}

export class Lobby extends DurableObject<Env> {
    st: LobbyState = freshLobby()

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)

        ctx.blockConcurrencyWhile(async () => {
            const saved = await ctx.storage.get<Partial<LobbyState>>('st')
            const base = freshLobby()
            const rawPosts =
                saved?.posts && typeof saved.posts === 'object'
                    ? saved.posts
                    : {}

            const posts: Record<string, StoredPost> = {}
            for (const [key, value] of Object.entries(rawPosts)) {
                if (value && typeof value === 'object') {
                    posts[key] = normalizePost(value as StoredPost)
                }
            }

            this.st = {
                ...base,
                ...(saved ?? {}),
                rooms:
                    saved?.rooms && typeof saved.rooms === 'object'
                        ? saved.rooms
                        : {},
                posts,
                chat: Array.isArray(saved?.chat)
                    ? saved.chat.slice(-200)
                    : [],
                pinnedChatId:
                    typeof saved?.pinnedChatId === 'string'
                        ? saved.pinnedChatId
                        : null,
            }

            await this.initFromR2IfNeeded().catch(() => {})
        })
    }

    private async putJson(key: string, data: unknown): Promise<void> {
        if (!this.env.COMMUNITY_BUCKET) return
        await this.env.COMMUNITY_BUCKET.put(key, JSON.stringify(data, null, 2), {
            httpMetadata: {
                contentType: 'application/json',
            },
        })
    }

    private async getJson<T>(key: string): Promise<T | null> {
        if (!this.env.COMMUNITY_BUCKET) return null
        const object = await this.env.COMMUNITY_BUCKET.get(key)
        if (!object) return null

        try {
            return (await object.json()) as T
        } catch {
            return null
        }
    }

    private async initFromR2IfNeeded(): Promise<void> {
        if (!this.env.COMMUNITY_BUCKET) return

        // Clean up legacy root chat.json if present
        await this.env.COMMUNITY_BUCKET.delete(LEGACY_CHAT_KEY).catch(() => {})

        const hasAnySavedPosts = Object.keys(this.st.posts).length > 0
        if (hasAnySavedPosts) {
            await this.syncAllToR2()
            return
        }

        let imported = false
        for (const category of POST_CATEGORIES) {
            const stored = await this.getJson<StoredPost[]>(`${category}/index.json`)
            if (!Array.isArray(stored)) continue

            for (const rawPost of stored) {
                if (rawPost?.item?.name) {
                    const post = normalizePost({ ...rawPost, category })
                    this.st.posts[post.item.name] = post
                    imported = true
                }
            }
        }

        const storedChat = await this.getJson<{
            messages?: ChatMessage[]
            pinnedChatId?: string | null
        }>(CHAT_INDEX_KEY)

        if (storedChat && Array.isArray(storedChat.messages) && this.st.chat.length === 0) {
            this.st.chat = storedChat.messages.slice(-200)
            this.st.pinnedChatId =
                typeof storedChat.pinnedChatId === 'string'
                    ? storedChat.pinnedChatId
                    : null
            imported = true
        }

        if (imported) {
            await this.persist()
        }
        await this.syncAllToR2()
    }

    private async syncCategoryToR2(category: PostCategory): Promise<void> {
        const items = sortPostsList(
            Object.values(this.st.posts)
                .filter((post) => post.category === category)
                .map(normalizePost),
        )
        await this.putJson(`${category}/index.json`, items)
    }

    private async syncPostToR2(post: StoredPost): Promise<void> {
        const normalized = normalizePost(post)
        await Promise.all([
            this.putJson(`${normalized.category}/${normalized.item.name}.json`, normalized),
            this.syncCategoryToR2(normalized.category),
        ])
    }

    private async syncChatToR2(): Promise<void> {
        await this.putJson(CHAT_INDEX_KEY, {
            messages: this.st.chat,
            pinnedChatId: this.st.pinnedChatId,
        })
    }

    async syncAllToR2(): Promise<void> {
        const writes: Promise<void>[] = POST_CATEGORIES.map((category) =>
            this.syncCategoryToR2(category),
        )
        for (const post of Object.values(this.st.posts)) {
            const normalized = normalizePost(post)
            writes.push(
                this.putJson(
                    `${normalized.category}/${normalized.item.name}.json`,
                    normalized,
                ),
            )
        }
        writes.push(this.syncChatToR2())
        await Promise.all(writes)
    }

    private async persist(): Promise<void> {
        await this.ctx.storage.put('st', this.st)
    }

    async upsert(room: LobbyRoom): Promise<void> {
        this.st.rooms[room.name] = room
        await this.persist()
    }

    async remove(name: string): Promise<void> {
        delete this.st.rooms[name]
        await this.persist()
    }

    async list(): Promise<LobbyRoom[]> {
        return Object.values(this.st.rooms)
    }

    async listPosts(category?: PostCategory): Promise<StoredPost[]> {
        const filtered = Object.values(this.st.posts)
            .filter((post) => !category || post.category === category)
            .map(normalizePost)

        return sortPostsList(filtered)
    }

    async getPost(name: string): Promise<StoredPost | null> {
        const existing = this.st.posts[name]
        if (existing) return normalizePost(existing)

        for (const category of POST_CATEGORIES) {
            const stored = await this.getJson<StoredPost>(`${category}/${name}.json`)
            if (!stored) continue

            const post = normalizePost({ ...stored, category })
            this.st.posts[name] = post
            await this.persist()
            return post
        }

        return null
    }

    async findPostByUploadKey(uploadKey: string): Promise<StoredPost | null> {
        return (
            Object.values(this.st.posts).find(
                (post) => post.uploadKey === uploadKey,
            ) ?? null
        )
    }

    async createPost(post: StoredPost): Promise<void> {
        const normalized = normalizePost(post)
        this.st.posts[normalized.item.name] = normalized
        await Promise.all([
            this.persist(),
            this.syncPostToR2(normalized),
        ])
    }

    async setPostThumbnail(
        name: string,
        hash: string,
        url: string,
    ): Promise<void> {
        const post = this.st.posts[name]
        if (!post) return

        post.item.thumbnail = { hash, url }
        post.thumbnailHash = hash
        delete post.uploadKey

        const normalized = normalizePost(post)
        this.st.posts[name] = normalized

        await Promise.all([
            this.persist(),
            this.syncPostToR2(normalized),
        ])
    }

    async removePost(name: string): Promise<void> {
        const existing = this.st.posts[name]
        if (!existing) return

        delete this.st.posts[name]
        await Promise.all([
            this.persist(),
            this.env.COMMUNITY_BUCKET?.delete(`${existing.category}/${name}.json`) ?? Promise.resolve(),
            this.syncCategoryToR2(existing.category),
        ])
    }

    async togglePostLike(
        name: string,
        handle: string,
    ): Promise<StoredPost | null> {
        const post = this.st.posts[name]
        if (!post) return null

        const current = new Set(post.likes ?? [])
        if (current.has(handle)) {
            current.delete(handle)
        } else {
            current.add(handle)
        }

        post.likes = [...current]
        const normalized = normalizePost(post)
        this.st.posts[name] = normalized

        await Promise.all([
            this.persist(),
            this.syncPostToR2(normalized),
        ])

        return normalized
    }

    async togglePostPin(name: string): Promise<StoredPost | null> {
        const post = this.st.posts[name]
        if (!post) return null

        post.pinned = !post.pinned
        const normalized = normalizePost(post)
        this.st.posts[name] = normalized

        await Promise.all([
            this.persist(),
            this.syncPostToR2(normalized),
        ])

        return normalized
    }

    async addPostComment(
        name: string,
        input: {
            handle: string
            author: string
            text: string
        },
    ): Promise<StoredPost | null> {
        const post = this.st.posts[name]
        if (!post) return null

        const comment: PostComment = {
            id: `${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 7)}`,
            handle: input.handle,
            author: input.author || input.handle,
            text: input.text,
            time: Date.now(),
        }

        post.comments = [...(post.comments ?? []).slice(-199), comment]
        const normalized = normalizePost(post)
        this.st.posts[name] = normalized

        await Promise.all([
            this.persist(),
            this.syncPostToR2(normalized),
        ])

        return normalized
    }

    async deletePostComment(
        name: string,
        commentId: string,
    ): Promise<StoredPost | null> {
        const post = this.st.posts[name]
        if (!post) return null

        post.comments = (post.comments ?? []).filter(
            (comment) => comment.id !== commentId,
        )

        const normalized = normalizePost(post)
        this.st.posts[name] = normalized

        await Promise.all([
            this.persist(),
            this.syncPostToR2(normalized),
        ])

        return normalized
    }

    async listChatMessages(): Promise<ChatMessage[]> {
        return this.st.chat
    }

    async getPinnedChatId(): Promise<string | null> {
        return this.st.pinnedChatId
    }

    async pinChatMessage(id?: string): Promise<string | null> {
        const targetId =
            id ?? this.st.chat[this.st.chat.length - 1]?.id ?? null

        if (!targetId) {
            this.st.pinnedChatId = null
            await Promise.all([this.persist(), this.syncChatToR2()])
            return null
        }

        this.st.pinnedChatId =
            this.st.pinnedChatId === targetId ? null : targetId

        await Promise.all([this.persist(), this.syncChatToR2()])
        return this.st.pinnedChatId
    }

    async addChatMessage(input: {
        handle: string
        author: string
        text: string
    }): Promise<ChatMessage> {
        const message: ChatMessage = {
            id: `${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 7)}`,
            handle: input.handle,
            author: input.author || input.handle,
            text: input.text,
            time: Date.now(),
        }

        this.st.chat = [...this.st.chat.slice(-199), message]
        await Promise.all([this.persist(), this.syncChatToR2()])

        this.ctx.waitUntil(this.sendEmailAlert(message))
        return message
    }

    async deleteChatMessage(id?: string): Promise<boolean> {
        if (!this.st.chat.length) return false

        if (id) {
            const before = this.st.chat.length
            this.st.chat = this.st.chat.filter(
                (message) => message.id !== id,
            )

            if (this.st.pinnedChatId === id) {
                this.st.pinnedChatId = null
            }

            if (this.st.chat.length === before) return false
        } else {
            const removed = this.st.chat[this.st.chat.length - 1]
            this.st.chat = this.st.chat.slice(0, -1)

            if (removed && this.st.pinnedChatId === removed.id) {
                this.st.pinnedChatId = null
            }
        }

        await Promise.all([this.persist(), this.syncChatToR2()])
        return true
    }

    private async sendEmailAlert(msg: ChatMessage): Promise<void> {
        const apiKey = this.env.RESEND_API_KEY
        const from = this.env.CHAT_EMAIL_FROM

        if (!apiKey || !from) return

        try {
            const response = await fetch(
                'https://api.resend.com/emails',
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        from,
                        to: [STAFF_CHAT_ALERT_EMAIL],
                        subject: `New ${msg.author} (${msg.handle}) message in XX! Chat`,
                        text: `${msg.author} (${msg.handle}):\n${msg.text}`,
                    }),
                    signal: AbortSignal.timeout(8000),
                },
            )

            if (!response.ok) {
                console.warn(
                    'Chat email alert failed:',
                    response.status,
                    await response.text().catch(() => ''),
                )
            }
        } catch (error) {
            console.warn('Chat email alert error:', error)
        }
    }
}