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

const VERIFIER_PORT = 3997;
const APP_PORT = 3998;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'whosit-call-actions-'));
let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`); if (!ok) failures++; };

// ── The module ───────────────────────────────────────────────────────────────────────────────
const modDir = join(work, 'demo-aktion');
mkdirSync(modDir);
writeFileSync(join(modDir, 'package.json'), JSON.stringify({
  name: 'demo-aktion', version: '0.0.1', main: 'index.js',
  whosit: { id: 'demo-aktion', coreApi: '^1', features: [{ id: 'demo-aktion', title: 'Demo' }], clientAliases: ['demo'] },
}));
writeFileSync(join(modDir, 'index.js'), `
module.exports.register = () => ({
  actions: [{
    id: 'senden', label: 'Formular senden',
    choices: () => [{ id: 'f1', label: 'Selbstauskunft', attrs: ['given_name', 'birth_date'] }, { id: 'f2', label: 'Ohne Ausweis', attrs: [] }],
    path: (id) => '/demo/f/' + id,
  }],
  routes(r, ctx) {
    r.get('/einloesen', (req, res) => res.json({ id: ctx.calls.redeem(String(req.query.ruf || '')) }));
    r.get('/fertig', (req, res) => res.json({ ok: ctx.calls.done(String(req.query.ruf || ''), { summary: 'Eingang 42' }) }));
    r.get('/rahmen', (req, res) => res.json({ frameOrigins: ctx.frameOrigins }));
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
const app = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: root, detached: true,
  env: {
    ...process.env, PORT: String(APP_PORT), PUBLIC_URL: `http://127.0.0.1:${APP_PORT}`,
    EUDI_EDITION: 'community', EUDI_PRO_MODULE: '', EUDI_MODULES: modDir, EUDI_FEATURES_OFF: '', EUDI_PROMO_ALL_PRO: '',
    EUDI_DATA_DIR: work, EUDIPLO_BASE_URL: `http://127.0.0.1:${VERIFIER_PORT}`, EUDIPLO_CLIENT_ID: 't', EUDIPLO_CLIENT_SECRET: 'ts',
    EUDI_WRP_POLICY: 'p2p-call', EUDI_WRP_NARROW: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (d) => log.push(d.toString()));
app.stderr.on('data', (d) => log.push(d.toString()));
const A = `http://127.0.0.1:${APP_PORT}`;
const get = async (p) => (await fetch(`${A}${p}`)).json();
const clients = [];

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
  const guestPeer = host.last('status').peers[0].peerId;
  return { host, guest, guestPeer };
}

try {
  await new Promise((r) => verifier.listen(VERIFIER_PORT, r));
  for (let t = Date.now(); ; ) {
    try { if ((await fetch(`${A}/health`)).ok) break; } catch {}
    if (Date.now() - t > 30000) throw new Error(log.join(''));
    await new Promise((r) => setTimeout(r, 250));
  }
  check('/capabilities says actions are offered', (await get('/capabilities')).actions === true);
  check('the module learns the app origins that may frame its page', (await get('/demo/rahmen')).frameOrigins.includes('https://localhost'));

  const { host, guest, guestPeer } = await call();

  console.log('\nOnly the host lists and starts');
  guest.send({ type: 'actions-list' });
  check('a guest gets no list', await guest.none('actions'));
  host.send({ type: 'actions-list' });
  const list = await host.wait('actions');
  check('the host gets the actions with their choices', list.items.length === 1 && list.items[0].label === 'Formular senden' && list.items[0].choices.length === 2, JSON.stringify(list));
  check('without attribute lists — the host does not need them', !('attrs' in list.items[0].choices[0]));

  console.log('\nThe guest is asked, with exactly the data that would go to the module');
  host.send({ type: 'action-start', to: guestPeer, module: 'demo-aktion', action: 'senden', choice: 'f1' });
  const req = await guest.wait('action-requested');
  check('who, what, which form', req.fromName && req.label === 'Formular senden' && req.title === 'Selbstauskunft', JSON.stringify(req));
  check('only what the form needs AND was presented: the first name — no birth date (not presented)', JSON.stringify(req.attrs) === '["given_name"]', JSON.stringify(req.attrs));
  check('the host sees it is pending', (await host.wait('action-pending')).title === 'Selbstauskunft');
  check('the guest gets no address before agreeing', !guest.last('action-open'));
  guest.send({ type: 'action-start', to: guestPeer, module: 'demo-aktion', action: 'senden', choice: 'f1' });
  check('a guest cannot start one', await host.none('action-requested') && guest.seen.filter((m) => m.type === 'action-requested').length === 1);

  guest.send({ type: 'action-accept', runId: req.runId });
  const offen = await guest.wait('action-open');
  check('agreed: the panel address with a token', /^\/demo\/f\/f1\?ruf=[\w-]{40,}$/.test(offen.path), offen.path);
  check('the host is told', (await host.wait('action-accepted')).title === 'Selbstauskunft');
  const ruf = new URLSearchParams(offen.path.split('?')[1]).get('ruf');

  console.log('\nThe module gets the identity once');
  check('a made-up token: nothing', (await get('/demo/einloesen?ruf=falsch')).id === null);
  const id = (await get(`/demo/einloesen?ruf=${ruf}`)).id;
  check('the first name from the call — and nothing else', id && JSON.stringify(id.claims) === '{"given_name":"Gustav"}' && id.action === 'senden' && id.choice === 'f1', JSON.stringify(id));
  check('only once', (await get(`/demo/einloesen?ruf=${ruf}`)).id === null);
  check('done', (await get(`/demo/fertig?ruf=${ruf}`)).ok === true);
  const fertig = await host.wait('action-done');
  check('the host sees it, with the module\'s summary', fertig.title === 'Selbstauskunft' && fertig.summary === 'Eingang 42', JSON.stringify(fertig));
  check('the guest\'s panel is told to close', !!(await guest.wait('action-done')));
  check('done only once', (await get(`/demo/fertig?ruf=${ruf}`)).ok === false);

  console.log('\nDeclined, withdrawn');
  host.send({ type: 'action-start', to: guestPeer, module: 'demo-aktion', action: 'senden', choice: 'f2' });
  const r2 = await guest.wait('action-requested', (m) => m.runId !== req.runId);
  check('a choice that takes nothing says so', r2.attrs.length === 0);
  guest.send({ type: 'action-decline', runId: r2.runId });
  check('declined: the host is told', (await host.wait('action-declined')).title === 'Ohne Ausweis');
  host.send({ type: 'action-start', to: guestPeer, module: 'demo-aktion', action: 'senden', choice: 'f1' });
  const r3 = await host.wait('action-pending', (m) => m.runId !== req.runId && m.runId !== r2.runId);
  host.send({ type: 'action-cancel', runId: r3.runId });
  check('withdrawn: the guest is told', !!(await guest.wait('action-cancelled', (m) => m.runId === r3.runId)));
  host.send({ type: 'action-start', to: guestPeer, module: 'demo-aktion', action: 'senden', choice: 'nichtda' });
  check('an unknown choice: refused', !!(await host.wait('action-error')));

  console.log('\nThe guest leaves while the panel is open');
  host.send({ type: 'action-start', to: guestPeer, module: 'demo-aktion', action: 'senden', choice: 'f1' });
  const r4 = await guest.wait('action-requested', (m) => ![req.runId, r2.runId, r3.runId].includes(m.runId));
  guest.send({ type: 'action-accept', runId: r4.runId });
  const o4 = await guest.wait('action-open', (m) => m.runId === r4.runId);
  const ruf4 = new URLSearchParams(o4.path.split('?')[1]).get('ruf');
  guest.send({ type: 'hangup' });
  check('the host is told it was not completed', !!(await host.wait('action-aborted', (m) => m.runId === r4.runId)));
  check('and the module gets nothing any more', (await get(`/demo/einloesen?ruf=${ruf4}`)).id === null);

  console.log('\nThe log');
  check('no name in the log', !/Gustav|Hanna/.test(log.join('')), log.join('').match(/.*(Gustav|Hanna).*/)?.[0]);
} catch (e) {
  failures++;
  console.log(`  ✗ aborted — ${e.stack || e}`);
  console.log(log.join('').slice(-3000));
} finally {
  for (const c of clients) { try { c.ws.close(); } catch {} }
  try { process.kill(-app.pid); } catch {}
  verifier.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
