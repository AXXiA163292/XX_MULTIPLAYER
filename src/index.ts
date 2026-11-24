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

type WorkerEnv = Env

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
    return env.SONOLUS_ASSETS_BUCKET ?? env.POSTS_BUCKET ?? null
}

function bucketsForRead(env: WorkerEnv): R2Bucket[] {
    return [env.SONOLUS_ASSETS_BUCKET, env.POSTS_BUCKET, env.COMMUNITY_BUCKET].filter(
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

function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

function formatXxFromHeader(rawFrom?: string): string {
    const trimmed = String(rawFrom ?? '').trim()
    if (!trimmed) {
        return 'XX! <onboarding@resend.dev>'
    }
    const angleMatch = trimmed.match(/<([^>]+)>/)
    const address = angleMatch ? angleMatch[1]!.trim() : trimmed
    return `XX! <${address}>`
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
    pfpKey?: string | null,
    notifyEmail?: string,
    emailNotifyMode?: EmailNotifyMode,
): Promise<UserChatPrefs> {
    const clean = String(handle ?? '').trim()
    const current = await getUserChatPrefs(env, clean)
    const nextPfpKey = pfpKey === null
        ? undefined
        : pfpKey !== undefined
            ? pfpKey
            : current.pfpKey

    const next: UserChatPrefs = {
        handle: clean,
        displayName: String(displayName ?? '').trim().slice(0, 40) || current.displayName,
        ...(nextPfpKey ? { pfpKey: nextPfpKey } : {}),
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

async function sendChatNotificationEmails(
    env: WorkerEnv,
    req: Request,
    sender: UserProfile,
    text: string,
): Promise<void> {
    const apiKey = String(env.RESEND_API_KEY ?? '').trim()
    if (!apiKey) {
        console.warn('[Mail] RESEND_API_KEY is not configured; skipping chat email notifications.')
        return
    }

    const fromEmail = formatXxFromHeader(env.NOTIFY_FROM_EMAIL)
    const allPrefs = await Promise.all(
        CHAT_PFP_HANDLES.map((h) => getUserChatPrefs(env, h)),
    )

    const lowerText = text.toLowerCase()
    const chatUrl = externalChatUrl(req, env)

    for (const pref of allPrefs) {
        if (pref.handle === sender.handle) continue
        const email = String(pref.notifyEmail ?? '').trim()
        if (!email || !isValidEmail(email)) continue

        const mode: EmailNotifyMode = pref.emailNotifyMode === 'all' ? 'all' : 'mention'
        const namesToMatch = [
            pref.displayName,
            DEFAULT_CHAT_PROFILES[pref.handle]?.name,
            pref.handle,
        ]
            .map((v) => String(v ?? '').trim().toLowerCase())
            .filter(Boolean)

        const isMentioned = namesToMatch.some(
            (n) => lowerText.includes(`@${n}`) || lowerText.includes(`#${n}`),
        )

        if (mode === 'mention' && !isMentioned) continue

        try {
            const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from: fromEmail,
                    to: [email],
                    subject: `XX! Chat • ${formatAuthorTag(sender.name, sender.handle)}`,
                    text: `${formatAuthorTag(sender.name, sender.handle)}:\n${text}\n\nOpen chat: ${chatUrl}`,
                }),
                signal: AbortSignal.timeout(8000),
            })

            if (!res.ok) {
                const bodyText = await res.text().catch(() => '')
                console.warn('[Mail] Failed sending email to', email, res.status, bodyText)
            }
        } catch (err) {
            console.warn('[Mail] Error sending email to', email, err)
        }
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
    const hostAndBase = addressOf(req, env).replace(/^https?:\/\//, '')
    return `sonolus://${hostAndBase}/sonolus/posts/chat`
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
  .field-row-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
  .subtle-link-btn{
    background:none;
    border:none;
    padding:0;
    font-size:11.5px;
    font-weight:700;
    color:var(--muted);
    cursor:pointer;
    text-decoration:underline;
    font-family:inherit;
  }
  .subtle-link-btn:hover{color:#BE123C}
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
        <button id="addMediaBtn" type="button" class="tab-plus" title="Add Media" aria-label="Add Media">+</button>
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
            <div class="sonolus-label">Sonolus App</div>
            <div class="sonolus-sub">Open server chat in Sonolus</div>
          </div>
          <a id="openSonolusBtn" class="btn-sm" href="${escapeAttr(sonolusUrl)}">Open on Sonolus</a>
        </div>
        <div>
          <div class="field-row-top">
            <label class="field-label" for="pfpFileInput" style="margin-bottom:0">Square 1:1 Profile Picture</label>
            <button id="removePfpBtn" type="button" class="subtle-link-btn">Remove picture</button>
          </div>
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
  const removePfpBtn = document.getElementById('removePfpBtn');
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
    const active = getActiveUser();
    if (!active) {
      openPasswordPrompt(MEDIA_ADMIN);
      return;
    }
    if (active.handle !== MEDIA_ADMIN) {
      mediaStatusEl.textContent = 'Only #163292 can upload media.';
      mediaUploadModal.classList.add('open');
      return;
    }
    if (activeTab !== 'media') {
      setActiveTab('media');
    }
    mediaStatusEl.textContent = '';
    mediaUploadModal.classList.add('open');
    setTimeout(() => mediaFileInput.focus(), 20);
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

  addMediaBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMediaUploadModal();
  });

  closeMediaModalBtn.addEventListener('click', () => {
    mediaUploadModal.classList.remove('open');
  });

  function renderMedia(items) {
    if (Array.isArray(items)) {
      currentMedia = items;
    }
    const active = getActiveUser();
    const canDelete = Boolean(active && active.handle === MEDIA_ADMIN);

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

  removePfpBtn.addEventListener('click', async () => {
    const active = getActiveUser();
    if (!active) return;
    settingsStatusEl.textContent = 'Removing picture...';
    removePfpBtn.disabled = true;
    try {
      const res = await fetch('/api/chat/settings', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'same-origin',
        body: JSON.stringify({
          handle: active.handle,
          displayName: displayNameInput.value.trim() || active.name,
          notifyEmail: notifyEmailInput.value.trim(),
          emailNotifyMode: selectedNotifyMode,
          removePfp: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        settingsStatusEl.textContent = data.message || 'Could not remove picture.';
        return;
      }
      if (data.prefs) prefsMap[active.handle] = data.prefs;
      pfpFileInput.value = '';
      cropWrap.style.display = 'none';
      cropState.loaded = false;
      settingsStatusEl.textContent = 'Picture removed.';
      render(currentMessages, true);
    } finally {
      removePfpBtn.disabled = false;
    }
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

const removeThumbnailForm = {
    name: 'Remove Image',
    type: 'removeThumbnail',
    title: 'Remove Image',
    icon: 'delete',
    requireConfirmation: true,
    options: [],
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
        actions.push(makeEditPostForm(post), makePinPostForm(pinned))
        if (post.item?.thumbnail || post.thumbnailHash) {
            actions.push(removeThumbnailForm)
        }
        actions.push(deletePostForm)
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

    async fetch(req: Request, env: WorkerEnv, ctx?: ExecutionContext): Promise<Response> {
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
            const obj = await getBucketObject(assetsBucket(env), [
                'server/banner.png',
                'ranked-match/MASTER/MASTER.png',
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
                if (rawBytes.byteLength === 0 || rawBytes.byteLength > 8_000_000) {
                    return message(400, 'Image must be between 1B and 8MB.')
                }

                const dims = getImageDimensions(rawBytes, mime)
                if (!dims || dims.width <= 0 || dims.height <= 0) {
                    return message(400, 'Could not read image dimensions.')
                }

                const bucket = communityBucket(env)
                if (!bucket) {
                    return message(500, 'COMMUNITY_BUCKET is not configured.')
                }

                const id = randomId()
                const imageKey = `chat/media/${id}.${ext}`
                await bucket.put(imageKey, rawBytes, {
                    httpMetadata: { contentType: mime },
                })

                const link = sanitizeHttpLink(body?.link)
                const caption = typeof body?.caption === 'string'
                    ? body.caption.trim().slice(0, 160)
                    : ''

                const existing = await listChatMedia(env)
                const nextItems: ChatMediaItem[] = [
                    {
                        id,
                        imageKey,
                        contentType: mime,
                        ...(link ? { link } : {}),
                        ...(caption ? { caption } : {}),
                        createdAt: Date.now(),
                        authorHandle: MEDIA_ADMIN_HANDLE,
                    },
                    ...existing,
                ]
                await saveChatMediaIndex(env, nextItems)

                return json({ items: nextItems })
            }

            if (req.method === 'DELETE') {
                if (!isMediaAdminHandle(resolved.user.handle)) {
                    return message(403, 'Only 163292 can remove media.')
                }
                const mediaId = String(url.searchParams.get('id') ?? '').trim()
                if (!mediaId) return message(400, 'Missing media id.')

                const existing = await listChatMedia(env)
                const target = existing.find((m) => m.id === mediaId)
                const nextItems = existing.filter((m) => m.id !== mediaId)
                await saveChatMediaIndex(env, nextItems)

                const bucket = communityBucket(env)
                if (bucket) {
                    const keysToDelete = new Set<string>([
                        `chat/media/${mediaId}.png`,
                        `chat/media/${mediaId}.jpg`,
                        `chat/media/${mediaId}.webp`,
                    ])
                    if (target?.imageKey) keysToDelete.add(target.imageKey)
                    for (const k of keysToDelete) {
                        await bucket.delete(k).catch(() => {})
                    }
                }

                return json({ items: nextItems })
            }

            return message(405, 'Method not allowed.')
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
                return json({ ok: true, handle })
            }

            if (!matchesSessionSecretPassword(env, body?.password)) {
                return message(401, 'Invalid password.')
            }

            return json({ ok: true, handle })
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

            const removePfp = body?.removePfp === true || body?.removePfp === 'true'
            const displayName = typeof body?.displayName === 'string' && body.displayName.trim()
                ? body.displayName.trim().slice(0, 40)
                : resolved.user.name

            const notifyEmail = typeof body?.notifyEmail === 'string'
                ? body.notifyEmail.trim().slice(0, 120)
                : undefined

            if (notifyEmail && !isValidEmail(notifyEmail)) {
                return message(400, 'Enter a valid email address.')
            }

            const emailNotifyMode: EmailNotifyMode | undefined =
                body?.emailNotifyMode === 'all' || body?.emailNotifyMode === 'mention'
                    ? body.emailNotifyMode
                    : undefined

            const currentPrefs = await getUserChatPrefs(env, resolved.user.handle)
            let pfpKey: string | null | undefined = undefined

            if (removePfp) {
                const bucket = communityBucket(env)
                if (bucket) {
                    const keysToRemove = new Set<string>([
                        `chat/pfp/${resolved.user.handle}.png`,
                    ])
                    if (currentPrefs.pfpKey) keysToRemove.add(currentPrefs.pfpKey)
                    for (const key of keysToRemove) {
                        await bucket.delete(key).catch(() => {})
                    }
                }
                pfpKey = null
            } else {
                const dataUrl = typeof body?.pfpDataUrl === 'string' ? body.pfpDataUrl : ''
                if (dataUrl) {
                    const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/)
                    if (!match) {
                        return message(400, 'Invalid image data.')
                    }

                    const mime = match[1]!
                    const rawBytes = Uint8Array.from(atob(match[2]!), (c) => c.charCodeAt(0))
                    if (rawBytes.byteLength === 0 || rawBytes.byteLength > 2_500_000) {
                        return message(400, 'Image size must be between 1B and 2.5MB.')
                    }

                    const dims = getImageDimensions(rawBytes, mime)
                    if (!dims || dims.width <= 0 || dims.height <= 0 || dims.width !== dims.height) {
                        return message(400, 'Profile picture must have a 1:1 square aspect ratio.')
                    }

                    const bucket = communityBucket(env)
                    if (!bucket) {
                        return message(500, 'COMMUNITY_BUCKET is not configured.')
                    }

                    pfpKey = `chat/pfp/${resolved.user.handle}.png`
                    await bucket.put(pfpKey, rawBytes, {
                        httpMetadata: { contentType: 'image/png' },
                    })
                }
            }

            const updated = await saveUserChatPrefs(
                env,
                resolved.user.handle,
                displayName,
                pfpKey,
                notifyEmail,
                emailNotifyMode,
            )

            return json({
                ok: true,
                prefs: updated,
            })
        }

        if (path === '/chat' || path === '/staff-chat') {
            const resolved = await resolveChatUser(req, env, url)
            const prefsEntries = await Promise.all(
                CHAT_PFP_HANDLES.map(async (h) => [h, await getUserChatPrefs(env, h)] as const),
            )
            const prefsMap = Object.fromEntries(prefsEntries) as Record<string, UserChatPrefs>
            const [initialMessages, initialMedia] = await Promise.all([
                chatStub(env).list().catch(() => []),
                listChatMedia(env).catch(() => []),
            ])

            return html(renderStaffChatHtml(
                resolved?.user ?? null,
                resolved?.token ?? '',
                resolved?.fromSonolus ?? false,
                prefsMap,
                sonolusChatLinkUrl(req, env),
                initialMessages,
                initialMedia,
            ))
        }

        if (path === '/ws/chat') {
            if (req.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected WebSocket', { status: 426 })
            }

            const resolved = await resolveChatUser(req, env, url)
            if (!resolved) {
                return new Response('Forbidden', { status: 403 })
            }

            const headers = new Headers(req.headers)
            headers.set('x-chat-user', encodeURIComponent(JSON.stringify(resolved.user)))
            return chatStub(env).fetch(new Request(req.url, { headers }))
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
                return message(403, 'Choose a valid handle to access chat.')
            }

            if (req.method === 'GET') {
                const messages = await chatStub(env).list()
                return json({ messages })
            }

            if (req.method === 'POST') {
                if (body?.action === 'like') {
                    const id = String(body?.id ?? '').trim()
                    if (!id) return message(400, 'Missing message id.')
                    const messages = await chatStub(env).toggleLike(id, resolved.user.handle)
                    return json({ messages })
                }

                const text = String(body?.text ?? '').trim()
                if (!text) return message(400, 'Message cannot be empty.')
                const replyTo = body?.replyTo && typeof body.replyTo === 'object'
                    ? {
                        id: String(body.replyTo.id ?? ''),
                        author: String(body.replyTo.author ?? ''),
                        handle: String(body.replyTo.handle ?? ''),
                        text: String(body.replyTo.text ?? '').slice(0, 120),
                    }
                    : undefined

                const messages = await chatStub(env).post(resolved.user, text, replyTo)
                const mailPromise = sendChatNotificationEmails(env, req, resolved.user, text)
                if (ctx) {
                    ctx.waitUntil(mailPromise)
                } else {
                    await mailPromise.catch(() => {})
                }
                return json({ messages })
            }

            if (req.method === 'DELETE') {
                const id = String(url.searchParams.get('id') ?? '').trim()
                if (!id) return message(400, 'Missing message id.')
                const current = await chatStub(env).list()
                const target = current.find((m) => m.id === id)
                if (!target) return message(404, 'Message not found.')
                if (!canDeleteChatMessage(resolved.user.handle, target.handle)) {
                    return message(403, 'Cannot delete this message.')
                }
                const messages = await chatStub(env).remove(id)
                return json({ messages })
            }

            return message(405, 'Method not allowed.')
        }

        if (path === '/sonolus/info' && req.method === 'GET') {
            return json({
                title: SERVER_TITLE,
                description: SERVER_DESCRIPTION,
                buttons: [
                    { type: 'authentication' },
                    { type: 'multiplayer' },
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
                        icon: 'award',
                        infoType: 'results',
                    },
                    { type: 'playlist' },
                    { type: 'level' },
                    { type: 'configuration' },
                ],
                configuration: {
                    options: [],
                },
            })
        }

        if (path === '/sonolus/authenticate' && req.method === 'POST') {
            const raw = new Uint8Array(await req.arrayBuffer())
            const body = await verifySigned(req, env, raw, 'authenticate')
            if (!body) return message(401, 'Authentication failed.')

            const user = profileOf(body.userProfile)
            const exp = Date.now() + 86_400_000
            const session = await signToken(env.SESSION_SECRET, { user, exp })

            return json({
                session,
                expiration: exp,
            })
        }

        if (path === '/sonolus/rooms/info' && req.method === 'GET') {
            const session = await sessionOf(req, env, url)
            const isTournamentHost = session?.user.handle === TOURNAMENT_HOST_HANDLE

            return json({
                creates: roomForms(isTournamentHost),
                searches: [],
                sections: [
                    {
                        title: 'Rooms',
                        items: await roomItems(env, session),
                    },
                ],
            })
        }

        if (path === '/sonolus/rooms/create' && req.method === 'POST') {
            const raw = new Uint8Array(await req.arrayBuffer())
            const body = await verifySigned(req, env, raw, 'roomCreate')
            if (!body) return message(401, 'Authentication failed.')

            const user = profileOf(body.userProfile)
            const parsed = parseSettings(
                String(body.values ?? ''),
                undefined,
                user.name,
            )

            if (!parsed) return message(400, 'Invalid room settings.')

            if (
                user.handle !== TOURNAMENT_HOST_HANDLE &&
                parsed.type !== 'casualRoom' &&
                parsed.type !== 'rankedRoom'
            ) {
                return message(403, 'Only the tournament host can create tournament rooms.')
            }

            const name = randomId()
            const key = randomId()
            const exp = Date.now() + 3_600_000

            await roomStub(env, name).reserve(name, {
                key,
                hostId: user.id,
                hostName: user.name,
                hostHandle: user.handle,
            })

            const joinSession = await signToken(env.SESSION_SECRET, {
                room: name,
                user,
                roomUser: {
                    authentication: '',
                    signature: '',
                },
                exp,
            } satisfies JoinSession)

            return json({
                name,
                key,
                address: addressOf(req, env).replace(/^https?:\/\//, 'wss://') + `/rooms/${name}`,
                session: joinSession,
                expiration: exp,
            })
        }

        if (path === '/sonolus/rooms/list' && req.method === 'GET') {
            const session = await sessionOf(req, env, url)
            return json({
                pageCount: 1,
                items: await roomItems(env, session),
            })
        }

        const roomMatch = path.match(/^\/sonolus\/rooms\/([^/]+)$/)
        if (roomMatch && req.method === 'GET') {
            const name = decodeURIComponent(roomMatch[1]!)
            const session = await sessionOf(req, env, url)
            const summary = await roomStub(env, name).summary()

            if (!summary) {
                return message(404, 'Room not found.')
            }

            const cover = await resolveRoomCover(env, summary)

            return json({
                item: {
                    name: summary.name,
                    title: summary.title,
                    subtitle: summary.subtitle,
                    master: summary.master,
                    ...(cover ? { cover } : {}),
                    tags: [],
                },
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
                ...(session ? {} : { externalUrl: `${addressOf(req, env)}/sonolus/rooms/${encodeURIComponent(name)}` }),
            })
        }

        const roomJoinMatch = path.match(/^\/sonolus\/rooms\/([^/]+)\/join$/)
        if (roomJoinMatch && req.method === 'POST') {
            const name = decodeURIComponent(roomJoinMatch[1]!)
            const raw = new Uint8Array(await req.arrayBuffer())
            const body = await verifySigned(req, env, raw, 'roomJoin')
            if (!body) return message(401, 'Authentication failed.')

            const user = profileOf(body.userProfile)
            const reason = await roomStub(env, name).canJoin(user)
            if (reason) return message(403, reason)

            const exp = Date.now() + 3_600_000
            const roomUser = {
                authentication: b64encode(crypto.getRandomValues(new Uint8Array(16))),
                signature: b64encode(crypto.getRandomValues(new Uint8Array(32))),
            }

            const joinSession = await signToken(env.SESSION_SECRET, {
                room: name,
                user,
                roomUser,
                exp,
            } satisfies JoinSession)

            return json({
                address: addressOf(req, env).replace(/^https?:\/\//, 'wss://') + `/rooms/${name}`,
                session: joinSession,
                expiration: exp,
            })
        }

        const roomWsMatch = path.match(/^\/rooms\/([^/]+)$/)
        if (roomWsMatch && req.headers.get('Upgrade') === 'websocket') {
            const name = decodeURIComponent(roomWsMatch[1]!)
            const sessionTokenParam = url.searchParams.get('session') ?? ''
            const join = sessionTokenParam
                ? await verifyToken<JoinSession>(env.SESSION_SECRET, sessionTokenParam)
                : null

            if (!join || join.room !== name || join.exp < Date.now()) {
                return new Response('Unauthorized', { status: 401 })
            }

            const headers = new Headers(req.headers)
            headers.set('x-join', encodeURIComponent(JSON.stringify(join)))
            return roomStub(env, name).fetch(new Request(req.url, { headers }))
        }

        if (path === '/sonolus/posts/info' && req.method === 'GET') {
            const session = await sessionOf(req, env, url)
            const [announcements, posts, results, chatState] = await Promise.all([
                lobby(env).listPosts('announcements'),
                lobby(env).listPosts('posts'),
                lobby(env).listPosts('results'),
                chatStub(env).state(),
            ])

            const sections: any[] = [
                {
                    title: 'Chat',
                    items: [buildChatPostItem(chatState.messages, chatState.pinnedId)],
                },
                {
                    title: 'Announcements',
                    items: sortPostsPinnedFirst(announcements).map(buildPostItemWithBadges),
                },
                {
                    title: 'Posts',
                    items: sortPostsPinnedFirst(posts).map(buildPostItemWithBadges),
                },
                {
                    title: 'Results',
                    items: sortPostsPinnedFirst(results).map(buildPostItemWithBadges),
                },
            ]

            return json({
                creates: canManagePosts(session)
                    ? [
                        postForm('announcements'),
                        postForm('posts'),
                        postForm('results'),
                    ]
                    : [],
                searches: [],
                sections,
            })
        }

        if (path === '/sonolus/posts/create' && req.method === 'POST') {
            const raw = new Uint8Array(await req.arrayBuffer())
            const body = await verifySigned(req, env, raw, 'postCreate')
            if (!body) return message(401, 'Authentication failed.')

            const user = profileOf(body.userProfile)
            if (user.handle !== TOURNAMENT_HOST_HANDLE) {
                return message(403, 'Only the tournament host can create posts.')
            }

            const values = new URLSearchParams(String(body.values ?? ''))
            const category = resolveCategory(url, req, body, values) ?? 'posts'
            const labels = POST_LABELS[category]
            const title = String(values.get('title') ?? '').trim() || labels.section
            const description = String(values.get('description') ?? '').trim()
            const now = Date.now()
            const postName = randomId(12)

            const created = await lobby(env).createPost({
                category,
                item: {
                    name: postName,
                    version: 1,
                    title,
                    time: now,
                    author: user.name || user.handle,
                    tags: [],
                },
                description,
                uploadKey: '',
                thumbnailHash: '',
            })

            return json({
                name: created.item.name,
                item: buildPostItemWithBadges(created),
            })
        }

        if (path === '/sonolus/posts/list' && req.method === 'GET') {
            const keywords = resolveKeywords(url)
            const [announcements, posts, results, chatState] = await Promise.all([
                lobby(env).listPosts('announcements'),
                lobby(env).listPosts('posts'),
                lobby(env).listPosts('results'),
                chatStub(env).state(),
            ])

            if (isChatCategory(url)) {
                const chatItem = buildChatPostItem(chatState.messages, chatState.pinnedId)
                const matches = !keywords ||
                    chatItem.title.toLowerCase().includes(keywords) ||
                    chatItem.subtitle.toLowerCase().includes(keywords)
                return json({
                    pageCount: 1,
                    items: matches ? [chatItem] : [],
                })
            }

            const specificCategory = resolveCategory(url)
            const combined = specificCategory
                ? sortPostsPinnedFirst(
                    specificCategory === 'announcements'
                        ? announcements
                        : specificCategory === 'results'
                            ? results
                            : posts,
                )
                : sortPostsPinnedFirst([...announcements, ...posts, ...results])

            const filtered = keywords
                ? combined.filter((p) => {
                    const t = String(p.item?.title ?? '').toLowerCase()
                    const d = String(p.description ?? '').toLowerCase()
                    return t.includes(keywords) || d.includes(keywords)
                })
                : combined

            return json({
                pageCount: 1,
                items: filtered.map(buildPostItemWithBadges),
            })
        }

        const postMatch = path.match(/^\/sonolus\/posts\/([^/]+)$/)
        if (postMatch && req.method === 'GET') {
            const name = decodeURIComponent(postMatch[1]!)
            const session = await sessionOf(req, env, url)

            if (isChatItemName(name)) {
                const chatState = await chatStub(env).state()
                const page = Number(url.searchParams.get('page') ?? '0') || 0
                const { pageCount, comments } = formatChatCommunityComments(
                    chatState.messages,
                    session,
                    page,
                )
                return json({
                    item: buildChatPostItem(chatState.messages, chatState.pinnedId),
                    description: `Web chat: ${externalChatUrl(req, env)}`,
                    actions: [chatActionForm],
                    hasCommunity: true,
                    leaderboards: [],
                    sections: [],
                    comments,
                    pageCount,
                    externalUrl: externalChatUrl(req, env),
                })
            }

            const post = await lobby(env).getPost(name)
            if (!post) {
                return message(404, 'Post not found.')
            }

            const page = Number(url.searchParams.get('page') ?? '0') || 0
            const { pageCount, comments } = formatPostComments(post, session, page)

            return json({
                item: buildPostItemWithBadges(post),
                description: post.description ?? '',
                actions: postActionsFor(post, session),
                hasCommunity: true,
                leaderboards: [],
                sections: [],
                comments,
                pageCount,
            })
        }

        const postCommentPostMatch = path.match(/^\/sonolus\/posts\/([^/]+)\/comments$/)
        if (postCommentPostMatch && req.method === 'POST') {
            const name = decodeURIComponent(postCommentPostMatch[1]!)
            const raw = new Uint8Array(await req.arrayBuffer())
            const body = await verifySigned(req, env, raw, 'postComment')
            if (!body) return message(401, 'Authentication failed.')

            const user = profileOf(body.userProfile)
            const values = new URLSearchParams(String(body.values ?? ''))
            const text = extractCommentText(values)
            if (!text) return message(400, 'Comment cannot be empty.')

            if (isChatItemName(name)) {
                if (!isStaffChatHandle(user.handle)) {
                    return message(403, 'Chat is restricted to staff.')
                }
                const prefs = await getUserChatPrefs(env, user.handle)
                const chatUser: UserProfile = {
                    ...user,
                    name: prefs.displayName || defaultDisplayName(user.handle, user.name),
                }
                const messages = await chatStub(env).post(chatUser, text)
                const { pageCount, comments } = formatChatCommunityComments(
                    messages,
                    { user: chatUser, exp: Date.now() + 86_400_000 },
                    0,
                )
                return json({ comments, pageCount })
            }

            const added = await lobby(env).addPostComment(name, {
                handle: user.handle,
                author: user.name || user.handle,
                text,
            })
            if (!added) return message(404, 'Post not found.')
            const updated = await lobby(env).getPost(name)
            if (!updated) return message(404, 'Post not found.')

            const { pageCount, comments } = formatPostComments(
                updated,
                { user, exp: Date.now() + 86_400_000 },
                0,
            )
            return json({ comments, pageCount })
        }

        const postCommentDelMatch = path.match(/^\/sonolus\/posts\/([^/]+)\/comments\/([^/]+)$/)
        if (postCommentDelMatch && req.method === 'DELETE') {
            const name = decodeURIComponent(postCommentDelMatch[1]!)
            const commentId = decodeURIComponent(postCommentDelMatch[2]!)
            const session = await sessionOf(req, env, url)
            if (!session) return message(401, 'Authentication required.')

            if (isChatItemName(name)) {
                const state = await chatStub(env).state()
                const target = state.messages.find((m) => m.id === commentId)
                if (!target) return message(404, 'Comment not found.')
                if (!canDeleteComment(session, target.handle)) {
                    return message(403, 'Cannot delete this comment.')
                }
                const messages = await chatStub(env).remove(commentId)
                const { pageCount, comments } = formatChatCommunityComments(messages, session, 0)
                return json({ comments, pageCount })
            }

            const post = await lobby(env).getPost(name)
            if (!post) return message(404, 'Post not found.')
            const target = (post.comments ?? []).find((c) => c.id === commentId)
            if (!target) return message(404, 'Comment not found.')
            if (!canDeleteComment(session, target.handle)) {
                return message(403, 'Cannot delete this comment.')
            }
            const removed = await lobby(env).deletePostComment(name, commentId)
            if (!removed) return message(404, 'Post not found.')
            const updated = await lobby(env).getPost(name)
            if (!updated) return message(404, 'Post not found.')
            const { pageCount, comments } = formatPostComments(updated, session, 0)
            return json({ comments, pageCount })
        }

        const postSubmitMatch = path.match(/^\/sonolus\/posts\/([^/]+)\/submit$/)
        if (postSubmitMatch && req.method === 'POST') {
            const name = decodeURIComponent(postSubmitMatch[1]!)
            const raw = new Uint8Array(await req.arrayBuffer())
            const body = await verifySigned(req, env, raw, 'postSubmit')
            if (!body) return message(401, 'Authentication failed.')

            const user = profileOf(body.userProfile)
            const values = new URLSearchParams(String(body.values ?? ''))
            const actionType = String(body.action ?? values.get('type') ?? '').trim()

            if (isChatItemName(name)) {
                if (!isStaffChatHandle(user.handle)) {
                    return message(403, 'Chat is restricted to staff.')
                }
                const text = extractCommentText(values)
                if (text) {
                    const prefs = await getUserChatPrefs(env, user.handle)
                    await chatStub(env).post({
                        ...user,
                        name: prefs.displayName || defaultDisplayName(user.handle, user.name),
                    }, text)
                }
                const chatState = await chatStub(env).state()
                return json({
                    item: buildChatPostItem(chatState.messages, chatState.pinnedId),
                })
            }

            const existing = await lobby(env).getPost(name)
            if (!existing) return message(404, 'Post not found.')

            if (actionType === 'likePost') {
                const updated = await lobby(env).togglePostLike(name, user.handle)
                if (!updated) return message(404, 'Post not found.')
                return json({ item: buildPostItemWithBadges(updated) })
            }

            if (user.handle !== TOURNAMENT_HOST_HANDLE) {
                return message(403, 'Only the tournament host can perform this action.')
            }

            if (actionType === 'deletePost') {
                const bucket = communityBucket(env)
                if (bucket && existing.thumbnailHash) {
                    await bucket.delete(`posts/thumbnails/${existing.thumbnailHash}`).catch(() => {})
                }
                await lobby(env).removePost(name)
                return json({ deleted: true })
            }

            if (actionType === 'removeThumbnail') {
                const bucket = communityBucket(env)
                if (bucket && existing.thumbnailHash) {
                    await bucket.delete(`posts/thumbnails/${existing.thumbnailHash}`).catch(() => {})
                }
                const updated = await lobby(env).clearPostThumbnail(name)
                if (!updated) return message(404, 'Post not found.')
                return json({ item: buildPostItemWithBadges(updated) })
            }

            if (actionType === 'pinPost') {
                const updated = await lobby(env).togglePostPin(name)
                if (!updated) return message(404, 'Post not found.')
                return json({ item: buildPostItemWithBadges(updated) })
            }

            if (actionType === 'editPost') {
                const nextTitle = values.has('title')
                    ? (String(values.get('title') ?? '').trim() || String(existing.item?.title ?? ''))
                    : undefined
                const nextDescription = values.has('description')
                    ? String(values.get('description') ?? '').trim()
                    : undefined

                const updated = await lobby(env).updatePost(name, {
                    ...(nextTitle !== undefined ? { title: nextTitle } : {}),
                    ...(nextDescription !== undefined ? { description: nextDescription } : {}),
                })
                if (!updated) return message(404, 'Post not found.')
                return json({ item: buildPostItemWithBadges(updated) })
            }

            const text = extractCommentText(values)
            if (text) {
                await lobby(env).addPostComment(name, {
                    handle: user.handle,
                    author: user.name || user.handle,
                    text,
                })
                const updated = await lobby(env).getPost(name)
                if (!updated) return message(404, 'Post not found.')
                return json({ item: buildPostItemWithBadges(updated) })
            }

            return json({ item: buildPostItemWithBadges(existing) })
        }

        if (path === '/sonolus/playlists/info' && req.method === 'GET') {
            const playlists = await getPlaylists(env)

            return json({
                creates: [],
                searches: [],
                sections: [
                    {
                        title: 'Playlists',
                        items: playlists.map((playlist) => ({
                            name: playlistSlug(playlist.name) || playlist.name,
                            title: playlist.name,
                            subtitle: `${playlist.charts.length} charts`,
                            tags: [],
                        })),
                    },
                ],
            })
        }

        if (path === '/sonolus/playlists/list' && req.method === 'GET') {
            const keywords = url.searchParams.get('keywords')?.trim().toLowerCase() ?? ''
            const playlists = await getPlaylists(env)

            const filtered = keywords
                ? playlists.filter((playlist) =>
                    playlist.name.toLowerCase().includes(keywords))
                : playlists

            return json({
                pageCount: 1,
                items: filtered.map((playlist) => ({
                    name: playlistSlug(playlist.name) || playlist.name,
                    title: playlist.name,
                    subtitle: `${playlist.charts.length} charts`,
                    tags: [],
                })),
            })
        }

        const playlistMatch = path.match(/^\/sonolus\/playlists\/([^/]+)$/)
        if (playlistMatch && req.method === 'GET') {
            const slug = decodeURIComponent(playlistMatch[1]!)
            const playlists = await getPlaylists(env)

            const playlist = playlists.find(
                (entry) =>
                    samePlaylist(playlistSlug(entry.name), slug) ||
                    samePlaylist(entry.name, slug),
            )

            if (!playlist) {
                return message(404, 'Playlist not found.')
            }

            const cachedItems = await getCachedLevelItemsForCharts(env, playlist.charts)
            const levels = cachedItems ?? (await loadLevelItems(playlist.charts)).map((x) => x.item)

            return json({
                item: {
                    name: playlistSlug(playlist.name) || playlist.name,
                    title: playlist.name,
                    subtitle: `${levels.length} charts`,
                    tags: [],
                },
                description: `${playlist.name} (${levels.length} charts).`,
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [
                    {
                        title: 'Charts',
                        items: levels,
                    },
                ],
            })
        }

        if (path === '/sonolus/levels/info' && req.method === 'GET') {
            const [{ charts, pageCount }, playlists] = await Promise.all([
                getCustomLevelPage(0, env),
                getPlaylists(env),
            ])

            const cachedItems = await getCachedLevelItemsForCharts(env, charts)
            const levels = cachedItems ?? (await loadLevelItems(charts)).map((x) => x.item)

            return json({
                creates: [],
                searches: [],
                sections: [
                    {
                        title: 'Custom Levels',
                        items: levels,
                    },
                    {
                        title: 'Playlists',
                        items: playlists.map((playlist) => ({
                            name: playlistSlug(playlist.name) || playlist.name,
                            title: playlist.name,
                            subtitle: `${playlist.charts.length} charts`,
                            tags: [],
                        })),
                    },
                ],
                pageCount,
            })
        }

        if (path === '/sonolus/levels/list' && req.method === 'GET') {
            const page = Number(url.searchParams.get('page') ?? '0') || 0
            const keywords = url.searchParams.get('keywords')?.trim().toLowerCase() ?? ''

            const { charts, pageCount } = await getCustomLevelPage(page, env)
            const cachedItems = await getCachedLevelItemsForCharts(env, charts)
            const loaded = cachedItems
                ? cachedItems.map((item) => ({ item }))
                : await loadLevelItems(charts)

            const items = loaded
                .map(({ item }) => item)
                .filter((item) => {
                    if (!keywords) return true
                    const title = String(item.title ?? '').toLowerCase()
                    const artists = String(item.artists ?? '').toLowerCase()
                    const author = String(item.author ?? '').toLowerCase()
                    return (
                        title.includes(keywords) ||
                        artists.includes(keywords) ||
                        author.includes(keywords)
                    )
                })

            return json({
                pageCount,
                items,
            })
        }

        const levelMatch = path.match(/^\/sonolus\/levels\/([^/]+)$/)
        if (levelMatch && req.method === 'GET') {
            const name = decodeURIComponent(levelMatch[1]!)
            const chart = await findChart(name, env)

            if (!chart) {
                return message(404, 'Level not found.')
            }

            if (isUnch(chart)) {
                return proxyToUnch(req, url, chart, '')
            }

            const details = await remoteLevelDetails(chart)
            if (!details) {
                return message(502, 'Could not load level data.')
            }

            return json({
                ...details,
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            })
        }

        const levelSubMatch = path.match(/^\/sonolus\/levels\/([^/]+)\/(.+)$/)
        if (levelSubMatch) {
            const name = decodeURIComponent(levelSubMatch[1]!)
            const rest = levelSubMatch[2]!
            const chart = await findChart(name, env)

            if (!chart) {
                return message(404, 'Level not found.')
            }

            return proxyToUnch(req, url, chart, rest)
        }

        const r2AssetMatch = path.match(/^\/(?:assets|r2)\/(.+)$/)
        if (r2AssetMatch && req.method === 'GET') {
            const key = decodeURIComponent(r2AssetMatch[1]!)
            for (const bucket of bucketsForRead(env)) {
                const obj = await bucket.get(key).catch(() => null)
                if (obj) {
                    return new Response(obj.body, {
                        headers: {
                            'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
                            'Access-Control-Allow-Origin': '*',
                            'Cache-Control': 'public, max-age=3600',
                        },
                    })
                }
            }
            return new Response(null, { status: 404 })
        }

        return message(404, 'Not found.')
    },
}