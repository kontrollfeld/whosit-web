// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Registration certificate (WRPRC) — the properties that fail on the phone, not here.
 *
 *   1. The coverage check mirrors EUDIPLO 8.0.2: key order is irrelevant, claim order and
 *      `intent_to_retain` are not, DCQL-only fields (`id`, `trusted_authorities`) are ignored.
 *   2. `buildDcql` emits the same claims array for the same attribute set in any order —
 *      otherwise a certificate covers a room on Monday and not on Tuesday.
 *   3. Every entry `npm run wrprc:credentials` prints is exactly what `buildDcql` sends, so a
 *      certificate built from that list covers every room.
 *   4. A PID config the certificate does not cover is refused BEFORE it reaches EUDIPLO; a
 *      catalog config simply goes out without the certificate; a covered one carries it.
 *   5. Startup: absent = warning, garbage or expired = fatal.
 *
 * Usage: npm run test:wrprc
 */
import { spawnSync } from 'node:child_process';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtFor = (payload) => `${b64({ alg: 'ES256', typ: 'rc-wrp+jwt' })}.${b64(payload)}.c2ln`;

function tsx(code, env = {}) {
  const r = spawnSync('npx', ['tsx', '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, EUDI_REGISTRATION_CERT: '', EUDI_REGISTRATION_CERT_FILE: '', ...env },
  });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

console.log('1. coverage check');
{
  const r = tsx(`
    import { uncoveredCredentials } from './src/registration-cert';
    const mdoc = { format: 'mso_mdoc', meta: { doctype_value: 'pid' }, claims: [{ path: ['pid', 'given_name'], intent_to_retain: false }] };
    const q = (c) => ({ credentials: [{ id: 'a', trusted_authorities: [{ type: 'etsi_tl', values: [] }], ...c }] });
    const reordered = { meta: { doctype_value: 'pid' }, claims: [{ intent_to_retain: false, path: ['pid', 'given_name'] }], format: 'mso_mdoc' };
    console.log(JSON.stringify({
      same: uncoveredCredentials(q(mdoc), { credentials: [reordered] }).length,
      noRetainFlag: uncoveredCredentials(q(mdoc), { credentials: [{ ...mdoc, claims: [{ path: ['pid', 'given_name'] }] }] }).length,
      none: uncoveredCredentials(q(mdoc), {}).length,
      empty: uncoveredCredentials({ credentials: [] }, {}).length,
    }));`);
  let j = {};
  try { j = JSON.parse(r.out); } catch {}
  check('key order irrelevant, DCQL-only fields ignored', j.same === 0, r.out || r.err);
  check('a missing intent_to_retain is a mismatch (EUDIPLO 8.0.2 compares exactly)', j.noRetainFlag === 1, r.out);
  check('no credentials claim covers nothing', j.none === 1, r.out);
  check('an empty query needs no coverage', j.empty === 0, r.out);
}

console.log('2. canonical claim order');
{
  const r = tsx(`
    import { buildDcql, selectedProfiles } from './src/credential-profiles';
    const p = selectedProfiles();
    const a = JSON.stringify(buildDcql(p, ['given_name', 'family_name', 'age_over_18']));
    const b = JSON.stringify(buildDcql(p, ['age_over_18', 'family_name', 'given_name']));
    console.log(a === b ? 'same' : 'different');`);
  check('same attribute set → same bytes', r.out === 'same', r.out || r.err);
}

console.log('3. helper output covers what is sent');
{
  const list = spawnSync('npx', ['tsx', 'scripts/wrprc-credentials.mts'], { encoding: 'utf8', env: { ...process.env, EUDI_REGISTRATION_CERT: '', EUDI_REGISTRATION_CERT_FILE: '' } });
  let entries = [];
  try { entries = JSON.parse(list.stdout); } catch {}
  check('helper prints entries', entries.length > 0, list.stderr);
  const cert = jwtFor({ credentials: entries, exp: Math.floor(Date.now() / 1000) + 86400 * 365 });
  const again = spawnSync('npx', ['tsx', 'scripts/wrprc-credentials.mts', '--check'], { encoding: 'utf8', env: { ...process.env, EUDI_REGISTRATION_CERT: cert, EUDI_REGISTRATION_CERT_FILE: '' } });
  check('a certificate built from that list covers all of it', again.status === 0, again.stderr);
  const partial = jwtFor({ credentials: entries.slice(1) });
  const short = spawnSync('npx', ['tsx', 'scripts/wrprc-credentials.mts', '--check'], { encoding: 'utf8', env: { ...process.env, EUDI_REGISTRATION_CERT: partial, EUDI_REGISTRATION_CERT_FILE: '' } });
  check('one entry short → exit 1 and named', short.status === 1 && /missing:/.test(short.stderr), short.stderr);

  console.log('4. egress');
  const code = `
    import { ensureVerifierConfig } from './src/eudiplo';
    import { buildDcql, selectedProfiles } from './src/credential-profiles';
    (async () => {
    const bodies = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/api/oauth2/token')) return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
      if (String(url).endsWith('/api/verifier/config')) { bodies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
      if (String(url).endsWith('/api/registrar/config')) return new Response('{}', { status: 200 });
      return new Response('{}', { status: 404 });
    };
    const res = {};
    try { await ensureVerifierConfig('pid1', buildDcql(selectedProfiles(), ['given_name', 'family_name']), 'pid'); res.pid = 'ok'; } catch (e) { res.pid = 'threw:' + e.message; }
    try { await ensureVerifierConfig('cat1', { credentials: [{ id: 'w', format: 'dc+sd-jwt', meta: { vct_values: ['x'] }, claims: [{ path: ['a'] }] }] }, 'catalog'); res.cat = 'ok'; } catch (e) { res.cat = 'threw:' + e.message; }
    res.bodies = bodies.map((b) => ({ id: b.id, cert: !!b.registration_cert?.jwt }));
    console.log(JSON.stringify(res));
    })();`;
  const egressEnv = { EUDIPLO_BASE_URL: 'http://verifier.test', EUDIPLO_CLIENT_ID: 'tenant', EUDIPLO_CLIENT_SECRET: 's' };
  const covered = tsx(code, { ...egressEnv, EUDI_REGISTRATION_CERT: cert });
  let c = {};
  try { c = JSON.parse(covered.out.split('\n').pop()); } catch {}
  check('covered PID config carries the certificate', c.pid === 'ok' && c.bodies?.find((b) => b.id === 'pid1')?.cert === true, covered.out || covered.err);
  check('uncovered catalog config goes out without it', c.cat === 'ok' && c.bodies?.find((b) => b.id === 'cat1')?.cert === false, covered.out);
  const narrow = tsx(code, { ...egressEnv, EUDI_REGISTRATION_CERT: jwtFor({ credentials: [] }) });
  let n = {};
  try { n = JSON.parse(narrow.out.split('\n').pop()); } catch {}
  check('uncovered PID config is refused before EUDIPLO sees it', String(n.pid).startsWith('threw:') && !n.bodies?.some((b) => b.id === 'pid1'), narrow.out || narrow.err);
  const none = tsx(code, egressEnv);
  let z = {};
  try { z = JSON.parse(none.out.split('\n').pop()); } catch {}
  check('without a certificate nothing changes', z.pid === 'ok' && z.bodies?.every((b) => !b.cert), none.out || none.err);
}

console.log('5. startup');
{
  const code = `
    import { collectConfigProblems } from './src/core/startup-checks';
    const env = { EUDIPLO_BASE_URL: 'https://v.example.net', EUDIPLO_CLIENT_ID: 'tenant-x', EUDIPLO_CLIENT_SECRET: 'real-secret-123', ...JSON.parse(process.env.CASE) };
    const p = collectConfigProblems({ env }).filter((x) => x.variable.startsWith('EUDI_REGISTRATION_CERT'));
    console.log(JSON.stringify(p.map((x) => x.fatal)));`;
  const run = (c) => { const r = tsx(code, { CASE: JSON.stringify(c) }); try { return JSON.parse(r.out.split('\n').pop()); } catch { return r.out || r.err; } };
  const now = Math.floor(Date.now() / 1000);
  check('absent → warning', JSON.stringify(run({})) === '[false]', JSON.stringify(run({})));
  check('garbage → fatal', JSON.stringify(run({ EUDI_REGISTRATION_CERT: 'nope' })) === '[true]', JSON.stringify(run({ EUDI_REGISTRATION_CERT: 'nope' })));
  check('expired → fatal', JSON.stringify(run({ EUDI_REGISTRATION_CERT: jwtFor({ exp: now - 10 }) })) === '[true]', '');
  check('expiring soon → warning', JSON.stringify(run({ EUDI_REGISTRATION_CERT: jwtFor({ exp: now + 86400 * 5 }) })) === '[false]', '');
  check('valid → silent', JSON.stringify(run({ EUDI_REGISTRATION_CERT: jwtFor({ exp: now + 86400 * 365 }) })) === '[]', '');
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall registration-certificate checks passed');
