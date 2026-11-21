import { DurableObject } from 'cloudflare:workers'
import type { Env } from './types.ts'

export type LobbyRoom = { name: string; title: string; subtitle: string; master: string }

/** Single instance that remembers which rooms exist, for the room list. */
export class Lobby extends DurableObject<Env> {
    async upsert(room: LobbyRoom): Promise<void> {
        await this.ctx.storage.put(`room:${room.name}`, room)
    }
    async remove(name: string): Promise<void> {
        await this.ctx.storage.delete(`room:${name}`)
    }
    async list(): Promise<LobbyRoom[]> {
        const map = await this.ctx.storage.list<LobbyRoom>({ prefix: 'room:' })
        return [...map.values()]
    }
}
