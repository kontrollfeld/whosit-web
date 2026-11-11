// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Channel binding, the SDP half: an offer or answer of a bound participant must establish the
 * connection with exactly the key the wallet saw. Every fingerprint line counts.
 *
 * Usage: npm run test:sdp-binding
 */
import { spawnSync } from 'node:child_process';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const F = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const G = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';
const cases = {
  'the bound key alone': `v=0\r\na=fingerprint:sha-256 ${F}\r\nm=audio 9 x\r\na=fingerprint:sha-256 ${F}\r\n`,
  'lower-case hex of the bound key': `v=0\r\na=fingerprint:sha-256 ${F.toLowerCase()}\r\n`,
  'no fingerprint at all': 'v=0\r\nm=audio 9 x\r\n',
  'only a sha-384 line': `v=0\r\na=fingerprint:sha-384 ${G}:${G.slice(0, 47)}\r\n`,
  'a second, different sha-256 line': `v=0\r\na=fingerprint:sha-256 ${F}\r\nm=audio 9 x\r\na=fingerprint:sha-256 ${G}\r\n`,
  'the bound key plus a sha-512 line': `v=0\r\na=fingerprint:sha-256 ${F}\r\na=fingerprint:sha-512 ${G}\r\n`,
  'another key only': `v=0\r\na=fingerprint:sha-256 ${G}\r\n`,
};
const code = `
  import { sdpMatchesBinding } from './src/channel-binding';
  const cases = ${JSON.stringify(cases)};
  console.log(JSON.stringify(Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, sdpMatchesBinding(v, ${JSON.stringify(F)})]))));
`;
const r = spawnSync('npx', ['tsx', '-e', code], { encoding: 'utf8', env: { ...process.env, EUDI_CHANNEL_BINDING: 'on' } });
let got = {};
try { got = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { console.error(r.stdout, r.stderr); failures++; }

console.log('\nAccepted');
check('the bound key on every line', got['the bound key alone'] === true, JSON.stringify(got));
check('hex case does not matter', got['lower-case hex of the bound key'] === true);
console.log('\nRefused (fail closed)');
for (const k of ['no fingerprint at all', 'only a sha-384 line', 'a second, different sha-256 line', 'the bound key plus a sha-512 line', 'another key only']) {
  check(k, got[k] === false, String(got[k]));
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
