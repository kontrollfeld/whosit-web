// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where the `qes-device` module is, for the two end-to-end tests that need it
 * (test-qes-device.mjs, test-qes-pairing.mjs).
 *
 * The module is not part of this repository — it is commercially licensed and released on its
 * own as @whosit/qes-device. These tests check the core and the module TOGETHER, down to a valid
 * PAdES signature, so they need a copy of it:
 *
 *   1. WHOSIT_QES_DEVICE_MODULE — set by the GitLab CI, which installs the package from the
 *      modules registry with its job token;
 *   2. ../whosit-module-qes-device — a sibling checkout, for local development (built: npm run build);
 *   3. ./.modules/node_modules/@whosit/qes-device — an installed copy.
 *
 * Without one, the test says so and exits 0: a contributor without access to the module (the
 * public mirror's checks) still gets a green suite for everything that is theirs to change. The
 * core half of the flow that does not need the module — the pairing relay — is still exercised.
 */
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function qesDeviceModule() {
  const candidates = [
    process.env.WHOSIT_QES_DEVICE_MODULE,
    join(root, '..', 'whosit-module-qes-device'),
    join(root, '.modules', 'node_modules', '@whosit', 'qes-device'),
  ].filter(Boolean).map((p) => resolve(p));
  return candidates.find((d) => existsSync(join(d, 'dist', 'index.js')) && existsSync(join(d, 'client', 'device-local.js'))) || null;
}

/** The module's directory, or end the test as skipped. */
export function requireQesDeviceModule(testName) {
  const dir = qesDeviceModule();
  if (!dir) {
    console.log(`\n↷ ${testName} skipped: the qes-device module is not available here.`);
    console.log('  It is not part of this repository (commercial licence). Set WHOSIT_QES_DEVICE_MODULE to an');
    console.log('  installed copy, or check out whosit-module-qes-device next to this repository and build it.');
    process.exit(0);
  }
  return dir;
}

/** Import one of the module's browser files (client/<file>) into this Node process. */
export function importClient(dir, file) {
  return import(pathToFileURL(join(dir, 'client', file)).href);
}
