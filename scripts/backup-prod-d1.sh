#!/usr/bin/env bash
# Per-table JSON backup of prod D1, working around the FTS5 export bug in wrangler.
# Skips the forum_search* FTS shadow tables — those are derivable from forum_post
# by re-running migration 0011 (or manually rebuilding the FTS5 index).
set -euo pipefail

cd "$(dirname "$0")/.."
source ~/proj/.env 2>/dev/null || true

OUT="backups/prod-d1-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

# Real tables only — exclude FTS5 shadow tables.
TABLES=(
  audit_event auth_token checkout_session credential d1_migrations
  draft_link event feed_project feed_version forum_category forum_image
  forum_post forum_post_upvote forum_subscription forum_thread
  forum_user_state organization organization_membership
  project_catalog_submission project_rt_feed publication publication_history
  session stripe_event subscription user
)

echo "Backing up to $OUT/"
for t in "${TABLES[@]}"; do
  printf '  %-32s ' "$t"
  npx wrangler d1 execute gtfs-builder --remote --command "SELECT * FROM $t" --json 2>/dev/null > "$OUT/$t.json"
  rows=$(grep -c '},\|}\]' "$OUT/$t.json" || echo 0)
  echo "→ $OUT/$t.json"
done

echo
echo "Done. $(du -sh $OUT | cut -f1) total."
