# XX! — Sonolus Multiplayer Server

Multiplayer server for Sonolus (**XX!**), built with Cloudflare Workers, Durable Objects (`Room` and `Lobby`), and R2 (`POSTS_BUCKET`).

## Deploy

1. Install dependencies.
2. Log in to Cloudflare.
3. Set `SESSION_SECRET` and deploy.

Commands:

    npm install
    npx wrangler login
    npx wrangler secret put SESSION_SECRET
    npm run deploy

## Sonolus

Add the server in Sonolus:

`Servers -> Add -> https://xx-multiplayer.axxia163292.workers.dev`

Sign in and open **Rooms** or **Levels**.

## Features & Rules

- **Server Identity:** `XX!` — `AXX!A's server!` with Discord link `https://discord.gg/xxsrG9G6f`.
- **Room Types:**
  - **Custom Room (`casualRoom`):** Available to players; default title `<username>'s room` (e.g., `AXX!A's room`), supports `pp` or `rankedMatch` scoring, `public` or `private` access, and optional random level selection.
  - **Ranked Match (`rankedRoom`):** Supports `master`, `diamond`, `platinum`, `gold`, `silver`, `bronze`, and `beginner` tiers with `off`, `on`, and `customOnly` custom song modes.
  - **Group Stage (`groupStage`) & Final (`final`):** Tournament modes for host `163292`, pre-selecting `G1` / `F1` on join.
- **Room Lifespan & Locking:** Room lifespan is capped at 3 minutes (`MAX_ROOM_LIFESPAN_MS`), room types are locked after creation, and custom room options/levels can be edited during `selecting` without resetting.
- **Rounds & Scoring:** Supports `Round 1`, `Round 1 - Rewind`, `Warmup - Round 1`, and `Freeplay • Round 1`. Warmups do not count toward score, and replay songs only add score on the first valid result unless that first result was `0` due to `X` / disqualification. Wire results strip non-standard fields while internal scoring tracks `X` as `0` score.
- **Catalog & Constants:** Full level catalog search and filtering (`HARD`, `EXPERT`, `MASTER`, `APPEND`, ratings `18` to `39`), backed by R2 (`POSTS_BUCKET`) and `/admin/refresh` with a `90000` ms sheet fetch timeout.
- **Staff Chat:** Private chat for handles `163292`, `283420`, and `3227470` with unread indicators (`🔴`), bottom-bar input, and shortcuts `@Bell`, `@Noct`, and `@Ʌstra`.

## Project Layout

- `src/index.ts` — Worker entry point, Sonolus endpoints, catalog search/filter, and staff chat routes.
- `src/room.ts` — `Room` Durable Object managing multiplayer state, rounds, constants, and scoring.
- `src/lobby.ts` — `Lobby` Durable Object managing rooms, posts, and staff chat persistence.
- `src/sheets.ts` — Google Sheets CSV importer, R2 snapshot cache (`POSTS_BUCKET`), and `/admin/refresh` sync.
- `src/scoring.ts` & `src/pp.ts` — Ranked Match points, PP calculation, tiebreakers, and replay/warmup rules.
- `src/forms.ts` & `src/config.ts` — Room creation forms, defaults, tiers, handles, and constants.
- `src/crypto.ts` & `src/types.ts` — Sonolus signature verification, HMAC session tokens, and shared types.