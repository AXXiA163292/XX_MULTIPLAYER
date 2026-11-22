import { SERVER_DESCRIPTION, SERVER_TITLE, TOURNAMENT_HOST_HANDLE } from './config.ts'
import { getCustomLevelPage, getCustomLevels, getPlaylists, type SheetChart } from './sheets.ts'
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
            'Cache-Control': 'no-store',
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

    if (typeof body.time !== 'number' || body.time + 60_000 < Date.now()) {
        return null
    }

    const p = body.userProfile

    if (typeof p?.id !== 'string' || typeof p?.handle !== 'string') {
        return null
    }

    if (!env.DEV_SKIP_SIGNATURE) {
        const sig = req.headers.get('Sonolus-Signature')

        if (!sig || !(await verifySonolusSignature(raw, sig))) {
            return null
        }
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
    const token = req.headers.get('Sonolus-Session')
    return token ? verifyToken<AuthSession>(env.SESSION_SECRET, token) : null
}

const roomStub = (env: Env, name: string) =>
    env.ROOM.get(env.ROOM.idFromName(name))

const lobby = (env: Env) =>
    env.LOBBY.get(env.LOBBY.idFromName('main'))

async function roomItems(env: Env, session: AuthSession | null) {
    const rooms = await lobby(env).list()

    const items = await Promise.all(
        rooms.map(async (room) => {
            const current = await roomStub(env, room.name).summary()

            if (!current) {
                // The room no longer exists (expired or closed): clean the stale entry.
                await lobby(env).remove(room.name)
                return null
            }

            // Private rooms are never listed: players join them through the room link only.
            if (current.visibility === 'private') return null

            return {
                name: current.name,
                title: current.title,
                subtitle: current.subtitle,
                master: current.master,
                tags: [],
            }
        }),
    )

    return items.filter((item) => item !== null)
}

const canManagePosts = (session: AuthSession | null) =>
    session?.user.handle === TOURNAMENT_HOST_HANDLE

type PostKind = 'announcements' | 'posts' | 'results'

const POST_LABELS: Record<PostKind, {
    section: string
    create: string
    titlePlaceholder: string
    bodyPlaceholder: string
}> = {
    announcements: {
        section: 'Announcements',
        create: 'Create announcement',
        titlePlaceholder: 'Announcement title',
        bodyPlaceholder: 'Write your announcement...',
    },
    posts: {
        section: 'Posts',
        create: 'Create post',
        titlePlaceholder: 'Post title',
        bodyPlaceholder: 'Write your post...',
    },
    results: {
        section: 'Results',
        create: 'Create result',
        titlePlaceholder: 'Result title',
        bodyPlaceholder: 'Write the results...',
    },
}

function postForm(category: PostKind) {
    const label = POST_LABELS[category]

    return {
        type: 'post',
        title: label.create,
        requireConfirmation: false,
        options: [
            {
                query: 'title',
                name: 'Title',
                required: true,
                type: 'text',
                def: '',
                placeholder: label.titlePlaceholder,
                limit: 100,
                shortcuts: [],
            },
            {
                query: 'description',
                name: 'Content',
                required: true,
                type: 'textArea',
                def: '',
                placeholder: label.bodyPlaceholder,
                limit: 5000,
                shortcuts: [],
            },
            {
                query: 'thumbnail',
                name: 'Thumbnail',
                description: 'Optional image.',
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
}

const deletePostForm = {
    type: 'deletePost',
    title: 'Delete post',
    icon: 'delete',
    requireConfirmation: true,
    options: [],
}

/** `?type=` of the post requests. Old "news" posts and links are treated as "posts". */
function postCategory(url: URL): PostKind {
    const type =
        url.searchParams.get('type') ??
        url.searchParams.get('infoType') ??
        url.searchParams.get('category')

    return type === 'announcements' || type === 'results' ? type : 'posts'
}

/** True when the request names a post category at all (the info request of some clients does not). */
const hasPostCategory = (url: URL) =>
    ['type', 'infoType', 'category'].some((key) => url.searchParams.has(key))

/** Keeps the original case (SUDU-001) so the top-left tag is uppercase. */
function playlistSlug(name: string): string {
    return name
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
}

const samePlaylist = (a: string, b: string) =>
    a.toLowerCase() === b.toLowerCase()

type RemoteLevelItem = Record<string, any>
type RemoteLevelDetails = Record<string, any> & {
    item: RemoteLevelItem
}

async function remoteLevelDetails(
    chart: SheetChart,
): Promise<RemoteLevelDetails | null> {
    const base = chart.address.replace(/\/+$/, '')
    const endpoint = `${base}/sonolus/levels/${encodeURIComponent(chart.name)}`

    try {
        const response = await fetch(endpoint, {
            headers: {
                Accept: 'application/json',
                'Cache-Control': 'no-cache',
            },
            cache: 'no-store',
            signal: AbortSignal.timeout(12000),
        })

        if (!response.ok) {
            console.warn(
                `Level ${chart.id} could not be fetched: HTTP ${response.status}`,
                endpoint,
            )
            return null
        }

        const data: any = await response.json()
        const item = data.item ?? data

        if (
            !item ||
            typeof item.name !== 'string' ||
            typeof item.title === 'undefined' ||
            typeof item.engine === 'undefined' ||
            typeof item.data === 'undefined'
        ) {
            console.warn('Invalid Sonolus LevelItem returned for', chart.id, item)
            return null
        }

        return {
            ...data,
            item: {
                ...item,
                source: chart.address,
            },
        }
    } catch (error) {
        console.error('Could not fetch source level', chart.id, endpoint, error)
        return null
    }
}

async function remoteLevelItem(
    chart: SheetChart,
): Promise<RemoteLevelItem | null> {
    const details = await remoteLevelDetails(chart)
    return details?.item ?? null
}

function descriptionText(value: any): string {
    if (typeof value === 'string') return value.trim()

    if (Array.isArray(value)) {
        return value.map(descriptionText).filter(Boolean).join('\n')
    }

    if (value && typeof value === 'object') {
        if (typeof value.en === 'string') return value.en.trim()

        return Object.values(value)
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter(Boolean)
            .join('\n')
    }

    return ''
}

function localizedTitle(value: any): string {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') {
        if (typeof value.en === 'string') return value.en
        const first = Object.values(value).find((entry) => typeof entry === 'string')
        return typeof first === 'string' ? first : ''
    }
    return ''
}

async function loadLevelItems(charts: SheetChart[]) {
    const loaded: { chart: SheetChart; item: RemoteLevelItem }[] = []

    for (let i = 0; i < charts.length; i += 5) {
        const batch = charts.slice(i, i + 5)

        const results = await Promise.all(
            batch.map(async (chart) => ({
                chart,
                item: await remoteLevelItem(chart),
            })),
        )

        loaded.push(
            ...results.filter(
                (entry): entry is { chart: SheetChart; item: RemoteLevelItem } =>
                    entry.item !== null,
            ),
        )
    }

    return loaded
}

const UNCH_HOST = 'untitledcharts.com'

const isUnch = (chart: SheetChart) => {
    try {
        const host = new URL(chart.address).hostname
        return host === UNCH_HOST || host.endsWith(`.${UNCH_HOST}`)
    } catch {
        return false
    }
}

async function findChart(name: string): Promise<SheetChart | null> {
    const [customCharts, playlists] = await Promise.all([
        getCustomLevels(),
        getPlaylists(),
    ])

    return [
        ...customCharts,
        ...playlists.flatMap((playlist) => playlist.charts),
    ].find((entry) => entry.name === name || entry.id === name) ?? null
}

/** Forwards community / leaderboard requests to the server that owns the level (Untitled Charts only). */
async function proxyToUnch(
    req: Request,
    url: URL,
    chart: SheetChart,
    rest: string,
): Promise<Response> {
    const target = `${chart.address.replace(/\/+$/, '')}/sonolus/levels/${encodeURIComponent(chart.name)}/${rest}${url.search}`

    const headers = new Headers()
    headers.set('Accept', req.headers.get('Accept') ?? 'application/json')

    const contentType = req.headers.get('Content-Type')
    if (contentType) headers.set('Content-Type', contentType)

    const upload = req.headers.get('Sonolus-Upload-Key')
    if (upload) headers.set('Sonolus-Upload-Key', upload)

    try {
        const response = await fetch(target, {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD'
                ? undefined
                : await req.arrayBuffer(),
            signal: AbortSignal.timeout(15000),
        })

        const type = response.headers.get('Content-Type') ?? 'application/json'

        if (type.includes('json')) {
            // Relative repository urls would resolve against this server: make them absolute.
            const text = (await response.text()).replace(
                /"url":"\/(?!\/)/g,
                `"url":"${chart.address.replace(/\/+$/, '')}/`,
            )

            return new Response(text, {
                status: response.status,
                headers: {
                    'Content-Type': type,
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-store',
                },
            })
        }

        return new Response(response.body, {
            status: response.status,
            headers: {
                'Content-Type': type,
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store',
            },
        })
    } catch (error) {
        console.error('Could not proxy community request:', target, error)
        return message(502, 'Could not reach the level server.')
    }
}

// Level search (title, artist, author + rating filter), like Untitled Charts.

const LEVEL_SEARCHES = [
    {
        type: 'quick',
        title: '#QUICK',
        icon: 'search',
        requireConfirmation: false,
        options: [
            {
                query: 'keywords',
                name: '#KEYWORDS',
                required: false,
                type: 'text',
                def: '',
                placeholder: '#KEYWORDS',
                limit: 0,
                shortcuts: [],
            },
        ],
    },
    {
        type: 'advanced',
        title: '#ADVANCED',
        icon: 'advanced',
        requireConfirmation: false,
        options: [
            {
                query: 'keywords',
                name: '#KEYWORDS',
                required: false,
                type: 'text',
                def: '',
                placeholder: '#KEYWORDS',
                limit: 0,
                shortcuts: [],
            },
            {
                query: 'minRating',
                name: 'Min level',
                required: false,
                type: 'slider',
                def: 0,
                min: 0,
                max: 40,
                step: 1,
            },
            {
                query: 'maxRating',
                name: 'Max level',
                required: false,
                type: 'slider',
                def: 40,
                min: 0,
                max: 40,
                step: 1,
            },
            {
                query: 'sort',
                name: 'Sort by',
                required: false,
                type: 'select',
                def: 'newest',
                values: [
                    { name: 'newest', title: 'Newest' },
                    { name: 'ratingDesc', title: 'Level (high to low)' },
                    { name: 'ratingAsc', title: 'Level (low to high)' },
                    { name: 'title', title: 'Title' },
                ],
            },
        ],
    },
]

let levelIndex: { at: number; entries: { chart: SheetChart; item: RemoteLevelItem }[] } | null = null

async function allLevelEntries() {
    if (levelIndex && Date.now() - levelIndex.at < 5 * 60_000) return levelIndex.entries

    const entries = await loadLevelItems(await getCustomLevels())
    levelIndex = { at: Date.now(), entries }

    return entries
}

function hasLevelFilters(url: URL) {
    const keywords = (url.searchParams.get('keywords') ?? '').trim()
    const min = Number(url.searchParams.get('minRating') ?? '0')
    const max = Number(url.searchParams.get('maxRating') ?? '40')
    const sort = url.searchParams.get('sort') ?? 'newest'

    return !!keywords || min > 0 || (Number.isFinite(max) && max < 40) || sort !== 'newest'
}

async function searchLevels(url: URL, page: number) {
    const keywords = (url.searchParams.get('keywords') ?? '').trim().toLowerCase()
    const min = Number(url.searchParams.get('minRating') ?? '0')
    const max = Number(url.searchParams.get('maxRating') ?? '40')
    const sort = url.searchParams.get('sort') ?? 'newest'

    const haystack = (item: RemoteLevelItem) =>
        [
            localizedTitle(item.title),
            localizedTitle(item.artists),
            localizedTitle(item.author),
            String(item.name ?? ''),
        ].join(' ').toLowerCase()

    let entries = (await allLevelEntries()).filter(({ item }) => {
        const rating = Number(item.rating)

        if (Number.isFinite(rating)) {
            if (Number.isFinite(min) && rating < min) return false
            if (Number.isFinite(max) && rating > max) return false
        }

        return keywords
            .split(/\s+/)
            .filter(Boolean)
            .every((word) => haystack(item).includes(word))
    })

    if (sort === 'ratingDesc') entries = [...entries].sort((a, b) => Number(b.item.rating) - Number(a.item.rating))
    else if (sort === 'ratingAsc') entries = [...entries].sort((a, b) => Number(a.item.rating) - Number(b.item.rating))
    else if (sort === 'title') {
        entries = [...entries].sort((a, b) =>
            localizedTitle(a.item.title).localeCompare(localizedTitle(b.item.title)))
    }

    const pageCount = Math.max(1, Math.ceil(entries.length / 10))
    const start = page * 10

    return {
        pageCount,
        items: entries.slice(start, start + 10).map((entry) => entry.item),
    }
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

            if (!join || join.room !== ws[1]) {
                return new Response('Unauthorized', { status: 401 })
            }

            const headers = new Headers(req.headers)
            headers.set('x-join', encodeURIComponent(JSON.stringify(join)))

            return roomStub(env, ws[1]!).fetch(
                new Request(req, { headers }),
            )
        }

        if (path === '/' || path === '/sonolus') {
            return new Response('AXX! Sonolus multiplayer server')
        }

        if (path === '/sonolus/info' && req.method === 'GET') {
            const bannerObject = await env.POSTS_BUCKET.get('server/banner.png')
            let banner: { hash: string; url: string } | undefined

            if (bannerObject) {
                const bytes = await bannerObject.arrayBuffer()
                const digest = await crypto.subtle.digest('SHA-1', bytes)
                const hash = Array.from(
                    new Uint8Array(digest),
                    (byte) => byte.toString(16).padStart(2, '0'),
                ).join('')

                banner = {
                    hash,
                    url: '/sonolus/server/banner',
                }
            }

            return json({
                title: SERVER_TITLE,
                description: SERVER_DESCRIPTION,
                ...(banner ? { banner } : {}),
                buttons: [
                    { type: 'authentication' },
                    { type: 'room' },
                    {
                        type: 'post',
                        title: 'Announcements',
                        icon: 'announcement',
                        infoType: 'announcements',
                    },
                    {
                        type: 'post',
                        title: 'Posts',
                        icon: 'post',
                        infoType: 'posts',
                    },
                    {
                        type: 'post',
                        title: 'Results',
                        icon: 'medal',
                        infoType: 'results',
                    },
                    { type: 'level' },
                    { type: 'playlist' },
                    { type: 'configuration' },
                ],
                configuration: {
                    options: [],
                },
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

        if (path === '/sonolus/server/banner' && req.method === 'GET') {
            const object = await env.POSTS_BUCKET.get('server/banner.png')

            if (!object) return new Response(null, { status: 404 })

            return new Response(object.body, {
                headers: {
                    'Content-Type': object.httpMetadata?.contentType ?? 'image/png',
                    'Cache-Control': 'public, max-age=3600',
                },
            })
        }

        // Posts: Announcements, Posts and Results (only the tournament host can create / delete)

        if (path === '/sonolus/posts/info' && req.method === 'GET') {
            console.log('[Posts] info request query:', url.search)

            const session = await sessionOf(req, env)
            const kinds: PostKind[] = hasPostCategory(url)
                ? [postCategory(url)]
                : ['announcements', 'posts', 'results']

            const sections = await Promise.all(
                kinds.map(async (kind) => ({
                    title: POST_LABELS[kind].section,
                    itemType: 'post',
                    items: (await lobby(env).listPosts(kind)).map((post) => post.item),
                })),
            )

            return json({
                creates: canManagePosts(session)
                    ? [postForm(kinds.length === 1 ? kinds[0]! : 'posts')]
                    : [],
                searches: [],
                sections,
            })
        }

        if (path === '/sonolus/posts/list' && req.method === 'GET') {
            const posts = await lobby(env).listPosts(postCategory(url))

            return json({
                pageCount: 1,
                items: posts.map((post) => post.item),
                searches: [],
            })
        }

        if (path === '/sonolus/posts/create' && req.method === 'POST') {
            const session = await sessionOf(req, env)
            if (!session) return new Response(null, { status: 401 })

            if (!canManagePosts(session)) {
                return message(403, 'Only handle 163292 can publish posts.')
            }

            let body: any

            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid post data.')
            }

            const values = new URLSearchParams(String(body.values ?? ''))
            const category = postCategory(url)
            const title = (values.get('title') ?? '').trim()
            const description = (values.get('description') ?? '').trim()
            const thumbnailHash = (values.get('thumbnail') ?? '').trim()

            if (!title || !description) {
                return message(400, 'A title and content are required.')
            }

            if (title.length > 100 || description.length > 5000) {
                return message(400, 'Post is too long.')
            }

            const name = randomId(12)
            const key = randomId(24)

            await lobby(env).createPost({
                category,
                item: {
                    name,
                    version: 1,
                    title,
                    time: Date.now(),
                    author: session.user.name || session.user.handle,
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

        const postSubmitPath = path.match(
            /^\/sonolus\/posts\/([\w-]+)\/submit$/,
        )

        if (postSubmitPath && req.method === 'POST') {
            const session = await sessionOf(req, env)

            if (!session) return new Response(null, { status: 401 })

            if (!canManagePosts(session)) {
                return message(403, 'Only handle 163292 can delete posts.')
            }

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

            if (values.get('type') !== 'deletePost') {
                return message(400, 'Unknown post action.')
            }

            await env.POSTS_BUCKET.delete(`posts/${postName}/thumbnail`)
            await lobby(env).removePost(postName)

            return json({ shouldRemoveItem: true })
        }

        if (path === '/sonolus/posts/upload' && req.method === 'POST') {
            const session = await sessionOf(req, env)

            if (!session) return new Response(null, { status: 401 })

            if (!canManagePosts(session)) {
                return message(403, 'Only handle 163292 can upload post images.')
            }

            const key = req.headers.get('Sonolus-Upload-Key')

            if (!key) return message(400, 'Missing upload key.')

            const post = await lobby(env).findPostByUploadKey(key)

            if (!post || !post.thumbnailHash) {
                return message(403, 'Invalid upload key.')
            }

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

            if (file.size > 5 * 1024 * 1024) {
                return message(400, 'Image is too large.')
            }

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

            if (!contentType) {
                return message(
                    400,
                    'Unsupported image format. Use PNG, JPEG, or WebP.',
                )
            }

            const digest = await crypto.subtle.digest('SHA-1', bytes)

            const hash = Array.from(
                new Uint8Array(digest),
                (byte) => byte.toString(16).padStart(2, '0'),
            ).join('')

            if (hash.toLowerCase() !== post.thumbnailHash.toLowerCase()) {
                return message(400, 'Image hash does not match.')
            }

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
                actions: canManagePosts(await sessionOf(req, env))
                    ? [deletePostForm]
                    : [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            })
        }

        // Levels

        if (path === '/sonolus/levels/info' && req.method === 'GET') {
            try {
                const { charts, pageCount } = await getCustomLevelPage(0)
                const loaded = await loadLevelItems(charts)

                console.log(
                    `[Levels] Info page 0: ${loaded.length}/${charts.length} levels loaded. ${pageCount} pages total.`,
                )

                return json({
                    creates: [],
                    searches: LEVEL_SEARCHES,
                    sections: [
                        {
                            title: 'Custom Levels',
                            itemType: 'level',
                            items: loaded.map((entry) => entry.item),
                        },
                    ],
                })
            } catch (error) {
                console.error('Could not read custom levels sheet:', error)
                return message(502, 'Could not read the custom levels sheet.')
            }
        }

        if (path === '/sonolus/levels/list' && req.method === 'GET') {
            try {
                const requestedPage = Number(url.searchParams.get('page') ?? '0')
                const page = Number.isInteger(requestedPage) && requestedPage >= 0
                    ? requestedPage
                    : 0

                if (hasLevelFilters(url)) {
                    const found = await searchLevels(url, page)

                    return json({
                        pageCount: found.pageCount,
                        items: page >= found.pageCount ? [] : found.items,
                        searches: LEVEL_SEARCHES,
                    })
                }

                const { charts, pageCount } = await getCustomLevelPage(page)

                if (page >= pageCount) {
                    return json({
                        pageCount,
                        items: [],
                        searches: LEVEL_SEARCHES,
                    })
                }

                const loaded = await loadLevelItems(charts)

                console.log(
                    `[Levels] List page ${page}: ${loaded.length}/${charts.length} levels loaded. ${pageCount} pages total.`,
                )

                return json({
                    pageCount,
                    items: loaded.map((entry) => entry.item),
                    searches: LEVEL_SEARCHES,
                })
            } catch (error) {
                console.error('Could not read custom levels sheet:', error)
                return message(502, 'Could not read custom levels sheet.')
            }
        }

        const levelSub = path.match(
            /^\/sonolus\/levels\/([^/]+)\/((?:community|leaderboards|submit|upload)(?:\/.*)?)$/,
        )

        if (levelSub) {
            const chart = await findChart(decodeURIComponent(levelSub[1]!)).catch(() => null)

            // Only Untitled Charts levels have a community / leaderboards.
            if (!chart || !isUnch(chart)) return new Response(null, { status: 404 })

            return proxyToUnch(req, url, chart, levelSub[2]!)
        }

        const levelPath = path.match(/^\/sonolus\/levels\/([^/]+)$/)

        if (levelPath && req.method === 'GET') {
            const requestedName = decodeURIComponent(levelPath[1]!)

            try {
                const [customCharts, playlists] = await Promise.all([
                    getCustomLevels(),
                    getPlaylists(),
                ])

                const allCharts = [
                    ...customCharts,
                    ...playlists.flatMap((playlist) => playlist.charts),
                ]

                const chart = allCharts.find(
                    (entry) =>
                        entry.name === requestedName ||
                        entry.id === requestedName,
                )

                if (!chart) return new Response(null, { status: 404 })

                const details = await remoteLevelDetails(chart)

                if (!details) return new Response(null, { status: 502 })

                return json({
                    ...details,
                    item: details.item,
                    description: details.description ?? details.item.description ?? '',
                    actions: isUnch(chart) && Array.isArray(details.actions) ? details.actions : [],
                    // Community / leaderboard only exist on Untitled Charts levels. They are proxied below.
                    hasCommunity: isUnch(chart) ? details.hasCommunity ?? false : false,
                    leaderboards: isUnch(chart) && Array.isArray(details.leaderboards)
                        ? details.leaderboards
                        : [],
                    sections: Array.isArray(details.sections) ? details.sections : [],
                })
            } catch (error) {
                console.error('Could not load level details:', error)
                return message(502, 'Could not load level details.')
            }
        }

        // Playlists

        const makePlaylistItems = async () => {
            const playlists = await getPlaylists()

            return Promise.all(
                playlists.map(async (playlist) => {
                    const loaded = await loadLevelItems(playlist.charts)

                    return {
                        name: playlistSlug(playlist.name),
                        version: 1 as const,
                        title: playlist.name,
                        subtitle: `${loaded.length} levels`,
                        author: 'XX!',
                        tags: [],
                        levels: loaded.map((entry) => entry.item),
                    }
                }),
            )
        }

        if (path === '/sonolus/playlists/info' && req.method === 'GET') {
            try {
                const items = await makePlaylistItems()

                return json({
                    creates: [],
                    searches: [],
                    sections: [
                        {
                            title: 'Playlists',
                            itemType: 'playlist',
                            items,
                        },
                    ],
                })
            } catch (error) {
                console.error('Could not read playlists sheet:', error)
                return message(502, 'Could not read the playlists sheet.')
            }
        }
        if (path === '/sonolus/playlists/list' && req.method === 'GET') {
            try {
                const items = await makePlaylistItems()

                return json({
                    pageCount: 1,
                    items,
                    searches: [],
                })
            } catch (error) {
                console.error('Could not read playlists sheet:', error)
                return message(502, 'Could not read playlists sheet.')
            }
        }

        const playlistPath = path.match(
            /^\/sonolus\/playlists\/([^/]+)$/,
        )

        if (playlistPath && req.method === 'GET') {
            const requestedName = decodeURIComponent(playlistPath[1]!)

            try {
                const playlists = await getPlaylists()
                const playlist = playlists.find(
                    (entry) => samePlaylist(playlistSlug(entry.name), requestedName),
                )

                if (!playlist) return new Response(null, { status: 404 })

                const loaded = await loadLevelItems(playlist.charts)

                const item = {
                    name: playlistSlug(playlist.name),
                    version: 1 as const,
                    title: playlist.name,
                    subtitle: `${loaded.length} levels`,
                    author: 'XX!',
                    tags: [],
                    levels: loaded.map((entry) => entry.item),
                }

                return json({
                    item,
                    description: '',
                    actions: [],
                    hasCommunity: false,
                    leaderboards: [],
                    sections: [],
                })
            } catch (error) {
                console.error('Could not load playlist details:', error)
                return message(502, 'Could not load playlist details.')
            }
        }

        // Rooms

        if (path === '/sonolus/rooms/info' && req.method === 'GET') {
            const session = await sessionOf(req, env)
            const isHost = session?.user.handle === TOURNAMENT_HOST_HANDLE

            return json({
                creates: session ? roomForms(isHost) : [],
                searches: [],
                sections: [
                    {
                        title: 'Rooms',
                        itemType: 'room',
                        items: await roomItems(env, session),
                    },
                ],
            })
        }

        if (path === '/sonolus/rooms/list' && req.method === 'GET') {
            const session = await sessionOf(req, env)

            return json({
                pageCount: 1,
                items: await roomItems(env, session),
                searches: [],
            })
        }

        if (path === '/sonolus/rooms/create' && req.method === 'POST') {
            const session = await sessionOf(req, env)

            if (!session) return new Response(null, { status: 401 })

            const name = randomId(8)
            const key = randomId(24)

            await roomStub(env, name).reserve(name, {
                key,
                hostId: session.user.id,
                hostName: session.user.name,
                hostHandle: session.user.handle,
            })

            return json({ name, key })
        }

        const roomPath = path.match(/^\/sonolus\/rooms\/([\w-]+)$/)

        if (roomPath && req.method === 'GET') {
            const item = await roomStub(env, roomPath[1]!).summary()

            if (!item) return new Response(null, { status: 404 })

            return json({
                item: {
                    name: item.name,
                    title: item.title,
                    subtitle: item.subtitle,
                    master: item.master,
                    tags: [],
                },
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

            if (!body || body.room !== name) {
                return new Response(null, { status: 400 })
            }

            const user = profileOf(body.userProfile)
            const stub = roomStub(env, name)
            const key = req.headers.get('Sonolus-Room-Key')

            if (key) {
                const settings = parseSettings(url.searchParams)

                if (!settings) {
                    return new Response(null, { status: 400 })
                }

                if (
                    (
                        user.handle !== TOURNAMENT_HOST_HANDLE &&
                        settings.type !== 'casualRoom' &&
                        settings.type !== 'rankedRoom'
                    ) ||
                    !(await stub.configure(key, settings, user))
                ) {
                    return message(403, 'You can only create Custom or Ranked Match rooms.')
                }
            } else {
                if (!(await stub.isOpen())) {
                    return new Response(null, { status: 404 })
                }

                // Locked rooms only accept registered players of that stage.
                const denied = await stub.canJoin(user)

                if (denied) return message(403, denied)
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