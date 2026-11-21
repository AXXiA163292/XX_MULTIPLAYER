
# AXX!A Sonolus multiplayer server

Round multiplayer server for Sonolus, built from the public spec:
https://wiki.sonolus.com/round-multiplayer-server-specs

Built with Cloudflare Workers and Durable Objects.

## Deploy

1. Install dependencies.
2. Log in to Cloudflare.
3. Set the SESSION_SECRET.
4. Deploy the Worker.

Commands:

    npm install
    npx wrangler login
    npx wrangler secret put SESSION_SECRET
    npx wrangler deploy

## Sonolus

Add the server in Sonolus:

Servers -> Add -> Your Worker URL

Sign in and open Rooms.

## What's customised

- Only handle 163292 can create rooms.
- Room types: Group Stage and Final.
- Group Stage rooms use the Group field.
- Final rooms use the server description followed by Final.
- Default scoring is Ranked Match.
- Ranked Match scoring: Perfect ×3, Great ×2, Good ×1.
- Tiebreakers: most Perfects, then highest combo.
- Settings can only be changed before the first round.
- Host is always room master and lead.
- Only the host can select levels, start rounds and kick players.
- Players cannot suggest levels or skip.
- Suggestions, scoreboard and results are host-only.
- No random level selection.
- Auto Exit is disabled.

## Where to change things

- src/config.ts: scoring points, names and room timeouts.
- src/forms.ts: room creation forms and defaults.
- src/scoring.ts: PP formula and tiebreakers.
- src/room.ts: room rules and multiplayer behavior.
- src/index.ts: Sonolus API endpoints.
- src/lobby.ts: room and post storage.
