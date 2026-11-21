
import { SERVER_DESCRIPTION, SERVER_TITLE } from './config.ts'
import { b64encode, randomId, signToken, verifySonolusSignature, verifyToken } from './crypto.ts'
import { parseSettings, roomForms } from './forms.ts'
import type { AuthSession, Env, JoinSession, UserProfile } from './types.ts'

export { Room } from './room.ts'
export { Lobby } from './lobby.ts'

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
const message = (status: number, text: string) => json({ message: text }, status)

const addressOf = (req: Request, env: Env) => (env.PUBLIC_ADDRESS ?? new URL(req.url).origin).replace(/\/+$/, '')

/** Verifies a Sonolus-signed request body (authenticate / join). Returns the parsed body or null. */
async function verifySigned(req: Request, env: Env, raw: Uint8Array, expectType: string) {
    let body: any
    try {
        body = JSON.parse(new TextDecoder().decode(raw))
    } catch {
        return null
    }
    if (body?.type !== expectType) return null
    if (typeof body.address !== 'string' || body.address.replace(/\/+$/, '') !== addressOf(req, env)) return null
    if (typeof body.time !== 'number' || body.time + 60_000 < Date.now()) return null
    const p = body.userProfile
    if (typeof p?.id !== 'string' || typeof p?.handle !== 'string') return null
    if (!env.DEV_SKIP_SIGNATURE) {
        const sig = req.headers.get('Sonolus-Signature')
        if (!sig || !(await verifySonolusSignature(raw, sig))) return null
    }
    return body
}

const profileOf = (p: any): UserProfile => ({ id: String(p.id), handle: String(p.handle), name: String(p.name ?? '') })

async function sessionOf(req: Request, env: Env): Promise<AuthSession | null> {
    const t = req.headers.get('Sonolus-Session')
    return t ? verifyToken<AuthSession>(env.SESSION_SECRET, t) : null
}

const roomStub = (env: Env, name: string) => env.ROOM.get(env.ROOM.idFromName(name))
const lobby = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName('main'))

async function roomItems(env: Env) {
    return (await lobby(env).list()).map((r) => ({ ...r, tags: [] }))
}

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        const url = new URL(req.url)
        const path = url.pathname.replace(/\/+$/, '') || '/'
        if (req.method === 'OPTIONS')
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                },
            })

        // ---------------------------------------------------------------- WebSocket
        const ws = path.match(/^\/ws\/([\w-]+)$/)
        if (ws) {
            const token =
                req.headers.get('Sonolus-Room-Session') ?? (env.DEV_SKIP_SIGNATURE ? url.searchParams.get('session') : null)
            const join = token ? await verifyToken<JoinSession>(env.SESSION_SECRET, token) : null
            if (!join || join.room !== ws[1]) return new Response('Unauthorized', { status: 401 })
            const headers = new Headers(req.headers)
            headers.set('x-join', encodeURIComponent(JSON.stringify(join)))
            return roomStub(env, ws[1]!).fetch(new Request(req, { headers }))
        }

        // ---------------------------------------------------------------- Sonolus server API
        if (path === '/' || path === '/sonolus') return new Response('AXX! Sonolus multiplayer server')

        if (path === '/sonolus/info' && req.method === 'GET')
            return json({
                title: SERVER_TITLE,
                description: SERVER_DESCRIPTION,
                buttons: [{ type: 'authentication' }, { type: 'room' }, { type: 'configuration' }],
                configuration: { options: [] },
            })

        if (path === '/sonolus/authenticate' && req.method === 'POST') {
            const body = await verifySigned(req, env, new Uint8Array(await req.arrayBuffer()), 'authenticateServer')
            if (!body) return new Response(null, { status: 401 })
            const expiration = Date.now() + 30 * 60_000
            const session = await signToken(env.SESSION_SECRET, {
                user: profileOf(body.userProfile),
                exp: expiration,
            } satisfies AuthSession)
            return json({ session, expiration })
        }

        if (path === '/sonolus/rooms/info' && req.method === 'GET') {
            const s = await sessionOf(req, env)
            const isHost = s?.user.handle === env.HOST_HANDLE
            return json({
                // Only the host even sees the "create room" form.
                creates: isHost ? roomForms() : [],
                searches: [],
                sections: [{ title: 'Rooms', itemType: 'room', items: await roomItems(env) }],
            })
        }

        if (path === '/sonolus/rooms/list' && req.method === 'GET')
            return json({ pageCount: 1, items: await roomItems(env), searches: [] })

        if (path === '/sonolus/rooms/create' && req.method === 'POST') {
            const s = await sessionOf(req, env)
            if (!s) return new Response(null, { status: 401 })
            if (s.user.handle !== env.HOST_HANDLE) return message(403, 'Only the host can create rooms.')
            const name = randomId(8)
            const key = randomId(24)
            await roomStub(env, name).reserve(name, {
                key,
                hostId: s.user.id,
                hostName: s.user.name,
                hostHandle: s.user.handle,
            })
            return json({ name, key })
        }

        const roomPath = path.match(/^\/sonolus\/rooms\/([\w-]+)$/)
        if (roomPath && req.method === 'GET') {
            const item = await roomStub(env, roomPath[1]!).summary()
            if (!item) return new Response(null, { status: 404 })
            return json({
                item: { ...item, tags: [] },
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            })
        }

        if (roomPath && req.method === 'POST') {
            const name = roomPath[1]!
            const raw = new Uint8Array(await req.arrayBuffer())
            const body = await verifySigned(req, env, raw, 'authenticateMultiplayer')
            if (!body || body.room !== name) return new Response(null, { status: 400 })
            const user = profileOf(body.userProfile)
            const stub = roomStub(env, name)

            const key = req.headers.get('Sonolus-Room-Key')
            if (key) {
                // Room creator finishing the create form. Re-check the handle, then configure the room.
                const settings = parseSettings(url.searchParams)
                if (!settings) return new Response(null, { status: 400 })
                if (user.handle !== env.HOST_HANDLE || !(await stub.configure(key, settings, user)))
                    return message(403, 'Only the host can create rooms.')
            } else if (!(await stub.isOpen())) {
                return new Response(null, { status: 404 })
            }

            const session = await signToken(env.SESSION_SECRET, {
                room: name,
                user,
                roomUser: { authentication: b64encode(raw), signature: req.headers.get('Sonolus-Signature') ?? '' },
                exp: Date.now() + 2 * 60_000,
            } satisfies JoinSession)
            const wsUrl = addressOf(req, env).replace(/^http/, 'ws') + `/ws/${name}`
            return json({ url: wsUrl, type: 'round', session })
        }

        return new Response('Not found', { status: 404 })
    },
} satisfies ExportedHandler<Env>