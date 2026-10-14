#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Issue a staff link for a tenant instance.
 *
 * Usage:
 *   EUDI_STAFF_SECRET=… node scripts/mint-staff-link.mjs \
 *     --base https://musterstadt.whosit.eu --label "buergerservice-schalter-3" [--days 365]
 *
 * The finished link goes to the clipboard and NOWHERE ELSE. It is a bearer token: whoever holds
 * it can issue appointments on the authority's behalf. Printed to the terminal it would end up in
 * shell history, in logs and in screenshots.
 */
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const SECRET = (process.env.EUDI_STAFF_SECRET || '').trim();
const base = (arg('base') || '').replace(/\/+$/, '');
const label = (arg('label') || '').trim();
const days = Number(arg('days') || 365);

if (!SECRET) { console.error('EUDI_STAFF_SECRET is missing — the same secret as on the instance.'); process.exit(1); }
if (!base || !label) { console.error('need --base <https://…> --label "<label>"'); process.exit(1); }
if (!Number.isFinite(days) || days < 1 || days > 3650) { console.error('--days must be between 1 and 3650'); process.exit(1); }

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const iat = Math.floor(Date.now() / 1000);
const exp = iat + days * 86400;
const body = b64url(JSON.stringify({ v: 1, label, iat, exp }));
const token = `${body}.${b64url(createHmac('sha256', SECRET).update(body).digest())}`;
const link = `${base}/?staff=${encodeURIComponent(token)}`;

try {
  execSync('pbcopy', { input: link });
} catch {
  console.error('Clipboard unavailable (pbcopy). Aborting — the link is deliberately not printed.');
  process.exit(1);
}

const until = new Date(exp * 1000).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
console.log('Staff link copied to the clipboard.');
console.log(`  Label      : ${label}`);
console.log(`  Instance   : ${base}`);
console.log(`  Valid till : ${until}`);
console.log(`  Length     : ${link.length} characters`);
console.log('');
console.log('This link is a BEARER token: whoever holds it can issue appointments on the');
console.log("authority's behalf. Pass it on over a confidential channel, not by plain email.");
console.log('To revoke: change EUDI_STAFF_SECRET on the instance — that invalidates ALL issued');
console.log('staff links, but not the appointment invitations.');
