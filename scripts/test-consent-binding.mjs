// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Consent is given to the people one has reviewed — not to whoever is in the room later.
 *
 * Until 2026-11-05 a `confirmed` survived a change of the other side: the host agreed, the guest
 * left before agreeing, someone else took the seat and agreed — and the host's values went to a
 * person the host had never seen on the review screen (audit #10). Now, before the call starts
 * (1:1, or a gathered multi-party room before "start"), any change of who is in the room takes
 * back every agreement given so far, and an agreement is only accepted once there is someone to
 * review. Against the real server, 1:1 (multi-party off), everyone verified-anonymous:
 *
 *   - the host alone cannot agree in advance;
 *   - host agrees, guest A leaves before agreeing, guest B joins: the host's agreement is gone,
 *     B's agreement alone does not start the call, nothing about the host reaches B;
 *   - once the host agrees again (having seen B), the call starts.
 *
 * Usage: npm run test:consent-binding
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const PORT = 3987;
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
    NODE_ENV: 'production', PORT: String(PORT), EUDI_VERIFIER: 'none', EUDI_FEATURES_OFF: 'multi-party',
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
const last = (c) => [...c.seen].reverse().find((m) => m.type === 'status');
try {
  for (let t0 = Date.now(); ; ) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
    if (app.exitCode !== null || Date.now() - t0 > 25000) throw new Error(`server did not start\n${log.join('')}`);
    await sleep(250);
  }
  const room = randomUUID();
  const host = await socket(); clients.push(host);
  host.send({ type: 'join', roomId: room, clientId: randomUUID() });
  await host.wait('status', (m) => m.self?.verified === true);

  console.log('\nAlone, the host cannot agree in advance');
  host.send({ type: 'confirm' });
  await sleep(300);
  check('no agreement without anyone to review', last(host)?.self?.confirmed === false, JSON.stringify(last(host)?.self));

  console.log('\nHost agrees to guest A; A leaves before agreeing; B takes the seat');
  const a = await socket(); clients.push(a);
  a.send({ type: 'join', roomId: room, clientId: randomUUID() });
  await a.wait('status', (m) => m.self?.verified === true && m.peers?.length === 1);
  await host.wait('status', (m) => m.peers?.length === 1);
  host.send({ type: 'confirm' });
  await host.wait('status', (m) => m.self?.confirmed === true);
  check('the host has agreed (to A)', true);
  a.send({ type: 'hangup' });
  await sleep(300);
  const b = await socket(); clients.push(b);
  b.send({ type: 'join', roomId: room, clientId: randomUUID() });
  await b.wait('status', (m) => m.self?.verified === true && m.peers?.length === 1);
  await sleep(300);
  check('the host\'s agreement is taken back', last(host)?.self?.confirmed === false, JSON.stringify(last(host)?.self));
  b.send({ type: 'confirm' });
  await sleep(500);
  check('B agreeing alone does not start the call', b.count('ready') === 0 && host.count('ready') === 0);
  check('nothing about the host reaches B', last(b)?.revealed !== true, JSON.stringify(last(b)?.peers));
  check('the host is asked again, now about B', last(host)?.reviewOpen === true && last(host)?.self?.confirmed === false);

  console.log('\nThe host agrees again, having seen B: the call starts');
  host.send({ type: 'confirm' });
  const ready = await Promise.all([host.wait('ready'), b.wait('ready')]).catch(() => null);
  check('both get "ready"', !!ready);
} catch (e) {
  check('test aborted', false, `${e.message}\n${log.join('').slice(-800)}`);
} finally {
  for (const c of clients) try { c.ws.terminate(); } catch {}
  try { process.kill(-app.pid, 'SIGTERM'); } catch {}
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nall checks passed');
process.exit(failures ? 1 : 0);
