// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The call gate is the server's, not only the page's.
 *
 * "Connect only once everyone has presented and agreed" used to be enforced by the client alone:
 * the server relayed offer/answer/ice to any member of the room. A client of one's own making —
 * not our page — could send an offer before the review, and a page that answered would hand out
 * its network addresses, or worse, a connection. Now the server relays signaling only between a
 * pair it has itself told to connect ("ready"), and only while both are still verified and
 * confirmed. Against the real server as in production (EUDI_VERIFIER=none: everyone counts as
 * verified-anonymous, so only the consent step is in the way):
 *
 *   - before anyone confirmed: an offer and an ICE candidate from the guest do not arrive;
 *   - with only the host confirmed: still nothing;
 *   - after both confirmed and "ready": offer, answer and ICE pass, in both directions;
 *   - after the guest withdraws consent (decline): nothing passes any more.
 *
 * Usage: npm run test:signaling-gate
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const PORT = 3988;
let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function socket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { 'x-forwarded-proto': 'http' } });
    const seen = [];
    const c = {
      ws, seen,
      send: (o) => ws.send(JSON.stringify(o)),
      wait(type, pred = () => true, ms = 8000) {
        const hit = [...seen].reverse().find((m) => m.type === type && pred(m));
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const t = setTimeout(() => { ws.off('message', on); rej(new Error(`timed out waiting for: ${type}`)); }, ms);
          const on = (raw) => {
            let m; try { m = JSON.parse(raw.toString()); } catch { return; }
            if (m.type === type && pred(m)) { clearTimeout(t); ws.off('message', on); res(m); }
          };
          ws.on('message', on);
        });
      },
      count: (type) => seen.filter((m) => m.type === type).length,
    };
    ws.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

const log = [];
const app = spawn('npx', ['tsx', 'src/server.ts'], {
  detached: true,
  env: {
    ...process.env,
    NODE_ENV: 'production', PORT: String(PORT), EUDI_VERIFIER: 'none',
    // Empty, not deleted: a deleted variable would be filled from a local .env by dotenv.
    EUDIPLO_BASE_URL: '', EUDIPLO_CLIENT_ID: '', EUDIPLO_CLIENT_SECRET: '',
    EUDIPLO_ROOT_ID: '', EUDIPLO_ROOT_SECRET: '', PUBLIC_URL: '',
    EUDI_HOST_ALLOWLIST: '', EUDI_HOST_FILE: '', EUDI_PRO_MODULE: '', EUDI_PROMO_ALL_PRO: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (d) => log.push(d.toString()));
app.stderr.on('data', (d) => log.push(d.toString()));

const clients = [];
const sdp = (kind) => ({ type: kind, sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' });
const cand = { candidate: 'candidate:1 1 udp 2122260223 192.0.2.10 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 };
try {
  for (let t0 = Date.now(); ; ) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
    if (app.exitCode !== null || Date.now() - t0 > 25000) throw new Error(`server did not start\n${log.join('')}`);
    await sleep(250);
  }
  const room = randomUUID();
  const host = await socket(); clients.push(host);
  host.send({ type: 'join', roomId: room, clientId: randomUUID() });
  const hs = await host.wait('status', (m) => m.self?.verified === true);
  const guest = await socket(); clients.push(guest);
  guest.send({ type: 'join', roomId: room, clientId: randomUUID() });
  const gs = await guest.wait('status', (m) => m.self?.verified === true && m.peers?.length === 1);
  const hostId = hs.self.peerId, guestId = gs.self.peerId;

  console.log('\nBefore anyone agreed, nothing passes');
  guest.send({ type: 'offer', to: hostId, data: sdp('offer') });
  guest.send({ type: 'ice', to: hostId, data: cand });
  guest.send({ type: 'offer', data: sdp('offer') }); // the 1:1 form without `to`
  await sleep(500);
  check('no offer reaches the host', host.count('offer') === 0, JSON.stringify(host.seen.filter((m) => m.type === 'offer')));
  check('no ICE candidate (no address) reaches the host', host.count('ice') === 0);

  console.log('\nWith only the host agreed, still nothing');
  host.send({ type: 'confirm' });
  await host.wait('status', (m) => m.self?.confirmed === true);
  guest.send({ type: 'offer', to: hostId, data: sdp('offer') });
  host.send({ type: 'ice', to: guestId, data: cand });
  await sleep(500);
  check('no offer from the guest who has not agreed', host.count('offer') === 0);
  check('nor anything from the host to that guest', guest.count('ice') === 0);

  console.log('\nBoth agreed, "ready": it passes, both ways');
  guest.send({ type: 'confirm' });
  await Promise.all([host.wait('ready'), guest.wait('ready')]);
  guest.send({ type: 'offer', to: hostId, data: sdp('offer') });
  const offer = await host.wait('offer').catch(() => null);
  check('the offer arrives, from the guest', offer?.from === guestId, JSON.stringify(offer));
  host.send({ type: 'answer', to: guestId, data: sdp('answer') });
  host.send({ type: 'ice', to: guestId, data: cand });
  check('the answer arrives', !!(await guest.wait('answer').catch(() => null)));
  check('ICE arrives', !!(await guest.wait('ice').catch(() => null)));

  console.log('\nConsent withdrawn: nothing passes any more');
  const before = host.count('offer');
  guest.send({ type: 'decline' });
  await sleep(300);
  guest.send({ type: 'offer', to: hostId, data: sdp('offer') });
  await sleep(500);
  check('no further offer from the guest', host.count('offer') === before, `${host.count('offer')} vs ${before}`);
} catch (e) {
  check('test aborted', false, `${e.message}\n${log.join('').slice(-800)}`);
} finally {
  for (const c of clients) try { c.ws.terminate(); } catch {}
  try { process.kill(-app.pid, 'SIGTERM'); } catch {}
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nall checks passed');
process.exit(failures ? 1 : 0);
