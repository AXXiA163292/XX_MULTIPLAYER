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

async function getUserChatPrefs(env: WorkerEnv, handle: string): Promise<UserChatPrefs> {
    const clean = String(handle ?? '').trim()
    const fallback: UserChatPrefs = {
        handle: clean,
        displayName: defaultDisplayName(clean),
        notifyEmail: '',
        emailNotifyMode: 'mention',
        updatedAt: 0,
    }

    if (!clean) return fallback

    const bucket = communityBucket(env)
    if (!bucket) return fallback

    const keys = [
        `chat/users/${clean}.json`,
        `${clean}.json`,
    ]

    for (const key of keys) {
        try {
            const obj = await bucket.get(key)
            if (!obj) continue
            const parsed = await obj.json() as Partial<UserChatPrefs>
            const displayName = String(parsed?.displayName ?? '').trim().slice(0, 40)
            const mode: EmailNotifyMode = parsed?.emailNotifyMode === 'all' ? 'all' : 'mention'
            return {
                handle: clean,
                displayName: displayName || fallback.displayName,
                pfpKey: typeof parsed?.pfpKey === 'string' ? parsed.pfpKey : undefined,
                notifyEmail: typeof parsed?.notifyEmail === 'string' ? parsed.notifyEmail.trim().slice(0, 120) : '',
                emailNotifyMode: mode,
                updatedAt: Number(parsed?.updatedAt) || 0,
            }
        } catch {
            // try next key
        }
    }

    return fallback
}

async function saveUserChatPrefs(
    env: WorkerEnv,
    handle: string,
    displayName: string,
    pfpKey?: string,
    notifyEmail?: string,
    emailNotifyMode?: EmailNotifyMode,
): Promise<UserChatPrefs> {
    const clean = String(handle ?? '').trim()
    const current = await getUserChatPrefs(env, clean)
    const next: UserChatPrefs = {
        handle: clean,
        displayName: String(displayName ?? '').trim().slice(0, 40) || current.displayName,
        pfpKey: pfpKey ?? current.pfpKey,
        notifyEmail: notifyEmail !== undefined ? notifyEmail.trim().slice(0, 120) : (current.notifyEmail ?? ''),
        emailNotifyMode: emailNotifyMode ?? current.emailNotifyMode ?? 'mention',
        updatedAt: Date.now(),
    }

    const bucket = communityBucket(env)
    if (!bucket) {
        throw new Error('COMMUNITY_BUCKET is not configured.')
    }

    await bucket.put(
        `chat/users/${clean}.json`,
        JSON.stringify(next),
        { httpMetadata: { contentType: 'application/json' } },
    )

    return next
}

async function sendChatEmailNotifications(
    env: WorkerEnv,
    chatMessage: Pick<ChatMessage, 'handle' | 'author' | 'text'>,
): Promise<void> {
    const apiKey = env.RESEND_API_KEY
    const from = env.RESEND_FROM_EMAIL

    if (!apiKey || !from) {
        console.warn('[Email] Resend configuration is missing.')
        return
    }

    const messageText = chatMessage.text.toLowerCase()

    const recipients = await Promise.all(
        CHAT_PFP_HANDLES
            .filter((handle) => handle !== chatMessage.handle)
            .map(async (handle) => {
                const prefs = await getUserChatPrefs(env, handle)
                const email = String(prefs.notifyEmail ?? '').trim()

                if (!email || !email.includes('@')) return null

                const displayName = prefs.displayName.toLowerCase()
                const mentioned =
                    messageText.includes('@' + displayName) ||
                    messageText.includes('@' + handle)

                if (prefs.emailNotifyMode !== 'all' && !mentioned) return null

                return { email, handle, displayName: prefs.displayName }
            }),
    )

    await Promise.allSettled(
        recipients.filter((r): r is NonNullable<typeof r> => r !== null).map(async (recipient) => {
            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from,
                    to: [recipient.email],
                    subject: `New XX! Chat message from ${chatMessage.author}`,
                    text: `Hello ${recipient.displayName},\n\n${chatMessage.author} sent a message in XX! Chat:\n\n${chatMessage.text}\n\nOpen the chat: ${env.PUBLIC_ADDRESS ?? ''}/chat`,
                }),
            })

            if (!response.ok) {
                console.error('[Email] Resend failed:', await response.text())
            }
        }),
    )
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
        level?: { address: string; name: string } | null
        coverUrl?: string | null
    },
): Promise<RoomCover | undefined> {
    const type = summary.type

    if (type === 'casualRoom') {
        if (summary.coverUrl) {
            return { url: summary.coverUrl }
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

function renderStaffChatHtml(
    user: UserProfile | null,
    sessionToken: string,
    fromSonolus: boolean,
    prefsMap: Record<string, UserChatPrefs>,
    sonolusUrl: string,
    initialMessages: ChatMessage[],
    initialMedia: ChatMediaItem[],
): string {
    const cardsHtml = CHAT_PFP_HANDLES.map((handle) => {
        const pref = prefsMap[handle]
        const name = pref?.displayName || DEFAULT_CHAT_PROFILES[handle]?.name || handle
        const lockBadge = handle === PROTECTED_CHAT_HANDLE ? `<span class="pick-lock">Password</span>` : ''
        return `<button type="button" class="pick-card" data-pick-handle="${escapeAttr(handle)}">
          <img class="pick-pfp" src="/api/chat/pfp/${escapeAttr(handle)}" alt="${escapeAttr(name)}"/>
          <span class="pick-name">${escapeAttr(name)}</span>
          <span class="pick-handle">#${escapeAttr(handle)}</span>
          ${lockBadge}
        </button>`
    }).join('')

    const safeInitialMessagesJson = JSON.stringify(initialMessages).replace(/</g, '\\u003c')
    const safeInitialMediaJson = JSON.stringify(initialMedia).replace(/</g, '\\u003c')

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"/>
<meta name="theme-color" content="#9E4B76"/>
<link rel="manifest" href="/manifest.webmanifest"/>
<link rel="icon" type="image/png" href="/app-icon.png"/>
<link rel="apple-touch-icon" href="/app-icon.png"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&family=Red+Hat+Display:wght@500;600;700&display=swap" rel="stylesheet"/>
<title>XX! Chat</title>
<style>
  :root{
    --plum:#9E4B76;
    --plum-dark:#833B61;
    --plum-deep:#57233E;
    --blush:#F4DCE6;
    --blush-soft:#FBF2F6;
    --blush-border:#E8C6D6;
    --bg:#FAF7F9;
    --surface:#FFFFFF;
    --text:#2D1B25;
    --muted:#7D5D6E;
    --header-h:62px;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{
    height:100%;
    overflow:hidden;
    overscroll-behavior:none;
    background:var(--bg);
    color:var(--text);
    font-family:'Red Hat Display',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    font-size:16px;
  }
  h1,h2,.title-font,.header-title,.picker-title,.pick-name,.modal-title,.btn-primary,.tab-btn{
    font-family:'Montserrat',system-ui,-apple-system,sans-serif;
    font-weight:800;
    letter-spacing:-0.01em;
  }
  header{
    position:fixed;
    top:0;
    left:0;
    right:0;
    height:calc(var(--header-h) + env(safe-area-inset-top));
    padding:env(safe-area-inset-top) 18px 0;
    background:var(--plum);
    color:var(--blush);
    border-bottom:3px solid var(--blush);
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:12px;
    z-index:30;
    box-shadow:0 4px 16px rgba(87,35,62,.16);
  }
  .header-brand{display:flex;align-items:center;gap:11px;min-width:0}
  .app-logo{
    width:34px;
    height:34px;
    border-radius:10px;
    object-fit:cover;
    image-rendering:pixelated;
    border:2px solid var(--blush);
    background:var(--plum-deep);
    flex-shrink:0;
  }
  .header-title{
    font-size:19px;
    color:var(--blush);
    text-transform:uppercase;
    letter-spacing:.03em;
    white-space:nowrap;
  }
  .header-right{display:flex;align-items:center;gap:8px;flex-shrink:0}
  .badge{
    background:rgba(244,220,230,.18);
    color:var(--blush);
    border:1px solid rgba(244,220,230,.4);
    border-radius:999px;
    padding:4px 11px;
    font-size:13px;
    font-weight:700;
    white-space:nowrap;
  }
  .btn-header{
    background:var(--blush);
    color:var(--plum-dark);
    border:none;
    border-radius:10px;
    padding:7px 12px;
    font-family:'Montserrat',sans-serif;
    font-size:12px;
    font-weight:800;
    text-transform:uppercase;
    letter-spacing:.03em;
    cursor:pointer;
    transition:transform .12s ease,background .12s ease;
  }
  .btn-header:hover{background:#FFFFFF}
  .btn-header:active{transform:scale(.97)}
  .btn-sm{
    background:var(--blush-soft);
    color:var(--plum-dark);
    border:1px solid var(--blush-border);
    border-radius:10px;
    padding:7px 13px;
    font-family:'Montserrat',sans-serif;
    font-size:12px;
    font-weight:700;
    cursor:pointer;
    text-decoration:none;
    display:inline-flex;
    align-items:center;
    transition:all .12s ease;
  }
  .btn-sm:hover{background:var(--blush);border-color:var(--plum)}
  .btn-danger{
    background:#FFF1F4;
    color:#BE123C;
    border-color:#FECDD3;
  }
  .btn-danger:hover{background:#FFE4E9;border-color:#F43F5E}
  .btn-primary{
    background:var(--plum);
    color:var(--blush);
    border:none;
    border-radius:10px;
    padding:8px 16px;
    font-size:13px;
    cursor:pointer;
  }
  .btn-primary:hover{background:var(--plum-dark);color:#FFFFFF}
  .btn-primary:disabled{opacity:.6;cursor:not-allowed}

  #picker{
    position:fixed;
    top:calc(var(--header-h) + env(safe-area-inset-top));
    left:0;
    right:0;
    bottom:0;
    display:none;
    flex-direction:column;
    align-items:center;
    justify-content:center;
    padding:24px 16px;
    gap:22px;
    overflow-y:auto;
    background:var(--bg);
  }
  #picker.open{display:flex}
  .picker-header{
    background:var(--plum);
    color:var(--blush);
    padding:12px 24px;
    border-radius:14px;
    box-shadow:0 8px 24px rgba(158,75,118,.2);
    text-align:center;
  }
  .picker-title{
    font-size:20px;
    text-transform:uppercase;
    letter-spacing:.03em;
  }
  .picker-sub{
    display:inline-block;
    margin-top:6px;
    background:var(--blush);
    color:var(--plum-dark);
    font-size:13px;
    font-weight:700;
    padding:4px 12px;
    border-radius:8px;
  }
  .picker-grid{
    display:grid;
    grid-template-columns:repeat(auto-fit,minmax(132px,164px));
    gap:16px;
    width:100%;
    max-width:560px;
    justify-content:center;
  }
  .pick-card{
    background:var(--surface);
    border:2px solid var(--blush-border);
    border-radius:18px;
    padding:16px 14px;
    display:flex;
    flex-direction:column;
    align-items:center;
    gap:10px;
    color:var(--text);
    cursor:pointer;
    box-shadow:0 4px 14px rgba(158,75,118,.07);
    transition:transform .14s ease,border-color .14s ease,box-shadow .14s ease;
  }
  .pick-card:hover{
    border-color:var(--plum);
    transform:translateY(-2px);
    box-shadow:0 10px 22px rgba(158,75,118,.16);
  }
  .pick-pfp{
    width:78px;
    height:78px;
    aspect-ratio:1/1;
    border-radius:14px;
    object-fit:cover;
    image-rendering:pixelated;
    border:2px solid var(--blush);
    background:var(--blush-soft);
  }
  .pick-name{font-size:15px;color:var(--plum-dark);text-align:center}
  .pick-handle{
    font-size:12px;
    font-weight:700;
    color:var(--plum);
    background:var(--blush-soft);
    padding:2px 9px;
    border-radius:999px;
  }
  .pick-lock{
    font-size:11px;
    font-weight:700;
    color:#FFFFFF;
    background:var(--plum);
    padding:2px 8px;
    border-radius:999px;
  }

  #appView{
    position:fixed;
    top:calc(var(--header-h) + env(safe-area-inset-top));
    left:0;
    right:0;
    bottom:0;
    display:none;
    flex-direction:column;
    overflow:hidden;
    background:var(--bg);
  }
  #appView.open{display:flex}

  .tab-bar{
    flex:0 0 auto;
    display:flex;
    gap:8px;
    padding:8px 16px;
    background:var(--surface);
    border-bottom:1.5px solid var(--blush-border);
    align-items:center;
    justify-content:space-between;
  }
  .tab-group{display:flex;gap:8px;align-items:center}
  .tab-btn{
    background:var(--blush-soft);
    color:var(--plum-dark);
    border:1.5px solid var(--blush-border);
    border-radius:10px;
    padding:7px 16px;
    font-size:12.5px;
    text-transform:uppercase;
    letter-spacing:.03em;
    cursor:pointer;
    transition:all .12s ease;
  }
  .tab-btn.active{
    background:var(--plum);
    color:var(--blush);
    border-color:var(--plum);
  }
  .tab-plus{
    background:var(--blush-soft);
    color:var(--plum-dark);
    border:1.5px solid var(--blush-border);
    border-radius:10px;
    width:32px;
    height:32px;
    padding:0;
    display:inline-flex;
    align-items:center;
    justify-content:center;
    font-family:'Montserrat',sans-serif;
    font-size:18px;
    font-weight:800;
    line-height:1;
    cursor:pointer;
    transition:all .12s ease;
  }
  .tab-plus:hover{background:var(--blush);border-color:var(--plum);color:var(--plum)}
  .tab-plus:active{background:var(--plum);color:var(--blush);border-color:var(--plum)}

  #chatTab{
    flex:1 1 auto;
    min-height:0;
    display:none;
    flex-direction:column;
    overflow:hidden;
  }
  #chatTab.active{display:flex}

  #messages{
    flex:1 1 auto;
    min-height:0;
    overflow-y:auto;
    overflow-x:hidden;
    -webkit-overflow-scrolling:touch;
    overscroll-behavior:contain;
    padding:18px 18px 20px;
    display:flex;
    flex-direction:column;
    gap:14px;
  }
  .empty-state{
    color:var(--muted);
    font-size:15px;
    font-weight:600;
    text-align:center;
    margin:auto;
    background:var(--surface);
    border:1px dashed var(--blush-border);
    padding:16px 24px;
    border-radius:14px;
  }

  .row{
    display:flex;
    align-items:flex-start;
    gap:11px;
    max-width:min(92%,760px);
    transition:transform .14s ease;
    touch-action:pan-y;
    cursor:pointer;
    user-select:none;
    -webkit-user-select:none;
  }
  .row.me{align-self:flex-end;flex-direction:row-reverse}
  .row:not(.me){align-self:flex-start}
  .pfp{
    width:46px;
    height:46px;
    min-width:46px;
    min-height:46px;
    aspect-ratio:1/1;
    flex-shrink:0;
    border-radius:13px;
    object-fit:cover;
    image-rendering:pixelated;
    border:2px solid var(--blush-border);
    background:var(--surface);
    box-shadow:0 2px 8px rgba(158,75,118,.1);
  }
  .msg{
    background:var(--surface);
    border:1.5px solid var(--blush-border);
    border-radius:16px;
    border-top-left-radius:4px;
    padding:11px 15px;
    flex:1;
    min-width:0;
    box-shadow:0 2px 10px rgba(45,27,37,.04);
    user-select:none;
    -webkit-user-select:none;
  }
  .row.me .msg{
    background:var(--plum);
    border-color:var(--plum);
    color:#FFFFFF;
    border-top-left-radius:16px;
    border-top-right-radius:4px;
    box-shadow:0 4px 14px rgba(158,75,118,.22);
  }
  .meta{
    font-size:12px;
    font-weight:700;
    color:var(--plum);
    margin-bottom:5px;
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:10px;
    flex-wrap:wrap;
  }
  .row.me .meta{color:var(--blush)}
  .meta-actions{display:flex;align-items:center;gap:6px;margin-left:auto}
  .reply-btn{
    background:var(--blush-soft);
    color:var(--plum-dark);
    border:1px solid var(--blush-border);
    border-radius:7px;
    padding:2px 8px;
    font-size:11.5px;
    font-weight:700;
    cursor:pointer;
    font-family:inherit;
  }
  .reply-btn:hover{background:var(--blush)}
  .row.me .reply-btn{
    background:rgba(244,220,230,.18);
    color:var(--blush);
    border-color:rgba(244,220,230,.35);
  }
  .row.me .reply-btn:hover{background:rgba(244,220,230,.3)}
  .del-btn{
    background:#FFF1F4;
    color:#BE123C;
    border:1px solid #FECDD3;
    border-radius:7px;
    padding:2px 8px;
    font-size:11.5px;
    font-weight:700;
    cursor:pointer;
    font-family:inherit;
  }
  .del-btn:hover{background:#FFE4E9}
  .row.me .del-btn{
    background:rgba(255,255,255,.16);
    color:#FFE4E9;
    border-color:rgba(255,255,255,.32);
  }
  .reply-quote{
    font-size:12.5px;
    font-weight:600;
    color:var(--plum-dark);
    background:var(--blush-soft);
    border-left:3px solid var(--plum);
    padding:5px 10px;
    border-radius:8px;
    margin-bottom:7px;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
  }
  .row.me .reply-quote{
    color:var(--blush);
    background:rgba(87,35,62,.38);
    border-left-color:var(--blush);
  }
  .text{
    font-size:16px;
    font-weight:500;
    line-height:1.45;
    white-space:pre-wrap;
    word-break:break-word;
  }
  .msg-footer{margin-top:8px;display:flex;align-items:center;flex-wrap:wrap;gap:8px}
  .like-pill{
    display:inline-flex;
    align-items:center;
    gap:5px;
    background:var(--blush-soft);
    border:1px solid var(--blush-border);
    border-radius:999px;
    padding:2px 9px;
    font-size:12.5px;
    font-weight:700;
    color:var(--plum-dark);
  }
  .row.me .like-pill{
    background:rgba(244,220,230,.22);
    border-color:rgba(244,220,230,.45);
    color:var(--blush);
  }
  .like-avatars{display:inline-flex;align-items:center;gap:4px}
  .like-pfp{
    width:18px;
    height:18px;
    aspect-ratio:1/1;
    border-radius:5px;
    object-fit:cover;
    image-rendering:pixelated;
    border:1px solid rgba(158,75,118,.3);
  }

  #mediaTab{
    flex:1 1 auto;
    min-height:0;
    width:100%;
    display:none;
    flex-direction:column;
    overflow-y:auto;
    -webkit-overflow-scrolling:touch;
    overscroll-behavior:contain;
    padding:0 0 32px;
    gap:16px;
  }
  #mediaTab.active{display:flex}
  .media-feed{
    display:flex;
    flex-direction:column;
    gap:16px;
    width:100%;
  }
  .media-card{
    background:var(--surface);
    border-top:1.5px solid var(--blush-border);
    border-bottom:1.5px solid var(--blush-border);
    width:100%;
  }
  .media-card img{
    width:100%;
    height:auto;
    display:block;
  }
  .media-meta{
    padding:10px 14px;
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:10px;
    flex-wrap:wrap;
  }
  .media-link{
    color:var(--plum-dark);
    font-size:13.5px;
    font-weight:700;
    text-decoration:none;
    word-break:break-all;
  }
  .media-link:hover{text-decoration:underline;color:var(--plum)}
  .media-caption{
    font-size:14px;
    font-weight:600;
    color:var(--text);
  }

  .bottom-bar{
    flex:0 0 auto;
    position:relative;
    z-index:25;
    background:var(--surface);
    border-top:2px solid var(--blush);
    padding:10px 16px calc(12px + env(safe-area-inset-bottom));
    display:flex;
    flex-direction:column;
    gap:9px;
    box-shadow:0 -4px 18px rgba(158,75,118,.08);
  }
  .reply-banner{
    display:none;
    align-items:center;
    justify-content:space-between;
    gap:10px;
    background:var(--blush);
    border:1px solid var(--blush-border);
    border-radius:10px;
    padding:7px 12px;
    font-size:13.5px;
    font-weight:700;
    color:var(--plum-dark);
  }
  .reply-banner.open{display:flex}
  .shortcuts{display:flex;gap:7px;flex-wrap:wrap}
  .chip{
    background:var(--blush-soft);
    color:var(--plum-dark);
    border:1px solid var(--blush-border);
    border-radius:999px;
    padding:5px 13px;
    font-size:13.5px;
    font-weight:700;
    cursor:pointer;
    font-family:inherit;
    transition:all .12s ease;
  }
  .chip:hover{background:var(--blush);border-color:var(--plum)}
  .chip:active{background:var(--plum);color:var(--blush);border-color:var(--plum)}
  form{display:flex;gap:9px;align-items:center}
  input[type=text],input[type=email],input[type=password],input[type=url],select{
    flex:1;
    min-width:0;
    background:var(--bg);
    color:var(--text);
    border:1.5px solid var(--blush-border);
    border-radius:12px;
    padding:11px 14px;
    font-size:15.5px;
    font-weight:500;
    outline:none;
    font-family:inherit;
    transition:border-color .14s ease,background .14s ease;
  }
  input[type=text]::placeholder,input[type=email]::placeholder,input[type=password]::placeholder,input[type=url]::placeholder{color:var(--muted)}
  input[type=text]:focus,input[type=email]:focus,input[type=password]:focus,input[type=url]:focus,select:focus{border-color:var(--plum);background:var(--surface)}
  button[type=submit]{
    background:var(--plum);
    color:var(--blush);
    border:none;
    border-radius:12px;
    padding:0 20px;
    height:44px;
    font-family:'Montserrat',sans-serif;
    font-weight:800;
    font-size:14px;
    text-transform:uppercase;
    letter-spacing:.03em;
    cursor:pointer;
    flex-shrink:0;
    transition:background .12s ease,transform .1s ease;
  }
  button[type=submit]:hover{background:var(--plum-dark);color:#FFFFFF}
  button[type=submit]:active{transform:scale(.98)}

  .modal-backdrop{
    display:none;
    position:fixed;
    inset:0;
    background:rgba(45,27,37,.55);
    backdrop-filter:blur(3px);
    align-items:center;
    justify-content:center;
    padding:16px;
    z-index:40;
    overflow-y:auto;
  }
  .modal-backdrop.open{display:flex}
  .modal-card{
    width:min(100%,460px);
    max-height:90dvh;
    background:var(--surface);
    border:2px solid var(--blush);
    border-radius:20px;
    overflow-y:auto;
    box-shadow:0 18px 40px rgba(87,35,62,.24);
    display:flex;
    flex-direction:column;
  }
  .modal-header{
    background:var(--plum);
    color:var(--blush);
    padding:15px 20px;
    border-bottom:3px solid var(--blush);
  }
  .modal-title{font-size:17px;text-transform:uppercase;letter-spacing:.03em}
  .modal-body{padding:18px 20px 20px;display:flex;flex-direction:column;gap:14px}
  .field-label{font-size:13px;font-weight:700;color:var(--plum-dark);margin-bottom:6px;display:block}
  .mode-row{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:8px;
    margin-bottom:8px;
  }
  .mode-btn{
    background:var(--blush-soft);
    color:var(--plum-dark);
    border:1.5px solid var(--blush-border);
    border-radius:10px;
    padding:8px 10px;
    font-family:'Montserrat',sans-serif;
    font-size:12px;
    font-weight:700;
    cursor:pointer;
  }
  .mode-btn.active{
    background:var(--plum);
    color:var(--blush);
    border-color:var(--plum);
  }
  .sonolus-box{
    background:var(--blush-soft);
    border:1px solid var(--blush-border);
    border-radius:12px;
    padding:11px 13px;
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:10px;
  }
  .sonolus-label{font-size:13px;font-weight:700;color:var(--plum-dark)}
  .sonolus-sub{font-size:12px;color:var(--muted)}
  .auth-error{font-size:13px;font-weight:700;color:#BE123C;min-height:18px}
  .save-status{font-size:13px;font-weight:700;color:var(--plum-dark);min-height:18px}
  input[type=file]{font-size:13.5px;color:var(--muted);font-family:inherit}
  input[type=range]{width:100%;accent-color:var(--plum)}
  .crop-box{
    position:relative;
    width:208px;
    height:208px;
    margin:8px auto;
    border-radius:14px;
    overflow:hidden;
    border:2px solid var(--plum);
    background:var(--blush-soft);
    touch-action:none;
    cursor:grab;
  }
  .crop-box img{position:absolute;top:0;left:0;transform-origin:top left;user-select:none;-webkit-user-drag:none}
  .modal-actions{
    display:flex;
    justify-content:space-between;
    align-items:center;
    gap:10px;
    margin-top:4px;
    padding-top:12px;
    border-top:1px solid var(--blush-border);
    flex-wrap:wrap;
  }
  .modal-actions-right{display:flex;gap:8px;margin-left:auto}
</style>
</head>
<body>
  <header>
    <div class="header-brand">
      <img class="app-logo" src="/app-icon.png" alt="XX!"/>
      <span class="header-title">XX! Chat</span>
    </div>
    <div class="header-right">
      <span id="userBadge" class="badge"></span>
      <button id="settingsBtn" type="button" class="btn-header" style="display:none">Settings</button>
    </div>
  </header>
  <div id="picker">
    <div class="picker-header">
      <div class="picker-title">Welcome to XX! Chat</div>
      <div class="picker-sub">Select your staff profile</div>
    </div>
    <div class="picker-grid">${cardsHtml}</div>
  </div>
  <div id="appView">
    <div class="tab-bar">
      <div class="tab-group">
        <button id="tabChatBtn" type="button" class="tab-btn active">Chat</button>
        <button id="tabMediaBtn" type="button" class="tab-btn">Media</button>
        <button id="addMediaBtn" type="button" class="tab-plus" style="display:none" title="Add Media" aria-label="Add Media">+</button>
      </div>
    </div>
    <div id="chatTab" class="active">
      <div id="messages"></div>
      <footer class="bottom-bar">
        <div id="replyBanner" class="reply-banner">
          <span id="replyText"></span>
          <button id="cancelReplyBtn" type="button" class="btn-sm">Cancel</button>
        </div>
        <div id="shortcutsBar" class="shortcuts"></div>
        <form id="chatForm">
          <input id="chatInput" type="text" maxlength="500" placeholder="Send a message..." autocomplete="off"/>
          <button type="submit">Send</button>
        </form>
      </footer>
    </div>
    <div id="mediaTab">
      <div id="mediaFeed" class="media-feed"></div>
    </div>
  </div>
  <div id="mediaUploadModal" class="modal-backdrop">
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-title">Upload Media (#163292)</div>
      </div>
      <div class="modal-body">
        <div>
          <label class="field-label" for="mediaFileInput">Image (keeps original aspect ratio)</label>
          <input id="mediaFileInput" type="file" accept="image/png,image/jpeg,image/webp"/>
        </div>
        <div>
          <label class="field-label" for="mediaLinkInput">Optional Link</label>
          <input id="mediaLinkInput" type="url" maxlength="400" placeholder="https://..."/>
        </div>
        <div>
          <label class="field-label" for="mediaCaptionInput">Optional Caption</label>
          <input id="mediaCaptionInput" type="text" maxlength="160" placeholder="Caption"/>
        </div>
        <div id="mediaStatus" class="auth-error"></div>
        <div class="modal-actions">
          <div class="modal-actions-right">
            <button id="closeMediaModalBtn" type="button" class="btn-sm">Cancel</button>
            <button id="uploadMediaBtn" type="button" class="btn-primary">Upload</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div id="passwordModal" class="modal-backdrop">
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-title">AXX!A Profile Password</div>
      </div>
      <div class="modal-body">
        <div>
          <label class="field-label" for="profilePasswordInput">Enter password for AXX!A (#163292)</label>
          <input id="profilePasswordInput" type="password" placeholder="Password" autocomplete="current-password"/>
          <div id="passwordError" class="auth-error"></div>
        </div>
        <div class="modal-actions">
          <div class="modal-actions-right">
            <button id="cancelPasswordBtn" type="button" class="btn-sm">Cancel</button>
            <button id="submitPasswordBtn" type="button" class="btn-primary">Unlock</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div id="settingsModal" class="modal-backdrop">
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-title">Chat Settings</div>
      </div>
      <div class="modal-body">
        <div>
          <label class="field-label" for="displayNameInput">Display Name</label>
          <input id="displayNameInput" type="text" maxlength="40" placeholder="Your display name"/>
        </div>
        <div>
          <label class="field-label" for="notifyEmailInput">Email Notifications</label>
          <div class="mode-row">
            <button id="modeMentionBtn" type="button" class="mode-btn">Mentions only</button>
            <button id="modeAllBtn" type="button" class="mode-btn">All messages</button>
          </div>
          <input id="notifyEmailInput" type="email" maxlength="120" placeholder="you@example.com"/>
        </div>
        <div class="sonolus-box">
    <div>
        <div class="sonolus-label">XX! Web Chat</div>
        <div class="sonolus-sub">Open the chat in your browser</div>
    </div>
    <a id="openSonolusBtn" class="btn-sm" href="${escapeAttr(sonolusUrl)}" target="_blank" rel="noopener noreferrer">Open Chat</a>
</div>
        <div>
          <label class="field-label" for="pfpFileInput">Square 1:1 Profile Picture</label>
          <input id="pfpFileInput" type="file" accept="image/png,image/jpeg,image/webp"/>
          <div id="cropWrap" style="display:none;margin-top:10px">
            <div id="cropBox" class="crop-box">
              <img id="cropImg" alt="Crop preview"/>
            </div>
            <label class="field-label" for="zoomRange">Zoom</label>
            <input id="zoomRange" type="range" min="1" max="3" step="0.02" value="1"/>
          </div>
        </div>
        <div id="settingsStatus" class="save-status"></div>
        <div class="modal-actions">
          <button id="logoutBtn" type="button" class="btn-sm btn-danger">Log out</button>
          <div class="modal-actions-right">
            <button id="closeSettingsBtn" type="button" class="btn-sm">Close</button>
            <button id="saveSettingsBtn" type="button" class="btn-primary">Save</button>
          </div>
        </div>
      </div>
    </div>
  </div>
<script>
  const STORAGE_KEY = 'xx_chat_handle';
  const UNLOCK_KEY = 'xx_chat_unlocked_163292';
  const PROTECTED_HANDLE = ${JSON.stringify(PROTECTED_CHAT_HANDLE)};
  const MEDIA_ADMIN = ${JSON.stringify(MEDIA_ADMIN_HANDLE)};
  const COOKIE_NAME = ${JSON.stringify(CHAT_HANDLE_COOKIE)};
  const HOST_HANDLE = ${JSON.stringify(TOURNAMENT_HOST_HANDLE)};
  const knownHandles = ${JSON.stringify([...CHAT_PFP_HANDLES])};
  const tzMap = ${JSON.stringify(HANDLE_TIMEZONES)};
  const sonolusUser = ${JSON.stringify(fromSonolus && user ? user : null)};
  const sessionToken = ${JSON.stringify(fromSonolus ? sessionToken : '')};
  const prefsMap = ${JSON.stringify(prefsMap)};
  const defaultsMap = ${JSON.stringify(DEFAULT_CHAT_PROFILES)};
  const initialMessages = ${safeInitialMessagesJson};
  const initialMedia = ${safeInitialMediaJson};

  const pickerEl = document.getElementById('picker');
  const appViewEl = document.getElementById('appView');
  const tabChatBtn = document.getElementById('tabChatBtn');
  const tabMediaBtn = document.getElementById('tabMediaBtn');
  const addMediaBtn = document.getElementById('addMediaBtn');
  const chatTabEl = document.getElementById('chatTab');
  const mediaTabEl = document.getElementById('mediaTab');
  const mediaUploadModal = document.getElementById('mediaUploadModal');
  const closeMediaModalBtn = document.getElementById('closeMediaModalBtn');
  const mediaFileInput = document.getElementById('mediaFileInput');
  const mediaLinkInput = document.getElementById('mediaLinkInput');
  const mediaCaptionInput = document.getElementById('mediaCaptionInput');
  const mediaStatusEl = document.getElementById('mediaStatus');
  const uploadMediaBtn = document.getElementById('uploadMediaBtn');
  const mediaFeedEl = document.getElementById('mediaFeed');

  const badgeEl = document.getElementById('userBadge');
  const settingsBtn = document.getElementById('settingsBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const settingsStatusEl = document.getElementById('settingsStatus');
  const box = document.getElementById('messages');
  const shortcutsBar = document.getElementById('shortcutsBar');
  const input = document.getElementById('chatInput');
  const replyBanner = document.getElementById('replyBanner');
  const replyTextEl = document.getElementById('replyText');
  const cancelReplyBtn = document.getElementById('cancelReplyBtn');

  const passwordModal = document.getElementById('passwordModal');
  const profilePasswordInput = document.getElementById('profilePasswordInput');
  const passwordError = document.getElementById('passwordError');

  const settingsModal = document.getElementById('settingsModal');
  const displayNameInput = document.getElementById('displayNameInput');
  const modeMentionBtn = document.getElementById('modeMentionBtn');
  const modeAllBtn = document.getElementById('modeAllBtn');
  const notifyEmailInput = document.getElementById('notifyEmailInput');
  const pfpFileInput = document.getElementById('pfpFileInput');
  const cropWrap = document.getElementById('cropWrap');
  const cropBox = document.getElementById('cropBox');
  const cropImg = document.getElementById('cropImg');
  const zoomRange = document.getElementById('zoomRange');

  let activeTab = 'chat';
  let loggedOut = false;
  let pendingPasswordHandle = '';
  let selectedNotifyMode = 'mention';
  let activeReply = null;
  let currentMessages = Array.isArray(initialMessages) ? [...initialMessages] : [];
  let currentMedia = Array.isArray(initialMedia) ? [...initialMedia] : [];
  let socket = null;
  let reconnectTimer = null;
  let cropState = { loaded: false, imgW: 0, imgH: 0, scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

  function syncViewportHeight() {
    const vv = window.visualViewport;
    if (!vv) return;
    appViewEl.style.height = Math.max(240, vv.height - headerHeightPx()) + 'px';
  }

  function headerHeightPx() {
    const h = document.querySelector('header');
    return h ? h.getBoundingClientRect().height : 62;
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      syncViewportHeight();
      box.scrollTop = box.scrollHeight;
    });
  }

  function isProtectedUnlocked() {
    try {
      return sessionStorage.getItem(UNLOCK_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setProtectedUnlocked(val) {
    try {
      if (val) sessionStorage.setItem(UNLOCK_KEY, '1');
      else sessionStorage.removeItem(UNLOCK_KEY);
    } catch {}
  }

  function readSavedHandle() {
    try {
      const ls = (localStorage.getItem(STORAGE_KEY) || '').trim();
      if (ls && defaultsMap[ls]) return ls;
    } catch {}
    const parts = document.cookie.split(';');
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq === -1) continue;
      if (p.slice(0, eq).trim() === COOKIE_NAME) {
        const val = decodeURIComponent(p.slice(eq + 1).trim());
        if (val && defaultsMap[val]) return val;
      }
    }
    return '';
  }

  function persistHandle(handle) {
    try {
      if (handle) localStorage.setItem(STORAGE_KEY, handle);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {}
    if (handle) {
      document.cookie = COOKIE_NAME + '=' + encodeURIComponent(handle) + ';path=/;max-age=31536000;SameSite=Lax';
    } else {
      document.cookie = COOKIE_NAME + '=;path=/;max-age=0;SameSite=Lax';
    }
  }

  function pfpUrlFor(handle) {
    const h = String(handle || '').trim();
    const ver = prefsMap[h]?.updatedAt || 0;
    return '/api/chat/pfp/' + encodeURIComponent(h) + (ver ? '?v=' + ver : '');
  }

  function displayNameFor(handle, fallback) {
    const h = String(handle || '').trim();
    return (prefsMap[h]?.displayName || fallback || defaultsMap[h]?.name || h).trim();
  }

  function formatAuthorTime(msg) {
    const h = String(msg.handle || '').trim();
    const zone = tzMap[h] || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try {
      return new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: zone });
    } catch {
      return new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  }

  function getActiveUser() {
    if (loggedOut) return null;
    if (sonolusUser && sonolusUser.handle) {
      if (sonolusUser.handle === PROTECTED_HANDLE && !isProtectedUnlocked()) {
        return null;
      }
      return { ...sonolusUser, name: displayNameFor(sonolusUser.handle, sonolusUser.name) };
    }
    const saved = readSavedHandle();
    if (saved && defaultsMap[saved]) {
      if (saved === PROTECTED_HANDLE && !isProtectedUnlocked()) {
        return null;
      }
      return {
        id: saved,
        handle: saved,
        name: displayNameFor(saved, defaultsMap[saved].name),
      };
    }
    return null;
  }

  function authHeaders(extra = {}) {
    const headers = { ...extra };
    if (sessionToken && !loggedOut) {
      headers['Sonolus-Session'] = sessionToken;
    } else {
      const active = getActiveUser();
      if (active) headers['X-Chat-Handle'] = active.handle;
    }
    return headers;
  }

  function insertTextAtCursor(snippet) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const needSpace = before && !before.endsWith(' ') ? ' ' : '';
    const insertion = needSpace + snippet + ' ';
    input.value = before + insertion + after;
    const nextPos = (before + insertion).length;
    input.focus();
    input.setSelectionRange(nextPos, nextPos);
  }

  function renderKnownUserChips() {
    const active = getActiveUser();
    const myHandle = active ? active.handle : '';
    const others = knownHandles.filter((h) => h !== myHandle);
    shortcutsBar.innerHTML = others.map((h) => {
      const label = '@' + displayNameFor(h, defaultsMap[h]?.name || h);
      return '<button type="button" class="chip" data-mention-handle="' + escapeAttr(h) + '">' + escapeHtml(label) + '</button>';
    }).join('');
    shortcutsBar.querySelectorAll('[data-mention-handle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const h = btn.getAttribute('data-mention-handle') || '';
        const mention = '@' + displayNameFor(h, defaultsMap[h]?.name || h);
        if (mention.length > 1) insertTextAtCursor(mention);
      });
    });
  }

  function setReplyTarget(msg) {
    activeReply = msg ? {
      id: msg.id,
      author: displayNameFor(msg.handle, msg.author),
      handle: msg.handle,
      text: msg.text,
    } : null;
    if (activeReply) {
      replyTextEl.textContent = 'Replying to ' + formatTag(activeReply.author, activeReply.handle) + ': ' + activeReply.text;
      replyBanner.classList.add('open');
      insertTextAtCursor('@' + activeReply.author);
    } else {
      replyTextEl.textContent = '';
      replyBanner.classList.remove('open');
    }
  }

  cancelReplyBtn.addEventListener('click', () => setReplyTarget(null));

  function escapeHtml(str) {
    return String(str).replace(/[<>&"]/g, (ch) => ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
    }[ch] ?? ch));
  }

  function formatTag(author, handle) {
    const h = String(handle || '').trim();
    const a = displayNameFor(h, author);
    return h ? a + '#' + h : a;
  }

  function openMediaUploadModal() {
    const active = getActiveUser()

    if (!active || active.handle !== MEDIA_ADMIN) {
        mediaStatusEl.textContent = 'Only #163292 can upload media.'
        return
    }

    mediaStatusEl.textContent = ''
    setActiveTab('media')
    mediaUploadModal.classList.add('open')

    requestAnimationFrame(() => {
        mediaFileInput.focus()
    })
}

  function setActiveTab(tab) {
    activeTab = tab === 'media' ? 'media' : 'chat';
    tabChatBtn.classList.toggle('active', activeTab === 'chat');
    tabMediaBtn.classList.toggle('active', activeTab === 'media');
    chatTabEl.classList.toggle('active', activeTab === 'chat');
    mediaTabEl.classList.toggle('active', activeTab === 'media');
    if (activeTab === 'chat') {
      box.scrollTop = box.scrollHeight;
    } else {
      renderMedia(currentMedia);
      void refreshMediaList();
    }
  }

  tabChatBtn.addEventListener('click', () => setActiveTab('chat'));
  tabMediaBtn.addEventListener('click', () => setActiveTab('media'));

  addMediaBtn.onclick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    openMediaUploadModal()
};

  closeMediaModalBtn.addEventListener('click', () => {
    mediaUploadModal.classList.remove('open');
  });

  function renderMedia(items) {
    if (Array.isArray(items)) {
      currentMedia = items;
    }
    const active = getActiveUser();
    const canDelete = active && active.handle === MEDIA_ADMIN;

    if (!currentMedia.length) {
      mediaFeedEl.innerHTML = '<div class="empty-state">No media uploaded yet.</div>';
      return;
    }

    mediaFeedEl.innerHTML = currentMedia.map((item) => {
      const imgSrc = '/api/chat/media/' + encodeURIComponent(item.id) + '?v=' + encodeURIComponent(String(item.createdAt || 0));
      const safeLink = item.link && /^https?:\/\//i.test(item.link) ? item.link : '';
      const linkHtml = safeLink
        ? '<a class="media-link" href="' + escapeAttr(safeLink) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(safeLink) + '</a>'
        : '';
      const captionHtml = item.caption
        ? '<div class="media-caption">' + escapeHtml(item.caption) + '</div>'
        : '';
      const delHtml = canDelete
        ? '<button type="button" class="del-btn" data-delete-media="' + escapeAttr(item.id) + '">Delete</button>'
        : '';

      return '<article class="media-card">' +
        '<img src="' + escapeHtml(imgSrc) + '" alt="' + escapeAttr(item.caption || 'Media') + '"/>' +
        '<div class="media-meta">' +
          '<div style="display:flex;flex-direction:column;gap:4px;min-width:0">' + captionHtml + linkHtml + '</div>' +
          delHtml +
        '</div>' +
      '</article>';
    }).join('');
  }

  async function refreshMediaList() {
    const active = getActiveUser();
    if (!active) return;
    const res = await fetch('/api/chat/media', {
      headers: authHeaders(),
      credentials: 'same-origin',
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.items)) renderMedia(data.items);
    }
  }

  async function fileToDataUrl(file) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Failed to read image'));
      reader.readAsDataURL(file);
    });
  }

  uploadMediaBtn.addEventListener('click', async () => {
    const active = getActiveUser();
    if (!active || active.handle !== MEDIA_ADMIN) {
      mediaStatusEl.textContent = 'Only #163292 can upload media.';
      return;
    }
    const file = mediaFileInput.files && mediaFileInput.files[0];
    if (!file) {
      mediaStatusEl.textContent = 'Select an image first.';
      return;
    }
    mediaStatusEl.textContent = 'Uploading...';
    uploadMediaBtn.disabled = true;
    try {
      const imageDataUrl = await fileToDataUrl(file);
      const res = await fetch('/api/chat/media', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'same-origin',
        body: JSON.stringify({
          handle: active.handle,
          imageDataUrl,
          link: mediaLinkInput.value.trim(),
          caption: mediaCaptionInput.value.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        mediaStatusEl.textContent = data.message || 'Upload failed.';
        return;
      }
      mediaFileInput.value = '';
      mediaLinkInput.value = '';
      mediaCaptionInput.value = '';
      mediaStatusEl.textContent = '';
      mediaUploadModal.classList.remove('open');
      setActiveTab('media');
      if (Array.isArray(data.items)) renderMedia(data.items);
    } finally {
      uploadMediaBtn.disabled = false;
    }
  });

  mediaFeedEl.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-delete-media]');
    if (!delBtn) return;
    const active = getActiveUser();
    if (!active || active.handle !== MEDIA_ADMIN) return;
    const id = delBtn.getAttribute('data-delete-media') || '';
    if (!id) return;
    const res = await fetch('/api/chat/media?id=' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: authHeaders(),
      credentials: 'same-origin',
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.items)) renderMedia(data.items);
    }
  });

  function render(messages, force = false) {
    const shouldStickBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90 || force;
    if (Array.isArray(messages)) {
      currentMessages = messages;
    }
    const active = getActiveUser();
    const myHandle = active ? active.handle : '';

    if (currentMessages.length === 0) {
      box.innerHTML = '<div class="empty-state">No messages yet. Say hello!</div>';
      return;
    }

    box.innerHTML = currentMessages.map((m) => {
      const time = formatAuthorTime(m);
      const mine = m.handle === myHandle ? 'me' : '';
      const canDelete = myHandle && (m.handle === myHandle || myHandle === HOST_HANDLE);
      const pfpImg = '<img class="pfp" src="' + escapeHtml(pfpUrlFor(m.handle)) + '" alt=""/>';
      const replyHtml = m.replyTo
        ? '<div class="reply-quote">Replying to ' + escapeHtml(m.replyTo.text || '') + '</div>'
        : '';
      const delHtml = canDelete
        ? '<button type="button" class="del-btn" data-delete-id="' + escapeHtml(m.id) + '">Delete</button>'
        : '';

      const likers = Array.isArray(m.likes) ? m.likes : [];
      const avatarsHtml = likers.map((h) =>
        '<img class="like-pfp" src="' + escapeHtml(pfpUrlFor(h)) + '" alt=""/>'
      ).join('');
      const likeBadgeHtml = likers.length > 0
        ? '<span class="like-pill">♥ <span class="like-avatars">' + avatarsHtml + '</span> ' + likers.length + '</span>'
        : '';

      return '<div class="row ' + mine + '" data-row-id="' + escapeHtml(m.id) + '">' +
        pfpImg +
        '<div class="msg" data-msg-id="' + escapeHtml(m.id) + '">' +
          '<div class="meta"><span>' + escapeHtml(time) + '</span>' +
          '<span class="meta-actions">' +
            '<button type="button" class="reply-btn" data-reply-id="' + escapeHtml(m.id) + '">Reply</button>' +
            delHtml +
          '</span></div>' +
          replyHtml +
          '<div class="text">' + escapeHtml(m.text) + '</div>' +
          (likeBadgeHtml ? '<div class="msg-footer">' + likeBadgeHtml + '</div>' : '') +
        '</div>' +
      '</div>';
    }).join('');

    if (shouldStickBottom) {
      box.scrollTop = box.scrollHeight;
    }
  }

  function disconnectSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      try { socket.close(1000, 'Switching profile'); } catch {}
      socket = null;
    }
  }

  function connectSocket() {
    disconnectSocket();
    const active = getActiveUser();
    if (!active) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams({ handle: active.handle });
    if (sessionToken && !loggedOut) qs.set('session', sessionToken);
    const ws = new WebSocket(proto + '//' + location.host + '/ws/chat?' + qs.toString());
    socket = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data || '{}'));
        if (data.type === 'chat' && Array.isArray(data.messages)) {
          render(data.messages);
        }
      } catch {}
    };

    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (getActiveUser()) {
        reconnectTimer = setTimeout(() => connectSocket(), 1500);
      }
    };
  }

  function syncMode() {
    const active = getActiveUser();
    if (!active) {
      disconnectSocket();
      badgeEl.textContent = 'Select profile';
      addMediaBtn.style.display = 'none';
      settingsBtn.style.display = 'none';
      pickerEl.classList.add('open');
      appViewEl.classList.remove('open');
      const saved = readSavedHandle();
      if (!loggedOut && saved === PROTECTED_HANDLE && !isProtectedUnlocked()) {
        openPasswordPrompt(PROTECTED_HANDLE);
      }
      return;
    }

    badgeEl.textContent = formatTag(active.name, active.handle);
    addMediaBtn.style.display = active.handle === MEDIA_ADMIN ? 'inline-flex' : 'none';
    settingsBtn.style.display = 'inline-block';
    pickerEl.classList.remove('open');
    appViewEl.classList.add('open');
    setActiveTab(activeTab);
    syncViewportHeight();
    renderKnownUserChips();
    render(currentMessages, true);
    renderMedia(currentMedia);
    connectSocket();
  }

  function openPasswordPrompt(handle) {
    pendingPasswordHandle = handle;
    profilePasswordInput.value = '';
    passwordError.textContent = '';
    passwordModal.classList.add('open');
    setTimeout(() => profilePasswordInput.focus(), 20);
  }

  async function verifyProfilePassword() {
    const pw = profilePasswordInput.value;
    if (!pw) {
      passwordError.textContent = 'Please enter the password.';
      return;
    }
    const res = await fetch('/api/chat/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ handle: pendingPasswordHandle || PROTECTED_HANDLE, password: pw }),
    });
    if (!res.ok) {
      passwordError.textContent = 'Incorrect password.';
      return;
    }
    setProtectedUnlocked(true);
    loggedOut = false;
    persistHandle(pendingPasswordHandle || PROTECTED_HANDLE);
    pendingPasswordHandle = '';
    passwordModal.classList.remove('open');
    syncMode();
  }

  document.getElementById('cancelPasswordBtn').addEventListener('click', () => {
    pendingPasswordHandle = '';
    passwordModal.classList.remove('open');
  });
  document.getElementById('submitPasswordBtn').addEventListener('click', () => {
    void verifyProfilePassword();
  });
  profilePasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void verifyProfilePassword();
    } else if (e.key === 'Escape') {
      pendingPasswordHandle = '';
      passwordModal.classList.remove('open');
    }
  });

  logoutBtn.addEventListener('click', () => {
    loggedOut = true;
    setProtectedUnlocked(false);
    persistHandle('');
    setReplyTarget(null);
    settingsModal.classList.remove('open');
    syncMode();
  });

  async function toggleLikeMessage(id) {
    const active = getActiveUser();
    if (!active || !id) return;
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'same-origin',
      body: JSON.stringify({ action: 'like', id, handle: active.handle }),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.messages)) render(data.messages, true);
    }
  }

  function updateCropTransform() {
    if (!cropState.loaded) return;
    const boxSize = 208;
    const baseScale = Math.max(boxSize / cropState.imgW, boxSize / cropState.imgH);
    const totalScale = baseScale * cropState.scale;
    const scaledW = cropState.imgW * totalScale;
    const scaledH = cropState.imgH * totalScale;
    cropState.x = Math.min(0, Math.max(boxSize - scaledW, cropState.x));
    cropState.y = Math.min(0, Math.max(boxSize - scaledH, cropState.y));
    cropImg.style.width = scaledW + 'px';
    cropImg.style.height = scaledH + 'px';
    cropImg.style.transform = 'translate(' + cropState.x + 'px, ' + cropState.y + 'px)';
  }

  pfpFileInput.addEventListener('change', () => {
    const file = pfpFileInput.files && pfpFileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      cropImg.onload = () => {
        cropState = {
          loaded: true,
          imgW: cropImg.naturalWidth || 208,
          imgH: cropImg.naturalHeight || 208,
          scale: Number(zoomRange.value) || 1,
          x: 0,
          y: 0,
          dragging: false,
          lastX: 0,
          lastY: 0,
        };
        cropWrap.style.display = 'block';
        updateCropTransform();
      };
      cropImg.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });

  zoomRange.addEventListener('input', () => {
    cropState.scale = Number(zoomRange.value) || 1;
    updateCropTransform();
  });

  cropBox.addEventListener('pointerdown', (e) => {
    if (!cropState.loaded) return;
    cropState.dragging = true;
    cropState.lastX = e.clientX;
    cropState.lastY = e.clientY;
    cropBox.setPointerCapture(e.pointerId);
  });

  cropBox.addEventListener('pointermove', (e) => {
    if (!cropState.dragging) return;
    cropState.x += e.clientX - cropState.lastX;
    cropState.y += e.clientY - cropState.lastY;
    cropState.lastX = e.clientX;
    cropState.lastY = e.clientY;
    updateCropTransform();
  });

  cropBox.addEventListener('pointerup', () => {
    cropState.dragging = false;
  });

  async function buildCroppedSquareDataUrl() {
    if (!cropState.loaded) return null;
    const outSize = 512;
    const boxSize = 208;
    const baseScale = Math.max(boxSize / cropState.imgW, boxSize / cropState.imgH);
    const totalScale = baseScale * cropState.scale;
    const sx = Math.max(0, (-cropState.x) / totalScale);
    const sy = Math.max(0, (-cropState.y) / totalScale);
    const sSize = Math.min(cropState.imgW, cropState.imgH, boxSize / totalScale);
    const canvas = document.createElement('canvas');
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(cropImg, sx, sy, sSize, sSize, 0, 0, outSize, outSize);
    return canvas.toDataURL('image/png');
  }

  function applyNotifyModeUi(mode) {
    selectedNotifyMode = mode === 'all' ? 'all' : 'mention';
    modeMentionBtn.classList.toggle('active', selectedNotifyMode === 'mention');
    modeAllBtn.classList.toggle('active', selectedNotifyMode === 'all');
  }

  modeMentionBtn.addEventListener('click', () => applyNotifyModeUi('mention'));
  modeAllBtn.addEventListener('click', () => applyNotifyModeUi('all'));

  settingsBtn.addEventListener('click', () => {
    const active = getActiveUser();
    if (!active) return;
    const p = prefsMap[active.handle] || {};
    displayNameInput.value = p.displayName || active.name;
    notifyEmailInput.value = p.notifyEmail || '';
    settingsStatusEl.textContent = '';
    applyNotifyModeUi(p.emailNotifyMode === 'all' ? 'all' : 'mention');
    pfpFileInput.value = '';
    zoomRange.value = '1';
    cropWrap.style.display = 'none';
    cropState.loaded = false;
    settingsModal.classList.add('open');
  });

  document.getElementById('closeSettingsBtn').addEventListener('click', () => {
    settingsModal.classList.remove('open');
  });

  saveSettingsBtn.addEventListener('click', async () => {
    const active = getActiveUser();
    if (!active) {
      settingsStatusEl.textContent = 'Session expired. Re-select profile.';
      return;
    }
    settingsStatusEl.textContent = 'Saving...';
    saveSettingsBtn.disabled = true;
    try {
      const displayName = displayNameInput.value.trim() || active.name;
      const notifyEmail = notifyEmailInput.value.trim();
      const croppedPng = await buildCroppedSquareDataUrl();
      const res = await fetch('/api/chat/settings', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'same-origin',
        body: JSON.stringify({
          handle: active.handle,
          displayName,
          notifyEmail,
          emailNotifyMode: selectedNotifyMode,
          pfpDataUrl: croppedPng,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        settingsStatusEl.textContent = data.message || ('Save failed (' + res.status + ')');
        return;
      }
      if (data.prefs) {
        prefsMap[active.handle] = data.prefs;
      }
      settingsStatusEl.textContent = 'Saved.';
      settingsModal.classList.remove('open');
      syncMode();
    } catch (err) {
      settingsStatusEl.textContent = err && err.message ? err.message : 'Network error saving settings.';
    } finally {
      saveSettingsBtn.disabled = false;
    }
  });

  document.querySelectorAll('[data-pick-handle]').forEach((card) => {
    card.addEventListener('click', () => {
      const picked = card.getAttribute('data-pick-handle') || '';
      if (!defaultsMap[picked]) return;
      if (picked === PROTECTED_HANDLE && !isProtectedUnlocked()) {
        openPasswordPrompt(picked);
        return;
      }
      loggedOut = false;
      persistHandle(picked);
      syncMode();
    });
  });

  let swipeRow = null;
  let swipeStartX = 0;
  let swipeDeltaX = 0;
  let lastTapId = '';
  let lastTapAt = 0;
  let suppressNextClickId = '';

  box.addEventListener('touchstart', (e) => {
    const row = e.target.closest('[data-row-id]');
    if (!row || e.touches.length !== 1) return;
    swipeRow = row;
    swipeStartX = e.touches[0].clientX;
    swipeDeltaX = 0;
  }, { passive: true });

  box.addEventListener('touchmove', (e) => {
    if (!swipeRow || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - swipeStartX;
    if (dx > 0) {
      swipeDeltaX = Math.min(72, dx);
      swipeRow.style.transform = 'translateX(' + swipeDeltaX + 'px)';
    }
  }, { passive: true });

  box.addEventListener('touchend', () => {
    if (!swipeRow) return;
    const rowId = swipeRow.getAttribute('data-row-id') || '';
    swipeRow.style.transform = '';
    const triggered = swipeDeltaX >= 40;
    swipeRow = null;
    swipeDeltaX = 0;
    if (triggered && rowId) {
      suppressNextClickId = rowId;
      const target = currentMessages.find((m) => m.id === rowId);
      if (target) setReplyTarget(target);
      return;
    }
    if (rowId) {
      const now = Date.now();
      if (rowId === lastTapId && now - lastTapAt < 420) {
        lastTapId = '';
        lastTapAt = 0;
        suppressNextClickId = rowId;
        void toggleLikeMessage(rowId);
      } else {
        lastTapId = rowId;
        lastTapAt = now;
      }
    }
  });

  box.addEventListener('dblclick', async (e) => {
    if (e.target.closest('button,input')) return;
    const rowEl = e.target.closest('[data-row-id]');
    if (!rowEl) return;
    const id = rowEl.getAttribute('data-row-id');
    if (id) {
      lastTapId = '';
      lastTapAt = 0;
      await toggleLikeMessage(id);
    }
  });

  box.addEventListener('click', async (e) => {
    const replyBtn = e.target.closest('[data-reply-id]');
    if (replyBtn) {
      const id = replyBtn.getAttribute('data-reply-id');
      const target = currentMessages.find((m) => m.id === id);
      if (target) setReplyTarget(target);
      return;
    }

    const delBtn = e.target.closest('[data-delete-id]');
    if (delBtn) {
      const id = delBtn.getAttribute('data-delete-id');
      if (!id) return;
      const res = await fetch('/api/chat?id=' + encodeURIComponent(id), {
        method: 'DELETE',
        headers: authHeaders(),
        credentials: 'same-origin',
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.messages)) render(data.messages, true);
      }
      return;
    }

    const rowEl = e.target.closest('[data-row-id]');
    if (rowEl) {
      const id = rowEl.getAttribute('data-row-id') || '';
      if (suppressNextClickId === id) {
        suppressNextClickId = '';
      }
    }
  });

  document.getElementById('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const active = getActiveUser();
    if (!active) return;
    const text = input.value.trim();
    if (!text) return;
    const replyTo = activeReply;
    input.value = '';
    setReplyTarget(null);
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'same-origin',
      body: JSON.stringify({ text, handle: active.handle, replyTo }),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.messages)) render(data.messages, true);
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !socket) connectSocket();
  });
  window.addEventListener('focus', () => {
    if (!socket) connectSocket();
  });
  window.addEventListener('pageshow', () => {
    syncMode();
  });

  syncMode();
</script>
</body>
</html>`
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
            const session = await sessionOf(req, env, url)
            const authHeader = req.headers.get('Authorization') ?? ''
            const expectedKey = (env as any).REFRESH_KEY as string | undefined
            const authorized =
                canManagePosts(session) ||
                (Boolean(expectedKey) &&
                    (authHeader === `Bearer ${expectedKey}` || url.searchParams.get('key') === expectedKey))

            if (!authorized) {
                return message(403, 'Refresh is restricted.')
            }

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
            if (!CHAT_PFP_HANDLE_SET.has(handle)) {
                return new Response(null, { status: 404 })
            }

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

                await chatStub(env).addMessage({
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

                await chatStub(env).addMessage({
                    handle: session.user.handle,
                    author: session.user.name || session.user.handle,
                    text: text.slice(0, 500),
                })

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
