# Ferry Feeds Analysis — WSF, BC Ferries, AMHS

How three Pacific Northwest ferry operators model their service in GTFS, what
the GTFS·X editor can reconstruct today, and what features the editor still
needs in order to produce a valid feed for ferry operators in general.

Sources examined:
- **Washington State Ferries (WSF)** — `https://business.wsdot.wa.gov/Transit/csv_files/wsf/google_transit.zip` (downloaded 2026-05-18)
- **BC Ferries** — `http://data.trilliumtransit.com/gtfs/bcferries-bc-ca/bcferries-bc-ca.zip` (Trillium-published official feed, valid 2026-05-12 → 2027-03-31)
- **Alaska Marine Highway System (AMHS)** — no GTFS feed; schedule reconstructed from `https://dot.alaska.gov/amhs/route.shtml`, `schedules.shtml`, and the 2026 summer schedule press release

---

## 1. What each feed actually looks like

### 1.1 Washington State Ferries

| | |
|---|---|
| Agency | 1 (`WSF`), timezone `America/Los_Angeles` |
| Routes | **38**, all `route_type = 4` (ferry) |
| Stops | **19** — one per terminal, all `location_type = 0`, no `parent_station`, no `zone_id` |
| Calendar | One `service_id` per **calendar date** (e.g. `20260518`, `20260519`, …) — schedule varies day-by-day, no weekly patterns |
| Trips | ~19,000, every trip has exactly **2** stop_times (origin + destination) |
| `stop_times` | `arrival_time == departure_time` on every single row (no dwell modeled) |
| `block_id` | Set on every trip (vessel/run blocking — e.g. `9113W_69`) |
| Fares | 8 `fare_attributes` (Cash Single Ride, Senior, Motorcycle, Passenger Through-Route, Foot Passenger, San Juan Inter-Island variants, Eastbound Refund). `fare_rules` join fare to **route_id only** — origin/destination/zone unused. |
| `frequencies.txt` | Not used |
| `transfers.txt` | Not used |

**Key modeling choice:** each port-pair direction is its own route. "Anacortes → Lopez Island" (`route_id=113`) and "Lopez Island → Anacortes" (`route_id=131`) are separate routes — `direction_id` is left blank on trips. Every trip is a single port hop. There are 38 routes because the WSF network has 7 inter-island legs (4×4 / 2 = 6 pairs × 2 directions = 12 inter-island routes) plus 13 mainland-island and cross-Sound legs, each doubled.

The "one service_id per date" pattern is unusual but valid; it lets WSF publish minor day-to-day variation without ever computing equivalence classes. The cost is a calendar of several hundred rows.

### 1.2 BC Ferries

| | |
|---|---|
| Agency | 1 (`965` / BC Ferries) |
| Routes | **22**, all `route_type = 4`. Extension columns: `route_sort_order`, `min_headway_minutes`, `eligibility_restricted`, `continuous_pickup/drop_off`, `route_color`, `route_text_color` |
| Stops | **96**, with proper **parent/child hierarchy**: each terminal is `location_type=1` (station) with `stop_timezone`, plus one or more `location_type=0` boarding-area children linked via `parent_station` |
| Calendar | Several **named service patterns** plus `calendar_dates.txt` for exceptions. The extension file `calendar_attributes.txt` gives each `service_id` a human-readable `service_description` like *"2026-06-03 to 2027-03-31 (No Saturday)"*. Hundreds of distinct service IDs (one per route × season × DOW combination). |
| Trips | 872, most 2-stop. **18 trips have 3 stops** — these are the multi-port runs (Southern Gulf Islands, Port McNeill–Alert Bay–Sointula, Chemainus–Thetis–Penelakut). |
| `stop_times` | Again `arrival_time == departure_time` on every row, even for the 3-stop trips. `timepoint=1` on every row. `shape_dist_traveled` is populated. |
| Fares | **Empty** — `fare_attributes.txt`, `fare_rules.txt`, `farezone_attributes.txt` all have only headers. Riders are pointed to `agency_fare_url`. |
| `transfers.txt` | Used for same-terminal min-transfer-time (`transfer_type=2` with `min_transfer_time` of 2700 sec / 45 min) and a few cross-berth links. |
| `frequencies.txt` | Empty |
| Other extensions | `areas.txt`, `booking_rules.txt`, `directions.txt`, `linked_datasets.txt`, `location_groups.txt`, `runcut.txt`, `stop_attributes.txt`, `timetables.txt`, `timetable_stop_order.txt` (Trillium GTFS-Editor conventions; mostly empty or sparsely populated) |

**Key modeling choices:**
- BC Ferries reuses one `route_id` for both directions; `direction_id` 0/1 distinguishes outbound vs inbound (e.g. `Tsawwassen (Vancouver)` headsign for 0, `Duke Point (Nanaimo)` for 1). That's the opposite of WSF's split-direction routes.
- The parent_station hierarchy is what lets a single terminal contain multiple berths and lets future GTFS-Pathways describe walking inside the terminal.
- Transfers at the same `stop_id` capture the realistic 45-minute connect window — get-off-load-vehicle-board-next-vessel time.

### 1.3 Alaska Marine Highway System

No GTFS feed exists. Schedule structure inferred from the AMHS Route Guide and the 2026 summer schedule (May 1 – Sept 30, 2026):

- **9 vessels** (`MV Kennicott`, `MV Tustumena`, `MV Matanuska`, `MV Columbia`, `MV LeConte`, `MV Aurora`, `MV Lituya`, `MV Hubbard`, `MV Tazlina`) serving **35 communities** across **~3,500 miles** from Bellingham WA to Dutch Harbor.
- **~11 mainline routes** (multi-port linear voyages), **6 day-boat routes**, **1 shuttle** (Ketchikan ↔ Metlakatla, 45 min).
- **Multi-day, multi-stop voyages.** Example Southeast Alaska mainline:
  `Bellingham → Ketchikan (38 h) → Wrangell (6 h) → Petersburg (3 h) → Juneau (8 h) → branches to Haines/Skagway/Sitka`. Total Bellingham → Skagway: ~3 days with ports of call.
- **Substantial dwell time at intermediate ports.** A vessel arrives at Wrangell at, say, 03:00, and departs at 04:30 — `arrival_time` and `departure_time` genuinely differ by 60–120 minutes per stop. This is fundamentally different from the WSF/BCF assumption.
- **Vessels span calendar days.** A voyage that leaves Bellingham at 18:00 on Friday arrives Ketchikan at 08:00 Sunday. GTFS requires this to be encoded as `arrival_time = 38:00:00` (or larger) on the same trip, anchored to the Friday `service_id`.
- **Vessels are shared across routes.** A single physical vessel may run a mainline voyage one week and a day-boat route the next; `block_id` should be used to express turnaround / vessel reuse for trip planners.
- **Fares are point-to-point** with passenger + vehicle + cabin add-ons. Pricing depends on origin/destination pair, not on route. Senior/child discounts apply. There is no flat per-route fare; you cannot model AMHS fares without origin/destination fare rules (legacy GTFS-Fares v1) or `fare_leg_rules` / `fare_products` (Fares v2).
- **Schedule is published as colored monthly grids per region/vessel.** There are 1–3 sailings per week per route in shoulder seasons, daily on the Lynn Canal day boats, weekly-or-less for the long mainlines.

AMHS is the hardest of the three to model because it's the only one that *requires* features WSF and BCF didn't need: separate arrival/departure, multi-stop trips, overnight times, point-to-point fares, and meaningful vessel blocking.

---

## 2. Editor capability inventory vs. ferry needs

What GTFS·X has today, mapped against the three feeds:

| Capability | Editor today | WSF needs | BCF needs | AMHS needs |
|---|---|---|---|---|
| `route_type = 4` (Ferry) | ✅ in `ROUTE_TYPES` dropdown | ✅ | ✅ | ✅ |
| Multi-stop routes (>2 stops) | ✅ via `RouteStopsTab` + `routeStops` ordering | n/a (2-stop) | ✅ (3-stop runs) | ✅ (5–10 stop voyages) |
| Per-direction route naming | ✅ (`_direction_0_name`/`_direction_1_name`) | n/a (one route per direction) | ✅ | ✅ |
| Per-stop arrival vs departure time | 🔴 **`TimeCell` writes one value to both fields** (`TimetableGrid.tsx:468`) | OK (collapse is fine) | OK | ❌ blocker — dwell time at intermediate ports cannot be expressed |
| GTFS times > 24:00 (overnight) | 🟡 `gtfsTimeToSeconds` and `normalizeTimeInput` accept any HH, but `formatTimeShort` renders "28:30" as-is — no UX guardrail | n/a | n/a | ❌ blocker — vessels arriving 14 h after departure date |
| `parent_station` / location_type=1 stations | 🟡 `location_type` is in `LOCATION_TYPES` dropdown, but there's **no UI to set `parent_station` on a child stop** | n/a | ❌ — needed for terminal-with-berths hierarchy | ⚠ recommended |
| `stop_timezone` | 🟡 in the type, **no UI field** in `StopEditPanel.tsx` | n/a (single TZ) | ✅ needed (BCF uses both America/Vancouver and America/Los_Angeles on different stops) | ❌ — voyages cross between Pacific and Alaska time |
| `block_id` on trips | 🟡 in the `Trip` type and round-tripped via import/export, **no UI** | ⚠ recommended (WSF uses everywhere) | n/a | ❌ — vessel-sharing across routes |
| `stop_headsign` | 🟡 in the `StopTime` type, **no UI** | ⚠ used by WSF | n/a | ⚠ useful for "Continuing to Juneau" signage at intermediate stops |
| Calendar — one service per date | ✅ supported (the editor doesn't care if every service_id covers a single date) | ✅ workable (tedious by hand; would need a bulk generator) | n/a | n/a |
| Calendar — named weekly patterns | ✅ `CalendarEditor` | n/a | ✅ | ✅ (seasonal patterns + `calendar_dates.txt` exceptions) |
| `calendar_dates.txt` | ✅ via type + import/export | n/a | ✅ | ✅ |
| Fares — flat per-route | ✅ `FaresEditor` rules join fare to `route_id` | ✅ | n/a (empty) | n/a |
| Fares — fare-type prefix (Regular/Reduced/Senior/Student/Free) | ✅ encoded as `fare_id` prefix | ✅ (WSF has 8 classes — only 5 fit the existing enum; the rest become "Regular" with custom IDs) | n/a | ⚠ — need at least Senior/Child |
| Fares — origin/destination rules | 🔴 fields exist in type and import/export, **no UI** in `FaresEditor` | OK (WSF doesn't use them) | n/a | ❌ blocker — AMHS fares are inherently OD |
| `zone_id` on stops | 🔴 field exists in type and import/export, **no UI** in `StopEditPanel` | n/a | n/a | ❌ blocker if modeling AMHS fares as zone pairs |
| `transfers.txt` | 🔲 planned (`REQUIREMENTS.md`), not implemented | n/a | ❌ — used for the 45-min same-terminal connect window | ⚠ for inter-vessel connections at hub ports (Juneau, Ketchikan) |
| `frequencies.txt` | 🔲 planned, not implemented | n/a | n/a | n/a — all three operators publish exact schedules |
| Time interpolation along shape | ✅ `interpolateStopTimes` in `tripSlice.ts` (uses `shape_dist_traveled`) | n/a | ⚠ helpful for the 3-stop runs | ✅ very useful for AMHS multi-port voyages |
| Per-route map shape with snap-to-road | ✅, but snap-to-road is land-only | ✅ (freehand the water leg) | ✅ | ✅ |
| Bulk trip duplication ("Repeat Every…") | ✅ in `TimetableGrid` | ✅ | ✅ | ⚠ less useful — AMHS sailings aren't on a headway |

🔴 = present in data model but no UI surface • 🟡 = partial • ⚠ = useful but not strictly required • ❌ = blocks valid reconstruction

---

## 3. Reconstruction recipes — using GTFS·X *as it exists today*

### 3.1 WSF (Washington State Ferries) — **fully reconstructable**

WSF is the closest fit to the editor today. Build it like this:

1. **Agency** — create one agency `WSF` with timezone `America/Los_Angeles`.
2. **Stops** — place 19 terminals on the map (Anacortes, Bainbridge Island, Bremerton, Clinton, Coupeville, Edmonds, Fauntleroy, Friday Harbor, Kingston, Lopez Island, Mukilteo, Orcas Island, Point Defiance, Port Townsend, Seattle, Shaw Island, Southworth, Tahlequah, Vashon Island). Leave `location_type = 0`; no parent stations needed.
3. **Routes** — create **38 routes**, one per directed port pair (e.g. "Anacortes – Lopez Island" and "Lopez Island – Anacortes" are two separate routes). All `route_type = 4`. Draw the shape for each as a freehand polyline (snap-to-road is land-only and useless on water).
4. **Route stops** — for each route, add exactly 2 stops in `RouteStopsTab` (origin then destination).
5. **Calendar** — this is the painful part. WSF publishes one `service_id` per *calendar date*. Today the editor's `CalendarEditor` makes you add each date by hand. **Recommended workaround:** use weekly patterns ("WeekdayWinter", "WeekendSummer") and accept that your feed won't be byte-identical to WSF's. Validators will accept either.
6. **Trips and times** — for each route's daily schedule, add trips and enter the single departure time per port. The `TimeCell` writing the same value to arrival and departure is *correct* for WSF — there's no dwell to model.
7. **Fares** — add `fare_attributes` for each WSF fare class. Use the existing "Senior / Reduced / Student / Free" prefix encoding; the other WSF classes (Motorcycle, Foot Passenger, Eastbound Refund) become custom Regular IDs. Tie each via `fare_rules` to the routes it applies to — the editor already supports route-level rules.
8. **Block IDs** — *cannot* be entered through the UI today. They round-trip on import/export but new feeds you author here will have empty `block_id`. The feed is still valid; only block-aware trip planners (e.g. those drawing vessel turnaround) lose information.

**Verdict: reconstructable today.** Loss vs. official feed: missing `block_id` (no editor surface), and you'll likely use weekly patterns instead of per-date services.

### 3.2 BC Ferries — **partially reconstructable**

You can get a valid, usable feed today, but it will be **structurally simpler** than the official one because the editor lacks parent-station and `stop_timezone` UI:

1. **Agency** — create `BC Ferries`, timezone `America/Vancouver`.
2. **Stops** — place 33 terminals. **Limitation:** today the editor can only set `location_type` (Station / Stop / Entrance / etc.) but not link a child stop's `parent_station` to a station. Pick one of two compromises:
   - **(Recommended)** Place one `location_type=0` stop per terminal and skip the hierarchy. Feed is valid; you lose the multi-berth detail.
   - Place both station and berth stops and edit `parent_station` by hand-editing the exported `stops.txt` (round-trip will preserve it).
3. **Routes** — create 22 routes, all `route_type = 4`. Set per-route `_direction_0_name` and `_direction_1_name` to the inbound/outbound terminals.
4. **Route stops** — most routes have 2 stops. For the 3-stop runs (Southern Gulf Islands; Chemainus–Thetis–Penelakut; Port McNeill–Alert Bay–Sointula), add all three intermediate stops to `RouteStopsTab` in order.
5. **Calendar** — create named weekly patterns for each season ("April–June No Saturday", "Summer Daily", etc.). Use `calendar_dates.txt` for the holiday exceptions. The editor already supports this.
6. **Trips and times** — single time per port works fine here too (`arrival_time == departure_time` on the official feed). For the 3-stop runs, `interpolateStopTimes` can fill the middle if you've drawn an accurate shape with `shape_dist_traveled`.
7. **Fares** — **skip them.** The official BCF feed has empty fare files and points to `agency_fare_url`. Set the route URL and agency fare URL fields; that matches BCF practice.
8. **Transfers** — the 45-min same-terminal connect window cannot be authored today (no `transfers.txt` editor). It's planned (see `REQUIREMENTS.md` §1.1). Feed validates without it; trip planners just won't enforce the connection minimum.

**Verdict: reconstructable today** with degraded fidelity — single-level stops, no transfer-time guarantees. Most rider-facing apps will work.

### 3.3 AMHS (Alaska Marine Highway) — **not reconstructable today**

You can lay out the *shape* of an AMHS feed in the editor, but you cannot produce a **valid and accurate** GTFS feed without four changes (covered in §4). The fundamental blockers:

1. **No separate arrival/departure times.** AMHS vessels dwell 30 min – 4 h at intermediate ports. With today's `TimeCell` you'd have to either:
   - Pretend the dwell is zero (lie about the schedule), or
   - Add the dwell to the departure and call it arrival (rider thinks the boat docks later than it actually does and misses meeting passengers).
   Both produce a feed that's misleading to riders.
2. **No UI for >24:00 times.** Multi-day voyages need stop_times like `38:00:00`. The store will accept it via import; the timetable cell will display it as "38:00" with no validation message. Authoring it by hand works but is fragile.
3. **No origin/destination fare rules.** AMHS fares are point-to-point (Bellingham→Ketchikan ≠ Wrangell→Petersburg). Today's `FaresEditor` only ties a fare to a `route_id`. You'd be forced to either omit fares or define a separate route per OD pair — an explosion that defeats the purpose of multi-stop trips.
4. **No `block_id` UI.** Vessel reuse across routes is editorial-only.

You could still use the editor as a **drafting surface** (stops, routes, shapes, weekly patterns) and post-process the export to splice in arrival/departure separation, overnight times, and fare matrices. But that's a workflow, not a feed authoring story.

---

## 4. Required functionality changes for ferry support

Tiered by impact on what's reconstructable.

### Tier 1 — unblocks AMHS (and tightens BCF)

**4.1 Separate arrival and departure time columns in the timetable.** *(Critical)*

`src/components/timetable/TimetableGrid.tsx:464-480` currently writes one input value to both `arrival_time` and `departure_time`. Add either:
- **Two columns per stop** in the grid (compact: "arr / dep" stacked, or "12:00 / 12:30" inline), or
- **A per-cell expand control** that splits into two inputs only when the user wants to enter a dwell (default to single time, expand on click). This minimizes visual clutter for the 95% of transit where dwell is zero.

The data model already supports this (`StopTime` has both fields); the change is purely in `TimeCell` and the surrounding cell layout. Validation should warn if `departure_time < arrival_time`.

**4.2 Make >24:00 times safe and visible.** *(Critical for multi-day routes)*

`utils/time.ts` parses them correctly; the display is the problem. Add:
- Visual treatment in `formatTimeShort` for hours ≥ 24 (e.g. "04:30 +1d" or "28:30" badge),
- A helper input that lets users enter "next-day 04:30" and have the editor compute the GTFS string,
- Validator rule that flags times ≥ 48:00 as suspicious (most overnight services don't exceed 30:00).

**4.3 `parent_station` UI on stops, and `stop_timezone` field.** *(Required for accurate BCF; recommended for AMHS)*

In `StopEditPanel.tsx`, when `location_type` is 0/2/3/4, add a "Parent Station" dropdown listing all `location_type=1` stops. Add a `stop_timezone` text field (or autocomplete from the existing `US_TIMEZONES` constant in `utils/constants.ts`, extended with `America/Anchorage`, `America/Vancouver`).

**4.4 Origin/destination fare rules.** *(Blocks AMHS fare modeling)*

`FaresEditor.tsx` only authors `fare_id ↔ route_id` rules. Extend it to support `origin_id` and `destination_id` (against stop `zone_id`). This needs a paired change:
- A "Fare zones" panel (or a `zone_id` field on `StopEditPanel`) so users can group terminals into zones.
- A "Per-OD fare matrix" view inside the fare detail panel: rows = origin zones, columns = destination zones, cells = price.

For AMHS specifically, each port can be its own zone (35 zones, ~1200 OD cells, only ~200 actually populated). A matrix editor with a "copy reverse direction" affordance handles this scale.

Longer-term: GTFS-Fares v2 (`fare_products.txt`, `fare_leg_rules.txt`) is the spec-blessed direction for OD pricing. The current `FaresEditor` is Fares v1; building OD support there gets us 80% of the value for 20% of the work, and a Fares v2 migration can come later.

### Tier 2 — useful for any operator but especially ferries

**4.5 `block_id` UI on trips.** *(Useful for WSF, important for AMHS)*

Add a `block_id` field to the trip-edit affordance (currently the only trip-level UI is the trip name cell in `TimetableGrid` and the `RouteTripsTab`). Block-aware trip planners use this to show vessel turnaround and through-routing.

**4.6 `stop_headsign` override per stop_time.** *(Useful)*

WSF sets `stop_headsign` (e.g. "Lopez Island") on each stop_time so that intermediate-stop riders see the next destination, not the final one. AMHS would use it similarly ("Continuing to Juneau"). A simple right-click "Override headsign at this stop" on the timetable cell, with the override appearing as a small badge.

**4.7 `transfers.txt` editor.** *(Required for BCF fidelity, useful for AMHS)*

Already on the roadmap (`REQUIREMENTS.md` §1.1). Minimum needed for ferries: same-stop transfers (`from_stop_id == to_stop_id`) with a `min_transfer_time` for the load/unload-and-board window. BC Ferries uses 2700 sec (45 min). AMHS would use longer at hub ports.

### Tier 3 — quality-of-life

**4.8 Bulk per-date service generator.** WSF publishes one `service_id` per date. Today the editor's `CalendarEditor` requires manual entry. Add a "Generate one service per date in range" button for operators that follow this pattern.

**4.9 Water-only freehand drawing mode** that disables snap-to-road by default for routes with `route_type = 4`. Today freehand exists but the default `snapToRoad` setting wastes API calls and produces nonsense for sea routes.

**4.10 Ferry-aware route templates.** When a user creates a `route_type = 4` route, default `_direction_0_name` / `_direction_1_name` to "Outbound" / "Inbound" → "Westbound" / "Eastbound" or terminal-named (e.g. "To Bainbridge" / "To Seattle"). Small but consistent with how all three operators name directions.

---

## 5. Recommended order of work

If the goal is "GTFS·X can author a valid feed for any small ferry operator":

1. **4.1 separate arrival/departure** — single largest unblock, ~1 day of work in `TimetableGrid`. Also resolves a future bus-with-layover gap.
2. **4.3 parent_station + stop_timezone UI** — couple of form fields, ~half a day. Unlocks BCF-fidelity feeds.
3. **4.5 block_id UI** — trivial.
4. **4.2 overnight times UX** — display + validator changes, ~half a day. Doesn't change the data model.
5. **4.7 transfers.txt** — already planned.
6. **4.4 OD fares + zone_id** — the largest single feature (matrix editor, zone management). Defer unless AMHS-scale authoring is a near-term goal.

After 4.1–4.5 + 4.7, GTFS·X can produce WSF and BC Ferries feeds at full fidelity, and an AMHS feed that's accurate on times/blocks/transfers but still missing point-to-point fares.

---

## Sources

- [Washington State Ferries GTFS feed (WSDOT)](https://business.wsdot.wa.gov/Transit/csv_files/wsf/google_transit.zip)
- [Transitland — WSF feed metadata](https://www.transit.land/feeds/f-c28-washingtonstateferries)
- [BC Ferries GTFS feed (Trillium)](http://data.trilliumtransit.com/gtfs/bcferries-bc-ca/bcferries-bc-ca.zip)
- [Mobility Database — BC Ferries](https://mobilitydatabase.org/feeds/mdb-690)
- [AMHS Route Guide](https://dot.alaska.gov/amhs/route.shtml)
- [AMHS Schedules portal](https://dot.alaska.gov/amhs/schedules.shtml)
- [AMHS Fares](https://dot.alaska.gov/amhs/fares.shtml)
- [AMHS 2026 Summer Schedule press release](https://dot.alaska.gov/comm/pressbox/arch2026/PR26-0005.shtml)
