
import { SERVER_DESCRIPTION, SERVER_TITLE, TOURNAMENT_HOST_HANDLE } from './config.ts'
import { getCustomLevels, getPlaylists, type SheetChart } from './sheets.ts'
import { b64encode, randomId, signToken, verifySonolusSignature, verifyToken } from './crypto.ts'
import { parseSettings, roomForms } from './forms.ts'
import type { AuthSession, Env, JoinSession, UserProfile } from './types.ts'

export { Room } from './room.ts'
export { Lobby } from './lobby.ts'

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    })

const message = (status: number, text: string) =>
    json({ message: text }, status)

const addressOf = (req: Request, env: Env) =>
    (env.PUBLIC_ADDRESS ?? new URL(req.url).origin).replace(/\/+$/, '')

async function verifySigned(
    req: Request,
    env: Env,
    raw: Uint8Array,
    expectType: string,
) {
    let body: any

    try {
        body = JSON.parse(new TextDecoder().decode(raw))
    } catch {
        return null
    }

    if (body?.type !== expectType) return null

    if (
        typeof body.address !== 'string' ||
        body.address.replace(/\/+$/, '') !== addressOf(req, env)
    ) return null

    if (typeof body.time !== 'number' || body.time + 60_000 < Date.now())
        return null

    const p = body.userProfile
    if (typeof p?.id !== 'string' || typeof p?.handle !== 'string')
        return null

    if (!env.DEV_SKIP_SIGNATURE) {
        const sig = req.headers.get('Sonolus-Signature')
        if (!sig || !(await verifySonolusSignature(raw, sig))) return null
    }

    return body
}

const profileOf = (p: any): UserProfile => ({
    id: String(p.id),
    handle: String(p.handle),
    name: String(p.name ?? ''),
})

async function sessionOf(
    req: Request,
    env: Env,
): Promise<AuthSession | null> {
    const t = req.headers.get('Sonolus-Session')
    return t ? verifyToken<AuthSession>(env.SESSION_SECRET, t) : null
}

const roomStub = (env: Env, name: string) =>
    env.ROOM.get(env.ROOM.idFromName(name))

const lobby = (env: Env) =>
    env.LOBBY.get(env.LOBBY.idFromName('main'))

async function roomItems(env: Env) {
    const rooms = await lobby(env).list()

    return Promise.all(
        rooms.map(async (room) => {
            const current = await roomStub(env, room.name).summary()
            return { ...(current ?? room), tags: [] }
        }),
    )
}

const postForm = {
    type: 'post',
    title: 'Create announcement',
    requireConfirmation: false,
    options: [
        {
            query: 'title',
            name: 'Title',
            required: true,
            type: 'text',
            def: '',
            placeholder: 'Announcement title',
            limit: 100,
            shortcuts: [],
        },
        {
            query: 'description',
            name: 'Announcement',
            required: true,
            type: 'textArea',
            def: '',
            placeholder: 'Write your announcement...',
            limit: 5000,
            shortcuts: [],
        },
        {
            query: 'thumbnail',
            name: 'Thumbnail',
            description: 'Optional announcement image.',
            required: false,
            type: 'file',
            def: '',
            validation: {
                type: 'postThumbnail',
                maxSize: 5242880,
                maxWidth: 2048,
                maxHeight: 2048,
            },
        },
    ],
}

const canManagePosts = (session: AuthSession | null) =>
    session?.user.handle === TOURNAMENT_HOST_HANDLE

const deletePostForm = {
    type: 'deletePost',
    title: 'Delete announcement',
    icon: 'delete',
    requireConfirmation: true,
    options: [],
}

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        const url = new URL(req.url)
        const path = url.pathname.replace(/\/+$/, '') || '/'

        if (req.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                },
            })
        }

        const ws = path.match(/^\/ws\/([\w-]+)$/)

        if (ws) {
            const token =
                req.headers.get('Sonolus-Room-Session') ??
                (env.DEV_SKIP_SIGNATURE
                    ? url.searchParams.get('session')
                    : null)

            const join = token
                ? await verifyToken<JoinSession>(env.SESSION_SECRET, token)
                : null

            if (!join || join.room !== ws[1])
                return new Response('Unauthorized', { status: 401 })

            const headers = new Headers(req.headers)
            headers.set('x-join', encodeURIComponent(JSON.stringify(join)))

            return roomStub(env, ws[1]!).fetch(
                new Request(req, { headers }),
            )
        }

        if (path === '/' || path === '/sonolus')
            return new Response('AXX! Sonolus multiplayer server')

        if (path === '/sonolus/info' && req.method === 'GET') {
            return json({
                title: SERVER_TITLE,
                description: SERVER_DESCRIPTION,
                buttons: [
                    { type: 'authentication' },
                    { type: 'room' },
                    { type: 'post', title: 'Announcements' },
                    { type: 'level' },
                    { type: 'playlist' },
                    { type: 'configuration' },
                ],
                configuration: { options: [] },
            })
        }

        if (path === '/sonolus/authenticate' && req.method === 'POST') {
            const body = await verifySigned(
                req,
                env,
                new Uint8Array(await req.arrayBuffer()),
                'authenticateServer',
            )

            if (!body) return new Response(null, { status: 401 })

            const expiration = Date.now() + 30 * 60_000

            const session = await signToken(env.SESSION_SECRET, {
                user: profileOf(body.userProfile),
                exp: expiration,
            } satisfies AuthSession)

            return json({ session, expiration })
        }

        // Announcements

        if (path === '/sonolus/posts/info' && req.method === 'GET') {
            const s = await sessionOf(req, env)
            const posts = await lobby(env).listPosts()

            return json({
                creates: canManagePosts(s) ? [postForm] : [],
                searches: [],
                sections: [
                    {
                        title: 'Announcements',
                        itemType: 'post',
                        items: posts.map((p) => p.item),
                    },
                ],
            })
        }

        if (path === '/sonolus/posts/list' && req.method === 'GET') {
            const posts = await lobby(env).listPosts()

            return json({
                pageCount: 1,
                items: posts.map((p) => p.item),
                searches: [],
            })
        }

        if (path === '/sonolus/posts/create' && req.method === 'POST') {
            const s = await sessionOf(req, env)

            if (!s) return new Response(null, { status: 401 })

            if (!canManagePosts(s))
                return message(403, 'Only handle 163292 can publish announcements.')

            let body: any

            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid announcement data.')
            }

            const values = new URLSearchParams(String(body.values ?? ''))
            const title = (values.get('title') ?? '').trim()
            const description = (values.get('description') ?? '').trim()
            const thumbnailHash = (values.get('thumbnail') ?? '').trim()

            if (!title || !description)
                return message(400, 'A title and content are required.')

            if (title.length > 100 || description.length > 5000)
                return message(400, 'Announcement is too long.')

            const name = randomId(12)
            const key = randomId(24)

            await lobby(env).createPost({
                item: {
                    name,
                    version: 1,
                    title,
                    time: Date.now(),
                    author: s.user.name || s.user.handle,
                    tags: [],
                },
                description,
                uploadKey: key,
                thumbnailHash,
            })

            return json({
                key,
                hashes: thumbnailHash ? [thumbnailHash] : [],
                shouldUpdateInfo: true,
                shouldNavigateToItem: name,
            })
        }

        const postSubmitPath = path.match(/^\/sonolus\/posts\/([\w-]+)\/submit$/)

        if (postSubmitPath && req.method === 'POST') {
            const s = await sessionOf(req, env)

            if (!s) return new Response(null, { status: 401 })

            if (!canManagePosts(s))
                return message(403, 'Only handle 163292 can delete announcements.')

            const postName = postSubmitPath[1]!
            const post = await lobby(env).getPost(postName)

            if (!post) return new Response(null, { status: 404 })

            let body: any

            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid announcement action.')
            }

            const values = new URLSearchParams(String(body.values ?? ''))

            if (values.get('type') !== 'deletePost')
                return message(400, 'Unknown announcement action.')

            await env.POSTS_BUCKET.delete(`posts/${postName}/thumbnail`)
            await lobby(env).removePost(postName)

            return json({ shouldRemoveItem: true })
        }

        if (path === '/sonolus/posts/upload' && req.method === 'POST') {
            const s = await sessionOf(req, env)

            if (!s) return new Response(null, { status: 401 })

            if (!canManagePosts(s))
                return message(403, 'Only handle 163292 can upload announcement images.')

            const key = req.headers.get('Sonolus-Upload-Key')
            if (!key) return message(400, 'Missing upload key.')

            const post = await lobby(env).findPostByUploadKey(key)

            if (!post || !post.thumbnailHash)
                return message(403, 'Invalid upload key.')

            let form: FormData

            try {
                form = await req.formData()
            } catch {
                return message(400, 'Invalid image upload.')
            }

            const file = form
                .getAll('files')
                .find((value): value is File => value instanceof File)

            if (!file) return message(400, 'No image was uploaded.')

            if (file.size > 5 * 1024 * 1024)
                return message(400, 'Image is too large.')

            const bytes = await file.arrayBuffer()
            const image = new Uint8Array(bytes)

            const isPng =
                image.length >= 8 &&
                image[0] === 0x89 &&
                image[1] === 0x50 &&
                image[2] === 0x4e &&
                image[3] === 0x47 &&
                image[4] === 0x0d &&
                image[5] === 0x0a &&
                image[6] === 0x1a &&
                image[7] === 0x0a

            const isJpeg =
                image.length >= 3 &&
                image[0] === 0xff &&
                image[1] === 0xd8 &&
                image[2] === 0xff

            const isWebp =
                image.length >= 12 &&
                String.fromCharCode(...image.slice(0, 4)) === 'RIFF' &&
                String.fromCharCode(...image.slice(8, 12)) === 'WEBP'

            const contentType = isPng
                ? 'image/png'
                : isJpeg
                    ? 'image/jpeg'
                    : isWebp
                        ? 'image/webp'
                        : null

            if (!contentType)
                return message(400, 'Unsupported image format. Use PNG, JPEG, or WebP.')

            const digest = await crypto.subtle.digest('SHA-1', bytes)

            const hash = Array.from(
                new Uint8Array(digest),
                (b) => b.toString(16).padStart(2, '0'),
            ).join('')

            if (hash.toLowerCase() !== post.thumbnailHash.toLowerCase())
                return message(400, 'Image hash does not match.')

            await env.POSTS_BUCKET.put(
                `posts/${post.item.name}/thumbnail`,
                bytes,
                {
                    httpMetadata: { contentType },
                },
            )

            await lobby(env).setPostThumbnail(
                post.item.name,
                hash,
                `/sonolus/posts/${post.item.name}/thumbnail`,
            )

            return json({})
        }

        const thumbnailPath = path.match(
            /^\/sonolus\/posts\/([\w-]+)\/thumbnail$/,
        )

        if (thumbnailPath && req.method === 'GET') {
            const object = await env.POSTS_BUCKET.get(
                `posts/${thumbnailPath[1]}/thumbnail`,
            )

            if (!object) return new Response(null, { status: 404 })

            return new Response(object.body, {
                headers: {
                    'Content-Type': object.httpMetadata?.contentType ?? 'image/png',
                    'Cache-Control': 'public, max-age=31536000, immutable',
                },
            })
        }

        const postPath = path.match(/^\/sonolus\/posts\/([\w-]+)$/)

        if (postPath && req.method === 'GET') {
            const post = await lobby(env).getPost(postPath[1]!)

            if (!post) return new Response(null, { status: 404 })

            return json({
                item: post.item,
                description: post.description,
                actions: canManagePosts(await sessionOf(req, env)) ? [deletePostForm] : [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            })
        }

        // Dynamic levels and playlists

        const remoteLevelItem = async (chart: SheetChart) => {
            const endpoint = `${chart.address.replace(/\/+$/, '')}/sonolus/levels/${encodeURIComponent(chart.name)}`

            try {
                const response = await fetch(endpoint, {
                    signal: AbortSignal.timeout(8000),
                })
                if (!response.ok) return null

                const data: any = await response.json()
                const item = data.item ?? data

                if (!item || typeof item.name !== 'string') return null
                return item
            } catch (error) {
                console.error('Could not fetch level item', chart.name, error)
                return null
            }
        }

        if (path === '/sonolus/levels/info' && req.method === 'GET') {
            const charts = await getCustomLevels().catch((error) => {
                console.error('Custom levels sheet failed', error)
                return []
            })

            const items = (await Promise.all(charts.map(remoteLevelItem)))
                .filter((item): item is Record<string, any> => item !== null)

            return json({
                creates: [],
                searches: [],
                sections: [{ title: 'Custom Levels', itemType: 'level', items }],
            })
        }

        if (path === '/sonolus/levels/list' && req.method === 'GET') {
            const charts = await getCustomLevels().catch(() => [])
            const items = (await Promise.all(charts.map(remoteLevelItem)))
                .filter((item): item is Record<string, any> => item !== null)

            return json({ pageCount: 1, items, searches: [] })
        }

        const levelPath = path.match(/^\/sonolus\/levels\/([\w-]+)$/)
        if (levelPath && req.method === 'GET') {
            const charts = await getCustomLevels().catch(() => [])
            const chart = charts.find((entry) => entry.name === levelPath[1])
            if (!chart) return new Response(null, { status: 404 })

            const item = await remoteLevelItem(chart)
            if (!item) return new Response(null, { status: 502 })

            return json({
                item,
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            })
        }

        const makePlaylistItems = async () => {
            const playlists = await getPlaylists()

            return playlists.map((playlist, index) => ({
                name: `xx-playlist-${index + 1}`,
                version: 1,
                title: playlist.name,
                subtitle: `${playlist.charts.length} levels`,
                author: "AXX!A's server",
                tags: [],
                levels: playlist.charts.map((chart) => ({
                    address: chart.address,
                    name: chart.name,
                })),
            }))
        }

        if (path === '/sonolus/playlists/info' && req.method === 'GET') {
            const items = await makePlaylistItems().catch((error) => {
                console.error('Custom playlists sheet failed', error)
                return []
            })

            return json({
                creates: [],
                searches: [],
                sections: [{ title: 'Playlists', itemType: 'playlist', items }],
            })
        }

        if (path === '/sonolus/playlists/list' && req.method === 'GET') {
            const items = await makePlaylistItems().catch(() => [])
            return json({ pageCount: 1, items, searches: [] })
        }

        const playlistPath = path.match(/^\/sonolus\/playlists\/([\w-]+)$/)
        if (playlistPath && req.method === 'GET') {
            const items = await makePlaylistItems().catch(() => [])
            const index = Number(playlistPath[1].replace('xx-playlist-', '')) - 1
            const item = items[index]
            if (!item) return new Response(null, { status: 404 })

            return json({
                item,
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            })
        }

        // Rooms

        if (path === '/sonolus/rooms/info' && req.method === 'GET') {
            const s = await sessionOf(req, env)
            const isHost = s?.user.handle === TOURNAMENT_HOST_HANDLE

            return json({
                creates: s ? roomForms(isHost) : [],
                searches: [],
                sections: [
                    {
                        title: 'Rooms',
                        itemType: 'room',
                        items: await roomItems(env),
                    },
                ],
            })
        }

        if (path === '/sonolus/rooms/list' && req.method === 'GET') {
            return json({
                pageCount: 1,
                items: await roomItems(env),
                searches: [],
            })
        }

        if (path === '/sonolus/rooms/create' && req.method === 'POST') {
            const s = await sessionOf(req, env)

            if (!s) return new Response(null, { status: 401 })

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

            const body = await verifySigned(
                req,
                env,
                raw,
                'authenticateMultiplayer',
            )

            if (!body || body.room !== name)
                return new Response(null, { status: 400 })

            const user = profileOf(body.userProfile)
            const stub = roomStub(env, name)
            const key = req.headers.get('Sonolus-Room-Key')

            if (key) {
                const settings = parseSettings(url.searchParams)

                if (!settings)
                    return new Response(null, { status: 400 })

                if (
                    (user.handle !== TOURNAMENT_HOST_HANDLE && settings.type !== 'casualRoom') ||
                    !(await stub.configure(key, settings, user))
                ) {
                    return message(403, 'You can only create Custom Rooms.')
                }
            } else if (!(await stub.isOpen())) {
                return new Response(null, { status: 404 })
            }

            const session = await signToken(env.SESSION_SECRET, {
                room: name,
                user,
                roomUser: {
                    authentication: b64encode(raw),
                    signature: req.headers.get('Sonolus-Signature') ?? '',
                },
                exp: Date.now() + 2 * 60_000,
            } satisfies JoinSession)

            const wsUrl =
                addressOf(req, env).replace(/^http/, 'ws') + `/ws/${name}`

            return json({
                url: wsUrl,
                type: 'round',
                session,
            })
        }

        return new Response('Not found', { status: 404 })
    },
} satisfies ExportedHandler<Env>