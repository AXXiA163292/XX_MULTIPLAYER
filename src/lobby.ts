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

export type StoredPost = {
    category: 'announcements' | 'posts' | 'results'
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

const POST_CATEGORIES: readonly StoredPost['category'][] = [
    'announcements',
    'posts',
    'results',
]

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
    const category: StoredPost['category'] =
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
    parts.push(`${likeCount}${likeCount === 1 ? 'like' : 'likes'}`)
    parts.push(`${commentCount}${commentCount === 1 ? 'comment' : 'comments'}`)

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

            await this.syncAllToR2().catch(() => {})
        })
    }

    private async putJson(key: string, data: unknown): Promise<void> {
        if (!this.env.POSTS_BUCKET) return
        await this.env.POSTS_BUCKET.put(key, JSON.stringify(data, null, 2), {
            httpMetadata: { contentType: 'application/json' },
        })
    }

    private async syncCategoryToR2(category: StoredPost['category']): Promise<void> {
        const items = Object.values(this.st.posts)
            .filter((post) => post.category === category)
            .map(normalizePost)
        await this.putJson(`community/posts/${category}.json`, sortPostsList(items)) }  private async syncPostToR2(post: StoredPost): Promise<void> { const norm = normalizePost(post) await this.putJson(`community/post/${norm.item.name}.json`, norm)
        await this.syncCategoryToR2(norm.category)
    }

    private async syncChatToR2(): Promise<void> {
        await this.putJson('community/chat.json', {
            messages: this.st.chat,
            pinnedChatId: this.st.pinnedChatId,
        })
    }

    async syncAllToR2(): Promise<void> {
        for (const cat of POST_CATEGORIES) {
            await this.syncCategoryToR2(cat)
        }
        for (const post of Object.values(this.st.posts)) {
            await this.putJson(`community/post/${post.item.name}.json`, normalizePost(post)) } await this.syncChatToR2() }  private async persist(): Promise<void> { await this.ctx.storage.put('st', this.st) }  async upsert(room: LobbyRoom): Promise<void> { this.st.rooms[room.name] = room await this.persist() }  async remove(name: string): Promise<void> { delete this.st.rooms[name] await this.persist() }  async list(): Promise<LobbyRoom[]> { return Object.values(this.st.rooms) }  async listPosts(category?: StoredPost['category']): Promise<StoredPost[]> { const filtered = Object.values(this.st.posts) .filter((post) => !category \vert{}\vert{} post.category === category) .map(normalizePost) return sortPostsList(filtered) }  async getPost(name: string): Promise<StoredPost \vert{} null> { const post = this.st.posts[name] if (post) return normalizePost(post)  if (this.env.POSTS_BUCKET) { try { const obj = await this.env.POSTS_BUCKET.get(`community/post/${name}.json`)
                if (obj) {
                    const parsed = normalizePost((await obj.json()) as StoredPost)
                    this.st.posts[name] = parsed
                    await this.persist()
                    return parsed
                }
            } catch {
                // ignore
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
        await this.syncPostToR2(norm).catch(() => {})
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
        await this.syncPostToR2(norm).catch(() => {})
    }

    async removePost(name: string): Promise<void> {
        const existing = this.st.posts[name]
        const category = existing?.category
        delete this.st.posts[name]
        await this.persist()
        if (this.env.POSTS_BUCKET) {
            await this.env.POSTS_BUCKET.delete(`community/post/${name}.json`).catch(() => {}) if (category) { await this.syncCategoryToR2(category).catch(() => {}) } else { for (const cat of POST_CATEGORIES) { await this.syncCategoryToR2(cat).catch(() => {}) } } } }  async togglePostLike(name: string, handle: string): Promise<StoredPost \vert{} null> { const post = this.st.posts[name] if (!post) return null  const current = new Set(post.likes ?? []) if (current.has(handle)) { current.delete(handle) } else { current.add(handle) } post.likes = [...current] const norm = normalizePost(post) this.st.posts[name] = norm await this.persist() await this.syncPostToR2(norm).catch(() => {}) return norm }  async togglePostPin(name: string): Promise<StoredPost \vert{} null> { const post = this.st.posts[name] if (!post) return null  post.pinned = !post.pinned const norm = normalizePost(post) this.st.posts[name] = norm await this.persist() await this.syncPostToR2(norm).catch(() => {}) return norm }  async addPostComment( name: string, input: { handle: string; author: string; text: string }, ): Promise<StoredPost \vert{} null> { const post = this.st.posts[name] if (!post) return null  const comment: PostComment = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, handle: input.handle, author: input.author \vert{}\vert{} input.handle, text: input.text, time: Date.now(), }  post.comments = [...(post.comments ?? []).slice(-199), comment] const norm = normalizePost(post) this.st.posts[name] = norm await this.persist() await this.syncPostToR2(norm).catch(() => {}) return norm }  async deletePostComment(name: string, commentId: string): Promise<StoredPost \vert{} null> { const post = this.st.posts[name] if (!post) return null  post.comments = (post.comments ?? []).filter((c) => c.id !== commentId) const norm = normalizePost(post) this.st.posts[name] = norm await this.persist() await this.syncPostToR2(norm).catch(() => {}) return norm }  async listChatMessages(): Promise<ChatMessage[]> { return this.st.chat }  async getPinnedChatId(): Promise<string \vert{} null> { return this.st.pinnedChatId }  async pinChatMessage(id?: string): Promise<string \vert{} null> { const targetId = id ?? this.st.chat[this.st.chat.length - 1]?.id ?? null if (!targetId) { this.st.pinnedChatId = null await this.persist() await this.syncChatToR2().catch(() => {}) return null }  this.st.pinnedChatId = this.st.pinnedChatId === targetId ? null : targetId await this.persist() await this.syncChatToR2().catch(() => {}) return this.st.pinnedChatId }  async addChatMessage(input: { handle: string author: string text: string }): Promise<ChatMessage> { const msg: ChatMessage = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, handle: input.handle, author: input.author \vert{}\vert{} input.handle, text: input.text, time: Date.now(), }  this.st.chat = [...this.st.chat.slice(-199), msg] await this.persist() await this.syncChatToR2().catch(() => {})  this.ctx.waitUntil(this.sendEmailAlert(msg)) return msg }  async deleteChatMessage(id?: string): Promise<boolean> { if (!this.st.chat.length) return false  if (id) { const before = this.st.chat.length this.st.chat = this.st.chat.filter((m) => m.id !== id) if (this.st.pinnedChatId === id) this.st.pinnedChatId = null if (this.st.chat.length === before) return false } else { const removed = this.st.chat[this.st.chat.length - 1] this.st.chat = this.st.chat.slice(0, -1) if (removed && this.st.pinnedChatId === removed.id) { this.st.pinnedChatId = null } }  await this.persist() await this.syncChatToR2().catch(() => {}) return true }  private async sendEmailAlert(msg: ChatMessage): Promise<void> { const apiKey = this.env.RESEND_API_KEY const from = this.env.CHAT_EMAIL_FROM if (!apiKey \vert{}\vert{} !from) return  try { const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`,
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