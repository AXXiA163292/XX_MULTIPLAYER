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

const CATEGORIES: readonly PostCategory[] = ['announcements', 'posts', 'results']

const freshLobby = (): LobbyState => ({
    rooms: {},
    posts: {},
    chat: [],
    pinnedChatId: null,
})

function sortPosts(posts: StoredPost[]): StoredPost[] {
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
    if (commentCount > 0) tags.push({ title: String(commentCount), icon: 'comment' })

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
                saved?.posts && typeof saved.posts === 'object' ? saved.posts : {}
            const posts: Record<string, StoredPost> = {}
            for (const [k, v] of Object.entries(rawPosts)) {
                if (v && typeof v === 'object') {
                    posts[k] = normalizePost(v as StoredPost)
                }
            }

            this.st = {
                ...base,
                ...(saved ?? {}),
                rooms: saved?.rooms && typeof saved.rooms === 'object' ? saved.rooms : {},
                posts,
                chat: Array.isArray(saved?.chat) ? saved.chat.slice(-200) : [],
                pinnedChatId: typeof saved?.pinnedChatId === 'string' ? saved.pinnedChatId : null,
            }

            await this.hydrateFromR2AndPersist().catch(() => {})
        })
    }

    private bucket(): R2Bucket | undefined {
        return (this.env as Env & { COMMUNITY_BUCKET?: R2Bucket }).COMMUNITY_BUCKET ?? this.env.POSTS_BUCKET
    }

    private async putJson(key: string, value: unknown): Promise<void> {
        const b = this.bucket()
        if (!b) return
        await b.put(key, JSON.stringify(value, null, 2), {
            httpMetadata: { contentType: 'application/json' },
        })
    }

    private async hydrateFromR2AndPersist(): Promise<void> {
        const b = this.bucket()
        if (!b) return

        let changed = false
        for (const cat of CATEGORIES) {
            const idxObj = await b.get(`${cat}/index.json`).catch(() => null)
            if (idxObj) {
                const list = (await idxObj.json().catch(() => [])) as StoredPost[]
                if (Array.isArray(list)) {
                    for (const entry of list) {
                        if (entry?.item?.name && !this.st.posts[entry.item.name]) {
                            this.st.posts[entry.item.name] = normalizePost({
                                ...entry,
                                category: cat,
                            })
                            changed = true
                        }
                    }
                }
            }
        }

        const chatObj = await b.get('chat/index.json').catch(() => null)
        if (chatObj && this.st.chat.length === 0) {
            const data = (await chatObj.json().catch(() => null)) as {
                messages?: ChatMessage[]
                pinnedChatId?: string | null
            } | null
            if (data && Array.isArray(data.messages) && data.messages.length > 0) {
                this.st.chat = data.messages.slice(-200)
                if (typeof data.pinnedChatId === 'string') {
                    this.st.pinnedChatId = data.pinnedChatId
                }
                changed = true
            }
        }

        if (changed) {
            await this.persist()
        }
        await this.syncAllToR2()
    }

    private async syncCategoryIndex(cat: PostCategory): Promise<void> {
        const posts = sortPosts(
            Object.values(this.st.posts)
                .filter((p) => p.category === cat)
                .map(normalizePost),
        )
        await this.putJson(`${cat}/index.json`, posts)
    }

    private async syncPostRecord(post: StoredPost): Promise<void> {
        const norm = normalizePost(post)
        await this.putJson(`${norm.category}/${norm.item.name}/post.json`, norm)
        await this.syncCategoryIndex(norm.category)
    }

    private async syncChatRecord(): Promise<void> {
        await this.putJson('chat/index.json', {
            messages: this.st.chat,
            pinnedChatId: this.st.pinnedChatId,
        })
    }

    async syncAllToR2(): Promise<void> {
        for (const cat of CATEGORIES) {
            await this.syncCategoryIndex(cat)
        }
        for (const post of Object.values(this.st.posts)) {
            await this.putJson(`${post.category}/${post.item.name}/post.json`, normalizePost(post))
        }
        await this.syncChatRecord()
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
        const posts = Object.values(this.st.posts)
            .filter((post) => !category || post.category === category)
            .map(normalizePost)
        return sortPosts(posts)
    }

    async getPost(name: string): Promise<StoredPost | null> {
        const existing = this.st.posts[name]
        if (existing) return normalizePost(existing)

        const b = this.bucket()
        if (b) {
            for (const cat of CATEGORIES) {
                const obj = await b.get(`${cat}/${name}/post.json`).catch(() => null)
                if (obj) {
                    const parsed = normalizePost({
                        ...((await obj.json()) as StoredPost),
                        category: cat,
                    })
                    this.st.posts[name] = parsed
                    await this.persist()
                    return parsed
                }
            }
        }
        return null
    }

    async findPostByUploadKey(uploadKey: string): Promise<StoredPost | null> {
        return (
            Object.values(this.st.posts).find((post) => post.uploadKey === uploadKey) ??
            null
        )
    }

    async createPost(post: StoredPost): Promise<void> {
        const norm = normalizePost(post)
        this.st.posts[norm.item.name] = norm
        await this.persist()
        await this.syncPostRecord(norm).catch(() => {})
    }

    async setPostThumbnail(name: string, hash: string, url: string): Promise<void> {
        const post = this.st.posts[name]
        if (!post) return

        post.item.thumbnail = { hash, url }
        post.thumbnailHash = hash
        delete post.uploadKey
        const norm = normalizePost(post)
        this.st.posts[name] = norm
        await this.persist()
        await this.syncPostRecord(norm).catch(() => {})
    }

    async removePost(name: string): Promise<void> {
        const post = this.st.posts[name]
        const cat = post?.category
        delete this.st.posts[name]
        await this.persist()

        const b = this.bucket()
        if (b) {
            for (const c of cat ? [cat] : CATEGORIES) {
                await b.delete(`${c}/${name}/post.json`).catch(() => {})
                await b.delete(`${c}/${name}/thumbnail`).catch(() => {})
                await this.syncCategoryIndex(c).catch(() => {})
            }
        }
    }

    async togglePostLike(name: string, handle: string): Promise<StoredPost | null> {
        const post = this.st.posts[name]
        if (!post) return null

        const current = new Set(post.likes ?? [])
        if (current.has(handle)) {
            current.delete(handle)
        } else {
            current.add(handle)
        }
        post.likes = [...current]
        const norm = normalizePost(post)
        this.st.posts[name] = norm
        await this.persist()
        await this.syncPostRecord(norm).catch(() => {})
        return norm
    }

    async togglePostPin(name: string): Promise<StoredPost | null> {
        const post = this.st.posts[name]
        if (!post) return null

        post.pinned = !post.pinned
        const norm = normalizePost(post)
        this.st.posts[name] = norm
        await this.persist()
        await this.syncPostRecord(norm).catch(() => {})
        return norm
    }

    async addPostComment(
        name: string,
        input: { handle: string; author: string; text: string },
    ): Promise<StoredPost | null> {
        const post = this.st.posts[name]
        if (!post) return null

        const comment: PostComment = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            handle: input.handle,
            author: input.author || input.handle,
            text: input.text,
            time: Date.now(),
        }

        post.comments = [...(post.comments ?? []).slice(-199), comment]
        const norm = normalizePost(post)
        this.st.posts[name] = norm
        await this.persist()
        await this.syncPostRecord(norm).catch(() => {})
        return norm
    }

    async deletePostComment(name: string, commentId: string): Promise<StoredPost | null> {
        const post = this.st.posts[name]
        if (!post) return null

        post.comments = (post.comments ?? []).filter((c) => c.id !== commentId)
        const norm = normalizePost(post)
        this.st.posts[name] = norm
        await this.persist()
        await this.syncPostRecord(norm).catch(() => {})
        return norm
    }

    async listChatMessages(): Promise<ChatMessage[]> {
        return this.st.chat
    }

    async getPinnedChatId(): Promise<string | null> {
        return this.st.pinnedChatId
    }

    async pinChatMessage(id?: string): Promise<string | null> {
        const targetId = id ?? this.st.chat[this.st.chat.length - 1]?.id ?? null
        if (!targetId) {
            this.st.pinnedChatId = null
            await this.persist()
            await this.syncChatRecord().catch(() => {})
            return null
        }

        this.st.pinnedChatId = this.st.pinnedChatId === targetId ? null : targetId
        await this.persist()
        await this.syncChatRecord().catch(() => {})
        return this.st.pinnedChatId
    }

    async addChatMessage(input: {
        handle: string
        author: string
        text: string
    }): Promise<ChatMessage> {
        const msg: ChatMessage = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            handle: input.handle,
            author: input.author || input.handle,
            text: input.text,
            time: Date.now(),
        }

        this.st.chat = [...this.st.chat.slice(-199), msg]
        await this.persist()
        await this.syncChatRecord().catch(() => {})

        this.ctx.waitUntil(this.sendEmailAlert(msg))
        return msg
    }

    async deleteChatMessage(id?: string): Promise<boolean> {
        if (!this.st.chat.length) return false

        if (id) {
            const before = this.st.chat.length
            this.st.chat = this.st.chat.filter((m) => m.id !== id)
            if (this.st.pinnedChatId === id) this.st.pinnedChatId = null
            if (this.st.chat.length === before) return false
        } else {
            const removed = this.st.chat[this.st.chat.length - 1]
            this.st.chat = this.st.chat.slice(0, -1)
            if (removed && this.st.pinnedChatId === removed.id) {
                this.st.pinnedChatId = null
            }
        }

        await this.persist()
        await this.syncChatRecord().catch(() => {})
        return true
    }

    private async sendEmailAlert(msg: ChatMessage): Promise<void> {
        const apiKey = this.env.RESEND_API_KEY
        const from = this.env.CHAT_EMAIL_FROM
        if (!apiKey || !from) return

        try {
            const res = await fetch('https://api.resend.com/emails', {
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
            })

            if (!res.ok) {
                console.warn('Chat email alert failed:', res.status, await res.text().catch(() => ''))
            }
        } catch (err) {
            console.warn('Chat email alert error:', err)
        }
    }
}