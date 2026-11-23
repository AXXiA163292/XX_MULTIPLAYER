import {
    SERVER_DESCRIPTION,
    SERVER_TITLE,
    STAFF_CHAT_HANDLES,
    STAFF_CHAT_SHORTCUTS,
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

const isStaffChatHandle = (handle?: string | null): boolean =>
    Boolean(
        handle &&
        (STAFF_CHAT_HANDLES as readonly string[]).includes(String(handle).trim()),
    )

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
    req?: Request,
    body?: any,
    values?: URLSearchParams,
): PostCategory | null {
    const bodySearchParams = parseEncodedParams(body?.searchValues ?? body?.values)
    const urlSearchParams = parseEncodedParams(
        url.searchParams.get('searchValues') ?? url.searchParams.get('values'),
    )

    const candidates: (string | null | undefined)[] = [
        url.searchParams.get('category'),
        url.searchParams.get('type'),
        url.searchParams.get('infoType'),
        url.searchParams.get('postType'),
        urlSearchParams?.get('category'),
        urlSearchParams?.get('type'),
        urlSearchParams?.get('infoType'),
        values?.get('category'),
        values?.get('type'),
        values?.get('infoType'),
        bodySearchParams?.get('category'),
        bodySearchParams?.get('type'),
        bodySearchParams?.get('infoType'),
        body?.category,
        body?.type,
        body?.infoType,
        body?.postType,
    ]

    for (const c of candidates) {
        const parsed = parseCategoryString(c)
        if (parsed) return parsed
    }

    const referer = req?.headers.get('Referer')
    if (referer) {
        try {
            const refUrl = new URL(referer)
            const refSearchParams = parseEncodedParams(
                refUrl.searchParams.get('searchValues') ?? refUrl.searchParams.get('values'),
            )
            const refCandidates: (string | null | undefined)[] = [
                refUrl.searchParams.get('category'),
                refUrl.searchParams.get('type'),
                refUrl.searchParams.get('infoType'),
                refUrl.searchParams.get('postType'),
                refSearchParams?.get('category'),
                refSearchParams?.get('type'),
                refSearchParams?.get('infoType'),
            ]
            for (const c of refCandidates) {
                const parsed = parseCategoryString(c)
                if (parsed) return parsed
            }
        } catch {
            // ignore invalid referer
        }
    }

    return null
}

function postCategory(
    url: URL,
    req?: Request,
    body?: any,
    values?: URLSearchParams,
): PostCategory {
    return resolveCategory(url, req, body, values) ?? 'posts'
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
            required: true,
            type: 'text',
            def: '',
            placeholder: 'Write a message...',
            limit: 500,
            shortcuts: [...STAFF_CHAT_SHORTCUTS],
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
            required: true,
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

function buildChatPostItem(messages: ChatMessage[], pinnedId: string | null) {
    const latest = messages[messages.length - 1] ?? null
    const pinnedMsg = pinnedId ? messages.find((m) => m.id === pinnedId) ?? null : null
    const count = messages.length
    const countLabel = `${count} ${count === 1 ? 'comment' : 'comments'}`

    const subtitle = pinnedMsg
        ? `${pinnedMsg.author}: ${pinnedMsg.text} · ${countLabel}`
        : latest
            ? `${latest.author}: ${latest.text} · ${countLabel}`
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
            author: `${m.author} (${m.handle})`,
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

function externalChatUrl(req: Request, env: Env, url: URL): string | null {
    const token = extractSessionToken(req, url)
    if (!token) return null
    return `${addressOf(req, env)}/chat?session=${encodeURIComponent(token)}`
}

function rawPostCategory(url: URL): string | null {
    const val =
        url.searchParams.get('category') ??
        url.searchParams.get('type') ??
        url.searchParams.get('infoType') ??
        url.searchParams.get('postType')
    return val ? val.trim().toLowerCase() : null
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

function renderStaffChatHtml(user: UserProfile, sessionToken: string): string {
    const shortcutsHtml = STAFF_CHAT_SHORTCUTS.map(
        (tag) =>
            `<button type="button" class="chip" data-shortcut="${escapeAttr(tag)}">${escapeAttr(tag)}</button>`,
    ).join('')

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>${escapeAttr(SERVER_TITLE)} · chat</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d0f14;color:#f3f4f6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column;height:100dvh}
  header{padding:12px 16px;background:#151922;border-bottom:1px solid #242b3a;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:space-between}
  .badge{font-size:12px;color:#9ca3af;font-weight:500}
  #messages{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
  .msg{background:#191e2a;border:1px solid #283042;border-radius:12px;padding:9px 12px;max-width:85%}
  .msg.me{align-self:flex-end;background:#1d2b45;border-color:#3b82f6}
  .meta{font-size:11px;color:#9ca3af;margin-bottom:3px;display:flex;align-items:center;justify-content:space-between;gap:8px}
  .del-btn{background:transparent;color:#f87171;border:1px solid rgba(248,113,113,.35);border-radius:6px;padding:1px 6px;font-size:10px;cursor:pointer}
  .del-btn:hover{background:rgba(248,113,113,.15)}
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
    <span>${escapeAttr(SERVER_TITLE)} chat</span>
    <span class="badge">${escapeAttr(user.name || user.handle)} (${escapeAttr(user.handle)})</span>
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
    const headers = { ...extra };
    if (sessionToken) headers['Sonolus-Session'] = sessionToken;
    return headers;
  }

  function insertShortcut(tag) {
    const current = input.value;
    const spacer = current && !current.endsWith(' ') ? ' ' : '';
    input.value = current + spacer + tag + ' ';
    input.focus();
  }

  document.querySelectorAll('.chip[data-shortcut]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.getAttribute('data-shortcut') || '';
      if (tag) insertShortcut(tag);
    });
  });

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
        '<div class="meta"><span>' + escapeHtml(m.author) + ' (' + escapeHtml(m.handle) + ') · ' + escapeHtml(time) + '</span>' +
        '<button type="button" class="del-btn" data-delete-id="' + escapeHtml(m.id) + '">Delete</button></div>' +
        '<div class="text">' + escapeHtml(m.text) + '</div>' +
      '</div>';
    }).join('');
    box.scrollTop = box.scrollHeight;
  }

  box.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-delete-id]');
    if (!delBtn) return;
    const id = delBtn.getAttribute('data-delete-id');
    if (!id) return;
    const res = await fetch('/api/chat?id=' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      render(data.messages || []);
    }
  });

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
        name: label.create,
        type: 'post',
        title: label.create,
        requireConfirmation: false,
        options: [
            {
                name: 'title',
                query: 'title',
                required: true,
                type: 'text',
                def: '',
                placeholder: label.titlePlaceholder,
                limit: 100,
                shortcuts: [],
            },
            {
                name: 'description',
                query: 'description',
                required: true,
                type: 'textArea',
                def: '',
                placeholder: label.bodyPlaceholder,
                limit: 5000,
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
            author: `${c.author} (${c.handle})`,
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

const LEVEL_SEARCHES = [
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

async function allLevelEntries(env: Env) {
    if (levelIndex && Date.now() - levelIndex.at < 15 * 60_000) return levelIndex.entries

    const entries = await loadLevelItems(await getCustomLevels(env))
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

function sortLevelEntries(
    entries: { chart: SheetChart; item: RemoteLevelItem }[],
    sort: string,
) {
    if (sort === 'ratingDesc') {
        return [...entries].sort((a, b) => Number(b.item.rating) - Number(a.item.rating))
    }
    if (sort === 'ratingAsc') {
        return [...entries].sort((a, b) => Number(a.item.rating) - Number(b.item.rating))
    }
    if (sort === 'title') {
        return [...entries].sort((a, b) =>
            localizedTitle(a.item.title).localeCompare(localizedTitle(b.item.title)))
    }
    return entries
}

async function searchLevels(url: URL, page: number, env: Env) {
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

    const filtered = (await allLevelEntries(env)).filter(({ item }) => {
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

    const sorted = sortLevelEntries(filtered, sort)
    const pageCount = Math.max(1, Math.ceil(sorted.length / 10))
    const start = page * 10

    return {
        pageCount,
        items: page >= pageCount ? [] : sorted.slice(start, start + 10).map((entry) => entry.item),
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

        if (path === '/refresh' || path === '/admin/refresh') {
            const summary = await refreshDailyAssets(env)
            await lobby(env).syncAllToR2().catch(() => {})
            levelIndex = null
            return json({
                ok: summary.errors.length === 0,
                ...summary,
            })
        }

        if (path === '/chat' && req.method === 'GET') {
            const token = url.searchParams.get('session') ?? ''
            const session = token
                ? await verifyToken<AuthSession>(env.SESSION_SECRET, token)
                : null

            if (!session || !isStaffChatHandle(session.user.handle)) {
                return html('<h1>403 Forbidden</h1><p>Chat is restricted.</p>', 403)
            }

            return html(renderStaffChatHtml(session.user, token))
        }

        if (path === '/api/chat') {
            const session = await sessionOf(req, env, url)
            if (!session || !isStaffChatHandle(session.user.handle)) {
                return message(403, 'Chat is restricted.')
            }

            if (req.method === 'GET') {
                const messages = await lobby(env).listChatMessages().catch(() => [])
                return json({ messages })
            }

            if (req.method === 'POST') {
                let body: any
                try {
                    body = await req.json()
                } catch {
                    return message(400, 'Invalid JSON.')
                }

                if (body?.action === 'delete') {
                    await lobby(env).deleteChatMessage(
                        typeof body?.id === 'string' ? body.id : undefined,
                    )
                    const messages = await lobby(env).listChatMessages().catch(() => [])
                    return json({ ok: true, messages })
                }

                const text = typeof body?.text === 'string' ? body.text.trim() : ''
                if (!text) return message(400, 'Message cannot be empty.')

                await lobby(env).addChatMessage({
                    handle: session.user.handle,
                    author: session.user.name || session.user.handle,
                    text: text.slice(0, 500),
                })

                const messages = await lobby(env).listChatMessages().catch(() => [])
                return json({ ok: true, messages })
            }

            if (req.method === 'DELETE') {
                const id = url.searchParams.get('id') ?? undefined
                await lobby(env).deleteChatMessage(id)
                const messages = await lobby(env).listChatMessages().catch(() => [])
                return json({ ok: true, messages })
            }
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
                                icon: 'message',
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
                    return json({ creates: [], searches: [], sections: [] })
                }

                const [messages, pinnedId] = await Promise.all([
                    lobby(env).listChatMessages().catch(() => []),
                    lobby(env).getPinnedChatId().catch(() => null),
                ])

                return json({
                    creates: [],
                    searches: [],
                    sections: [
                        {
                            title: 'Chat',
                            itemType: 'post',
                            hasMore: false,
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
                        hasMore: posts.length > 0,
                        searchValues: new URLSearchParams({ category: kind }).toString(),
                        items: posts.map(buildPostItemWithBadges),
                    }
                }),
            )

            return json({
                creates: canManagePosts(session)
                    ? explicit
                        ? [postForm(explicit)]
                        : [
                            postForm('announcements'),
                            postForm('posts'),
                            postForm('results'),
                        ]
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

            const kind = postCategory(url, req)
            const posts = sortPostsPinnedFirst(
                (await lobby(env).listPosts(kind).catch(() => [])).filter(
                    (p) => p.category === kind,
                ),
            )
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
            const category = postCategory(url, req, body, values)
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
                env.COMMUNITY_BUCKET?.delete(`${post.category}/${postName}/thumbnail`) ?? Promise.resolve(),
                env.POSTS_BUCKET?.delete(`posts/${postName}/thumbnail`) ?? Promise.resolve(),
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

            const digest = await crypto.subtle.digest('SHA-1', bytes)
            const hash = Array.from(
                new Uint8Array(digest),
                (byte) => byte.toString(16).padStart(2, '0'),
            ).join('')

            if (hash.toLowerCase() !== post.thumbnailHash.toLowerCase()) {
                return message(400, 'Image hash does not match.')
            }

            await (env.COMMUNITY_BUCKET ?? env.POSTS_BUCKET).put(
                `${post.category}/${post.item.name}/thumbnail`,
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
                (post && env.COMMUNITY_BUCKET
                    ? await env.COMMUNITY_BUCKET.get(`${post.category}/${name}/thumbnail`).catch(() => null)
                    : null) ??
                (env.COMMUNITY_BUCKET
                    ? await env.COMMUNITY_BUCKET.get(`posts/${name}/thumbnail`).catch(() => null)
                    : null) ??
                (await env.POSTS_BUCKET?.get(`posts/${name}/thumbnail`).catch(() => null))

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
                const extUrl = externalChatUrl(req, env, url)

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
                    const found = await searchLevels(url, page, env)

                    return json({
                        pageCount: found.pageCount,
                        items: found.items,
                        searches: LEVEL_SEARCHES,
                    })
                }

                const { charts, pageCount } = await getCustomLevelPage(page, env)

                if (page >= pageCount) {
                    return json({
                        pageCount,
                        items: [],
                        searches: LEVEL_SEARCHES,
                    })
                }

                const loaded = await loadLevelItems(charts)

                return json({
                    pageCount,
                    items: loaded.map((entry) => entry.item),
                    searches: LEVEL_SEARCHES,
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