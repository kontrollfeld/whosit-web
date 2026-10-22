// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The verification callback — the only place where an outsider calls into the room.
 *
 * `POST /webhook/:sessionId?t=<token>` is the crossing from outside to inside: EUDIPLO uses it to
 * report that a wallet presentation succeeded. Whoever can forge or repeat that call decides who
 * counts as verified.
 *
 * Four directions of failure, all checked here:
 *   - NO PROTECTION: a call that only knows the sessionId would get through.
 *   - EMPTY TOKEN: `?t=` against an empty stored value would be valid in a naive implementation,
 *     because two empty buffers are equal in length and content.
 *   - REPLAY: if sessionId AND token stayed valid after a successful check, an intercepted
 *     callback could be replayed any number of times — each time adding a fresh entry to the
 *     verification record. A record showing more events than
 *     actually happened is worthless as evidence.
 *   - MIX-UP: one participant's token must not work for another.
 *
 * The token is never disclosed to the client — it lives only in the webhook URL the server hands
 * to the verifier. The mock verifier here records exactly that URL; that is the only way to
 * reproduce the real case at all (same pattern as in test-host-login.mjs).
 *
 * Usage: npm run test:webhook
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const VERIFIER_PORT = 3976;
const APP_PORT = 3977;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- Verifier ----
/** offerId -> the full webhook URL (including ?t=…) exactly as the server handed it out. */
const offers = new Map();
/** Offer bodies EUDIPLO 9.1 would refuse — must stay empty. */
const offerRejections = [];
const OFFER_FIELDS = ['response_type', 'requestId', 'webhook', 'redirectUri', 'expected_origin', 'transaction_data', 'skewSeconds'];
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

const verifier = http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://127.0.0.1:${VERIFIER_PORT}`).pathname;
  if (req.method === 'POST' && p === '/api/oauth2/token') return json(res, 200, { access_token: 'test-token' });
  if (req.method === 'POST' && /^\/api\/client\/[^/]+\/rotate-secret$/.test(p)) return json(res, 200, { secret: 'test-secret' });
  if (req.method === 'POST' && p === '/api/verifier/config') return json(res, 200, { ok: true });
  if (req.method === 'POST' && p === '/api/verifier/offer') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!body?.webhook?.url) return json(res, 400, { error: 'missing webhook.url' });
    // EUDIPLO 7+ validates the offer strictly: an unknown field is a 400, not silently dropped.
    const unknown = Object.keys(body).filter((k) => !OFFER_FIELDS.includes(k));
    if (unknown.length) { offerRejections.push(unknown); return json(res, 400, { error: `unrecognized keys: ${unknown.join(',')}` }); }
    const id = randomUUID();
    offers.set(id, body.webhook.url);
    const uri = `http://127.0.0.1:${VERIFIER_PORT}/simulate/${id}`;
    return json(res, 200, { uri, crossDeviceUri: uri });
  }
  return json(res, 404, { error: 'not found' });
});

/** Send a successful presentation callback to a (possibly tampered-with) URL. */
async function callback(url, values = { family_name: 'Mustermann', given_name: 'Erika' }) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'completed', credentials: [{ values: [values] }] }),
  });
  return r.status;
}

/** Send a raw callback body (EUDIPLO 9 also calls for failed, declined and cancelled presentations). */
async function rawCallback(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.status;
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

/** A guest joins, asks to be verified, and we capture their webhook URL. */
const usedRoomIds = [];
async function newGuestWithWebhookUrl(roomId) {
  usedRoomIds.push(roomId);
  const before = new Set(offers.keys());
  const guest = participant(APP_PORT, { roomId, clientId: randomUUID(), wantAuth: true });
  const auth = await guest.wait('auth');
  const offerId = String(auth.uri).split('/').pop();
  if (!offers.has(offerId) || before.has(offerId)) throw new Error(`no new offer: ${auth.uri}`);
  return { guest, url: offers.get(offerId) };
}

const clients = [];
try {
  await new Promise((r) => verifier.listen(VERIFIER_PORT, r));
  startApp();
  await waitForApp();

  // ---------------------------------------------------------------------------
  console.log('\nRejection without a valid token');
  {
    const roomId = randomUUID();
    const { guest, url } = await newGuestWithWebhookUrl(roomId);
    clients.push(guest);
    const u = new URL(url);
    const goodToken = u.searchParams.get('t');
    check('the server set a token at all', !!goodToken && goodToken.length > 20, String(goodToken));

    const noToken = new URL(url); noToken.searchParams.delete('t');
    check('no token -> 401', (await callback(noToken.toString())) === 401, 'a call that only knows the sessionId would get through');

    const emptyToken = new URL(url); emptyToken.searchParams.set('t', '');
    check('empty token -> 401', (await callback(emptyToken.toString())) === 401, 'two empty buffers are equal in length and content');

    const wrongSameLength = new URL(url);
    wrongSameLength.searchParams.set('t', 'x'.repeat(goodToken.length));
    check('wrong token of the same length -> 401', (await callback(wrongSameLength.toString())) === 401);

    const wrongShort = new URL(url); wrongShort.searchParams.set('t', 'short');
    check('wrong token of a different length -> 401', (await callback(wrongShort.toString())) === 401);

    check('the guest still counts as unverified',
      !guest.find('status', (m) => m.self?.verified === true),
      'a rejected callback took effect anyway');
  }

  // ---------------------------------------------------------------------------
  console.log('\nUnknown session');
  {
    const bogus = `http://127.0.0.1:${APP_PORT}/webhook/${randomUUID()}?t=${randomUUID()}`;
    check('unknown sessionId -> 404', (await callback(bogus)) === 404);
  }

  // ---------------------------------------------------------------------------
  console.log('\nThe legitimate callback works — exactly once (replay protection)');
  {
    const roomId = randomUUID();
    const { guest, url } = await newGuestWithWebhookUrl(roomId);
    clients.push(guest);

    check('first callback -> 200', (await callback(url)) === 200);
    const st = await guest.wait('status', (m) => m.self?.verified === true);
    check('the guest now counts as verified', st?.self?.verified === true);

    const second = await callback(url);
    check('second callback with the same token -> 401', second === 401,
      `got ${second} — the callback is repeatable, which makes the verification record unreliable`);
    const third = await callback(url, { family_name: 'Other', given_name: 'Person' });
    check('also 401 with different claims', third === 401, `got ${third}`);
  }

  // ---------------------------------------------------------------------------
  console.log('\nTokens are bound to their participant');
  {
    const { guest: g1, url: u1 } = await newGuestWithWebhookUrl(randomUUID());
    const { guest: g2, url: u2 } = await newGuestWithWebhookUrl(randomUUID());
    clients.push(g1, g2);
    const t2 = new URL(u2).searchParams.get('t');
    const crossed = new URL(u1); crossed.searchParams.set('t', t2);
    check("the other participant's token -> 401", (await callback(crossed.toString())) === 401);
  }

  // ---------------------------------------------------------------------------
  console.log('\nEUDIPLO 9 failure callbacks (declined, failed, cancelled)');
  for (const [name, body] of [
    ['declined (status failed, outcome.error access_denied)',
      { status: 'failed', session: randomUUID(), outcome: { result: 'failed', error: 'access_denied', message: 'declined' } }],
    ['failed with credential details, no credentials key',
      { status: 'failed', session: randomUUID(), outcome: { result: 'failed', error: 'trust_chain_not_trusted', credentials: [{ id: 'pid', format: 'dc+sd-jwt', verified: false, error: 'trust_chain_not_trusted' }] } }],
    ['cancelled by an operator', { status: 'cancelled', session: randomUUID(), reason: 'operator' }],
    ['failed without any recognisable code', { status: 'failed', session: randomUUID(), detail: { family_name: 'Mustermann' } }],
    ['outcome not success, even with a completed status', { status: 'completed', outcome: { result: 'failed', error: 'claim_value_mismatch' }, credentials: [{ values: [{ family_name: 'Mustermann', given_name: 'Erika' }] }] }],
  ]) {
    const { guest, url } = await newGuestWithWebhookUrl(randomUUID());
    clients.push(guest);
    const firstOffer = guest.find('auth')?.uri;
    check(`${name} -> 200`, (await rawCallback(url, body)) === 200);
    await guest.wait('auth-failed').then(() => check(`${name}: guest told auth-failed`, true), (e) => check(`${name}: guest told auth-failed`, false, e.message));
    await guest.wait('auth', (m) => m.uri !== firstOffer).then(
      () => check(`${name}: a fresh offer replaces the used one`, true),
      (e) => check(`${name}: a fresh offer replaces the used one`, false, e.message));
    check(`${name}: guest stays unverified`, !guest.find('status', (m) => m.self?.verified === true), 'a failure callback verified the guest');
  }
  check('the failure code reaches the log', /verification failed \(access_denied\)/.test(appLog.join('')), 'no "(access_denied)" in the log');
  check('an unknown failure shape is logged by field names', /verification failed \(code unknown: status=failed keys=\[status,session,detail\]\)/.test(appLog.join('')), 'no "code unknown" line with the field names');

  // ---------------------------------------------------------------------------
  console.log('\nThe log reveals no identity data');
  {
    const joined = appLog.join('');
    check('no family name in the server log', !/Mustermann/.test(joined), 'a PID value in the log');
    check('no given name in the server log', !/Erika/.test(joined), 'a PID value in the log');
    // The token is a credential; it must not be logged even when the call is rejected.
    check('no webhook token in the server log', !/[?&]t=[A-Za-z0-9-]{8,}/.test(joined), 'a token in the log');
    check('sessionId not in clear text', !/session=[0-9a-f]{8}-[0-9a-f]{4}/.test(joined), 'a sessionId in the log');
    // Room ids are secrets (see src/channel-binding.ts): only their audit hash may be logged.
    check('room ids not in clear text', usedRoomIds.length > 0 && usedRoomIds.every((id) => !joined.includes(id)), 'a room id in the log');
  }

  // ---------------------------------------------------------------------------
  console.log('\nEvery offer passes EUDIPLO 8 schema validation');
  check('no offer carried a field EUDIPLO rejects', offerRejections.length === 0, JSON.stringify(offerRejections));
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
