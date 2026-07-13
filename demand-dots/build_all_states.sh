#!/usr/bin/env bash
# Build line-delimited GeoJSON dot outputs for every US state + DC + PR.
# Runs 4 states in parallel; writes per-state logs to tiles/ldjson/dots_{ST}.log.
#
# Safe to re-run: a state is skipped only if its existing .ldjson was built from
# the SAME class/density config as the current build_dots.py. The config
# fingerprint lives in each state's dots_{ST}.ldjson.meta.json sidecar.
#
# That check matters. This script used to skip any non-empty output, so after the
# dot pipeline grew from 3 classes to 10, a re-run would have quietly kept every
# 3-class file from the previous build and cat'd them together with the new
# 10-class ones — a nationwide tileset that had the analytical overlays in the
# states that happened to get rebuilt and not in the rest, with no error emitted
# anywhere. Stale outputs are now rebuilt instead.

set -u

cd "$(dirname "$0")"
set -a; source /Users/clippy2/proj/.env; set +a
mkdir -p ../tiles/ldjson

STATES=(AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR)

# Fingerprint of the current class vocabulary + per-class density + minzooms +
# ACS var list. Any change to DOT_CLASSES or ACS_VARS changes this.
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
