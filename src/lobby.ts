import { DurableObject } from 'cloudflare:workers'
import type { Env } from './types.ts'

export type PostCategory = 'announcements' | 'posts' | 'results'

export type LobbyRoom = {
    name: string
    title: string
    subtitle: string
    master: string
    hostId?: string
    hostHandle?: string
    visibility?: 'public' | 'private' | 'locked'
}

export type LobbyPost = {
    category?: PostCategory | 'news'
    item: {
        name: string
        version: 1
        title: string
        time: number
        author: string
        tags: { title: string }[]
        thumbnail?: { hash: string; url: string }
    }
    description: string
    uploadKey: string
    thumbnailHash: string
}

export type ChatMessage = {
    id: string
    handle: string
    author: string
    text: string
    time: number
}

export class Lobby extends DurableObject<Env> {
    async upsert(room: LobbyRoom): Promise<void> {
        await this.ctx.storage.put(`room:${room.name}`, room)
    }

    async remove(name: string): Promise<void> {
        await this.ctx.storage.delete(`room:${name}`)
    }

    async list(): Promise<LobbyRoom[]> {
        const map = await this.ctx.storage.list<LobbyRoom>({
            prefix: 'room:',
        })

        return [...map.values()]
    }

    async createPost(post: LobbyPost): Promise<void> {
        await this.ctx.storage.put(`post:${post.item.name}`, post)
    }

    async getPost(name: string): Promise<LobbyPost | null> {
        return (await this.ctx.storage.get<LobbyPost>(`post:${name}`)) ?? null
    }

    async listPosts(category?: PostCategory): Promise<LobbyPost[]> {
        const map = await this.ctx.storage.list<LobbyPost>({
            prefix: 'post:',
        })

        return [...map.values()]
            .filter((post) => {
                const stored = post.category ?? 'posts'
                const normalized = stored === 'news' ? 'posts' : stored
                return !category || normalized === category
            })
            .sort((a, b) => b.item.time - a.item.time)
    }

    async findPostByUploadKey(key: string): Promise<LobbyPost | null> {
        const posts = await this.listPosts()
        return posts.find((post) => post.uploadKey === key) ?? null
    }

    async setPostThumbnail(
        name: string,
        hash: string,
        url: string,
    ): Promise<void> {
        const post = await this.getPost(name)
        if (!post) return

        post.item.thumbnail = { hash, url }
        post.uploadKey = ''

        await this.createPost(post)
    }

    async removePost(name: string): Promise<void> {
        await this.ctx.storage.delete(`post:${name}`)
    }

    async listChatMessages(): Promise<ChatMessage[]> {
        const messages = await this.ctx.storage.get<ChatMessage[]>('staff_chat_messages')
        return Array.isArray(messages) ? messages : []
    }

    async addChatMessage(msg: Omit<ChatMessage, 'id' | 'time'>): Promise<ChatMessage[]> {
        const handle = String(msg.handle).trim()
        const current = await this.listChatMessages()
        const entry: ChatMessage = {
            id: crypto.randomUUID(),
            handle,
            author: String(msg.author || handle).trim(),
            text: String(msg.text).slice(0, 500),
            time: Date.now(),
        }

        const updated = [...current.slice(-99), entry]
        await this.ctx.storage.put('staff_chat_messages', updated)
        await this.markChatRead(handle, entry.time)
        return updated
    }

    async markChatRead(handle: string, timestamp = Date.now()): Promise<void> {
        const cleanHandle = String(handle).trim()
        if (!cleanHandle) return
        const reads = (await this.ctx.storage.get<Record<string, number>>('staff_chat_reads')) ?? {}
        reads[cleanHandle] = Math.max(reads[cleanHandle] ?? 0, timestamp)
        await this.ctx.storage.put('staff_chat_reads', reads)
    }

    async getChatUnreadCount(handle: string): Promise<number> {
        const cleanHandle = String(handle).trim()
        if (!cleanHandle) return 0

        const [messages, reads] = await Promise.all([
            this.listChatMessages(),
            this.ctx.storage.get<Record<string, number>>('staff_chat_reads'),
        ])

        const lastRead = reads?.[cleanHandle] ?? 0
        return messages.filter((m) => m.handle !== cleanHandle && m.time > lastRead).length
    }
}