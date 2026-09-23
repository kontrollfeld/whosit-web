// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host sign-in on a tenant instance — end to end.
 *
 * WHY A VERIFIER OF ITS OWN INSTEAD OF deploy/mock-eudiplo: the development mock ALWAYS sends
 * both given and family name, no matter what was asked for. A real wallet presents only what the
 * DCQL asks for. The bug this test guards against lived in exactly that gap: offer creation
 * received the list the client wanted instead of the enforced one, the wallet was asked only for
 * `family_name` (observed in a real wallet's log on 2026-08-15), and the gate rejected its own
 * operator. Against the mock, that would have been green.
 *
 * The verifier here therefore releases only claims that were genuinely requested — and makes the
 * question itself checkable.
 *
 * Usage: npm run test:hostlogin
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const VERIFIER_PORT = 3982;
const GATED_PORT = 3983;
const OPEN_PORT = 3984;
const GATED = `http://127.0.0.1:${GATED_PORT}`;
const OPEN = `http://127.0.0.1:${OPEN_PORT}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------- Verifier ----
/** requestId -> DCQL, so the test can check WHAT was asked for. */
const configs = new Map();
/** offerId → { webhook, requestId } */
const offers = new Map();

const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

const verifier = http.createServer(async (req, res) => {
  const p = new URL(req.url, `http://127.0.0.1:${VERIFIER_PORT}`).pathname;
  if (req.method === 'POST' && p === '/api/oauth2/token') return json(res, 200, { access_token: 'test-token' });
  if (req.method === 'POST' && /^\/api\/client\/[^/]+\/rotate-secret$/.test(p)) return json(res, 200, { secret: 'test-secret' });
  if (req.method === 'POST' && p === '/api/verifier/config') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (body?.id) configs.set(body.id, body.dcql_query);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/verifier/offer') {
    const body = JSON.parse((await readBody(req)) || '{}');
    if (!body?.webhook?.url) return json(res, 400, { error: 'missing webhook.url' });
    const id = randomUUID();
    offers.set(id, { webhook: body.webhook.url, requestId: body.requestId });
    const uri = `http://127.0.0.1:${VERIFIER_PORT}/simulate/${id}`;
    return json(res, 200, { uri, crossDeviceUri: uri });
  }
  return json(res, 404, { error: 'not found' });
});

/** Extract the offer identifier from the wallet URI. */
const offerIdOf = (uri) => String(uri).split('/').pop();

/** Which claims does the DCQL for this offer ask for? The last path element is the field name. */
function requestedClaims(offerId) {
  const dcql = configs.get(offers.get(offerId)?.requestId);
  const out = new Set();
  for (const c of dcql?.credentials ?? []) {
    for (const cl of c.claims ?? []) out.add(String(cl.path[cl.path.length - 1]));
  }
  return out;
}

/**
 * Present like a real wallet: ONLY the requested fields, everything else is withheld.
 * That is precisely what distinguishes this verifier from the development mock.
 */
async function present(offerId, identity) {
  const offer = offers.get(offerId);
  if (!offer) throw new Error(`unknown offer ${offerId}`);
  const wanted = requestedClaims(offerId);
  const values = {};
  for (const [k, v] of Object.entries(identity)) if (wanted.has(k)) values[k] = v;
  const r = await fetch(offer.webhook, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'completed', credentials: [{ values: [values] }] }),
  });
  return { status: r.status, sent: Object.keys(values) };
}

// ------------------------------------------------------------------ Client ----
/**
 * A participant as an object: collects every message and allows targeted waiting.
 * Without that collection a test would miss a message that arrives before the wait begins.
 */
function participant(port, { roomId, clientId, wantAuth }) {
  const seen = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const p = {
    ws, seen,
    send: (o) => ws.send(JSON.stringify(o)),
    /** The last message of a type that satisfies the predicate (retrospectively too). */
    find: (type, pred = () => true) => [...seen].reverse().find((m) => m.type === type && pred(m)),
    async wait(type, pred = () => true, ms = 6000) {
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
    close: () => ws.close(),
  };
  ws.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
  ws.on('open', () => p.send({ type: 'join', roomId, clientId, wantAuth }));
  return p;
}

const room = () => randomUUID(); // satisfies /^[A-Za-z0-9_-]{8,64}$/

// ------------------------------------------------------------------ Server ----
const logs = new Map();

/**
 * Report an occupied port immediately instead of interrogating SOMEONE ELSE'S server.
 *
 * Without this the test ran against servers left over from an earlier round and reported
 * timeouts whose cause was documented nowhere — the checks then said nothing about the code you
 * had just changed.
 */
async function assertPortFree(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) });
    if (r) throw new Error(
      `Port ${port} is occupied — a server is already answering there. Probably a leftover ` +
      `from an earlier run: "pkill -f 'tsx src/server.ts'".`,
    );
  } catch (e) {
    if (String(e?.message || '').startsWith(`Port ${port}`)) throw e;
    // Connection refused = free, which is exactly what we want.
  }
}

function startServer(port, extraEnv) {
  const base = `http://127.0.0.1:${port}`;
  // detached: `npx` is only the wrapper; signalling it leaves the actual Node process alive.
  // That is exactly how servers were left behind and skewed the next run. With a process group
  // of its own, the signal at the end reaches the whole chain.
  const s = spawn('npx', ['tsx', 'src/server.ts'], {
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: base,
      EUDI_EDITION: 'community',
      EUDIPLO_BASE_URL: `http://127.0.0.1:${VERIFIER_PORT}`,
      EUDIPLO_CLIENT_ID: 'test',
      EUDIPLO_CLIENT_SECRET: 'test',
      EUDI_INVITE_SECRET: 'test-secret-do-not-use-in-production',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  logs.set(port, log);
  s.stdout.on('data', (d) => log.push(d.toString()));
  s.stderr.on('data', (d) => log.push(d.toString()));
  return s;
}

async function waitForServer(base, port) {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server ${base} did not start:\n${(logs.get(port) || []).join('')}`);
}

for (const p of [VERIFIER_PORT, GATED_PORT, OPEN_PORT]) await assertPortFree(p);

await new Promise((r) => verifier.listen(VERIFIER_PORT, r));
const gatedSrv = startServer(GATED_PORT, {
  EUDI_HOST_ALLOWLIST: 'Mustermann,Erika; Schmidt,Hans-Peter',
  EUDI_BRAND_NAME: 'Test Authority',
  EUDI_TRUST_LIST_IDS: 'pid-issuers',
});
const openSrv = startServer(OPEN_PORT, {});
const sockets = [];

try {
  await waitForServer(GATED, GATED_PORT);
  await waitForServer(OPEN, OPEN_PORT);

  console.log('\nThe sign-in announces itself');
  const capsGated = await (await fetch(`${GATED}/capabilities`)).json();
  const capsOpen = await (await fetch(`${OPEN}/capabilities`)).json();
  check('the gated instance reports hostLogin=true', capsGated.hostLogin === true, `hostLogin=${capsGated.hostLogin}`);
  check('the open instance reports hostLogin=false', capsOpen.hostLogin === false, `hostLogin=${capsOpen.hostLogin}`);

  console.log('\nThe wallet is asked for BOTH names (otherwise the gate can never match)');
  const r1 = room();
  const host1 = participant(GATED_PORT, { roomId: r1, clientId: 'c-host-1' });
  sockets.push(host1);
  const auth1 = await host1.wait('auth');
  const asked1 = requestedClaims(offerIdOf(auth1.uri));
  check('family name requested', asked1.has('family_name'), [...asked1].join(','));
  check('given name requested', asked1.has('given_name'), [...asked1].join(','));
  // EUDIPLO 7+ only takes a trust list as an object; a URL string registers and then fails
  // every verification with a bare 400.
  const ta1 = configs.get(offers.get(offerIdOf(auth1.uri))?.requestId)?.credentials?.[0]?.trusted_authorities;
  check('the trust list goes out as { trustListId }',
    JSON.stringify(ta1) === JSON.stringify([{ type: 'etsi_tl', values: [{ trustListId: 'pid-issuers' }] }]),
    JSON.stringify(ta1));

  console.log('\nA listed name gets through');
  const p1 = await present(offerIdOf(auth1.uri), { given_name: 'Erika', family_name: 'Mustermann' });
  check('webhook accepted', p1.status === 200, `status=${p1.status}`);
  const st1 = await host1.wait('status', (m) => m.self?.verified === true);
  check('the host counts as verified', st1.self.verified === true);
  check('no rejection', !host1.find('host-denied'));

  console.log('\nThe given name stays requested even after setup');
  // The bug sat exactly here: set-config passed the client's list on instead of the enforced
  // one. That is why ONLY the family name is deliberately selected here.
  const r2 = room();
  const host2 = participant(GATED_PORT, { roomId: r2, clientId: 'c-host-2' });
  sockets.push(host2);
  await host2.wait('auth');
  host2.send({ type: 'set-config', mode: 'video', requestedAttrs: ['family_name'], disclosedAttrs: ['family_name'] });
  const auth2 = await host2.wait('auth', (m) => offerIdOf(m.uri) !== offerIdOf(host2.find('auth').uri) || true, 6000);
  await new Promise((r) => setTimeout(r, 400));
  const lastAuth = [...host2.seen].reverse().find((m) => m.type === 'auth');
  const asked2 = requestedClaims(offerIdOf(lastAuth.uri));
  check('given name requested despite choosing "family name only"', asked2.has('given_name'), [...asked2].join(','));
  const st2 = await host2.wait('status', (m) => Array.isArray(m.disclosedAttrs));
  check('the interface shows the same list', (st2.disclosedAttrs || []).includes('given_name'), JSON.stringify(st2.disclosedAttrs));

  console.log('\nChoosing anonymity does NOT lift the gate');
  const r3 = room();
  const host3 = participant(GATED_PORT, { roomId: r3, clientId: 'c-host-3' });
  sockets.push(host3);
  await host3.wait('auth');
  host3.send({ type: 'set-config', mode: 'video', requestedAttrs: [], disclosedAttrs: [] });
  await new Promise((r) => setTimeout(r, 600));
  const st3 = [...host3.seen].reverse().find((m) => m.type === 'status');
  check('the host does NOT count as verified without a wallet', st3?.self?.verified !== true, `verified=${st3?.self?.verified}`);

  console.log('\nAn unlisted name is rejected');
  const r4 = room();
  const host4 = participant(GATED_PORT, { roomId: r4, clientId: 'c-host-4' });
  sockets.push(host4);
  const auth4 = await host4.wait('auth');
  await present(offerIdOf(auth4.uri), { given_name: 'Erika', family_name: 'Meier' });
  await host4.wait('host-denied');
  check('the rejection reaches the host', !!host4.find('host-denied'));
  const status4 = await (await fetch(`${GATED}/status/${r4}`)).json().catch(() => null);
  check('the room stays without a host', !(status4?.peers || []).includes('caller'), JSON.stringify(status4));

  console.log('\nRight given name, wrong family name is not a match');
  const r5 = room();
  const host5 = participant(GATED_PORT, { roomId: r5, clientId: 'c-host-5' });
  sockets.push(host5);
  const auth5 = await host5.wait('auth');
  await present(offerIdOf(auth5.uri), { given_name: 'Hans-Peter', family_name: 'Mustermann' });
  await host5.wait('host-denied');
  check('a cross of two listed people is rejected', !!host5.find('host-denied'));

  console.log('\nThe guest is never checked against the list');
  const r6 = room();
  const host6 = participant(GATED_PORT, { roomId: r6, clientId: 'c-host-6' });
  sockets.push(host6);
  const auth6 = await host6.wait('auth');
  host6.send({ type: 'set-config', mode: 'video', requestedAttrs: ['family_name'], disclosedAttrs: ['family_name'] });
  await new Promise((r) => setTimeout(r, 400));
  const auth6b = [...host6.seen].reverse().find((m) => m.type === 'auth');
  await present(offerIdOf(auth6b.uri), { given_name: 'Erika', family_name: 'Mustermann' });
  await host6.wait('status', (m) => m.self?.verified === true);
  const guest6 = participant(GATED_PORT, { roomId: r6, clientId: 'c-guest-6' });
  sockets.push(guest6);
  const authGuest = await guest6.wait('auth');
  await present(offerIdOf(authGuest.uri), { given_name: 'Wilhelmine', family_name: 'Unbekannt' });
  const stGuest = await guest6.wait('status', (m) => m.self?.verified === true);
  check('a guest with an unlisted name gets through', stGuest.self.verified === true);
  check('the guest is not rejected', !guest6.find('host-denied'));

  console.log('\nThe rejection is in the record — without the name');
  const gatedLog = (logs.get(GATED_PORT) || []).join('');
  const auditLines = gatedLog.split('\n').filter((z) => z.includes('[audit]'));
  check('the host-denied event is recorded', auditLines.some((z) => z.includes('host-denied')));
  const names = ['Meier', 'Mustermann', 'Erika', 'Hans-Peter', 'Wilhelmine', 'Unbekannt'];
  const leaked = names.filter((n) => auditLines.some((z) => z.includes(n)));
  check('no name in the verification record', leaked.length === 0, `found: ${leaked.join(',')}`);
  const leakedLog = names.filter((n) => gatedLog.includes(n));
  check('no name anywhere in the server log', leakedLog.length === 0, `found: ${leakedLog.join(',')}`);

  console.log('\nThe open instance notices none of this');
  const r7 = room();
  const host7 = participant(OPEN_PORT, { roomId: r7, clientId: 'c-host-7' });
  sockets.push(host7);
  const auth7 = await host7.wait('auth');
  const asked7 = requestedClaims(offerIdOf(auth7.uri));
  check('no given name is enforced', !asked7.has('given_name'), [...asked7].join(','));
  await present(offerIdOf(auth7.uri), { given_name: 'Wilhelmine', family_name: 'Unbekannt' });
  const st7 = await host7.wait('status', (m) => m.self?.verified === true);
  check('any host gets through', st7.self.verified === true);
  check('no rejection', !host7.find('host-denied'));

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
} catch (e) {
  failures++;
  console.error('\nAborted:', e?.message || e);
  console.error((logs.get(GATED_PORT) || []).join('').slice(-3000));
} finally {
  for (const s of sockets) { try { s.close(); } catch {} }
  // Kill the GROUP (negative PID), not just the npx wrapper — otherwise the server survives.
  for (const s of [gatedSrv, openSrv]) { try { process.kill(-s.pid, 'SIGKILL'); } catch { try { s.kill('SIGKILL'); } catch {} } }
  verifier.close();
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
}
