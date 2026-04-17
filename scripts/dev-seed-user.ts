#!/usr/bin/env node
// Seeds a pre-verified user directly into the local D1 for dev.
// Usage: npx tsx scripts/dev-seed-user.ts <email> <displayName> <password>
// Example: npx tsx scripts/dev-seed-user.ts me@test.com "Me" hunter2hunter2

import { execSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { ulid } from 'ulidx';

const [, , email, displayName, password] = process.argv;
if (!email || !displayName || !password) {
  console.error('Usage: tsx scripts/dev-seed-user.ts <email> <displayName> <password>');
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

console.error(`Seeding user ${normEmail} (id=${userId}) into local D1…`);
execSync(`npx wrangler d1 execute gtfs-builder --local --command=${JSON.stringify(sql)}`, {
  stdio: 'inherit',
});
console.error(`\nDone. Sign in at http://127.0.0.1:5173/login with:`);
console.error(`  email:    ${normEmail}`);
console.error(`  password: ${password}`);
