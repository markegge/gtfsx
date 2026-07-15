#!/usr/bin/env bash
# Build line-delimited GeoJSON dot outputs for every US state + DC + PR.
# Runs 4 states in parallel; writes per-state logs to tiles/ldjson/dots_{ST}.log.
#
# Safe to re-run: a state is skipped only if its existing .ldjson was built from
# the SAME config as the current build_dots.py. The config fingerprint lives in
# each state's dots_{ST}.ldjson.meta.json sidecar.
#
# That check matters. This script used to skip any non-empty output, so after the
# dot pipeline was rewritten, a re-run would have quietly kept every file from the
# previous build and cat'd them together with the new ones — a nationwide tileset
# with one schema in the states that happened to get rebuilt and another in the
# rest, internally consistent and wrong, with no error emitted anywhere.
#
# THE SKIP CHECK BELOW IS A FAST PATH, NOT THE SAFETY NET. It only saves you a
# rebuild. The actual authority lives in Python, in build_dots.py's concatenation
# gate: the tileset is built by piping through `build_dots.py --cat-verified`,
# which refuses to emit a single byte if any input's sidecar disagrees with the
# current config_hash. That guard cannot be lost by rewriting this script — if you
# delete everything below, the worst case is a slow rebuild, not a corrupt
# tileset. (A previous bash-only version of this guard WAS lost in a rewrite,
# which is exactly why the authority is no longer in bash.)

set -u

cd "$(dirname "$0")"
set -a; source /Users/clippy2/proj/.env; set +a
mkdir -p ../tiles/ldjson

STATES=(AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR)

# Fingerprint of everything that determines a dot file's CONTENT: the flag bits,
# per-universe density, the ACS vars, the PUMA corrections and the apportionment
# version. Any change to those changes this, and every state gets rebuilt.
#
# The ZOOM LADDER is deliberately NOT in it. The ladder decides each dot's
# `tippecanoe.minzoom`, but --cat-verified OVERWRITES that on every feature at
# concat time (restride_lines), so the ladder is consumed by the ~80-minute
# re-tile, not by the ~2-hour state build. Changing the ladder therefore does not
# invalidate a single .ldjson: skip this script entirely and just re-run the
# tippecanoe command below. See config_hash() in build_dots.py for the full
# argument — including what would make it unsafe.
CONFIG_HASH="$(./.venv/bin/python -c 'import build_dots; print(build_dots.config_hash())')"
export CONFIG_HASH
echo "Config fingerprint: $CONFIG_HASH"

# The legend the frontend reads ("1 dot = N people", per class). Regenerated on
# every run so it can never drift from the tiles it describes.
./.venv/bin/python build_dots.py --emit-legend demand-legend.json

build_state() {
  local st="$1"
  local out="../tiles/ldjson/dots_${st}.ldjson"
  local meta="${out}.meta.json"
  local log="../tiles/ldjson/dots_${st}.log"

  if [ -s "$out" ]; then
    local have=""
    [ -f "$meta" ] && have="$(./.venv/bin/python -c "
import json,sys
try: print(json.load(open('$meta')).get('config_hash',''))
except Exception: print('')
")"
    if [ "$have" = "$CONFIG_HASH" ]; then
      echo "  [skip]  $st already built with this config ($(du -h "$out" | cut -f1))"
      return 0
    fi
    echo "  [stale] $st built with a different config (${have:-none}) — rebuilding"
  fi

  local t0=$(date +%s)
  echo "  [start] $st  $(date +%T)"
  if uv run python build_dots.py --state "$st" --output "$out" --ldjson > "$log" 2>&1; then
    local dt=$(( $(date +%s) - t0 ))
    echo "  [done]  $st  $(du -h "$out" | cut -f1)  ${dt}s"
  else
    echo "  [FAIL]  $st  exit=$?  see $log"
    return 1
  fi
}
export -f build_state

printf '%s\n' "${STATES[@]}" | xargs -n1 -P4 -I{} bash -c 'build_state "$@"' _ {}
echo "=== ALL DONE ==="
ls -lh ../tiles/ldjson/*.ldjson | awk '{print $5, $9}' | sort

ARCHIVE="$(./.venv/bin/python -c 'import build_dots; print(build_dots.TILESET_ARCHIVE)')"
TILE_CMD="$(./.venv/bin/python build_dots.py --emit-tile-cmd)"

cat <<EOF

Next: build the tileset. This command is GENERATED from build_dots.py's zoom and
ladder constants — do not retype it, and do not copy an older one out of a
runbook. The zoom flags, the legend's min_zoom/max_zoom and the per-feature
minzooms in the .ldjson all come from those same constants, which is the only
reason they agree. (They didn't: the legend said z16 while the build said z15, so
the frontend asked Mapbox for a z16 tile that never existed and the layer went
blank from z16 in.)

Note it pipes through '--cat-verified', not 'cat'. Do not "simplify" that back to
a bare cat. It does two things a cat cannot:

  1. It is the GATE that refuses to concatenate a state whose sidecar does not
     match the current config ${CONFIG_HASH}. A bare cat cannot tell a stale
     state from a fresh one, and nothing downstream can either — the tiles come
     out internally consistent and wrong.
  2. It sets the ZOOM LADDER'S PHASE across the whole archive. Each state was
     built by its own process, so each one numbered its dots from 0 — and dot 0
     is a z8 dot, the rarest rung on the ladder. Cat them raw and all 52 states
     round their z8 count UP, over-filling the low-zoom tiles by up to +2.9% on
     the rare flag combinations. --cat-verified re-tags every dot from ONE
     ordinal per code, so the archive rounds once instead of 52 times.
     (verify_tiles.py catches a bare cat, loudly. It already has, once.)

If you want to check the inputs without building, that same gate runs standalone:

  ./.venv/bin/python build_dots.py --verify-inputs '../tiles/ldjson/*.ldjson'

${TILE_CMD}

Then PROVE the tiles honor the legend before publishing anything:

  ./.venv/bin/python verify_tiles.py ../tiles/${ARCHIVE}.pmtiles \\
    --meta '../tiles/ldjson/*.ldjson.meta.json'

That re-decodes the archive and checks retained == emitted for every zoom and
every class. It is not a formality: tippecanoe's DEFAULT --drop-rate had been
thinning the low zooms by up to 40x on top of our ladder, so the legend claimed
"1 dot = 40 people" at z8 while the tiles carried one dot per ~1,850. Nothing
noticed, because nothing compared the two. If verify_tiles.py fails, the legend
is lying — fix the build, don't publish.

Publish under the archive name '${ARCHIVE}' — the frontend reads that name out of
demand-legend.json (the "archive" key) and builds its tile URLs from it, so the
tiles and the legend have to move together. Ship demand-legend.json alongside the
tiles: it is the source of truth for the per-class "1 dot = N people", for the
zoom ladder that scales it (zoom_ladder.strides), and for the zoom envelope the
frontend hands to Mapbox.
EOF
