# GTFS Builder — Agent Guidelines

## Browser & Chrome Tools
- Proactively open HTML files, wireframes, and local dev servers in Chrome using `open` or browser automation tools — don't wait to be asked.
- Use chrome browser tools (mcp__claude-in-chrome__*) freely for reviewing pages, taking screenshots, verifying UI, and interacting with the app during development.

## Project
- Requirements: `docs/REQUIREMENTS.md`
- Wireframes/mockups: `docs/wireframes.html`
- Example GTFS feed: `streamline_gtfs_march_2026/`

## Backend (auth + feed management)
- Feature spec: `docs/BACKEND_REQUIREMENTS.md`
- Implementation plan: `docs/BACKEND_IMPLEMENTATION_PLAN.md`
- Deploy runbook: `docs/DEPLOY_BACKEND.md`
- Cloudflare Worker (same `wrangler.jsonc` as the SPA): `worker/` — Hono router composing `auth/`, `projects/`, `email/`, `util/`, with legacy tile/catalog handlers in `worker/legacy/`.
- D1 migrations: `worker/migrations/*.sql` (run via `wrangler d1 migrations apply`).
- Frontend gates on `VITE_BACKEND_ENABLED` — when false, auth and /feeds routes render a placeholder and the editor stays anonymous/local-only.
- Anonymous IndexedDB editor still works; signed-in users' projects live in R2 (`gtfs-builder-feeds` bucket) with metadata in D1.
