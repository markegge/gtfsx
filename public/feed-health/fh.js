/* =============================================================
   Feed Health Dashboard — vanilla JS conversion of
   FHChrome.jsx + FHMap.jsx + FHBoard.jsx + FHFooter.jsx
   No React, no Babel. D3 + TopoJSON loaded from vendor/.
   ============================================================= */
(function () {
  "use strict";

  // Demo mode: ?demo-agencies=1 makes every state drill-down load _SAMPLE.json
  // (used to preview the agency table UI before real per-state data ships)
  const DEMO_AGENCIES = new URLSearchParams(location.search).has("demo-agencies");

  // Statewide-program demo-booking link (tracked redirect to the founder's calendar).
  const CONSULT_URL = "/book-demo?src=feed_health";

  // ---- Colour scale (matches FHMap.jsx) ----
  const GAP_STOPS = ["#FBE4D8", "#F4B393", "#E8734A", "#C9491F"];

  function gapColor(noFeed) {
    const t = Math.max(0, Math.min(1, (noFeed - 18) / (75 - 18)));
    // Manual piecewise lerp over 4 stops (matches d3.interpolateRgbBasis behaviour)
    const n = GAP_STOPS.length - 1;
    const i = Math.min(Math.floor(t * n), n - 1);
    const f = t * n - i;
    return lerpHex(GAP_STOPS[i], GAP_STOPS[i + 1], f);
  }

  function hexToRgb(h) {
    const v = parseInt(h.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  function lerpHex(a, b, t) {
    const [ar, ag, ab] = hexToRgb(a);
    const [br, bg, bb] = hexToRgb(b);
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bv = Math.round(ab + (bb - ab) * t);
    return `rgb(${r},${g},${bv})`;
  }

  // ---- Coverage tone (matches FHBoard.jsx) ----
  function covTone(cov) {
    if (cov >= 65) return { cls: "p-good", txt: "Strong", bg: "var(--gtfs-teal)" };
    if (cov >= 45) return { cls: "p-mid",  txt: "Partial", bg: "var(--gtfs-gold)" };
    return             { cls: "p-bad",  txt: "Sparse",  bg: "var(--gtfs-coral)" };
  }

  // ---- h() minimal DOM helper ----
  function h(tag, attrs, ...children) {
    const el = tag === "svg"
      ? document.createElementNS("http://www.w3.org/2000/svg", "svg")
      : document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "className") el.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v !== null && v !== undefined) el.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      el.append(typeof c === "string" || typeof c === "number" ? String(c) : c);
    }
    return el;
  }

  // ---- Integer to word (2–9); numeral fallback ----
  function numToWord(n) {
    const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    return (n >= 2 && n <= 9) ? words[n] : String(n);
  }

  // ---- Animate bar fills after paint ----
  function animateFills() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.querySelectorAll("[data-fill-width]").forEach((el) => {
          el.style.width = el.dataset.fillWidth;
        });
      });
    });
  }

  // ---- Subtle pencil "edit" icon → GTFS·X editor (state view only) ----
  // Muted by default, darkens on hover. Deep-links the agency's own feed into
  // the editor via the /import?url= route (DeepLinkImportPage fetches the zip
  // and loads it). Only rendered for feed-present agencies that have a feedUrl.
  function editPencil(agencyName, feedUrl) {
    // NOTE: use the `class` attribute (not `className`) — on SVG elements
    // `el.className` is a read-only SVGAnimatedString and assigning to it throws.
    const svg = h("svg", {
      "class": "ag-edit-ico", viewBox: "0 0 24 24", width: "13", height: "13",
      fill: "none", stroke: "currentColor", "stroke-width": "2",
      "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
    });
    svg.innerHTML = '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>';
    return h("a", {
      className: "ag-edit-link",
      href: "/import?url=" + encodeURIComponent(feedUrl),
      title: "Open this feed in the GTFS·X editor",
      "aria-label": "Open " + agencyName + "’s feed in GTFS·X",
    }, svg);
  }

  // ===========================================================
  // TOP BAR
  // ===========================================================
  function renderTopBar() {
    return h("header", { className: "fh-topbar" },
      h("div", { className: "wrap" },
        h("a", { className: "brand-mark", href: "/" },
          h("img", { src: "/gtfsx-mark.svg", width: "28", height: "28", alt: "" }),
          "GTFS·X"
        ),
        h("span", { className: "brand-crumb" }, "Feed Health Dashboard"),
        h("nav", { className: "top-nav" },
          h("a", { href: "#map" }, "Coverage Map"),
          h("a", { href: "#leaderboard" }, "Leaderboard"),
          h("a", { href: "#flex" }, "GTFS-Flex"),
          h("a", { href: "#methodology" }, "Methodology")
        )
      )
    );
  }

  // ===========================================================
  // HERO
  // ===========================================================
  function renderHero() {
    const { HEADLINE, GRADIENT } = window.FH_DATA;

    const miniRows = GRADIENT.map((g) =>
      h("div", { className: "minigrad-row" },
        h("div", { className: "top" },
          h("span", { className: "nm" }, g.label),
          h("span", { className: "pc" }, g.noFeedPct + "%")
        ),
        h("div", { className: "track" },
          h("div", { className: "fill", "data-fill-width": g.noFeedPct + "%", style: { width: "0%" } })
        )
      )
    );

    // Compute rural-vs-full ratio for minigrad footnote (e.g. 66/11 = 6 → "six times")
    const fullGrad  = GRADIENT.find((g) => g.key === "full");
    const ruralGrad = GRADIENT.find((g) => g.key === "rural");
    const ruralRatio = numToWord(Math.round(ruralGrad.noFeedPct / fullGrad.noFeedPct));

    return h("section", { className: "hero", id: "top" },
      h("div", { className: "wrap" },
        h("span", { className: "eyebrow" }, "State of US Transit Data · 2026"),
        h("div", { className: "hero-grid" },
          h("div", null,
            h("h1", null,
              h("span", { className: "big" }, "45%"),
              "of US federally funded transit agencies have no GTFS feed any trip planner can find."
            ),
            h("p", { className: "lede" },
              "We joined the FY2024 NTD roster of " + HEADLINE.agencies.toLocaleString() + " agencies against the FTA GTFS Weblinks crosswalk and the Mobility Database, then read validation status from the canonical validator. This is what we found."
            ),
            // Item 2: "As of <draftDate>" chip — date comes from HEADLINE.draftDate (runtime)
            h("div", { className: "hero-meta" },
              h("span", { className: "chip" }, "As of " + HEADLINE.draftDate),
              h("span", { className: "chip" }, HEADLINE.agencies.toLocaleString() + " agencies analyzed")
            ),
            h("div", { className: "hero-actions" },
              h("a", { className: "btn-primary", href: "#map" }, "Explore the map →"),
              h("a", { className: "btn-secondary", href: "#methodology" }, "Read the methodology")
            )
          ),
          h("div", { className: "hero-side" },
            h("h3", null, "The gap widens as agencies get smaller"),
            h("div", { className: "minigrad" }, ...miniRows),
            h("p", { className: "minigrad-foot" },
              "Share of agencies with no findable feed, by NTD reporting class. The planner-relevant cut: rural 5311 service is " + ruralRatio + " times more likely to be invisible than a full reporter."
            )
          )
        )
      )
    );
  }

  // ===========================================================
  // STAT BAND
  // ===========================================================
  function renderStatBand() {
    const { HEADLINE } = window.FH_DATA;
    // Item 5: compute demand-response context for card 4 (drAgencies is real FY2024 NTD data)
    const drPct = (HEADLINE.flexFeeds / HEADLINE.drAgencies * 100).toFixed(1);
    // Stat values come from HEADLINE (regenerated by scripts/feed-health-publish.py)
    // so the cards track each monthly data refresh instead of drifting (the old
    // hardcoded 21 / 12.8 had already fallen out of sync with fh-data.js).
    const cards = [
      { c: "coral",  num: String(HEADLINE.noFeedPct), u: "%", lab: "of agencies have no findable GTFS feed",
        sub: HEADLINE.agencies.toLocaleString() + " agencies in the FY2024 NTD roster" },
      { c: "gold",   num: String(HEADLINE.expiredPct), u: "%", lab: "of catalogued feeds describe service that has already ended",
        sub: "Expired calendar dates in published feeds" },
      { c: "purple", num: String(HEADLINE.validatorFailPct), u: "%", lab: "of feeds fail the canonical validator",
        sub: "Read from MDB canonical-validator reports" },
      // Item 5: reframed against demand-response denominator; no sub-line per polish pass
      { c: "teal",   num: String(HEADLINE.flexFeeds), u: "",
        lab: "feeds publish GTFS‑Flex: just " + drPct + "% of the " + HEADLINE.drAgencies.toLocaleString() + " agencies offering demand-response service" },
    ];
    return h("section", { className: "statband" },
      h("div", { className: "wrap" },
        h("div", { className: "stat-grid" },
          ...cards.map((c) =>
            h("div", { className: "stat-card c-" + c.c },
              h("div", { className: "num" }, c.num, h("span", { className: "u" }, c.u)),
              h("div", { className: "lab" }, c.lab),
              c.sub ? h("div", { className: "sub" }, c.sub) : null
            )
          )
        )
      )
    );
  }

  // ===========================================================
  // MAP SECTION
  // ===========================================================
  function renderMapSection() {
    const { STATES, HEADLINE } = window.FH_DATA;
    const byFips = {};
    STATES.forEach((s) => { byFips[s.fips] = s; });

    // Leaders: top 3 states by feed coverage (cov desc)
    const leaders = [...STATES].sort((a, b) => b.cov - a.cov).slice(0, 3);
    // Laggers: top 3 states by no-feed share (noFeed desc)
    const laggers = [...STATES].sort((a, b) => b.noFeed - a.noFeed).slice(0, 3);

    // Tooltip (fixed overlay, appended to body)
    const tooltip = h("div", { className: "map-tooltip", style: { display: "none" } });
    document.body.appendChild(tooltip);
    // Hide tooltip on scroll — prevents stale artifact when the user scrolls away from the map
    window.addEventListener("scroll", function () { tooltip.style.display = "none"; }, { passive: true });

    const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgEl.setAttribute("role", "img");
    svgEl.setAttribute("aria-label", "US choropleth of GTFS feed coverage gaps by state");
    // Hide tooltip when the cursor exits the SVG — catches fast movement across state gaps
    svgEl.addEventListener("mouseleave", function () { tooltip.style.display = "none"; });

    const failMsg = h("div", { style: { padding: "60px 24px", textAlign: "center", fontFamily: "var(--font-body)", color: "var(--gtfs-warm-gray)", display: "none" } },
      "Map tiles could not load. The leaderboard below carries the same per-state data."
    );

    const mapCard = h("div", { className: "map-card" }, failMsg, svgEl);

    const legendBar = h("div", { className: "legend-bar",
      style: { background: "linear-gradient(90deg," + GAP_STOPS.join(",") + ")" } });

    const gapStopsLegend = ["~18%", "45%", "75%+"];

    // Leaders & laggers card
    const leaderRows = leaders.map((s) =>
      h("div", { className: "hero-gap-row" },
        h("span", { className: "lb-abbr", style: { background: "var(--gtfs-teal)" } }, s.abbr),
        h("span", { className: "hero-gap-name" }, s.name),
        h("span", { className: "hero-gap-pct leadlag-teal-pct" }, s.cov + "%")
      )
    );
    const laggerRows = laggers.map((s) =>
      h("div", { className: "hero-gap-row" },
        h("span", { className: "lb-abbr", style: { background: "var(--gtfs-coral)" } }, s.abbr),
        h("span", { className: "hero-gap-name" }, s.name),
        h("span", { className: "hero-gap-pct" }, s.noFeed + "%")
      )
    );
    const darkCard = h("div", { className: "map-stat" },
      h("div", { className: "dark-card-title" }, "Leaders & laggers"),
      h("div", { className: "leadlag-group" },
        h("span", { className: "leadlag-label" }, "Best covered"),
        h("div", { className: "dark-rows" }, ...leaderRows)
      ),
      h("div", { className: "leadlag-divider" }),
      h("div", { className: "leadlag-group" },
        h("span", { className: "leadlag-label leadlag-label-coral" }, "Widest gaps"),
        h("div", { className: "dark-rows" }, ...laggerRows)
      )
    );

    const section = h("section", { className: "section", id: "map" },
      h("div", { className: "wrap" },
        h("div", { className: "section-head" },
          h("span", { className: "eyebrow" }, "Coverage Map"),
          h("h2", null, "Where US transit data goes dark"),
          h("p", null,
            "Each state is shaded by the share of its NTD-listed agencies with no GTFS feed any trip planner can find. The deepest coral marks the largest gaps, concentrated in the rural Mountain West and Deep South. Hover any state for its feed health."
          )
        ),
        h("div", { className: "map-layout" },
          mapCard,
          h("div", { className: "map-side" },
            h("div", { className: "legend-card" },
              h("h4", null, "Agencies with no findable feed"),
              legendBar,
              h("div", { className: "legend-scale" },
                ...gapStopsLegend.map((l) => h("span", null, l))
              ),
              h("div", { className: "legend-na" },
                h("span", { className: "sw" }),
                "No transit agencies / not analyzed"
              ),
              h("p", { className: "legend-note" },
                "The scale is the inverse of feed coverage: deeper color, bigger publishing gap."
              )
            ),
            darkCard
          )
        )
      )
    );

    // Async map init with D3 + TopoJSON
    fetch("vendor/states-10m.json")
      .then((r) => r.json())
      .then((us) => {
        const width = 960, height = 600;
        const states = topojson.feature(us, us.objects.states);
        const projection = d3.geoAlbersUsa().fitSize([width, height], states);
        const path = d3.geoPath(projection);

        const svg = d3.select(svgEl).attr("viewBox", "0 0 " + width + " " + height);

        svg.append("g")
          .selectAll("path")
          .data(states.features)
          .join("path")
          .attr("class", "map-state")
          .attr("d", path)
          .attr("fill", (d) => {
            const s = byFips[String(d.id).padStart(2, "0")];
            return s ? gapColor(s.noFeed) : "var(--gtfs-sand)";
          })
          .on("mousemove", function (event, d) {
            const s = byFips[String(d.id).padStart(2, "0")];
            if (!s) return;
            d3.select(this).raise().attr("stroke-width", 1.6);
            // Item 7: Transit Agencies row first, then no-feed %
            let inner = `<div class="t-name">${s.name}</div>
              <div class="t-row"><span class="k">Transit Agencies</span><span class="v">${s.agencies}</span></div>
              <div class="t-row"><span class="k">No findable feed</span><span class="v t-big">${s.noFeed}%</span></div>
              <div class="t-row"><span class="k">Feeds expired</span><span class="v">${s.exp}%</span></div>
              <div class="t-row"><span class="k">Validator fails</span><span class="v">${s.val}%</span></div>`;
            if (s.flex > 0) {
              inner += `<div class="t-row"><span class="k">GTFS-Flex feeds</span><span class="v">${s.flex}</span></div>`;
            }
            tooltip.innerHTML = inner;
            tooltip.style.display = "block";
            tooltip.style.left = event.clientX + "px";
            tooltip.style.top  = event.clientY + "px";
          })
          .on("mouseleave", function () {
            d3.select(this).attr("stroke-width", 0.6);
            tooltip.style.display = "none";
          });
      })
      .catch(() => {
        failMsg.style.display = "block";
      });

    return section;
  }

  // ===========================================================
  // AGENCY TABLE (drill-down, lazy-loaded per state)
  // ===========================================================
  function renderAgencyTable(data, opts) {
    const { CTAS } = window.FH_DATA;
    // State view (Campaign B) drops the pushy "Action" column and instead shows
    // a subtle pencil next to the status badge for agencies that already have a
    // feed. The national drill-down keeps its Action column (stateMode = false).
    const stateMode = !!(opts && opts.stateMode);
    let agSortKey = "name";
    let agSortDir = "asc";

    const STATUS_ORDER = { ok: 0, expired: 1, invalid: 2, none: 3 };

    function statusMeta(status) {
      switch (status) {
        case "ok":      return { cls: "p-good", label: "Current" };
        case "expired": return { cls: "p-mid",  label: "Expired" };
        case "invalid": return { cls: "p-mid",  label: "Fails validator" };
        default:        return { cls: "p-bad",  label: "No feed" };
      }
    }

    function ctaMeta(status) {
      const keyMap = { ok: "edit", expired: "fix", invalid: "fix", none: "build" };
      const key = keyMap[status] || "build";
      const cta = CTAS.find(function (c) { return c.key === key; }) || CTAS[2];
      const toneClass = ({ teal: "ap-teal", gold: "ap-gold", coral: "ap-coral" })[cta.tone] || "ap-coral";
      const label = ({ edit: "Edit in GTFS·X", fix: "Fix in GTFS·X", build: "Build in GTFS·X" })[key];
      return { key, toneClass, label };
    }

    function reporterLabel(type) {
      return ({ full: "Full", reduced: "Reduced", rural: "Rural" })[type] || type;
    }

    // Verbose NTD organization_type strings → compact, readable labels for the
    // muted summary sub-line (kept short so the cell stays tidy at ~390px).
    const ORG_TYPE_SHORT = {
      "City, County or Local Government Unit or Department of Transportation": "Local government",
      "Independent Public Agency or Authority of Transit Service": "Public transit authority",
      "Private-Non-Profit Corporation": "Nonprofit",
      "Tribe": "Tribal nation",
      "MPO, COG or Other Planning Agency": "Planning agency (MPO/COG)",
      "Area Agency on Aging": "Area Agency on Aging",
      "State Government Unit or Department of Transportation": "State DOT / government",
      "University": "University",
      "Private-For-Profit Corporation": "Private (for-profit)",
      "Other Publicly-Owned or Privately Chartered Corporation": "Chartered corporation",
      "Subsidiary Unit of a Transit Agency, Reporting Separately": "Transit subsidiary",
      "Private Provider Reporting on Behalf of a Public Entity": "Private operator",
    };
    function shortOrgType(t) { return t ? (ORG_TYPE_SHORT[t] || t) : ""; }

    // City · organization-type summary (both ~100% coverage in the data).
    function agencySummary(ag) {
      const parts = [];
      if (ag.city) parts.push(ag.city);
      const ot = shortOrgType(ag.orgType);
      if (ot) parts.push(ot);
      return parts.join(" · ");
    }

    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function prettyDate(iso) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
      if (!m) return null;
      const mi = parseInt(m[2], 10) - 1;
      if (mi < 0 || mi > 11) return null;
      return MONTHS[mi] + " " + parseInt(m[3], 10) + ", " + m[1];
    }
    // Feed end / expiration sub-line; null when we have no service-end date.
    function feedEndLabel(ag) {
      const d = prettyDate(ag.serviceEnd);
      if (!d) return null;
      return (ag.expired ? "Service ended " : "Service ends ") + d;
    }
    // Compact "MMM YYYY" for the last-feed-update column (keeps the cell tidy at
    // ~390px); the full date sits in the cell's title attribute.
    function shortMonthYear(iso) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
      if (!m) return null;
      const mi = parseInt(m[2], 10) - 1;
      if (mi < 0 || mi > 11) return null;
      return MONTHS[mi] + " " + m[1];
    }

    // Fixed-route and demand-response service indicators, each in its OWN column.
    // Classified from the agency's NTD reported service modes (Service-by-Mode
    // table): demand-response = modes DR/DT; fixed-route = any scheduled mode that
    // is not DR/DT or vanpool. An agency can be both. A colored check marks the
    // service; a muted dash means it's not reported (e.g. vanpool-only / no NTD
    // mode record).
    function serviceFlagCell(on, yesClass, yesTitle) {
      if (!on) {
        return h("span", { className: "ag-muted-dash", title: "Not reported in NTD service modes" }, "–");
      }
      return h("span", { className: "svc-yes " + yesClass, title: yesTitle }, "✓");
    }

    // Last-feed-update cell: the date the Mobility Database last captured the
    // matched feed's latest dataset (proxy for "feed last published/updated").
    // Null when the agency has no MDB-matched feed.
    function lastUpdateCell(ag) {
      const short = shortMonthYear(ag.lastFeedUpdate);
      if (!short) return h("span", { className: "ag-muted-dash" }, "–");
      return h("span", {
        className: "ag-update-date",
        title: "Feed last updated in the Mobility Database: " + prettyDate(ag.lastFeedUpdate),
      }, short);
    }

    function getSorted() {
      return data.agencies.slice().sort(function (a, b) {
        if (agSortKey === "name") {
          const r = a.name.localeCompare(b.name);
          return agSortDir === "asc" ? r : -r;
        }
        const av = STATUS_ORDER[a.status] != null ? STATUS_ORDER[a.status] : 99;
        const bv = STATUS_ORDER[b.status] != null ? STATUS_ORDER[b.status] : 99;
        return agSortDir === "asc" ? av - bv : bv - av;
      });
    }

    const agThead = document.createElement("thead");
    const agTbody = document.createElement("tbody");

    function renderAgHead() {
      agThead.innerHTML = "";
      const tr = document.createElement("tr");

      const nameTh = h("th", { className: "tl" });
      nameTh.innerHTML = "Agency" + (agSortKey === "name"
        ? " <span class=\"arw\">" + (agSortDir === "asc" ? "▲" : "▼") + "</span>" : "");
      nameTh.style.cursor = "pointer";
      nameTh.addEventListener("click", function () { setAgSort("name"); });

      // Fixed Route / Demand Response each get their OWN yes/– column, and the
      // last feed-update date sits between them and Feed status so the status badge
      // + trailing pencil/action stay the right-hand pair. Last-update is hidden on
      // small screens (hide-mobile) to keep the table uncrowded at ~390px.
      const frTh = h("th", { className: "tl ag-svc-col", style: { cursor: "default" } }, "Fixed Route");
      const drTh = h("th", { className: "tl ag-svc-col", style: { cursor: "default" } }, "Demand Response");
      const updateTh = h("th", { className: "tl hide-mobile", style: { cursor: "default" } }, "Last update");

      const statusTh = h("th", null);
      statusTh.innerHTML = "Feed status" + (agSortKey === "status"
        ? " <span class=\"arw\">" + (agSortDir === "asc" ? "▲" : "▼") + "</span>" : "");
      statusTh.style.cursor = "pointer";
      statusTh.addEventListener("click", function () { setAgSort("status"); });

      if (stateMode) {
        // Trailing edit-pencil column carries no header text so the Feed status
        // badge above it stays cleanly right-aligned.
        const pencilTh = h("th", { className: "ag-pencil-col", style: { cursor: "default" } });
        pencilTh.setAttribute("aria-label", "Edit");
        tr.append(nameTh, frTh, drTh, updateTh, statusTh, pencilTh);
      } else {
        const actionTh = h("th", { style: { cursor: "default" } }, "Action");
        tr.append(nameTh, frTh, drTh, updateTh, statusTh, actionTh);
      }
      agThead.appendChild(tr);
    }

    function renderAgBody() {
      agTbody.innerHTML = "";
      getSorted().forEach(function (ag) {
        const sm = statusMeta(ag.status);
        const cm = ctaMeta(ag.status);
        const tr = document.createElement("tr");
        tr.style.cursor = "default";

        // ---- Agency cell ----
        const nameCell = h("div", { className: "ag-name-cell" });
        if (stateMode) {
          // Name line + GTFS-Flex badge (only when the matched feed publishes
          // Flex; rare, so it reads as a highlight rather than clutter).
          nameCell.appendChild(
            h("div", { className: "ag-name-line" },
              h("span", { className: "nm" }, ag.name),
              ag.isFlex ? h("span", {
                className: "ag-flex-badge",
                title: "Publishes GTFS-Flex (on-demand / flexible service)",
              }, "Flex") : null
            )
          );
          // City · organization-type summary.
          const summary = agencySummary(ag);
          if (summary) nameCell.appendChild(h("span", { className: "ag-sub" }, summary));
        } else {
          nameCell.appendChild(h("span", { className: "nm" }, ag.name));
          if (ag.city) nameCell.appendChild(h("span", { className: "ag-city" }, ag.city));
        }
        tr.appendChild(h("td", null, nameCell));

        // ---- Service columns: Fixed Route + Demand Response (own yes/– columns) ----
        tr.appendChild(h("td", { className: "ag-svc-col" },
          serviceFlagCell(ag.fixedRoute, "svc-yes-fr", "Operates fixed-route service (NTD reported modes)")));
        tr.appendChild(h("td", { className: "ag-svc-col" },
          serviceFlagCell(ag.demandResponse, "svc-yes-dr", "Operates demand-response service (NTD reported modes)")));

        // ---- Last feed-update cell (hidden on small screens) ----
        tr.appendChild(h("td", { className: "hide-mobile ag-update-cell" }, lastUpdateCell(ag)));

        // ---- Feed status cell: JUST the badge (stays right-aligned) ----
        tr.appendChild(h("td", null,
          h("div", { className: "ag-status-cell" },
            h("span", { className: "lb-pill " + sm.cls }, sm.label)
          )
        ));

        // ---- Trailing cell ----
        if (stateMode) {
          // Edit pencil in its own no-header column, deep-linking the feed into
          // the GTFS·X editor. Only clean "edit" feeds that have a URL get it;
          // fix/build statuses rely on the section + closing CTAs.
          const pencilCell = h("td", { className: "ag-pencil-col" });
          if (cm.key === "edit" && ag.feedUrl) {
            pencilCell.appendChild(editPencil(ag.name, ag.feedUrl));
          }
          tr.appendChild(pencilCell);
        } else {
          tr.appendChild(h("td", null,
            h("a", { className: "action-pill " + cm.toneClass, href: "/" }, cm.label)
          ));
        }
        agTbody.appendChild(tr);
      });
    }

    function setAgSort(key) {
      if (key === agSortKey) {
        agSortDir = agSortDir === "asc" ? "desc" : "asc";
      } else {
        agSortKey = key;
        agSortDir = "asc";
      }
      renderAgHead();
      renderAgBody();
    }

    renderAgHead();
    renderAgBody();

    const agTable = h("table", { className: "lb-table ag-table" }, agThead, agTbody);
    return h("div", { className: "drill-agency-section" },
      h("div", { className: "drill-agency-head" },
        h("h4", null, "Transit Agencies"),
        h("span", { className: "drill-agency-as-of" }, "Data as of " + data.asOf)
      ),
      h("div", { className: "lb-card" }, agTable)
    );
  }

  // ===========================================================
  // LEADERBOARD
  // ===========================================================
  // Item 1: "Transit Agencies" replaces "NTD Agencies"
  const COLS = [
    { key: "name",     label: "State",             align: "tl", num: false },
    { key: "agencies", label: "Transit Agencies",   num: true },
    { key: "cov",      label: "Feed Coverage",      num: true, bar: true },
    { key: "exp",      label: "Expired",            num: true, suffix: "%" },
    { key: "val",      label: "Validator Fail",     num: true, suffix: "%" },
    { key: "flex",     label: "Flex",               num: true },
  ];

  const FILTERS = [
    { key: "all",  label: "All states" },
    { key: "gaps", label: "Biggest gaps" },
    { key: "best", label: "Best covered" },
    { key: "flex", label: "Publishes Flex" },
  ];

  function renderLeaderboard() {
    const { STATES, HEADLINE } = window.FH_DATA;

    // Item 9: distinct initial sort per chip
    let sortKey = "name";
    let sortDir = "asc";
    let filter  = "all";
    let query   = "";

    function getRows() {
      let r = STATES.slice();
      if (filter === "flex") r = r.filter((s) => s.flex > 0);
      const q = query.trim().toLowerCase();
      if (q) r = r.filter((s) => s.name.toLowerCase().includes(q) || s.abbr.toLowerCase().includes(q));
      r.sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        if (sortKey === "name") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        return sortDir === "asc" ? av - bv : bv - av;
      });
      return r;
    }

    function setSort(key) {
      if (key === sortKey) { sortDir = sortDir === "asc" ? "desc" : "asc"; }
      else { sortKey = key; sortDir = key === "name" ? "asc" : "desc"; }
      renderHead();
      renderBody();
    }

    // Item 9: each chip applies a distinct default sort
    function applyFilter(key) {
      filter = key;
      if      (key === "all")  { sortKey = "name";   sortDir = "asc"; }
      else if (key === "gaps") { sortKey = "noFeed";  sortDir = "desc"; }
      else if (key === "best") { sortKey = "cov";    sortDir = "desc"; }
      else if (key === "flex") { sortKey = "flex";   sortDir = "desc"; }
      update();
    }

    // Build DOM skeleton
    const chips = h("div", { className: "chips" },
      ...FILTERS.map((f) => {
        const btn = h("button", { className: "chip-btn" + (f.key === filter ? " active" : "") }, f.label);
        btn.dataset.filterKey = f.key;
        return btn;
      })
    );

    const searchInput = h("input", { placeholder: "Find a state…", type: "search" });
    const searchWrap = h("div", { className: "lb-search" },
      h("span", { className: "ic" }, "⌕"),
      searchInput
    );
    const toolbar = h("div", { className: "lb-toolbar" }, chips, searchWrap);

    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    const foot  = document.createElement("div");
    foot.className = "lb-foot";

    const table = h("table", { className: "lb-table" }, thead, tbody);
    const card  = h("div", { className: "lb-card" }, table, foot);

    // Item 10: content area that swaps between table view and drill-down
    const contentArea = h("div", { className: "lb-content-area" });

    // ---- Drill-down view ----
    function openDrill(s) {
      history.pushState({ drillState: s.abbr }, "", "#state-" + s.abbr);
      showDrillDown(s);
    }

    function showDrillDown(s) {
      // Hide any stale map tooltip (fixed-position, persists across scroll/section changes)
      document.querySelectorAll(".map-tooltip").forEach(function (el) { el.style.display = "none"; });
      contentArea.innerHTML = "";
      const tone = covTone(s.cov);

      const backBtn = h("button", { className: "drill-back" }, "← All states");
      backBtn.addEventListener("click", () => {
        history.pushState(null, "", location.pathname + location.search + "#leaderboard");
        showTableView();
      });

      const statItems = [
        { label: "Transit Agencies", value: s.agencies },
        { label: "Feed Coverage",    value: s.cov + "%" },
        { label: "Expired Feeds",    value: s.exp + "%" },
        { label: "Validator Fails",  value: s.val + "%" },
        { label: "GTFS-Flex Feeds",  value: s.flex > 0 ? String(s.flex) : "0" },
      ];

      const drillHeader = h("div", { className: "drill-header" },
        backBtn,
        h("div", { className: "drill-title" },
          h("span", { className: "lb-abbr drill-abbr", style: { background: tone.bg } }, s.abbr),
          h("span", { className: "drill-name" }, s.name)
        ),
        h("div", { className: "drill-stats" },
          ...statItems.map((item) =>
            h("div", { className: "drill-stat" },
              h("div", { className: "drill-stat-num" }, item.value),
              h("div", { className: "drill-stat-lab" }, item.label)
            )
          )
        )
      );

      const placeholder = h("div", { className: "drill-placeholder" },
        "Agency-level listings ship with the full dataset: ",
        h("strong", null, String(s.agencies)),
        " transit agencies in ",
        h("strong", null, s.name),
        "."
      );

      contentArea.appendChild(drillHeader);
      contentArea.appendChild(placeholder);

      // Lazy-fetch per-state agency data; silently fall back to placeholder on 404 / network error.
      // With ?demo-agencies=1 every state loads _SAMPLE.json (clearly fake data, for UI preview only).
      const dataUrl = DEMO_AGENCIES
        ? "data/agencies/_SAMPLE.json"
        : "data/agencies/" + s.abbr + ".json";
      fetch(dataUrl)
        .then(function (r) {
          // 404 is expected for every state until real CSVs ship — keep placeholder, no error
          if (!r.ok) return null;
          return r.json();
        })
        .then(function (data) {
          // stateMode:true → subtle edit-pencil action column (matches the toned-down
          // state agency section); without it the map drill-down regressed to the loud
          // "Build/Fix/Edit in GTFS·X" action-pills once per-state data shipped.
          if (data) placeholder.replaceWith(renderAgencyTable(data, { stateMode: true }));
          // else: placeholder already in DOM, nothing to do
        })
        .catch(function () {
          // network / parse errors — placeholder remains, no console spam
        });
    }

    function showTableView() {
      contentArea.innerHTML = "";
      contentArea.appendChild(toolbar);
      contentArea.appendChild(card);
      update();
    }

    // Hash routing (browser back/forward)
    function handleHash() {
      const m = location.hash.match(/^#state-([A-Z]{2})$/);
      if (m) {
        const s = STATES.find((st) => st.abbr === m[1]);
        if (s) { showDrillDown(s); return; }
      }
      showTableView();
    }
    window.addEventListener("hashchange", handleHash);

    function renderHead() {
      thead.innerHTML = "";
      const tr = document.createElement("tr");
      const thRank = h("th", { className: "tl", style: { cursor: "default" } }, "#");
      tr.appendChild(thRank);
      COLS.forEach((c) => {
        const arw = sortKey === c.key
          ? ` <span class="arw">${sortDir === "asc" ? "▲" : "▼"}</span>`
          : "";
        const th = h("th", { className: c.align || "" });
        th.innerHTML = c.label + arw;
        if (c.key !== "name") th.style.cursor = "pointer";
        th.addEventListener("click", () => setSort(c.key));
        tr.appendChild(th);
      });
      tr.appendChild(h("th", { style: { cursor: "default" } }));
      thead.appendChild(tr);
    }

    function renderBody() {
      tbody.innerHTML = "";
      const rows = getRows();
      rows.forEach((s, i) => {
        const tone = covTone(s.cov);
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="lb-rank">${i + 1}</td>
          <td>
            <div class="lb-name">
              <span class="lb-abbr" style="background:${tone.bg}">${s.abbr}</span>
              <span class="nm">${s.name}</span>
            </div>
          </td>
          <td class="lb-num">${s.agencies}</td>
          <td>
            <div class="lb-bar-cell">
              <span class="lb-pill ${tone.cls}">${s.cov}%</span>
              <span class="lb-bar"><span class="f" style="width:${s.cov}%;background:${tone.bg}"></span></span>
            </div>
          </td>
          <td class="lb-num">${s.exp}%</td>
          <td class="lb-num">${s.val}%</td>
          <td class="lb-num">${s.flex || "–"}</td>
          <td><a class="lb-link" href="#state-${s.abbr}">View →</a></td>
        `;
        // Row click opens drill-down (item 10)
        tr.addEventListener("click", (e) => {
          if (e.target.tagName === "A") e.preventDefault();
          openDrill(s);
        });
        tbody.appendChild(tr);
      });
      foot.innerHTML = `Showing ${rows.length} of ${STATES.length} states &amp; DC &middot; data as of ${HEADLINE.draftDate}`;
    }

    function renderChips() {
      chips.querySelectorAll(".chip-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.filterKey === filter);
      });
    }

    function update() {
      renderHead();
      renderBody();
      renderChips();
    }

    chips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip-btn");
      if (btn) applyFilter(btn.dataset.filterKey);
    });
    searchInput.addEventListener("input", () => {
      query = searchInput.value;
      update();
    });

    const section = h("section", { className: "section", id: "leaderboard" },
      h("div", { className: "wrap" },
        h("div", { className: "section-head" },
          h("span", { className: "eyebrow" }, "Leaderboard"),
          h("h2", null, "Feed health, state by state"),
          h("p", null,
            "Sort by any column. Coverage is the share of a state’s transit agencies with a findable feed; expired and validator-fail rates are read against the feeds that do exist. Click any row to explore that state."
          )
        ),
        contentArea
      )
    );

    // Initialize: respect URL hash on load
    handleHash();

    return section;
  }

  // ===========================================================
  // FLEX SECTION
  // ===========================================================
  function renderFlexSection() {
    const { FLEX, HEADLINE } = window.FH_DATA;
    const totalFlex = HEADLINE.flexFeeds; // denominator for bar percentages
    const drPct = (HEADLINE.flexFeeds / HEADLINE.drAgencies * 100).toFixed(1);

    // Colorado's flex count (dynamic, not hardcoded)
    const coEntry = FLEX.find(function (s) { return s.abbr === "CO"; });
    const coFlex = coEntry ? coEntry.flex : 0;

    // Bars as % of US Flex feeds; show "41 feeds · 55%"
    const flexRows = FLEX.slice(0, 10).map((s, i) => {
      const pct = Math.round(s.flex / totalFlex * 100);
      return h("div", { className: "flex-row" },
        h("span", { className: "rk" }, i + 1),
        h("span", { className: "nm" },
          h("span", { className: "ab" }, s.abbr),
          s.name
        ),
        h("span", { className: "tk" },
          h("span", { className: "f", "data-fill-width": pct + "%", style: { width: "0%" } })
        ),
        h("span", { className: "ct" }, s.flex + " · " + pct + "%")
      );
    });

    return h("section", { className: "flex-band", id: "flex" },
      h("div", { className: "wrap section" },
        h("div", { className: "section-head" },
          h("span", { className: "eyebrow" }, "GTFS-Flex"),
          h("h2", null, "Demand-response service is nearly invisible in trip planners"),
          h("p", null,
            "GTFS-Flex is the GTFS extension that lets riders find demand-response service (dial-a-ride, deviated routes, and on-demand microtransit) through mainstream trip planners. Just " + String(totalFlex) + " US feeds publish it today, about " + drPct + "% of the " + HEADLINE.drAgencies.toLocaleString() + " agencies that operate demand-response service. ",
            h("a", { href: "/learn/gtfs-flex/", className: "flex-inline-link" }, "What is GTFS-Flex?")
          )
        ),
        h("div", { className: "flex-grid" },
          h("div", { className: "flex-lead" },
            h("div", { className: "big" },
              String(totalFlex), h("span", { className: "u" }, " US feeds")
            ),
            h("p", { className: "flex-stat-context" },
              "just " + drPct + "% of demand-response operators"
            ),
            h("p", null,
              "A handful of states have run successful statewide adoption initiatives. Colorado's program alone accounts for " + coFlex + " of the " + totalFlex + " US Flex feeds. Minnesota DOT runs a parallel statewide rural Flex effort."
            )
          ),
          h("div", { className: "flex-board" },
            h("span", { className: "eyebrow" }, "Where state initiatives are working"),
            ...flexRows
          )
        )
      )
    );
  }

  // ===========================================================
  // METHODOLOGY
  // ===========================================================
  function renderMethodology() {
    const { HEADLINE } = window.FH_DATA;
    // Derive "Month Year" from HEADLINE.asOf (ISO "YYYY-MM-DD") for "accessed <Month Year>" citations.
    // NTD vintage ("FY2024; published 2025") is hardcoded — it only changes when the pipeline moves to a new report year.
    const _asOfParts   = HEADLINE.asOf.split("-");
    const _monthNames  = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const accessedDate = _monthNames[parseInt(_asOfParts[1], 10) - 1] + " " + _asOfParts[0];

    const citation = "GTFS·X Feed Health Dashboard (2026). State of US Transit GTFS Publishing. Retrieved from gtfsx.com/feed-health.";

    const copyBtn = h("button", { className: "cite-copy" }, "Copy");
    copyBtn.addEventListener("click", () => {
      if (navigator.clipboard) navigator.clipboard.writeText(citation);
      copyBtn.textContent = "Copied";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1800);
    });

    return h("section", { className: "method", id: "methodology" },
      h("div", { className: "wrap section" },
        h("div", { className: "section-head" },
          h("span", { className: "eyebrow" }, "Methodology"),
          h("h2", null, "How this dataset is built"),
          // Item 1 (methodology scope) + item 12 (removed "CSV in, HTML out..." sentence)
          h("p", null, "This analysis covers the 2,238 agencies in the FY2024 NTD roster; transit providers outside the NTD are not included.")
        ),
        h("div", { className: "method-grid" },
          h("div", null,
            h("dl", null,
              h("div", null,
                h("dt", null, "Data sources"),
                // Items 15-16: links + vintage dates
                h("dd", null,
                  h("a", { href: "https://www.transit.dot.gov/ntd/ntd-data", target: "_blank", rel: "noopener" }, "FY2024 NTD Annual Database"),
                  " (FY2024; published 2025), covering 2,238 federally funded US transit agencies, joined against the FTA ",
                  h("a", { href: "https://www.transit.dot.gov/research-innovation/national-transit-map", target: "_blank", rel: "noopener" }, "GTFS Weblinks crosswalk via the National Transit Map"),
                  " (accessed " + accessedDate + ") and the ",
                  h("a", { href: "https://mobilitydatabase.org", target: "_blank", rel: "noopener" }, "Mobility Database"),
                  " (accessed " + accessedDate + "), with validation status read from ",
                  h("a", { href: "https://github.com/MobilityData/gtfs-validator", target: "_blank", rel: "noopener" }, "MobilityData’s canonical GTFS validator"),
                  " reports (accessed " + accessedDate + ")."
                )
              ),
              h("div", null,
                h("dt", null, "Definitions"),
                h("dd", null,
                  "A feed is ",
                  h("em", null, "findable"),
                  " when it appears in the FTA NTD weblinks crosswalk or the MobilityData catalog. Feeds hosted on other sites but never registered in either source are not captured by this analysis. ",
                  h("em", null, "Expired"),
                  " means the feed’s ",
                  h("code", null, "calendar.txt"),
                  " / ",
                  h("code", null, "calendar_dates.txt"),
                  " describe service that has already ended. ",
                  h("em", null, "Validator fail"),
                  " follows the canonical validator’s error severity."
                )
              ),
              h("div", null,
                h("dt", null, "Demand-response denominator"),
                h("dd", null,
                  "Agencies reporting Demand Response (mode DR; the retired DT demand-response-taxi code is absorbed into DR since report year 2019) in the FY2024 NTD Annual Data, via the ",
                  h("a", { href: "https://data.transportation.gov/Public-Transit/2022-2024-NTD-Annual-Data-Service-by-Mode-and-Time/wwdp-t4re", target: "_blank", rel: "noopener" }, "Service (by Mode and Time Period)"),
                  " table (accessed " + accessedDate + "), across full, reduced, and rural reporters: 1,925 of the 2,238 agencies in the FY2024 roster."
                )
              ),
              h("div", null,
                h("dt", null, "Fuzzy-match disclosure"),
                // Item 13: removed "Rendered pages are public."
                h("dd", null,
                  "Agency-to-feed joins use name and locality matching where no canonical ID exists. Matches are reviewed but not infallible; the per-agency CSV stays internal-only."
                )
              ),
              h("div", null,
                h("dt", null, "Why rural states run dark"),
                h("dd", null,
                  "NTD Section 5311 subrecipients, which dominate rural-state rosters, operate demand-responsive services that typically do not publish GTFS. This structural fact, not a data artifact, drives the highest state no-feed shares."
                )
              ),
              h("div", null,
                h("dt", null, "Reading the Full Reporter share"),
                h("dd", null,
                  "Of the Full Reporters with no findable feed, most are vanpool coordination programs or paratransit and human-services operators; these service types do not publish fixed-route schedules. Fixed-route operators with a genuine gap are rare (single digits nationally)."
                )
              ),
              h("div", null,
                h("dt", null, "Stale-catalog note"),
                h("dd", null,
                  "In states with older regional GTFS programs (Georgia is one example), some agencies previously published feeds whose URLs have since died and which are absent from current catalogs. Their share may be modestly overstated."
                )
              ),
              h("div", null,
                h("dt", null, "Refresh cadence"),
                h("dd", null, "Monthly. Last refreshed " + HEADLINE.draftDate + ". Owner: Mark Egge.")
              )
            )
          ),
          h("div", null,
            h("dt", { style: { fontFamily: "var(--font-body)", fontWeight: 600, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--gtfs-coral)", marginBottom: "8px", display: "block" } },
              "How to cite"
            ),
            h("div", { className: "cite-box" },
              h("div", { className: "lbl" },
                h("span", { className: "eyebrow" }, "Suggested citation"),
                copyBtn
              ),
              h("div", { className: "txt" }, citation)
            )
            // Item 14: removed companion article / gtfsfeeds.net sentence
          )
        )
      )
    );
  }

  // ===========================================================
  // CLOSING CTA (addressed to state DOTs)
  // ===========================================================
  function renderClosingCta() {
    const { HEADLINE, GRADIENT, STATES } = window.FH_DATA;

    // Live numbers: rural no-feed share, Colorado's Flex count, national Flex total
    const ruralGrad = GRADIENT.find((g) => g.key === "rural");
    const ruralPct  = ruralGrad ? ruralGrad.noFeedPct : 66;
    const co        = STATES.find((s) => s.abbr === "CO");
    const coFlex    = co ? co.flex : 41;
    const flexTotal = HEADLINE.flexFeeds;

    return h("section", { className: "closing-band", id: "closing" },
      h("div", { className: "wrap" },
        h("div", { className: "closing-head" },
          h("span", { className: "eyebrow closing-eyebrow" }, "A closing word for state DOTs"),
          h("h2", { className: "closing-h2" },
            "State DOTs have a role to play. Sub-recipients already report to them; directing resources toward GTFS publishing closes the gap."
          )
        ),
        h("div", { className: "closing-grid" },
          h("div", { className: "closing-plank" },
            h("div", { className: "closing-plank-stat" }, ruralPct + "%"),
            h("h3", { className: "closing-plank-h3" }, "Close the gap"),
            h("p", { className: "closing-plank-p" },
              ruralPct + "% of rural reporters have no GTFS feed any trip planner can find. Nearly all of them are Section 5311 sub-recipients, and every one already reports to a statewide transit office to receive federal funds. That office is the natural owner of the fix: commit resources and accountability for sub-recipient data, with a clear target of 100% of funded agencies publishing current, validator-clean GTFS."
            ),
            h("div", { className: "closing-links" },
              h("a", { className: "closing-link", href: "#leaderboard" }, "See your state →")
            )
          ),
          h("div", { className: "closing-plank" },
            h("div", { className: "closing-plank-stat" }, coFlex + " of " + flexTotal),
            h("h3", { className: "closing-plank-h3" }, "Champion GTFS-Flex"),
            h("p", { className: "closing-plank-p" },
              "Most sub-recipient service is demand-responsive, so a publishing push that stops at fixed-route GTFS misses the point. GTFS-Flex puts dial-a-ride and deviated-route service in front of trip planners. Colorado is the proof it scales: " + coFlex + " of the nation's " + flexTotal + " Flex feeds come from one state program. Minnesota DOT's statewide rural Flex effort shows a second path."
            ),
            h("div", { className: "closing-links" },
              h("a", { className: "closing-link", href: "/learn/gtfs-flex/" }, "What is GTFS-Flex? →"),
              h("a", { className: "closing-link", href: "https://blog.transitapp.com/mndot-gtfs-flex-bringing-rural-riders-into-the-fold/", target: "_blank", rel: "noopener" }, "MnDOT case study →")
            )
          )
        )
      )
    );
  }

  // ===========================================================
  // SITE FOOTER
  // ===========================================================
  function renderSiteFooter() {
    const { HEADLINE } = window.FH_DATA;
    return h("footer", { className: "site-foot" },
      h("div", { className: "wrap" },
        h("a", { className: "brand-mark", href: "/" },
          h("img", { src: "/gtfsx-mark.svg", width: "26", height: "26", alt: "" }),
          "GTFS·X"
        ),
        h("span", { style: { fontSize: "13px", color: "rgba(255,248,240,0.7)" } },
          "The free online GTFS feed editor"
        ),
        h("nav", { className: "fnav" },
          h("a", { href: "#map" }, "Coverage Map"),
          h("a", { href: "#leaderboard" }, "Leaderboard"),
          h("a", { href: "#flex" }, "GTFS-Flex"),
          h("a", { href: "#methodology" }, "Methodology")
        ),
        h("div", { className: "copy" },
          "Feed Health Dashboard · data refreshed " + HEADLINE.draftDate + ". Headline findings from the FY2024 NTD roster, FTA GTFS Weblinks, and the Mobility Database."
        )
      )
    );
  }

  // ===========================================================
  // STATE-SCOPED VIEW (?state=XX direct entry — Campaign B)
  // ===========================================================
  // A clean, shareable, policymaker-framed page for a single state DOT:
  // state hero + that state's agency table + condensed methodology + footer.
  // The national hero / US choropleth / leaderboard are not rendered in this mode.
  // The in-page #state-XX drill-down on the national page is untouched.

  // Sanitize the optional ?for= value before it is shown in the hero eyebrow.
  // URLSearchParams already percent-decodes; we strip tag delimiters + control
  // chars and cap the length. (Values are also added as DOM text nodes via h(),
  // which is injection-safe on its own — this is belt-and-suspenders.)
  function sanitizeForLabel(raw) {
    if (!raw) return "";
    return String(raw)
      .replace(/[<>]/g, "")
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .trim()
      .slice(0, 80);
  }

  // Coverage computed from the state's agency JSON (not the national STATES table,
  // whose "cov" column is the looser findable share). Headline coverage = status "ok".
  function computeStateCoverage(data) {
    const ags = (data && data.agencies) || [];
    const total = ags.length;
    const TYPES = ["full", "reduced", "rural"];
    const byType = {};
    TYPES.forEach(function (t) { byType[t] = { total: 0, ok: 0 }; });
    let ok = 0, none = 0;
    ags.forEach(function (a) {
      if (a.status === "ok") ok++;
      if (a.status === "none") none++;
      const t = byType[a.reporterType];
      if (t) { t.total++; if (a.status === "ok") t.ok++; }
    });
    const pct = function (n, d) { return d > 0 ? Math.round(n / d * 100) : 0; };
    const labels = { full: "Full reporters", reduced: "Reduced reporters", rural: "Rural (5311)" };
    return {
      total: total,
      coveragePct: pct(ok, total),   // share with a current, findable feed (status "ok")
      noFeedPct: pct(none, total),   // inverse "no findable feed" share (status "none")
      byType: TYPES
        .map(function (t) {
          return {
            label: labels[t],
            total: byType[t].total,
            // Coverage gap = share without a current, findable feed (path to 100%).
            gapPct: byType[t].total > 0
              ? Math.round((byType[t].total - byType[t].ok) / byType[t].total * 100)
              : 0,
          };
        })
        .filter(function (r) { return r.total > 0; }),
    };
  }

  function renderStateTopBar(stateName, nationalHref) {
    return h("header", { className: "fh-topbar" },
      h("div", { className: "wrap" },
        h("a", { className: "brand-mark", href: "/" },
          h("img", { src: "/gtfsx-mark.svg", width: "28", height: "28", alt: "" }),
          "GTFS·X"
        ),
        h("span", { className: "brand-crumb" }, "Feed Health · " + stateName),
        h("nav", { className: "top-nav" },
          h("a", { href: nationalHref }, "← National view")
        )
      )
    );
  }

  function renderStateHero(stateMeta, data, cov, forValue) {
    const name = stateMeta.name;

    // Reporter-type breakdown reuses the national hero's minigrad styling.
    const miniRows = cov.byType.map(function (r) {
      return h("div", { className: "minigrad-row" },
        h("div", { className: "top" },
          h("span", { className: "nm" }, r.label),
          h("span", { className: "pc" }, r.gapPct + "%")
        ),
        h("div", { className: "track" },
          h("div", { className: "fill", "data-fill-width": r.gapPct + "%", style: { width: "0%" } })
        )
      );
    });

    return h("section", { className: "hero", id: "top" },
      h("div", { className: "wrap" },
        forValue
          ? h("span", { className: "eyebrow", style: { color: "var(--gtfs-coral)", display: "block", marginBottom: "10px" } },
              "Prepared for " + forValue)
          : null,
        h("span", { className: "eyebrow" }, "State of US Transit Data · " + name),
        h("div", { className: "hero-grid" },
          h("div", null,
            h("h1", null,
              h("span", { className: "big" }, cov.coveragePct + "%"),
              "of " + name + "’s transit agencies publish a GTFS feed riders can find."
            ),
            h("p", { className: "lede" },
              "Here’s the path from " + cov.coveragePct + "% to 100% — and why it matters for the services your agencies are working to fund."
            ),
            h("div", { className: "hero-meta" },
              h("span", { className: "chip" }, "Data as of " + data.asOf),
              h("span", { className: "chip" }, cov.total + " NTD-listed agencies")
            ),
            h("div", { className: "hero-actions" },
              h("a", { className: "btn-primary", href: CONSULT_URL, target: "_blank", rel: "noopener" },
                "Talk to us about a statewide program →"),
              h("a", { className: "btn-secondary", href: "#agencies" }, "See every agency ↓")
            )
          ),
          h("div", { className: "hero-side" },
            h("h3", null, "Where the coverage gap is, by reporter type"),
            h("div", { className: "minigrad" }, ...miniRows),
            h("p", { className: "minigrad-foot" },
              "Share of " + name + "’s NTD-listed agencies without a current, findable feed, by reporting class. Rural Section 5311 service is typically the biggest opportunity, and the hardest for riders to find today."
            )
          )
        )
      )
    );
  }

  function renderStateAgencySection(stateMeta, data) {
    return h("section", { className: "section", id: "agencies" },
      h("div", { className: "wrap" },
        h("div", { className: "section-head" },
          h("span", { className: "eyebrow" }, "Agency detail"),
          h("h2", null, "Every NTD-listed transit agency in " + stateMeta.name),
          h("p", null,
            "Each agency’s current feed status, with a direct path to publish or repair its GTFS in the free GTFS·X editor. This is an opportunity list, not a scorecard: most agencies without a findable feed are rural and demand-response operators that have never had a reason to publish one."
          )
        ),
        renderAgencyTable(data, { stateMode: true })
      )
    );
  }

  // State-scoped GTFS-Flex section. Driven off the per-state flex feed count
  // (stateMeta.flex). The common case (0 flex feeds) gets a clean "none yet"
  // message + why it matters + a link to the learning page; states with feeds
  // get a short positive summary. Styled to match the national flex band.
  function renderStateFlexSection(stateMeta) {
    const name = stateMeta.name;
    const flexCount = stateMeta.flex || 0;
    const learnLink = h("a",
      { href: "/learn/gtfs-flex/", className: "flex-inline-link" },
      "What is GTFS-Flex?"
    );

    let headline, body;
    if (flexCount > 0) {
      const verb = flexCount === 1 ? "feed publishes" : "feeds publish";
      headline = name + " agencies are publishing GTFS-Flex";
      body = h("p", { className: "state-flex-body" },
        flexCount + " " + name + " " + verb + " GTFS-Flex, which makes their " +
        "demand-response service findable in mainstream trip planners. ",
        learnLink
      );
    } else {
      headline = "Demand-response service is invisible without GTFS-Flex";
      body = h("p", { className: "state-flex-body" },
        "No " + name + " agencies currently report GTFS-Flex. Demand-response " +
        "service (dial-a-ride, route deviation, on-demand microtransit) stays " +
        "invisible in mainstream trip planners until an agency publishes it as " +
        "GTFS-Flex. ",
        learnLink
      );
    }

    return h("section", { className: "flex-band state-flex", id: "flex" },
      h("div", { className: "wrap section" },
        h("div", { className: "section-head" },
          h("span", { className: "eyebrow" }, "GTFS-Flex"),
          h("h2", null, headline),
          body
        )
      )
    );
  }

  function renderStateMethodology(stateMeta, nationalHref) {
    const { HEADLINE } = window.FH_DATA;
    return h("section", { className: "method", id: "methodology" },
      h("div", { className: "wrap section" },
        h("div", { className: "section-head" },
          h("span", { className: "eyebrow" }, "Methodology"),
          h("h2", null, "How this is measured"),
          h("p", null,
            "We join the FY2024 NTD agency roster against the FTA GTFS Weblinks crosswalk and the Mobility Database, then read validation status from MobilityData’s canonical validator."
          )
        ),
        h("div", { className: "method-grid" },
          h("div", null,
            h("dl", null,
              h("div", null,
                h("dt", null, "Feed status"),
                h("dd", null,
                  h("em", null, "Current"),
                  " means a findable feed that passes the canonical validator and describes current service. ",
                  h("em", null, "Expired"),
                  " and ",
                  h("em", null, "Fails validator"),
                  " feeds are findable but out of date or invalid. ",
                  h("em", null, "No feed"),
                  " means no GTFS appears in the FTA weblinks crosswalk or the Mobility Database."
                )
              ),
              h("div", null,
                h("dt", null, "Coverage"),
                h("dd", null,
                  "The headline figure is the share of " + stateMeta.name + "’s NTD-listed agencies with a current, findable feed."
                )
              ),
              h("div", null,
                h("dt", null, "Scope & caveats"),
                h("dd", null,
                  "Only the " + HEADLINE.agencies.toLocaleString() + " agencies in the FY2024 NTD roster are included. Agency-to-feed joins use name and locality matching where no canonical ID exists; matches are reviewed but not infallible."
                )
              ),
              h("div", null,
                h("dt", null, "Refresh"),
                h("dd", null, "Monthly. Last refreshed " + HEADLINE.draftDate + ". Owner: " + HEADLINE.owner + ".")
              )
            )
          ),
          h("div", null,
            h("dt", { style: { fontFamily: "var(--font-body)", fontWeight: 600, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--gtfs-coral)", marginBottom: "8px", display: "block" } },
              "The national picture"
            ),
            h("div", { className: "cite-box" },
              h("div", { className: "txt" },
                "Nationally, " + HEADLINE.noFeedPct + "% of US federally funded transit agencies have no GTFS feed any trip planner can find."
              ),
              h("div", { style: { marginTop: "14px" } },
                h("a", { className: "btn-secondary", href: nationalHref }, "View the national dashboard →")
              )
            )
          )
        )
      )
    );
  }

  // Update the document title + social/canonical meta for the scoped state.
  // NOTE: social/search scrapers do not run this JS, so link-preview cards stay
  // national until a pre-render/SSG pass ships (Phase 2). This only fixes the
  // browser tab + canonical for users who actually load the page.
  function setMetaTag(kind, key, value) {
    let el = document.head.querySelector("meta[" + kind + "=\"" + key + "\"]");
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute(kind, key);
      document.head.appendChild(el);
    }
    el.setAttribute("content", value);
  }

  function applyStateMeta(stateMeta, cov) {
    const name = stateMeta.name;
    const title = name + " Transit Feed Health — GTFS·X";
    const desc = name + ": " + cov.coveragePct + "% of transit agencies publish a GTFS feed riders can find. " +
      "The state of transit data publishing across " + name + "’s NTD-listed agencies, and the path to full coverage.";
    const url = "https://gtfsx.com/feed-health/?state=" + stateMeta.abbr;

    document.title = title;
    setMetaTag("name", "description", desc);
    setMetaTag("property", "og:title", title);
    setMetaTag("property", "og:description", desc);
    setMetaTag("property", "og:url", url);
    setMetaTag("name", "twitter:title", title);
    setMetaTag("name", "twitter:description", desc);

    let link = document.head.querySelector("link[rel=\"canonical\"]");
    if (!link) {
      link = document.createElement("link");
      link.setAttribute("rel", "canonical");
      document.head.appendChild(link);
    }
    link.setAttribute("href", url);
  }

  function renderStateScoped(root, stateMeta, data, forValue) {
    const cov = computeStateCoverage(data);
    applyStateMeta(stateMeta, cov);
    const nationalHref = location.pathname;

    const main = document.createElement("main");
    main.appendChild(renderStateHero(stateMeta, data, cov, forValue));
    main.appendChild(renderStateAgencySection(stateMeta, data));
    main.appendChild(renderStateFlexSection(stateMeta));
    main.appendChild(renderStateMethodology(stateMeta, nationalHref));

    root.appendChild(renderStateTopBar(stateMeta.name, nationalHref));
    root.appendChild(main);
    root.appendChild(renderSiteFooter());

    // Trigger minigrad bar animations after paint
    animateFills();
  }

  // ===========================================================
  // NATIONAL VIEW (default)
  // ===========================================================
  function renderNational(root) {
    const divider = document.createElement("hr");
    divider.className = "rule wrap";
    divider.style.cssText = "margin:8px auto 0;max-width:1120px;width:calc(100% - 56px)";

    const main = document.createElement("main");
    main.appendChild(renderHero());
    main.appendChild(renderStatBand());
    main.appendChild(divider);
    main.appendChild(renderMapSection());
    main.appendChild(renderLeaderboard());
    main.appendChild(renderFlexSection());
    // Item 11: original CTA band removed — no renderCtaBand() call
    main.appendChild(renderClosingCta());
    main.appendChild(renderMethodology());

    root.appendChild(renderTopBar());
    root.appendChild(main);
    root.appendChild(renderSiteFooter());

    // Trigger bar animations after paint
    animateFills();
  }

  // ===========================================================
  // APP INIT
  // ===========================================================
  document.addEventListener("DOMContentLoaded", function () {
    const root = document.getElementById("root");
    if (!root) return;

    const params = new URLSearchParams(location.search);
    const stateParam = (params.get("state") || "").trim().toUpperCase();
    // Validate against the known state list before switching to the scoped layout.
    const stateMeta = stateParam
      ? window.FH_DATA.STATES.find(function (s) { return s.abbr === stateParam; })
      : null;

    if (stateMeta) {
      const forValue = sanitizeForLabel(params.get("for"));
      const dataUrl = DEMO_AGENCIES
        ? "data/agencies/_SAMPLE.json"
        : "data/agencies/" + stateMeta.abbr + ".json";
      fetch(dataUrl)
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.agencies && data.agencies.length) {
            renderStateScoped(root, stateMeta, data, forValue);
          } else {
            // Missing/empty state file — fall back cleanly to the national page.
            renderNational(root);
          }
        })
        .catch(function () { renderNational(root); });
      return;
    }

    // No / invalid ?state= → national page (unchanged).
    renderNational(root);
  });
})();
