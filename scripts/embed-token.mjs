// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mint a signed embed token (operator tool). The token binds the allowed ancestor
 * origins AND the requestable PID attributes; the server verifies it (EMBED_SIGNING_SECRET)
 * before allowing the framed widget. See the embed section in src/server.ts.
 *
 * Usage:
 *   EMBED_SIGNING_SECRET=… node scripts/embed-token.mjs \
 *     --origins "https://example.com https://portal.example.org" \
 *     --request family_name,age_over_18 \
 *     [--disclose ""] [--mode video] [--lock] [--ttl-days 365]
 *
 * Prints the token. Hand it to the embedding site to use as embed.js `token` / data-token.
 */
import { createHmac } from 'node:crypto';

const SECRET = (process.env.EMBED_SIGNING_SECRET || '').trim();
if (!SECRET) { console.error('EMBED_SIGNING_SECRET is not set.'); process.exit(1); }

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);
const list = (v) => (v ? String(v).split(/[\s,]+/).filter(Boolean) : []);
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const VALID_ATTRS = new Set(['family_name', 'given_name', 'age_over_18', 'birth_date', 'issuing_country', 'address']);
const VALID_MODES = new Set(['video', 'audio', 'chat']);

const origins = list(arg('origins'));
if (!origins.length) { console.error('Provide --origins "https://customer.example …" (at least one).'); process.exit(1); }
const request = list(arg('request')).filter((a) => VALID_ATTRS.has(a));
const disclose = list(arg('disclose')).filter((a) => VALID_ATTRS.has(a));
const mode = VALID_MODES.has(arg('mode')) ? arg('mode') : 'video';
const ttlDays = Number(arg('ttl-days', '365'));
const exp = Math.floor(Date.now() / 1000) + Math.max(1, ttlDays) * 86400;

const payload = { m: mode, r: request, d: disclose, l: has('lock'), o: origins, e: exp };
const payloadB64 = b64url(JSON.stringify(payload));
const sig = b64url(createHmac('sha256', SECRET).update(payloadB64).digest());
const token = `${payloadB64}.${sig}`;

console.error('payload:', JSON.stringify(payload));
console.error('expires:', new Date(exp * 1000).toISOString());
console.log(token);
