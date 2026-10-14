// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Who is asking — the one thing a white-labelled instance must not get wrong.
 *
 * On a branded instance the page carries the customer's name while the WALLET shows whoever owns
 * the access certificate behind the EUDIPLO tenant. Measured on the first tenant instance in
 * August 2026: page said "LHD Bürgerservice", wallet said "Kontrollfeld", and nothing in the
 * interface bridged the two.
 *
 * What is tested here is not the wording but the DECISION — when disclosure happens, and that no
 * configuration can switch it off. The failure mode is silent by construction: an instance with
 * the sentence suppressed looks better, works identically, and is exactly the state this exists
 * to end.
 *
 * Usage: npm run test:relyingparty
 */
import { spawnSync } from 'node:child_process';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

/** Resolve the disclosure for one environment, in its own process (the module reads env once). */
function rp(env, brand) {
  const code = `
    import { relyingParty } from './src/relying-party';
    console.log(JSON.stringify(relyingParty(${JSON.stringify(brand ?? null)} ?? undefined)));
  `;
  const r = spawnSync('npx', ['tsx', '-e', code], { env: { ...process.env, ...env }, encoding: 'utf8' });
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); }
  catch { return { _raw: r.stdout, _err: r.stderr }; }
}

const OWN = { EUDIPLO_CLIENT_ID: 'stadt-xy' };        // an instance on its own tenant
const DEFAULT_TENANT = { EUDIPLO_CLIENT_ID: '' };      // falls back to kontrollfeld-admin

console.log('\nAn unbranded instance discloses nothing');
// The no-op condition. whosit.eu itself and every self-hosted instance without EUDI_BRAND_NAME
// must be completely unaffected — same standard src/branding.ts holds itself to.
const plain = rp({ ...DEFAULT_TENANT, EUDI_RP_NAME: '' }, undefined);
check('no disclosure without a brand', plain.disclose === false, JSON.stringify(plain));
check('and nobody is named', plain.onBehalfOf === null, JSON.stringify(plain));
const plainNamed = rp({ ...OWN, EUDI_RP_NAME: 'Kontrollfeld GmbH' }, undefined);
check('not even with EUDI_RP_NAME set', plainNamed.disclose === false, JSON.stringify(plainNamed));

console.log('\nBranded + someone else’s certificate = say so');
const managed = rp({ ...DEFAULT_TENANT, EUDI_RP_NAME: 'Kontrollfeld GmbH' }, 'Stadt XY');
check('disclosure required', managed.disclose === true, JSON.stringify(managed));
check('the asking party is named', managed.name === 'Kontrollfeld GmbH', JSON.stringify(managed));
check('and on whose behalf', managed.onBehalfOf === 'Stadt XY', JSON.stringify(managed));

console.log('\nBranded but nobody named — the blunt wording, not silence');
// "Unknown" is not "identical". A missing EUDI_RP_NAME must not read as "the brand asks".
const unnamed = rp({ ...OWN, EUDI_RP_NAME: '' }, 'Stadt XY');
check('still discloses', unnamed.disclose === true, JSON.stringify(unnamed));
check('with no name to offer', unnamed.name === null, JSON.stringify(unnamed));
check('but the brand is still named, so the client can say who it is NOT',
  unnamed.onBehalfOf === 'Stadt XY', JSON.stringify(unnamed));

console.log('\nThe description cannot talk the disclosure away');
// The attack this closes: an operator on someone else's certificate sets EUDI_RP_NAME to the
// CUSTOMER's name, the two match, and the sentence disappears — while the wallet keeps showing
// the certificate holder. The tenant decides, not the description.
const lying = rp({ ...DEFAULT_TENANT, EUDI_RP_NAME: 'Stadt XY' }, 'Stadt XY');
check('default tenant forces disclosure even when the names match',
  lying.disclose === true, JSON.stringify(lying));

console.log('\nIt disappears the honest way: own tenant, own name');
const stufe2 = rp({ ...OWN, EUDI_RP_NAME: 'Stadt XY' }, 'Stadt XY');
check('no disclosure when brand and certificate holder are the same party',
  stufe2.disclose === false, JSON.stringify(stufe2));
check('and nothing is left dangling in the payload', stufe2.onBehalfOf === null, JSON.stringify(stufe2));

console.log('\nThere is no switch to turn it off');
// Every plausible name an operator might reach for. If one of these ever silences the sentence,
// this test is the thing that notices.
for (const v of ['EUDI_RP_DISCLOSE', 'EUDI_RP_HIDE', 'EUDI_FEATURES_OFF']) {
  const off = rp({ ...DEFAULT_TENANT, EUDI_RP_NAME: 'Kontrollfeld GmbH', [v]: v === 'EUDI_FEATURES_OFF' ? 'relying-party' : 'off' }, 'Stadt XY');
  check(`${v} does not suppress it`, off.disclose === true, `${v}: ${JSON.stringify(off)}`);
}

console.log('\nThe client renders it before the wallet is opened');
// Placement is the whole point on a phone, where "open wallet" is the first thing a thumb
// reaches. Checked against the markup so a later reshuffle cannot move it below the button.
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const cta = html.slice(html.indexOf('<div class="auth-cta">'), html.indexOf('id="qrcode"'));
check('the disclosure paragraph exists', /id="rp-disclosure"/.test(cta), 'not inside the auth CTA');
check('it stands BEFORE the same-device wallet link',
  cta.indexOf('id="rp-disclosure"') < cta.indexOf('id="auth-link"'), 'it sits after the wallet button');
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
// style.css warns in place that anything without an explicit `order` silently jumps in front of
// the QR code. The desktop layout must therefore pin this paragraph rather than inherit 0.
check('the desktop layout pins its position explicitly',
  /\.auth-cta \.rp-disclosure \{ order: -1; \}/.test(css), 'no explicit order — see the warning in style.css');
const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
check('it is re-rendered for every offer, not once at startup',
  /applyRelyingPartyDisclosure\(\);[\s\S]{0,200}authRenewBtn/.test(js), 'not called from showAuth');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
