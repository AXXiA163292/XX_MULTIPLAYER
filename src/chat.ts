import { DurableObject } from 'cloudflare:workers'
import { randomId } from './crypto.ts'
import type { ChatMessage, Env } from './types.ts'

export type StoredChatMessage = ChatMessage & {
    likes?: string[]
    replyTo?: {
        id: string
        author: string
        handle: string
        text: string
    }
}

type ChatState = {
    messages: StoredChatMessage[]
    pinnedChatId: string | null
}

const MAX_CHAT = 200

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

export class Chat extends DurableObject<Env> {
    private st: ChatState = {
        messages: [],
        pinnedChatId: null,
    }
    private loaded = false

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        void ctx.blockConcurrencyWhile(async () => {
            await this.ensureLoaded()
        })
    }

    private async ensureLoaded(): Promise<void> {
        if (this.loaded) return
        const stored = await this.ctx.storage.get<ChatState>('chat_state')
        if (stored) {
            this.st = {
                messages: Array.isArray(stored.messages)
                    ? stored.messages.slice(-MAX_CHAT).map((m) => normalizeChatMessage(m))
                    : [],
                pinnedChatId: typeof stored.pinnedChatId === 'string'
                    ? stored.pinnedChatId
                    : null,
            }
        }
        this.loaded = true
    }

    private async saveAndBroadcast(): Promise<void> {
        this.st.messages = this.st.messages.slice(-MAX_CHAT)
        if (
            this.st.pinnedChatId &&
            !this.st.messages.some((m) => m.id === this.st.pinnedChatId)
        ) {
            this.st.pinnedChatId = null
        }
        await this.ctx.storage.put('chat_state', this.st)
        this.broadcast({ type: 'chat', messages: this.st.messages, pinnedChatId: this.st.pinnedChatId })
    }

    private broadcast(payload: unknown): void {
        const serialized = JSON.stringify(payload)
        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.send(serialized)
            } catch {
                try {
                    ws.close(1011, 'Send failed')
                } catch {}
            }
        }
    }

    async listMessages(): Promise<StoredChatMessage[]> {
        await this.ensureLoaded()
        return this.st.messages.map((m) => normalizeChatMessage(m))
    }

    async getPinnedId(): Promise<string | null> {
        await this.ensureLoaded()
        return this.st.pinnedChatId
    }

    async addMessage(input: {
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
        const msg = normalizeChatMessage({
            id: randomId(10),
            handle: input.handle,
            author: input.author,
            text: input.text.slice(0, 500),
            time: Date.now(),
            likes: [],
            ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        })
        this.st.messages = [...this.st.messages, msg].slice(-MAX_CHAT)
        await this.saveAndBroadcast()
        return msg
    }

    async deleteMessage(id: string): Promise<boolean> {
        await this.ensureLoaded()
        const before = this.st.messages.length
        this.st.messages = this.st.messages.filter((m) => m.id !== id)
        if (this.st.pinnedChatId === id) {
            this.st.pinnedChatId = null
        }
        if (this.st.messages.length === before) return false
        await this.saveAndBroadcast()
        return true
    }

    async toggleLike(id: string, handle: string): Promise<StoredChatMessage | null> {
        await this.ensureLoaded()
        const idx = this.st.messages.findIndex((m) => m.id === id)
        if (idx === -1) return null

        const current = normalizeChatMessage(this.st.messages[idx])
        const hasLike = (current.likes ?? []).includes(handle)
        current.likes = hasLike
            ? (current.likes ?? []).filter((h) => h !== handle)
            : [...(current.likes ?? []), handle]

        this.st.messages[idx] = current
        await this.saveAndBroadcast()
        return current
    }

    async togglePin(id: string): Promise<string | null> {
        await this.ensureLoaded()
        if (!this.st.messages.some((m) => m.id === id)) return this.st.pinnedChatId
        this.st.pinnedChatId = this.st.pinnedChatId === id ? null : id
        await this.saveAndBroadcast()
        return this.st.pinnedChatId
    }

    async fetch(req: Request): Promise<Response> {
        await this.ensureLoaded()
        const url = new URL(req.url)

        if (req.headers.get('Upgrade') === 'websocket') {
            const pair = new WebSocketPair()
            const [client, server] = Object.values(pair)
            this.ctx.acceptWebSocket(server!)
            server!.send(JSON.stringify({
                type: 'chat',
                messages: this.st.messages,
                pinnedChatId: this.st.pinnedChatId,
            }))
            return new Response(null, { status: 101, webSocket: client })
        }

        if (url.pathname === '/messages' && req.method === 'GET') {
            return Response.json({
                messages: this.st.messages,
                pinnedChatId: this.st.pinnedChatId,
            })
        }

        if (url.pathname === '/add' && req.method === 'POST') {
            const body = await req.json<any>()
            const msg = await this.addMessage(body)
            return Response.json({ ok: true, message: msg, messages: this.st.messages })
        }

        if (url.pathname === '/delete' && req.method === 'POST') {
            const { id } = await req.json<{ id: string }>()
            await this.deleteMessage(id)
            return Response.json({ ok: true, messages: this.st.messages })
        }

        if (url.pathname === '/like' && req.method === 'POST') {
            const { id, handle } = await req.json<{ id: string; handle: string }>()
            await this.toggleLike(id, handle)
            return Response.json({ ok: true, messages: this.st.messages })
        }

        if (url.pathname === '/pin' && req.method === 'POST') {
            const { id } = await req.json<{ id: string }>()
            await this.togglePin(id)
            return Response.json({ ok: true, messages: this.st.messages, pinnedChatId: this.st.pinnedChatId })
        }

        return new Response('Not found', { status: 404 })
    }

    async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
        await this.ensureLoaded()
        ws.send(JSON.stringify({
            type: 'chat',
            messages: this.st.messages,
            pinnedChatId: this.st.pinnedChatId,
        }))
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
        try {
            ws.close(code, reason)
        } catch {}
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        try {
            ws.close(1011, 'WebSocket error')
        } catch {}
    }
}