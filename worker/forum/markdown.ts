// Server-side markdown → safe HTML for forum SSR. Mirrors the rules in
// src/components/community/Markdown.tsx but emits HTML strings (escaped) so the
// crawler / no-JS reader gets the same readable content the SPA later
// hydrates. Image syntax is supported here too: only same-origin image URLs
// are allowed (FEEDS_ORIGIN/_forum-images/...) — anything else falls back to
// alt text.

const FORUM_IMAGE_PATH_PREFIX = '/_forum-images/';

export interface MdRenderOptions {
  // Whitelisted origin for inline images (FEEDS_ORIGIN). Anything else is
  // dropped to alt text only.
  imageOriginHost: string | null;
}

export function renderMarkdownToHtml(src: string, opts: MdRenderOptions): string {
  const blocks = parseBlocks(src);
  return blocks.map((b) => renderBlock(b, opts)).join('\n');
}

// Strip markdown to plain text for meta descriptions / OG previews.
export function markdownToPlainText(src: string, maxLen = 200): string {
  const text = src
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1).trimEnd() + '…';
}

type Block =
  | { kind: 'code'; lang: string; body: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'p'; text: string }
  | { kind: 'hr' };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      out.push({ kind: 'code', lang, body: body.join('\n') });
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    if (/^(\s*)([-*_]\s*){3,}$/.test(line)) {
      out.push({ kind: 'hr' });
      i++;
      continue;
    }

    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ kind: 'heading', level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push({ kind: 'quote', lines: buf });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      out.push({ kind: 'ul', items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push({ kind: 'ol', items });
      continue;
    }

    const buf: string[] = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ kind: 'p', text: buf.join('\n') });
  }
  return out;
}

function isBlockStart(line: string): boolean {
  return (
    /^```/.test(line)
    || /^(#{1,6})\s+/.test(line)
    || /^>\s?/.test(line)
    || /^\s*[-*]\s+/.test(line)
    || /^\s*\d+\.\s+/.test(line)
    || /^(\s*)([-*_]\s*){3,}$/.test(line)
  );
}

function renderBlock(b: Block, opts: MdRenderOptions): string {
  switch (b.kind) {
    case 'code':
      return `<pre><code>${escapeHtml(b.body)}</code></pre>`;
    case 'heading': {
      // Bump down by one so the post's "h1" looks like a section heading
      // inside the page, mirroring the client renderer.
      const level = Math.min(6, Math.max(2, b.level + 1));
      return `<h${level}>${renderInline(b.text, opts)}</h${level}>`;
    }
    case 'quote':
      return `<blockquote>${b.lines.map((ln) => `<p>${renderInline(ln, opts)}</p>`).join('')}</blockquote>`;
    case 'ul':
      return `<ul>${b.items.map((it) => `<li>${renderInline(it, opts)}</li>`).join('')}</ul>`;
    case 'ol':
      return `<ol>${b.items.map((it) => `<li>${renderInline(it, opts)}</li>`).join('')}</ol>`;
    case 'hr':
      return `<hr/>`;
    case 'p':
      return `<p>${renderInline(b.text, opts)}</p>`;
  }
}

function renderInline(text: string, opts: MdRenderOptions): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    let m: RegExpExecArray | null = /^`([^`\n]+)`/.exec(rest);
    if (m) {
      out += `<code>${escapeHtml(m[1])}</code>`;
      i += m[0].length;
      continue;
    }

    // Image first (must precede link since both start with `[`-ish).
    m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      const alt = m[1];
      const safeSrc = safeImageSrc(m[2], opts.imageOriginHost);
      if (safeSrc) {
        out += `<img src="${escapeHtml(safeSrc)}" alt="${escapeHtml(alt)}" loading="lazy" />`;
      } else {
        out += escapeHtml(alt);
      }
      i += m[0].length;
      continue;
    }

    m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      const href = safeLinkHref(m[2]);
      if (href) {
        out += `<a href="${escapeHtml(href)}" rel="nofollow ugc noopener noreferrer">${renderInline(m[1], opts)}</a>`;
      } else {
        out += renderInline(m[1], opts);
      }
      i += m[0].length;
      continue;
    }

    m = /^\*\*([^*]+)\*\*/.exec(rest);
    if (m) {
      out += `<strong>${renderInline(m[1], opts)}</strong>`;
      i += m[0].length;
      continue;
    }

    m = /^\*([^*\n]+)\*/.exec(rest) ?? /^_([^_\n]+)_/.exec(rest);
    if (m) {
      out += `<em>${renderInline(m[1], opts)}</em>`;
      i += m[0].length;
      continue;
    }

    m = /^https?:\/\/[^\s)]+/.exec(rest);
    if (m) {
      const href = safeLinkHref(m[0]);
      if (href) {
        out += `<a href="${escapeHtml(href)}" rel="nofollow ugc noopener noreferrer">${escapeHtml(m[0])}</a>`;
      } else {
        out += escapeHtml(m[0]);
      }
      i += m[0].length;
      continue;
    }

    if (rest.startsWith('\n')) {
      out += '<br/>';
      i++;
      continue;
    }

    const next = rest.search(/[`![*_\n]|https?:\/\//);
    const take = next === -1 ? rest.length : Math.max(1, next);
    out += escapeHtml(rest.slice(0, take));
    i += take;
  }
  return out;
}

function safeLinkHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
      return u.toString();
    }
  } catch {
    // not a valid absolute URL — drop the link
  }
  return null;
}

// Image URL allowlist: only allow images served from our own forum-images
// path (relative or absolute against FEEDS_ORIGIN). Everything else falls
// back to alt text — this defeats hotlinking-from-anywhere abuse vectors
// (tracking pixels, blasting third-party hosts, malicious SVG/animated
// payloads on arbitrary domains).
export function safeImageSrc(raw: string, imageOriginHost: string | null): string | null {
  // Relative path: must start with the forum-images prefix.
  if (raw.startsWith(FORUM_IMAGE_PATH_PREFIX)) return raw;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!imageOriginHost) return null;
    if (u.hostname !== imageOriginHost) return null;
    if (!u.pathname.startsWith(FORUM_IMAGE_PATH_PREFIX)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
