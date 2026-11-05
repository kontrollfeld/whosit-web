// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Zero retention at the verifier — the claims must not outlive the call.
 *
 * EUDIPLO keeps the result of a presentation in a session row of its own so that a relying
 * party can poll for it. The app never polls: the result arrives at its webhook, is read into
 * process memory, and from that moment the verifier's copy is the ONLY persisted record of
 * who presented what. Left alone it stays there until a time-based sweep removes it
 * (SESSION_TTL, 24 h by default) — encrypted at rest, on a host that also holds the key.
 *
 * So the server deletes it, immediately, via `DELETE /api/session/:id` (see
 * src/verifier-session.ts). This test holds that promise to account, on all three paths on
 * which a session becomes worthless:
 *
 *   - VERIFIED: the presentation succeeded and was read out of the webhook payload.
 *   - FAILED: the presentation failed; a fresh offer — and a fresh session — follows.
 *   - LEFT: nobody ever presented; the participant hung up with the QR code still open.
 *
 * And one property that matters more than any of them: a verifier that REFUSES the delete
 * must not break the call. The person in front of the camera did nothing wrong, and refusing
 * them would not delete anything either — but the failure has to be loud in the log, because
 * the claims are then still sitting at the verifier.
 *
 * Usage: npm run test:purge
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const VERIFIER_PORT = 3982;
const APP_PORT = 3983;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- Verifier ----
/** offerId (= our session id) -> the webhook URL the server handed out. */
const offers = new Map();
/** Session ids the server asked us to delete, in order. */
const deleted = [];
/** Authorization headers those DELETEs carried — a purge without a token would 401 for real. */
const deleteAuth = [];
/** Flipped mid-test: the verifier starts refusing DELETE, as an under-privileged token would. */
let refuseDelete = false;
/** How many DELETEs to answer with 503 first — a verifier that is briefly away. */
let unavailableDeletes = 0;
/** Delay for the next offer, in ms — the window in which a participant can leave. */
let slowOffer = 0;
/** Session ids of every offer created, in order. */
const created = [];

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

const verifier = http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://127.0.0.1:${VERIFIER_PORT}`).pathname;
  if (req.method === 'POST' && p === '/api/oauth2/token') return json(res, 200, { access_token: 'test-token' });
  if (req.method === 'POST' && p === '/api/verifier/config') return json(res, 200, { ok: true });
  if (req.method === 'POST' && p === '/api/verifier/offer') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!body?.webhook?.url) return json(res, 400, { error: 'missing webhook.url' });
    if (slowOffer) { const ms = slowOffer; slowOffer = 0; await new Promise((r) => setTimeout(r, ms)); }
    const id = randomUUID();
    created.push(id);
    offers.set(id, body.webhook.url);
    const uri = `http://127.0.0.1:${VERIFIER_PORT}/simulate/${id}`;
    // `session` is what EUDIPLO 8 returns alongside the offer — the handle for the delete.
    return json(res, 200, { uri, crossDeviceUri: uri, session: id });
  }
  const sess = p.match(/^\/api\/session\/([0-9a-f-]+)$/i);
  if (sess && req.method === 'DELETE') {
    if (refuseDelete) return json(res, 403, { error: 'insufficient role' });
    if (unavailableDeletes > 0) { unavailableDeletes--; return json(res, 503, { error: 'briefly away' }); }
    deleted.push(sess[1]);
    deleteAuth.push(req.headers.authorization || '');
    res.writeHead(204);
    return res.end();
  }
  return json(res, 404, { error: 'not found' });
});

/** Report a presentation result for `sessionId` to the server, the way EUDIPLO would. */
async function callback(sessionId, body) {
  const url = offers.get(sessionId);
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: sessionId, ...body }),
  });
  return r.status;
}
const presentation = (values = { family_name: 'Mustermann', given_name: 'Erika' }) =>
  ({ status: 'completed', credentials: [{ values: [values] }] });

/** Purging is fire-and-forget — wait for it rather than assuming it already happened. */
async function waitForDelete(sessionId, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (deleted.includes(sessionId)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
async function waitForLog(re, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(appLog.join(''))) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ------------------------------------------------------------------ Client ----
function participant(port, { roomId, clientId, wantAuth }) {
  const seen = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const p = {
    ws, seen,
    send: (o) => ws.send(JSON.stringify(o)),
    find: (type, pred = () => true) => [...seen].reverse().find((m) => m.type === type && pred(m)),
    async wait(type, pred = () => true, ms = 8000) {
      const hit = p.find(type, pred);
      if (hit) return hit;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for: ${type}`)), ms);
        const on = (raw) => {
          let m; try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m.type === type && pred(m)) { clearTimeout(t); ws.off('message', on); resolve(m); }
        };
        ws.on('message', on);
      });
    },
    close: () => { try { ws.close(); } catch {} },
  };
  ws.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
  ws.on('open', () => p.send({ type: 'join', roomId, clientId, wantAuth }));
  return p;
}

/** A guest joins, asks to be verified, and we learn which session their offer belongs to. */
async function newGuest(roomId = randomUUID()) {
  const guest = participant(APP_PORT, { roomId, clientId: randomUUID(), wantAuth: true });
  const auth = await guest.wait('auth');
  const sessionId = String(auth.uri).split('/').pop();
  if (!offers.has(sessionId)) throw new Error(`no offer for ${auth.uri}`);
  return { guest, sessionId };
}

// ------------------------------------------------------------------ Server ----
const appLog = [];
let app;
function startApp() {
  app = spawn('npx', ['tsx', 'src/server.ts'], {
    detached: true,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      PUBLIC_URL: `http://127.0.0.1:${APP_PORT}`,
      EUDI_EDITION: 'community',
      EUDIPLO_BASE_URL: `http://127.0.0.1:${VERIFIER_PORT}`,
      EUDIPLO_CLIENT_ID: 'test-tenant',
      EUDIPLO_CLIENT_SECRET: 'test-tenant-secret',
      EUDI_PROMO_ALL_PRO: '',
      EUDI_PURGE_RETRY_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (d) => appLog.push(d.toString()));
  app.stderr.on('data', (d) => appLog.push(d.toString()));
}
async function waitForApp(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`app unreachable\n${appLog.join('')}`);
}

const clients = [];
try {
  await new Promise((r) => verifier.listen(VERIFIER_PORT, r));
  startApp();
  await waitForApp();

  // ---------------------------------------------------------------------------
  console.log('\nA successful presentation leaves nothing behind');
  {
    const { guest, sessionId } = await newGuest();
    clients.push(guest);
    check('callback accepted', (await callback(sessionId, presentation())) === 200);
    const st = await guest.wait('status', (m) => m.self?.verified === true);
    check('the guest counts as verified', st?.self?.verified === true);
    check('the verifier session was deleted', await waitForDelete(sessionId),
      'the presented claims stay at the verifier until its TTL sweep — the whole point of this test');
    check('the delete was authenticated', /^Bearer \S+/.test(deleteAuth[deleteAuth.length - 1] || ''),
      `Authorization header was "${deleteAuth[deleteAuth.length - 1]}"`);
  }

  // ---------------------------------------------------------------------------
  console.log('\nA failed presentation leaves nothing behind either');
  {
    const { guest, sessionId } = await newGuest();
    clients.push(guest);
    check('callback accepted', (await callback(sessionId, { status: 'failed' })) === 200);
    check('the guest is told', !!(await guest.wait('auth-failed')));
    check('the failed session was deleted', await waitForDelete(sessionId),
      'a failed attempt still discloses which credential was presented');
  }

  // ---------------------------------------------------------------------------
  console.log('\nA session nobody ever used is deleted too');
  {
    const { guest, sessionId } = await newGuest();
    clients.push(guest);
    guest.send({ type: 'hangup' });
    check('the abandoned session was deleted', await waitForDelete(sessionId),
      'an unused session holds no claims, but it is still an open invitation at the verifier');
  }

  // ---------------------------------------------------------------------------
  console.log('\nA verifier that refuses the delete does not break the call');
  {
    refuseDelete = true;
    const { guest, sessionId } = await newGuest();
    clients.push(guest);
    check('callback accepted', (await callback(sessionId, presentation())) === 200);
    const st = await guest.wait('status', (m) => m.self?.verified === true);
    check('the guest is still verified', st?.self?.verified === true,
      'a failed purge must not cost the person their call');
    check('the failure is loud in the log', await waitForLog(/PURGE FAILED/),
      'a silently failed purge is worse than none — nobody would ever look');
    refuseDelete = false;
  }

  // ---------------------------------------------------------------------------
  console.log('\nA verifier that is briefly away gets the delete later (audit #8)');
  {
    unavailableDeletes = 2;
    const { guest, sessionId } = await newGuest();
    clients.push(guest);
    check('callback accepted', (await callback(sessionId, presentation())) === 200);
    check('deleted after two failed tries', await waitForDelete(sessionId, 8000),
      'a single failure used to leave the claims at the verifier until its TTL');
    // Wait for the line rather than read the log at once: the delete is seen by the stand-in
    // verifier a moment before the server's log line about it arrives here.
    check('and the retry is in the log', await waitForLog(/purged \S+ \(verified\) on retry 2/), appLog.join('').slice(-400));
  }

  // ---------------------------------------------------------------------------
  console.log('\nA wallet that answers after the person left: deleted all the same (audit #7)');
  {
    const late = randomUUID();
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/webhook/${randomUUID()}?t=x`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: late, status: 'completed' }),
    });
    check('unknown session answered 404', r.status === 404, String(r.status));
    check('its verifier session is deleted', await waitForDelete(late),
      'the late result would stay at the verifier until its TTL');
    const before = deleted.length;
    await fetch(`http://127.0.0.1:${APP_PORT}/webhook/${randomUUID()}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: 'not-a-uuid' }),
    });
    await new Promise((r) => setTimeout(r, 300));
    check('nothing that is not a session id is passed on', deleted.length === before);
  }

  // ---------------------------------------------------------------------------
  console.log('\nLeaving while the offer is being made: that session is deleted too (audit #9)');
  {
    slowOffer = 800;
    const n = created.length;
    const guest = participant(APP_PORT, { roomId: randomUUID(), clientId: randomUUID(), wantAuth: true });
    clients.push(guest);
    await new Promise((r) => guest.ws.once('open', r));
    await new Promise((r) => setTimeout(r, 200)); // the offer is under way now
    guest.send({ type: 'hangup' });
    for (let t0 = Date.now(); created.length === n && Date.now() - t0 < 5000; ) await new Promise((r) => setTimeout(r, 50));
    const orphan = created[n];
    check('an offer was made', !!orphan);
    check('and deleted once it existed', !!orphan && await waitForDelete(orphan),
      'stored on someone gone, it would never have been deleted');
  }

  // ---------------------------------------------------------------------------
  console.log('\nA fresh wallet offer at most every 10 s (audit #3)');
  {
    const { guest } = await newGuest();
    clients.push(guest);
    const n = created.length;
    const authsNow = () => guest.seen.filter((m) => m.type === 'auth').length;
    // As the page does it: click, wait for the answer (the button is disabled until then), click again.
    let before = authsNow();
    guest.send({ type: 'renew-auth' });
    for (let t0 = Date.now(); authsNow() === before && Date.now() - t0 < 3000; ) await new Promise((r) => setTimeout(r, 50));
    const renewed = guest.seen.filter((m) => m.type === 'auth').pop();
    before = authsNow();
    guest.send({ type: 'renew-auth' });
    for (let t0 = Date.now(); authsNow() === before && Date.now() - t0 < 3000; ) await new Promise((r) => setTimeout(r, 50));
    const second = guest.seen.filter((m) => m.type === 'auth').pop();
    await new Promise((r) => setTimeout(r, 300));
    check('the first ask makes a new session', created.length === n + 1, `${created.length - n} new`);
    check('the second, seconds later, makes none', created.length === n + 1, `${created.length - n} new`);
    check('but is answered with the offer just made (the page\'s button must not hang)', authsNow() === before + 1 && second?.uri === renewed?.uri, `${second?.uri} vs ${renewed?.uri}`);
  }

  // ---------------------------------------------------------------------------
  console.log('\nThe log discloses nothing');
  {
    const joined = appLog.join('');
    check('no session id in clear text', !new RegExp([...offers.keys()].join('|')).test(joined),
      'a verifier session id is half an access credential');
    check('no identity data', !/Mustermann|Erika/.test(joined), 'a PID value in the log');
  }
} catch (e) {
  console.error(`\n✗ Test setup failed: ${e.message}`);
  failures++;
} finally {
  for (const c of clients) c.close();
  try { if (app) process.kill(-app.pid, 'SIGTERM'); } catch {}
  verifier.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
