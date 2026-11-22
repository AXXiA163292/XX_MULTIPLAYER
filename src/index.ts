export { Room } from './room.ts'
export { Lobby } from './lobby.ts'
import {
    RANKED_ALLOWED_DIFFICULTIES,
    RANKED_MAX_RATING,
    RANKED_MIN_RATING,
    SERVER_DESCRIPTION,
    SERVER_TITLE,
    STAFF_CHAT_HANDLES,
    STAFF_CHAT_SHORTCUTS,
    TOURNAMENT_HOST_HANDLE,
} from './config.ts'
import {
    signToken,
    verifySonolusSignature,
    verifyToken,
} from './crypto.ts'
import { roomForms, parseSettings } from './forms.ts'
import type { Env, RoomUser } from './types.ts'

type SonolusUser = {
    id: string
    name: string
    handle: string
}

type SessionPayload = {
    user: SonolusUser
    exp: number
}

type LevelItem = {
    name: string
    title?: string
    artists?: string
    author?: string
    rating?: number
    tags?: { title: string }[]
    [key: string]: unknown
}

type ConstantRow = {
    input: string
    Constant: number
    Difficulty?: string
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const stripTrailingSlash = (value: string) => value.trim().replace(/\/+$/, '')

const getSessionSecret = (env: Env): string =>
    String((env as Record<string, unknown>).SESSION_SECRET ?? 'xx-championship-session-secret')

const isStaffChatUser = (handle?: string | null): boolean =>
    Boolean(
        handle &&
            (STAFF_CHAT_HANDLES as readonly string[]).includes(String(handle).trim()),
    )

async function parseUserFromRequest(
    request: Request,
    url: URL,
    env: Env,
): Promise<SonolusUser | null> {
    const secret = getSessionSecret(env)

    const sonolusSession =
        request.headers.get('Sonolus-Session') ??
        request.headers.get('sonolus-session') ??
        url.searchParams.get('session')

    if (sonolusSession) {
        const verified = await verifyToken<SessionPayload>(secret, sonolusSession.trim())
        if (verified?.user?.handle) {
            return {
                id: String(verified.user.id || verified.user.handle).trim(),
                name: String(verified.user.name || verified.user.handle).trim(),
                handle: String(verified.user.handle).trim(),
            }
        }
    }

    const handleHeader = request.headers.get('x-user-handle') ?? url.searchParams.get('handle')
    const idHeader = request.headers.get('x-user-id') ?? url.searchParams.get('userId') ?? handleHeader
    const nameHeader = request.headers.get('x-user-name') ?? url.searchParams.get('name') ?? handleHeader

    if (handleHeader || idHeader) {
        const handle = String(handleHeader ?? idHeader ?? '').trim()
        return {
            id: String(idHeader ?? handle).trim(),
            name: String(nameHeader ?? handle).trim(),
            handle,
        }
    }

    return null
}

function buildRoomUser(user: SonolusUser, request: Request): RoomUser {
    return {
        id: user.id,
        name: user.name,
        handle: user.handle,
        authentication: request.headers.get('Sonolus-Session') ?? '',
        signature: request.headers.get('Sonolus-Signature') ?? '',
    }
}

function buildStaffChatPostItem(unread: number, origin: string, sessionToken?: string) {
    const chatUrl = sessionToken
        ? `${origin}/chat?session=${encodeURIComponent(sessionToken)}`
        : `${origin}/chat`

    return {
        name: 'staff-chat',
        version: 1,
        title: unread > 0 ? `🔴 Chat (${unread})` : 'Chat',
        time: Date.now(),
        author: SERVER_TITLE,
        tags: [{ title: 'Chat' }],
        url: chatUrl,
    }
}

function normalizeConstantRows(raw: any): ConstantRow[] {
    const rows = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.rows)
            ? raw.rows
            : Array.isArray(raw?.customSongs)
                ? raw.customSongs
                : []

    const normalized: ConstantRow[] = []
    for (const entry of rows) {
        if (!entry || typeof entry !== 'object') continue
        const rawInput = String(entry.input ?? entry.Input ?? entry.url ?? '').trim()
        if (!rawInput) continue

        const c = Number(entry.Constant ?? entry.constant)
        if (!Number.isFinite(c) || c <= 0) continue

        const diffRaw = String(entry.Difficulty ?? entry.difficulty ?? '').trim().toUpperCase()
        normalized.push({
            input: stripTrailingSlash(rawInput),
            Constant: Math.round(c * 10) / 10,
            ...(diffRaw ? { Difficulty: diffRaw } : {}),
        })
    }
    return normalized
}

async function refreshR2FromSource(env: Env, url: URL): Promise<{
    ok: boolean
    constantsCount: number
    levelsCount: number
    sourceUsed: string | null
}> {
    if (!env.R2) {
        return { ok: false, constantsCount: 0, levelsCount: 0, sourceUsed: null }
    }

    const envAny = env as Record<string, unknown>
    const sourceUrl =
        url.searchParams.get('source') ||
        String(envAny.REFRESH_SOURCE_URL ?? envAny.SHEET_EXPORT_URL ?? '').trim()

    let constantsRows: ConstantRow[] = []
    let levelItems: LevelItem[] | null = null

    if (sourceUrl) {
        const res = await fetch(sourceUrl, {
            headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
            cache: 'no-store',
        })
        if (res.ok) {
            const payload = await res.json<any>().catch(() => null)
            constantsRows = normalizeConstantRows(payload)
            if (Array.isArray(payload?.levels)) {
                levelItems = payload.levels
            } else if (Array.isArray(payload?.items)) {
                levelItems = payload.items
            }
        }
    }

    if (constantsRows.length === 0) {
        const existingConst = await env.R2.get('constants.json').catch(() => null)
        if (existingConst) {
            const existingJson = await existingConst.json<any>().catch(() => null)
            constantsRows = normalizeConstantRows(existingJson)
        }
    }

    await env.R2.put('constants.json', JSON.stringify(constantsRows), {
        httpMetadata: { contentType: 'application/json' },
    })

    let levelsCount = 0
    if (levelItems && levelItems.length > 0) {
        await env.R2.put('levels/index.json', JSON.stringify({ items: levelItems }), {
            httpMetadata: { contentType: 'application/json' },
        })
        levelsCount = levelItems.length
    } else {
        const currentLevels = await getAllCatalogLevels(env, url)
        levelsCount = currentLevels.length
    }

    return {
        ok: true,
        constantsCount: constantsRows.length,
        levelsCount,
        sourceUsed: sourceUrl || 'existing-r2',
    }
}

async function getAllCatalogLevels(env: Env, url: URL): Promise<LevelItem[]> {
    if (env.R2) {
        for (const indexKey of ['levels/index.json', 'catalog/levels.json']) {
            const indexObj = await env.R2.get(indexKey).catch(() => null)
            if (indexObj) {
                const parsed = await indexObj.json<any>().catch(() => null)
                if (Array.isArray(parsed?.items)) return parsed.items
                if (Array.isArray(parsed)) return parsed
            }
        }

        const listed = await env.R2.list({ prefix: 'levels/' })
        const items: LevelItem[] = []

        for (const obj of listed.objects) {
            if (!obj.key.endsWith('.json') || obj.key.endsWith('index.json')) continue
            const raw = await env.R2.get(obj.key)
            if (!raw) continue
            try {
                const json = await raw.json<any>()
                const item = json?.item ?? json
                if (item && typeof item.name === 'string') {
                    items.push({
                        ...item,
                        title: typeof item.title === 'string'
                            ? item.title
                            : item.title?.en ?? item.name,
                        artists: typeof item.artists === 'string'
                            ? item.artists
                            : item.artists?.en ?? '',
                        author: typeof item.author === 'string'
                            ? item.author
                            : item.author?.en ?? '',
                    })
                }
            } catch {
                // Skip malformed JSON entry.
            }
        }

        if (items.length > 0) return items
    }

    const fallbackIndexUrl = new URL('/sonolus/levels/index.json', url.origin)
    const res = await fetch(fallbackIndexUrl.toString()).catch(() => null)
    if (res?.ok) {
        const data = await res.json<any>().catch(() => null)
        if (Array.isArray(data?.items)) return data.items
    }

    return []
}

function isRankedEligibleLevel(lvl: LevelItem): boolean {
    const rating = typeof lvl.rating === 'number' && Number.isFinite(lvl.rating)
        ? lvl.rating
        : NaN

    if (!Number.isFinite(rating) || rating < RANKED_MIN_RATING || rating > RANKED_MAX_RATING) {
        return false
    }

    const tags = Array.isArray(lvl.tags)
        ? lvl.tags.map((t) => String(t?.title ?? '').trim().toUpperCase())
        : []

    return tags.some((tag) => RANKED_ALLOWED_DIFFICULTIES.has(tag))
}

function filterCatalogLevels(levels: LevelItem[], searchParams: URLSearchParams): LevelItem[] {
    const keywords = (searchParams.get('keywords') ?? '').trim().toLowerCase()
    const hasMinRating = searchParams.has('minRating') && searchParams.get('minRating') !== ''
    const hasMaxRating = searchParams.has('maxRating') && searchParams.get('maxRating') !== ''
    const minRating = hasMinRating ? Number(searchParams.get('minRating')) : NaN
    const maxRating = hasMaxRating ? Number(searchParams.get('maxRating')) : NaN
    const difficulty = (searchParams.get('difficulty') ?? '').trim().toUpperCase()
    const rankedOnly = searchParams.get('ranked') === '1' || searchParams.get('bucket') === 'ranked'

    const terms = keywords ? keywords.split(/\s+/).filter(Boolean) : []

    return levels.filter((lvl) => {
        if (rankedOnly && !isRankedEligibleLevel(lvl)) {
            return false
        }

        if (terms.length > 0) {
            const tagTitles = Array.isArray(lvl.tags)
                ? lvl.tags.map((t) => String(t?.title ?? ''))
                : []

            const haystack = [
                lvl.name,
                lvl.title,
                lvl.artists,
                lvl.author,
                ...tagTitles,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()

            if (!terms.every((term) => haystack.includes(term))) {
                return false
            }
        }

        const rating = typeof lvl.rating === 'number' && Number.isFinite(lvl.rating)
            ? lvl.rating
            : 0

        if (hasMinRating && Number.isFinite(minRating) && rating < minRating) {
            return false
        }

        if (hasMaxRating && Number.isFinite(maxRating) && rating > maxRating) {
            return false
        }

        if (difficulty && difficulty !== 'ALL') {
            const tags = Array.isArray(lvl.tags)
                ? lvl.tags.map((t) => String(t?.title ?? '').toUpperCase())
                : []
            if (!tags.some((tag) => tag.includes(difficulty))) {
                return false
            }
        }

        return true
    })
}

function renderStaffChatHtml(user: SonolusUser, sessionToken: string): string {
    const shortcutsHtml = STAFF_CHAT_SHORTCUTS.map(
        (tag) =>
            `<button type="button" class="chip" onclick="insertShortcut(${JSON.stringify(tag)})">${tag}</button>`,
    ).join('')

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>${SERVER_TITLE} · Chat</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0f14;color:#f3f4f6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column;height:100dvh}
  header{padding:12px 16px;background:#151922;border-bottom:1px solid #242b3a;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:space-between}
  .badge{font-size:12px;color:#9ca3af;font-weight:500}
  #messages{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
  .msg{background:#191e2a;border:1px solid #283042;border-radius:12px;padding:9px 12px;max-width:85%}
  .msg.me{align-self:flex-end;background:#1d2b45;border-color:#3b82f6}
  .meta{font-size:11px;color:#9ca3af;margin-bottom:3px}
  .text{font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word}
  .bottom-bar{background:#151922;border-top:1px solid #242b3a;padding:8px 12px 12px;display:flex;flex-direction:column;gap:8px}
  .shortcuts{display:flex;gap:8px;flex-wrap:wrap}
  .chip{background:#232938;color:#e5e7eb;border:1px solid #374151;border-radius:999px;padding:5px 12px;font-size:13px;font-weight:600;cursor:pointer}
  .chip:active{background:#3b82f6;color:#fff;border-color:#3b82f6}
  form{display:flex;gap:8px}
  input{flex:1;background:#0d0f14;color:#fff;border:1px solid #374151;border-radius:10px;padding:10px 12px;font-size:14px;outline:none}
  input:focus{border-color:#3b82f6}
  button[type=submit]{background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:0 16px;font-weight:700;font-size:14px;cursor:pointer}
</style>
</head>
<body>
  <header>
    <span>💬 ${SERVER_TITLE} Chat</span>
    <span class="badge">${user.name} (${user.handle})</span>
  </header>
  <div id="messages"></div>
  <div class="bottom-bar">
    <div class="shortcuts">${shortcutsHtml}</div>
    <form id="chatForm">
      <input id="chatInput" type="text" maxlength="500" placeholder="Send a message..." autocomplete="off"/>
      <button type="submit">Send</button>
    </form>
  </div>
<script>
  const myHandle = ${JSON.stringify(user.handle)};
  const sessionToken = ${JSON.stringify(sessionToken)};
  const box = document.getElementById('messages');
  const input = document.getElementById('chatInput');

  function authHeaders(extra = {}) {
    const headers = { ...extra, 'x-user-handle': myHandle };
    if (sessionToken) headers['Sonolus-Session'] = sessionToken;
    return headers;
  }

  function insertShortcut(tag) {
    const current = input.value;
    const spacer = current && !current.endsWith(' ') ? ' ' : '';
    input.value = current + spacer + tag + ' ';
    input.focus();
  }

  function escapeHtml(str) {
    return String(str).replace(/[<>&"]/g, (ch) => ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
    }[ch] ?? ch));
  }

  function render(messages) {
    box.innerHTML = (messages || []).map((m) => {
      const time = new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const mine = m.handle === myHandle ? 'me' : '';
      return '<div class="msg ' + mine + '">' +
        '<div class="meta">' + escapeHtml(m.author) + ' (' + escapeHtml(m.handle) + ') · ' + escapeHtml(time) + '</div>' +
        '<div class="text">' + escapeHtml(m.text) + '</div>' +
      '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  async function loadMessages() {
    const res = await fetch('/api/chat', { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      render(data.messages || []);
    }
  }

  document.getElementById('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ text }),
    });
    if (res.ok) {
      const data = await res.json();
      render(data.messages || []);
    }
  });

  loadMessages();
  setInterval(loadMessages, 3500);
</script>
</body>
</html>`
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url)

        if (url.pathname === '/refresh' || url.pathname === '/admin/refresh') {
            const result = await refreshR2FromSource(env, url)
            return Response.json(result, { status: result.ok ? 200 : 500 })
        }

        if (url.pathname === '/sonolus/authenticate' && request.method === 'POST') {
            const rawBody = new Uint8Array(await request.arrayBuffer())
            const signature =
                request.headers.get('Sonolus-Signature') ??
                request.headers.get('sonolus-signature') ??
                ''

            const validSig = await verifySonolusSignature(rawBody, signature)
            if (!validSig) {
                return new Response('Invalid Sonolus signature', { status: 401 })
            }

            let parsed: any = null
            try {
                parsed = JSON.parse(new TextDecoder().decode(rawBody))
            } catch {
                return new Response('Invalid JSON body', { status: 400 })
            }

            const profile = parsed?.userProfile ?? parsed?.profile ?? parsed
            const handle = String(profile?.handle ?? '').trim()
            const id = String(profile?.id ?? handle).trim()
            const name = String(profile?.name ?? handle).trim()

            if (!handle) {
                return new Response('Missing user handle', { status: 400 })
            }

            const expiration = Date.now() + SESSION_TTL_MS
            const session = await signToken(getSessionSecret(env), {
                user: { id, name, handle },
                exp: expiration,
            })

            return Response.json({
                session,
                expiration,
            })
        }

        const user = await parseUserFromRequest(request, url, env)
        const sessionToken =
            request.headers.get('Sonolus-Session') ??
            request.headers.get('sonolus-session') ??
            url.searchParams.get('session') ??
            ''

        if (url.pathname === '/api/chat') {
            if (!user || !isStaffChatUser(user.handle)) {
                return new Response('Forbidden', { status: 403 })
            }

            const lobby = env.LOBBY.get(env.LOBBY.idFromName('main'))

            if (request.method === 'POST') {
                const body = await request.json<{ text?: string }>().catch(() => ({}))
                const text = String(body?.text ?? '').trim()
                if (!text) {
                    return Response.json({ ok: false, error: 'Empty message' }, { status: 400 })
                }

                const messages = await lobby.addChatMessage({
                    handle: user.handle,
                    author: user.name || user.handle,
                    text,
                })
                return Response.json({ ok: true, messages })
            }

            await lobby.markChatRead(user.handle)
            const messages = await lobby.listChatMessages()
            return Response.json({ ok: true, messages })
        }

        if (url.pathname === '/chat') {
            if (!user || !isStaffChatUser(user.handle)) {
                return new Response('Forbidden', { status: 403 })
            }

            const lobby = env.LOBBY.get(env.LOBBY.idFromName('main'))
            await lobby.markChatRead(user.handle)

            return new Response(renderStaffChatHtml(user, sessionToken), {
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
            })
        }

        if (url.pathname === '/sonolus/info') {
            const canSeeChat = Boolean(user && isStaffChatUser(user.handle))
            const unread = canSeeChat
                ? await env.LOBBY.get(env.LOBBY.idFromName('main')).getChatUnreadCount(user!.handle)
                : 0

            const chatItem = canSeeChat
                ? buildStaffChatPostItem(unread, url.origin, sessionToken)
                : null

            return Response.json({
                title: SERVER_TITLE,
                description: SERVER_DESCRIPTION,
                hasAuthentication: true,
                hasMultiplayer: true,
                configuration: {
                    options: [],
                },
                levels: {
                    items: [],
                    searches: [
                        {
                            title: 'Search',
                            options: [
                                {
                                    query: 'keywords',
                                    name: 'Keywords',
                                    required: false,
                                    type: 'text',
                                    def: '',
                                    placeholder: 'Song, artist, charter...',
                                    limit: 100,
                                    shortcuts: [],
                                },
                                {
                                    query: 'difficulty',
                                    name: 'Difficulty',
                                    required: false,
                                    type: 'select',
                                    def: 'ALL',
                                    values: [
                                        { name: 'ALL', title: 'All' },
                                        { name: 'HARD', title: 'HARD' },
                                        { name: 'EXPERT', title: 'EXPERT' },
                                        { name: 'MASTER', title: 'MASTER' },
                                        { name: 'APPEND', title: 'APPEND' },
                                    ],
                                },
                                {
                                    query: 'minRating',
                                    name: 'Min Level',
                                    required: false,
                                    type: 'number',
                                    def: RANKED_MIN_RATING,
                                    min: 0,
                                    max: 50,
                                    step: 0.1,
                                },
                                {
                                    query: 'maxRating',
                                    name: 'Max Level',
                                    required: false,
                                    type: 'number',
                                    def: RANKED_MAX_RATING,
                                    min: 0,
                                    max: 50,
                                    step: 0.1,
                                },
                            ],
                        },
                    ],
                },
                rooms: {
                    items: [],
                    creates: roomForms(user?.handle === TOURNAMENT_HOST_HANDLE),
                },
                playlists: {
                    items: [],
                    searches: [],
                },
                posts: {
                    items: chatItem ? [chatItem] : [],
                    searches: [],
                },
            })
        }

        if (url.pathname === '/sonolus/posts/list') {
            if (!user || !isStaffChatUser(user.handle)) {
                return Response.json({
                    pageCount: 1,
                    items: [],
                    searches: [],
                })
            }

            const lobby = env.LOBBY.get(env.LOBBY.idFromName('main'))
            const unread = await lobby.getChatUnreadCount(user.handle)
            return Response.json({
                pageCount: 1,
                items: [buildStaffChatPostItem(unread, url.origin, sessionToken)],
                searches: [],
            })
        }

        if (url.pathname === '/sonolus/posts/staff-chat') {
            if (!user || !isStaffChatUser(user.handle)) {
                return new Response('Not Found', { status: 404 })
            }

            const lobby = env.LOBBY.get(env.LOBBY.idFromName('main'))
            const messages = await lobby.listChatMessages()
            await lobby.markChatRead(user.handle)

            const chatUrl = sessionToken
                ? `${url.origin}/chat?session=${encodeURIComponent(sessionToken)}`
                : `${url.origin}/chat`

            const recentLines = messages.slice(-15).map(
                (m) => `[${m.author} (${m.handle})]: ${m.text}`,
            )

            return Response.json({
                item: buildStaffChatPostItem(0, url.origin, sessionToken),
                description: [
                    `Open chat: ${chatUrl}`,
                    'Shortcuts: @Bell, @Noct, @Ʌstra',
                    '',
                    ...(recentLines.length > 0 ? recentLines : ['No messages yet.']),
                ].join('\n'),
                recommended: [],
            })
        }

        if (url.pathname === '/sonolus/levels/list') {
            const pageSize = 20
            const page = Math.max(0, Number(url.searchParams.get('page') ?? 0) || 0)
            const allLevels = await getAllCatalogLevels(env, url)
            const filtered = filterCatalogLevels(allLevels, url.searchParams)
            const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
            const items = filtered.slice(page * pageSize, (page + 1) * pageSize)

            return Response.json({
                pageCount,
                items,
                searches: [],
            })
        }

        if (url.pathname === '/sonolus/rooms/list') {
            const lobby = env.LOBBY.get(env.LOBBY.idFromName('main'))
            const rooms = await lobby.list()
            const visibleRooms = rooms.filter((r) => {
                if (r.visibility !== 'private') return true
                return Boolean(user && (user.id === r.hostId || user.handle === TOURNAMENT_HOST_HANDLE))
            })

            return Response.json({
                pageCount: 1,
                items: visibleRooms,
                creates: roomForms(user?.handle === TOURNAMENT_HOST_HANDLE),
            })
        }

        if (url.pathname === '/sonolus/rooms/create' && request.method === 'POST') {
            if (!user) {
                return new Response('Unauthorized', { status: 401 })
            }

            const body = await request.json<{ optionValues?: string }>().catch(() => ({}))
            const parsed = parseSettings(body?.optionValues ?? '', undefined, user.name || user.handle)
            if (!parsed) {
                return new Response('Invalid room options', { status: 400 })
            }

            if (parsed.type !== 'casualRoom' && parsed.type !== 'rankedRoom' && user.handle !== TOURNAMENT_HOST_HANDLE) {
                return new Response('Forbidden room type', { status: 403 })
            }

            const roomName = crypto.randomUUID().slice(0, 8)
            const reserveKey = crypto.randomUUID()
            const roomStub = env.ROOM.get(env.ROOM.idFromName(roomName))

            await roomStub.reserve(roomName, {
                key: reserveKey,
                hostId: user.id,
                hostName: user.name || user.handle,
                hostHandle: user.handle,
            })

            const configured = await roomStub.configure(
                reserveKey,
                parsed,
                {
                    id: user.id,
                    name: user.name || user.handle,
                    handle: user.handle,
                },
            )

            if (!configured) {
                return new Response('Failed to configure room', { status: 500 })
            }

            const summary = await roomStub.summary()
            return Response.json({
                name: roomName,
                room: summary,
            })
        }

        const roomWsMatch = url.pathname.match(/^\/sonolus\/rooms\/([^/]+)\/connect$/)
        if (roomWsMatch) {
            const roomName = decodeURIComponent(roomWsMatch[1]!)
            const roomStub = env.ROOM.get(env.ROOM.idFromName(roomName))

            if (!user) {
                return new Response('Unauthorized', { status: 401 })
            }

            const denyReason = await roomStub.canJoin({ id: user.id, handle: user.handle })
            if (denyReason) {
                return new Response(denyReason, { status: 403 })
            }

            const roomUser = buildRoomUser(user, request)
            const joinPayload = encodeURIComponent(
                JSON.stringify({
                    room: roomName,
                    user,
                    roomUser,
                }),
            )

            const headers = new Headers(request.headers)
            headers.set('x-join', joinPayload)

            return roomStub.fetch(
                new Request(request.url, {
                    method: request.method,
                    headers,
                }),
            )
        }

        void ctx
        return new Response('Not Found', { status: 404 })
    },
}