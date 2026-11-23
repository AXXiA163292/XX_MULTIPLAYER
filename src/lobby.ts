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

export type ChatReplyRef = {
    id: string
    author: string
    handle: string
    text: string
}

export type StoredChatMessage = ChatMessage & {
    replyTo?: ChatReplyRef
    likes?: string[]
    reactions?: Record<string, string[]>
}

type LobbyState = {
    rooms: Record<string, LobbyRoom>
    posts: Record<string, StoredPost>
    chat: StoredChatMessage[]
    pinnedChatId: string | null
}

const CHAT_INDEX_KEY = 'chat/index.json'

const freshLobby = (): LobbyState => ({
    rooms: {},
    posts: {},
    chat: [],
    pinnedChatId: null,
})

function isValidCategory(value: unknown): value is PostCategory {
    return value === 'announcements' || value === 'posts' || value === 'results'
}

function sortPostsList(posts: StoredPost[]): StoredPost[] {
    return [...posts].sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) {
            return a.pinned ? -1 : 1
        }
        return b.item.time - a.item.time
    })
}

function normalizePost(post: StoredPost): StoredPost {
    const category: PostCategory = isValidCategory(post.category)
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

function normalizeChatMessage(msg: StoredChatMessage): StoredChatMessage {
    const likes = Array.isArray(msg.likes)
        ? [...new Set(msg.likes.map((h) => String(h).trim()).filter(Boolean))]
        : []

    const rawReactions =
        msg.reactions && typeof msg.reactions === 'object' ? msg.reactions : {}
    const reactions: Record<string, string[]> = {}
    for (const [emoji, handles] of Object.entries(rawReactions)) {
        const cleanEmoji = String(emoji).trim()
        if (!cleanEmoji || !Array.isArray(handles)) continue
        const deduped = [...new Set(handles.map((h) => String(h).trim()).filter(Boolean))]
        if (deduped.length > 0) {
            reactions[cleanEmoji] = deduped
        }
    }

    return {
        ...msg,
        likes,
        reactions,
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
                    ? saved.chat.slice(-200).map((m) => normalizeChatMessage(m as StoredChatMessage))
                    : [],
                pinnedChatId:
                    typeof saved?.pinnedChatId === 'string'
                        ? saved.pinnedChatId
                        : null,
            }

            await this.initChatFromR2IfEmpty().catch(() => {})
        })
    }

    private async initChatFromR2IfEmpty(): Promise<void> {
        const bucket = this.env.COMMUNITY_BUCKET
        if (!bucket) return

        if (this.st.chat.length === 0) {
            const obj = await bucket.get(CHAT_INDEX_KEY).catch(() => null)
            if (obj) {
                const parsed = (await obj.json().catch(() => null)) as {
                    messages?: StoredChatMessage[]
                    pinnedChatId?: string | null
                } | null
                if (parsed && Array.isArray(parsed.messages)) {
                    this.st.chat = parsed.messages
                        .slice(-200)
                        .map((m) => normalizeChatMessage(m))
                    if (typeof parsed.pinnedChatId === 'string') {
                        this.st.pinnedChatId = parsed.pinnedChatId
                    }
                    await this.persist()
                }
            }
        }

        await this.syncChatToR2()
    }

    private async syncChatToR2(): Promise<void> {
        const bucket = this.env.COMMUNITY_BUCKET
        if (!bucket) return

        await bucket.put(
            CHAT_INDEX_KEY,
            JSON.stringify({
                messages: this.st.chat,
                pinnedChatId: this.st.pinnedChatId,
            }),
            {
                httpMetadata: {
                    contentType: 'application/json',
                },
            },
        )
    }

    async syncAllToR2(): Promise<void> {
        await this.syncChatToR2()
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
            .map(normalizePost)
            .filter((post) => !category || post.category === category)

        return sortPostsList(filtered)
    }

    async getPost(name: string): Promise<StoredPost | null> {
        const existing = this.st.posts[name]
        return existing ? normalizePost(existing) : null
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
        await this.persist()
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

        this.st.posts[name] = normalizePost(post)
        await this.persist()
    }

    async removePost(name: string): Promise<void> {
        if (!this.st.posts[name]) return
        delete this.st.posts[name]
        await this.persist()
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
        await this.persist()
        return normalized
    }

    async togglePostPin(name: string): Promise<StoredPost | null> {
        const post = this.st.posts[name]
        if (!post) return null

        post.pinned = !post.pinned
        const normalized = normalizePost(post)
        this.st.posts[name] = normalized
        await this.persist()
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
        await this.persist()
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
        await this.persist()
        return normalized
    }

    async listChatMessages(): Promise<StoredChatMessage[]> {
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
        replyTo?: ChatReplyRef
    }): Promise<StoredChatMessage> {
        const message: StoredChatMessage = normalizeChatMessage({
            id: `${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 7)}`,
            handle: input.handle,
            author: input.author || input.handle,
            text: input.text,
            time: Date.now(),
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
            likes: [],
            reactions: {},
        })

        this.st.chat = [...this.st.chat.slice(-199), message]
        await Promise.all([this.persist(), this.syncChatToR2()])

        this.ctx.waitUntil(this.sendEmailAlert(message))
        return message
    }

    async toggleChatLike(id: string, handle: string): Promise<StoredChatMessage | null> {
        const cleanHandle = String(handle ?? '').trim()
        if (!cleanHandle) return null

        let updated: StoredChatMessage | null = null
        this.st.chat = this.st.chat.map((msg) => {
            if (msg.id !== id) return msg
            const normalized = normalizeChatMessage(msg)
            const set = new Set(normalized.likes ?? [])
            if (set.has(cleanHandle)) set.delete(cleanHandle)
            else set.add(cleanHandle)
            updated = normalizeChatMessage({
                ...normalized,
                likes: [...set],
            })
            return updated
        })

        if (!updated) return null
        await Promise.all([this.persist(), this.syncChatToR2()])
        return updated
    }

    async toggleChatReaction(
        id: string,
        handle: string,
        emoji: string,
    ): Promise<StoredChatMessage | null> {
        const cleanHandle = String(handle ?? '').trim()
        const cleanEmoji = String(emoji ?? '').trim().slice(0, 16)
        if (!cleanHandle || !cleanEmoji) return null

        let updated: StoredChatMessage | null = null
        this.st.chat = this.st.chat.map((msg) => {
            if (msg.id !== id) return msg
            const normalized = normalizeChatMessage(msg)
            const reactions: Record<string, string[]> = { ...(normalized.reactions ?? {}) }
            const set = new Set(reactions[cleanEmoji] ?? [])
            if (set.has(cleanHandle)) set.delete(cleanHandle)
            else set.add(cleanHandle)
            if (set.size === 0) delete reactions[cleanEmoji]
            else reactions[cleanEmoji] = [...set]
            updated = normalizeChatMessage({
                ...normalized,
                reactions,
            })
            return updated
        })

        if (!updated) return null
        await Promise.all([this.persist(), this.syncChatToR2()])
        return updated
    }

    async deleteChatMessage(id: string): Promise<boolean> {
        const cleanId = String(id ?? '').trim()
        if (!cleanId || !this.st.chat.length) return false

        const before = this.st.chat.length
        this.st.chat = this.st.chat.filter(
            (message) => message.id !== cleanId,
        )

        if (this.st.pinnedChatId === cleanId) {
            this.st.pinnedChatId = null
        }

        if (this.st.chat.length === before) return false

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
                        subject: `New ${msg.author} (${msg.handle}) message in XX!`,
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