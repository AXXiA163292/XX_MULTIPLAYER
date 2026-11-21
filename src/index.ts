import { SERVER_DESCRIPTION, SERVER_TITLE } from './config.ts'
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
    return (await lobby(env).list()).map((r) => ({
        ...r,
        tags: [],
    }))
}

const postForm = {
    type: 'post',
    title: 'Create post',
    requireConfirmation: false,
    options: [
        {
            query: 'title',
            name: 'Title',
            required: true,
            type: 'text',
            def: '',
            placeholder: 'Post title',
            limit: 100,
            shortcuts: [],
        },
        {
            query: 'description',
            name: 'Content',
            required: true,
            type: 'textArea',
            def: '',
            placeholder: 'Write your post...',
            limit: 5000,
            shortcuts: [],
        },
        {
            query: 'tags',
            name: 'Tags',
            required: false,
            type: 'text',
            def: '',
            placeholder: 'News, Announcement',
            limit: 100,
            shortcuts: [],
        },
        {
            query: 'thumbnail',
            name: 'Image thumbnail',
            description: 'Optional post image.',
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

const canManagePosts = (session: AuthSession | null, env: Env) =>
    session?.user.handle === env.HOST_HANDLE

const deletePostForm = {
    type: 'deletePost',
    title: 'Delete post',
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
                    { type: 'post' },
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

        // Posts

        if (path === '/sonolus/posts/info' && req.method === 'GET') {
            const s = await sessionOf(req, env)
            const posts = await lobby(env).listPosts()

            return json({
                creates: canManagePosts(s, env) ? [postForm] : [],
                searches: [],
                sections: [
                    {
                        title: 'Posts',
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

            if (!canManagePosts(s, env))
                return message(403, 'Only the designated publisher can create posts.')

            let body: any

            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid post data.')
            }

            const values = new URLSearchParams(String(body.values ?? ''))
            const title = (values.get('title') ?? '').trim()
            const description = (values.get('description') ?? '').trim()
            const thumbnailHash = (values.get('thumbnail') ?? '').trim()

            if (!title || !description)
                return message(400, 'A title and content are required.')

            if (title.length > 100 || description.length > 5000)
                return message(400, 'Post is too long.')

            const tags = (values.get('tags') ?? '')
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean)
                .slice(0, 8)
                .map((title) => ({ title }))

            const name = randomId(12)
            const key = randomId(24)

            await lobby(env).createPost({
                item: {
                    name,
                    version: 1,
                    title,
                    time: Date.now(),
                    author: s.user.name || s.user.handle,
                    tags,
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

            if (!canManagePosts(s, env))
                return message(403, 'Only the designated publisher can delete posts.')

            const postName = postSubmitPath[1]!
            const post = await lobby(env).getPost(postName)

            if (!post) return new Response(null, { status: 404 })

            let body: any

            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid post action.')
            }

            const values = new URLSearchParams(String(body.values ?? ''))

            if (values.get('type') !== 'deletePost')
                return message(400, 'Unknown post action.')

            await env.POSTS_BUCKET.delete(`posts/${postName}/thumbnail`)
            await lobby(env).removePost(postName)

            return json({
                shouldRemoveItem: true,
                shouldUpdateItem: true,
            })
        }

        if (path === '/sonolus/posts/upload' && req.method === 'POST') {
            const s = await sessionOf(req, env)

            if (!s) return new Response(null, { status: 401 })

            if (!canManagePosts(s, env))
                return message(403, 'Only the designated publisher can upload images.')

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
                    httpMetadata: {
                        contentType,
                    },
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
                actions: canManagePosts(await sessionOf(req, env), env) ? [deletePostForm] : [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            })
        }

        // Rooms

        if (path === '/sonolus/rooms/info' && req.method === 'GET') {
            const s = await sessionOf(req, env)
            const isHost = s?.user.handle === env.HOST_HANDLE

            return json({
                creates: isHost ? roomForms() : [],
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

            if (s.user.handle !== env.HOST_HANDLE)
                return message(403, 'Only the host can create rooms.')

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
                    user.handle !== env.HOST_HANDLE ||
                    !(await stub.configure(key, settings, user))
                ) {
                    return message(403, 'Only the host can create rooms.')
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