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
import type { AuthSession, ChatMessage, Env, JoinSession, UserProfile } from './types.ts'
import type { PostCategory, PostComment, StoredPost } from './lobby.ts'

export { Room } from './room.ts'
export { Lobby } from './lobby.ts'

const CHAT_PFP_HANDLES = ['163292', '283420', '3227470'] as const
const CHAT_PFP_HANDLE_SET = new Set<string>(CHAT_PFP_HANDLES)
const CHAT_HANDLE_COOKIE = 'xx_chat_handle'

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

type UserChatPrefs = {
    handle: string
    displayName: string
    pfpKey?: string
    updatedAt: number
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

const addressOf = (req: Request, env: Env) =>
    (env.PUBLIC_ADDRESS ?? new URL(req.url).origin).replace(/\/+$/, '')

const isDevSkipSignature = (env: Env): boolean =>
    String(env.DEV_SKIP_SIGNATURE ?? '').trim().toLowerCase() === 'true'

const isStaffChatHandle = (handle?: string | null): boolean =>
    Boolean(
        handle &&
        (STAFF_CHAT_HANDLES as readonly string[]).includes(String(handle).trim()),
    )

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

async function getUserChatPrefs(env: Env, handle: string): Promise<UserChatPrefs> {
    const clean = String(handle ?? '').trim()
    const fallback: UserChatPrefs = {
        handle: clean,
        displayName: defaultDisplayName(clean),
        updatedAt: 0,
    }

    if (!clean || !env.COMMUNITY_BUCKET) return fallback

    try {
        const obj = await env.COMMUNITY_BUCKET.get(`chat/users/${clean}.json`)
        if (!obj) return fallback
        const parsed = await obj.json() as Partial<UserChatPrefs>
        const displayName = String(parsed?.displayName ?? '').trim().slice(0, 40)
        return {
            handle: clean,
            displayName: displayName || fallback.displayName,
            pfpKey: typeof parsed?.pfpKey === 'string' ? parsed.pfpKey : undefined,
            updatedAt: Number(parsed?.updatedAt) || 0,
        }
    } catch {
        return fallback
    }
}

async function saveUserChatPrefs(
    env: Env,
    handle: string,
    displayName: string,
    pfpKey?: string,
): Promise<UserChatPrefs> {
    const clean = String(handle ?? '').trim()
    const current = await getUserChatPrefs(env, clean)
    const next: UserChatPrefs = {
        handle: clean,
        displayName: String(displayName ?? '').trim().slice(0, 40) || current.displayName,
        pfpKey: pfpKey ?? current.pfpKey,
        updatedAt: Date.now(),
    }

    if (env.COMMUNITY_BUCKET) {
        await env.COMMUNITY_BUCKET.put(
            `chat/users/${clean}.json`,
            JSON.stringify(next),
            { httpMetadata: { contentType: 'application/json' } },
        )
    }

    return next
}

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
    env: Env,
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
    env: Env,
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

const roomStub = (env: Env, name: string) =>
    env.ROOM.get(env.ROOM.idFromName(name))

const lobby = (env: Env) =>
    env.LOBBY.get(env.LOBBY.idFromName('main'))

const POST_LABELS: Record<PostCategory, {
    section: string
    create: string
    titlePlaceholder: string
    bodyPlaceholder: string
}> = {
    announcements: {
        section: 'Announcements',
        create: 'Post an announcement',
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
        create: 'Post results',
        titlePlaceholder: 'Result title',
        bodyPlaceholder: 'Write the results...',
    },
}

function parseCategoryString(raw: string | null | undefined): PostCategory | null {
    if (!raw) return null
    const clean = raw.trim().toLowerCase()
    if (clean === 'announcements' || clean === 'announcement') return 'announcements'
    if (clean === 'results' || clean === 'result') return 'results'
    if (clean === 'posts' || clean === 'post') return 'posts'
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
        urlSearchParams?.get('category'),
        bodySearchParams?.get('category'),
        values?.get('category'),
        bodyValueParams?.get('category'),
        url.searchParams.get('category'),
        body?.category,
        values?.get('type'),
        bodyValueParams?.get('type'),
        body?.type,
        url.searchParams.get('type'),
        url.searchParams.get('infoType'),
        url.searchParams.get('postType'),
        body?.infoType,
        body?.postType,
        urlSearchParams?.get('infoType'),
        bodySearchParams?.get('infoType'),
        urlSearchParams?.get('type'),
        bodySearchParams?.get('type'),
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

function externalChatUrl(req: Request, env: Env): string {
    return `${addressOf(req, env)}/chat`
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
        url.searchParams.get('category'),
        searchParams?.get('category'),
        searchParams?.get('infoType'),
        searchParams?.get('type'),
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

function renderStaffChatHtml(
    user: UserProfile | null,
    sessionToken: string,
    fromSonolus: boolean,
    prefsMap: Record<string, UserChatPrefs>,
): string {
    const cardsHtml = CHAT_PFP_HANDLES.map((handle) => {
        const pref = prefsMap[handle]
        const name = pref?.displayName || DEFAULT_CHAT_PROFILES[handle]?.name || handle
        return `<button type="button" class="pick-card" data-pick-handle="${escapeAttr(handle)}">
          <img class="pick-pfp" src="/api/chat/pfp/${escapeAttr(handle)}" alt="${escapeAttr(name)}"/>
          <span class="pick-name">${escapeAttr(name)}</span>
          <span class="pick-handle">#${escapeAttr(handle)}</span>
        </button>`
    }).join('')

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<meta name="theme-color" content="#0d0f14"/>
<link rel="manifest" href="/manifest.webmanifest"/>
<link rel="icon" type="image/png" href="/app-icon.png"/>
<link rel="apple-touch-icon" href="/app-icon.png"/>
<title>XX! Chat</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0f14;color:#f3f4f6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column;height:100dvh}
  header{padding:12px 16px;background:#151922;border-bottom:1px solid #242b3a;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .header-brand{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .app-logo{width:24px;height:24px;border-radius:6px;object-fit:cover;image-rendering:pixelated;border:1px solid #283042;background:#0d0f14}
  .header-right{display:flex;align-items:center;gap:8px}
  .badge{font-size:12px;color:#9ca3af;font-weight:500}
  .btn-sm{background:#232938;color:#e5e7eb;border:1px solid #374151;border-radius:8px;padding:4px 9px;font-size:11px;font-weight:600;cursor:pointer}
  .btn-sm:hover{border-color:#3b82f6}
  .btn-danger{color:#fca5a5;border-color:rgba(248,113,113,.45)}
  #picker{flex:1;display:none;flex-direction:column;align-items:center;justify-content:center;padding:24px 16px;gap:18px}
  #picker.open{display:flex}
  .picker-title{font-size:18px;font-weight:700;text-align:center}
  .picker-grid{display:grid;grid-template-columns:repeat(3,minmax(92px,130px));gap:14px}
  .pick-card{background:#151922;border:1px solid #283042;border-radius:14px;padding:12px;display:flex;flex-direction:column;align-items:center;gap:8px;color:#f3f4f6;cursor:pointer}
  .pick-card:hover{border-color:#3b82f6;background:#192131}
  .pick-pfp{width:64px;height:64px;aspect-ratio:1/1;border-radius:10px;object-fit:cover;image-rendering:pixelated;border:1px solid #283042;background:#0d0f14}
  .pick-name{font-size:13px;font-weight:700;text-align:center}
  .pick-handle{font-size:11px;color:#9ca3af}
  #chatView{flex:1;display:none;flex-direction:column;min-height:0}
  #chatView.open{display:flex}
  #messages{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
  .empty-state{color:#9ca3af;font-size:13px;text-align:center;margin:auto}
  .row{display:flex;align-items:flex-start;gap:8px;max-width:92%;transition:transform .14s ease;touch-action:pan-y}
  .row.me{align-self:flex-end;flex-direction:row-reverse}
  .row:not(.me){align-self:flex-start}
  .pfp{width:44px;height:44px;min-width:44px;min-height:44px;aspect-ratio:1/1;flex-shrink:0;border-radius:10px;object-fit:cover;image-rendering:pixelated;border:1px solid #283042;background:#151922}
  .msg{background:#191e2a;border:1px solid #283042;border-radius:12px;padding:9px 12px;flex:1;min-width:0;user-select:none}
  .row.me .msg{background:#1d2b45;border-color:#3b82f6}
  .meta{font-size:11px;color:#9ca3af;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;gap:8px}
  .meta-actions{display:flex;align-items:center;gap:6px}
  .reply-btn{background:transparent;color:#93c5fd;border:1px solid rgba(147,197,253,.3);border-radius:6px;padding:1px 6px;font-size:10px;cursor:pointer}
  .reply-btn:hover{background:rgba(59,130,246,.18)}
  .del-btn{background:transparent;color:#f87171;border:1px solid rgba(248,113,113,.35);border-radius:6px;padding:1px 6px;font-size:10px;cursor:pointer}
  .del-btn:hover{background:rgba(248,113,113,.15)}
  .reply-quote{font-size:11px;color:#cbd5e1;background:rgba(13,15,20,.45);border-left:2px solid #60a5fa;padding:3px 7px;border-radius:4px;margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .text{font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word}
  .msg-footer{margin-top:6px;display:flex;align-items:center;flex-wrap:wrap;gap:6px}
  .like-pill{display:inline-flex;align-items:center;gap:4px;background:rgba(244,63,94,.12);border:1px solid rgba(244,63,94,.35);border-radius:999px;padding:2px 6px;color:#fda4af}
  .like-avatars{display:inline-flex;align-items:center;gap:3px}
  .like-pfp{width:14px;height:14px;aspect-ratio:1/1;border-radius:4px;object-fit:cover;image-rendering:pixelated;border:1px solid rgba(255,255,255,.2)}
  .reply-banner{display:none;align-items:center;justify-content:space-between;gap:8px;background:#1e293b;border:1px solid #3b82f6;border-radius:8px;padding:6px 10px;font-size:12px;color:#dbeafe}
  .reply-banner.open{display:flex}
  .bottom-bar{background:#151922;border-top:1px solid #242b3a;padding:8px 12px 12px;display:flex;flex-direction:column;gap:8px}
  .shortcuts{display:flex;gap:8px;flex-wrap:wrap}
  .chip{background:#232938;color:#e5e7eb;border:1px solid #374151;border-radius:999px;padding:5px 12px;font-size:13px;font-weight:600;cursor:pointer}
  .chip:active{background:#3b82f6;color:#fff;border-color:#3b82f6}
  form{display:flex;gap:8px}
  input{flex:1;background:#0d0f14;color:#fff;border:1px solid #374151;border-radius:10px;padding:10px 12px;font-size:14px;outline:none}
  input:focus{border-color:#3b82f6}
  button[type=submit]{background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:0 16px;font-weight:700;font-size:14px;cursor:pointer}
  #settingsModal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);align-items:center;justify-content:center;padding:16px;z-index:20}
  #settingsModal.open{display:flex}
  .modal-card{width:100%;max-width:400px;background:#151922;border:1px solid #283042;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px}
  .modal-title{font-size:16px;font-weight:700}
  .field-label{font-size:12px;color:#9ca3af;margin-bottom:4px;display:block}
  .crop-box{position:relative;width:180px;height:180px;margin:6px auto;border-radius:12px;overflow:hidden;border:2px solid #3b82f6;background:#0d0f14;touch-action:none;cursor:grab}
  .crop-box img{position:absolute;top:0;left:0;transform-origin:top left;user-select:none;-webkit-user-drag:none}
  .modal-actions{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap}
  .modal-actions-right{display:flex;gap:8px}
</style>
</head>
<body>
  <header>
    <div class="header-brand">
      <img class="app-logo" src="/app-icon.png" alt="XX!"/>
      <span>XX! Chat</span>
    </div>
    <div class="header-right">
      <span id="userBadge" class="badge"></span>
      <button id="settingsBtn" type="button" class="btn-sm" style="display:none">Settings</button>
    </div>
  </header>
  <div id="picker">
    <div class="picker-title">Hi!, who are you?</div>
    <div class="picker-grid">${cardsHtml}</div>
  </div>
  <div id="chatView">
    <div id="messages"></div>
    <div class="bottom-bar">
      <div id="replyBanner" class="reply-banner">
        <span id="replyText"></span>
        <button id="cancelReplyBtn" type="button" class="btn-sm">Cancel</button>
      </div>
      <div id="shortcutsBar" class="shortcuts"></div>
      <form id="chatForm">
        <input id="chatInput" type="text" maxlength="500" placeholder="Send a message..." autocomplete="off"/>
        <button type="submit">Send</button>
      </form>
    </div>
  </div>
  <div id="settingsModal">
    <div class="modal-card">
      <div class="modal-title">Chat Settings</div>
      <div>
        <label class="field-label" for="displayNameInput">Display Name (also used for @mention)</label>
        <input id="displayNameInput" type="text" maxlength="40" placeholder="Your display name"/>
      </div>
      <div>
        <label class="field-label" for="pfpFileInput">Square 1:1 Profile Picture (R2)</label>
        <input id="pfpFileInput" type="file" accept="image/png,image/jpeg,image/webp"/>
        <div id="cropWrap" style="display:none;margin-top:8px">
          <div id="cropBox" class="crop-box">
            <img id="cropImg" alt="Crop preview"/>
          </div>
          <label class="field-label" for="zoomRange">Zoom</label>
          <input id="zoomRange" type="range" min="1" max="3" step="0.02" value="1"/>
        </div>
      </div>
      <div class="modal-actions">
        <button id="logoutBtn" type="button" class="btn-sm btn-danger">Log out</button>
        <div class="modal-actions-right">
          <button id="closeSettingsBtn" type="button" class="btn-sm">Close</button>
          <button id="saveSettingsBtn" type="button" class="btn-sm" style="background:#3b82f6;color:#fff;border-color:#3b82f6">Save</button>
        </div>
      </div>
    </div>
  </div>
<script>
  const STORAGE_KEY = 'xx_chat_handle';
  const COOKIE_NAME = ${JSON.stringify(CHAT_HANDLE_COOKIE)};
  const HOST_HANDLE = ${JSON.stringify(TOURNAMENT_HOST_HANDLE)};
  const knownHandles = ${JSON.stringify([...CHAT_PFP_HANDLES])};
  const tzMap = ${JSON.stringify(HANDLE_TIMEZONES)};
  const sonolusUser = ${JSON.stringify(fromSonolus && user ? user : null)};
  const sessionToken = ${JSON.stringify(fromSonolus ? sessionToken : '')};
  const prefsMap = ${JSON.stringify(prefsMap)};
  const defaultsMap = ${JSON.stringify(DEFAULT_CHAT_PROFILES)};

  const pickerEl = document.getElementById('picker');
  const chatViewEl = document.getElementById('chatView');
  const badgeEl = document.getElementById('userBadge');
  const settingsBtn = document.getElementById('settingsBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const box = document.getElementById('messages');
  const shortcutsBar = document.getElementById('shortcutsBar');
  const input = document.getElementById('chatInput');
  const replyBanner = document.getElementById('replyBanner');
  const replyTextEl = document.getElementById('replyText');
  const cancelReplyBtn = document.getElementById('cancelReplyBtn');

  const settingsModal = document.getElementById('settingsModal');
  const displayNameInput = document.getElementById('displayNameInput');
  const pfpFileInput = document.getElementById('pfpFileInput');
  const cropWrap = document.getElementById('cropWrap');
  const cropBox = document.getElementById('cropBox');
  const cropImg = document.getElementById('cropImg');
  const zoomRange = document.getElementById('zoomRange');

  let loggedOut = false;
  let activeReply = null;
  let currentMessages = [];
  let hasLoadedOnce = false;
  let cropState = { loaded: false, imgW: 0, imgH: 0, scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

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
      return { ...sonolusUser, name: displayNameFor(sonolusUser.handle, sonolusUser.name) };
    }
    const saved = readSavedHandle();
    if (saved && defaultsMap[saved]) {
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

  function render(messages) {
    currentMessages = Array.isArray(messages) ? messages : [];
    const active = getActiveUser();
    const myHandle = active ? active.handle : '';

    if (currentMessages.length === 0) {
      box.innerHTML = '<div class="empty-state">No messages yet.</div>';
      return;
    }

    box.innerHTML = currentMessages.map((m) => {
      const time = formatAuthorTime(m);
      const mine = m.handle === myHandle ? 'me' : '';
      const canDelete = myHandle && (m.handle === myHandle || myHandle === HOST_HANDLE);
      const pfpImg = '<img class="pfp" src="' + escapeHtml(pfpUrlFor(m.handle)) + '" alt=""/>';
      const replyHtml = m.replyTo
        ? '<div class="reply-quote">Replying to ' + escapeHtml(m.replyTo.author || m.replyTo.handle || '') + ': ' + escapeHtml(m.replyTo.text || '') + '</div>'
        : '';
      const delHtml = canDelete
        ? '<button type="button" class="del-btn" data-delete-id="' + escapeHtml(m.id) + '">Delete</button>'
        : '';

      const likers = Array.isArray(m.likes) ? m.likes : [];
      const avatarsHtml = likers.map((h) =>
        '<img class="like-pfp" src="' + escapeHtml(pfpUrlFor(h)) + '" alt="' + escapeHtml(h) + '"/>'
      ).join('');
      const likeBadgeHtml = likers.length > 0
        ? '<span class="like-pill">♥ <span class="like-avatars">' + avatarsHtml + '</span></span>'
        : '';

      return '<div class="row ' + mine + '" data-row-id="' + escapeHtml(m.id) + '">' +
        pfpImg +
        '<div class="msg" data-msg-id="' + escapeHtml(m.id) + '">' +
          '<div class="meta"><span>' + escapeHtml(formatTag(m.author, m.handle)) + ' · ' + escapeHtml(time) + '</span>' +
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
    box.scrollTop = box.scrollHeight;
  }

  async function loadMessages() {
    const active = getActiveUser();
    if (!active) return;
    if (!hasLoadedOnce) {
      box.innerHTML = '<div class="empty-state">Loading messages...</div>';
    }
    try {
      const qs = 'handle=' + encodeURIComponent(active.handle) + '&t=' + Date.now();
      const res = await fetch('/api/chat?' + qs, {
        headers: authHeaders(),
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(await res.text() || ('HTTP ' + res.status));
      const data = await res.json();
      if (data.prefs) {
        Object.assign(prefsMap, data.prefs);
        renderKnownUserChips();
      }
      hasLoadedOnce = true;
      render(Array.isArray(data.messages) ? data.messages : []);
    } catch (error) {
      console.error('Could not load chat messages:', error);
      if (!hasLoadedOnce) {
        box.innerHTML = '<div class="empty-state">Could not load messages.</div>';
      }
    }
  }

  function syncMode() {
    const active = getActiveUser();
    if (!active) {
      badgeEl.textContent = 'Pick profile';
      settingsBtn.style.display = 'none';
      pickerEl.classList.add('open');
      chatViewEl.classList.remove('open');
      return;
    }

    const wasOpen = chatViewEl.classList.contains('open');

    badgeEl.textContent = formatTag(active.name, active.handle);
    settingsBtn.style.display = 'inline-block';
    pickerEl.classList.remove('open');
    chatViewEl.classList.add('open');
    renderKnownUserChips();

    if (!wasOpen) void loadMessages();
  }

  logoutBtn.addEventListener('click', () => {
    loggedOut = true;
    hasLoadedOnce = false;
    persistHandle('');
    currentMessages = [];
    render([]);
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
      render(data.messages || []);
    }
  }

  function updateCropTransform() {
    if (!cropState.loaded) return;
    const boxSize = 180;
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
          imgW: cropImg.naturalWidth || 180,
          imgH: cropImg.naturalHeight || 180,
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
    const boxSize = 180;
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

  settingsBtn.addEventListener('click', () => {
    const active = getActiveUser();
    if (!active) return;
    displayNameInput.value = active.name;
    pfpFileInput.value = '';
    zoomRange.value = '1';
    cropWrap.style.display = 'none';
    cropState.loaded = false;
    settingsModal.classList.add('open');
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.remove('open');
  });

  saveSettingsBtn.addEventListener('click', async () => {
    const active = getActiveUser();
    if (!active) return;
    const displayName = displayNameInput.value.trim() || active.name;
    const croppedPng = await buildCroppedSquareDataUrl();
    const res = await fetch('/api/chat/settings', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'same-origin',
      body: JSON.stringify({
        handle: active.handle,
        displayName,
        pfpDataUrl: croppedPng,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.prefs) {
        prefsMap[active.handle] = data.prefs;
      }
      settingsModal.classList.remove('open');
      syncMode();
    }
  });

  document.querySelectorAll('[data-pick-handle]').forEach((card) => {
    card.addEventListener('click', () => {
      const picked = card.getAttribute('data-pick-handle') || '';
      if (!defaultsMap[picked]) return;
      loggedOut = false;
      hasLoadedOnce = false;
      persistHandle(picked);
      syncMode();
    });
  });

  let swipeRow = null;
  let swipeStartX = 0;
  let swipeDeltaX = 0;
  let lastTapId = '';
  let lastTapAt = 0;

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
      swipeDeltaX = Math.min(80, dx);
      swipeRow.style.transform = 'translateX(' + swipeDeltaX + 'px)';
    }
  }, { passive: true });

  box.addEventListener('touchend', () => {
    if (!swipeRow) return;
    const rowId = swipeRow.getAttribute('data-row-id') || '';
    swipeRow.style.transform = '';
    const triggered = swipeDeltaX >= 48;
    swipeRow = null;
    swipeDeltaX = 0;
    if (triggered && rowId) {
      const target = currentMessages.find((m) => m.id === rowId);
      if (target) setReplyTarget(target);
    }
  });

  box.addEventListener('dblclick', async (e) => {
    const msgEl = e.target.closest('[data-msg-id]');
    if (!msgEl) return;
    const id = msgEl.getAttribute('data-msg-id');
    if (id) await toggleLikeMessage(id);
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
        render(data.messages || []);
      }
      return;
    }

    const msgEl = e.target.closest('[data-msg-id]');
    if (msgEl) {
      const id = msgEl.getAttribute('data-msg-id') || '';
      const now = Date.now();
      if (id && id === lastTapId && now - lastTapAt < 320) {
        lastTapId = '';
        lastTapAt = 0;
        await toggleLikeMessage(id);
      } else {
        lastTapId = id;
        lastTapAt = now;
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
      render(data.messages || []);
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }

  syncMode();
</script>
</body>
</html>`
}

async function roomItems(env: Env, _session: AuthSession | null) {
    const rooms = await lobby(env).list()

    const items = await Promise.all(
        rooms.map(async (room) => {
            const current = await roomStub(env, room.name).summary()

            if (!current) {
                await lobby(env).remove(room.name)
                return null
            }

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

function postForm(category: PostCategory) {
    const label = POST_LABELS[category]

    return {
        name: category,
        type: category,
        title: label.create,
        requireConfirmation: false,
        options: [
            {
                name: 'title',
                query: 'title',
                required: false,
                type: 'text',
                def: '',
                placeholder: label.titlePlaceholder,
                limit: 100,
                shortcuts: [],
            },
            {
                name: 'description',
                query: 'description',
                required: false,
                type: 'textArea',
                def: '',
                placeholder: label.bodyPlaceholder,
                limit: 2000,
                shortcuts: [],
            },
            {
                name: 'thumbnail',
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
    const actions = [
        makeLikePostForm(liked),
        makePinPostForm(pinned),
    ]
    if (canManagePosts(session)) {
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

function localizedTitle(value: any): string {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') {
        if (typeof value.en === 'string') return value.en
        const first = Object.values(value).find((entry) => typeof entry === 'string')
        return typeof first === 'string' ? first : ''
    }
    return ''
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

const UNCH_HOST = 'untitledcharts.com'

const isUnch = (chart: SheetChart) => {
    try {
        const host = new URL(chart.address).hostname
        return host === UNCH_HOST || host.endsWith(`.${UNCH_HOST}`)
    } catch {
        return false
    }
}

async function findChart(name: string, env: Env): Promise<SheetChart | null> {
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
        env: Env,
        ctx: ExecutionContext,
    ): Promise<void> {
        ctx.waitUntil(refreshDailyAssets(env))
    },

    async fetch(req: Request, env: Env): Promise<Response> {
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
                background_color: '#0d0f14',
                theme_color: '#0d0f14',
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
            if (!env.COMMUNITY_BUCKET) {
                return new Response(null, { status: 404 })
            }

            const keys = ['chat/XX!.png', 'chat/pfp/163292.png', 'chat/163292.png']
            for (const key of keys) {
                const obj = await env.COMMUNITY_BUCKET.get(key).catch(() => null)
                if (obj) {
                    return new Response(obj.body, {
                        headers: {
                            'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
                            'Access-Control-Allow-Origin': '*',
                            'Cache-Control': 'public, max-age=3600',
                        },
                    })
                }
            }

            return new Response(null, { status: 404 })
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
            if (!CHAT_PFP_HANDLE_SET.has(handle) || !env.COMMUNITY_BUCKET) {
                return new Response(null, { status: 404 })
            }

            const prefs = await getUserChatPrefs(env, handle)
            const keys = [
                prefs.pfpKey,
                `chat/pfp/${handle}.png`,
                `chat/${handle}.png`,
            ].filter((k): k is string => Boolean(k))

            for (const key of keys) {
                const obj = await env.COMMUNITY_BUCKET.get(key).catch(() => null)
                if (obj) {
                    return new Response(obj.body, {
                        headers: {
                            'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
                            'Access-Control-Allow-Origin': '*',
                            'Cache-Control': 'no-cache',
                        },
                    })
                }
            }

            return new Response(null, { status: 404 })
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
                if (env.COMMUNITY_BUCKET) {
                    pfpKey = `chat/pfp/${handle}.png`
                    await env.COMMUNITY_BUCKET.put(pfpKey, rawBytes, {
                        httpMetadata: { contentType: mime },
                    })
                }
            }

            const nextDisplayName = typeof body?.displayName === 'string' && body.displayName.trim()
                ? body.displayName.trim().slice(0, 40)
                : resolved.user.name

            const savedPrefs = await saveUserChatPrefs(env, handle, nextDisplayName, pfpKey)
            return json({ ok: true, prefs: savedPrefs })
        }

        if (path === '/chat' && req.method === 'GET') {
            const prefsEntries = await Promise.all(
                CHAT_PFP_HANDLES.map(async (h) => [h, await getUserChatPrefs(env, h)] as const),
            )
            const prefsMap = Object.fromEntries(prefsEntries)
            const resolved = await resolveChatUser(req, env, url)
            if (resolved) {
                return html(
                    renderStaffChatHtml(resolved.user, resolved.token, resolved.fromSonolus, prefsMap),
                )
            }
            return html(renderStaffChatHtml(null, '', false, prefsMap))
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
                const messages = await lobby(env).getChatMessagesFromR2()
                    .catch(() => lobby(env).listChatMessages().catch(() => []))
                return json({ messages, prefs: prefsMap })
            }

            if (req.method === 'POST') {
                if (body?.action === 'delete') {
                    const targetId = typeof body?.id === 'string' ? body.id.trim() : ''
                    if (!targetId) {
                        return message(400, 'Missing message id.')
                    }
                    const messages = await lobby(env).listChatMessages().catch(() => [])
                    const target = messages.find((m) => m.id === targetId)
                    if (!target) {
                        return message(404, 'Message not found.')
                    }
                    if (!canDeleteChatMessage(resolved.user.handle, target.handle)) {
                        return message(403, 'Only 163292 can delete messages from other members.')
                    }
                    await lobby(env).deleteChatMessage(targetId)
                    const updated = await lobby(env).listChatMessages().catch(() => [])
                    return json({ ok: true, messages: updated, prefs: prefsMap })
                }

                if (body?.action === 'like') {
                    const targetId = typeof body?.id === 'string' ? body.id.trim() : ''
                    if (!targetId) return message(400, 'Missing message id.')
                    await lobby(env).toggleChatLike(targetId, resolved.user.handle)
                    const updated = await lobby(env).listChatMessages().catch(() => [])
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

                await lobby(env).addChatMessage({
                    handle: resolved.user.handle,
                    author: resolved.user.name || resolved.user.handle,
                    text: text.slice(0, 500),
                    ...(replyTo ? { replyTo } : {}),
                })

                const messages = await lobby(env).listChatMessages().catch(() => [])
                return json({ ok: true, messages, prefs: prefsMap })
            }

            if (req.method === 'DELETE') {
                const id = (url.searchParams.get('id') ?? '').trim()
                if (!id) {
                    return message(400, 'Missing message id.')
                }
                const messages = await lobby(env).listChatMessages().catch(() => [])
                const target = messages.find((m) => m.id === id)
                if (!target) {
                    return message(404, 'Message not found.')
                }
                if (!canDeleteChatMessage(resolved.user.handle, target.handle)) {
                    return message(403, 'Only 163292 can delete messages from other members.')
                }
                await lobby(env).deleteChatMessage(id)
                const updated = await lobby(env).listChatMessages().catch(() => [])
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
            const object = await env.POSTS_BUCKET.get('server/banner.png')
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
                    lobby(env).listChatMessages().catch(() => []),
                    lobby(env).getPinnedChatId().catch(() => null),
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
                        ...(explicit
                            ? { searchValues: new URLSearchParams({ category: explicit }).toString() }
                            : {}),
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
                    lobby(env).listChatMessages().catch(() => []),
                    lobby(env).getPinnedChatId().catch(() => null),
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

                const messages = await lobby(env).listChatMessages().catch(() => [])
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

                await lobby(env).addChatMessage({
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

                const messages = await lobby(env).listChatMessages().catch(() => [])
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

                const messages = await lobby(env).listChatMessages().catch(() => [])
                const target = messages.find((m) => m.id === commentName)
                if (!target || !canDeleteComment(session, target.handle)) {
                    return message(403, 'You cannot delete this comment.')
                }

                await lobby(env).deleteChatMessage(commentName)
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

                await lobby(env).addChatMessage({
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
                env.POSTS_BUCKET?.delete(`posts/${postName}/thumbnail`) ?? Promise.resolve(),
                env.COMMUNITY_BUCKET?.delete(`${post.category}/${postName}/thumbnail`) ?? Promise.resolve(),
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

            await env.POSTS_BUCKET.put(
                `posts/${post.item.name}/thumbnail`,
                bytes,
                { httpMetadata: { contentType } },
            )

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

            const object =
                (await env.POSTS_BUCKET?.get(`posts/${name}/thumbnail`).catch(() => null)) ??
                (post && env.COMMUNITY_BUCKET
                    ? await env.COMMUNITY_BUCKET.get(`${post.category}/${name}/thumbnail`).catch(() => null)
                    : null)

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
                    lobby(env).listChatMessages().catch(() => []),
                    lobby(env).getPinnedChatId().catch(() => null),
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

            const post = await lobby(env).getPost(postPath[1]!).catch(() => null)
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
                const loaded = await loadLevelItems(charts)

                console.log(
                    `[Levels] Info page 0: ${loaded.length}/${charts.length} levels loaded. ${pageCount} pages total.`,
                )

                return json({
                    creates: [],
                    searches: [],
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

                const { charts, pageCount } = await getCustomLevelPage(page, env)

                if (page >= pageCount) {
                    return json({
                        pageCount,
                        items: [],
                        searches: [],
                    })
                }

                const loaded = await loadLevelItems(charts)

                return json({
                    pageCount,
                    items: loaded.map((entry) => entry.item),
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
            const playlists = await getPlaylists(env)

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
                const settings = parseSettings(url.searchParams, undefined, user.name || user.handle)
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