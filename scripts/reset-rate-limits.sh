#!/usr/bin/env bash
# Nuke rate-limit counters on a KV namespace. Useful when local testing or an
# honest user trips the signup/login/reset limits and you want to keep going
# without waiting for the window to reset.
#
# Usage:
#   scripts/reset-rate-limits.sh staging       # clear the staging KV
#   scripts/reset-rate-limits.sh prod          # clear the prod KV
#   scripts/reset-rate-limits.sh local         # clear the local miniflare KV
#
# Loads CLOUDFLARE_API_TOKEN from ~/proj/.env if not already in env.

set -euo pipefail

ENV_ARG="${1:-}"
if [[ -z "$ENV_ARG" || "$ENV_ARG" == "-h" || "$ENV_ARG" == "--help" ]]; then
  echo "Usage: $0 <staging|prod|local>" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

# Pull the KV id out of wrangler.jsonc. The top-level block is prod; env.staging
# is staging. Strip // and /* */ comments + trailing commas before JSON.parse.
KV_ID=$(node -e '
  const fs = require("fs");
  let src = fs.readFileSync("wrangler.jsonc", "utf8");
  // Strip /* ... */ block comments (non-greedy).
  src = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Strip // line comments — but only outside strings. Cheap heuristic:
  // walk the source, tracking in-string state, and drop from // to EOL.
  let out = "";
  let inStr = false;
  let prev = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < src.length) { out += src[++i]; continue; }
      if (c === "\"") inStr = false;
    } else if (c === "\"") {
      inStr = true; out += c;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      if (i < src.length) out += "\n";
    } else {
      out += c;
    }
    prev = c;
  }
  // Strip trailing commas before } or ].
  out = out.replace(/,(\s*[}\]])/g, "$1");
  const cfg = JSON.parse(out);
  const env = process.argv[1];
  const ns = env === "staging"
    ? cfg.env?.staging?.kv_namespaces?.[0]
    : cfg.kv_namespaces?.[0];
  if (!ns?.id) { console.error("No KV namespace id found for env=" + env); process.exit(1); }
  console.log(ns.id);
' "$ENV_ARG")

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" && -f "$HOME/proj/.env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/proj/.env"
fi

FLAGS=()
if [[ "$ENV_ARG" == "local" ]]; then
  FLAGS+=(--local)
else
  FLAGS+=(--remote)
fi

echo "Listing rl:* keys on KV namespace $KV_ID ($ENV_ARG) …"
KEYS_JSON=$(npx wrangler kv key list --namespace-id="$KV_ID" --prefix="rl:" "${FLAGS[@]}")
COUNT=$(echo "$KEYS_JSON" | node -e 'const k=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(k.length)')

if [[ "$COUNT" == "0" ]]; then
  echo "No rate-limit keys to delete."
  exit 0
fi

echo "Deleting $COUNT rate-limit keys…"
TMP=$(mktemp -t gb-kv-delete.XXXXXX.json)
trap 'rm -f "$TMP"' EXIT
echo "$KEYS_JSON" | node -e '
  const keys = JSON.parse(require("fs").readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(keys.map(k => k.name)));
' > "$TMP"

npx wrangler kv bulk delete --namespace-id="$KV_ID" "${FLAGS[@]}" "$TMP"
echo "Done."
