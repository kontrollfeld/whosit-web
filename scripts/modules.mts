// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which modules this instance is configured with, and do they fit — without starting the server.
 *
 *   npm run modules              list them (EUDI_MODULES / EUDI_PRO_MODULE from the environment)
 *   npm run modules -- check     the same, but exit 1 if any module would not load
 *
 * Reads the manifests only and runs no module code, so it is safe to run in CI and against an
 * image before it goes live. What it cannot know is whether a module's `register()` will succeed
 * — that is decided at startup, where production aborts on failure (see src/module-loader.ts).
 *
 * The counterpart of `drush pm:list` / `drush status` — except that enabling and disabling is not
 * a command here, but the configuration itself (EUDI_MODULES), versioned with the instance.
 */
import { moduleSpecs, readManifests } from '../src/module-loader';
import { MODULE_API_VERSION } from '../src/core/modules';

const check = process.argv.includes('check');
const { specs, legacy } = moduleSpecs();

console.log(`Core module API: ${MODULE_API_VERSION}`);
if (specs.length === 0) {
  console.log('No modules configured (EUDI_MODULES is empty) — the core runs on its own.');
  process.exit(0);
}
if (legacy) console.log('Note: EUDI_PRO_MODULE is read as one more entry of EUDI_MODULES — prefer the latter.');

const { reads } = readManifests(specs);
for (const r of reads) {
  if (r.manifest && !r.error) {
    const m = r.manifest;
    console.log(`  ✓ ${m.id}@${m.version}  (${r.spec}, coreApi ${m.coreApi})`);
    for (const f of m.features) console.log(`      ${f.id.padEnd(22)}${f.title}`);
    if (m.clientAliases.length) console.log(`      browser files also under: ${m.clientAliases.map((a) => `/${a}/`).join(', ')}`);
  } else {
    console.log(`  ✗ ${r.spec}: ${r.error}`);
  }
}

const bad = reads.filter((r) => r.error).length;
if (bad) console.log(`\n${bad} module(s) would not load — in production the server would refuse to start.`);
process.exit(check && bad ? 1 : 0);
