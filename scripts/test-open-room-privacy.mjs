// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reciprocity in an open room: nobody receives values before they have agreed themselves.
 *
 * The review screen makes a promise — "the contents only become visible once both agree" — and
 * an open multi-party room once broke it. `broadcastStatus` gated the values on the SUBJECT
 * alone:
 *
 *   const showValues = (x) => revealed && (!openRoom || (x.verified && x.confirmed));
 *
 * `revealed` turns true in an open room as soon as TWO participants have confirmed. From that
 * moment every participant received the names and claims of the confirmed ones — including
 * someone who had only just joined and had not consented to anything: in a three-party call the
 * third person saw the others' names on their own review screen.
 *
 * The visible part was the name in the block heading. The worse part was invisible: the whole
 * `claims` object travelled in the status payload, so anyone with developer tools could read
 * every attribute without ever agreeing to the exchange.
 *
 * This test drives the real protocol over WebSockets against a real server (same harness as
 * test-webhook.mjs / test-invite.mjs) and checks both directions, because a gate that leaks
 * nothing at all would also pass a one-sided test:
 *
 *   - an unconfirmed joiner gets NO name, claims or credentials …
 *   - … while presence metadata (role, verified, confirmed) still flows, since the UI needs it
 *   - the confirmed participants likewise see nothing of the unconfirmed joiner
 *   - after the joiner confirms, the values DO arrive — otherwise this test would be vacuous
 *
 * Usage: npm run test:openroom
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const VERIFIER_PORT = 3986;
const APP_PORT = 3987;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------- Verifier ----
/** offerId -> the full webhook URL (including ?t=…) exactly as the server handed it out. */
const offers = new Map();
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
    const id = randomUUID();
    offers.set(id, body.webhook.url);
    const uri = `http://127.0.0.1:${VERIFIER_PORT}/simulate/${id}`;
    return json(res, 200, { uri, crossDeviceUri: uri });
  }
  return json(res, 404, { error: 'not found' });
});

/** The wallet presented successfully: report it the way EUDIPLO would. */
async function present(url, values) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'completed', credentials: [{ values: [values] }] }),
  });
  if (r.status !== 200) throw new Error(`webhook rejected: HTTP ${r.status}`);
}

// ------------------------------------------------------------------ Client ----
function participant(port, { roomId, clientId, wantAuth }) {
  const seen = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const p = {
    ws, seen,
    send: (o) => ws.send(JSON.stringify(o)),
    /** Latest message of a type — status arrives repeatedly, and only the last one is current. */
    last: (type, pred = () => true) => [...seen].reverse().find((m) => m.type === type && pred(m)),
    async wait(type, pred = () => true, ms = 10000) {
      const hit = p.last(type, pred);
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

/** Join, take the offer that appears, and hand back the webhook URL belonging to it. */
async function joinAndGetWebhook(roomId) {
  const before = new Set(offers.keys());
  const who = participant(APP_PORT, { roomId, clientId: randomUUID(), wantAuth: true });
  const auth = await who.wait('auth');
  const offerId = String(auth.uri).split('/').pop();
  if (!offers.has(offerId) || before.has(offerId)) throw new Error(`no fresh offer: ${auth.uri}`);
  return { who, url: offers.get(offerId) };
}

/** Wait until this participant's own status reports the given condition. */
const untilStatus = (who, pred) => who.wait('status', pred);

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
      // Open rooms need the multi-party capability, which is in Community, so the plain
      // default edition is exactly the case this test has to cover.
      EUDI_EDITION: 'community',
      EUDIPLO_BASE_URL: `http://127.0.0.1:${VERIFIER_PORT}`,
      EUDIPLO_CLIENT_ID: 'test-tenant',
      EUDIPLO_CLIENT_SECRET: 'test-tenant-secret',
      EUDI_PROMO_ALL_PRO: '',
      EUDI_PRO_MODULE: '',
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

  const roomId = randomUUID();
  const ATTRS = ['given_name', 'family_name'];

  // --- host opens an OPEN room and verifies -----------------------------------------------
  const hostClientId = randomUUID();
  const host = participant(APP_PORT, { roomId, clientId: hostClientId, wantAuth: false });
  clients.push(host);
  await host.wait('status');
  const offersBeforeHost = new Set(offers.keys());
  host.send({ type: 'set-config', mode: 'chat', requestedAttrs: ATTRS, disclosedAttrs: ATTRS, openRoom: true });
  const hostAuth = await host.wait('auth');
  const hostOfferId = String(hostAuth.uri).split('/').pop();
  if (offersBeforeHost.has(hostOfferId)) throw new Error('host offer was not re-issued after set-config');
  await present(offers.get(hostOfferId), { given_name: 'Hanna', family_name: 'Hostmann' });
  await untilStatus(host, (m) => m.self.verified === true);
  check('the room is an open multi-party room', host.last('status').openRoom === true, 'openRoom not set — is multi-party off?');

  // --- guest 1 verifies, both confirm → values are revealed among them ---------------------
  const { who: guest1, url: guest1Url } = await joinAndGetWebhook(roomId);
  clients.push(guest1);
  await present(guest1Url, { given_name: 'Gustav', family_name: 'Gastmann' });
  await untilStatus(guest1, (m) => m.self.verified === true);
  host.send({ type: 'confirm' });
  guest1.send({ type: 'confirm' });
  await untilStatus(host, (m) => m.revealed === true);
  await untilStatus(guest1, (m) => m.revealed === true);
  check('host and guest 1 see each other after both confirmed',
    !!host.last('status').peers[0].name && !!host.last('status').peers[0].claims,
    'the two confirmed participants see nothing — the test would be meaningless');

  // --- guest 2 joins and verifies, but does NOT confirm ------------------------------------
  const { who: guest2, url: guest2Url } = await joinAndGetWebhook(roomId);
  clients.push(guest2);
  await present(guest2Url, { given_name: 'Erika', family_name: 'Mustermann' });
  await untilStatus(guest2, (m) => m.self.verified === true && m.peers.length >= 2);

  console.log('\nWhat an unconfirmed joiner receives');
  {
    const st = guest2.last('status');
    check('no name of any peer', st.peers.every((p) => p.name === undefined),
      `names leaked: ${JSON.stringify(st.peers.map((p) => p.name))}`);
    check('no claims of any peer', st.peers.every((p) => p.claims === undefined),
      `claims leaked: ${JSON.stringify(st.peers.map((p) => p.claims))}`);
    check('no in-call credentials of any peer', st.peers.every((p) => p.credentials === undefined),
      'credentials leaked');
    check('own values withheld as well', st.self.name === undefined && st.self.claims === undefined,
      'the server echoed the joiner their own values before consent');
    check('presence metadata still flows (the UI needs it)',
      st.peers.length === 2 && st.peers.every((p) => p.verified === true && typeof p.role === 'string'),
      'role/verified missing — the review screen cannot render');
  }

  console.log('\nWhat the confirmed participants see of the unconfirmed joiner');
  {
    const seenByHost = host.last('status').peers.find((p) => p.peerId === guest2.last('status').self.peerId);
    check('guest 2 is visible as present', !!seenByHost, 'guest 2 missing from the host status');
    check('but without name', seenByHost && seenByHost.name === undefined, 'name of an unconfirmed person leaked');
    check('and without claims', seenByHost && seenByHost.claims === undefined, 'claims of an unconfirmed person leaked');
  }

  console.log('\nAfter guest 2 confirms');
  {
    guest2.send({ type: 'confirm' });
    await untilStatus(guest2, (m) => m.peers.every((p) => p.name !== undefined));
    const st = guest2.last('status');
    check('names now arrive', st.peers.every((p) => typeof p.name === 'string' && p.name.length > 0),
      'still no names — the gate is now too tight');
    check('claims now arrive', st.peers.every((p) => p.claims && Object.keys(p.claims).length > 0),
      'still no claims — the gate is now too tight');
    const host2 = await untilStatus(host, (m) => m.peers.length === 2 && m.peers.every((p) => p.name !== undefined));
    check('and the others see guest 2 in turn', host2.peers.every((p) => p.name !== undefined),
      'the host does not see the newly confirmed guest');
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  if (appLog.length) console.error(appLog.join(''));
  failures++;
} finally {
  for (const c of clients) c.close();
  if (app?.pid) { try { process.kill(-app.pid, 'SIGKILL'); } catch {} }
  verifier.close();
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
