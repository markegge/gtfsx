// Worker-rendered HTML for the /book-demo lead form. Standalone page (not part
// of the React bundle) so it can serve instantly on the same URL every
// marketing placement already points at (/book-demo?src=<placement>), with the
// query string preserved for the client to forward on submit.
//
// The look mirrors the static marketing home page (public/home/): cream/sand
// canvas, coral accent, Nunito headings, Inter body — fonts served as static
// assets from /home/fonts/. Everything is inlined so the page is a single
// self-contained worker response with no dependency on the SPA build.
//
// Copy rule: no spaced em dashes in user-facing text (commas/colons/parens).

interface PageOpts {
  /** Public Turnstile site key. Empty => widget skipped (dev/unconfigured). */
  siteKey: string;
  /** The founder's booking calendar, offered after a successful submit. */
  bookingUrl: string;
}

// Attribute-safe escape for the two injected config values.
function attr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderBookDemoPage(opts: PageOpts): string {
  const siteKey = attr(opts.siteKey);
  const bookingUrl = attr(opts.bookingUrl);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>See GTFS·X in action</title>
<link rel="icon" href="/favicon.ico" />
<style>
@font-face {
  font-family: "Nunito";
  src: url("/home/fonts/Nunito/Nunito-VariableFont_wght.ttf") format("truetype-variations");
  font-weight: 200 1000; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Inter";
  src: url("/home/fonts/Inter/Inter-VariableFont_opsz,wght.ttf") format("truetype-variations");
  font-weight: 100 900; font-style: normal; font-display: swap;
}
:root {
  --cream: #FFF8F0; --sand: #F5E6D3; --warm-gray: #8B7E74; --brown: #5C4A3A;
  --dark-brown: #3D2E22; --coral: #E8734A; --coral-deep: #D4603A;
  --coral-light: #FDECE5; --teal: #2A9D8F; --border-strong: #EADBC8;
  --font-heading: "Nunito", ui-rounded, system-ui, sans-serif;
  --font-body: "Inter", ui-sans-serif, system-ui, -apple-system, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--font-body); color: var(--dark-brown);
  background: var(--cream); line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh; display: flex; flex-direction: column;
}
.wrap { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 20px; }
.card {
  width: 100%; max-width: 520px; background: #fff;
  border: 1px solid var(--border-strong); border-radius: 16px;
  box-shadow: 0 12px 32px rgba(61, 46, 34, 0.10);
  padding: 32px 30px;
}
.brand {
  font-family: var(--font-heading); font-weight: 800; font-size: 15px;
  letter-spacing: 0.02em; color: var(--brown); margin: 0 0 20px;
}
.brand .x { color: var(--coral); }
h1 {
  font-family: var(--font-heading); font-weight: 800;
  font-size: 26px; line-height: 1.2; margin: 0 0 8px; color: var(--dark-brown);
}
.sub { margin: 0 0 22px; color: var(--warm-gray); font-size: 15px; }
label { display: block; font-size: 13px; font-weight: 600; color: var(--brown); margin: 14px 0 5px; }
label .opt { font-weight: 400; color: var(--warm-gray); }
input[type="text"], input[type="email"], textarea {
  width: 100%; font-family: var(--font-body); font-size: 15px; color: var(--dark-brown);
  padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: 8px;
  background: var(--cream); transition: border-color 120ms, box-shadow 120ms;
}
input:focus, textarea:focus {
  outline: none; border-color: var(--coral);
  box-shadow: 0 0 0 3px var(--coral-light); background: #fff;
}
textarea { resize: vertical; min-height: 72px; }
/* Honeypot: visually + assistively hidden, but a bot filling every field trips it. */
.hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.turnstile { margin: 16px 0 4px; }
button.submit {
  width: 100%; margin-top: 18px; font-family: var(--font-heading); font-weight: 700;
  font-size: 16px; color: #fff; background: var(--coral); border: 0;
  padding: 13px 18px; border-radius: 10px; cursor: pointer;
  transition: background 120ms, transform 120ms;
}
button.submit:hover { background: var(--coral-deep); }
button.submit:active { transform: translateY(1px); }
button.submit:disabled { opacity: 0.6; cursor: default; }
.err { color: #B4442A; font-size: 14px; margin-top: 12px; min-height: 0; }
.fine { color: var(--warm-gray); font-size: 12px; margin: 16px 0 0; }
/* Thank-you state */
.thanks { text-align: center; padding: 8px 0; }
.thanks .check {
  width: 52px; height: 52px; border-radius: 50%; background: var(--teal);
  color: #fff; display: inline-flex; align-items: center; justify-content: center;
  font-size: 28px; margin: 0 auto 14px;
}
.thanks h2 { font-family: var(--font-heading); font-weight: 800; font-size: 22px; margin: 0 0 10px; }
.thanks p { color: var(--brown); margin: 0 auto 22px; max-width: 380px; }
.book {
  display: inline-block; font-family: var(--font-heading); font-weight: 700; font-size: 16px;
  color: #fff; background: var(--coral); text-decoration: none;
  padding: 13px 26px; border-radius: 10px; transition: background 120ms;
}
.book:hover { background: var(--coral-deep); }
/* Small nav link under the card, revealed with the thank-you state. */
.home-link { text-align: center; margin: 16px 0 0; font-size: 13px; }
.home-link a { color: var(--warm-gray); text-decoration: none; }
.home-link a:hover { color: var(--coral-deep); text-decoration: underline; }
.hidden { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div id="form-view">
      <p class="brand">GTFS<span class="x">·X</span></p>
      <h1>See GTFS·X in action</h1>
      <p class="sub">Tell us a bit about your agency and we'll set up a walkthrough of building, validating, and publishing GTFS right in the browser.</p>
      <form id="lead-form" novalidate>
        <label for="name">Name</label>
        <input id="name" name="name" type="text" autocomplete="name" required maxlength="120" />

        <label for="email">Work email</label>
        <input id="email" name="email" type="email" autocomplete="email" required maxlength="254" />

        <label for="org">Agency / organization</label>
        <input id="org" name="org" type="text" autocomplete="organization" required maxlength="160" />

        <label for="message">Anything specific you want to see? <span class="opt">(optional)</span></label>
        <textarea id="message" name="message" maxlength="2000"></textarea>

        <!-- Honeypot: real people leave this empty. -->
        <div class="hp" aria-hidden="true">
          <label for="company_website">Company website</label>
          <input id="company_website" name="company_website" type="text" tabindex="-1" autocomplete="off" />
        </div>

        <div class="turnstile" id="turnstile-container" data-sitekey="${siteKey}"></div>

        <button class="submit" type="submit" id="submit-btn">Request a demo</button>
        <div class="err" id="error" role="alert"></div>
      </form>
      <p class="fine">Prefer to skip ahead? <a href="${bookingUrl}" target="_blank" rel="noopener" style="color: var(--coral-deep);">Pick a time on the calendar.</a></p>
    </div>

    <div id="thanks-view" class="thanks hidden">
      <div class="check" aria-hidden="true">&#10003;</div>
      <h2>Thanks, you're on our radar</h2>
      <p>You'll hear from us within one business day. Want to skip the back-and-forth? Pick a time that works for you.</p>
      <a class="book" href="${bookingUrl}" target="_blank" rel="noopener">Grab a time now</a>
    </div>
  </div>
  <p class="home-link hidden" id="home-link"><a href="/">&larr; Back to home</a></p>
</div>

<script>
(function () {
  var container = document.getElementById('turnstile-container');
  var siteKey = container ? container.getAttribute('data-sitekey') : '';
  var turnstileToken = '';
  var widgetId = null;

  // Load the Turnstile widget only when a site key is configured. Without it
  // (dev / unconfigured) the form still submits; the server skips verification
  // to match, and the honeypot + rate limit still apply.
  if (siteKey) {
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.defer = true;
    s.onload = function () {
      if (!window.turnstile) return;
      widgetId = window.turnstile.render(container, {
        sitekey: siteKey,
        callback: function (t) { turnstileToken = t; },
        'error-callback': function () { turnstileToken = ''; },
        'expired-callback': function () { turnstileToken = ''; },
        theme: 'light'
      });
    };
    document.head.appendChild(s);
  }

  // Pull the campaign context off the current URL. src is the placement label;
  // fall back to utm_campaign / utm_source so auto-tagged UTMs still populate it.
  var params = new URLSearchParams(window.location.search);
  function cap(v, n) { return v ? String(v).slice(0, n) : ''; }
  var src = cap(params.get('src') || params.get('utm_campaign') || params.get('utm_source'), 128);
  var gclid = cap(params.get('gclid'), 256);
  var gbraid = cap(params.get('gbraid'), 256);
  var wbraid = cap(params.get('wbraid'), 256);
  var ref = cap(document.referrer, 128);

  var form = document.getElementById('lead-form');
  var btn = document.getElementById('submit-btn');
  var errEl = document.getElementById('error');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Sending…';

    var payload = {
      name: document.getElementById('name').value.trim(),
      email: document.getElementById('email').value.trim(),
      org: document.getElementById('org').value.trim(),
      message: document.getElementById('message').value.trim(),
      company_website: document.getElementById('company_website').value,
      src: src, gclid: gclid, gbraid: gbraid, wbraid: wbraid, ref: ref,
      turnstileToken: turnstileToken
    };

    fetch('/api/demo-leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GB-Client': 'web' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (res.ok) {
        document.getElementById('form-view').classList.add('hidden');
        document.getElementById('thanks-view').classList.remove('hidden');
        document.getElementById('home-link').classList.remove('hidden');
        return;
      }
      return res.json().catch(function () { return {}; }).then(function (body) {
        errEl.textContent = (body && body.message) || 'Something went wrong. Please try again.';
        btn.disabled = false;
        btn.textContent = 'Request a demo';
        if (widgetId !== null && window.turnstile) { window.turnstile.reset(widgetId); turnstileToken = ''; }
      });
    }).catch(function () {
      errEl.textContent = 'Network error. Please try again.';
      btn.disabled = false;
      btn.textContent = 'Request a demo';
    });
  });
})();
</script>
</body>
</html>`;
}
