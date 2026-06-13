# GTFS·X — Agent Guidelines

## Browser & Chrome Tools
- Proactively open HTML files, wireframes, and local dev servers in Chrome using `open` or browser automation tools — don't wait to be asked.
- Use chrome browser tools (mcp__claude-in-chrome__*) freely for reviewing pages, taking screenshots, verifying UI, and interacting with the app during development.

## Docs (only two living docs)
- **Product requirements & build status:** `docs/REQUIREMENTS.md` — the feature map (what's shipped / planned). Read before adding features.
- **Engineering reference:** `docs/ARCHITECTURE.md` — system architecture, data model, full API surface, security/privacy NFRs (`BE-*`/`NF-*` anchors), **live environment state** (read §5 first when picking work back up), git + deploy workflow, provisioning + operator runbooks. **Update §5 when you change deployed state.**
- The planned-feature backlog lives in **GitHub issues** (`markegge/gtfs-studio`). Superseded/historical docs are under `docs/archive/` (gitignored, local-only).
- Integration-test fixture feed: `tests/fixtures/benton-area-transit/` (Benton Area Transit, mdb-3109). Brand assets: `docs/brand-kit/`.

## Demo feed (svt-demo) — keep it exercising the spec
- `/demo` loads the **published `svt-demo`** feed from `https://feeds.gtfsx.com/svt-demo/gtfs.zip` (not a bundled zip). Updating the demo means editing the `svt-demo` server project and republishing.
- **When you add new GTFS spec functionality or an extension (Fares v2, flex/demand-response, continuous pickup/drop-off, etc.), build a representative example into the demo feed** so `/demo`, the marketing site, and the validator-parity test all exercise it. Tracked on the demo-feed GitHub issue.
- **Validator parity:** `npm run test:validator-parity` (network-dependent, periodic — not in the fast gate) compares our validator's output against the canonical MobilityData validator on our own feeds to confirm we flag the same issues.

## Backend (auth + feed management + embeds + billing + forum)
- Backend + Stripe billing are **live in production** (`BACKEND_ENABLED=true`, `BILLING_ENABLED=true`); see `docs/ARCHITECTURE.md` §5 for the live snapshot and the kill-switch pairing.
- Cloudflare Worker (same `wrangler.jsonc` as the SPA): `worker/` — Hono router composing `auth/`, `me/`, `orgs/`, `projects/`, `publication/`, `distribution/`, `embeds/`, `billing/`, `forum/`, `events/`, `marketing/`, `admin/`, `import/`, `cron/`, `email/`, `util/`, with legacy handlers in `worker/legacy/`.
- D1 migrations: `worker/migrations/*.sql` (run via `wrangler d1 migrations apply`).
- Frontend gates on `VITE_BACKEND_ENABLED` / `VITE_BILLING_ENABLED` — keep each paired with its `wrangler.jsonc` twin (flip in lockstep).
- Anonymous IndexedDB editor still works; signed-in users' projects live in R2 (`gtfs-builder-feeds`) with metadata in D1.
