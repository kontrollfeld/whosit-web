// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Making the licence boundary checkable — otherwise it is decoration.
 *
 * This repository is AGPL-3.0-or-later, all of it. The commercially licensed features are
 * modules in repositories of their own (@whosit/audit-trail, @whosit/qes-csc, @whosit/qes-device),
 * loaded through EUDI_MODULES (src/module-loader.ts). Until 2026-10 a pro/ directory lived here
 * under a second licence; it is gone, and these checks keep it that way:
 *
 *   1. No file in the repository carries the commercial licence identifier.
 *   2. Nothing under src/, scripts/ or public/ imports from a module package (`@whosit/…`) or a
 *      pro/ directory — the core builds and runs without any module.
 *   3. The loader does not require a module, and the core's registry names no module capability:
 *      modules declare their own.
 *
 * Runs in CI and locally via `npm run check:licence-boundary`.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

/** Collect every source file below a directory. */
function walk(dir, exts = ['.ts', '.js', '.mjs', '.mts']) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e);
    if (e === 'node_modules' || e === 'dist' || e === 'vendor') continue;
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((x) => e.endsWith(x))) out.push(full);
  }
  return out;
}

console.log('\nThis repository is AGPL only');
// Tracked files only: an installed module under .modules/ (CI) is not part of the repository.
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
// The SPDX licence line itself that names the commercial licence (also in the `key = "…"` form
// of REUSE.toml) — not a mere mention, which documentation and this very check need.
const COMMERCIAL = /SPDX-License-Identifier\s*[:=]\s*"?LicenseRef-Commercial/;
const commercial = tracked.filter((f) => {
  try { return COMMERCIAL.test(readFileSync(f, 'utf8')); } catch { return false; }
});
check(`${tracked.length} tracked files, none commercially licensed`, commercial.length === 0,
  `marked commercially licensed: ${commercial.join(', ')} — commercially licensed code belongs in a module repository`);
check('no pro/ directory', !existsSync('pro'), 'pro/ is back — the commercially licensed features are modules now');

console.log('\nThe core does not depend on a module');
// Catches `from './pro/x'`, `require('../pro/x')`, `import('@whosit/x')` and dynamic imports alike.
const OFFENDING = /(?:from|import|require)\s*\(?\s*['"](?:[^'"]*(?:^|\/)pro\/|@whosit\/)/;
const scanned = [...walk('src'), ...walk('scripts'), ...walk('public')];
const offenders = [];
for (const f of scanned) {
  const text = readFileSync(f, 'utf8');
  for (const [i, line] of text.split('\n').entries()) {
    // Comments do not count — that is where the reason for the prohibition is written.
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    if (OFFENDING.test(code)) offenders.push(`${relative('.', f)}:${i + 1}`);
  }
}
check(`${scanned.length} files checked, no import of a module`, offenders.length === 0,
  `forbidden imports: ${offenders.join(', ')}`);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => d.startsWith('@whosit/'));
check('no module in package.json', deps.length === 0, `dependencies on modules: ${deps.join(', ')}`);
check('the licence is AGPL-3.0-or-later', pkg.license === 'AGPL-3.0-or-later', pkg.license);

console.log('\nThe loader does not require a module');
const loader = readFileSync('src/module-loader.ts', 'utf8');
check('importing a module is wrapped in try/catch', /try\s*\{[\s\S]*await import\(/.test(loader),
  'a failing module would crash startup instead of being reported');
check('without configured modules it returns the defaults immediately',
  /if \(specs\.length === 0\) return defaults;/.test(loader), 'the Community path is not guaranteed');

console.log('\nThe core does not name module capabilities');
const registry = readFileSync('src/core/features.ts', 'utf8');
check("no `edition: 'pro'` entry in src/core/features.ts", !/edition:\s*'pro'/.test(registry),
  'a capability whose code lives in a module belongs in that module\'s manifest');
for (const id of ['audit-trail', 'qes-csc', 'qes-device']) {
  check(`${id} is not in the core registry`, !new RegExp(`id:\\s*'${id}'`).test(registry), `${id} is listed in the core`);
}

console.log(failures === 0 ? '\nLicence boundary intact.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
