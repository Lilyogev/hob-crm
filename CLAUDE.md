# hob CRM: architecture decisions

The board of House of Bais (hob), a clothing brand run by two partners, Avia (אביה) and Lior (ליאור). Initiator: Yogev.
A pruned copy of the Segula board, same stack, same visual language, own resources. Hebrew everywhere in the UI, RTL, mobile first, feminine plural for the partners.
Replies to Yogev: Hebrew, direct.

## Stack
- TanStack Start (React 19 SSR, Vite 7) as a Cloudflare Worker. Build emits `dist/server/server.js` + `dist/client` (ASSETS binding).
- D1 (`DB`) for all data, R2 (`STORAGE`) for receipts, images and nightly backups, Workers AI (`AI`) for Whisper.
- One Durable Object `SummaryAgent` (binding `ROOMS`, `src/server.ts`): the scheduler (self-rearming alarm) and the only place that calls Anthropic and Shopify. API routes relay to it with `agentStub().fetch("https://agent/<path>")`.
- Plain Tailwind 4 plus CSS tokens `--hob-*` in `src/styles.css` (cream paper `#faf6e9`, ink `#4f463c`, from the logo). Light is the default (`html.ivory`), dark is the 🌓 option. No UI kit.
- Web Push with VAPID, no library. The push carries no payload; `public/sw.js` pulls the latest row of `push_outbox`.
- Resources: Worker `hob-crm`, D1 `hob-crm-db`, R2 `hob-crm-files`. **Never reuse an id from segula-board or shay-crm.**

## Code layout
- `src/server.ts`: Worker entry + `SummaryAgent`.
- `src/lib/*.server.ts`: server logic. `hob.server.ts` = D1 access, users, sessions, rate limits, task CRUD. `partners.ts` = the shared vocabulary (partners, owners, locations, payers); never hardcode the names.
- `src/routes/api/*`: JSON API. Every handler starts with `isAuthed(request)`; the actor comes from `currentUser(request)`, never from the client.
- `src/components/hob/*`: UI. `board.tsx` = shell with tabs + the Monday-style task groups. Tabs: `shared` / `avia` / `lior` (tasks), `stock`, `finance` (with the drop simulator), `collab`, `hobi`, `settings`.
- `migrations/*.sql`: one file per module (0001 core, 0002 stock, 0003 finance, 0004 collab, 0005 assistant, 0006 shopify). Additive only. Never a password, secret or business number in a migration.
- `scripts/create-user.mjs` prints the SQL for a user; `scripts/vapid-keys.mjs` prints push keys; `scripts/demo-seed.mjs` writes `seed/demo.sql` (demo only, never on production).

## Data decisions
- Two users, both owners (`users.key` = `avia` | `lior`). No roles in v1.
- Tasks: `board_groups.view` puts a lane in one of the three task tabs; `tasks.owner` = `''` | `avia` | `lior` | `both`.
- Stock: `seed_stock` per item × size × location, locations exactly `avia` | `lior`. Sales, gifts and transfers move stock between them. `seed_sales.handled_by` = who handled the sale.
- Money: REAL in shekels. Expenses have `payer` (`avia` | `lior` | `business`) and `paid_from` (business only). Manual income has `handled_by`. VAT and fee rates live in `settings` (`vat_exempt`, `fee_rates`).
- Influencers: `collab_links.handled_by` / `collab_prospects.handled_by`. Public links use `settings.collab_domain`; codes redirect to `settings.store_url/discount/CODE`.
- Hobi: chat in `assistant_chat` (chat_id 1). `kind='note'` rows are board notifications never sent to the model. Persona and brand facts come from `settings.brand_context`, `settings.owner_context` and `brand_memory`.
- Shopify: `settings.shop_domain`, secrets `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`. See `SHOPIFY.md`.

## Commands
- `npm run dev`: local development. `npm run db:migrate:local && npm run db:seed:local`: local DB with demo data (no money).
- `npm run typecheck`, `npm test`.
- Deploy: see `DEPLOY.md`.
