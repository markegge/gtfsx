# Rail Elegance — Issues + Corrective Plan

A walkthrough audit of the new two-rail layout (left navigation rail + right configuration rail), conducted 2026-05-10 against the `exploration/right-rail-and-responsive-left` branch. The goal is an elegant, consistent implementation, not a list of every paper cut.

This document is **a plan**, not a changeset. Each item is followed by a corrective sketch; sequencing is in §6.

---

## 1. Scope reviewed

Walkthroughs covered the following surfaces against `docs/REQUIREMENTS.md`:

- **Top-level layout**: TopBar, LeftRail (3 widths), RightRail (open/closed/shape-edit strip), BottomPanel.
- **All 9 left-rail sections**: Agency, Fares, Calendars, Routes (list + detail tabs), Stops, Flex Zones, Costs, Coverage, Title VI.
- **Route detail tabs**: Details / Stops / Trips / Frequencies.
- **Empty states** for every section.
- **Shape-edit collapse** behavior on Routes.
- **Map + bottom-panel interaction** with the rail.

Not exhaustively reviewed (out of scope for this pass): admin console, account/feeds pages, embed renderer, validation auto-fix dialog, import/export dialogs.

---

## 2. Cross-cutting issues

These are the patterns that show up everywhere; fixing them once removes the most paper cuts.

### 2.1 Breadcrumb redundancy

Every section that has a group label renders the breadcrumb as `Group › Section` followed immediately by `Section` as the H2. For seven of nine sections the leaf and title are identical strings:

| Section | Renders as |
|---|---|
| Routes (list) | `Fixed Route Service › Routes` / **Routes** |
| Stops | `Fixed Route Service › Stops` / **Stops** |
| Flex Zones | `GTFS-Flex › Flex Zones & Rules` / **Flex Zones & Rules** |
| Costs | `Analysis › Costs` / **Costs** |
| Coverage | `Analysis › Coverage` / **Coverage** |
| Title VI | `Analysis › Title VI` / **Title VI** |

**Corrective sketch.** Drop the breadcrumb on top-level section landings; show the group only as a small eyebrow above the title (`SERVICE` over **Routes**). Keep the breadcrumb pattern *only* when there is an actual hierarchy to navigate — i.e. the route-detail header (`Routes › Blueline`). That breadcrumb is doing real work; the section ones aren't.

### 2.2 Eyebrow style overload

The same uppercase + 11px + `text-warm-gray` style is used for: form-field labels (`SHORT NAME`), sub-section headings (`FIXED ROUTE FARES`, `ASSUMPTIONS`, `ROUTE SHAPES`), the section group label (`SERVICE`), and the bottom-panel tab eyebrows. They're indistinguishable, so visual hierarchy collapses.

**Corrective sketch.** Adopt three distinct text styles:

- **Section title** — H2, 18 px, font-heading, dark-brown.
- **Sub-section heading** — H3, 13 px, font-heading, dark-brown, with optional `pill-count` on the right (matches the design source's `.rr-section-head`).
- **Eyebrow / form-field label** — 11 px, uppercase, warm-gray, the existing pattern. Reserved for *labels*, not for *headings*.

Applies to: AgencyEditor (`Feed Info`), FaresEditor (`Fixed Route Fares`, `Demand Responsive Fares`), CostSummary (`Assumptions`, `System Totals`, `Per-Route Breakdown`), CoveragePanel + TitleVIPanel (any tabs/sub-headers), CalendarEditor (`Service Patterns` and the per-pattern editor section).

### 2.3 Sub-heading duplication of the section title

Several panels render a sub-heading that essentially repeats the rail's H2:

| Section | Rail H2 | Body sub-heading |
|---|---|---|
| Costs | Costs | "Cost Summary" |
| Flex Zones | Flex Zones & Rules | "GTFS-Flex" + descriptive paragraph |
| Calendars | Calendars | "Service Patterns" |

**Corrective sketch.** Strip these. The section is already named in the rail header. If a description is genuinely useful (Flex), move it to a one-line `<p class="help">` directly under the title, in the rail header itself, not as a duplicate sub-heading.

### 2.4 Padding inconsistency

`RightRail` now wraps the panel body in `p-5`, but several panel components have lingering `p-3` / `px-3` wrappers from when they rendered inside the older 300px sidebar. Result: uneven inner spacing depending on which section is open.

**Corrective sketch.** Audit each panel's outermost `<div>`: remove panel-level horizontal padding so the rail's `p-5` is the single source of truth. Sub-sections may add `p-4` on cards (e.g. `flag-block`, `Cost Estimation` accordion) but should not re-pad the whole panel.

### 2.5 CTA style fragmentation

Primary "create" actions are rendered four different ways:

- `+ Create Route` — coral solid button (RouteList empty state, via `EmptyState`)
- `+ Add Agency` — coral solid (EmptyState) ✓
- `+ Add Service Pattern` — sand dashed pill (CalendarEditor)
- `+ Add Fare` — sand dashed pill (FaresEditor)
- `+ Create New Flex Zone` — purple solid (FlexEditor)

**Corrective sketch.** Two CTA tiers, applied consistently:

- **Primary CTA** (`btn-primary`) — coral solid; used for the headline action of the panel (`+ Create Route`, `+ Add Agency`, `+ Add Service Pattern`).
- **Secondary "add to existing list"** (`btn-dashed`) — dashed sand; used when adding an additional item below an existing list (`+ Add Route`, `+ Add Fare` once one exists).

Flex Zones is the outlier with purple — the purple maps to GTFS-Flex's tile color and isn't necessarily wrong, but should be applied consistently (purple primary CTAs *only* in the Flex section, as a deliberate brand-association).

### 2.6 Form layout under-uses the 460 px width

At 460 px the rail can comfortably fit 2-up form fields, but most panels stack everything in a single column. Existing 2-up usage is sporadic:

- Agency: all single-column (Phone+Email and Language+Fare URL would pair naturally).
- Calendars: Start/End dates already paired ✓.
- Routes Details: Direction 0/1 paired, continuous_pickup/drop-off paired ✓; the rest single-column.
- Costs: single-column ✓ (numerics are short).

**Corrective sketch.** A `field-row-2` Tailwind utility (`grid grid-cols-2 gap-3`) applied where fields are short and parallel: Phone/Email, Direction labels, pickup/drop-off, etc. Long fields (Description, URL) stay single-column.

### 2.7 Section-title vs entity-title competing for the same slot

When you're deep in a route (`Routes › Blueline`), the rail header shows the *entity*'s title ("Blueline") with its swatch — replacing the section's title ("Routes"). This is the right call, but it's not done elsewhere:

- Calendar editor shows "Service Patterns" sub-heading even when one specific pattern is selected for editing — the active pattern's name is buried in a card above the editor.
- A future stop-detail view would have the same need.

**Corrective sketch.** Adopt a consistent **section vs entity** header pattern across all panels with master-detail:

- **Section header** (no entity selected): `[GROUP eyebrow] / Section title / X close`.
- **Entity header** (drilled into one item): `Section › Entity name (clickable) / X close` then `[swatch] Entity title [actions]` then `[tabs strip]`.

Apply to: Routes ✓ (already done), Calendars (calendar-detail), Stops (stop-detail), Flex Zones (zone-detail), Fares (fare-detail).

### 2.8 Empty-state inconsistency

Each empty state is hand-rolled: different icons (🗺️ vs `🏢` vs JUL/17 page-flip vs scale ⚖️), different button styles, and different subtitle tone.

**Corrective sketch.** All empty states route through `<EmptyState>` (already exists for Agency / Routes); migrate the rest. Standardise on:

- Icon: 64 × 64 illustration centred (the "warm + slightly playful" mood per requirements §Design direction).
- Title: H3, friendly, non-technical ("No service patterns").
- Subtitle: 1 short sentence (≤ 80 chars).
- Single primary CTA. No secondary CTA in the empty state.

### 2.9 Rail close vs section-clear conflation

Today the X button in the rail header always sets `sidebarSection: null`, which both (a) closes the rail and (b) deselects the nav. There's no way to "minimize" without losing your place. This bites in two places:

- **Route detail.** The X in the route-detail header closes the *whole* rail (and clears `editingRouteId`). The breadcrumb's "Routes" link is the only way to step back to the list view without losing state. Users will mistakenly hit X expecting to "go up one level".
- **Quick map glance.** I'm editing a route, want a clear map view for two seconds, expect the rail to slide closed and snap back. Today there's no toggle for that.

**Corrective sketch.** Two-button model in the route-detail header:

- `←` (or breadcrumb) → step up one level (clear `editingRouteId`, keep rail open showing list).
- `✕` → close rail. Section stays selected. A reopen affordance (the existing `‹` strip) lets the user snap back without re-clicking the left-rail tile.

For top-level section panels (no entity), only `✕` is needed, and it should *only* close the rail (set `rightRailOpen: false`), keeping `sidebarSection` intact. Picking another section reopens it on that section.

### 2.10 Map ↔ rail context coupling is partial

The map is meant to react to the rail's selected section/entity:

- Routes → highlights the selected route, focuses on its bbox. ✓
- Stops (route-scoped) → shows the selected route's stops only. ✓
- Coverage → applies the buffer overlay. ✓
- Calendars → no map effect. ✓ (correct)
- Flex Zones → highlights the active zone. ✓
- Costs → no map effect. (could highlight per-route).
- Title VI → applies the block-group classification overlay. ✓

The route-detail tabs *don't* propagate context: clicking the **Stops** tab inside a route shows that route's stops in the rail body, but the map doesn't change focus. Same for **Trips**.

**Corrective sketch.** Each tab body, on mount, calls a pre-defined "focus" intent on the map:

- Details → fitBounds(route shapes).
- Stops → fitBounds(route stops); show stop sequence numbers.
- Trips → fitBounds(route shapes); flag direction tracks 0/1.
- Frequencies → no-op.

---

## 3. Left-rail issues

### 3.1 The 36 px expand/collapse strip

Current bottom strip carries the « / » buttons taking 36 px of vertical real estate from the nav itself. At mid (96 px) you can fit roughly 9 tile-buttons in 720 px; the lost 36 px hides "Title VI" off-screen by a few pixels at 1440×900 (currently visibly clipped at the bottom).

**Corrective sketch.**

- Float the rail-width control as a small chevron in the *top-right of the rail header strip* (not its own bar), or
- Show the chevron as an icon that overlaps the rail's bottom-right corner and only renders on hover, or
- Move it into a topbar control ("rail width" segmented control next to the project name pill).

The simplest and most "elegant" choice is the third: a single segmented control near the brand pill that says `▎` `▍` `▌` (40 / 96 / 260) — visible but unobtrusive.

### 3.2 Tile clipping at narrow viewport heights

At 720 px tall and mid width, "Title VI" is partially clipped because of the strip cost above + section dividers + 9 tiles. Fixing 3.1 (recovering 36 px) plus a slightly tighter `.resp-icon-btn` spacing covers this; a fall-back is `overflow-y: auto` (already on) — but no scroll affordance is shown to users, so they may not notice.

**Corrective sketch.** Add a subtle top/bottom fade-mask on `.left-rail` when it's scrollable, the same `linear-gradient` trick the design source uses on `.resp-content-fade`.

### 3.3 Group eyebrow labels in mid mode

In mid (96 px) mode the group labels "SETUP", "SERVICE", "ANALYZE" are tiny centered text and read more as decoration than navigation. Skipping them gains visual quiet; alternative: drop them at mid, keep them at max.

**Corrective sketch.** Hide group eyebrows when `effective === 'mid'`. Leave them in `min` (the existing dividers do the job there) and `max` (full-width, accordion caps need a label).

### 3.4 Min-mode dot indicators

The 6 px coral dot for "this section has content" is small and easy to miss. The mockup uses a colored filled tile as the affordance, which is more salient.

**Corrective sketch.** In min mode, switch from "tile + tiny dot" to "tile renders in its own color when populated, in muted gray when empty." Keep the dot only as a "needs attention" indicator (e.g. validation errors, future).

---

## 4. Right-rail issues

### 4.1 Shape-edit collapse strip discoverability

The 36 px vertical strip with rotated text "Editing shape · click to exit" is creative but easy to miss. Some users will lose the rail and not understand how to bring it back.

**Corrective sketch.**

- Replace the rotated label with a horizontal pill: the strip stays 36 px wide; render an X-style icon at the top with a one-line tooltip on hover (`Click to exit drawing`).
- Mirror the same affordance the user already learnt from the rail's normal close button.
- Pair with a small persistent toast or map-overlay banner: "Drawing route shape — click `↩` to exit" so the *exit gesture* is foregrounded, not just the rail strip.

### 4.2 Rail collapse affordance when mode-toggled vs user-closed

When the user clicks `✕`, the rail is gone with no on-screen reopen affordance — they have to click a left-rail tile. When the rail is gone *because of shape editing*, the strip *is* the reopen affordance. Two different visual states for "rail is closed" → confusing.

**Corrective sketch.** Always leave a 36 px "rail is closed" strip on the right edge, with a single chevron `‹` and the section name labelled vertically. Click → rail reopens to whatever section was last open. Remove the "set section to null on close" behaviour (§2.9).

### 4.3 No horizontal resize affordance

The rail is locked at 460 px. On smaller viewports (≤ 1280 px wide), with the left rail taking 96 px and the rail taking 460 px, the map drops to ~720 px. A drag-to-resize handle on the rail's left edge would let power users tune. The design source supports this (slider in tweaks panel).

**Corrective sketch.** Optional, deferred. Add a 4 px hover-only resize handle on the rail's left edge, persisted to `rightRailWidth: number` in store, clamped to [380, 640]. Snap to 460 by default.

### 4.4 Open behavior memory

Today the rail opens onSelect; closing clears the section. So toggling between "rail open" and "rail closed" means re-clicking the same nav item — there's no "I'd like the rail back where I left it" gesture.

**Corrective sketch.** Combined with §4.2: closing keeps `sidebarSection`; reopen strip restores. Add `Cmd+/` (Ctrl+/ on Linux/Win) keyboard shortcut for "toggle rail".

### 4.5 Header action buttons missing in route detail

The original mockup placed `Duplicate` and `Delete` in the entity header next to the title. Currently `Delete route` is a small red link at the bottom of the Details tab; `Duplicate` doesn't exist.

**Corrective sketch.**

- Move `Delete` to a header `btn-danger-ghost` next to the title.
- Add `Duplicate` as a header `btn-ghost`. Behaviour: clones the route + all its `route_stops` + its trips with new IDs, appends a `(copy)` suffix to the long name.
- Hoist the existing delete-confirmation dialog (with the orphan-stops checkbox) to a shared modal component so both the header and any future deletion entry-point share the same UX.

### 4.6 Save-state visibility

The TopBar shows `Saved` / `Unsaved changes`, but the rail itself doesn't surface save state per-form. For long forms this is fine. But during route shape edits the rail is collapsed; the `Save` button on the shape-edit toolbar is what the user is looking for. There's no consistent "draft / saved / dirty" indicator pattern across panels.

**Corrective sketch.** Trust the TopBar indicator (one source of truth). Don't replicate save-state in the rail. *Do* preserve the explicit "Save Changes" / "Cancel" buttons that appear during shape editing — those are about the shape edit, not the autosave.

---

## 5. Per-panel notes

### 5.1 Agency

- Empty state is good; CTA is consistent.
- Form is single-column for everything. Apply 2-up to Phone/Email and Language/Fare URL.
- "Feed Info" sub-heading should be promoted from eyebrow to H3 (per §2.2).
- Consider whether Feed Info is part of `Agency` at all, or belongs in a separate section. It's a separate file in GTFS (`feed_info.txt`) and conceptually different. *Recommendation*: leave it here for now — agencies and feed publisher info typically map 1:1 — but add a divider/heading that says `Feed Info` clearly.

### 5.2 Calendars

- Section title says "Calendars"; the body sub-heading says "Service Patterns" (§2.3 redundancy).
- Multiple patterns are listed at the top; the editor below operates on the "Active" one — but "Active" is ambiguous (is it the currently-edited one, or the default-applied service?).
- The "Active" pill on a pattern is misleading — pick clearer terminology (`Selected` for "currently editing" vs `Default` for "applied to new trips").
- Master-detail: lift the pattern list into the rail header (chips at the top), so the body is *only* the editor for the selected pattern. This matches the route master-detail pattern.

### 5.3 Routes (list)

- Whole row clickable opens detail (just fixed).
- Stop/trip counts inline ✓.
- Color swatch toggles visibility ✓ — but the swatch's secondary purpose isn't discoverable; needs a tooltip.
- Future affordance: drag-handle to reorder routes (export order for `routes.txt`).

### 5.4 Routes (detail)

- Tabs work but the **Trips** count badge double-counts (each shape's trip count is summed in the tab counter).
- Tabs should reflect the route's *concept* count, not implementation: `Stops 9` = unique stop count; `Trips 67` = trip count; `Frequencies 0` (or hidden when 0).
- Header missing Duplicate/Delete (§4.5).
- Form sub-section headings need promotion (§2.2).
- "Cost Estimation" is an accordion in a different visual style — convert to a regular sub-section with `+ Add` pill that toggles inline editing, matching the design source's `.rr-section`.
- "Direction for new shape" toggle ordering: it currently sits below "Route Shapes (0)"; the toggle is *for the next shape*, but its label sounds like a property of the shape list. Rename to `Direction for next shape` and visually associate with the `Draw Route Shape` CTA below it (group them in a card).

### 5.5 Stops

- The "FOR ROUTE" dropdown shows raw `route_id` (`route-mozwf61k-3`). Show `route_short_name || route_long_name` and indent with the swatch.
- The whole panel is route-scoped only. There's no global stops list — fine for the design philosophy ("stops in the context of a route") but missing affordances:
  - Multi-route stops: indicator on the route filter that this stop is shared.
  - Off-route / orphan stops: surface them with a banner ("3 stops not assigned to any route").
- After Place Stops on Map mode is active, the right rail still shows the form. The map cursor is captured. There's no big visible "Done placing" exit button — exiting requires re-clicking the toggle. Add an exit affordance in the toolbar overlay on the map.

### 5.6 Fares

- Yellow warning is clear ✓.
- "Demand Responsive Fares" sub-section is *informational only* — it's a paragraph telling the user to set up flex zones first. This is dead weight in a config panel.
  - Move the explainer to a dismissible note in the Flex Zones section.
  - Remove the standalone DR-Fares sub-section here; once flex zones exist, surface their fares as another card under `Fixed Route Fares` titled `Flex Zone Fares`, with the same card style.

### 5.7 Flex Zones

- "GTFS-Flex" sub-heading + 2-line description duplicates the section title (§2.3). Strip it.
- Footer line "Exported as `locations.geojson` + `booking_rules.txt` per the GTFS-Flex spec." — fine but could be a tooltip on a small `?` icon next to the title.
- Once zones exist, the editor is master-detail (zone list + selected zone editor). Apply the same master-detail pattern as Routes (entity-header with name + actions when one zone is selected).

### 5.8 Costs

- Sub-heading "Cost Summary" is redundant — strip (§2.3).
- "Assumptions / System Totals / Per-route Breakdown" sub-headings need promotion (§2.2).
- Per-route table at the bottom should match the Route list visual style (cards with swatch + name + counts), so users feel the connection: *this is the same data as the Routes list, scoped to costs*.

### 5.9 Coverage

- Empty state ✓.
- Once stops exist: tabs (overall / per-route), summary card, per-block-group toggle. Audit for §2.2 (heading) consistency.
- The map overlay (block-group fill) needs a legend in the rail when the section is open — currently the colour scale is on the map only.

### 5.10 Title VI

- Empty state ✓.
- Once data exists: minority/non-minority comparison + ratio. Same audit as Coverage.
- Methodology link: today probably surfaced inline as text — should be a `?` info button linking to `docs/Title VI Transit Service Analysis - Calculation Procedures Memo.md`.

---

## 6. Prioritized corrective steps

In order of impact ÷ effort. Each step is sized roughly: S = ≤ 1 h, M = ½ day, L = 1 day.

### P0 — visual hierarchy fixes that touch every panel

1. **§2.1 — Drop section-landing breadcrumbs.** (S) Refactor `RightRail.GenericHeader` to show only `[GROUP eyebrow] / H2 title / X`. Remove the `›` separator from the section landings; keep it only in entity headers.
2. **§2.2 — Three-tier text hierarchy.** (M) Add a `<RailSubHeading>` component (H3, font-heading, dark-brown). Audit each panel; replace inline `<h3>`s and uppercase eyebrow sub-headings with it.
3. **§2.3 — Strip duplicate sub-headings.** (S) Costs ("Cost Summary"), Flex Zones ("GTFS-Flex"), Calendars ("Service Patterns") — remove or relocate.
4. **§2.4 — Padding audit.** (S) Walk every panel's outermost element; remove leftover `p-3` / `px-3` / `pt-N`. The rail's `p-5` is the source of truth.

### P1 — interaction model fixes for the rail itself

5. **§4.2 + §2.9 — Persist `sidebarSection` on close; always render the reopen strip.** (M) Replace the "set section null on X" with "set rightRailOpen=false". Render the 36 px reopen strip whenever the rail is closed *and* a section is selected.
6. **§4.4 — `Cmd+/` keyboard shortcut to toggle rail.** (S)
7. **§3.1 — Move rail-width control to the topbar.** (M) Three-segment control (`min`/`mid`/`max`); recover the 36 px from the rail bottom.
8. **§4.1 — Improve shape-edit collapse strip.** (S) Replace rotated text with a chevron-with-tooltip + a persistent map-side banner.

### P2 — entity-header parity across panels

9. **§2.7 — Section-vs-entity header pattern.** (L) Generalize the route-detail-header pattern into `<RailEntityHeader>`. Adopt for: Calendars (per-pattern), Flex Zones (per-zone), Fares (per-fare), eventually Stops (per-stop).
10. **§4.5 — Duplicate / Delete in route-detail header.** (M) Hoist delete-confirm dialog to a shared modal; wire Duplicate.
11. **§2.10 — Tab → map context propagation.** (M) Each route-detail tab calls `mapFocus(...)` on mount.

### P3 — content polish per panel

12. **§5.5 — Stops "FOR ROUTE" shows readable name + swatch.** (S)
13. **§5.4 — Route-detail Trips count fix + heading promotion.** (S)
14. **§5.6 — Drop standalone "Demand Responsive Fares" subsection; restructure Fares.** (M)
15. **§5.2 — Calendars master-detail.** (M) Lift pattern list into header chips.
16. **§2.5 — CTA style audit + standardize `<RailPrimaryCTA>` / `<RailDashedCTA>`.** (S)
17. **§2.8 — Migrate all empty states to `<EmptyState>`.** (S)
18. **§2.6 — `field-row-2` layout where parallel-short.** (S)

### P4 — polish + future affordances

19. **§3.2 — Scroll-edge fade on rail.** (S)
20. **§3.3 — Hide group eyebrows in mid mode.** (S)
21. **§3.4 — Min-mode color-tile-when-populated.** (S)
22. **§4.3 — Resize handle on rail.** (M, optional)
23. **§5.3 — Drag-reorder routes.** (M, requires `route_sort_order` plumbing)

---

## 7. Sequencing recommendation

Land **P0 + P1** as a single PR titled "Rail polish: visual hierarchy + close/reopen model". That's where most of the "rough" feeling lives, and the fixes are largely visual / non-behavioral so they're low-risk.

Land **P2** as a second PR: it changes architecture (RailEntityHeader as a shared component), so it benefits from being a focused change.

P3 and P4 can each be split per-panel into smaller PRs as the eye for inconsistencies surfaces them.

---

## 8. Out of scope / explicitly deferred

- **Mobile / phone layout.** The two-rail design assumes desktop / tablet. Phone-narrow viewport handling is a separate effort (likely "rail collapses to a bottom-sheet pattern" rather than this 40 px rail).
- **Validation surfacing in the rail.** Whether/how to show "this section has 3 errors" badges in the left rail is a separate design problem (and overlaps with the existing Validation tab in the bottom panel).
- **Bottom-panel ↔ rail dialogue.** Cleanly de-duplicating the "Timetable" concept (it appears in the rail's Trips tab AND the bottom panel) needs its own pass, deferred.
- **Embeds / publication panels in the right rail.** Today these live in the bottom panel; whether to relocate is a future question.
