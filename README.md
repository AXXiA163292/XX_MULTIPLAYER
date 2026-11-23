# XX! — AXX!A Sonolus Server

Multiplayer server for Sonolus (**XX!**), built with Cloudflare Workers, Durable Objects (`Room` and `Lobby`), and R2 (`POSTS_BUCKET` / `sonolus-assets`).

## Deploy

1. Install dependencies.
2. Log in to Cloudflare.
3. Set `SESSION_SECRET` and deploy.

Commands:

    npm install
    npx wrangler login
    npx wrangler secret put SESSION_SECRET
    npx wrangler deploy

## Sonolus

Add the server in Sonolus:

`Servers -> Add -> https://xx-multiplayer.axxia163292.workers.dev`

Sign in and open **Rooms** or **Levels**.

## Endpoints

- `GET /sonolus/info` — Server info, dynamic Staff Chat button (for authorized handles), Announcements, Posts, Results, Levels, Playlists, and Rooms.
- `GET /admin/refresh` (or `/refresh`) — Syncs custom levels, playlists, constants, and Ranked Match pools (`hr`, `ex`, `ms`, `ap` columns only) from Google Sheets into R2 (`POSTS_BUCKET`).
- `GET /sonolus/server/banner` — Serves `server/banner.png` from R2 (`POSTS_BUCKET`).
- `GET /chat` & `/api/chat` — Live Staff Chat UI and message API for authorized staff handles.

## Features & Rules

- **Server Identity:** `XX!` — `https://discord.gg/xxsrG9G6f` followed by `AXX!A's server!`.
- **Room Types:**
  - **Custom Room (`casualRoom`):** Available to players; defaults to `<username>'s room`, supports `pp` or `rankedMatch` scoring, `public` or `private` access, and optional random level selection.
  - **Ranked Match (`rankedRoom`):** Supports `master`, `diamond`, `platinum`, `gold`, `silver`, `bronze`, and `beginner` tiers with `off`, `on`, and `customOnly` custom song modes, pulling strictly from `hr`, `ex`, `ms`, and `ap` columns (ratings `18` to `39`).
  - **Group Stage (`groupStage`) & Final (`final`):** Tournament modes for host `163292`, pre-selecting `G1` / `F1` on creation and supporting `Round N`, `Warmup - Round N`, `Round N - Rewind`, and `Freeplay • Round N` round types.
- **Room Lifespan & Stability:** Empty or unjoined rooms close after 3 minutes (`EMPTY_ROOM_TTL_MS`), while active rooms stay open up to 4 hours (`MAX_ROOM_LIFESPAN_MS`) with WebSocket auto-ping/pong so AFK players are not disconnected.
- **Rounds & Scoring:** Warmup rounds do not count toward score, and replay/rewind/freeplay songs only add score on the first valid result unless that first result was `0` due to `X` / disqualification. Wire results strip non-standard fields while internal scoring tracks `X` as `0` score.
- **Staff Chat:** Private chat button (`infoType: 'staff-chat'`) shown dynamically on `/sonolus/info` only when signed in as `163292`, `283420`, or `3227470`, featuring unread indicators (`🔴`), bottom-bar input, and shortcuts `@Bell`, `@Noct`, and `@Ʌstra`.

## Project Layout

- `src/index.ts` — Worker entry point, Sonolus endpoints, dynamic staff chat button, `/admin/refresh`, and catalog search/filter.
- `src/room.ts` — `Room` Durable Object managing multiplayer state, round modes, constants, and scoring.
- `src/lobby.ts` — `Lobby` Durable Object managing active rooms, posts, and staff chat persistence.
- `src/sheets.ts` — Google Sheets CSV importer, R2 snapshot cache (`POSTS_BUCKET`), and `hr`/`ex`/`ms`/`ap` Ranked Match pool builder.
- `src/scoring.ts` & `src/pp.ts` — Ranked Match points, PP calculation, tiebreakers, and replay/warmup rules.
- `src/forms.ts` & `src/config.ts` — Room creation forms, round mode selectors, defaults, tiers, handles, and constants.
- `src/crypto.ts` & `src/types.ts` — Sonolus signature verification, HMAC session tokens, and shared types.