// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Module routes and wallet presentations outside a call (src/presentations.ts, ports
 * `PresentationPort` / `ModuleRoutes`) — with a throwaway module written into a temp directory and
 * a verifier stand-in.
 *
 * What must hold:
 *   - A module's routes are served under /modules/<id>/ and its aliases, and only while its
 *     feature is on.
 *   - It may ask the wallet only for what the instance's policy permits — anything else, and the
 *     room-scoped pseudonym, is refused, not narrowed.
 *   - The wallet is asked for exactly those attributes, and only those come back, even when the
 *     presentation carries more.
 *   - The claims are handed to the module once; the secret is needed to read them; a forged or
 *     repeated callback changes nothing; the verifier session is purged.
 *   - The record names attributes, never values.
 *
 * Usage: npm run test:module-presentations
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifierResults } from './lib/verifier-results.mjs';


const VERIFIER_PORT = 3994;
const APP_PORT = 3995;
const OFF_PORT = 3996;
const SHORT_PORT = 3985;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'whosit-module-pres-'));

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures++;
}

// ── A module, as small as it gets ────────────────────────────────────────────────────────────
const modDir = join(work, 'demo-modul');
mkdirSync(modDir);
writeFileSync(join(modDir, 'package.json'), JSON.stringify({
  name: 'demo-modul', version: '0.0.1', main: 'index.js',
  whosit: { id: 'demo-modul', coreApi: '^1', features: [{ id: 'demo-formular', title: 'Demo' }], clientAliases: ['demo'] },
}));
writeFileSync(join(modDir, 'index.js'), `
const held = new Map();
module.exports.register = () => ({
  routes(r, ctx) {
    r.get('/hallo', (req, res) => res.json({ ok: true, dataDir: ctx.dataDir, brand: ctx.brandName, allowed: ctx.presentations.allowedAttributes(), staff: ctx.staff.active() }));
    r.post('/start', async (req, res) => {
      try {
        const s = await ctx.presentations.start({ attrs: req.body.attrs, origin: ctx.publicOrigin(req) });
        held.set(s.id, s.secret);
        res.json({ id: s.id, uri: s.uri });
      } catch (e) { res.status(400).json({ fehler: e.message }); }
    });
    r.get('/stand/:id', (req, res) => res.json(ctx.presentations.poll(req.params.id, req.query.falsch ? 'falsch' : held.get(req.params.id))));
  },
});
`);

// ── Verifier stand-in ────────────────────────────────────────────────────────────────────────
const offers = new Map();     // session → webhook url
const configs = new Map();    // config id → body
const deleted = [];
const results = verifierResults();
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const verifier = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'POST' && p === '/api/oauth2/token') return json(res, 200, { access_token: 'test-token' });
  if (req.method === 'POST' && p === '/api/verifier/config') { const b = JSON.parse((await readBody(req)) || '{}'); configs.set(b.id, b); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && p === '/api/verifier/offer') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const id = randomUUID();
    offers.set(id, { url: body.webhook.url, requestId: body.requestId });
    const uri = `openid4vp://?session=${id}`;
    return json(res, 200, { uri, crossDeviceUri: uri, session: id });
  }
  if (req.method === 'DELETE' && p.startsWith('/api/session/')) { deleted.push(p.split('/').pop()); res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && p.startsWith('/api/session/')) return json(res, 200, results.lookup(p.split('/').pop()));
  return json(res, 404, {});
});

const appLog = [];
function startApp(port, extra = {}) {
  const proc = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: root, detached: true,
    env: {
      ...process.env,
      PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`,
      EUDI_EDITION: 'community', EUDI_PRO_MODULE: '', EUDI_MODULES: modDir, EUDI_FEATURES_OFF: '', EUDI_PROMO_ALL_PRO: '',
      EUDI_AUDIT_FILE: join(work, `audit-${port}.jsonl`), EUDI_DATA_DIR: join(work, `daten-${port}`),
      EUDIPLO_BASE_URL: `http://127.0.0.1:${VERIFIER_PORT}`, EUDIPLO_CLIENT_ID: 'test-tenant', EUDIPLO_CLIENT_SECRET: 'test-tenant-secret',
      EUDI_WRP_POLICY: 'p2p-call', EUDI_WRP_NARROW: '', EUDI_STAFF_SECRET: '',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => appLog.push(d.toString()));
  proc.stderr.on('data', (d) => appLog.push(d.toString()));
  return proc;
}
async function up(port) {
  for (let t0 = Date.now(); ; ) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    if (Date.now() - t0 > 25000) throw new Error(`app unreachable\n${appLog.join('')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const A = `http://127.0.0.1:${APP_PORT}`;
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
/** A wallet's answer as the verifier delivers it: recorded there first, then the callback. */
const deliver = (url, body) => { results.record(body.session, body); return post(url, body); };
const procs = [];
try {
  await new Promise((r) => verifier.listen(VERIFIER_PORT, r));
  procs.push(startApp(APP_PORT));
  await up(APP_PORT);

  console.log('\nA module adds routes');
  const hallo = await fetch(`${A}/modules/demo-modul/hallo`);
  const h = hallo.ok ? await hallo.json() : {};
  check('served under /modules/<id>/', hallo.ok && h.ok, `HTTP ${hallo.status}`);
  check('and under its alias', (await fetch(`${A}/demo/hallo`)).ok);
  check('it gets a data directory of its own, created', String(h.dataDir).endsWith('/modules/demo-modul') && existsSync(h.dataDir), h.dataDir);
  check('it learns what the policy permits — without the room-scoped pseudonym', JSON.stringify(h.allowed) === JSON.stringify(['given_name', 'family_name', 'age_over_18']), JSON.stringify(h.allowed));
  check('no staff secret → staff links are off', h.staff === false);
  check('the core\'s own routes are not shadowed', (await fetch(`${A}/health`)).ok);

  console.log('\nOnly what the policy permits');
  for (const [name, attrs] of [['an attribute outside the policy', ['given_name', 'birth_date']], ['the room-scoped pseudonym', ['pseudonym_id']], ['an unknown name', ['shoe_size']], ['nothing', []]]) {
    const r = await post(`${A}/modules/demo-modul/start`, { attrs });
    check(`${name}: refused`, r.status === 400, `HTTP ${r.status}`);
  }

  console.log('\nExactly what was asked for');
  const r1 = await post(`${A}/modules/demo-modul/start`, { attrs: ['given_name', 'family_name'] });
  const s1 = await r1.json();
  check('started', r1.ok && s1.id && s1.uri, JSON.stringify(s1));
  const sess1 = String(s1.uri).split('session=')[1];
  const cfg = configs.get(offers.get(sess1)?.requestId);
  const asked = JSON.stringify(cfg?.dcql_query ?? cfg ?? {});
  check('the wallet is asked for given and family name only', asked.includes('given_name') && asked.includes('family_name') && !asked.includes('age_over_18'), asked.slice(0, 300));
  check('pending before the wallet answered', (await (await fetch(`${A}/modules/demo-modul/stand/${s1.id}`)).json()).state === 'pending');

  const hook = offers.get(sess1).url;
  const forged = await post(hook.replace(/t=[^&]+/, 't=falsch'), { status: 'completed', session: sess1, credentials: [{ values: [{ given_name: 'Mallory', family_name: 'X' }] }] });
  check('a forged callback is refused', forged.status === 401, `HTTP ${forged.status}`);
  const cb = await deliver(hook, { status: 'completed', session: sess1, credentials: [{ values: [{ given_name: 'Erika', family_name: 'Mustermann', age_over_18: true }] }] });
  check('the real one is taken', cb.ok, `HTTP ${cb.status}`);
  check('a repeat changes nothing', !(await post(hook, { status: 'completed', session: sess1, credentials: [{ values: [{ given_name: 'Mallory', family_name: 'X' }] }] })).ok);
  check('the verifier session is purged', deleted.includes(sess1), deleted.join(','));

  check('without the secret: nothing', (await (await fetch(`${A}/modules/demo-modul/stand/${s1.id}?falsch=1`)).json()).state === 'unknown');
  const got = await (await fetch(`${A}/modules/demo-modul/stand/${s1.id}`)).json();
  check('ok, with the asked-for claims', got.state === 'ok' && got.claims.given_name === 'Erika' && got.claims.family_name === 'Mustermann', JSON.stringify(got));
  check('and nothing more, though the wallet sent more', !('age_over_18' in (got.claims || {})), JSON.stringify(got.claims));
  check('handed over once', (await (await fetch(`${A}/modules/demo-modul/stand/${s1.id}`)).json()).state === 'unknown');

  console.log('\nA declined presentation');
  const s2 = await (await post(`${A}/modules/demo-modul/start`, { attrs: ['age_over_18'] })).json();
  const sess2 = String(s2.uri).split('session=')[1];
  await deliver(offers.get(sess2).url, { status: 'failed', session: sess2, outcome: { result: 'failed', error: 'access_denied' } });
  check('failed, without claims', (await (await fetch(`${A}/modules/demo-modul/stand/${s2.id}`)).json()).state === 'failed');

  console.log('\nThe record');
  // Without the audit-trail module the record goes to stdout (src/audit.ts), one JSON line each.
  const audit = appLog.join('').split('\n').filter((l) => l.startsWith('[audit] ')).join('\n');
  check('a verified line with attribute names', /"event":"verified"/.test(audit) && /"claimKeys":\["given_name","family_name"\]/.test(audit), audit.slice(-400));
  check('never a value', !/Erika|Mustermann|Mallory/.test(audit) && !appLog.join('').includes('Mustermann'), 'a value leaked');

  console.log('\nRun out before anyone asked: gone at the verifier too (audit #7)');
  procs.push(startApp(SHORT_PORT, { EUDI_PRESENTATION_TTL_MS: '1000' }));
  await up(SHORT_PORT);
  const S = `http://127.0.0.1:${SHORT_PORT}`;
  const s3 = await (await post(`${S}/modules/demo-modul/start`, { attrs: ['given_name'] })).json();
  const sess3 = String(s3.uri).split('session=')[1];
  await new Promise((r) => setTimeout(r, 1300));
  check('expired', (await (await fetch(`${S}/modules/demo-modul/stand/${s3.id}`)).json()).state === 'expired');
  for (let t0 = Date.now(); !deleted.includes(sess3) && Date.now() - t0 < 3000; ) await new Promise((r) => setTimeout(r, 50));
  check('and its verifier session deleted', deleted.includes(sess3), 'a late wallet answer would stay at the verifier until its TTL');

  console.log('\nSwitched off, its pages are gone');
  procs.push(startApp(OFF_PORT, { EUDI_FEATURES_OFF: 'demo-formular' }));
  await up(OFF_PORT);
  check('404 with the feature off', (await fetch(`http://127.0.0.1:${OFF_PORT}/modules/demo-modul/hallo`)).status === 404);
} catch (e) {
  failures++;
  console.log(`  ✗ test aborted — ${e.stack || e}`);
  console.log(appLog.join('').slice(-3000));
} finally {
  for (const p of procs) { try { process.kill(-p.pid); } catch {} }
  verifier.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
