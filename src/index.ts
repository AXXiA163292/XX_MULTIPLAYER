import {
    SERVER_DESCRIPTION,
    SERVER_TITLE,
    STAFF_CHAT_HANDLES,
    STAFF_CHAT_SHORTCUTS,
    TOURNAMENT_HOST_HANDLE,
} from './config.ts'
import { roomForms, parseSettings } from './forms.ts'
import type { Env, RoomUser } from './types.ts'

type SonolusUser = {
    id: string
    name: string
    handle: string
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

const isStaffChatUser = (handle?: string | null): boolean =>
    Boolean(
        handle &&
            (STAFF_CHAT_HANDLES as readonly string[]).includes(String(handle).trim()),
    )

function parseUserFromRequest(request: Request, url: URL): SonolusUser | null {
    const headerSession = request.headers.get('x-sonolus-session')
    const queryHandle = url.searchParams.get('handle')
    const queryUserId = url.searchParams.get('userId')
    const queryName = url.searchParams.get('name')

    if (headerSession) {
        try {
            const parsed = JSON.parse(decodeURIComponent(headerSession)) as {
                user?: Partial<SonolusUser>
            }
            if (parsed?.user?.handle || parsed?.user?.id) {
                return {
                    id: String(parsed.user.id ?? parsed.user.handle ?? ''),
                    name: String(parsed.user.name ?? parsed.user.handle ?? 'Player'),
                    handle: String(parsed.user.handle ?? parsed.user.id ?? ''),
                }
            }
        } catch {
            // Fall through to query/header values.
        }
    }

    const handleHeader = request.headers.get('x-user-handle') ?? queryHandle
    const idHeader = request.headers.get('x-user-id') ?? queryUserId ?? handleHeader
    const nameHeader = request.headers.get('x-user-name') ?? queryName ?? handleHeader

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
        authentication: request.headers.get('x-sonolus-authentication') ?? '',
        signature: request.headers.get('x-sonolus-signature') ?? '',
    }
}

function buildStaffChatPostItem(unread: number, origin: string) {
    return {
        name: 'staff-chat',
        version: 1,
        title: unread > 0 ? `🔴 Chat (${unread})` : 'Chat',
        time: Date.now(),
        author: SERVER_TITLE,
        tags: [{ title: 'Chat' }],
        url: `${origin}/chat`,
    }
}

async function getAllCatalogLevels(env: Env, url: URL): Promise<LevelItem[]> {
    if (env.R2) {
        const listed = await env.R2.list({ prefix: 'levels/' })
        const items: LevelItem[] = []

        for (const obj of listed.objects) {
            if (!obj.key.endsWith('.json')) continue
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

function filterCatalogLevels(levels: LevelItem[], searchParams: URLSearchParams): LevelItem[] {
    const keywords = (searchParams.get('keywords') ?? '').trim().toLowerCase()
    const hasMinRating = searchParams.has('minRating') && searchParams.get('minRating') !== ''
    const hasMaxRating = searchParams.has('maxRating') && searchParams.get('maxRating') !== ''
    const minRating = hasMinRating ? Number(searchParams.get('minRating')) : NaN
    const maxRating = hasMaxRating ? Number(searchParams.get('maxRating')) : NaN
    const difficulty = (searchParams.get('difficulty') ?? '').trim().toUpperCase()

    const terms = keywords ? keywords.split(/\s+/).filter(Boolean) : []

    return levels.filter((lvl) => {
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

function renderStaffChatHtml(user: SonolusUser): string {
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
  const box = document.getElementById('messages');
  const input = document.getElementById('chatInput');

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
    const res = await fetch('/api/chat', { headers: { 'x-user-handle': myHandle } });
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
      headers: {
        'Content-Type': 'application/json',
        'x-user-handle': myHandle,
      },
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
        const user = parseUserFromRequest(request, url)

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

            return new Response(renderStaffChatHtml(user), {
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
            })
        }

        if (url.pathname === '/sonolus/info') {
            const canSeeChat = Boolean(user && isStaffChatUser(user.handle))
            const unread = canSeeChat
                ? await env.LOBBY.get(env.LOBBY.idFromName('main')).getChatUnreadCount(user!.handle)
                : 0

            const chatItem = canSeeChat
                ? buildStaffChatPostItem(unread, url.origin)
                : null

            return Response.json({
                title: SERVER_TITLE,
                description: SERVER_DESCRIPTION,
                configuration: {
                    options: [],
                },
                sections: chatItem
                    ? [
                        {
                            title: 'Chat',
                            icon: 'comment',
                            itemType: 'post',
                            items: [chatItem],
                        },
                    ]
                    : [],
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
                                        { name: 'EASY', title: 'EASY' },
                                        { name: 'NORMAL', title: 'NORMAL' },
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
                                    def: 0,
                                    min: 0,
                                    max: 50,
                                    step: 0.1,
                                },
                                {
                                    query: 'maxRating',
                                    name: 'Max Level',
                                    required: false,
                                    type: 'number',
                                    def: 50,
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
                items: [buildStaffChatPostItem(unread, url.origin)],
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

            const recentLines = messages.slice(-15).map(
                (m) => `[${m.author} (${m.handle})]: ${m.text}`,
            )

            return Response.json({
                item: buildStaffChatPostItem(0, url.origin),
                description: [
                    `Open chat in browser: ${url.origin}/chat`,
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
            const parsed = parseSettings(body?.optionValues ?? '')
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