// POST /api/forum/uploads/image — user-uploaded forum images.
//
// Security model:
//   1. Auth + forum write gate (display name set, not banned) reused from posts.
//   2. New-account gate: account must be ≥24h old AND email verified.
//   3. Magic-byte sniff: trust the file header, not the filename or Content-Type.
//      Only image/jpeg, image/png, image/gif, image/webp are accepted. SVG is
//      flatly rejected (script injection vector) — also AVIF/HEIC, since neither
//      is broadly safe-to-render-without-libraries territory.
//   4. Size cap: 5 MB. Dimension cap: 4096×4096 — applied via header parsing
//      since the workerd runtime has no native image decode. JPEG/PNG/GIF/WebP
//      headers are all small and well-defined.
//   5. EXIF strip for JPEG (drops APP-segment metadata that may carry PII or
//      malformed payloads). PNG/GIF/WebP are passed through — they don't have
//      the same metadata exposure surface.
//   6. KV rate limits: 20 uploads / hour and 100 / day per user.
//   7. Lifetime quota: 200 MB and/or 500 images per user. Hits return 429.
//   8. Hash dedupe: SHA-256 the (potentially-stripped) bytes; on collision
//      with a still-live row for the same user, reuse the existing URL.

import { Hono } from 'hono';
import { ulid } from 'ulidx';
import type { AppContext } from '../env';
import { requireAuth } from '../auth/middleware';
import { ApiError, validationFailed, rateLimited } from '../util/errors';
import { logAudit } from '../util/audit';
import { clientIp } from '../util/rateLimit';
import { canWriteToForum } from './util';

export const uploadsRouter = new Hono<AppContext>();

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_BYTES = 5 * 1024 * 1024;           // 5 MB
const MAX_DIMENSION = 4096;                  // px (longest side)
const MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const RATE_HOUR = 20;
const RATE_DAY = 100;
const QUOTA_BYTES = 200 * 1024 * 1024;       // 200 MB
const QUOTA_COUNT = 500;

type ImageType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

// ─── Route ──────────────────────────────────────────────────────────────────

uploadsRouter.post('/image', requireAuth, async (c) => {
  const user = c.var.user!;

  // Forum write gate (display name + ban check).
  const gate = await canWriteToForum(c.env, user.id);
  if (!gate.ok) {
    throw new ApiError(422, 'validation_failed',
      gate.reason === 'banned' ? 'Your forum access is suspended.' : 'Set a display name before uploading.',
      { reason: gate.reason });
  }

  // Account-age + email-verification gate. Anti-throwaway-account heuristic.
  // `user.status = 'active'` is set when verification completes; anything
  // else (pending_verification, disabled) blocks uploads. Staff bypass the
  // age check so we can test in fresh test accounts.
  const accountRow = await c.env.DB.prepare(
    `SELECT created_at, status FROM user WHERE id = ?`,
  ).bind(user.id).first<{ created_at: number; status: string }>();
  if (!accountRow) throw new ApiError(401, 'unauthenticated', 'Account not found');
  if (accountRow.status !== 'active') {
    throw new ApiError(403, 'forbidden', 'Verify your email before uploading images.');
  }
  if (Date.now() - accountRow.created_at < MIN_ACCOUNT_AGE_MS && !user.staff) {
    throw new ApiError(403, 'forbidden', 'Image uploads open 24 hours after signup. Until then, link to images instead.');
  }

  // Multipart parse. Hono uses the runtime's built-in FormData.
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw validationFailed('Expected multipart/form-data');
  }
  const file = form.get('file');
  // workerd's FormDataEntryValue is `File | string`; the runtime File class
  // isn't on the global type, so duck-type check instead of `instanceof File`.
  if (typeof file === 'string' || !file || typeof (file as Blob).arrayBuffer !== 'function') {
    throw validationFailed('Missing `file` field');
  }
  const blob = file as Blob & { size: number };
  if (blob.size === 0) throw validationFailed('Empty file');
  if (blob.size > MAX_BYTES) {
    throw validationFailed(`Image too large — limit is ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.`);
  }

  // Rate limit (KV). 1-hour and 24-hour buckets.
  await checkUploadRateLimit(c.env, user.id);

  // Quota check before reading bytes — cheap row aggregate.
  const usage = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes
       FROM forum_image WHERE user_id = ? AND deleted_at IS NULL`,
  ).bind(user.id).first<{ n: number; bytes: number }>();
  if ((usage?.n ?? 0) >= QUOTA_COUNT) {
    throw rateLimited('You have reached the lifetime image-upload count limit. Delete older images to free space.');
  }
  if ((usage?.bytes ?? 0) + blob.size > QUOTA_BYTES) {
    throw rateLimited('You have reached the lifetime image-storage limit. Delete older images to free space.');
  }

  // Read full bytes. Workerd has no native image decoder; we work directly
  // on the buffer.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) {
    throw validationFailed(`Image too large — limit is ${Math.floor(MAX_BYTES / 1024 / 1024)} MB.`);
  }

  // Magic-byte sniff. Ignore filename + Content-Type — pure header check.
  const sniff = detectImageType(bytes);
  if (!sniff) {
    throw validationFailed('Unsupported file type. Use JPEG, PNG, GIF, or WebP.');
  }
  const { type, width, height } = sniff;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw validationFailed(`Image dimensions exceed ${MAX_DIMENSION}px — resize before uploading.`);
  }

  // EXIF strip for JPEG (privacy + metadata cleanup). PNG/GIF/WebP are
  // structurally chunk-based and we trust the magic-byte check.
  const cleaned = type === 'image/jpeg' ? stripJpegMetadata(bytes) : bytes;

  // Hash + dedupe. If the same user uploaded the same bytes before and the row
  // is still live, reuse it rather than storing twice.
  const sha = await sha256Hex(cleaned);
  const existing = await c.env.DB.prepare(
    `SELECT id, r2_key, content_type FROM forum_image
       WHERE user_id = ? AND sha256 = ? AND deleted_at IS NULL LIMIT 1`,
  ).bind(user.id, sha).first<{ id: string; r2_key: string; content_type: string }>();
  if (existing) {
    return c.json({
      id: existing.id,
      url: publicUrl(c.env.FEEDS_ORIGIN, existing.r2_key),
      contentType: existing.content_type,
      deduped: true,
    });
  }

  // Store.
  const id = ulid();
  const ext = extFor(type);
  const r2Key = `images/${user.id}/${id}.${ext}`;
  await c.env.FORUM_IMAGES.put(r2Key, cleaned, {
    httpMetadata: {
      contentType: type,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      userId: user.id,
      uploadedAt: String(Date.now()),
    },
  });

  await c.env.DB.prepare(
    `INSERT INTO forum_image (id, user_id, r2_key, content_type, bytes, width, height, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, user.id, r2Key, type, cleaned.byteLength, width, height, sha, Date.now()).run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'forum_image',
    subjectId: id,
    action: 'forum.image.upload',
    metadata: { contentType: type, bytes: cleaned.byteLength, width, height },
    ip: clientIp(c.req.raw),
  });

  return c.json({
    id,
    url: publicUrl(c.env.FEEDS_ORIGIN, r2Key),
    contentType: type,
    width,
    height,
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function publicUrl(feedsOrigin: string, r2Key: string): string {
  // The serving path lives on FEEDS_ORIGIN; see worker/publication/feeds.ts.
  return `${feedsOrigin}/_forum-images/${r2Key}`;
}

function extFor(type: ImageType): string {
  switch (type) {
    case 'image/jpeg': return 'jpg';
    case 'image/png':  return 'png';
    case 'image/gif':  return 'gif';
    case 'image/webp': return 'webp';
  }
}

async function checkUploadRateLimit(env: AppContext['Bindings'], userId: string): Promise<void> {
  const hourKey = `forum:img:hour:${userId}`;
  const dayKey  = `forum:img:day:${userId}`;
  const hour = parseInt((await env.KV.get(hourKey)) ?? '0', 10);
  const day  = parseInt((await env.KV.get(dayKey))  ?? '0', 10);
  if (hour >= RATE_HOUR || day >= RATE_DAY) {
    throw rateLimited(`You are uploading too quickly — try again later.`);
  }
  await env.KV.put(hourKey, String(hour + 1), { expirationTtl: 3600 });
  await env.KV.put(dayKey,  String(day + 1),  { expirationTtl: 86400 });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
  return s;
}

// ─── Magic-byte sniffing + dimension parsing ────────────────────────────────
//
// Each branch returns the canonical content-type and parsed width/height. We
// only accept formats whose header layout is well-defined enough to parse
// without a decoder library — that keeps the surface tiny and the runtime
// dependency-free.

interface Sniff { type: ImageType; width: number; height: number }

export function detectImageType(b: Uint8Array): Sniff | null {
  if (b.length < 16) return null;

  // JPEG: FF D8 FF ...
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const dim = parseJpegDimensions(b);
    if (!dim) return null;
    return { type: 'image/jpeg', ...dim };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    // IHDR is the first chunk; width at offset 16, height at 20 (big-endian)
    if (b.length < 24) return null;
    const width  = readU32BE(b, 16);
    const height = readU32BE(b, 20);
    return { type: 'image/png', width, height };
  }
  // GIF: 'GIF87a' or 'GIF89a'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    if (b.length < 10) return null;
    const width  = b[6]  | (b[7]  << 8);
    const height = b[8]  | (b[9]  << 8);
    return { type: 'image/gif', width, height };
  }
  // WebP: 'RIFF' .... 'WEBP'
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    const dim = parseWebpDimensions(b);
    if (!dim) return null;
    return { type: 'image/webp', ...dim };
  }
  return null;
}

function readU32BE(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function readU16BE(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1];
}

// Walk JPEG segments to the SOF (Start-of-Frame) marker and read its width/height.
function parseJpegDimensions(b: Uint8Array): { width: number; height: number } | null {
  let i = 2; // skip SOI
  while (i < b.length) {
    // Each marker starts with 0xFF
    if (b[i] !== 0xff) return null;
    // Skip any fill bytes
    while (i < b.length && b[i] === 0xff) i++;
    const marker = b[i];
    i++;
    // SOF0..SOF15 (excluding DHT 0xC4, JPG 0xC8, DAC 0xCC)
    if (
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      // segment length (2 bytes), precision (1), height (2), width (2)
      if (i + 7 > b.length) return null;
      const height = readU16BE(b, i + 3);
      const width  = readU16BE(b, i + 5);
      return { width, height };
    }
    // SOI/EOI/RST have no payload, but we shouldn't see those here mid-stream.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    // Other markers: skip their payload using the 2-byte length field.
    if (i + 2 > b.length) return null;
    const segLen = readU16BE(b, i);
    i += segLen;
  }
  return null;
}

// WebP comes in three flavors: VP8 (lossy), VP8L (lossless), VP8X (extended).
function parseWebpDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (chunk === 'VP8 ') {
    // VP8 lossy: width/height at +26..+30, 14-bit each
    if (b.length < 32) return null;
    const w = (b[26] | (b[27] << 8) | (b[28] << 16)) & 0x3fff;
    const h = ((b[28] >> 6) | (b[29] << 2) | (b[30] << 10)) & 0x3fff;
    return { width: w, height: h };
  }
  if (chunk === 'VP8L') {
    // VP8L: 1-byte signature 0x2F, then 14-bit width-1 and 14-bit height-1 packed LE
    if (b.length < 25) return null;
    if (b[20] !== 0x2f) return null;
    const lo = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    const w = (lo & 0x3fff) + 1;
    const h = ((lo >>> 14) & 0x3fff) + 1;
    return { width: w, height: h };
  }
  if (chunk === 'VP8X') {
    // VP8X: 1 flag byte + 3 reserved + canvas width-1 (24-bit LE) + canvas height-1 (24-bit LE)
    if (b.length < 30) return null;
    const w = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const h = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return { width: w, height: h };
  }
  return null;
}

// Strip JPEG metadata (APPn + COM segments) while preserving DQT/DHT/SOF/SOS/RST.
// Pure structural pass — does not touch image bytes.
export function stripJpegMetadata(b: Uint8Array): Uint8Array {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) {
      // unexpected; bail and return the original
      return b;
    }
    while (i < b.length && b[i] === 0xff) i++;
    const marker = b[i];
    i++;
    // Standalone markers with no payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(0xff, marker);
      // EOI ends the stream.
      if (marker === 0xd9) break;
      continue;
    }
    // SOS — entropy-coded data follows until the next non-RST marker; copy
    // everything from here to the end (the rest of the file is the image).
    if (marker === 0xda) {
      const segLen = readU16BE(b, i);
      out.push(0xff, marker, b[i], b[i + 1]);
      for (let j = i + 2; j < i + segLen; j++) out.push(b[j]);
      // append rest of file verbatim
      for (let j = i + segLen; j < b.length; j++) out.push(b[j]);
      break;
    }
    // Marker with payload.
    if (i + 2 > b.length) return b;
    const segLen = readU16BE(b, i);
    const skip = marker >= 0xe0 && marker <= 0xef; // APP0..APP15
    const isCom = marker === 0xfe;
    if (skip || isCom) {
      i += segLen;
      continue;
    }
    out.push(0xff, marker, b[i], b[i + 1]);
    for (let j = i + 2; j < i + segLen; j++) out.push(b[j]);
    i += segLen;
  }
  return new Uint8Array(out);
}
