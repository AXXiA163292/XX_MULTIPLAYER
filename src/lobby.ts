
import { DurableObject } from 'cloudflare:workers'
import type { Env } from './types.ts'

export type PostCategory = 'announcements' | 'news'

export type LobbyRoom = {
    name: string
    title: string
    subtitle: string
    master: string
}

export type LobbyPost = {
    category?: PostCategory
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
        return (
            (await this.ctx.storage.get<LobbyPost>(`post:${name}`)) ?? null
        )
    }

    async listPosts(category?: PostCategory): Promise<LobbyPost[]> {
        const map = await this.ctx.storage.list<LobbyPost>({
            prefix: 'post:',
        })

        return [...map.values()]
            .filter((post) => {
                const postCategory = post.category ?? 'news'
                return !category || postCategory === category
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
}