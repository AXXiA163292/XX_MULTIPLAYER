import {
    SERVER_DESCRIPTION,
    SERVER_TITLE,
    STAFF_CHAT_HANDLES,
    TOURNAMENT_HOST_HANDLE,
} from './config.ts'
import {
    getCustomLevelPage,
    getCustomLevels,
    getPlaylists,
    refreshDailyAssets,
    getAvailableEditions,
    getCurrentEdition,
    type SheetChart,
} from './sheets.ts'
import { b64encode, randomId, signToken, verifySonolusSignature, verifyToken } from './crypto.ts'
import { parseSettings, roomForms } from './forms.ts'
import type { AuthSession, ChatMessage, Env, JoinSession, RoomCover, UserProfile } from './types.ts'
import type { PostCategory, PostComment, StoredPost } from './lobby.ts'

export { Room } from './room.ts'
export { Lobby } from './lobby.ts'
export { Chat } from './chat.ts'

const CHAT_PFP_HANDLES = ['163292', '283420', '3227470'] as const
const CHAT_PFP_HANDLE_SET = new Set<string>(CHAT_PFP_HANDLES)
const CHAT_HANDLE_COOKIE = 'xx_chat_handle'
const PROTECTED_CHAT_HANDLE = '163292'
const MEDIA_ADMIN_HANDLE = '163292'

const DEFAULT_CHAT_PROFILES: Record<string, { handle: string; name: string }> = {
    '163292': { handle: '163292', name: 'AXX!A' },
    '283420': { handle: '283420', name: 'Astra' },
    '3227470': { handle: '3227470', name: 'Nocturne' },
}

const HANDLE_TIMEZONES: Record<string, string> = {
    '163292': 'Europe/Paris',
    '283420': 'Europe/Paris',
    '3227470': 'Etc/GMT+6',
}

type EmailNotifyMode = 'mention' | 'all'

type UserChatPrefs = {
    handle: string
    displayName: string
    pfpKey?: string
    notifyEmail?: string
    emailNotifyMode?: EmailNotifyMode
    updatedAt: number
}

type ChatMediaItem = {
    id: string
    imageKey: string
    contentType: string
    link?: string
    caption?: string
    createdAt: number
    authorHandle: string
}

type WorkerEnv = Env & {
    COMMUNITY_BUCKET?: R2Bucket
    SONOLUS_ASSETS_BUCKET?: R2Bucket
    RESEND_API_KEY?: string
    RESEND_FROM_EMAIL?: string
}

const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
        },
    })

const html = (body: string, status = 200) =>
    new Response(body, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    })

const message = (status: number, text: string) =>
    json({ message: text }, status)

const addressOf = (req: Request, env: WorkerEnv) =>
    (env.PUBLIC_ADDRESS ?? new URL(req.url).origin).replace(/\/+$/, '')

const isDevSkipSignature = (env: WorkerEnv): boolean =>
    String(env.DEV_SKIP_SIGNATURE ?? '').trim().toLowerCase() === 'true'

const isStaffChatHandle = (handle?: string | null): boolean =>
    Boolean(
        handle &&
        (STAFF_CHAT_HANDLES as readonly string[]).includes(String(handle).trim()),
    )

const isMediaAdminHandle = (handle?: string | null): boolean =>
    String(handle ?? '').trim() === MEDIA_ADMIN_HANDLE

function requiresProfilePassword(handle?: string | null): boolean {
    return String(handle ?? '').trim() === PROTECTED_CHAT_HANDLE
}

function matchesSessionSecretPassword(env: WorkerEnv, password?: unknown): boolean {
    const secret = String(env.SESSION_SECRET ?? '')
    const candidate = typeof password === 'string' ? password : ''
    return Boolean(secret) && candidate.length > 0 && candidate === secret
}

function defaultDisplayName(handle: string, fallbackName?: string): string {
    const cleanHandle = String(handle ?? '').trim()
    const cleanFallback = String(fallbackName ?? '').trim()
    return cleanFallback || DEFAULT_CHAT_PROFILES[cleanHandle]?.name || cleanHandle
}

function formatAuthorTag(author: string | undefined, handle: string | undefined): string {
    const cleanHandle = String(handle ?? '').trim()
    const cleanAuthor = String(author ?? '').trim() || cleanHandle
    if (!cleanHandle) return cleanAuthor
    return `${cleanAuthor}#${cleanHandle}`
}

function parseCookie(req: Request, name: string): string | null {
    const cookieHeader = req.headers.get('Cookie') ?? ''
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=')
        if (idx === -1) continue
        const key = part.slice(0, idx).trim()
        if (key === name) {
            return decodeURIComponent(part.slice(idx + 1).trim())
        }
    }
    return null
}

function communityBucket(env: WorkerEnv): R2Bucket | null {
    return env.COMMUNITY_BUCKET ?? null
}

function assetsBucket(env: WorkerEnv): R2Bucket | null {
    return env.SONOLUS_ASSETS_BUCKET ?? null
}

function bucketsForRead(env: WorkerEnv): R2Bucket[] {
    return [env.SONOLUS_ASSETS_BUCKET, env.COMMUNITY_BUCKET].filter(
        (b): b is R2Bucket => Boolean(b),
    )
}

function sanitizeHttpLink(raw?: unknown): string {
    const val = String(raw ?? '').trim()
    if (!val) return ''
    try {
        const parsed = new URL(val)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.toString()
        }
    } catch {
        // invalid link
    }
    return ''
}

async function getBucketObject(
    bucket: R2Bucket | null,
    keys: string[],
): Promise<R2ObjectBody | null> {
    if (!bucket) return null
    for (const key of keys) {
        const obj = await bucket.get(key).catch(() => null)
        if (obj) return obj
    }
    return null
}

async function getCachedJsonFromAssets<T>(
    env: WorkerEnv,
    keys: string[],
): Promise<T | null> {
    const obj = await getBucketObject(assetsBucket(env), keys)
    if (!obj) return null
    try {
        return await obj.json() as T
    } catch {
        return null
    }
}

const MEDIA_INDEX_KEY = 'chat/media/index.json'

async function listChatMedia(env: WorkerEnv): Promise<ChatMediaItem[]> {
    const bucket = communityBucket(env)
    if (!bucket) return []

    const indexed: ChatMediaItem[] = []
    for (const key of [MEDIA_INDEX_KEY, 'media/index.json']) {
        try {
            const obj = await bucket.get(key)
            if (!obj) continue
            const parsed = await obj.json() as { items?: ChatMediaItem[] } | ChatMediaItem[]
            const rawList = Array.isArray(parsed)
                ? parsed
                : Array.isArray(parsed?.items)
                    ? parsed.items
                    : []
            for (const item of rawList) {
                if (item && typeof item.id === 'string' && typeof item.imageKey === 'string') {
                    indexed.push(item)
                }
            }
            if (indexed.length > 0) break
        } catch {
            // try next
        }
    }

    if (indexed.length > 0) {
        return indexed.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    }

    try {
        const listed = await bucket.list({ prefix: 'chat/media/' })
        const derived: ChatMediaItem[] = []
        for (const obj of listed.objects ?? []) {
            if (!obj.key || obj.key.endsWith('/') || obj.key.endsWith('.json')) continue
            const fileName = obj.key.slice('chat/media/'.length)
            const id = fileName.replace(/\.[^.]+$/, '') || fileName
            derived.push({
                id,
                imageKey: obj.key,
                contentType: obj.httpMetadata?.contentType ?? 'image/png',
                createdAt: obj.uploaded ? new Date(obj.uploaded).getTime() : Date.now(),
                authorHandle: MEDIA_ADMIN_HANDLE,
            })
        }
        return derived.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    } catch {
        return []
    }
}

async function saveChatMediaIndex(env: WorkerEnv, items: ChatMediaItem[]): Promise<void> {
    const bucket = communityBucket(env)
    if (!bucket) {
        throw new Error('COMMUNITY_BUCKET is not configured.')
    }
    await bucket.put(
        MEDIA_INDEX_KEY,
        JSON.stringify({ items }),
        { httpMetadata: { contentType: 'application/json' } },
    )
}

async function verifySigned(
    req: Request,
    env: WorkerEnv,
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

    const now = Date.now()
    if (
        typeof body.time !== 'number' ||
        !Number.isFinite(body.time) ||
        body.time + 60_000 < now ||
        body.time - 60_000 > now
    ) {
        return null
    }

    const p = body.userProfile
    if (typeof p?.id !== 'string' || typeof p?.handle !== 'string') {
        return null
    }

    if (!isDevSkipSignature(env)) {
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

function extractSessionToken(req: Request, url?: URL): string | null {
    return (
        req.headers.get('Sonolus-Session') ??
        url?.searchParams.get('session') ??
        null
    )
}

async function sessionOf(
    req: Request,
    env: WorkerEnv,
    url?: URL,
): Promise<AuthSession | null> {
    const token = extractSessionToken(req, url)
    return token ? verifyToken<AuthSession>(env.SESSION_SECRET, token) : null
}

function pickedProfile(handle?: string | null): UserProfile | null {
    const clean = String(handle ?? '').trim()
    if (!clean || !isStaffChatHandle(clean)) return null
    const known = DEFAULT_CHAT_PROFILES[clean]
    return {
        id: known ? known.handle : clean,
        handle: clean,
        name: known ? known.name : clean,
    }
}

async function resolveChatUser(
    req: Request,
    env: WorkerEnv,
    url: URL,
    body?: any,
): Promise<{ user: UserProfile; fromSonolus: boolean; token: string } | null> {
    const token = extractSessionToken(req, url) ?? ''
    const session = token
        ? await verifyToken<AuthSession>(env.SESSION_SECRET, token)
        : null

    if (session && isStaffChatHandle(session.user.handle)) {
        const prefs = await getUserChatPrefs(env, session.user.handle)
        return {
            user: {
                ...session.user,
                name: prefs.displayName || defaultDisplayName(session.user.handle, session.user.name),
            },
            fromSonolus: true,
            token,
        }
    }

    const pickedHandle =
        url.searchParams.get('handle') ??
        req.headers.get('X-Chat-Handle') ??
        body?.handle ??
        parseCookie(req, CHAT_HANDLE_COOKIE) ??
        null

    const picked = pickedProfile(pickedHandle)
    if (picked) {
        const prefs = await getUserChatPrefs(env, picked.handle)
        return {
            user: {
                ...picked,
                name: prefs.displayName || picked.name,
            },
            fromSonolus: false,
            token: '',
        }
    }

    return null
}

const roomStub = (env: WorkerEnv, name: string) =>
    env.ROOM.get(env.ROOM.idFromName(name))

const lobby = (env: WorkerEnv) =>
    env.LOBBY.get(env.LOBBY.idFromName('main'))

const chatStub = (env: WorkerEnv) =>
    env.CHAT.get(env.CHAT.idFromName('staff'))

const POST_LABELS: Record<PostCategory, {
    section: string
    create: string
    titlePlaceholder: string
    bodyPlaceholder: string
}> = {
    announcements: {
        section: 'Announcements',
        create: 'Create Announcement',
        titlePlaceholder: 'Announcement title',
        bodyPlaceholder: 'Write your announcement...',
    },
    posts: {
        section: 'Posts',
        create: 'Create Post',
        titlePlaceholder: 'Post title',
        bodyPlaceholder: 'Write your post...',
    },
    results: {
        section: 'Results',
        create: 'Publish Results',
        titlePlaceholder: 'Result title',
        bodyPlaceholder: 'Write the results...',
    },
}

function parseCategoryString(raw: string | null | undefined): PostCategory | null {
    if (!raw) return null
    const clean = raw.trim().toLowerCase()
    if (clean === 'announcements' || clean === 'announcement' || clean.includes('announce')) return 'announcements'
    if (clean === 'results' || clean === 'result' || clean.includes('result')) return 'results'
    if (clean === 'posts' || clean === 'post' || clean.includes('post')) return 'posts'
    return null
}

function parseEncodedParams(raw: string | null | undefined): URLSearchParams | null {
    if (!raw) return null
    try {
        return new URLSearchParams(String(raw))
    } catch {
        return null
    }
}

function resolveCategory(
    url: URL,
    _req?: Request,
    body?: any,
    values?: URLSearchParams,
): PostCategory | null {
    const bodySearchParams = parseEncodedParams(body?.searchValues)
    const bodyValueParams = parseEncodedParams(body?.values)
    const urlSearchParams = parseEncodedParams(url.searchParams.get('searchValues'))

    const candidates: (string | null | undefined)[] = [
        values?.get('type'),
        values?.get('infoType'),
        values?.get('postType'),
        values?.get('section'),
        values?.get('category'),
        bodyValueParams?.get('type'),
        bodyValueParams?.get('infoType'),
        bodyValueParams?.get('postType'),
        bodyValueParams?.get('section'),
        bodyValueParams?.get('category'),
        body?.type,
        body?.infoType,
        body?.postType,
        body?.section,
        body?.category,
        url.searchParams.get('type'),
        url.searchParams.get('infoType'),
        url.searchParams.get('postType'),
        url.searchParams.get('section'),
        url.searchParams.get('category'),
        urlSearchParams?.get('category'),
        urlSearchParams?.get('infoType'),
        urlSearchParams?.get('type'),
        urlSearchParams?.get('section'),
        bodySearchParams?.get('category'),
        bodySearchParams?.get('infoType'),
        bodySearchParams?.get('type'),
        bodySearchParams?.get('section'),
    ]

    for (const c of candidates) {
        const parsed = parseCategoryString(c)
        if (parsed) return parsed
    }

    return null
}

function resolveKeywords(url: URL): string {
    const urlSearchParams = parseEncodedParams(url.searchParams.get('searchValues'))
    const direct =
        url.searchParams.get('keywords') ??
        url.searchParams.get('query') ??
        urlSearchParams?.get('keywords') ??
        urlSearchParams?.get('query') ??
        ''
    return direct.trim().toLowerCase()
}

function sortPostsPinnedFirst(posts: StoredPost[]): StoredPost[] {
    return [...posts].sort((a, b) => {
        const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
        if (pinDiff !== 0) return pinDiff
        return Number(b.item?.time ?? 0) - Number(a.item?.time ?? 0)
    })
}

function buildPostItemWithBadges(post: StoredPost) {
    const likesCount = (post.likes ?? []).length
    const commentsCount = (post.comments ?? []).length
    const tags: { title: string; icon?: string }[] = []

    if (post.pinned) {
        tags.push({ title: 'Pinned', icon: 'pin' })
    }
    tags.push({ title: String(likesCount), icon: 'heart' })
    if (commentsCount > 0) {
        tags.push({ title: String(commentsCount), icon: 'comment' })
    }

    return {
        ...post.item,
        tags,
    }
}

const chatActionForm = {
    name: 'Chat',
    type: 'chatComment',
    title: 'Chat',
    icon: 'comment',
    requireConfirmation: false,
    options: [
        {
            name: 'Chat',
            query: 'text',
            required: false,
            type: 'text',
            def: '',
            placeholder: 'Write a message...',
            limit: 500,
            shortcuts: [],
        },
    ],
}

const postCommentForm = {
    name: 'Comment',
    type: 'postComment',
    title: 'Comment',
    icon: 'comment',
    requireConfirmation: false,
    options: [
        {
            name: 'Comment',
            query: 'text',
            required: false,
            type: 'text',
            def: '',
            placeholder: 'Write a comment...',
            limit: 500,
            shortcuts: [],
        },
    ],
}

function makeDeleteCommentForm() {
    return {
        name: 'Delete',
        type: 'deleteComment',
        title: 'Delete',
        icon: 'delete',
        requireConfirmation: true,
        options: [],
    }
}

function canDeleteComment(session: AuthSession | null, authorHandle: string): boolean {
    if (!session) return false
    return session.user.handle === authorHandle || session.user.handle === TOURNAMENT_HOST_HANDLE
}

function canDeleteChatMessage(actorHandle: string, authorHandle: string): boolean {
    return actorHandle === authorHandle || actorHandle === TOURNAMENT_HOST_HANDLE
}

function buildChatPostItem(messages: ChatMessage[], pinnedId: string | null) {
    const latest = messages[messages.length - 1] ?? null
    const pinnedMsg = pinnedId ? messages.find((m) => m.id === pinnedId) ?? null : null
    const count = messages.length
    const countLabel = `${count} ${count === 1 ? 'comment' : 'comments'}`

    const subtitle = pinnedMsg
        ? `${formatAuthorTag(pinnedMsg.author, pinnedMsg.handle)}: ${pinnedMsg.text} · ${countLabel}`
        : latest
            ? `${formatAuthorTag(latest.author, latest.handle)}: ${latest.text} · ${countLabel}`
            : countLabel

    return {
        name: 'chat',
        version: 1 as const,
        title: 'Chat',
        subtitle,
        time: latest?.time ?? 0,
        author: SERVER_TITLE,
        tags: [{ title: String(count), icon: 'comment' }],
    }
}

function formatChatCommunityComments(
    messages: ChatMessage[],
    session: AuthSession | null,
    page = 0,
) {
    const ordered = [...messages].reverse()
    const pageSize = 10
    const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize))
    const slice = ordered.slice(page * pageSize, page * pageSize + pageSize)

    return {
        pageCount,
        comments: slice.map((m) => ({
            name: m.id,
            author: formatAuthorTag(m.author, m.handle),
            time: m.time,
            content: m.text,
            message: m.text,
            actions: canDeleteComment(session, m.handle) ? [makeDeleteCommentForm()] : [],
        })),
    }
}

function extractCommentText(values: URLSearchParams): string {
    const direct =
        values.get('text') ??
        values.get('Chat') ??
        values.get('Comment') ??
        values.get('comment') ??
        values.get('content') ??
        values.get('message') ??
        ''
    if (direct.trim()) return direct.trim()

    for (const [key, val] of values.entries()) {
        if (key !== 'type' && val.trim()) return val.trim()
    }
    return ''
}

function externalChatUrl(req: Request, env: WorkerEnv): string {
    return `${addressOf(req, env)}/chat`
}

function sonolusChatLinkUrl(req: Request, env: WorkerEnv): string {
    return externalChatUrl(req, env)
}

const VALID_POST_CATEGORIES = new Set([
    'announcements',
    'announcement',
    'posts',
    'post',
    'results',
    'result',
    'chat',
    'staff-chat',
])

function rawPostCategory(url: URL): string | null {
    const searchParams = parseEncodedParams(url.searchParams.get('searchValues'))

    const candidates = [
        url.searchParams.get('type'),
        url.searchParams.get('infoType'),
        url.searchParams.get('postType'),
        url.searchParams.get('section'),
        url.searchParams.get('category'),
        searchParams?.get('category'),
        searchParams?.get('infoType'),
        searchParams?.get('type'),
        searchParams?.get('section'),
    ]

    for (const candidate of candidates) {
        const clean = String(candidate ?? '').trim().toLowerCase()
        if (clean && VALID_POST_CATEGORIES.has(clean)) {
            return clean
        }
    }

    return null
}

const isChatCategory = (url: URL) => {
    const raw = rawPostCategory(url)
    return raw === 'chat' || raw === 'staff-chat'
}

const isChatItemName = (name: string) =>
    name === 'chat' || name === 'staff-chat'

function getImageDimensions(
    bytes: Uint8Array,
    contentType: string,
): { width: number; height: number } | null {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    if (contentType === 'image/png' && bytes.length >= 24) {
        return {
            width: view.getUint32(16, false),
            height: view.getUint32(20, false),
        }
    }

    if (contentType === 'image/jpeg') {
        let offset = 2
        while (offset + 9 < bytes.length) {
            if (bytes[offset] !== 0xff) {
                offset++
                continue
            }
            const marker = bytes[offset + 1]!
            if (marker === 0xd8 || marker === 0xd9) {
                offset += 2
                continue
            }
            const segLen = view.getUint16(offset + 2, false)
            if (segLen < 2 || offset + 2 + segLen > bytes.length) break
            if (
                (marker >= 0xc0 && marker <= 0xc3) ||
                (marker >= 0xc5 && marker <= 0xc7) ||
                (marker >= 0xc9 && marker <= 0xcb) ||
                (marker >= 0xcd && marker <= 0xcf)
            ) {
                return {
                    height: view.getUint16(offset + 5, false),
                    width: view.getUint16(offset + 7, false),
                }
            }
            offset += 2 + segLen
        }
    }

    if (contentType === 'image/webp' && bytes.length >= 30) {
        const chunk = String.fromCharCode(...bytes.slice(12, 16))
        if (chunk === 'VP8X' && bytes.length >= 30) {
            const w = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
            const h = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
            return { width: w, height: h }
        }
        if (chunk === 'VP8 ' && bytes.length >= 30) {
            const w = view.getUint16(26, true) & 0x3fff
            const h = view.getUint16(28, true) & 0x3fff
            return { width: w, height: h }
        }
        if (chunk === 'VP8L' && bytes.length >= 25) {
            const b0 = bytes[21]!
            const b1 = bytes[22]!
            const b2 = bytes[23]!
            const b3 = bytes[24]!
            const w = 1 + (((b1 & 0x3f) << 8) | b0)
            const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
            return { width: w, height: h }
        }
    }

    return null
}

function escapeAttr(str: string): string {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

const RANKED_TIERS_UPPER = new Set([
    'BEGINNER',
    'BRONZE',
    'SILVER',
    'GOLD',
    'PLATINUM',
    'DIAMOND',
    'MASTER',
])

async function resolveRoomCover(
    env: WorkerEnv,
        summary: {
        type?: string
        tier?: string
        hostHandle?: string
        level?: { address: string; name: string } | null
        coverUrl?: string | null
    },
): Promise<RoomCover | undefined> {
    const type = summary.type

    if (type === 'casualRoom') {
        if (summary.coverUrl) {
            return { url: summary.coverUrl }
        }        if (!summary.level) {
            const handle = String(summary.hostHandle ?? '').trim()
            if (handle) {
                const prefs = await getUserChatPrefs(env, handle)
                const keys = [
                    prefs.pfpKey,
                    `chat/pfp/${handle}.png`,
                ].filter((key): key is string => Boolean(key))

                const profileImage = await getBucketObject(communityBucket(env), keys)
                if (profileImage) {
                    return {
                        url: `/sonolus/chat/pfp/${encodeURIComponent(handle)}`,
                    }
                }
            }
        }
        if (summary.level?.address && summary.level?.name) {
            const base = summary.level.address.replace(/\/+$/, '')
            const endpoint = `${base}/sonolus/levels/${encodeURIComponent(summary.level.name)}`
            try {
                const res = await fetch(endpoint, {
                    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
                    signal: AbortSignal.timeout(5000),
                })
                if (res.ok) {
                    const data: any = await res.json()
                    const item = data?.item ?? data
                    const coverObj = item?.cover
                    if (coverObj && typeof coverObj.url === 'string' && coverObj.url) {
                        const fullUrl = coverObj.url.startsWith('/')
                            ? `${base}${coverObj.url}`
                            : coverObj.url
                        return {
                            url: fullUrl,
                            ...(typeof coverObj.hash === 'string' && coverObj.hash
                                ? { hash: coverObj.hash }
                                : {}),
                        }
                    }
                }
            } catch {
                // fallback to undefined if song jacket unavailable
            }
        }
        return undefined
    }

    if (type === 'rankedRoom') {
        const tierUpper = String(summary.tier ?? 'master').toUpperCase()
        const safeTier = RANKED_TIERS_UPPER.has(tierUpper) ? tierUpper : 'MASTER'
        return {
            url: `/sonolus/rooms/cover/ranked/${safeTier}`,
        }
    }

    if (type === 'groupStage' || type === 'final') {
        return {
            url: '/sonolus/rooms/cover/xx',
        }
    }

    void env
    return undefined
}
async function roomItems(env: WorkerEnv, _session: AuthSession | null) {
    const rooms = await lobby(env).list()

    const items = await Promise.all(
        rooms.map(async (room) => {
            const current = await roomStub(env, room.name).summary()

            if (!current) {
                await lobby(env).remove(room.name)
                return null
            }

            if (current.visibility === 'private') return null

            const cover = await resolveRoomCover(env, current)

            return {
                name: current.name,
                title: current.title,
                subtitle: current.subtitle,
                master: current.master,
                ...(cover ? { cover } : {}),
                tags: [],
            }
        }),
    )

    return items.filter((item) => item !== null)
}

const canManagePosts = (session: AuthSession | null) =>
    session?.user.handle === TOURNAMENT_HOST_HANDLE

function postForm(category: PostCategory) {
    const label = POST_LABELS[category]

    return {
        name: category,
        type: category,
        title: label.create,
        requireConfirmation: false,
        options: [
            {
                name: 'Title',
                query: 'title',
                required: false,
                type: 'text',
                def: '',
                placeholder: label.titlePlaceholder,
                limit: 100,
                shortcuts: [],
            },
            {
                name: 'Description',
                query: 'description',
                required: false,
                type: 'textArea',
                def: '',
                placeholder: label.bodyPlaceholder,
                limit: 2000,
                shortcuts: [],
            },
            {
                name: 'Thumbnail',
                query: 'thumbnail',
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

function makeEditPostForm(post: StoredPost) {
    return {
        name: 'Edit',
        type: 'editPost',
        title: 'Edit',
        icon: 'edit',
        requireConfirmation: false,
        options: [
            {
                name: 'Title',
                query: 'title',
                required: false,
                type: 'text',
                def: String(post.item?.title ?? ''),
                placeholder: 'Post title',
                limit: 100,
                shortcuts: [],
            },
            {
                name: 'Description',
                query: 'description',
                required: false,
                type: 'textArea',
                def: String(post.description ?? ''),
                placeholder: 'Post description',
                limit: 2000,
                shortcuts: [],
            },
            {
                name: 'Thumbnail',
                query: 'thumbnail',
                description: 'Optional replacement image.',
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

function makeLikePostForm(liked: boolean) {
    return {
        name: liked ? 'Unlike' : 'Like',
        type: 'likePost',
        title: liked ? 'Unlike' : 'Like',
        icon: 'heart',
        requireConfirmation: false,
        options: [],
    }
}

function makePinPostForm(pinned: boolean) {
    return {
        name: pinned ? 'Unpin' : 'Pin',
        type: 'pinPost',
        title: pinned ? 'Unpin' : 'Pin',
        icon: 'pin',
        requireConfirmation: false,
        options: [],
    }
}

const deletePostForm = {
    name: 'Delete',
    type: 'deletePost',
    title: 'Delete',
    icon: 'delete',
    requireConfirmation: true,
    options: [],
}

function postActionsFor(post: StoredPost, session: AuthSession | null) {
    const liked = Boolean(session && (post.likes ?? []).includes(session.user.handle))
    const pinned = Boolean(post.pinned)
    const actions: any[] = [
        makeLikePostForm(liked),
    ]
    if (canManagePosts(session)) {
        actions.push(makeEditPostForm(post), makePinPostForm(pinned), deletePostForm)
    }
    return actions
}

function formatPostComments(
    post: StoredPost,
    session: AuthSession | null,
    page = 0,
) {
    const comments: PostComment[] = post.comments ?? []
    const ordered = [...comments].reverse()
    const pageSize = 10
    const pageCount = Math.max(1, Math.ceil(ordered.length / pageSize))
    const slice = ordered.slice(page * pageSize, page * pageSize + pageSize)

    return {
        pageCount,
        comments: slice.map((c) => ({
            name: c.id,
            author: formatAuthorTag(c.author, c.handle),
            time: c.time,
            content: c.text,
            message: c.text,
            actions: canDeleteComment(session, c.handle) ? [makeDeleteCommentForm()] : [],
        })),
    }
}

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

        if (!response.ok) return null

        const data: any = await response.json()
        const item = data.item ?? data

        if (
            !item ||
            typeof item.name !== 'string' ||
            typeof item.title === 'undefined' ||
            typeof item.engine === 'undefined' ||
            typeof item.data === 'undefined'
        ) {
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

async function loadLevelItems(charts: SheetChart[], concurrency = 12) {
    const results: ({ chart: SheetChart; item: RemoteLevelItem } | null)[] =
        new Array(charts.length).fill(null)
    let cursor = 0

    const worker = async () => {
        while (cursor < charts.length) {
            const idx = cursor++
            const chart = charts[idx]!
            const item = await remoteLevelItem(chart)
            results[idx] = item ? { chart, item } : null
        }
    }

    const workers = Array.from(
        { length: Math.min(concurrency, charts.length) },
        () => worker(),
    )
    await Promise.all(workers)

    return results.filter(
        (entry): entry is { chart: SheetChart; item: RemoteLevelItem } =>
            entry !== null,
    )
}

async function getCachedLevelItemsForCharts(
    env: WorkerEnv,
    charts: SheetChart[],
): Promise<RemoteLevelItem[] | null> {
    const cachedList = await getCachedJsonFromAssets<any>(env, [
        'server/level-list/index.json',
    ])
    const rawItems: any[] = Array.isArray(cachedList)
        ? cachedList
        : Array.isArray(cachedList?.items)
            ? cachedList.items
            : []

    if (!rawItems.length) return null

    const byKey = new Map<string, RemoteLevelItem>()
    for (const raw of rawItems) {
        const item = raw?.item ?? raw
        if (!item || typeof item.name !== 'string') continue
        byKey.set(item.name, item)
        if (typeof item.id === 'string' && item.id) {
            byKey.set(item.id, item)
        }
    }

    const matched: RemoteLevelItem[] = []
    for (const chart of charts) {
        const hit = byKey.get(chart.name) ?? byKey.get(chart.id)
        if (!hit) return null
        matched.push(hit)
    }
    return matched
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

async function findChart(name: string, env: WorkerEnv): Promise<SheetChart | null> {
    const [customCharts, playlists] = await Promise.all([
        getCustomLevels(env),
        getPlaylists(env),
    ])

    return [
        ...customCharts,
        ...playlists.flatMap((playlist) => playlist.charts),
    ].find((entry) => entry.name === name || entry.id === name) ?? null
}

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

export default {
    async scheduled(
        _event: ScheduledEvent,
        env: WorkerEnv,
        ctx: ExecutionContext,
    ): Promise<void> {
        ctx.waitUntil(refreshDailyAssets(env))
    },

    async fetch(req: Request, env: WorkerEnv): Promise<Response> {
        const url = new URL(req.url)
        const path = url.pathname.replace(/\/+$/, '') || '/'

        if (req.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                },
            })
        }

        if (path === '/manifest.webmanifest' && req.method === 'GET') {
            return new Response(JSON.stringify({
                name: 'XX!',
                short_name: 'XX!',
                start_url: '/chat',
                scope: '/',
                display: 'standalone',
                background_color: '#FAF7F9',
                theme_color: '#9E4B76',
                icons: [
                    {
                        src: '/app-icon.png',
                        sizes: '192x192',
                        type: 'image/png',
                        purpose: 'any maskable',
                    },
                    {
                        src: '/app-icon.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'any maskable',
                    },
                ],
            }), {
                headers: {
                    'Content-Type': 'application/manifest+json; charset=utf-8',
                    'Cache-Control': 'public, max-age=3600',
                },
            })
        }

        if (path === '/sw.js' && req.method === 'GET') {
            const swCode = `
self.addEventListener('install', (event) => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.pathname === '/app-icon.png' || u.pathname.startsWith('/api/chat/pfp/')) {
    event.respondWith(
      caches.open('xx-chat-media-v1').then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      })
    );
  }
});
`
            return new Response(swCode.trim(), {
                headers: {
                    'Content-Type': 'application/javascript; charset=utf-8',
                    'Service-Worker-Allowed': '/',
                    'Cache-Control': 'no-store',
                },
            })
        }

        if (path === '/app-icon.png' && req.method === 'GET') {
            const obj =
                (await getBucketObject(assetsBucket(env), [
                    'server/banner.png',
                    'chat/pfp/163292.png',
                ])) ??
                (await getBucketObject(communityBucket(env), [
                    'chat/pfp/163292.png',
                ]))
            if (!obj) return new Response(null, { status: 404 })
            return new Response(obj.body, {
                headers: {
                    'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=3600',
                },
            })
        }

        if (path === '/sonolus/rooms/cover/xx' && req.method === 'GET') {
    const obj = await getBucketObject(communityBucket(env), [
        'chat/XX!.png',
    ])
    if (!obj) return new Response(null, { status: 404 })
    return new Response(obj.body, {
        headers: {
            'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600',
        },
    })
        }

        const rankedCoverMatch = path.match(/^\/sonolus\/rooms\/cover\/ranked\/([A-Z]+)$/)
        if (rankedCoverMatch && req.method === 'GET') {
            const tierUpper = rankedCoverMatch[1]!
            if (!RANKED_TIERS_UPPER.has(tierUpper)) {
                return new Response(null, { status: 404 })
            }
            const obj = await getBucketObject(assetsBucket(env), [
                `ranked-match/${tierUpper}/${tierUpper}.png`,
            ])
            if (!obj) return new Response(null, { status: 404 })
            return new Response(obj.body, {
                headers: {
                    'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=3600',
                },
            })
        }

                                if (path === '/refresh' || path === '/admin/refresh') {
            const summary = await refreshDailyAssets(env)
            await lobby(env).syncAllToR2().catch(() => {})
            return json({
                ok: summary.errors.length === 0,
                ...summary,
            })
        }

                const pfpMatch = path.match(/^\/(?:api\/chat\/pfp|sonolus\/chat\/pfp)\/([^/]+)$/)
        if (pfpMatch && req.method === 'GET') {
            const handle = decodeURIComponent(pfpMatch[1]!).trim()
            const prefs = await getUserChatPrefs(env, handle)
            const keys = [
                prefs.pfpKey,
                `chat/pfp/${handle}.png`,
            ].filter((k): k is string => Boolean(k))

            const obj = await getBucketObject(communityBucket(env), keys)
            if (obj) {
                return new Response(obj.body, {
                    headers: {
                        'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-cache',
                    },
                })
            }

            return new Response(null, { status: 404 })
        }

        const mediaAssetMatch = path.match(/^\/api\/chat\/media\/([^/]+)$/)
        if (mediaAssetMatch && req.method === 'GET') {
            const mediaId = decodeURIComponent(mediaAssetMatch[1]!).trim()
            const items = await listChatMedia(env)
            const target = items.find((m) => m.id === mediaId)
            if (!target) return new Response(null, { status: 404 })

            const obj = await getBucketObject(communityBucket(env), [
                target.imageKey,
                `chat/media/${mediaId}.png`,
                `chat/media/${mediaId}.jpg`,
                `chat/media/${mediaId}.webp`,
            ])
            if (!obj) return new Response(null, { status: 404 })

            return new Response(obj.body, {
                headers: {
                    'Content-Type': obj.httpMetadata?.contentType ?? target.contentType ?? 'image/png',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=3600',
                },
            })
        }

        if (path === '/api/chat/media') {
            let body: any = null
            if (req.method === 'POST') {
                try {
                    body = await req.json()
                } catch {
                    return message(400, 'Invalid JSON.')
                }
            }

            const resolved = await resolveChatUser(req, env, url, body)
            if (!resolved) {
                return message(403, 'Choose a valid handle.')
            }

            if (req.method === 'GET') {
                const items = await listChatMedia(env)
                return json({ items })
            }

            if (req.method === 'POST') {
                if (!isMediaAdminHandle(resolved.user.handle)) {
                    return message(403, 'Only 163292 can add media.')
                }

                const dataUrl = typeof body?.imageDataUrl === 'string' ? body.imageDataUrl : ''
                const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/)
                if (!match) {
                    return message(400, 'Invalid image data.')
                }

                const mime = match[1]!
                const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
                const rawBytes = Uint8Array.from(atob(match[2]!), (c) => c.charCodeAt(0))
                if (rawBytes.byteLength > 8 * 1024 * 1024) {
                    return message(400, 'Media image too large.')
                }

                const bucket = communityBucket(env)
                if (!bucket) {
                    return message(500, 'COMMUNITY_BUCKET is not configured.')
                }

                const id = randomId(12)
                const imageKey = `chat/media/${id}.${ext}`
                await bucket.put(imageKey, rawBytes, {
                    httpMetadata: { contentType: mime },
                })

                const safeLink = sanitizeHttpLink(body?.link)
                const safeCaption = typeof body?.caption === 'string'
                    ? body.caption.trim().slice(0, 160)
                    : ''

                const existing = await listChatMedia(env)
                const nextItem: ChatMediaItem = {
                    id,
                    imageKey,
                    contentType: mime,
                    ...(safeLink ? { link: safeLink } : {}),
                    ...(safeCaption ? { caption: safeCaption } : {}),
                    createdAt: Date.now(),
                    authorHandle: resolved.user.handle,
                }
                const updated = [nextItem, ...existing]
                await saveChatMediaIndex(env, updated)
                return json({ ok: true, item: nextItem, items: updated })
            }

            if (req.method === 'DELETE') {
                if (!isMediaAdminHandle(resolved.user.handle)) {
                    return message(403, 'Only 163292 can delete media.')
                }
                const id = (url.searchParams.get('id') ?? '').trim()
                if (!id) return message(400, 'Missing media id.')

                const existing = await listChatMedia(env)
                const target = existing.find((m) => m.id === id)
                if (!target) return message(404, 'Media item not found.')

                const bucket = communityBucket(env)
                if (bucket) {
                    await bucket.delete(target.imageKey).catch(() => {})
                }
                const updated = existing.filter((m) => m.id !== id)
                await saveChatMediaIndex(env, updated)
                return json({ ok: true, items: updated })
            }
        }

        if (path === '/api/chat/auth' && req.method === 'POST') {
            let body: any
            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid JSON.')
            }
            const handle = String(body?.handle ?? '').trim()
            if (!requiresProfilePassword(handle)) {
                return json({ ok: true })
            }
            if (!matchesSessionSecretPassword(env, body?.password)) {
                return message(401, 'Invalid password.')
            }
            return json({ ok: true })
        }

        if (path === '/api/chat/settings' && req.method === 'POST') {
            let body: any
            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid JSON.')
            }

            const resolved = await resolveChatUser(req, env, url, body)
            if (!resolved) {
                return message(403, 'Choose a valid handle to update settings.')
            }

            const bucket = communityBucket(env)
            if (!bucket) {
                return message(500, 'COMMUNITY_BUCKET is not configured.')
            }

            const handle = resolved.user.handle
            let pfpKey: string | undefined

            if (typeof body?.pfpDataUrl === 'string' && body.pfpDataUrl.startsWith('data:image/')) {
                const match = body.pfpDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/)
                if (!match) {
                    return message(400, 'Invalid image data.')
                }
                const mime = match[1]!
                const rawBytes = Uint8Array.from(atob(match[2]!), (c) => c.charCodeAt(0))
                if (rawBytes.byteLength > 2 * 1024 * 1024) {
                    return message(400, 'Profile image too large.')
                }
                pfpKey = `chat/pfp/${handle}.png`
                await bucket.put(pfpKey, rawBytes, {
                    httpMetadata: { contentType: mime },
                })
            }

            const nextDisplayName = typeof body?.displayName === 'string' && body.displayName.trim()
                ? body.displayName.trim().slice(0, 40)
                : resolved.user.name

            const notifyEmail = typeof body?.notifyEmail === 'string'
                ? body.notifyEmail.trim().slice(0, 120)
                : undefined

            const emailNotifyMode: EmailNotifyMode | undefined =
                body?.emailNotifyMode === 'all' || body?.emailNotifyMode === 'mention'
                    ? body.emailNotifyMode
                    : undefined

            const savedPrefs = await saveUserChatPrefs(
                env,
                handle,
                nextDisplayName,
                pfpKey,
                notifyEmail,
                emailNotifyMode,
            )
            return json({ ok: true, prefs: savedPrefs })
        }

        if (path === '/ws/chat' && req.headers.get('Upgrade') === 'websocket') {
            const resolved = await resolveChatUser(req, env, url)
            if (!resolved) {
                return new Response('Unauthorized', { status: 401 })
            }
            return chatStub(env).fetch(req)
        }

        if (path === '/chat' && req.method === 'GET') {
            const [prefsEntries, initialMessages, initialMedia] = await Promise.all([
                Promise.all(
                    CHAT_PFP_HANDLES.map(async (h) => [h, await getUserChatPrefs(env, h)] as const),
                ),
                chatStub(env).listMessages().catch(() => []),
                listChatMedia(env).catch(() => []),
            ])
            const prefsMap = Object.fromEntries(prefsEntries)
            const resolved = await resolveChatUser(req, env, url)
            const sUrl = sonolusChatLinkUrl(req, env)
            if (resolved) {
                return html(
                    renderStaffChatHtml(
                        resolved.user,
                        resolved.token,
                        resolved.fromSonolus,
                        prefsMap,
                        sUrl,
                        initialMessages,
                        initialMedia,
                    ),
                )
            }
            return html(
                renderStaffChatHtml(null, '', false, prefsMap, sUrl, initialMessages, initialMedia),
            )
        }

        if (path === '/api/chat') {
            let body: any = null
            if (req.method === 'POST') {
                try {
                    body = await req.json()
                } catch {
                    return message(400, 'Invalid JSON.')
                }
            }

            const resolved = await resolveChatUser(req, env, url, body)
            if (!resolved) {
                return message(403, 'Choose a valid handle to use chat.')
            }

            const prefsEntries = await Promise.all(
                CHAT_PFP_HANDLES.map(async (h) => [h, await getUserChatPrefs(env, h)] as const),
            )
            const prefsMap = Object.fromEntries(prefsEntries)

            if (req.method === 'GET') {
                const messages = await chatStub(env).listMessages().catch(() => [])
                return json({ messages, prefs: prefsMap })
            }

            if (req.method === 'POST') {
                if (body?.action === 'delete') {
                    const targetId = typeof body?.id === 'string' ? body.id.trim() : ''
                    if (!targetId) {
                        return message(400, 'Missing message id.')
                    }
                    const messages = await chatStub(env).listMessages().catch(() => [])
                    const target = messages.find((m) => m.id === targetId)
                    if (!target) {
                        return message(404, 'Message not found.')
                    }
                    if (!canDeleteChatMessage(resolved.user.handle, target.handle)) {
                        return message(403, 'Only 163292 can delete messages from other members.')
                    }
                    await chatStub(env).deleteMessage(targetId)
                    const updated = await chatStub(env).listMessages().catch(() => [])
                    return json({ ok: true, messages: updated, prefs: prefsMap })
                }

                if (body?.action === 'like') {
                    const targetId = typeof body?.id === 'string' ? body.id.trim() : ''
                    if (!targetId) return message(400, 'Missing message id.')
                    await chatStub(env).toggleLike(targetId, resolved.user.handle)
                    const updated = await chatStub(env).listMessages().catch(() => [])
                    return json({ ok: true, messages: updated, prefs: prefsMap })
                }

                const text = typeof body?.text === 'string' ? body.text.trim() : ''
                if (!text) return message(400, 'Message cannot be empty.')

                const replyTo = body?.replyTo && typeof body.replyTo === 'object'
                    ? {
                        id: String(body.replyTo.id ?? ''),
                        author: String(body.replyTo.author ?? ''),
                        handle: String(body.replyTo.handle ?? ''),
                        text: String(body.replyTo.text ?? '').slice(0, 120),
                    }
                    : undefined

                const newMessage = {
    handle: resolved.user.handle,
    author: resolved.user.name || resolved.user.handle,
    text: text.slice(0, 500),
}

await chatStub(env).addMessage({
    ...newMessage,
    ...(replyTo ? { replyTo } : {}),
})

await sendChatEmailNotifications(env, newMessage)

const messages = await chatStub(env).listMessages().catch(() => [])
return json({ ok: true, messages, prefs: prefsMap })
            }

            if (req.method === 'DELETE') {
                const id = (url.searchParams.get('id') ?? '').trim()
                if (!id) {
                    return message(400, 'Missing message id.')
                }
                const messages = await chatStub(env).listMessages().catch(() => [])
                const target = messages.find((m) => m.id === id)
                if (!target) {
                    return message(404, 'Message not found.')
                }
                if (!canDeleteChatMessage(resolved.user.handle, target.handle)) {
                    return message(403, 'Only 163292 can delete messages from other members.')
                }
                await chatStub(env).deleteMessage(id)
                const updated = await chatStub(env).listMessages().catch(() => [])
                return json({ ok: true, messages: updated, prefs: prefsMap })
            }
        }

        const ws = path.match(/^\/ws\/([\w-]+)$/)

        if (ws) {
            const token =
                req.headers.get('Sonolus-Room-Session') ??
                (isDevSkipSignature(env)
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
            const session = await sessionOf(req, env, url)
            const canChat = Boolean(session && isStaffChatHandle(session.user.handle))

            const bannerObject = await getBucketObject(assetsBucket(env), [
                'server/banner.png',
            ])
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
                    ...(canChat
                        ? [
                            {
                                type: 'post',
                                title: 'Chat',
                                icon: 'comment',
                                infoType: 'chat',
                            },
                        ]
                        : []),
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

            const expiration = Date.now() + 24 * 60 * 60_000
            const session = await signToken(env.SESSION_SECRET, {
                user: profileOf(body.userProfile),
                exp: expiration,
            } satisfies AuthSession)

            return json({ session, expiration })
        }

        if (path === '/sonolus/server/banner' && req.method === 'GET') {
            const object = await getBucketObject(assetsBucket(env), [
                'server/banner.png',
            ])
            if (!object) return new Response(null, { status: 404 })

            return new Response(object.body, {
                headers: {
                    'Content-Type': object.httpMetadata?.contentType ?? 'image/png',
                    'Cache-Control': 'public, max-age=31536000, immutable',
                },
            })
        }

        if (path === '/sonolus/posts/info' && req.method === 'GET') {
            const session = await sessionOf(req, env, url)

            if (isChatCategory(url)) {
                if (!session || !isStaffChatHandle(session.user.handle)) {
                    return json({ title: 'Chat', creates: [], searches: [], sections: [] })
                }

                const [messages, pinnedId] = await Promise.all([
                    chatStub(env).listMessages().catch(() => []),
                    chatStub(env).getPinnedId().catch(() => null),
                ])

                return json({
                    title: 'Chat',
                    creates: [],
                    searches: [],
                    sections: [
                        {
                            title: 'Chat',
                            itemType: 'post',
                            items: [buildChatPostItem(messages, pinnedId)],
                        },
                    ],
                })
            }

            const explicit = resolveCategory(url, req)
            const kinds: PostCategory[] = explicit
                ? [explicit]
                : ['announcements', 'posts', 'results']

            const sections = await Promise.all(
                kinds.map(async (kind) => {
                    const posts = sortPostsPinnedFirst(
                        (await lobby(env).listPosts(kind).catch(() => [])).filter(
                            (p) => p.category === kind,
                        ),
                    )
                    return {
                        title: POST_LABELS[kind].section,
                        itemType: 'post',
                        items: posts.map(buildPostItemWithBadges),
                    }
                }),
            )

            return json({
                title: explicit ? POST_LABELS[explicit].section : 'Posts',
                creates: canManagePosts(session) && explicit
                    ? [postForm(explicit)]
                    : [],
                searches: [],
                sections,
            })
        }

        if (path === '/sonolus/posts/list' && req.method === 'GET') {
            const session = await sessionOf(req, env, url)
            const page = Math.max(0, Number(url.searchParams.get('page') ?? '0') || 0)
            const pageSize = 10

            if (isChatCategory(url)) {
                if (!session || !isStaffChatHandle(session.user.handle)) {
                    return json({ title: 'Chat', pageCount: 1, items: [], searches: [] })
                }

                const [messages, pinnedId] = await Promise.all([
                    chatStub(env).listMessages().catch(() => []),
                    chatStub(env).getPinnedId().catch(() => null),
                ])

                return json({
                    title: 'Chat',
                    pageCount: 1,
                    items: page === 0 ? [buildChatPostItem(messages, pinnedId)] : [],
                    searches: [],
                })
            }

            const kind = resolveCategory(url, req) ?? 'posts'
            const keywords = resolveKeywords(url)

            const allCategoryPosts = sortPostsPinnedFirst(
                (await lobby(env).listPosts(kind).catch(() => [])).filter(
                    (p) => p.category === kind,
                ),
            )

            const posts = keywords
                ? allCategoryPosts.filter((p) => {
                    const hay = [
                        String(p.item?.title ?? ''),
                        String(p.item?.author ?? ''),
                        String(p.description ?? ''),
                    ].join(' ').toLowerCase()
                    return keywords
                        .split(/\s+/)
                        .filter(Boolean)
                        .every((term) => hay.includes(term))
                })
                : allCategoryPosts

            const pageCount = Math.max(1, Math.ceil(posts.length / pageSize))
            const slice = posts.slice(page * pageSize, page * pageSize + pageSize)

            return json({
                title: POST_LABELS[kind].section,
                pageCount,
                items: slice.map(buildPostItemWithBadges),
                searches: [],
            })
        }

        if (path === '/sonolus/posts/create' && req.method === 'POST') {
            const session = await sessionOf(req, env, url)
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
            const category = resolveCategory(url, req, body, values)
            if (!category) {
                return message(400, 'Invalid or missing post category.')
            }

            const title = (values.get('title') ?? '').trim()
            const description = (values.get('description') ?? '').trim()
            const thumbnailHash = (values.get('thumbnail') ?? '').trim()

            if (!title || !description) {
                return message(400, 'A title and content are required.')
            }

            if (title.length > 100 || description.length > 2000) {
                return message(400, 'Post title or description exceeds maximum length.')
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
                    author: formatAuthorTag(session.user.name, session.user.handle),
                    tags: [],
                },
                description,
                uploadKey: key,
                thumbnailHash,
                likes: [],
                comments: [],
                pinned: false,
            })

            return json({
                key,
                hashes: thumbnailHash ? [thumbnailHash] : [],
                shouldUpdateInfo: true,
                shouldNavigateToItem: name,
            })
        }

        const postCommunityInfo = path.match(/^\/sonolus\/posts\/([\w-]+)\/community\/info$/)

        if (postCommunityInfo && req.method === 'GET') {
            const itemName = postCommunityInfo[1]!
            const session = await sessionOf(req, env, url)

            if (isChatItemName(itemName)) {
                if (!session || !isStaffChatHandle(session.user.handle)) {
                    return json({ creates: [], actions: [], topComments: [] })
                }

                const messages = await chatStub(env).listMessages().catch(() => [])
                return json({
                    creates: [],
                    actions: [chatActionForm],
                    topComments: formatChatCommunityComments(messages, session, 0).comments.slice(0, 3),
                })
            }

            const post = await lobby(env).getPost(itemName).catch(() => null)
            if (!post) {
                return json({ creates: [], actions: [], topComments: [] })
            }

            return json({
                creates: [],
                actions: [postCommentForm],
                topComments: formatPostComments(post, session, 0).comments.slice(0, 3),
            })
        }

        const postCommunitySubmit = path.match(/^\/sonolus\/posts\/([\w-]+)\/community\/submit$/)

        if (postCommunitySubmit && req.method === 'POST') {
            const itemName = postCommunitySubmit[1]!
            const session = await sessionOf(req, env, url)
            if (!session) return new Response(null, { status: 401 })

            let body: any
            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid community action.')
            }

            const values = new URLSearchParams(String(body.values ?? ''))
            const actionType = values.get('type')

            if (isChatItemName(itemName)) {
                if (!isStaffChatHandle(session.user.handle)) {
                    return message(403, 'Chat is restricted.')
                }

                const text = extractCommentText(values)
                if (!text) {
                    return message(400, 'Message cannot be empty.')
                }

                const newMessage = {
    handle: session.user.handle,
    author: session.user.name || session.user.handle,
    text: text.slice(0, 500),
}

await chatStub(env).addMessage(newMessage)
await sendChatEmailNotifications(env, newMessage)

                return json({
                    key: '',
                    hashes: [],
                    shouldUpdateCommunity: true,
                    shouldUpdateComments: true,
                })
            }

            const post = await lobby(env).getPost(itemName).catch(() => null)
            if (!post) return new Response(null, { status: 404 })

            if (actionType === 'likePost') {
                await lobby(env).togglePostLike(itemName, session.user.handle)
                return json({
                    key: '',
                    hashes: [],
                    shouldUpdateCommunity: true,
                    shouldUpdateComments: true,
                })
            }

            if (actionType === 'pinPost') {
                if (!canManagePosts(session)) {
                    return message(403, 'Only handle 163292 can pin posts.')
                }
                await lobby(env).togglePostPin(itemName)
                return json({
                    key: '',
                    hashes: [],
                    shouldUpdateCommunity: true,
                    shouldUpdateComments: true,
                })
            }

            const text = extractCommentText(values)
            if (!text) {
                return message(400, 'Comment cannot be empty.')
            }

            await lobby(env).addPostComment(itemName, {
                handle: session.user.handle,
                author: session.user.name || session.user.handle,
                text: text.slice(0, 500),
            })

            return json({
                key: '',
                hashes: [],
                shouldUpdateCommunity: true,
                shouldUpdateComments: true,
            })
        }

        const postCommentsList = path.match(/^\/sonolus\/posts\/([\w-]+)\/community\/comments\/list$/)

        if (postCommentsList && req.method === 'GET') {
            const itemName = postCommentsList[1]!
            const session = await sessionOf(req, env, url)
            const page = Math.max(0, Number(url.searchParams.get('page') ?? '0') || 0)

            if (isChatItemName(itemName)) {
                if (!session || !isStaffChatHandle(session.user.handle)) {
                    return json({ pageCount: 1, comments: [] })
                }

                const messages = await chatStub(env).listMessages().catch(() => [])
                return json(formatChatCommunityComments(messages, session, page))
            }

            const post = await lobby(env).getPost(itemName).catch(() => null)
            if (!post) {
                return json({ pageCount: 1, comments: [] })
            }

            return json(formatPostComments(post, session, page))
        }

        const postCommentSubmit = path.match(
            /^\/sonolus\/posts\/([\w-]+)\/community\/comments\/([^/]+)\/submit$/,
        )

        if (postCommentSubmit && req.method === 'POST') {
            const itemName = postCommentSubmit[1]!
            const session = await sessionOf(req, env, url)
            if (!session) return new Response(null, { status: 401 })

            const commentName = decodeURIComponent(postCommentSubmit[2]!)

            if (isChatItemName(itemName)) {
                if (!isStaffChatHandle(session.user.handle)) {
                    return message(403, 'Chat is restricted.')
                }

                const messages = await chatStub(env).listMessages().catch(() => [])
                const target = messages.find((m) => m.id === commentName)
                if (!target || !canDeleteComment(session, target.handle)) {
                    return message(403, 'You cannot delete this comment.')
                }

                await chatStub(env).deleteMessage(commentName)
                return json({
                    key: '',
                    hashes: [],
                    shouldUpdateCommunity: true,
                    shouldUpdateComments: true,
                })
            }

            const post = await lobby(env).getPost(itemName).catch(() => null)
            if (!post) return new Response(null, { status: 404 })

            const target = (post.comments ?? []).find((c) => c.id === commentName)
            if (!target || !canDeleteComment(session, target.handle)) {
                return message(403, 'You cannot delete this comment.')
            }

            await lobby(env).deletePostComment(itemName, commentName)
            return json({
                key: '',
                hashes: [],
                shouldUpdateCommunity: true,
                shouldUpdateComments: true,
            })
        }

        const postSubmitPath = path.match(/^\/sonolus\/posts\/([\w-]+)\/submit$/)

        if (postSubmitPath && req.method === 'POST') {
            const session = await sessionOf(req, env, url)
            if (!session) return new Response(null, { status: 401 })

            const postName = postSubmitPath[1]!

            let body: any
            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid post action.')
            }

            const values = new URLSearchParams(String(body.values ?? ''))
            const actionType = values.get('type')

            if (isChatItemName(postName)) {
                if (!isStaffChatHandle(session.user.handle)) {
                    return message(403, 'Chat is restricted.')
                }

                const text = extractCommentText(values)
                if (!text) {
                    return message(400, 'Message cannot be empty.')
                }

                const newMessage = {
    handle: session.user.handle,
    author: session.user.name || session.user.handle,
    text: text.slice(0, 500),
}

await chatStub(env).addMessage(newMessage)
await sendChatEmailNotifications(env, newMessage)

                return json({
                    key: '',
                    hashes: [],
                    shouldUpdateItem: true,
                })
            }

            const post = await lobby(env).getPost(postName).catch(() => null)
            if (!post) return new Response(null, { status: 404 })

            if (actionType === 'likePost') {
                await lobby(env).togglePostLike(postName, session.user.handle)
                return json({
                    key: '',
                    hashes: [],
                    shouldUpdateItem: true,
                })
            }

            if (actionType === 'editPost') {
                if (!canManagePosts(session)) {
                    return message(403, 'Only handle 163292 can edit posts.')
                }

                const nextTitle = (values.get('title') ?? String(post.item?.title ?? '')).trim()
                const nextDescription = (values.get('description') ?? String(post.description ?? '')).trim()
                const nextThumbHash = (values.get('thumbnail') ?? '').trim()

                if (!nextTitle || !nextDescription) {
                    return message(400, 'A title and content are required.')
                }

                if (nextTitle.length > 100 || nextDescription.length > 2000) {
                    return message(400, 'Post title or description exceeds maximum length.')
                }

                const uploadKey = nextThumbHash ? (post.uploadKey || randomId(24)) : post.uploadKey

                await lobby(env).createPost({
                    ...post,
                    item: {
                        ...post.item,
                        title: nextTitle,
                    },
                    description: nextDescription,
                    uploadKey,
                    ...(nextThumbHash ? { thumbnailHash: nextThumbHash } : {}),
                })

                return json({
                    key: nextThumbHash ? uploadKey : '',
                    hashes: nextThumbHash ? [nextThumbHash] : [],
                    shouldUpdateItem: true,
                })
            }

            if (actionType === 'pinPost') {
                if (!canManagePosts(session)) {
                    return message(403, 'Only handle 163292 can pin posts.')
                }
                await lobby(env).togglePostPin(postName)
                return json({
                    key: '',
                    hashes: [],
                    shouldUpdateItem: true,
                })
            }

            if (!canManagePosts(session)) {
                return message(403, 'Only handle 163292 can delete posts.')
            }

            if (actionType !== 'deletePost') {
                return message(400, 'Unknown post action.')
            }

            await Promise.all([
                ...[...bucketsForRead(env)].flatMap((b) => [
                    b.delete(`${post.category}/${postName}/thumbnail`).catch(() => {}),
                    b.delete(`posts/${postName}/thumbnail`).catch(() => {}),
                ]),
                lobby(env).removePost(postName),
            ])

            return json({
                key: '',
                hashes: [],
                shouldRemoveItem: true,
            })
        }

        if (path === '/sonolus/posts/upload' && req.method === 'POST') {
            const session = await sessionOf(req, env, url)
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
            if (file.size > 5 * 1024 * 1024) return message(400, 'Image is too large.')

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
                return message(400, 'Unsupported image format. Use PNG, JPEG, or WebP.')
            }

            const dims = getImageDimensions(image, contentType)
            if (!dims || dims.width < 1 || dims.height < 1 || dims.width > 2048 || dims.height > 2048) {
                return message(400, 'Image dimensions must be between 1×1 and 2048×2048 px.')
            }

            const digest = await crypto.subtle.digest('SHA-1', bytes)
            const hash = Array.from(
                new Uint8Array(digest),
                (byte) => byte.toString(16).padStart(2, '0'),
            ).join('')

            if (hash.toLowerCase() !== post.thumbnailHash.toLowerCase()) {
                return message(400, 'Image hash does not match.')
            }

            const targetBucket = communityBucket(env)
            if (targetBucket) {
                const objectKey = `${post.category}/${post.item.name}/thumbnail`
                await targetBucket.put(objectKey, bytes, {
                    httpMetadata: { contentType },
                })
            }

            await lobby(env).setPostThumbnail(
                post.item.name,
                hash,
                `/sonolus/posts/${post.item.name}/thumbnail`,
            )

            return json({})
        }

        const thumbnailPath = path.match(/^\/sonolus\/posts\/([\w-]+)\/thumbnail$/)

        if (thumbnailPath && req.method === 'GET') {
            const name = thumbnailPath[1]!
            const post = await lobby(env).getPost(name).catch(() => null)
            const cat = post?.category ?? 'posts'

            const object = await getBucketObject(communityBucket(env), [
                `${cat}/${name}/thumbnail`,
                `posts/${name}/thumbnail`,
                `announcements/${name}/thumbnail`,
                `results/${name}/thumbnail`,
            ])

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
            const session = await sessionOf(req, env, url)

            if (isChatItemName(postPath[1]!)) {
                if (!session || !isStaffChatHandle(session.user.handle)) {
                    return message(403, 'Chat is restricted.')
                }

                const [messages, pinnedId] = await Promise.all([
                    chatStub(env).listMessages().catch(() => []),
                    chatStub(env).getPinnedId().catch(() => null),
                ])
                const extUrl = externalChatUrl(req, env)

                return json({
                    item: buildChatPostItem(messages, pinnedId),
                    description: extUrl ? `External chat:\n${extUrl}` : '',
                    actions: [],
                    hasCommunity: true,
                    leaderboards: [],
                    sections: [],
                })
            }

            const postId = postPath[1]!
            const post = await lobby(env).getPost(postId).catch(() => null)
            if (!post) return new Response(null, { status: 404 })

            return json({
                item: buildPostItemWithBadges(post),
                description: post.description,
                actions: postActionsFor(post, session),
                hasCommunity: true,
                leaderboards: [],
                sections: [],
            })
        }

        if (path === '/sonolus/levels/info' && req.method === 'GET') {
            try {
                const { charts, pageCount } = await getCustomLevelPage(0, env)
                const cached = await getCachedLevelItemsForCharts(env, charts)
                const items = cached ?? (await loadLevelItems(charts)).map((entry) => entry.item)

                console.log(
                    `[Levels] Info page 0: ${items.length}/${charts.length} levels loaded (${cached ? 'R2 cache' : 'live'}). ${pageCount} pages total.`,
                )

                return json({
                    creates: [],
                    searches: [],
                    sections: [
                        {
                            title: 'Custom Levels',
                            itemType: 'level',
                            items,
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

                const { charts, pageCount } = await getCustomLevelPage(page, env)

                if (page >= pageCount) {
                    return json({
                        pageCount,
                        items: [],
                        searches: [],
                    })
                }

                const cached = await getCachedLevelItemsForCharts(env, charts)
                const items = cached ?? (await loadLevelItems(charts)).map((entry) => entry.item)

                return json({
                    pageCount,
                    items,
                    searches: [],
                })
            } catch (error) {
                console.error('Could not read custom levels sheet:', error)
                return message(502, 'Could not read the custom levels sheet.')
            }
        }

        const levelSub = path.match(
            /^\/sonolus\/levels\/([^/]+)\/((?:community|leaderboards|submit|upload)(?:\/.*)?)$/,
        )

        if (levelSub) {
            const chart = await findChart(decodeURIComponent(levelSub[1]!), env).catch(() => null)
            if (!chart || !isUnch(chart)) return new Response(null, { status: 404 })
            return proxyToUnch(req, url, chart, levelSub[2]!)
        }

        const levelPath = path.match(/^\/sonolus\/levels\/([^/]+)$/)

        if (levelPath && req.method === 'GET') {
            const requestedName = decodeURIComponent(levelPath[1]!)

            try {
                const [customCharts, playlists] = await Promise.all([
                    getCustomLevels(env),
                    getPlaylists(env),
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

        const makePlaylistItems = async () => {
            const [playlists, cachedPlaylistsRaw] = await Promise.all([
                getPlaylists(env),
                getCachedJsonFromAssets<any>(env, ['server/playlists/index.json']),
            ])

            const cachedList: any[] = Array.isArray(cachedPlaylistsRaw)
                ? cachedPlaylistsRaw
                : Array.isArray(cachedPlaylistsRaw?.items)
                    ? cachedPlaylistsRaw.items
                    : []

            const cachedBySlug = new Map<string, any>()
            for (const entry of cachedList) {
                const item = entry?.item ?? entry
                if (item && typeof item.name === 'string') {
                    cachedBySlug.set(item.name.toLowerCase(), item)
                }
            }

            return Promise.all(
                playlists.map(async (playlist) => {
                    const slug = playlistSlug(playlist.name)
                    const cachedItem = cachedBySlug.get(slug.toLowerCase())
                    if (cachedItem && Array.isArray(cachedItem.levels)) {
                        return {
                            ...cachedItem,
                            name: slug,
                            title: playlist.name,
                            subtitle: `${cachedItem.levels.length} levels`,
                        }
                    }

                    const loaded = await loadLevelItems(playlist.charts)

                    return {
                        name: slug,
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
                return message(502, 'Could not read the playlists sheet.')
            }
        }

        const playlistPath = path.match(/^\/sonolus\/playlists\/([\w-]+)$/)

        if (playlistPath && req.method === 'GET') {
            const requestedName = decodeURIComponent(playlistPath[1]!)

            try {
                const playlists = await getPlaylists(env)
                const playlist = playlists.find(
                    (entry) => samePlaylist(playlistSlug(entry.name), requestedName),
                )

                if (!playlist) return new Response(null, { status: 404 })

                const allItems = await makePlaylistItems()
                const item = allItems.find((entry) => samePlaylist(entry.name, playlistSlug(playlist.name)))

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

        if (path === '/sonolus/rooms/info' && req.method === 'GET') {
    const session = await sessionOf(req, env, url)
    const isHost = session?.user.handle === TOURNAMENT_HOST_HANDLE

    let availableEditions: string[]
    try {
        availableEditions = await getAvailableEditions()
    } catch (error) {
        console.error('[ROOMS] Could not load editions:', error)
        availableEditions = [await getCurrentEdition()]
    }

    return json({
        creates: session ? roomForms(isHost, availableEditions) : [],
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
            const session = await sessionOf(req, env, url)

            return json({
                pageCount: 1,
                items: await roomItems(env, session),
                searches: [],
            })
        }

        if (path === '/sonolus/rooms/create' && req.method === 'POST') {
            const session = await sessionOf(req, env, url)
            if (!session) return new Response(null, { status: 401 })

            const name = randomId(8)
            const key = randomId(24)

                        const reservation = {
                key,
                hostId: session.user.id,
                hostName: session.user.name,
                hostHandle: session.user.handle,
            }

                        await env.LOBBY
                .get(env.LOBBY.idFromName('main'))
                .reserveHostRoom(session.user.id, name, reservation)

            return json({ name, key })
        }

        const roomPath = path.match(/^\/sonolus\/rooms\/([\w-]+)$/)

        if (roomPath && req.method === 'GET') {
            const current = await roomStub(env, roomPath[1]!).summary()
            if (!current) return new Response(null, { status: 404 })

            const cover = await resolveRoomCover(env, current)

            return json({
                item: {
                    name: current.name,
                    title: current.title,
                    subtitle: current.subtitle,
                    master: current.master,
                    ...(cover ? { cover } : {}),
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
                        const authSession = await sessionOf(req, env, url)
            console.log('[ROOM CONFIG AUTH]', {
                signedHandle: user.handle,
                sessionHandle: authSession?.user.handle ?? null,
                sessionIdMatches: authSession?.user.id === user.id,
                type: url.searchParams.get('type'),
                hasRoomKey: !!key,
            })

            if (key) {
                const params = new URLSearchParams(url.searchParams)
                const rawSettings = parseSettings(params, undefined, user.name || user.handle)
                if (!rawSettings) {
                    return new Response(null, { status: 400 })
                }

                const existingSummary = await stub.summary().catch(() => null)
                const isAlreadyOpened = Boolean(existingSummary)
                const settings = rawSettings.type === 'rankedRoom' && isAlreadyOpened
                    ? {
                        ...rawSettings,
                        title: existingSummary?.title || rawSettings.title,
                    }
                    : rawSettings

                                if (!(await stub.configure(key, settings, user))) {
                    return new Response(null, { status: 400 })
                }
            } else {
                if (!(await stub.isOpen())) {
                    return new Response(null, { status: 404 })
                }

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
} satisfies ExportedHandler<WorkerEnv>
