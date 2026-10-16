// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * WRP policies — the properties that can be silently wrong.
 *
 * Ever since policies became selectable (`EUDI_WRP_POLICY`), three things hang on them that
 * nobody notices when they tip over:
 *   1. An instance WITHOUT the variable must behave exactly as before.
 *   2. What a policy permits must not simultaneously be published as "waived" — /wrp-policy is
 *      meant as a verifiable commitment, not as prose.
 *   3. An unknown policy name must abort startup instead of quietly falling back to the default
 *      registration.
 *   3b. A NARROWING (`EUDI_WRP_NARROW`, added for hosted white-label instances) must only ever
 *      subtract. This is the one property of that variable that matters: if it could add, the
 *      attribute whitelist would no longer live in reviewed source but in a deployment's
 *      environment, and the promise at the top of src/wrp-policy.ts would be void.
 *
 * Plus normalisation: mdoc and SD-JWT name the same claims differently. That once made
 * `birth_date` fall through from mdoc only and `address` from SD-JWT only — requested, presented,
 * discarded. Point 4 pins that down.
 *
 * Usage: npm run test:wrp
 */
import { spawn, spawnSync } from 'node:child_process';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

/** Fetch the policy description from ONE process, without starting a server. */
function describe(env) {
  const r = spawnSync('npx', ['tsx', '-e', `
    import { policyDescriptor, activePolicyName } from './src/wrp-policy';
    console.log(JSON.stringify({ name: activePolicyName(), ...policyDescriptor() }));
  `], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const line = (r.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(line); } catch { return { _raw: r.stdout, _err: r.stderr }; }
}

console.log('\nThe default policy is unchanged');
const std = describe({ EUDI_WRP_POLICY: '' });
check('the name is p2p-call', std.name === 'p2p-call', std.name);
check('permits exactly the four base attributes',
  JSON.stringify(std.allowedAttributes) === JSON.stringify(['given_name', 'family_name', 'age_over_18', 'pseudonym_id']),
  JSON.stringify(std.allowedAttributes));
check('reports date of birth, country and address as waived',
  JSON.stringify(std.retiredAttributes) === JSON.stringify(['birth_date', 'issuing_country', 'address']),
  JSON.stringify(std.retiredAttributes));
check('does NOT ask the wallet for pseudonym_id',
  !std.walletRequestable.includes('pseudonym_id'), JSON.stringify(std.walletRequestable));

console.log('\nThe public-body policy publishes the truth');
const kommune = describe({ EUDI_WRP_POLICY: 'kommune-buergerservice' });
check('Name übernommen', kommune.name === 'kommune-buergerservice', kommune.name);
check('address is permitted', kommune.allowedAttributes.includes('address'), JSON.stringify(kommune.allowedAttributes));
check('address no longer counts as waived',
  !kommune.retiredAttributes.includes('address'), JSON.stringify(kommune.retiredAttributes));
check('permitted and waived never overlap',
  !kommune.allowedAttributes.some((a) => kommune.retiredAttributes.includes(a)),
  `${JSON.stringify(kommune.allowedAttributes)} ∩ ${JSON.stringify(kommune.retiredAttributes)}`);
check('its own purpose is published',
  kommune.purposeId !== std.purposeId && !!kommune.purposeId, kommune.purposeId);

// The template's earlier name stays valid as an alias — otherwise an already-configured
// EUDI_WRP_POLICY would trigger a startup abort (assertPolicyOrExit lets no unknown name
// through, which is right, but here it would be a self-inflicted outage).
console.log('\nThe old policy name stays valid as an alias');
const alias = describe({ EUDI_WRP_POLICY: 'lhd-buergerservice' });
check('the alias is accepted, with no fallback to the default policy',
  alias.name === 'lhd-buergerservice', alias.name);
check('Alias liefert dieselbe Attributmenge',
  JSON.stringify(alias.allowedAttributes) === JSON.stringify(kommune.allowedAttributes),
  `${JSON.stringify(alias.allowedAttributes)} vs ${JSON.stringify(kommune.allowedAttributes)}`);
check('Alias liefert denselben Zweck', alias.purposeId === kommune.purposeId, alias.purposeId);

// `EUDI_WRP_NARROW` exists so a hosted instance can serve one customer's purpose, which is
// usually narrower than the registration it runs under. Everything below tests the same
// question from different sides: can it ever result in MORE being asked of a wallet?
console.log('\nNarrowing subtracts — and can never add');
const narrowed = describe({ EUDI_WRP_POLICY: 'kommune-buergerservice', EUDI_WRP_NARROW: 'given_name,family_name' });
check('only the named attributes remain',
  JSON.stringify(narrowed.allowedAttributes) === JSON.stringify(['given_name', 'family_name']),
  JSON.stringify(narrowed.allowedAttributes));
check('the narrowing is declared as such', narrowed.narrowed === true, String(narrowed.narrowed));
check('what the registration permits is still published, unnarrowed',
  JSON.stringify(narrowed.registrationPermits) === JSON.stringify(kommune.allowedAttributes),
  `${JSON.stringify(narrowed.registrationPermits)} vs ${JSON.stringify(kommune.allowedAttributes)}`);
// The published waiver has to follow, or /wrp-policy would keep claiming an attribute is in use
// that this instance gave up — the endpoint would lie exactly where it is meant to be checkable.
check('what was narrowed away is published as waived',
  ['birth_date', 'address', 'pseudonym_id'].every((a) => narrowed.retiredAttributes.includes(a)),
  JSON.stringify(narrowed.retiredAttributes));
check('permitted and waived never overlap',
  !narrowed.allowedAttributes.some((a) => narrowed.retiredAttributes.includes(a)),
  JSON.stringify(narrowed.allowedAttributes));
// The point of the whole exercise: nothing outside the policy can get in, whatever the order or
// spelling in the variable.
check('a narrowing is always a SUBSET of the policy',
  narrowed.allowedAttributes.every((a) => kommune.allowedAttributes.includes(a)),
  JSON.stringify(narrowed.allowedAttributes));
const reordered = describe({ EUDI_WRP_POLICY: 'kommune-buergerservice', EUDI_WRP_NARROW: 'family_name, given_name' });
check('order and whitespace in the variable change nothing (the EUDIPLO config id hangs on this)',
  JSON.stringify(reordered.allowedAttributes) === JSON.stringify(narrowed.allowedAttributes),
  `${JSON.stringify(reordered.allowedAttributes)} vs ${JSON.stringify(narrowed.allowedAttributes)}`);

console.log('\nAn unusable narrowing aborts startup');
const narrowRuns = [
  ['an attribute the policy does not permit', { EUDI_WRP_POLICY: 'p2p-call', EUDI_WRP_NARROW: 'given_name,address' }, /address/],
  ['an attribute that does not exist at all', { EUDI_WRP_POLICY: 'p2p-call', EUDI_WRP_NARROW: 'lieblingsfarbe' }, /lieblingsfarbe/],
  ['only derived attributes — a wallet prompt with no claim', { EUDI_WRP_POLICY: 'p2p-call', EUDI_WRP_NARROW: 'pseudonym_id' }, /derived/i],
];
for (const [label, env, expect] of narrowRuns) {
  const r = spawnSync('npx', ['tsx', '-e', `import { assertNarrowOrExit } from './src/wrp-policy'; assertNarrowOrExit();`],
    { env: { ...process.env, ...env }, encoding: 'utf8' });
  check(`${label} -> exit 1`, r.status === 1, `status=${r.status}`);
  check(`${label}: the message says what is wrong`, expect.test(r.stderr || ''), (r.stderr || '').slice(0, 160));
}
// Without the variable this must be a complete no-op, or every existing instance would be at
// risk from a check written for a feature it does not use.
const noNarrow = spawnSync('npx', ['tsx', '-e', `import { assertNarrowOrExit } from './src/wrp-policy'; assertNarrowOrExit(); console.log('weiter');`],
  { env: { ...process.env, EUDI_WRP_POLICY: 'p2p-call', EUDI_WRP_NARROW: '' }, encoding: 'utf8' });
check('no narrowing -> no abort', noNarrow.status === 0 && /weiter/.test(noNarrow.stdout || ''), `status=${noNarrow.status}`);
check('an instance without the variable is unchanged',
  JSON.stringify(describe({ EUDI_WRP_POLICY: '' }).allowedAttributes) === JSON.stringify(std.allowedAttributes),
  'default drifted');
check('and does not declare itself narrowed', std.narrowed === false, String(std.narrowed));

console.log('\nAn unknown policy aborts startup');
const bad = spawnSync('npx', ['tsx', '-e', `import './src/wrp-policy'; import { assertPolicyOrExit } from './src/wrp-policy'; assertPolicyOrExit();`],
  { env: { ...process.env, EUDI_WRP_POLICY: 'does-not-exist' }, encoding: 'utf8' });
check('Exit-Code 1', bad.status === 1, `status=${bad.status}`);
check('the message names the wrong name', /does-not-exist/.test(bad.stderr || ''), (bad.stderr || '').slice(0, 120));
check('the message names the known names', /p2p-call/.test(bad.stderr || ''), (bad.stderr || '').slice(0, 120));

console.log('\nNormalisation: mdoc and SD-JWT yield the same result');
const norm = spawnSync('npx', ['tsx', '-e', `
  import { normalizeClaims } from './src/credential-profiles';
  const wrap = (v) => ({ status: 'completed', credentials: [{ values: [v] }] });
  const mdoc = wrap({ given_name:'Erika', family_name:'M', birth_date:'1984-01-26', age_over_18:true,
    resident_street:'Musterstr. 1', resident_postal_code:'10115', resident_city:'Berlin', resident_country:'DE' });
  const sdjwt = wrap({ given_name:'Erika', family_name:'M', birthdate:'1984-01-26', age_equal_or_over:{'18':true},
    address:{ street_address:'Musterstr. 1', locality:'Berlin', postal_code:'10115', country:'DE' } });
  console.log(JSON.stringify({ mdoc: normalizeClaims(mdoc), sdjwt: normalizeClaims(sdjwt) }));
`], { env: { ...process.env, EUDI_WRP_POLICY: 'kommune-buergerservice' }, encoding: 'utf8' });
let n = {};
try { n = JSON.parse((norm.stdout || '').trim().split('\n').pop()); } catch { /* unten sichtbar */ }
check('beide Formate liefern dieselben Schlüssel',
  JSON.stringify(Object.keys(n.mdoc || {}).sort()) === JSON.stringify(Object.keys(n.sdjwt || {}).sort()),
  `${JSON.stringify(n.mdoc)} vs ${JSON.stringify(n.sdjwt)}`);
check('Geburtsdatum kommt aus BEIDEN durch',
  n.mdoc?.birth_date === '1984-01-26' && n.sdjwt?.birth_date === '1984-01-26',
  `${n.mdoc?.birth_date} / ${n.sdjwt?.birth_date}`);
check('Anschrift kommt aus BEIDEN durch, in gleicher Form',
  JSON.stringify(n.mdoc?.address) === JSON.stringify(n.sdjwt?.address) && !!n.mdoc?.address,
  `${JSON.stringify(n.mdoc?.address)} vs ${JSON.stringify(n.sdjwt?.address)}`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
