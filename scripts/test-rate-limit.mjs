// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Rate limit on /invite and /wallet-pass: an integration test against a real server (no
 * browser, no EUDIPLO).
 *
 * The limit is set low through the environment. All requests come from the loopback socket, so
 * X-Forwarded-For (last entry) is what tells clients apart.
 *
 * Usage: npm run test:ratelimit
 */
import { spawn } from 'node:child_process';

const PORT = 3961;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

// Start a second server to read /ice under a given environment, then stop it.
async function iceWith(port, extraEnv) {
  const child = spawn('npx', ['tsx', 'src/server.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      EUDI_EDITION: 'community',
      EUDI_VERIFIER: 'none',
      STUN_URLS: '',
      TURN_PUBLIC_FALLBACK: '',
      TURN_URL: '',
      TURN_SECRET: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/ice`);
        if (r.ok) return (await r.json()).iceServers.map((s) => [].concat(s.urls)).flat();
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`/ice not reachable on :${port}`);
  } finally {
    child.kill();
  }
}

const server = spawn('npx', ['tsx', 'src/server.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    EUDI_INVITE_SECRET: 'test-rate-limit-secret-do-not-use-in-production',
    EUDI_EDITION: 'community',
    EUDI_RATE_LIMIT_INVITE: '3',
    EUDI_RATE_LIMIT_WALLET_PASS: '2',
    PUBLIC_URL: BASE,
    EUDIPLO_BASE_URL: 'http://127.0.0.1:1', // deliberately unreachable — must never be needed
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(d.toString()));
server.stderr.on('data', (d) => serverLog.push(d.toString()));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the server did not start:\n${serverLog.join('')}`);
}

const soon = () => ({
  start: new Date(Date.now() + 5 * 60_000).toISOString(),
  end: new Date(Date.now() + 35 * 60_000).toISOString(),
});
function invite(xff) {
  return fetch(`${BASE}/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
    body: JSON.stringify({ mode: 'chat', requestedAttrs: [], disclosedAttrs: [], ...soon() }),
  });
}
const pass = (xff) => fetch(`${BASE}/wallet-pass`, { headers: xff ? { 'x-forwarded-for': xff } : {} });

try {
  await waitForServer();

  console.log('\nStartup warning (OSS-S06)');
  const log = serverLog.join('');
  check('the log warns that /invite is open without EUDI_STAFF_SECRET', /EUDI_STAFF_SECRET is not set: POST \/invite is open/.test(log));

  console.log('\nPOST /invite (limit 3)');
  const rs = [];
  for (let i = 0; i < 3; i++) rs.push(await invite('198.51.100.1'));
  check('requests under the limit pass', rs.every((r) => r.status === 200), rs.map((r) => r.status).join(','));
  const over = await invite('198.51.100.1');
  check('the request over the limit gets 429', over.status === 429, `status=${over.status}`);
  check('429 carries Retry-After', Number(over.headers.get('retry-after')) > 0, over.headers.get('retry-after'));
  check('429 body is { error: "rate limited" }', (await over.json().catch(() => null))?.error === 'rate limited');
  const other = await invite('198.51.100.2');
  check('a different X-Forwarded-For counts as a different client', other.status === 200, `status=${other.status}`);
  const spoof = await invite('203.0.113.9, 198.51.100.1');
  check('only the LAST X-Forwarded-For entry counts (prefix spoofing does not help)', spoof.status === 429, `status=${spoof.status}`);
  const pre = await fetch(`${BASE}/invite`, { method: 'OPTIONS', headers: { 'x-forwarded-for': '198.51.100.1' } });
  check('the CORS preflight is not limited', pre.status === 204, `status=${pre.status}`);

  console.log('\nGET /wallet-pass (limit 2)');
  const p1 = await pass('198.51.100.1');
  const p2 = await pass('198.51.100.1');
  check('requests under the limit are not 429', p1.status !== 429 && p2.status !== 429, `${p1.status},${p2.status}`);
  const p3 = await pass('198.51.100.1');
  check('the request over the limit gets 429 with Retry-After',
    p3.status === 429 && Number(p3.headers.get('retry-after')) > 0, `status=${p3.status}`);
  const p4 = await pass('198.51.100.2');
  check('a different client is not limited', p4.status !== 429, `status=${p4.status}`);

  console.log('\n/ice: STUN_URLS and TURN_PUBLIC_FALLBACK (OSS-S07, OSS-S08)');
  const isStun = (u) => u.startsWith('stun:');
  const isRelay = (u) => u.includes('openrelay.metered.ca');
  const def = await iceWith(3962, {});
  check('default: Google and Cloudflare STUN', def.includes('stun:stun.l.google.com:19302') && def.includes('stun:stun.cloudflare.com:3478'), def.join(' '));
  check('default: public relay present', def.some(isRelay));
  const own = await iceWith(3963, { STUN_URLS: 'stun:stun.example.org:3478' });
  check('STUN_URLS=<url>: only that STUN entry', own.filter(isStun).join() === 'stun:stun.example.org:3478', own.join(' '));
  const none = await iceWith(3964, { STUN_URLS: 'none' });
  check('STUN_URLS=none: no STUN entry', !none.some(isStun), none.join(' '));
  const off = await iceWith(3965, { TURN_PUBLIC_FALLBACK: 'off' });
  check('TURN_PUBLIC_FALLBACK=off: no public relay', !off.some(isRelay) && off.some(isStun), off.join(' '));
} catch (e) {
  failures++;
  console.log(`  ✗ ${e.message}`);
} finally {
  server.kill();
}

if (failures) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
