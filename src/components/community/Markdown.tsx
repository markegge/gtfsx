import { Fragment, type ReactNode } from 'react';
import { safeImageSrc } from './markdownSafeUrl';

// Minimal, XSS-safe markdown renderer that produces React nodes (not raw HTML).
// Supports a deliberate subset:
//   - Fenced code blocks (```lang\n...\n```)
//   - Headings (# ... ######)
//   - Blockquotes (> ...)
//   - Unordered lists (- ... or * ...)
//   - Ordered lists (1. ...)
//   - GFM-style tables (| col | col |\n|---|---| with optional :---: alignment)
//   - Inline code (`code`)
//   - Bold (**text**) and italic (*text* or _text_)
//   - Links [text](url) — http/https only, otherwise text passes through unlinked
//   - Images ![alt](url) — only same-origin (/_forum-images/...), otherwise alt
//     text falls through. The allowlist is the abuse barrier: nothing else gets
//     rendered as an <img>, so users can't hot-link tracking pixels, host
//     arbitrary content, or exploit third-party CSP holes.
//   - Auto-link bare URLs
//   - Hard line breaks within paragraphs
//
// Anything else passes through as plain text. We deliberately do NOT support
// raw HTML or footnotes.

interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className = '' }: MarkdownProps) {
  const blocks = parseBlocks(children);
  return <div className={`forum-md leading-relaxed ${className}`}>{blocks.map((b, i) => <Fragment key={i}>{renderBlock(b)}</Fragment>)}</div>;
}

type Align = 'left' | 'right' | 'center' | null;
type Block =
  | { kind: 'code'; lang: string; body: string }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'table'; headers: string[]; aligns: Align[]; rows: string[][] }
  | { kind: 'p'; text: string }
  | { kind: 'hr' };

// Split a table row on unescaped `|`, trim each cell, and drop the
// leading/trailing empty produced by `| a | b |`.
function splitTableRow(line: string): string[] {
  const cells = line.split('|').map((c) => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// Parse a GFM table separator row (`|---|:---:|---:|`) into alignment
// hints, or return null if the line doesn't look like a separator.
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

    // Fenced code block
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      out.push({ kind: 'code', lang, body: body.join('\n') });
      continue;
    }

    // Blank line
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\s*)([-*_]\s*){3,}$/.test(line)) {
      out.push({ kind: 'hr' });
      i++;
      continue;
    }

    // Heading
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ kind: 'heading', level: h[1].length as 1, text: h[2] });
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push({ kind: 'quote', lines: buf });
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      out.push({ kind: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push({ kind: 'ol', items });
      continue;
    }

    // GFM table: a row containing `|` immediately followed by a separator
    // row (`|---|---|`). If the second line doesn't match the separator
    // shape, fall through to the paragraph branch and render the lines as
    // text — same as a stray `|` in prose.
    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = parseTableSeparator(lines[i + 1]);
      if (aligns) {
        const headers = splitTableRow(line);
        i += 2;
        const rows: string[][] = [];
        while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
          const cells = splitTableRow(lines[i]);
          // Pad / truncate to header width so the renderer always sees a
          // rectangular grid.
          while (cells.length < headers.length) cells.push('');
          if (cells.length > headers.length) cells.length = headers.length;
          rows.push(cells);
          i++;
        }
        out.push({ kind: 'table', headers, aligns, rows });
        continue;
      }
    }

    // Paragraph: accumulate non-blank lines.
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

function alignClass(align: Align): string {
  if (align === 'right') return 'text-right';
  if (align === 'center') return 'text-center';
  return 'text-left';
}

function renderBlock(b: Block): ReactNode {
  switch (b.kind) {
    case 'code':
      return (
        <pre className="bg-sand/60 border border-sand rounded-md p-3 my-3 text-xs overflow-x-auto">
          <code>{b.body}</code>
        </pre>
      );
    case 'heading': {
      const Tag = `h${Math.min(6, Math.max(2, b.level + 1))}` as keyof React.JSX.IntrinsicElements; // bump down so h1 looks like a section heading inside the post
      const sizeMap: Record<number, string> = {
        2: 'text-lg font-bold mt-3 mb-1',
        3: 'text-base font-bold mt-3 mb-1',
        4: 'text-sm font-bold mt-2 mb-1',
        5: 'text-sm font-semibold mt-2 mb-1',
        6: 'text-xs font-semibold mt-2 mb-1 uppercase tracking-wide',
      };
      const cls = sizeMap[Math.min(6, Math.max(2, b.level + 1))] ?? 'font-bold';
      return <Tag className={`text-dark-brown ${cls}`}>{renderInline(b.text)}</Tag>;
    }
    case 'quote':
      return (
        <blockquote className="border-l-4 border-sand pl-3 my-2 text-warm-gray italic">
          {b.lines.map((ln, i) => <p key={i}>{renderInline(ln)}</p>)}
        </blockquote>
      );
    case 'ul':
      return (
        <ul className="list-disc pl-6 my-2 space-y-1">
          {b.items.map((it, i) => <li key={i}>{renderInline(it)}</li>)}
        </ul>
      );
    case 'ol':
      return (
        <ol className="list-decimal pl-6 my-2 space-y-1">
          {b.items.map((it, i) => <li key={i}>{renderInline(it)}</li>)}
        </ol>
      );
    case 'table':
      return (
        <div className="my-3 overflow-x-auto">
          <table className="text-sm border-collapse w-full">
            <thead>
              <tr>
                {b.headers.map((h, i) => (
                  <th
                    key={i}
                    className={`border border-sand px-3 py-1.5 bg-cream font-semibold ${alignClass(b.aligns[i] ?? null)}`}
                  >
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={`border border-sand px-3 py-1.5 align-top ${alignClass(b.aligns[ci] ?? null)}`}
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr className="my-4 border-sand" />;
    case 'p':
      return <p className="my-2 whitespace-pre-wrap">{renderInline(b.text)}</p>;
  }
}

function renderInline(text: string): ReactNode {
  // Tokenize into: code span, image, link, bold, italic, autolink, plain.
  // Approach: walk through the string and split on the next pattern match.
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // Inline code: `…`
    let m: RegExpExecArray | null = /^`([^`\n]+)`/.exec(rest);
    if (m) {
      out.push(<code key={key++} className="bg-sand/60 px-1 rounded text-[0.85em]">{m[1]}</code>);
      i += m[0].length;
      continue;
    }

    // Image: ![alt](url). Must precede the link branch (both start with `[`).
    m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      const src = safeImageSrc(m[2]);
      if (src) {
        out.push(
          <img
            key={key++}
            src={src}
            alt={m[1]}
            loading="lazy"
            className="max-w-full h-auto rounded-md my-2 border border-sand"
          />,
        );
      } else {
        // Allowlist miss — render the alt text so context survives.
        out.push(<span key={key++}>{m[1]}</span>);
      }
      i += m[0].length;
      continue;
    }

    // Link: [text](url)
    m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (m) {
      const href = safeHref(m[2]);
      if (href) {
        out.push(<a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="text-coral underline hover:text-[#d4603a]">{m[1]}</a>);
      } else {
        out.push(<span key={key++}>{m[1]}</span>);
      }
      i += m[0].length;
      continue;
    }

    // Bold: **text**
    m = /^\*\*([^*]+)\*\*/.exec(rest);
    if (m) {
      out.push(<strong key={key++} className="font-semibold text-dark-brown">{m[1]}</strong>);
      i += m[0].length;
      continue;
    }

    // Italic: *text* or _text_
    m = /^\*([^*\n]+)\*/.exec(rest) ?? /^_([^_\n]+)_/.exec(rest);
    if (m) {
      out.push(<em key={key++} className="italic">{m[1]}</em>);
      i += m[0].length;
      continue;
    }

    // Autolink bare URL
    m = /^https?:\/\/[^\s)]+/.exec(rest);
    if (m) {
      const href = safeHref(m[0]);
      if (href) {
        out.push(<a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="text-coral underline hover:text-[#d4603a]">{m[0]}</a>);
      } else {
        out.push(<span key={key++}>{m[0]}</span>);
      }
      i += m[0].length;
      continue;
    }

    // Hard line break inside paragraph
    if (rest.startsWith('\n')) {
      out.push(<br key={key++} />);
      i++;
      continue;
    }

    // Plain char run — consume until the next markdown-meaningful character.
    const next = rest.search(/[`![*_\n]|https?:\/\//);
    const take = next === -1 ? rest.length : Math.max(1, next);
    out.push(<span key={key++}>{rest.slice(0, take)}</span>);
    i += take;
  }
  return out;
}

function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return u.toString();
  } catch {
    // not a valid absolute URL
  }
  return null;
}
