import {
    SERVER_DESCRIPTION,
    SERVER_TITLE,
    STAFF_CHAT_HANDLES,
    TOURNAMENT_HOST_HANDLE,
} from './config.ts'
import {
    getAvailableEditions,
    getLiveEdition,
    getCustomLevelPage,
    getCustomLevels,
    getPlaylists,
    refreshDailyAssets,
    type SheetChart,
} from './sheets.ts'
import { b64encode, randomId, signToken, verifySonolusSignature, verifyToken } from './crypto.ts'
import { parseSettings, roomForms } from './forms.ts'
import type { AuthSession, ChatMessage, Env, JoinSession, ReplayRecord, RoomCover, UserProfile } from './types.ts'
import type { PostCategory, PostComment, StoredPost } from './lobby.ts'

export { Room } from './room.ts'
export { Lobby } from './lobby.ts'
export { Chat } from './chat.ts'
export { Replays } from './replays.ts'

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

const replaysStub = (env: WorkerEnv) =>
    env.REPLAYS.get(env.REPLAYS.idFromName('xx-replays'))

async function listReplayRecords(env: WorkerEnv): Promise<ReplayRecord[]> {
    const response = await replaysStub(env).fetch(
        'https://replays/list',
    )

    if (!response.ok) {
        throw new Error(`Replay storage returned ${response.status}.`)
    }

    const data = await response.json() as {
        items?: ReplayRecord[]
    }

    return Array.isArray(data.items) ? data.items : []
}

function replaySectionTitle(metadata: ReplayRecord['metadata']): string {
    const editionTitle =
        metadata.competition === 'ultimateEdition'
            ? `XX! Ultimate Edition • ${metadata.edition}`
            : `XX! Championship ${metadata.edition}`

    const division =
        metadata.competition === 'groupStage'
            ? `Group ${metadata.group || 'A'}`
            : metadata.competition === 'final'
                ? 'Final'
                : 'Ultimate Edition'

    const level =
        `${metadata.songTitle}` +
        `${metadata.difficulty ? ` • ${metadata.difficulty}` : ''}` +
        `${metadata.levelRating != null ? ` Lv.${metadata.levelRating}` : ''}`

    return `${editionTitle} • ${division} • ${metadata.roundLabel} • ${level}`
}

function compareReplayRecords(a: ReplayRecord, b: ReplayRecord): number {
    const scoreDifference =
        Number(b.metadata.scoreValue) - Number(a.metadata.scoreValue)

    if (scoreDifference !== 0) return scoreDifference

    const perfectDifference =
        Number(b.metadata.perfect) - Number(a.metadata.perfect)

    if (perfectDifference !== 0) return perfectDifference

    const comboDifference =
        Number(b.metadata.combo) - Number(a.metadata.combo)

    if (comboDifference !== 0) return comboDifference

    return b.createdAt - a.createdAt
}

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
        }
        if (!summary.level) {
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
  .media-image-error{
    width:100%;
    min-height:140px;
    display:flex;
    align-items:center;
    justify-content:center;
    background:var(--blush-soft);
    color:var(--muted);
    font-size:13px;
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
    mediaStatusEl.textContent = ''

    if (!active || String(active.handle).trim() !== MEDIA_ADMIN) {
      mediaStatusEl.textContent = 'Only #163292 can upload media.'
    }

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

  addMediaBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openMediaUploadModal()
  })

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
        '<img data-media-image loading="lazy" decoding="async" src="' + escapeHtml(imgSrc) + '" alt="' + escapeAttr(item.caption || 'Media')+'"/>' +
        '<div class="media-meta">' +
          '<div style="display:flex;flex-direction:column;gap:4px;min-width:0">' + captionHtml + linkHtml + '</div>' +
          delHtml +
        '</div>' +
      '</article>';
    }).join('');
  }

  mediaFeedEl.addEventListener('error', (e) => {
    const img = e.target.closest('[data-media-image]')
    if (!img) return
    const fallback = document.createElement('div')
    fallback.className = 'media-image-error'
    fallback.textContent = 'Image unavailable'
    img.replaceWith(fallback)
  }, true)

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
    } catch (error) {
      mediaStatusEl.textContent = error instanceof Error ? error.message : 'Upload failed. Please try again.'
    } finally {
      uploadMediaBtn.disabled = false
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
                        return message(403, 'Only 163292 can delete other users messages.')
                    }
                    const updated = await chatStub(env).deleteMessage(targetId)
                    return json({ ok: true, messages: updated, prefs: prefsMap })
                }

                if (body?.action === 'like') {
                    const targetId = typeof body?.id === 'string' ? body.id.trim() : ''
                    if (!targetId) {
                        return message(400, 'Missing message id.')
                    }
                    const updated = await chatStub(env).toggleLike(targetId, resolved.user.handle)
                    return json({ ok: true, messages: updated, prefs: prefsMap })
                }

                const text = typeof body?.text === 'string' ? body.text.trim() : ''
                if (!text) {
                    return message(400, 'Message cannot be empty.')
                }

                const replyTo = body?.replyTo && typeof body.replyTo === 'object' && typeof body.replyTo.id === 'string'
                    ? {
                        id: String(body.replyTo.id).slice(0, 64),
                        author: String(body.replyTo.author ?? '').slice(0, 80),
                        handle: String(body.replyTo.handle ?? '').slice(0, 40),
                        text: String(body.replyTo.text ?? '').slice(0, 140),
                    }
                    : undefined

                const sentMsg: ChatMessage = {
                    id: randomId(12),
                    handle: resolved.user.handle,
                    author: resolved.user.name || defaultDisplayName(resolved.user.handle),
                    text: text.slice(0, 500),
                    time: Date.now(),
                    ...(replyTo ? { replyTo } : {}),
                }
                const messages = await chatStub(env).postMessage(sentMsg)
                await sendChatEmailNotifications(env, sentMsg).catch((err) => {
                    console.error('[Email] Notification dispatch failed:', err)
                })
                return json({ ok: true, message: sentMsg, messages, prefs: prefsMap })
            }

            if (req.method === 'DELETE') {
                const targetId = (url.searchParams.get('id') ?? '').trim()
                if (!targetId) {
                    return message(400, 'Missing message id.')
                }
                const messages = await chatStub(env).listMessages().catch(() => [])
                const target = messages.find((m) => m.id === targetId)
                if (!target) {
                    return message(404, 'Message not found.')
                }
                if (!canDeleteChatMessage(resolved.user.handle, target.handle)) {
                    return message(403, 'Only 163292 can delete other users messages.')
                }
                const updated = await chatStub(env).deleteMessage(targetId)
                return json({ ok: true, messages: updated, prefs: prefsMap })
            }
        }

        if (path === '/sonolus/info' && req.method === 'GET') {
            const session = await sessionOf(req, env, url)
            const canChat = Boolean(session && isStaffChatHandle(session.user.handle))
            const [editions, playlists] = await Promise.all([
                getAvailableEditions(),
                getPlaylists(env),
            ])
            const liveEdition = getLiveEdition()

            const bannerObj = await getBucketObject(assetsBucket(env), [
                'server/banner.png',
            ])
            let banner: { hash: string; url: string } | undefined
            if (bannerObj) {
                const bytes = await bannerObj.arrayBuffer()
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
                        ? [{
                            type: 'post',
                            title: 'Chat',
                            icon: 'comment',
                            infoType: 'chat',
                        }]
                        : []),
                    {
                        type: 'replay',
                        title: 'Replays',
                        icon: 'replay',
                    },
                    { type: 'level' },
                    { type: 'playlist' },
                    { type: 'configuration' },
                ],
                hasAuthentication: true,
                hasMultiplayer: true,
                session: session
                    ? {
                        userProfile: session.user,
                        expire: session.exp,
                    }
                    : undefined,
                configuration: {
                    options: [],
                },
                meta: {
                    liveEdition,
                    editions,
                    playlists: playlists.map((p) => p.name),
                },
            })
        }

        if (path === '/sonolus/server/banner' && req.method === 'GET') {
            const obj = await getBucketObject(assetsBucket(env), [
                'server/banner.png',
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

        if (path === '/sonolus/levels/result/info' && req.method === 'GET') {
            const session = await sessionOf(req, env, url)

            if (!session) {
                return json({ submits: [] })
            }

            try {
                const pendingResponse = await replaysStub(env).fetch(
                    `https://replays/pending?handle=${encodeURIComponent(session.user.handle)}`,
                )

                if (!pendingResponse.ok) {
                    return message(503, 'Replay storage is unavailable.')
                }

                const pendingData = await pendingResponse.json() as {
                    pending?: boolean
                }

                return json({
                    submits: pendingData.pending
                        ? [
                            {
                                type: 'saveXXReplay',
                                title: 'Save XX! Championship Replay',
                                icon: 'replay',
                                requireConfirmation: false,
                                options: [],
                            },
                        ]
                        : [],
                })
            } catch (error) {
                console.error('[Replays] Could not check pending result:', error)
                return message(503, 'Replay storage is unavailable.')
            }
        }

        if (path === '/sonolus/levels/result/submit' && req.method === 'POST') {
            const session = await sessionOf(req, env, url)

            if (!session) {
                return new Response(null, { status: 401 })
            }

            let body: any

            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid replay submission.')
            }

            if (!body?.replay || typeof body.replay !== 'object') {
                return message(400, 'Missing replay data.')
            }

            const replay = {
                ...body.replay,
                source: body.replay.source || addressOf(req, env),
            }

            return replaysStub(env).fetch(
                new Request('https://replays/stage', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        handle: session.user.handle,
                        replay,
                    }),
                }),
            )
        }

        if (path === '/sonolus/levels/result/upload' && req.method === 'POST') {
            const session = await sessionOf(req, env, url)

            if (!session) {
                return new Response(null, { status: 401 })
            }

            const uploadKey = req.headers.get('Sonolus-Upload-Key')

            if (!uploadKey) {
                return message(400, 'Missing replay upload key.')
            }

            const contentType = req.headers.get('Content-Type')

            if (!contentType?.toLowerCase().includes('multipart/form-data')) {
                return message(400, 'Expected multipart replay upload.')
            }

            const headers = new Headers({
                'Sonolus-Upload-Key': uploadKey,
                'Content-Type': contentType,
            })

            return replaysStub(env).fetch(
                new Request('https://replays/upload', {
                    method: 'POST',
                    headers,
                    body: await req.arrayBuffer(),
                }),
            )
        }

        if (path === '/sonolus/replays/info' && req.method === 'GET') {
            try {
                const records = await listReplayRecords(env)

                const grouped = new Map<
                    string,
                    {
                        metadata: ReplayRecord['metadata']
                        records: ReplayRecord[]
                    }
                >()

                for (const record of records) {
                    const metadata = record.metadata

                    if (
                        !metadata ||
                        !metadata.roundId ||
                        !['groupStage', 'final', 'ultimateEdition'].includes(metadata.competition)
                    ) {
                        continue
                    }

                    const existing = grouped.get(metadata.roundId)

                    if (existing) {
                        existing.records.push(record)
                    } else {
                        grouped.set(metadata.roundId, {
                            metadata,
                            records: [record],
                        })
                    }
                }

                const competitionOrder = {
                    groupStage: 0,
                    final: 1,
                    ultimateEdition: 2,
                }

                const sections = [...grouped.values()]
                    .sort((a, b) => {
                        const editionDifference =
                            b.metadata.edition.localeCompare(a.metadata.edition)

                        if (editionDifference !== 0) return editionDifference

                        const competitionDifference =
                            competitionOrder[a.metadata.competition] -
                            competitionOrder[b.metadata.competition]

                        if (competitionDifference !== 0) return competitionDifference

                        const groupDifference =
                            String(a.metadata.group ?? '').localeCompare(
                                String(b.metadata.group ?? ''),
                                undefined,
                                { numeric: true },
                            )

                        if (groupDifference !== 0) return groupDifference

                        return a.metadata.roundNumber - b.metadata.roundNumber
                    })
                    .map(({ metadata, records: roundRecords }) => ({
                        title: replaySectionTitle(metadata),
                        itemType: 'replay',
                        items: roundRecords
                            .sort(compareReplayRecords)
                            .map((record) => record.replay),
                    }))

                return json({
                    title: 'Replays',
                    creates: [],
                    searches: [],
                    sections,
                })
            } catch (error) {
                console.error('[Replays] Could not build replay sections:', error)
                return message(503, 'Could not load replays.')
            }
        }

        if (path === '/sonolus/replays/list' && req.method === 'GET') {
            try {
                const page = Math.max(
                    0,
                    Number(url.searchParams.get('page') ?? '0') || 0,
                )

                const pageSize = 20
                const keywords = resolveKeywords(url).toLowerCase()

                let records = await listReplayRecords(env)

                if (keywords) {
                    records = records.filter((record) => {
                        const metadata = record.metadata

                        const haystack = [
                            metadata.edition,
                            metadata.group ?? '',
                            metadata.roundLabel,
                            metadata.songTitle,
                            metadata.difficulty,
                            metadata.playerName,
                            metadata.playerHandle,
                            metadata.scoreLabel,
                        ].join(' ').toLowerCase()

                        return keywords
                            .split(/\s+/)
                            .filter(Boolean)
                            .every((term) => haystack.includes(term))
                    })
                }

                records.sort((a, b) => b.createdAt - a.createdAt)

                const pageCount = Math.max(
                    1,
                    Math.ceil(records.length / pageSize),
                )

                return json({
                    title: 'Replays',
                    pageCount,
                    items: records
                        .slice(page * pageSize, page * pageSize + pageSize)
                        .map((record) => record.replay),
                    searches: [],
                })
            } catch (error) {
                console.error('[Replays] Could not list replays:', error)
                return message(503, 'Could not load replays.')
            }
        }

        const replayResourcePath = path.match(
            /^\/sonolus\/replays\/resource\/([a-f0-9]{32})\/([a-f0-9]{40})$/i,
        )

        if (replayResourcePath && req.method === 'GET') {
            return replaysStub(env).fetch(
                new Request(
                    `https://replays/resource/${replayResourcePath[1]}/${replayResourcePath[2]}`,
                ),
            )
        }

        const replaySubmitPath = path.match(
            /^\/sonolus\/replays\/([a-f0-9]{32})\/submit$/i,
        )

        if (replaySubmitPath && req.method === 'POST') {
            const session = await sessionOf(req, env, url)

            if (!session) {
                return new Response(null, { status: 401 })
            }

            if (session.user.handle !== TOURNAMENT_HOST_HANDLE) {
                return message(403, 'Only handle 163292 can delete replays.')
            }

            let body: any

            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid replay action.')
            }

            const values = new URLSearchParams(String(body?.values ?? ''))
            const actionType =
                values.get('type') || url.searchParams.get('type') || ''

            if (actionType !== 'deleteReplay') {
                return message(400, 'Unknown replay action.')
            }

            const deleteResponse = await replaysStub(env).fetch(
                new Request(
                    `https://replays/delete/${replaySubmitPath[1]}`,
                    { method: 'DELETE' },
                ),
            )

            if (!deleteResponse.ok) {
                return message(404, 'Replay not found.')
            }

            return json({
                shouldRemoveItem: true,
            })
        }

        const replayItemPath = path.match(
            /^\/sonolus\/replays\/([a-f0-9]{32})$/i,
        )

        if (replayItemPath && req.method === 'GET') {
            const session = await sessionOf(req, env, url)

            const response = await replaysStub(env).fetch(
                new Request(
                    `https://replays/get/${replayItemPath[1]}`,
                ),
            )

            if (!response.ok) {
                return new Response(null, { status: 404 })
            }

            const record = await response.json() as ReplayRecord
            const metadata = record.metadata

            const competition =
                metadata.competition === 'groupStage'
                    ? `Group ${metadata.group ?? 'A'}`
                    : metadata.competition === 'final'
                        ? 'Final'
                        : 'Ultimate Edition'

            const description = [
                metadata.edition,
                competition,
                metadata.roundLabel,
                metadata.songTitle,
                metadata.difficulty,
                metadata.levelRating != null
                    ? `Lv.${metadata.levelRating}`
                    : '',
                metadata.scoreLabel,
            ].filter(Boolean).join('\n')

            return json({
                item: record.replay,
                description,
                actions:
                    session?.user.handle === TOURNAMENT_HOST_HANDLE
                        ? [
                            {
                                type: 'deleteReplay',
                                title: 'Delete Replay',
                                icon: 'delete',
                                requireConfirmation: true,
                                options: [],
                            },
                        ]
                        : [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            })
        }

        if (path === '/sonolus/posts/info' && req.method === 'GET') {
            const session = await sessionOf(req, env, url)

            if (isChatCategory(url)) {
                if (!session || !isStaffChatHandle(session.user.handle)) {
                    return json({
                        title: 'Staff Chat',
                        creates: [],
                        searches: [],
                        sections: [],
                    })
                }
                const messages = await chatStub(env).listMessages().catch(() => [])
                const pinnedId = await chatStub(env).getPinnedId().catch(() => null)
                const chatItem = buildChatPostItem(messages, pinnedId)
                return json({
                    title: 'Staff Chat',
                    creates: [],
                    searches: [],
                    sections: [
                        {
                            title: 'Staff Chat',
                            itemType: 'post',
                            items: [chatItem],
                        },
                    ],
                })
            }

            const category = resolveCategory(url)
            const [announcements, posts, results] = await Promise.all([
                lobby(env).listPosts('announcements'),
                lobby(env).listPosts('posts'),
                lobby(env).listPosts('results'),
            ])

            const all: { cat: PostCategory; list: StoredPost[] }[] = [
                { cat: 'announcements', list: announcements },
                { cat: 'posts', list: posts },
                { cat: 'results', list: results },
            ]
            const chosen = category ? all.filter((x) => x.cat === category) : all

            const sections = chosen.map(({ cat, list }) => ({
                title: POST_LABELS[cat].section,
                itemType: 'post',
                items: sortPostsPinnedFirst(list).map(buildPostItemWithBadges),
            }))

            return json({
                title: category ? POST_LABELS[category].section : 'Posts',
                creates: canManagePosts(session)
                    ? (category ? [postForm(category)] : [
                        postForm('announcements'),
                        postForm('posts'),
                        postForm('results'),
                    ])
                    : [],
                searches: [],
                sections,
            })
        }

        if (path === '/sonolus/posts/list' && req.method === 'GET') {
            const session = await sessionOf(req, env, url)
            const page = Math.max(0, Number(url.searchParams.get('page') ?? '0') || 0)
            const pageSize = 20
            const keywords = resolveKeywords(url)

            if (isChatCategory(url)) {
                if (!session || !isStaffChatHandle(session.user.handle)) {
                    return json({
                        title: 'Staff Chat',
                        pageCount: 1,
                        items: [],
                        searches: [],
                    })
                }
                const messages = await chatStub(env).listMessages().catch(() => [])
                const pinnedId = await chatStub(env).getPinnedId().catch(() => null)
                const chatItem = buildChatPostItem(messages, pinnedId)
                return json({
                    title: 'Staff Chat',
                    pageCount: 1,
                    items: page === 0 ? [chatItem] : [],
                    searches: [],
                })
            }

            const category = resolveCategory(url)
            let posts = category
                ? await lobby(env).listPosts(category)
                : [
                    ...(await lobby(env).listPosts('announcements')),
                    ...(await lobby(env).listPosts('posts')),
                    ...(await lobby(env).listPosts('results')),
                ]

            if (keywords) {
                posts = posts.filter((p) => {
                    const t = String(p.item?.title ?? '').toLowerCase()
                    const s = String(p.item?.subtitle ?? '').toLowerCase()
                    const d = String(p.description ?? '').toLowerCase()
                    return t.includes(keywords) || s.includes(keywords) || d.includes(keywords)
                })
            }

            const sorted = sortPostsPinnedFirst(posts)
            const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
            const slice = sorted.slice(page * pageSize, page * pageSize + pageSize)

            return json({
                title: category ? POST_LABELS[category].section : 'Posts',
                pageCount,
                items: slice.map(buildPostItemWithBadges),
                searches: [],
            })
        }

        if (path === '/sonolus/posts/create' && req.method === 'POST') {
            const session = await sessionOf(req, env, url)
            if (!session) return new Response(null, { status: 401 })
            if (!canManagePosts(session)) {
                return message(403, 'Only handle 163292 can create posts.')
            }

            let body: any
            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid request body.')
            }

            const values = new URLSearchParams(String(body?.values ?? ''))
            const category = resolveCategory(url, req, body, values) ?? 'posts'
            const title = (values.get('title') ?? values.get('Title') ?? body?.title ?? '').trim()
            const description = (values.get('description') ?? values.get('Description') ?? body?.description ?? '').trim()

            if (!title && !description) {
                return message(400, 'Enter a title or description.')
            }

            const finalTitle = title || description.split('\n')[0]!.slice(0, 60)
            const name = `${category}-${randomId(10)}`
            const now = Date.now()
            const item = {
                name,
                version: 1 as const,
                title: finalTitle,
                subtitle: formatAuthorTag(session.user.name, session.user.handle),
                time: now,
                author: formatAuthorTag(session.user.name, session.user.handle),
                tags: [],
            }

            await lobby(env).createPost(category, {
                name,
                category,
                description,
                item,
                likes: [],
                comments: [],
            })

            return json({ item })
        }

        const postCommunityPath = path.match(/^\/sonolus\/posts\/([^/]+)\/community$/)
        if (postCommunityPath && req.method === 'GET') {
            const name = decodeURIComponent(postCommunityPath[1]!)
            const page = Math.max(0, Number(url.searchParams.get('page') ?? '0') || 0)
            const session = await sessionOf(req, env, url)

            if (isChatItemName(name)) {
                if (!session || !isStaffChatHandle(session.user.handle)) {
                    return message(403, 'Staff chat is restricted to staff handles.')
                }
                const messages = await chatStub(env).listMessages().catch(() => [])
                const formatted = formatChatCommunityComments(messages, session, page)
                return json({
                    actions: [chatActionForm],
                    pageCount: formatted.pageCount,
                    comments: formatted.comments,
                    reviews: [],
                })
            }

            const post = await lobby(env).getPost(name)
            if (!post) return new Response(null, { status: 404 })

            const formatted = formatPostComments(post, session, page)
            return json({
                actions: [postCommentForm],
                pageCount: formatted.pageCount,
                comments: formatted.comments,
                reviews: [],
            })
        }

        const postCommunitySubmitPath = path.match(/^\/sonolus\/posts\/([^/]+)\/community\/submit$/)
        if (postCommunitySubmitPath && req.method === 'POST') {
            const session = await sessionOf(req, env, url)
            if (!session) return new Response(null, { status: 401 })

            const name = decodeURIComponent(postCommunitySubmitPath[1]!)
            let body: any
            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid comment request.')
            }

            const values = new URLSearchParams(String(body?.values ?? ''))
            const actionType = values.get('type') || url.searchParams.get('type') || ''

            if (actionType === 'deleteComment') {
                const commentId = String(body?.commentName ?? body?.commentId ?? body?.target ?? values.get('commentName') ?? values.get('id') ?? url.searchParams.get('commentName') ?? '').trim()
                if (!commentId) return message(400, 'Missing comment id.')

                if (isChatItemName(name)) {
                    if (!isStaffChatHandle(session.user.handle)) {
                        return message(403, 'Staff chat is restricted to staff handles.')
                    }
                    const messages = await chatStub(env).listMessages().catch(() => [])
                    const existing = messages.find((m) => m.id === commentId)
                    if (!existing) return message(404, 'Comment not found.')
                    if (!canDeleteComment(session, existing.handle)) {
                        return message(403, 'Only 163292 can delete other users messages.')
                    }
                    await chatStub(env).deleteMessage(commentId)
                    return json({})
                }

                const post = await lobby(env).getPost(name)
                if (!post) return new Response(null, { status: 404 })
                const comment = (post.comments ?? []).find((c) => c.id === commentId)
                if (!comment) return message(404, 'Comment not found.')
                if (!canDeleteComment(session, comment.handle)) {
                    return message(403, 'Only 163292 can delete other users comments.')
                }
                await lobby(env).deletePostComment(name, commentId)
                return json({})
            }

            const text = extractCommentText(values)
            if (!text) return message(400, 'Comment cannot be empty.')

            if (isChatItemName(name)) {
                if (!isStaffChatHandle(session.user.handle)) {
                    return message(403, 'Staff chat is restricted to staff handles.')
                }
                const sentMsg: ChatMessage = {
                    id: randomId(12),
                    handle: session.user.handle,
                    author: session.user.name || session.user.handle,
                    text: text.slice(0, 500),
                    time: Date.now(),
                }
                await chatStub(env).postMessage(sentMsg)
                await sendChatEmailNotifications(env, sentMsg).catch((err) => {
                    console.error('[Email] Notification dispatch failed:', err)
                })
                return json({})
            }

            const post = await lobby(env).getPost(name)
            if (!post) return new Response(null, { status: 404 })

            await lobby(env).addPostComment(name, {
                id: randomId(12),
                handle: session.user.handle,
                author: session.user.name || session.user.handle,
                text: text.slice(0, 500),
                time: Date.now(),
            })

            return json({})
        }

        const postSubmitPath = path.match(/^\/sonolus\/posts\/([^/]+)\/submit$/)
        if (postSubmitPath && req.method === 'POST') {
            const session = await sessionOf(req, env, url)
            if (!session) return new Response(null, { status: 401 })

            const name = decodeURIComponent(postSubmitPath[1]!)
            let body: any
            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid action body.')
            }

            const values = new URLSearchParams(String(body?.values ?? ''))
            const actionType = values.get('type') || url.searchParams.get('type') || ''

            if (isChatItemName(name)) {
                if (!isStaffChatHandle(session.user.handle)) {
                    return message(403, 'Staff chat is restricted to staff handles.')
                }
                const text = extractCommentText(values)
                if (!text) return message(400, 'Message cannot be empty.')
                const sentMsg: ChatMessage = {
                    id: randomId(12),
                    handle: session.user.handle,
                    author: session.user.name || session.user.handle,
                    text: text.slice(0, 500),
                    time: Date.now(),
                }
                await chatStub(env).postMessage(sentMsg)
                await sendChatEmailNotifications(env, sentMsg).catch((err) => {
                    console.error('[Email] Notification dispatch failed:', err)
                })
                return json({})
            }

            const post = await lobby(env).getPost(name)
            if (!post) return new Response(null, { status: 404 })

            if (actionType === 'likePost') {
                const updated = await lobby(env).togglePostLike(name, session.user.handle)
                if (!updated) return new Response(null, { status: 404 })
                return json({
                    item: buildPostItemWithBadges(updated),
                    actions: postActionsFor(updated, session),
                })
            }

            if (!canManagePosts(session)) {
                return message(403, 'Only handle 163292 can edit, pin, or delete posts.')
            }

            if (actionType === 'pinPost') {
                const updated = await lobby(env).togglePostPin(name)
                if (!updated) return new Response(null, { status: 404 })
                return json({
                    item: buildPostItemWithBadges(updated),
                    actions: postActionsFor(updated, session),
                })
            }

            if (actionType === 'editPost') {
                const title = (values.get('title') ?? values.get('Title') ?? '').trim()
                const description = (values.get('description') ?? values.get('Description') ?? '').trim()
                const updated = await lobby(env).updatePost(name, {
                    ...(title ? { title } : {}),
                    description,
                })
                if (!updated) return new Response(null, { status: 404 })
                return json({
                    item: buildPostItemWithBadges(updated),
                    description: updated.description,
                    actions: postActionsFor(updated, session),
                })
            }

            if (actionType === 'deletePost') {
                await lobby(env).deletePost(name)
                return json({ shouldRemoveItem: true })
            }

            return message(400, 'Unknown post action.')
        }

        const postItemPath = path.match(/^\/sonolus\/posts\/([^/]+)$/)
        if (postItemPath && req.method === 'GET') {
            const name = decodeURIComponent(postItemPath[1]!)
            const session = await sessionOf(req, env, url)

            if (isChatItemName(name)) {
                if (!session || !isStaffChatHandle(session.user.handle)) {
                    return message(403, 'Staff chat is restricted to staff handles.')
                }
                const messages = await chatStub(env).listMessages().catch(() => [])
                const pinnedId = await chatStub(env).getPinnedId().catch(() => null)
                const chatItem = buildChatPostItem(messages, pinnedId)
                const formattedText = messages.length
                    ? messages.map((m) => `${formatAuthorTag(m.author, m.handle)}: ${m.text}`).join('\n\n')
                    : 'No messages yet.'
                return json({
                    item: chatItem,
                    description: formattedText,
                    actions: [chatActionForm],
                    hasCommunity: true,
                    leaderboards: [],
                    sections: [],
                })
            }

            const post = await lobby(env).getPost(name)
            if (!post) return new Response(null, { status: 404 })

            const likesCount = (post.likes ?? []).length
            const descriptionWithLikes = likesCount > 0
                ? `${post.description}\n\n♥ ${likesCount}`
                : post.description

            return json({
                item: buildPostItemWithBadges(post),
                description: descriptionWithLikes,
                actions: postActionsFor(post, session),
                hasCommunity: true,
                leaderboards: [],
                sections: [],
            })
        }

        if (path === '/sonolus/authenticate' && req.method === 'POST') {
            const raw = new Uint8Array(await req.arrayBuffer())
            const body = await verifySigned(req, env, raw, 'authenticate')
            if (!body) return new Response(null, { status: 401 })

            const user = profileOf(body.userProfile)
            const exp = Date.now() + 24 * 60 * 60 * 1000
            const authSession: AuthSession = { user, exp }

            return json({
                session: await signToken(env.SESSION_SECRET, authSession),
                userProfile: user,
                expire: exp,
            })
        }

        if (path === '/sonolus/rooms/info' && req.method === 'GET') {
            const session = await sessionOf(req, env, url)
            const isTournamentHost = session?.user.handle === TOURNAMENT_HOST_HANDLE
            const editionOptions = await getAvailableEditions().catch((error) => {
                console.error('[ROOMS INFO] Could not load editions:', error)
                return [] as string[]
            })

            return json({
                creates: session
                    ? roomForms(isTournamentHost, editionOptions)
                    : [],
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
            const items = await roomItems(env, session)

            return json({
                pageCount: 1,
                items,
                searches: [],
            })
        }

        if (path === '/sonolus/rooms/create' && req.method === 'POST') {
            const session = await sessionOf(req, env, url)
            if (!session) return new Response(null, { status: 401 })

            await lobby(env).prune(session.user.id).catch(() => {})

            let body: any
            try {
                body = await req.json()
            } catch {
                return message(400, 'Invalid room options.')
            }

            const settings = parseSettings(body?.values)
            if (!settings) {
                return message(400, 'Invalid room options or edition.')
            }

            const isTournamentHost = session.user.handle === TOURNAMENT_HOST_HANDLE

            if (
                settings.type !== 'casualRoom' &&
                settings.type !== 'rankedRoom' &&
                !isTournamentHost
            ) {
                return message(
                    403,
                    'Only the tournament host can create Championship rooms.',
                )
            }

            if (settings.type === 'casualRoom') {
                settings.scoring = 'pp'
            }

            const name = randomId(12)
            const key = randomId(16)
            const stub = roomStub(env, name)

            await stub.reserve(name, {
                key,
                hostId: session.user.id,
                hostName: session.user.name,
                hostHandle: session.user.handle,
            })

            const configured = await stub.configure(key, settings, session.user)
            if (!configured) {
                await stub.closeForOwner(session.user.id).catch(() => {})
                return message(400, 'Could not configure room.')
            }

            const exp = Date.now() + 24 * 60 * 60 * 1000
            const join: JoinSession = {
                room: name,
                user: session.user,
                roomUser: {
                    authentication: randomId(16),
                    signature: randomId(24),
                },
                exp,
            }

            const ws = new URL(addressOf(req, env))
            ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:'
            ws.pathname = `/sonolus/rooms/${name}/connect`

            return json({
                name,
                address: ws.toString(),
                key: await signToken(env.SESSION_SECRET, join),
                roomUser: join.roomUser,
                expire: exp,
            })
        }

        const roomDetailsPath = path.match(/^\/sonolus\/rooms\/([^/]+)$/)
        if (roomDetailsPath && req.method === 'GET') {
            const name = roomDetailsPath[1]!
            const session = await sessionOf(req, env, url)
            const stub = roomStub(env, name)
            const summary = await stub.summary()

            if (!summary) {
                await lobby(env).remove(name)
                return new Response(null, { status: 404 })
            }

            if (summary.visibility === 'private') {
                const canJoin = session ? await stub.canJoin(session.user) : 'Private room'
                if (canJoin) {
                    return message(403, canJoin)
                }
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
                description: `${summary.title}\nHost: ${summary.master}\n${summary.subtitle}`,
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            })
        }

        const roomJoinPath = path.match(/^\/sonolus\/rooms\/([^/]+)\/join$/)
        if (roomJoinPath && req.method === 'POST') {
            const name = roomJoinPath[1]!
            const raw = new Uint8Array(await req.arrayBuffer())
            const body = await verifySigned(req, env, raw, 'joinRoom')
            if (!body) return new Response(null, { status: 401 })

            const user = profileOf(body.userProfile)
            const stub = roomStub(env, name)
            const reason = await stub.canJoin(user)

            if (reason) {
                return message(403, reason)
            }

            const exp = Date.now() + 24 * 60 * 60 * 1000
            const join: JoinSession = {
                room: name,
                user,
                roomUser: {
                    authentication: randomId(16),
                    signature: randomId(24),
                },
                exp,
            }

            const ws = new URL(addressOf(req, env))
            ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:'
            ws.pathname = `/sonolus/rooms/${name}/connect`

            return json({
                address: ws.toString(),
                key: await signToken(env.SESSION_SECRET, join),
                roomUser: join.roomUser,
                expire: exp,
            })
        }

        const roomConnectPath = path.match(/^\/sonolus\/rooms\/([^/]+)\/connect$/)
        if (roomConnectPath) {
            const name = roomConnectPath[1]!
            const token = url.searchParams.get('key')
            const join = token ? await verifyToken<JoinSession>(env.SESSION_SECRET, token) : null

            if (!join || join.room !== name) {
                return new Response('Unauthorized', { status: 401 })
            }

            const headers = new Headers(req.headers)
            headers.set('x-join', encodeURIComponent(JSON.stringify(join)))

            return roomStub(env, name).fetch(
                new Request(req.url, {
                    method: req.method,
                    headers,
                }),
            )
        }

        if (path === '/sonolus/levels/info' && req.method === 'GET') {
            const customCharts = await getCustomLevels(env)
            const cachedItems = await getCachedLevelItemsForCharts(env, customCharts)

            if (cachedItems) {
                return json({
                    title: 'Custom Levels',
                    creates: [],
                    searches: [],
                    sections: [
                        {
                            title: 'Custom Levels',
                            itemType: 'level',
                            items: cachedItems.slice(0, 20),
                        },
                    ],
                })
            }

            const loaded = await loadLevelItems(customCharts)

            return json({
                title: 'Custom Levels',
                creates: [],
                searches: [],
                sections: [
                    {
                        title: 'Custom Levels',
                        itemType: 'level',
                        items: loaded.slice(0, 20).map((entry) => entry.item),
                    },
                ],
            })
        }

        if (path === '/sonolus/levels/list' && req.method === 'GET') {
            const page = Math.max(0, Number(url.searchParams.get('page') ?? '0') || 0)
            const keywords = resolveKeywords(url)
            const pageSize = 20

            const paged = await getCustomLevelPage(env, page, pageSize, keywords)
            const cachedItems = await getCachedLevelItemsForCharts(env, paged.items)
            const items = cachedItems ?? (await loadLevelItems(paged.items)).map((entry) => entry.item)

            return json({
                title: 'Custom Levels',
                pageCount: paged.pageCount,
                items,
                searches: [],
            })
        }

        const makePlaylistItems = async () => {
            const playlists = await getPlaylists(env)

            return Promise.all(
                playlists.map(async (playlist) => {
                    const cached = await getCachedLevelItemsForCharts(
                        env,
                        playlist.charts,
                    )
                    const levels = cached ??
                        (await loadLevelItems(playlist.charts)).map(
                            (entry) => entry.item,
                        )

                    return {
                        name: playlistSlug(playlist.name) || playlist.name,
                        version: 1 as const,
                        title: playlist.name,
                        subtitle: `${levels.length} levels`,
                        author: SERVER_TITLE,
                        tags: [],
                        levels,
                    }
                }),
            )
        }

        if (path === '/sonolus/playlists/info' && req.method === 'GET') {
            try {
                const items = await makePlaylistItems()

                return json({
                    title: 'Playlists',
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
                console.error('[Playlists] Could not load playlists:', error)
                return message(502, 'Could not load playlists.')
            }
        }

        if (path === '/sonolus/playlists/list' && req.method === 'GET') {
            try {
                const page = Math.max(0, Number(url.searchParams.get('page') ?? '0') || 0)
                const keywords = resolveKeywords(url)
                const pageSize = 20
                let items = await makePlaylistItems()

                if (keywords) {
                    items = items.filter((item) =>
                        String(item.title).toLowerCase().includes(keywords),
                    )
                }

                const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
                const slice = items.slice(page * pageSize, page * pageSize + pageSize)

                return json({
                    title: 'Playlists',
                    pageCount,
                    items: slice,
                    searches: [],
                })
            } catch (error) {
                console.error('[Playlists] Could not list playlists:', error)
                return message(502, 'Could not list playlists.')
            }
        }

        const playlistDetailsPath = path.match(/^\/sonolus\/playlists\/([^/]+)$/)
        if (playlistDetailsPath && req.method === 'GET') {
            try {
                const rawName = decodeURIComponent(playlistDetailsPath[1]!)
                const items = await makePlaylistItems()
                const item = items.find(
                    (entry) =>
                        samePlaylist(entry.name, rawName) ||
                        samePlaylist(playlistSlug(entry.name), rawName),
                )

                if (!item) {
                    return new Response(null, { status: 404 })
                }

                return json({
                    item,
                    description: `${item.title} (${item.levels.length} levels)`,
                    actions: [],
                    hasCommunity: false,
                    leaderboards: [],
                    sections: [],
                })
            } catch (error) {
                console.error('[Playlists] Could not load playlist details:', error)
                return message(502, 'Could not load playlist details.')
            }
        }

        const levelSubPath = path.match(/^\/sonolus\/levels\/([^/]+)\/(.+)$/)
        if (levelSubPath) {
            const name = decodeURIComponent(levelSubPath[1]!)
            const rest = levelSubPath[2]!
            const chart = await findChart(name, env)

            if (chart && isUnch(chart)) {
                return proxyToUnch(req, url, chart, rest)
            }
        }

        const levelDetailsPath = path.match(/^\/sonolus\/levels\/([^/]+)$/)
        if (levelDetailsPath && req.method === 'GET') {
            const name = decodeURIComponent(levelDetailsPath[1]!)
            const chart = await findChart(name, env)

            if (!chart) {
                return new Response(null, { status: 404 })
            }

            if (isUnch(chart)) {
                const details = await remoteLevelDetails(chart)
                if (!details) return new Response(null, { status: 404 })

                return json({
                    ...details,
                    actions: [],
                    hasCommunity: false,
                    leaderboards: [],
                    sections: [],
                })
            }

            const details = await remoteLevelDetails(chart)
            if (!details) {
                return new Response(null, { status: 404 })
            }

            return json({
                ...details,
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            })
        }

        const assetMatch = path.match(/^\/sonolus\/(?:repository|assets)\/(.+)$/)
        if (assetMatch && req.method === 'GET') {
            const key = decodeURIComponent(assetMatch[1]!)
            for (const b of bucketsForRead(env)) {
                const obj = await b.get(key).catch(() => null)
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

        return new Response('Not found', { status: 404 })
    },
}