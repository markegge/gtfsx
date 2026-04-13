#!/usr/bin/env bash
# Build line-delimited GeoJSON dot outputs for every US state + DC + PR.
# Runs 4 states in parallel; writes per-state logs to tiles/ldjson/dots_{ST}.log.
# Safe to re-run: existing non-empty outputs are skipped.

set -u

cd "$(dirname "$0")"
set -a; source /Users/clippy2/proj/.env; set +a
mkdir -p ../tiles/ldjson

STATES=(AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR)

build_state() {
  local st="$1"
  local out="../tiles/ldjson/dots_${st}.ldjson"
  local log="../tiles/ldjson/dots_${st}.log"
  if [ -s "$out" ]; then
    echo "  [skip] $st already built ($(du -h "$out" | cut -f1))"
    return 0
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
