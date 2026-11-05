// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The operator's choices for the call setup (src/operator-ui.ts) and the client's attribute list.
 *
 * Three things have to hold:
 *
 *   1. The file never widens anything. Attributes outside the instance's policy are dropped before
 *      the client sees them, and wording that could be markup makes the whole file invalid.
 *   2. Without a file, /capabilities says `ui: null` and nothing changes.
 *   3. The browser knows every attribute a choosable policy may ask for. It keeps a mirror of the
 *      attributes for labels and icons; a policy whose attributes are missing there can be ordered
 *      and runs, but its setup only offers the ones the mirror knows — which is how an instance on
 *      the tenant-screening policy once could ask for names only.
 *
 * Usage: npm run test:operatorui
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOperatorUi } from '../src/operator-ui.ts';
import { policyCatalog } from '../src/wrp-policy.ts';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const MIETE = ['given_name', 'family_name', 'birth_date', 'address', 'pseudonym_id'];
const P2P = ['given_name', 'family_name', 'age_over_18', 'pseudonym_id'];
const DATEI = {
  vorauswahl: { anfragen: ['given_name', 'family_name', 'birth_date', 'address'], teilen: ['family_name'] },
  schnellwahl: [
    { name: { de: 'Mieterprüfung', en: 'Tenant check' }, angaben: ['given_name', 'family_name', 'birth_date', 'address'] },
    { name: { de: 'Nur Name', en: 'Name only' }, angaben: ['given_name', 'family_name'] },
  ],
  texte: { de: { 'Was soll dein Gast dir zeigen?': 'Was soll der Mietinteressent dir zeigen?' }, en: { 'Was soll dein Gast dir zeigen?': 'What should the prospective tenant show you?' } },
};

console.log('\nThe file, checked against the policy');
{
  const r = parseOperatorUi(DATEI, MIETE);
  check('a valid file is taken as it is', 'ui' in r && r.ui.vorauswahl.anfragen.length === 4 && r.ui.schnellwahl.length === 2 && r.ui.texte.en['Was soll dein Gast dir zeigen?'].startsWith('What'), JSON.stringify(r));
  const eng = parseOperatorUi(DATEI, P2P);
  check('on a narrower policy the extra attributes are dropped, not passed on',
    'ui' in eng && eng.ui.vorauswahl.anfragen.join() === 'given_name,family_name' && eng.ui.schnellwahl.every((s) => !s.angaben.includes('birth_date')), JSON.stringify(eng));
  const leer = parseOperatorUi({ schnellwahl: [{ name: { de: 'Nur Anschrift' }, angaben: ['address'] }] }, P2P);
  check('a quick pick left empty by that disappears', 'ui' in leer && leer.ui.schnellwahl.length === 0, JSON.stringify(leer));
  for (const [fall, roh] of [
    ['markup in a text', { texte: { de: { Gast: '<b>Kunde</b>' } } }],
    ['an ampersand (an entity) in a text', { texte: { de: { Gast: 'Kunde &amp; Co' } } }],
    ['markup in a quick-pick name', { schnellwahl: [{ name: { de: '<img src=x>' }, angaben: ['given_name'] }] }],
    ['a line break in a text', { texte: { de: { Gast: 'Kunde\nzwei' } } }],
    ['an unknown field', { farbe: 'rot' }],
    ['a quick pick without a German name', { schnellwahl: [{ name: { en: 'Name' }, angaben: ['given_name'] }] }],
    ['too many quick picks', { schnellwahl: Array.from({ length: 5 }, () => ({ name: { de: 'x' }, angaben: ['given_name'] })) }],
    ['an attribute name that is not one', { vorauswahl: { anfragen: ['given name'] } }],
  ]) {
    const r2 = parseOperatorUi(roh, MIETE);
    check(`refused as a whole: ${fall}`, 'fehler' in r2, JSON.stringify(r2));
  }
}

console.log('\nThe browser knows every attribute a policy may ask for');
{
  const app = readFileSync('public/app.js', 'utf8');
  const block = app.slice(app.indexOf('const ATTRIBUTES = ['), app.indexOf('];', app.indexOf('const ATTRIBUTES = [')));
  const bekannt = new Set([...block.matchAll(/key: '([a-z_0-9]+)'/g)].map((m) => m[1]));
  for (const p of policyCatalog().filter((x) => x.status !== 'template')) {
    const fehlt = p.attributes.filter((a) => !bekannt.has(a));
    check(`${p.policyId}: every attribute has a label in public/app.js`, fehlt.length === 0, `missing: ${fehlt.join(', ')}`);
  }
  for (const a of ['birth_date', 'address']) {
    check(`${a} has a result renderer`, new RegExp(`case '${a}':`).test(app), 'no case in attrResult');
  }
}

console.log('\n/capabilities');
const servers = [];
function start(port, env) {
  const p = spawn('npx', ['tsx', 'src/server.ts'], {
    detached: true,
    env: { ...process.env, PORT: String(port), EUDIPLO_BASE_URL: 'https://verifier.test.invalid', EUDIPLO_CLIENT_ID: 'test-tenant', EUDIPLO_CLIENT_SECRET: 'test-tenant-secret', EUDI_EDITION: 'community', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  p.stdout.on('data', (d) => log.push(d.toString()));
  p.stderr.on('data', (d) => log.push(d.toString()));
  servers.push(p);
  return log;
}
async function waitFor(port) {
  for (const t0 = Date.now(); Date.now() - t0 < 25000;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on :${port} unreachable`);
}
const caps = async (port) => (await fetch(`http://127.0.0.1:${port}/capabilities`)).json();

try {
  const dir = mkdtempSync(join(tmpdir(), 'operator-ui-'));
  writeFileSync(join(dir, 'oberflaeche.json'), JSON.stringify(DATEI));
  const ohneDatei = mkdtempSync(join(tmpdir(), 'operator-ui-leer-'));
  start(3981, { EUDI_OPERATOR_PAGES: dir, EUDI_WRP_POLICY: 'immobilien-mieterpruefung' });
  start(3982, { EUDI_OPERATOR_PAGES: dir });
  start(3983, { EUDI_OPERATOR_PAGES: ohneDatei });
  const log4 = start(3984, { EUDI_OPERATOR_PAGES: join(dir, 'kaputt') });
  await Promise.all([3981, 3982, 3983, 3984].map(waitFor));

  const miete = await caps(3981);
  check('the tenant-screening instance publishes the file', miete.ui?.schnellwahl?.[0]?.name?.de === 'Mieterprüfung' && miete.ui.vorauswahl.anfragen.includes('address'), JSON.stringify(miete.ui));
  const p2p = await caps(3982);
  check('the standard instance gets the same file without the attributes it may not ask for',
    p2p.ui && !JSON.stringify(p2p.ui.vorauswahl).includes('birth_date') && p2p.ui.schnellwahl.length === 2 && p2p.ui.schnellwahl[0].angaben.join() === 'given_name,family_name', JSON.stringify(p2p.ui));
  const leer = await caps(3983);
  check('without a file: ui is null', leer.ui === null, JSON.stringify(leer.ui));

  // Written after startup: read per request, no restart.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'kaputt'));
  writeFileSync(join(dir, 'kaputt', 'oberflaeche.json'), JSON.stringify({ texte: { de: { Gast: '<script>' } } }));
  const kaputt = await caps(3984);
  check('an invalid file is not half-applied: ui is null', kaputt.ui === null, JSON.stringify(kaputt.ui));
  await new Promise((r) => setTimeout(r, 200));
  check('and the reason is logged', log4.join('').includes('oberflaeche.json wird nicht verwendet'), log4.join('').slice(-300));
  writeFileSync(join(dir, 'kaputt', 'oberflaeche.json'), JSON.stringify({ vorauswahl: { anfragen: ['given_name'] } }));
  const repariert = await caps(3984);
  check('a corrected file counts at the next request, without a restart', repariert.ui?.vorauswahl?.anfragen?.[0] === 'given_name', JSON.stringify(repariert.ui));
} catch (e) {
  check('test ran', false, e.message);
} finally {
  for (const p of servers) { try { process.kill(-p.pid, 'SIGTERM'); } catch {} }
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
