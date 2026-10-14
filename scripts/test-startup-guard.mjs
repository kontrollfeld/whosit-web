// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The startup check — a bolt that is only useful if it actually engages.
 *
 * Why this test exists: until 2026-08-19 `eudiplo.ts` had defaults pointing at someone else's
 * verifier instance, root secret included. An incompletely configured instance would therefore
 * start without complaint and quietly authenticate against a verifier that was not its own. The
 * defaults are gone; to stop them coming back, the check itself is checked here.
 *
 * Three directions in which this can fail:
 *   - TOO LAX: production starts with missing configuration. The mistake then only surfaces at
 *     the first wallet verification, as a 401 in the middle of a citizen's appointment.
 *   - TOO STRICT: development aborts where a warning would have been enough — and then the check
 *     gets worked around instead of satisfied.
 *   - TALKATIVE: a message that prints the VALUE of a secret. Startup logs end up in log
 *     aggregators, issue reports and screenshots; a secret in one of those is burnt.
 *
 * The checks pass their environment in explicitly as an `env` object rather than relying on
 * process.env — otherwise the local `.env` would skew the result and the test would be green on
 * a configured machine without proving anything.
 *
 * Usage: npm run test:startup
 */
import { spawnSync } from 'node:child_process';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

/**
 * A complete, plausible configuration — the reference that gaps are tested against.
 * The hostnames deliberately avoid `example.org`/`example.com`: those are on the placeholder
 * denylist, so using them here would make every check pass for the wrong reason.
 */
const OK_ENV = {
  EUDIPLO_BASE_URL: 'https://verifier.agency.example-real.eu',
  EUDIPLO_CLIENT_ID: 'agency-tenant',
  EUDIPLO_CLIENT_SECRET: 'a-real-looking-random-secret-9f3c1',
  // A registration certificate valid for a year (its own checks: scripts/test-registration-cert.mjs).
  EUDI_REGISTRATION_CERT: [
    { alg: 'ES256', typ: 'rc-wrp+jwt' },
    { exp: Math.floor(Date.now() / 1000) + 365 * 86400 },
  ].map((o) => Buffer.from(JSON.stringify(o)).toString('base64url')).join('.') + '.c2ln',
};

/** Call `collectConfigProblems` with a fixed environment. */
function problems(env, opts = {}) {
  const code = `
    import { collectConfigProblems } from './src/core/startup-checks';
    console.log(JSON.stringify(collectConfigProblems({
      env: ${JSON.stringify(env)},
      embedEnabled: ${opts.embedEnabled === true},
    })));
  `;
  const r = spawnSync('npx', ['tsx', '-e', code], { encoding: 'utf8' });
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); }
  catch { return [{ variable: '_PARSE', problem: `${r.stdout}${r.stderr}`, fatal: true }]; }
}

const names = (ps) => ps.map((p) => p.variable).sort();
const fatalNames = (ps) => ps.filter((p) => p.fatal).map((p) => p.variable).sort();

console.log('\nA complete configuration draws no complaints');
check('no problems', problems(OK_ENV).length === 0, JSON.stringify(problems(OK_ENV)));

console.log('\nEvery required value is detected individually');
for (const missing of ['EUDIPLO_BASE_URL', 'EUDIPLO_CLIENT_ID', 'EUDIPLO_CLIENT_SECRET']) {
  const env = { ...OK_ENV };
  delete env[missing];
  check(`${missing} missing -> fatal`, fatalNames(problems(env)).includes(missing), JSON.stringify(problems(env)));
}

console.log('\nThe legacy root path is a valid substitute for the tenant secret');
const rootOnly = { EUDIPLO_BASE_URL: OK_ENV.EUDIPLO_BASE_URL, EUDIPLO_CLIENT_ID: 'agency-tenant', EUDIPLO_ROOT_ID: 'root', EUDIPLO_ROOT_SECRET: 'another-real-looking-secret-4a7b' };
check('verifier access not flagged', !names(problems(rootOnly)).includes('EUDIPLO_CLIENT_SECRET'), JSON.stringify(problems(rootOnly)));
// Half of the legacy path must NOT be enough — otherwise the token request would fail later.
const halfRoot = { EUDIPLO_BASE_URL: OK_ENV.EUDIPLO_BASE_URL, EUDIPLO_CLIENT_ID: 'agency-tenant', EUDIPLO_ROOT_SECRET: 'secret-without-its-id-8c2d' };
check('half a legacy path (no ROOT_ID) is not enough', fatalNames(problems(halfRoot)).includes('EUDIPLO_CLIENT_SECRET'), JSON.stringify(problems(halfRoot)));

console.log('\nTrust lists in the pre-EUDIPLO-7 form are refused, the new form is not');
const oldTrust = { ...OK_ENV, EUDI_TRUST_LIST_URLS: 'https://verifier.agency.example-real.eu/issuers/agency/trust-list/pid-issuers' };
check('EUDI_TRUST_LIST_URLS -> fatal', fatalNames(problems(oldTrust)).includes('EUDI_TRUST_LIST_URLS'), JSON.stringify(problems(oldTrust)));
check('the message does not echo the URL', !JSON.stringify(problems(oldTrust)).includes('agency/trust-list'), JSON.stringify(problems(oldTrust)));
const newTrust = { ...OK_ENV, EUDI_TRUST_LIST_IDS: 'pid-issuers' };
check('EUDI_TRUST_LIST_IDS draws no complaint', problems(newTrust).length === 0, JSON.stringify(problems(newTrust)));

console.log('\nPlaceholders copied from the template are rejected');
for (const [variable, value] of [
  ['EUDIPLO_CLIENT_SECRET', '__set_me__'],
  ['EUDIPLO_BASE_URL', 'https://eudi.example.org/eudiplo'],
  ['EUDIPLO_CLIENT_ID', 'your-tenant-id'],
]) {
  const ps = problems({ ...OK_ENV, [variable]: value });
  check(`${variable} = placeholder -> fatal`, fatalNames(ps).includes(variable), JSON.stringify(ps));
}

console.log('\nThe old default secret from the source code is rejected by name');
// 'kontrollfeld-secret' was a fallback in the code until 2026-08-19 and is therefore publicly
// known. It MUST fail even when someone sets it deliberately.
const compromised = problems({ ...OK_ENV, EUDIPLO_CLIENT_SECRET: undefined, EUDIPLO_ROOT_ID: 'kontrollfeld', EUDIPLO_ROOT_SECRET: 'kontrollfeld-secret' });
check('recognised as fatal', fatalNames(compromised).includes('EUDIPLO_ROOT_SECRET'), JSON.stringify(compromised));
const msg = (compromised.find((p) => p.variable === 'EUDIPLO_ROOT_SECRET') || {}).problem || '';
check('the message explains that it must be rotated', /rotate/i.test(msg), msg);

console.log('\nNo message ever prints a value');
// The most important test in this file: a recognisable secret value must appear in NO message.
const CANARY = 'zzz-canary-secret-value-do-not-log';
const leaky = problems({ ...OK_ENV, EUDIPLO_CLIENT_SECRET: `__set_me__${CANARY}`, PUBLIC_URL: `https://CHANGE-ME-${CANARY}` });
check('the value appears nowhere', !JSON.stringify(leaky).includes(CANARY), JSON.stringify(leaky));
check('variable names are still named', names(leaky).length >= 2, JSON.stringify(names(leaky)));

console.log('\nPUBLIC_URL: absence is allowed, a placeholder is not');
// Leaving it unset is the CORRECT state — the origin is derived per request from
// x-forwarded-host. A pinned placeholder, by contrast, breaks the wallet redirect back.
check('unset -> no complaint', !names(problems(OK_ENV)).includes('PUBLIC_URL'));
check('CHANGE-ME -> fatal', fatalNames(problems({ ...OK_ENV, PUBLIC_URL: 'https://CHANGE-ME.example' })).includes('PUBLIC_URL'));
check('localhost -> fatal', fatalNames(problems({ ...OK_ENV, PUBLIC_URL: 'http://localhost:3000' })).includes('PUBLIC_URL'));
check('a real address -> fine', !names(problems({ ...OK_ENV, PUBLIC_URL: 'https://whosit.eu' })).includes('PUBLIC_URL'));

console.log('\nFraming: the placeholder asterisk does not get through');
check('embed off -> EMBED_ALLOWED_ANCESTORS irrelevant',
  !names(problems({ ...OK_ENV, EMBED_ALLOWED_ANCESTORS: '*' })).includes('EMBED_ALLOWED_ANCESTORS'));
check('embed on + "*" -> fatal',
  fatalNames(problems({ ...OK_ENV, EMBED_ALLOWED_ANCESTORS: '*' }, { embedEnabled: true })).includes('EMBED_ALLOWED_ANCESTORS'));
check('embed on with no value -> a note only, no abort',
  problems({ ...OK_ENV }, { embedEnabled: true }).every((p) => !p.fatal),
  JSON.stringify(problems({ ...OK_ENV }, { embedEnabled: true })));
check('embed on + token mode -> no complaint',
  problems({ ...OK_ENV, EMBED_SIGNING_SECRET: 'signing-secret-1a2b' }, { embedEnabled: true }).length === 0);
check('embed on + concrete origins -> no complaint',
  problems({ ...OK_ENV, EMBED_ALLOWED_ANCESTORS: 'https://office.example-real.eu' }, { embedEnabled: true }).length === 0);

console.log('\nThe process really does abort — and only in production');
/** Run assertProductionConfig in its own process and collect the exit code. */
function runAssert(nodeEnv, env) {
  const code = `
    import { assertProductionConfig } from './src/core/startup-checks';
    assertProductionConfig({ env: ${JSON.stringify({ ...env, NODE_ENV: nodeEnv })} });
    console.log('CONTINUED');
  `;
  return spawnSync('npx', ['tsx', '-e', code], { encoding: 'utf8' });
}
const prodBroken = runAssert('production', { EUDIPLO_BASE_URL: '' });
check('production + a gap -> exit code 1', prodBroken.status === 1, `status=${prodBroken.status}`);
check('production + a gap -> does NOT continue', !String(prodBroken.stdout).includes('CONTINUED'), prodBroken.stdout);
check('the message names the missing variable', /EUDIPLO_BASE_URL/.test(prodBroken.stderr || ''), prodBroken.stderr);

const prodOk = runAssert('production', OK_ENV);
check('production + complete -> continues', prodOk.status === 0 && String(prodOk.stdout).includes('CONTINUED'), `status=${prodOk.status} ${prodOk.stdout}${prodOk.stderr}`);

const devBroken = runAssert('development', { EUDIPLO_BASE_URL: '' });
check('development + a gap -> exit code 0', devBroken.status === 0, `status=${devBroken.status}`);
check('development + a gap -> continues', String(devBroken.stdout).includes('CONTINUED'), devBroken.stdout);
check('development warns anyway', /startup would abort here/i.test(devBroken.stderr || ''), devBroken.stderr);

console.log('\nRunning without a verifier: explicit, and only then');
{
  // EUDI_VERIFIER=none replaces the verifier variables. It must be ASKED for: missing verifier
  // values without the switch still abort, or a typo would turn a real deployment anonymous.
  const none = problems({ EUDI_VERIFIER: 'none' });
  check('none without any EUDIPLO_* -> nothing fatal', fatalNames(none).length === 0, JSON.stringify(none));
  check('none is announced, as a warning', none.some((p) => p.variable === 'EUDI_VERIFIER' && !p.fatal), JSON.stringify(none));
  check('without the switch the gap is still fatal', fatalNames(problems({})).includes('EUDIPLO_BASE_URL'));
  check('an unknown value is fatal', fatalNames(problems({ ...OK_ENV, EUDI_VERIFIER: 'off' })).includes('EUDI_VERIFIER'));
  check('"eudiplo" is the explicit default', fatalNames(problems({ ...OK_ENV, EUDI_VERIFIER: 'eudiplo' })).length === 0);
  check('none + a host gate is fatal', fatalNames(problems({ EUDI_VERIFIER: 'none', EUDI_HOST_ALLOWLIST: 'Erika Mustermann' })).some((v) => /EUDI_HOST_ALLOWLIST/.test(v)));
  check('the other checks still run with none', fatalNames(problems({ EUDI_VERIFIER: 'none', TURN_SECRET: '__set_me__' })).includes('TURN_SECRET'));
  const prodNone = runAssert('production', { EUDI_VERIFIER: 'none' });
  check('production + none -> starts', prodNone.status === 0 && String(prodNone.stdout).includes('CONTINUED'), `status=${prodNone.status} ${prodNone.stderr}`);
  check('the missing-verifier message names the way out', /EUDI_VERIFIER=none/.test(problems({}).find((p) => p.variable === 'EUDIPLO_BASE_URL')?.problem || ''));
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
