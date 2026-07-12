/* docs-nav.js — shared navigation for Docs and Learn pages.
   Docs pages get a left-rail (sections below) + prev/next.
   Learn pages get breadcrumbs + a "More in Learn" cross-link block (no rail).
   Single source of truth: SECTIONS (docs rail) and LEARN (learn articles).
   Drop a <script src="/assets/docs/docs-nav.js"></script> before </body> on each page. */
(function () {
  'use strict';

  /* ── Docs navigation manifest ───────────────────────────────────────
     Ordered list; sections mirror the docs hub groupings.
     Docs only — Learn is its own list below. Edit here to add/reorder docs.
  ─────────────────────────────────────────────────────────────────── */
  var SECTIONS = [
    {
      label: 'Foundations',
      pages: [
        { path: '/docs/quick-start/',             title: 'Quick Start' },
        { path: '/docs/account-and-cloud-sync/',  title: 'Account & Cloud Sync' },
        { path: '/docs/pricing/',                 title: 'Pricing & Plans' },
        { path: '/docs/feature-settings/',        title: 'Feature Settings' },
        { path: '/docs/organizations/',           title: 'Organizations' }
      ]
    },
    {
      label: 'Editor panels',
      pages: [
        { path: '/docs/agency-setup/',                  title: 'Agency Setup' },
        { path: '/docs/service-calendars/',             title: 'Service Calendars' },
        { path: '/docs/routes-and-shapes/',             title: 'Routes & Shapes' },
        { path: '/docs/stops/',                         title: 'Stops' },
        { path: '/docs/stations/',                      title: 'Stations' },
        { path: '/docs/timetables-and-trips/',          title: 'Timetables & Trips' },
        { path: '/docs/fares/',                         title: 'Fares' },
        { path: '/docs/transfers/',                     title: 'Transfers' },
        { path: '/docs/flex-zones-and-booking-rules/',  title: 'Flex Zones & Booking Rules' }
      ]
    },
    {
      label: 'Validation & I/O',
      pages: [
        { path: '/docs/validation/',       title: 'Validation' },
        { path: '/docs/import-and-export/', title: 'Import & Export' },
        { path: '/docs/shapes-from-stops/', title: 'Generate Shapes from Stops' },
        { path: '/docs/service-summary/',  title: 'Service Summary' },
        { path: '/docs/deep-links/',       title: 'Integrations' }
      ]
    },
    {
      label: 'Analysis tools',
      pages: [
        { path: '/docs/cost-estimation/',      title: 'Cost Estimation' },
        { path: '/docs/demographic-coverage/', title: 'Demographic Coverage' },
        { path: '/docs/access-isochrones/',    title: 'Transit Access Isochrones' },
        { path: '/docs/stop-analysis/',        title: 'Stop Analysis' },
        { path: '/docs/title-vi-analysis/',    title: 'Title VI Analysis' },
        { path: '/docs/scenario-analysis/',    title: 'Route Visibility' },
        { path: '/docs/service-planning/',     title: 'Service Planning' },
        { path: '/docs/rider-propensity/',     title: 'Rider Propensity' }
      ]
    },
    {
      label: 'Publishing & distribution',
      pages: [
        { path: '/docs/hosted-publishing/',  title: 'Hosted Publishing' },
        { path: '/docs/rider-mini-site/',    title: 'Rider Mini-Site' },
        { path: '/docs/embed-widgets/',      title: 'Embed Widgets' },
        { path: '/docs/draft-links/',        title: 'Draft Links' },
        { path: '/docs/service-alerts/',     title: 'Service Alerts' }
      ]
    }
  ];

  /* ── Learn articles ─────────────────────────────────────────────────
     Source of truth is window.GTFSX_LEARN, set by site-nav.js (loaded just
     before this script on every static page). Used here for the learn-page
     breadcrumbs and the "More in Learn" cross-link block. The inline fallback
     applies only if site-nav.js failed to load. To add a learn article, edit
     the LEARN array in site-nav.js. */
  var LEARN = window.GTFSX_LEARN || [
    { path: '/learn/gtfs/',               title: 'What is GTFS?' },
    { path: '/learn/gtfs-flex/',          title: 'What is GTFS-Flex?' },
    { path: '/learn/publish-gtfs-feed/',  title: 'How to Publish a GTFS Feed' }
  ];

  /* ── Flat ordered list of docs pages for prev/next ────────────────── */
  var ALL_PAGES = [];
  SECTIONS.forEach(function (s) {
    s.pages.forEach(function (p) {
      ALL_PAGES.push({ path: p.path, title: p.title, section: s.label });
    });
  });

  /* ── Identify current page ────────────────────────────────────────── */
  var currentPath = location.pathname;
  if (currentPath.charAt(currentPath.length - 1) !== '/') currentPath += '/';

  var isLearnPage = currentPath.indexOf('/learn/') === 0;

  // Locate current page in the relevant list.
  var docsIndex = -1;
  for (var ci = 0; ci < ALL_PAGES.length; ci++) {
    if (ALL_PAGES[ci].path === currentPath) { docsIndex = ci; break; }
  }

  var learnIndex = -1;
  for (var li = 0; li < LEARN.length; li++) {
    if (LEARN[li].path === currentPath) { learnIndex = li; break; }
  }

  // Not a page we know about -- bail silently.
  if (docsIndex === -1 && learnIndex === -1) return;

  // Docs pages show the left rail; learn pages never do.
  var showSidebar = !isLearnPage && docsIndex !== -1;

  /* ── Inject shared CSS ────────────────────────────────────────────── */
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/assets/docs/docs-nav.css';
  document.head.appendChild(link);

  /* ── Build left-rail sidebar (docs pages only) ────────────────────── */
  if (showSidebar) {
    document.body.classList.add('docs-with-sidebar');

    var aside = document.createElement('aside');
    aside.className = 'docs-sidebar';
    aside.setAttribute('aria-label', 'Documentation navigation');

    // Mobile toggle button (hidden on desktop via CSS)
    var toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'docs-nav-mobile-toggle';
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.setAttribute('aria-controls', 'docs-nav-list');
    toggleBtn.innerHTML =
      '<span class="docs-nav-mobile-toggle-icon" aria-hidden="true">&#9654;</span> On this site';
    aside.appendChild(toggleBtn);

    // Nav landmark wrapping the list
    var nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Docs');

    var ul = document.createElement('ul');
    ul.className = 'docs-nav-list';
    ul.id = 'docs-nav-list';
    ul.setAttribute('hidden', '');

    SECTIONS.forEach(function (section) {
      // Section label row (not a link, not a heading -- visual grouper only)
      var labelLi = document.createElement('li');
      labelLi.setAttribute('role', 'presentation');
      var labelSpan = document.createElement('span');
      labelSpan.className = 'docs-nav-section-label';
      labelSpan.textContent = section.label;
      labelLi.appendChild(labelSpan);
      ul.appendChild(labelLi);

      section.pages.forEach(function (page) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = page.path;
        a.textContent = page.title;
        if (page.path === currentPath) {
          a.setAttribute('aria-current', 'page');
        }
        li.appendChild(a);
        ul.appendChild(li);
      });
    });

    nav.appendChild(ul);
    aside.appendChild(nav);

    // Insert aside immediately after .site-header
    var header = document.querySelector('.site-header');
    if (header && header.parentNode) {
      header.parentNode.insertBefore(aside, header.nextSibling);
    } else {
      document.body.insertBefore(aside, document.body.firstChild);
    }

    // Mobile toggle interaction
    toggleBtn.addEventListener('click', function () {
      var expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
      toggleBtn.setAttribute('aria-expanded', String(!expanded));
      if (expanded) {
        ul.setAttribute('hidden', '');
      } else {
        ul.removeAttribute('hidden');
      }
    });
  }

  /* ── Prev / Next (docs pages only) ────────────────────────────────── */
  if (!isLearnPage && docsIndex !== -1) {
    var prevEntry = docsIndex > 0 ? ALL_PAGES[docsIndex - 1] : null;
    var nextEntry = docsIndex < ALL_PAGES.length - 1 ? ALL_PAGES[docsIndex + 1] : null;

    if (prevEntry || nextEntry) {
      var pnDiv = document.createElement('div');
      pnDiv.className = 'docs-prev-next';

      if (prevEntry) {
        var prevA = document.createElement('a');
        prevA.className = 'docs-pn-prev';
        prevA.href = prevEntry.path;
        prevA.innerHTML =
          '<span class="docs-prev-next-label">Previous</span>' +
          '<span class="docs-prev-next-title">' + esc(prevEntry.title) + '</span>';
        pnDiv.appendChild(prevA);
      }

      if (nextEntry) {
        var nextA = document.createElement('a');
        nextA.className = 'docs-pn-next';
        nextA.href = nextEntry.path;
        nextA.innerHTML =
          '<span class="docs-prev-next-label">Next</span>' +
          '<span class="docs-prev-next-title">' + esc(nextEntry.title) + '</span>';
        pnDiv.appendChild(nextA);
      }

      var mainEl = document.querySelector('main');
      if (mainEl) mainEl.appendChild(pnDiv);
    }
  }

  /* ── Learn pages: breadcrumbs (top) + More in Learn (bottom) ──────── */
  if (isLearnPage && learnIndex !== -1) {
    var learnEntry = LEARN[learnIndex];
    var learnMain = document.querySelector('main');

    if (learnMain) {
      // Breadcrumbs: Home / Learn / <article>. "Learn" is plain text
      // (no /learn/ index exists); current article is non-linked.
      var bcNav = document.createElement('nav');
      bcNav.setAttribute('aria-label', 'Breadcrumb');

      var bcOl = document.createElement('ol');
      bcOl.className = 'docs-breadcrumbs';

      var homeLi = document.createElement('li');
      var homeA = document.createElement('a');
      homeA.href = '/';
      homeA.textContent = 'Home';
      homeLi.appendChild(homeA);
      bcOl.appendChild(homeLi);

      var learnLi = document.createElement('li');
      var learnSpan = document.createElement('span');
      learnSpan.textContent = 'Learn';
      learnLi.appendChild(learnSpan);
      bcOl.appendChild(learnLi);

      var currLi = document.createElement('li');
      var currSpan = document.createElement('span');
      currSpan.setAttribute('aria-current', 'page');
      currSpan.textContent = learnEntry.title;
      currLi.appendChild(currSpan);
      bcOl.appendChild(currLi);

      bcNav.appendChild(bcOl);
      learnMain.insertBefore(bcNav, learnMain.firstChild);

      // "More in Learn": links to the OTHER learn articles. Sits at the
      // bottom of the article, below the content/CTA -- conversion-safe.
      var others = LEARN.filter(function (a) { return a.path !== currentPath; });
      if (others.length) {
        var moreSection = document.createElement('nav');
        moreSection.className = 'learn-more';
        moreSection.setAttribute('aria-label', 'More in Learn');

        var moreHeading = document.createElement('h2');
        moreHeading.className = 'learn-more-title';
        moreHeading.textContent = 'More in Learn';
        moreSection.appendChild(moreHeading);

        var moreUl = document.createElement('ul');
        moreUl.className = 'learn-more-list';
        others.forEach(function (a) {
          var liEl = document.createElement('li');
          var aEl = document.createElement('a');
          aEl.href = a.path;
          aEl.textContent = a.title;
          liEl.appendChild(aEl);
          moreUl.appendChild(liEl);
        });
        moreSection.appendChild(moreUl);
        learnMain.appendChild(moreSection);
      }
    }
  }

  /* ── Section permalinks (docs + learn article subheadings) ─────────── */
  addSectionPermalinks();

  /* ── Utility: HTML-escape ───────────────────────────────────────────── */
  function esc(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Section permalinks ──────────────────────────────────────────────
     Give every article subheading (h2/h3 inside <main>) a stable id and a
     subtle "copy link" button. Existing ids are preserved; missing ones are
     slugified from the heading text and de-duped with numeric suffixes.
     Navigational / injected headings ("On this page", "More in Learn") are
     skipped. The script does all of this so no per-page edits are needed. */
  function addSectionPermalinks() {
    var mainEl = document.querySelector('main');
    if (!mainEl) return;

    var headings = mainEl.querySelectorAll('h2, h3');
    if (!headings.length) return;

    // Seed the used-id set with every id already on the page.
    var used = {};
    var existing = document.querySelectorAll('[id]');
    for (var e = 0; e < existing.length; e++) {
      if (existing[e].id) used[existing[e].id] = true;
    }

    for (var i = 0; i < headings.length; i++) {
      var heading = headings[i];

      // Skip navigational widgets and headings this script injects.
      if (heading.closest('.toc') || heading.closest('.learn-more') ||
          heading.closest('nav') || heading.closest('.docs-sidebar')) {
        continue;
      }
      if (heading.getAttribute('data-anchored') === 'true') continue;

      // 1. Ensure a stable id (keep existing; otherwise slugify + de-dupe).
      var id = heading.getAttribute('id');
      if (!id) {
        var base = slugify(heading.textContent) || 'section';
        id = base;
        var n = 2;
        while (used[id]) { id = base + '-' + n; n += 1; }
        heading.setAttribute('id', id);
      }
      used[id] = true;

      heading.setAttribute('data-anchored', 'true');
      heading.classList.add('docs-heading');

      // 2. Copy-link button (subtle at rest; shown on hover / focus).
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'heading-anchor';
      btn.setAttribute('aria-label', 'Copy link to this section');
      btn.title = 'Copy link to this section';
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
        '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' +
        '</svg><span class="heading-anchor-feedback" aria-hidden="true">Copied</span>';
      heading.appendChild(btn);

      bindPermalink(heading, id, btn);
    }

    // 3. Initial deep-link: re-scroll once stylesheets have loaded so the
    // target heading clears the sticky header (scroll-margin-top applies).
    if (location.hash && location.hash.length > 1) {
      var hashId = decodeURIComponent(location.hash.slice(1));
      window.addEventListener('load', function () {
        var target = document.getElementById(hashId);
        if (target) target.scrollIntoView();
      });
    }
  }

  function bindPermalink(heading, id, btn) {
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var url = location.origin + location.pathname + '#' + id;
      if (location.hash !== '#' + id) {
        location.hash = id; // updates URL + native scroll (honors scroll-margin)
      } else {
        heading.scrollIntoView();
      }
      copyLinkText(url, btn);
    });

    // Clicking the heading itself also deep-links, unless the user is
    // selecting text or clicking the button.
    heading.addEventListener('click', function (ev) {
      if (ev.target.closest('.heading-anchor')) return;
      if (window.getSelection && !window.getSelection().isCollapsed) return;
      location.hash = id;
    });
  }

  function slugify(text) {
    return (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function copyLinkText(text, btn) {
    function done() {
      btn.classList.add('copied');
      btn.setAttribute('aria-label', 'Link copied');
      setTimeout(function () {
        btn.classList.remove('copied');
        btn.setAttribute('aria-label', 'Copy link to this section');
      }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        fallbackCopy(text);
        done();
      });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (err) { /* ignore */ }
    document.body.removeChild(ta);
  }
})();
