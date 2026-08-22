// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The host gate — rules that can be silently wrong.
 *
 * Two directions of failure, both unpleasant:
 *   - TOO STRICT locks out your own staff. Names come from identity documents and from a
 *     configuration file, and the two do not spell them identically (capitalisation, Unicode
 *     form, hyphens). A naive comparison fails on that.
 *   - TOO LAX lets strangers appear as the authority — exactly what the gate is meant to
 *     prevent. Particularly treacherous: a list that is set but unusable, and relied upon.
 *
 * Usage: npm run test:hostgate
 */
import { spawnSync } from 'node:child_process';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

/** Load the module with a given allowlist and ask it questions. */
function gate(allowlist, questions) {
  const code = `
    import { mayHost, hostGateActive, hostGateSize } from './src/host-gate';
    const answers = ${JSON.stringify(questions)}.map(([f, g]) => mayHost(f ?? undefined, g ?? undefined));
    console.log(JSON.stringify({ active: hostGateActive(), count: hostGateSize(), answers }));
  `;
  const r = spawnSync('npx', ['tsx', '-e', code], {
    env: { ...process.env, EUDI_HOST_ALLOWLIST: allowlist },
    encoding: 'utf8',
  });
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); }
  catch { return { _raw: r.stdout, _err: r.stderr }; }
}

console.log('\nWithout a list nothing changes');
const off = gate('', [['Mustermann', 'Erika'], [null, null]]);
check('Sperre inaktiv', off.active === false, JSON.stringify(off));
check('anyone may host', JSON.stringify(off.answers) === '[true,true]', JSON.stringify(off.answers));

console.log('\nWith a list: matches and non-matches');
const LIST = 'Mustermann,Erika; Schmidt,Hans-Peter; Yılmaz,Ayşe';
const a = gate(LIST, [
  ['Mustermann', 'Erika'],     // exakt
  ['Schmidt', 'Hans-Peter'],   // mit Bindestrich
  ['Yılmaz', 'Ayşe'],          // non-ASCII
  ['Müller', 'Michael'],       // not listed
  ['Mustermann', 'Hans'],      // richtiger Nachname, falscher Vorname
  ['Schmidt', 'Erika'],        // crossed — must NOT get through
]);
check('Sperre active, 3 Einträge', a.active === true && a.count === 3, JSON.stringify(a));
check('gelistete Person zugelassen', a.answers[0] === true);
check('Bindestrich-Vorname zugelassen', a.answers[1] === true);
check('a non-ASCII name is admitted', a.answers[2] === true);
check('fremde Person abgewiesen', a.answers[3] === false);
check('the right family name alone is not enough', a.answers[4] === false);
check('crossed names are rejected', a.answers[5] === false, 'given and family name must match TOGETHER');

console.log('\nSpellings — this is where a naive comparison locks out the wrong people');
// The NFD case is only a test if the input REALLY is in decomposed form. Hence generated
// programmatically rather than typed: retyping the file would easily turn it into NFC, and the
// check would keep passing without proving anything any more.
const NFD_VORNAME = 'Ayşe'.normalize('NFD');
check('the test input really is NFD (otherwise the following proves nothing)',
  NFD_VORNAME !== NFD_VORNAME.normalize('NFC'),
  `Länge ${NFD_VORNAME.length}, NFC-Länge ${NFD_VORNAME.normalize('NFC').length}`);
const b = gate(LIST, [
  ['mustermann', 'erika'],       // klein
  ['MUSTERMANN', 'ERIKA'],       // groß, wie auf manchen Ausweisen
  ['  Mustermann ', ' Erika  '], // Leerraum
  ['Schmidt', 'Hans Peter'],     // Leerzeichen statt Bindestrich
  ['Yılmaz', NFD_VORNAME], // programmatisch zerlegt, siehe oben
]);
check('Kleinschreibung', b.answers[0] === true);
check('Großschreibung', b.answers[1] === true);
check('umgebender Leerraum', b.answers[2] === true);
check('Leerzeichen statt Bindestrich', b.answers[3] === true);
check('NFD-Variante trifft NFC-Eintrag', b.answers[4] === true, 'Unicode-Normalisierung fehlt');

console.log('\nA missing name is a no, not a wave-through');
const c = gate(LIST, [[null, 'Erika'], ['Mustermann', null], [null, null]]);
check('rejected without a family name', c.answers[0] === false);
check('rejected without a given name', c.answers[1] === false);
check('rejected with no name at all', c.answers[2] === false);

console.log('\nAn unusable list aborts startup');
const broken = spawnSync('npx', ['tsx', '-e',
  `import { assertHostGateOrExit } from './src/host-gate'; assertHostGateOrExit(true);`],
  { env: { ...process.env, EUDI_HOST_ALLOWLIST: 'Mustermann Erika' }, encoding: 'utf8' });
check('an entry without a comma -> exit 1', broken.status === 1, `status=${broken.status}`);
check('the message explains the expected format', /FamilyName,GivenName/.test(broken.stderr || ''), (broken.stderr || '').slice(0, 100));

const withoutName = spawnSync('npx', ['tsx', '-e',
  `import { assertHostGateOrExit } from './src/host-gate'; assertHostGateOrExit(false);`],
  { env: { ...process.env, EUDI_HOST_ALLOWLIST: 'Mustermann,Erika' }, encoding: 'utf8' });
check('a policy without host names -> exit 1', withoutName.status === 1, `status=${withoutName.status}`);
check('the message names the way out', /policy|allowlist/i.test(withoutName.stderr || ''), (withoutName.stderr || '').slice(0, 100));

const empty = spawnSync('npx', ['tsx', '-e',
  `import { assertHostGateOrExit } from './src/host-gate'; assertHostGateOrExit(false); console.log('weiter');`],
  { env: { ...process.env, EUDI_HOST_ALLOWLIST: '' }, encoding: 'utf8' });
check('no abort without a list, even with an anonymous host', empty.status === 0, `status=${empty.status}`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
