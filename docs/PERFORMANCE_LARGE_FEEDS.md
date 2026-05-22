# Performance: Handling Large GTFS Feeds

**Status:** Phase 0 shipped (import size warning). Phases 1–4 proposed.
**Motivation:** Large regional feeds (e.g. RTD Denver, `mdb-178`) hang the tab
and then crash. The culprit is not stops or routes — it's `stop_times.txt`,
which for these feeds is millions of rows.

## Where it breaks today

Traced through the current import + storage + render path:

| Stage | What happens | File |
| --- | --- | --- |
| Parse | `stop_times.txt` parsed **synchronously on the main thread** via PapaParse, then a linear loop allocates one object per row | `src/services/gtfsImport.ts:30`, `:226` |
| Store | The full `stopTimes: StopTime[]` array lives in the Zustand store in memory | `src/store/tripSlice.ts` |
| Persist | On change, the **entire store snapshot is `JSON.stringify`'d into one blob** and written to IndexedDB (debounced ~1s) | `src/db/persistence.ts` |
| Render | Timetable grid, stop list, and map layers render **every row / feature with no virtualization** | `src/components/timetable/TimetableGrid.tsx`, `src/components/stops/StopList.tsx`, `src/components/map/StopLayer.tsx`, `RouteLayer.tsx` |

**Failure sequence for an RTD-sized feed:** synchronous parse blocks the main
thread for tens of seconds (looks like a hang) → a single Immer `setStopTimes`
with millions of objects spikes memory → `JSON.stringify` of the snapshot spikes
it again → tab OOMs and crashes. Even if it survives, opening a route renders
tens of thousands of DOM nodes and freezes again.

There is a hard ceiling here: a browser tab cannot hold an arbitrarily large
feed fully in memory. The goal is **"handles most large feeds gracefully,"** not
"handles everything." Truly massive feeds should still warn (Phase 0) and may
warrant a server-side path later.

---

## Phase 0 — Import size warning (SHIPPED)

Cheap pre-flight that reads the *uncompressed* size of `stop_times.txt` from the
ZIP central directory **without decompressing or parsing it**, and gates the
import behind a confirmation when it's large.

- `inspectGtfsZip(file)` + `LARGE_STOP_TIMES_BYTES` (40 MB ≈ ~700k–1M rows) —
  `src/services/gtfsImport.ts`
- Confirmation gate covering all three import sources (upload / URL / catalog),
  which all funnel through `parseFile` — `src/components/import-export/ImportDialog.tsx`

This stops the silent hang-then-crash: the user gets an explicit "this is very
large, may crash the tab" choice before any expensive work runs.

---

## Phase 1 — Parse off the main thread (HIGH impact, ~1–1.5 days)

**Goal:** the UI never freezes during import; show real progress.

- Move `importGtfsZip` into a **Web Worker**. JSZip, PapaParse, and the row
  loops all run in the worker; post the assembled arrays back via
  `postMessage` (consider `Transferable` / structured clone cost).
- Switch PapaParse to **streaming/chunk mode** (`step`/`chunk` callbacks)
  instead of parsing the whole string at once, so peak string + object memory
  is lower and progress is reportable.
- Replace the dropzone's static "Parsing…" with a **progress indicator**
  (rows parsed, file being read). The `ImportDialog` already has the state
  plumbing for this.

**Risk:** the `@turf` shape-distance recompute (`fillShapeDistances`,
`gtfsImport.ts:17`) is O(n²) per shape and also runs during import — verify it
isn't a second bottleneck for feeds with long, dense shapes; make it
incremental or defer it.

**Outcome:** kills the "hang" perception and the parse-phase freeze. Does *not*
by itself fix the memory ceiling — that's Phase 2.

## Phase 2 — Stop the persistence memory spike (HIGH impact, ~1 day)

**Goal:** importing a large feed doesn't OOM on the IndexedDB write.

- Stop serializing the whole store as one `JSON.stringify` blob
  (`persistence.ts`). Options, in order of preference:
  1. Store large tables (`stopTimes`, `shapes`) in their **own Dexie tables**
     as structured records (Dexie handles structured clone; no giant JSON
     string), keyed for bulk `bulkPut` in batches.
  2. If keeping the snapshot model, **omit `stopTimes` from the debounced
     snapshot** above a size threshold and persist it via a separate batched
     writer.
- Make the auto-save **skip or chunk** when the feed exceeds the Phase 0
  threshold, rather than re-serializing megabytes every second.

**Outcome:** removes the post-parse OOM crash and the per-second re-serialize
cost on big feeds.

## Phase 3 — Virtualize the heavy renders (MEDIUM impact, ~1–1.5 days)

**Goal:** opening a route / stop list / map on a big feed stays smooth.

- **Timetable** (`TimetableGrid.tsx:451`) and **stop list**
  (`StopList.tsx:342`): introduce row virtualization
  (`@tanstack/react-virtual` or `react-window`) so only visible rows mount.
- **Map**: enable **stop clustering** (Mapbox GL `cluster: true` on the source)
  in `StopLayer.tsx`; **simplify shape geometry** by zoom level in
  `RouteLayer.tsx` (Douglas–Peucker / drop points at low zoom) so a few hundred
  dense shapes don't ship full coordinate arrays at once.

**Outcome:** interaction after load no longer freezes.

## Phase 4 — Lazy stop_times (LARGER, optional, ~2–3 days)

**Goal:** never hold all stop_times in memory at once.

- Index `stopTimes` by `trip_id` in IndexedDB and load only the trips currently
  being viewed/edited, instead of one flat in-memory array in `tripSlice`.
- Touches the store API and every reader of `stopTimes`; do this only if Phases
  1–3 prove insufficient for the feeds we actually need to support.

---

## Suggested order & checkpoints

1. **Phase 1** (worker + streaming + progress) — biggest perceived win; fixes the hang.
2. **Phase 2** (persistence) — fixes the crash.
3. Re-test RTD Denver here. If it loads and is editable, **stop.**
4. **Phase 3** only if rendering is still rough; **Phase 4** only if memory still is.

Test fixture: RTD Denver (`mdb-178`,
https://mobilitydatabase.org/feeds/gtfs/mdb-178) is the canonical large-feed
regression case. Add a smaller large-ish feed for CI if one fits.
