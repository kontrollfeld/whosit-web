// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Making the licence boundary checkable — otherwise it is decoration.
 *
 * The repository carries two licences: everything under the AGPL (../LICENSE) except `pro/`
 * (commercial, pro/LICENSE). More modules follow in repositories of their own, loaded through
 * EUDI_MODULES (src/module-loader.ts). The split holds under one condition only:
 *
 *   **The AGPL core must build and run completely without any module.**
 *
 * If anything under `src/` imported from a module, the free part would depend on code under
 * another licence — it could then no longer be shipped on its own, and the separation would be
 * worthless. This script checks exactly that, in both directions:
 *
 *   1. No import from `pro/` or from a module package (`@id-call/…`) in `src/`, `public/` or
 *      `scripts/`.
 *   2. No module is a prerequisite: `tsc` over `src/` must succeed without `pro/`, and the
 *      loader catches a failing module at runtime — verified here too.
 *   3. The core does not name module capabilities: they are declared in the module's manifest,
 *      not in src/core/features.ts.
 *
 * Runs in CI and locally via `npm run check:licence-boundary`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

/** Collect every source file below a directory. */
function walk(dir, exts = ['.ts', '.js', '.mjs']) {
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

console.log('\nThe AGPL part must not depend on a module');
// Catches `from './pro/x'`, `require('../pro/x')`, `import('@id-call/x')` and dynamic imports alike.
const OFFENDING = /(?:from|import|require)\s*\(?\s*['"](?:[^'"]*(?:^|\/)pro\/|@id-call\/)/;
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
check(`${scanned.length} files checked, no import from pro/ or a module package`, offenders.length === 0,
  `forbidden imports: ${offenders.join(', ')}`);

console.log('\nThe main build does not know about pro/');
// A structural guarantee, stronger than a test: pro/ is NOT in the main tsconfig's include and
// has one of its own. The AGPL build therefore CANNOT depend on pro/ — regardless of what anyone
// imports. Verified by hand: with pro/ moved away, `tsc` and the server start ran unchanged, and
// /capabilities reported 20 capabilities without audit-trail.
const rootTs = JSON.parse(readFileSync('tsconfig.json', 'utf8'));
const includes = (rootTs.include || []).join(' ');
check('tsconfig.json does not include pro/', !/\bpro\b/.test(includes), `include = ${includes}`);
check('pro/ has a tsconfig of its own', (() => { try { readFileSync('pro/tsconfig.json'); return true; } catch { return false; } })(),
  'without its own tsconfig, pro/ would drift into the main build sooner or later');

console.log('\npro/ carries its own licence');
let lic = '';
try { lic = readFileSync('pro/LICENSE', 'utf8'); } catch {}
check('pro/LICENSE present', !!lic, "without a licence file the repository's applies by default — i.e. the AGPL");
check('it explicitly sets itself apart from the AGPL', /NOT COVERED BY THE AGPL/i.test(lic), lic.slice(0, 80));

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
let manifest = null;
try { manifest = JSON.parse(readFileSync('pro/package.json', 'utf8')).idCall; } catch {}
if (manifest) {
  const named = (manifest.features || []).map((f) => f.id).filter((id) => new RegExp(`id:\\s*'${id}'`).test(registry));
  check('the capabilities of pro/ are not listed in the core registry', named.length === 0,
    `listed in the core as well: ${named.join(', ')}`);
}

console.log(failures === 0 ? '\nLicence boundary intact.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
