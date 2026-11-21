# AXX!A Sonolus multiplayer server

Round multiplayer server for Sonolus, built from the public spec
(https://wiki.sonolus.com/round-multiplayer-server-specs) on Cloudflare Workers + Durable Objects (free plan OK).

## Deploy (free)
    npm install
    npx wrangler login
    npx wrangler secret put SESSION_SECRET     # paste any long random string
    npx wrangler deploy

Then in Sonolus: Servers -> Add -> https://axxia-multiplayer.<your-subdomain>.workers.dev, sign in, open Rooms.

## What's customised
- Only handle 163292 (HOST_HANDLE in wrangler.jsonc) can create rooms. Checked from the Sonolus-signed profile, at create and at join.
- Room types: Group Stage / Final, same settings. Only setting: Round scoring = Ranked Match | PP.
- Tiebreakers fixed: most perfects, then highest combo. No random, no auto exit, no level options.
- Host is always room master + lead. Nobody can change them. Only the host picks the level, starts rounds, kicks.
- Players can't suggest levels and can't skip. Suggestions / scoreboard / results are only sent to the host.
- Scoreboard (host only): Total on top, then each round with ranked score first, then P/Gr/Gd/M and combo.

## Where to change things
- src/config.ts   points per judgment, names, TTLs
- src/scoring.ts  PP formula (ppScore), tiebreakers
- src/room.ts     all room rules
- test/e2e.mjs    local test: npx wrangler dev --var DEV_SKIP_SIGNATURE:1 --var SESSION_SECRET:test, then node test/e2e.mjs
  (DEV_SKIP_SIGNATURE disables signature checks. Never set it when deployed.)
