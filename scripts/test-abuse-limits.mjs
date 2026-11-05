// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Brakes against bulk use from one address (2026-11-05, audit #3 and #4).
 *
 * Every new room creates a session at the verifier, every /ice answer is TURN relay for a few
 * hours. Without limits one script could fill the verifier with sessions or use the relay for
 * traffic of its own. Against the real server, limits set low through the environment, all
 * clients told apart by X-Forwarded-For from the loopback socket (as behind the proxy):
 *
 *   - more open connections from one address than allowed: the next one is closed (1013);
 *     another address is not affected;
 *   - more new rooms from one address than allowed: refused with a reason; joining a room that
 *     exists is not a new room;
 *   - /ice is rate limited, and its credentials last 6 hours, not a day.
 *
 * Usage: npm run test:abuse-limits
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const PORT = 3984;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(ip) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { 'x-forwarded-for': ip } });
    const c = { ws, seen: [], closed: null };
    ws.on('message', (raw) => { try { c.seen.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('close', (code) => { c.closed = code; });
    ws.on('open', () => resolve(c));
    ws.on('error', () => resolve(c));
  });
}

const log = [];
const app = spawn('npx', ['tsx', 'src/server.ts'], {
  detached: true,
  env: {
    ...process.env,
    NODE_ENV: 'production', PORT: String(PORT), EUDI_VERIFIER: 'none',
    EUDI_WS_PER_IP: '3', EUDI_NEW_ROOMS_PER_IP: '2', EUDI_RATE_LIMIT_ICE: '2', TURN_TTL: '',
    TURN_URL: 'turn:192.0.2.1:3479', TURN_SECRET: 'test-turn-secret-not-real',
    EUDIPLO_BASE_URL: '', EUDIPLO_CLIENT_ID: '', EUDIPLO_CLIENT_SECRET: '',
    EUDIPLO_ROOT_ID: '', EUDIPLO_ROOT_SECRET: '', PUBLIC_URL: '',
    EUDI_HOST_ALLOWLIST: '', EUDI_HOST_FILE: '', EUDI_PRO_MODULE: '', EUDI_PROMO_ALL_PRO: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (d) => log.push(d.toString()));
app.stderr.on('data', (d) => log.push(d.toString()));
const clients = [];
try {
  for (let t0 = Date.now(); ; ) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {}
    if (app.exitCode !== null || Date.now() - t0 > 25000) throw new Error(`server did not start\n${log.join('')}`);
    await sleep(250);
  }

  console.log('\nOpen connections per address');
  for (let i = 0; i < 3; i++) clients.push(await connect('198.51.100.20'));
  const fourth = await connect('198.51.100.20');
  clients.push(fourth);
  await sleep(300);
  check('three are fine', clients.slice(0, 3).every((c) => c.closed === null));
  check('the fourth is closed with 1013', fourth.closed === 1013, String(fourth.closed));
  const elsewhere = await connect('198.51.100.21');
  clients.push(elsewhere);
  await sleep(200);
  check('another address is not affected', elsewhere.closed === null);
  clients[0].ws.close();
  await sleep(300);
  const again = await connect('198.51.100.20');
  clients.push(again);
  await sleep(200);
  check('a closed one frees its place', again.closed === null, String(again.closed));

  console.log('\nNew rooms per address');
  const roomer = await connect('198.51.100.30');
  clients.push(roomer);
  const rooms = [randomUUID(), randomUUID(), randomUUID()];
  for (const r of rooms) { roomer.ws.send(JSON.stringify({ type: 'join', roomId: r, clientId: randomUUID() })); await sleep(250); }
  const refused = roomer.seen.filter((m) => m.type === 'error' && /too many new rooms/.test(m.message));
  check('the third new room is refused, with a reason', refused.length === 1, JSON.stringify(roomer.seen.filter((m) => m.type === 'error')));
  const guest = await connect('198.51.100.30');
  clients.push(guest);
  guest.ws.send(JSON.stringify({ type: 'join', roomId: rooms[0], clientId: randomUUID() }));
  await sleep(300);
  check('joining a room that exists is not a new room', guest.seen.some((m) => m.type === 'joined'), JSON.stringify(guest.seen.map((m) => m.type)));

  console.log('\n/ice');
  const ice = (ip) => fetch(`${BASE}/ice`, { headers: { 'x-forwarded-for': ip } });
  const first = await (await ice('198.51.100.40')).json();
  await ice('198.51.100.40');
  check('the third request from one address gets 429', (await ice('198.51.100.40')).status === 429);
  const turn = first.iceServers.find((s) => [].concat(s.urls).some((u) => u.startsWith('turn:')));
  const expiry = Number(String(turn?.username).split(':')[0]);
  const hours = (expiry - Date.now() / 1000) / 3600;
  check('TURN credentials last 6 hours, not 24', first.ttl === 21600 && hours > 5.9 && hours < 6.1, `ttl=${first.ttl} hours=${hours.toFixed(2)}`);
} catch (e) {
  check('test aborted', false, `${e.message}\n${log.join('').slice(-800)}`);
} finally {
  for (const c of clients) try { c.ws.terminate(); } catch {}
  try { process.kill(-app.pid, 'SIGTERM'); } catch {}
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nall checks passed');
process.exit(failures ? 1 : 0);
