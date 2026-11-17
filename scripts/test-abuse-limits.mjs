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
 *   - /ice is rate limited, and its credentials last 6 hours, not a day;
 *   - an IPv6 client counts by its /64, so changing the address inside it does not help;
 *   - above EUDI_MAX_ROOMS open rooms on the instance a new room is refused, from any address,
 *     while joining a room that exists still works.
 *
 * Usage: npm run test:abuse-limits
 */
import { spawn, spawnSync } from 'node:child_process';
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

console.log('\nThe key a client is counted under');
{
  const code = `import { limitKey } from './src/rate-limit';
    process.stdout.write(JSON.stringify(['198.51.100.7', '::ffff:198.51.100.7', '2001:db8:1:2::a', '2001:DB8:1:2:ffff:1:2:3',
      '2001:db8:1:3::a', '2001:db8::1', '::1', 'fe80::1%eth0', '2001:db8:0:0:1::192.0.2.1'].map(limitKey)));`;
  const r = spawnSync('npx', ['tsx', '-e', code], { encoding: 'utf8' });
  let k = [];
  try { k = JSON.parse(r.stdout); } catch { /* reported below */ }
  check('IPv4 stays the address', k[0] === '198.51.100.7', r.stdout || r.stderr);
  check('IPv4-mapped IPv6 is the IPv4 address', k[1] === '198.51.100.7', k[1]);
  check('IPv6 counts by its /64', k[2] === '2001:db8:1:2::/64' && k[3] === '2001:db8:1:2::/64', `${k[2]} ${k[3]}`);
  check('another /64 is another client', k[4] === '2001:db8:1:3::/64', k[4]);
  check('a shortened address is expanded first', k[5] === '2001:db8:0:0::/64', k[5]);
  check('loopback and a zone id', k[6] === '0:0:0:0::/64' && k[7] === 'fe80:0:0:0::/64', `${k[6]} ${k[7]}`);
  check('a trailing IPv4 part does not shift the prefix', k[8] === '2001:db8:0:0::/64', k[8]);
}

const log = [];
const app = spawn('npx', ['tsx', 'src/server.ts'], {
  detached: true,
  env: {
    ...process.env,
    NODE_ENV: 'production', PORT: String(PORT), EUDI_VERIFIER: 'none',
    EUDI_WS_PER_IP: '3', EUDI_NEW_ROOMS_PER_IP: '2', EUDI_MAX_ROOMS: '3', EUDI_RATE_LIMIT_ICE: '2', TURN_TTL: '',
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
  // rooms[1]: one socket holds one seat, so joining rooms[1] gave up rooms[0] (and the empty
  // room went with it). rooms[1] is the room that still exists.
  guest.ws.send(JSON.stringify({ type: 'join', roomId: rooms[1], clientId: randomUUID() }));
  await sleep(300);
  check('joining a room that exists is not a new room', guest.seen.some((m) => m.type === 'joined'), JSON.stringify(guest.seen.map((m) => m.type)));

  console.log('\nIPv6: one /64 is one client');
  const v6 = [];
  for (const a of ['2001:db8:5:5::1', '2001:db8:5:5::2', '2001:db8:5:5::3', '2001:db8:5:5::4']) v6.push(await connect(a));
  clients.push(...v6);
  await sleep(300);
  check('three addresses of one /64 are fine', v6.slice(0, 3).every((c) => c.closed === null));
  check('the fourth address of the same /64 is closed with 1013', v6[3].closed === 1013, String(v6[3].closed));
  const otherNet = await connect('2001:db8:5:6::1');
  clients.push(otherNet);
  await sleep(200);
  check('another /64 is not affected', otherNet.closed === null, String(otherNet.closed));

  console.log('\nOpen rooms on the whole instance (EUDI_MAX_ROOMS=3)');
  // One room is open from the section above (rooms[1], with two seats).
  const openers = [];
  for (const a of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
    const c = await connect(a);
    clients.push(c);
    openers.push(c);
    c.ws.send(JSON.stringify({ type: 'join', roomId: randomUUID(), clientId: randomUUID() }));
    await sleep(250);
  }
  check('rooms two and three open, each from its own address', openers.slice(0, 2).every((c) => c.seen.some((m) => m.type === 'joined')),
    JSON.stringify(openers.map((c) => c.seen.map((m) => m.type))));
  const full = openers[2].seen.find((m) => m.type === 'error');
  check('the fourth room is refused, from an address with no history', /too many open rooms/.test(full?.message || ''), JSON.stringify(openers[2].seen));
  const late = await connect('203.0.113.4');
  clients.push(late);
  late.ws.send(JSON.stringify({ type: 'join', roomId: rooms[1], clientId: randomUUID() }));
  await sleep(300);
  check('joining a room that exists still works', late.seen.some((m) => m.type === 'joined' || m.type === 'room-full'), JSON.stringify(late.seen.map((m) => m.type)));
  check('the log says the cap was reached', log.join('').includes('EUDI_MAX_ROOMS reached'), log.join('').slice(-300));
  // Hanging up ends the seat at once; a dropped connection would keep the room for its grace.
  openers[0].ws.send(JSON.stringify({ type: 'hangup' }));
  await sleep(400);
  const after = await connect('203.0.113.5');
  clients.push(after);
  after.ws.send(JSON.stringify({ type: 'join', roomId: randomUUID(), clientId: randomUUID() }));
  await sleep(300);
  check('a room that closes (hang-up) frees a place', after.seen.some((m) => m.type === 'joined'), JSON.stringify(after.seen));

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
