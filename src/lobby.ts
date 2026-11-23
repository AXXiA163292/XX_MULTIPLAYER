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

export type StoredPost = {
    category: 'announcements' | 'posts' | 'results'
    item: {
        name: string
        version: 1
        title: string
        subtitle?: string
        time: number
        author: string
        tags: { title: string }[]
        thumbnail?: { hash: string; url: string }
    }
    description: string
    uploadKey?: string
    thumbnailHash?: string
}

type LobbyState = {
    rooms: Record<string, LobbyRoom>
    posts: Record<string, StoredPost>
    chat: ChatMessage[]
}

const freshLobby = (): LobbyState => ({
    rooms: {},
    posts: {},
    chat: [],
})

export class Lobby extends DurableObject<Env> {
    st: LobbyState = freshLobby()

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)

        ctx.blockConcurrencyWhile(async () => {
            const saved = await ctx.storage.get<Partial<LobbyState>>('st')
            const base = freshLobby()

            this.st = {
                ...base,
                ...(saved ?? {}),
                rooms: saved?.rooms && typeof saved.rooms === 'object' ? saved.rooms : {},
                posts: saved?.posts && typeof saved.posts === 'object' ? saved.posts : {},
                chat: Array.isArray(saved?.chat) ? saved.chat.slice(-200) : [],
            }
        })
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

    async listPosts(category?: StoredPost['category']): Promise<StoredPost[]> {
        return Object.values(this.st.posts)
            .filter((post) => !category || post.category === category)
            .sort((a, b) => b.item.time - a.item.time)
    }

    async getPost(name: string): Promise<StoredPost | null> {
        return this.st.posts[name] ?? null
    }

    async findPostByUploadKey(uploadKey: string): Promise<StoredPost | null> {
        return (
            Object.values(this.st.posts).find((post) => post.uploadKey === uploadKey) ??
            null
        )
    }

    async createPost(post: StoredPost): Promise<void> {
        this.st.posts[post.item.name] = post
        await this.persist()
    }

    async setPostThumbnail(name: string, hash: string, url: string): Promise<void> {
        const post = this.st.posts[name]
        if (!post) return

        post.item.thumbnail = { hash, url }
        post.thumbnailHash = hash
        delete post.uploadKey
        await this.persist()
    }

    async removePost(name: string): Promise<void> {
        delete this.st.posts[name]
        await this.persist()
    }

    async listChatMessages(): Promise<ChatMessage[]> {
        return this.st.chat
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

        this.ctx.waitUntil(this.sendEmailAlert(msg))
        return msg
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
                    subject: `New XX! Chat from ${msg.author} (${msg.handle})`,
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