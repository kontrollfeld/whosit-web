// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Actions in a call (src/call-actions.ts, ports `ModuleAction` / `CallPort`) — with a throwaway
 * module, a verifier stand-in and two participants over the real signalling.
 *
 * What must hold:
 *   - Only a verified host can list and start actions, and only for a verified, confirmed guest.
 *   - The guest is told which verified data the module will receive — what the choice needs AND
 *     the guest presented in this call, nothing else — before anything is handed over.
 *   - The module gets that identity once, only after the guest agreed, only with the token, only
 *     while the guest is still in the call; "done" reaches the host once.
 *   - Declining, withdrawing and leaving end an action and tell the other side.
 *
 * Usage: npm run test:call-actions
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const VERIFIER_PORT = 3987;
const APP_PORT = 3988;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'whosit-cred-module-'));
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`); if (!ok) failures++; };

// ── The module ───────────────────────────────────────────────────────────────────────────────
const modDir = join(work, 'demo-nachweise');
mkdirSync(modDir);
writeFileSync(join(modDir, 'package.json'), JSON.stringify({
  name: 'demo-nachweise', version: '0.0.1', main: 'index.js',
  whosit: { id: 'demo-nachweise', coreApi: '^1', features: [{ id: 'demo-nachweise', title: 'Demo' }, { id: 'in-call-credentials', title: 'In-call credentials' }], clientAliases: ['dn'] },
}));
writeFileSync(join(modDir, 'index.js'), `
const katalog = [
  { id: 'mitglied', label: 'Mitgliedsausweis', format: 'dc+sd-jwt', credentialType: 'urn:test:mitglied', claims: [{ path: ['member_id'], name: 'Mitgliedsnummer' }, { path: ['since'], name: 'Mitglied seit', mandatory: false }] },
  { id: 'kaputt', label: 'Ohne Felder', format: 'dc+sd-jwt', credentialType: 'x', claims: [] },
];
const held = new Map();
module.exports.register = () => ({
  credentialCatalog: () => katalog,
  actions: [{ id: 'nachweis', label: 'Nachweis anfordern', credential: true, choices: () => katalog.map((c) => ({ id: c.id, label: c.label, attrs: [] })), path: () => '' }],
  routes(r, ctx) {
    r.post('/start', async (req, res) => {
      try { const s = await ctx.presentations.startCredential({ credentialId: req.body.id, origin: ctx.publicOrigin(req) }); held.set(s.id, s.secret); res.json({ id: s.id, uri: s.uri }); }
      catch (e) { res.status(400).json({ fehler: e.message }); }
    });
    r.get('/stand/:id', (req, res) => res.json(ctx.presentations.poll(req.params.id, held.get(req.params.id))));
  },
});
`);

// ── Verifier stand-in ────────────────────────────────────────────────────────────────────────
const offers = new Map();
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const verifier = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'POST' && p === '/api/oauth2/token') return json(res, 200, { access_token: 't' });
  if (req.method === 'POST' && p === '/api/verifier/config') { await readBody(req); return json(res, 200, {}); }
  if (req.method === 'POST' && p === '/api/verifier/offer') {
    const b = JSON.parse(await readBody(req));
    const id = randomUUID();
    offers.set(id, b.webhook.url);
    return json(res, 200, { uri: `http://x/${id}`, crossDeviceUri: `http://x/${id}`, session: id });
  }
  if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
  return json(res, 404, {});
});
const present = (auth, values) => fetch(offers.get(String(auth.uri).split('/').pop()), {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ status: 'completed', credentials: [{ values: [values] }] }),
});

function participant(roomId) {
  const seen = [];
  const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}`);
  const p = {
    ws, seen,
    send: (o) => ws.send(JSON.stringify(o)),
    last: (type, pred = () => true) => [...seen].reverse().find((m) => m.type === type && pred(m)),
    async wait(type, pred = () => true, ms = 8000) {
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
    /** Nothing of this type arrives within `ms`. */
    async none(type, ms = 600) { const n = seen.filter((m) => m.type === type).length; await new Promise((r) => setTimeout(r, ms)); return seen.filter((m) => m.type === type).length === n; },
  };
  ws.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
  ws.on('open', () => p.send({ type: 'join', roomId, clientId: randomUUID(), wantAuth: true }));
  return p;
}


const log = [];
function start(port, modules) {
  const p = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: root, detached: true,
    env: {
      ...process.env, PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`,
      EUDI_EDITION: 'community', EUDI_PRO_MODULE: '', EUDI_MODULES: modules, EUDI_FEATURES_OFF: '', EUDI_PROMO_ALL_PRO: '',
      EUDI_DATA_DIR: work, EUDIPLO_BASE_URL: `http://127.0.0.1:${VERIFIER_PORT}`, EUDIPLO_CLIENT_ID: 't', EUDIPLO_CLIENT_SECRET: 'ts',
      EUDI_WRP_POLICY: 'p2p-call', EUDI_WRP_NARROW: '', EUDI_CREDENTIAL_CATALOG: join(work, 'alte-datei.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => log.push(d.toString()));
  p.stderr.on('data', (d) => log.push(d.toString()));
  return p;
}
async function up(port) {
  for (let t = Date.now(); ; ) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    if (Date.now() - t > 30000) throw new Error(log.join(''));
    await new Promise((r) => setTimeout(r, 250));
  }
}
writeFileSync(join(work, 'alte-datei.json'), JSON.stringify([{ id: 'alt', label: 'Aus der Datei', format: 'dc+sd-jwt', credentialType: 'x', claims: [{ path: ['a'], name: 'A' }] }]));
const A = `http://127.0.0.1:${APP_PORT}`;
const get = async (p) => (await fetch(`${A}${p}`)).json();
const post = (url, b) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
const clients = [];
const procs = [];
async function call() {
  const roomId = randomUUID();
  const host = participant(roomId); clients.push(host);
  await host.wait('status');
  host.send({ type: 'set-config', mode: 'chat', requestedAttrs: ['given_name', 'family_name'], disclosedAttrs: ['given_name', 'family_name'] });
  await present(await host.wait('auth'), { given_name: 'Hanna', family_name: 'Host' });
  await host.wait('status', (m) => m.self.verified);
  const guest = participant(roomId); clients.push(guest);
  await present(await guest.wait('auth'), { given_name: 'Gustav', family_name: 'Gast' });
  await guest.wait('status', (m) => m.self.verified);
  host.send({ type: 'confirm' }); guest.send({ type: 'confirm' });
  await host.wait('status', (m) => m.revealed === true);
  return { host, guest, guestPeer: host.last('status').peers[0].peerId };
}

try {
  await new Promise((r) => verifier.listen(VERIFIER_PORT, r));

  console.log('\nWithout the module the capability does not exist — the old file is not read');
  procs.push(start(APP_PORT, ''));
  await up(APP_PORT);
  check('not offered', !(await get('/capabilities')).enabled.includes('in-call-credentials'));
  check('no catalog', (await get('/credential-catalog')).credentials.length === 0);
  { const { host, guestPeer } = await call();
    host.send({ type: 'credential-request', to: guestPeer, credentialId: 'alt' });
    check('a request on the wire is ignored', await host.none('credential-pending')); }
  try { process.kill(-procs.pop().pid); } catch {}
  await new Promise((r) => setTimeout(r, 800));

  console.log('\nWith the module');
  procs.push(start(APP_PORT, modDir));
  await up(APP_PORT);
  const caps = await get('/capabilities');
  check('offered, and actions too', caps.enabled.includes('in-call-credentials') && caps.actions === true);
  const kat = (await get('/credential-catalog')).credentials;
  check('the catalog is the module\'s — the invalid entry and the file are not in it', JSON.stringify(kat.map((c) => c.id)) === '["mitglied"]', JSON.stringify(kat.map((c) => c.id)));
  check('the log names it once', (log.join('').match(/\[catalog\] 1 credential/g) || []).length >= 1);

  const { host, guest, guestPeer } = await call();
  host.send({ type: 'actions-list' });
  const list = await host.wait('actions');
  check('"Nachweis anfordern" in the menu', list.items.some((i) => i.label === 'Nachweis anfordern' && i.choices.some((c) => c.id === 'mitglied')), JSON.stringify(list));
  host.send({ type: 'action-start', to: guestPeer, module: 'demo-nachweise', action: 'nachweis', choice: 'mitglied' });
  const ask = await guest.wait('credential-requested');
  check('it runs the core\'s credential flow: consent with the exact fields', ask.credential.id === 'mitglied' && ask.credential.claims.map((c) => c.name).join() === 'Mitgliedsnummer,Mitglied seit', JSON.stringify(ask));
  check('no panel for it', !guest.last('action-requested'));
  guest.send({ type: 'credential-accept', requestId: ask.requestId });
  const auth = await guest.wait('credential-auth');
  await fetch(offers.get(String(auth.uri).split('/').pop()), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'completed', credentials: [{ values: [{ member_id: 'M-42', since: '2020' }] }] }) });
  const got = await host.wait('credential-presented');
  check('the host gets the values', JSON.stringify(got.claims) === JSON.stringify([{ name: 'Mitgliedsnummer', value: 'M-42' }, { name: 'Mitglied seit', value: '2020' }]), JSON.stringify(got.claims));
  host.send({ type: 'action-start', to: guestPeer, module: 'demo-nachweise', action: 'nachweis', choice: 'kaputt' });
  check('an id the catalog does not hold: refused', !!(await host.wait('credential-error')));

  console.log('\nOutside a call: a module asks for a catalog credential');
  check('unknown id refused', (await post(`${A}/dn/start`, { id: 'gibtsnicht' })).status === 400);
  const s = await (await post(`${A}/dn/start`, { id: 'mitglied' })).json();
  const sess = String(s.uri).split('/').pop();
  check('started', !!s.id && offers.has(sess));
  await fetch(offers.get(sess), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'completed', session: sess, credentials: [{ values: [{ since: '2020' }] }] }) });
  check('a presentation without the mandatory field fails', (await get(`/dn/stand/${s.id}`)).state === 'failed');
  const s2 = await (await post(`${A}/dn/start`, { id: 'mitglied' })).json();
  const sess2 = String(s2.uri).split('/').pop();
  await fetch(offers.get(sess2), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'completed', session: sess2, credentials: [{ values: [{ member_id: 'M-7', given_name: 'Mallory' }] }] }) });
  const st = await get(`/dn/stand/${s2.id}`);
  check('ok: its claims, nothing else', st.state === 'ok' && st.credential === 'mitglied' && JSON.stringify(st.claims) === '{"member_id":"M-7"}', JSON.stringify(st));
  check('no value in the log', !/M-42|M-7|Mallory|Gustav/.test(log.join('')), log.join('').match(/.*(M-42|M-7|Mallory).*/)?.[0]);
} catch (e) {
  failures++;
  console.log(`  ✗ aborted — ${e.stack || e}`);
  console.log(log.join('').slice(-3000));
} finally {
  for (const c of clients) { try { c.ws.close(); } catch {} }
  for (const p of procs) { try { process.kill(-p.pid); } catch {} }
  verifier.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
