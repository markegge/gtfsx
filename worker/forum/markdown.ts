// Server-side markdown → safe HTML for forum SSR. Mirrors the rules in
// src/components/community/Markdown.tsx but emits HTML strings (escaped) so the
// crawler / no-JS reader gets the same readable content the SPA later
// hydrates. Image syntax is supported here too: only same-origin image URLs
// are allowed (FEEDS_ORIGIN/_forum-images/...) — anything else falls back to
// alt text.

const FORUM_IMAGE_PATH_PREFIX = '/_forum-images/';

export interface MdRenderOptions {
  // Whitelisted hosts for inline images (the feeds host from FEEDS_ORIGIN and
  // the dedicated image host from IMAGES_ORIGIN — see worker/forum/seo.ts).
  // Anything else is dropped to alt text only. Empty = no absolute image hosts
  // allowed (relative /_forum-images/ paths still pass).
  imageOriginHosts: string[];
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

type Align = 'left' | 'right' | 'center' | null;
type Block =
  | { kind: 'code'; lang: string; body: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'table'; headers: string[]; aligns: Align[]; rows: string[][] }
  | { kind: 'p'; text: string }
  | { kind: 'hr' };

function splitTableRow(line: string): string[] {
  const cells = line.split('|').map((c) => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function parseTableSeparator(line: string): Align[] | null {
  const trimmed = line.trim();
  if (!/^\|?[\s:|-]+\|?$/.test(trimmed) || !trimmed.includes('-')) return null;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return null;
  const aligns: Align[] = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

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

    // GFM-style table: header row containing `|` followed by a separator
    // (`|---|---|`). If the second line isn't a separator we fall through
    // to the paragraph branch (matches the SPA renderer).
    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = parseTableSeparator(lines[i + 1]);
      if (aligns) {
        const headers = splitTableRow(line);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
          const cells = splitTableRow(lines[i]);
          while (cells.length < headers.length) cells.push('');
          if (cells.length > headers.length) cells.length = headers.length;
          rows.push(cells);
          i++;
        }
        out.push({ kind: 'table', headers, aligns, rows });
        continue;
      }
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
    || line.includes('|')
  );
}

function alignAttr(align: Align): string {
  if (align === 'right') return ' style="text-align:right"';
  if (align === 'center') return ' style="text-align:center"';
  if (align === 'left') return ' style="text-align:left"';
  return '';
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
    case 'table': {
      const head = `<thead><tr>${b.headers
        .map((h, i) => `<th${alignAttr(b.aligns[i] ?? null)}>${renderInline(h, opts)}</th>`)
        .join('')}</tr></thead>`;
      const body = `<tbody>${b.rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell, ci) => `<td${alignAttr(b.aligns[ci] ?? null)}>${renderInline(cell, opts)}</td>`)
              .join('')}</tr>`,
        )
        .join('')}</tbody>`;
      return `<table>${head}${body}</table>`;
    }
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
      const safeSrc = safeImageSrc(m[2], opts.imageOriginHosts);
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
// path (relative, or absolute against one of the allowed image hosts — the
// feeds host from FEEDS_ORIGIN and the dedicated image host from
// IMAGES_ORIGIN). Everything else falls back to alt text — this defeats
// hotlinking-from-anywhere abuse vectors (tracking pixels, blasting
// third-party hosts, malicious SVG/animated payloads on arbitrary domains).
export function safeImageSrc(raw: string, imageOriginHosts: string[]): string | null {
  // Relative path: must start with the forum-images prefix.
  if (raw.startsWith(FORUM_IMAGE_PATH_PREFIX)) return raw;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!imageOriginHosts.includes(u.hostname)) return null;
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
