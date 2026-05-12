#!/usr/bin/env node
// Seeds a pre-verified user directly into D1 so you can skip the email
// verification step when testing the editor or billing flows.
//
// Usage:
//   npx tsx scripts/dev-seed-user.ts <email> <displayName> <password>
//   npx tsx scripts/dev-seed-user.ts --env staging --remote <email> <name> <pw>
//
// Local (default): writes into the miniflare-backed D1 used by `wrangler dev`.
// Staging:         writes into the remote staging D1; useful for repeated
//                  end-to-end billing tests where you don't want to keep
//                  signing up + clicking verify links.
//
// The script always sets status='active' so the user can sign in immediately.

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { ulid } from 'ulidx';

interface Args {
  env: string | null;
  remote: boolean;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { env: null, remote: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') {
      out.env = argv[++i] ?? null;
    } else if (a?.startsWith('--env=')) {
      out.env = a.slice('--env='.length);
    } else if (a === '--remote') {
      out.remote = true;
    } else if (a) {
      out.positional.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const [email, displayName, password] = args.positional;
if (!email || !displayName || !password) {
  console.error('Usage: tsx scripts/dev-seed-user.ts [--env staging --remote] <email> <displayName> <password>');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Password must be at least 10 characters');
  process.exit(1);
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    s += BASE64URL[b0 >> 2];
    s += BASE64URL[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) break;
    s += BASE64URL[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) break;
    s += BASE64URL[b2 & 0x3f];
  }
  return s;
}

async function hashPassword(pw: string): Promise<string> {
  const iter = 600_000;
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pw),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2$${iter}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
}

const normEmail = email.trim().toLowerCase();
const userId = ulid();
const credId = ulid();
const now = Date.now();
const hash = await hashPassword(password);

const sql = `
INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at)
VALUES ('${userId}', '${normEmail}', '${displayName.replace(/'/g, "''")}', 'active', 0, ${now}, ${now});
INSERT INTO credential (id, user_id, kind, password_hash, created_at, updated_at)
VALUES ('${credId}', '${userId}', 'password', '${hash}', ${now}, ${now});
`.trim();

// Wrangler addresses the staging D1 by binding name when --env is set, but by
// database name when it isn't. Pick whichever matches the requested target.
const dbName = args.env ? 'gtfs-builder-staging' : 'gtfs-builder';
const flags: string[] = [];
flags.push(args.remote ? '--remote' : '--local');
if (args.env) flags.push(`--env ${args.env}`);

const target = args.remote ? `remote (env=${args.env ?? 'prod'})` : 'local';
console.error(`Seeding user ${normEmail} (id=${userId}) into ${target} D1…`);

// Multi-statement SQL doesn't round-trip cleanly through --command on remote
// D1 (newlines get mangled in shell quoting). Write to a temp .sql file and
// pass via --file instead — same path the migrations runner uses.
const tmpFile = join(tmpdir(), `seed-user-${userId}.sql`);
writeFileSync(tmpFile, sql, 'utf8');
try {
  const cmd = `npx wrangler d1 execute ${dbName} ${flags.join(' ')} --file=${tmpFile}`;
  execSync(cmd, { stdio: 'inherit' });
} finally {
  try { unlinkSync(tmpFile); } catch { /* ignore */ }
}

const baseUrl = args.env === 'staging'
  ? 'https://staging.gtfsbuilder.net'
  : 'http://127.0.0.1:5173';
console.error(`\nDone. Sign in at ${baseUrl}/login with:`);
console.error(`  email:    ${normEmail}`);
console.error(`  password: ${password}`);
