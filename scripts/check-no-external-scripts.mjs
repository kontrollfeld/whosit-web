// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * No code from anyone else's server.
 *
 * A script pulled from a CDN — unpinned, without an `integrity` attribute — on the very page that
 * builds the wallet request would let whoever controls that CDN path inject script and rewrite the
 * presentation offer while the user believes they are identifying themselves to the operator.
 * Every visitor would also be announced to a third party, contradicting the privacy notice, and
 * where such CDNs are blocked the QR code would simply not appear.
 *
 * Fonts are self-hosted for the same reason, and pdfjs, pkijs and signpdf live in
 * public/vendor/. This check makes the rule hold: everything executable is served from the
 * instance's own origin.
 *
 * Checked: <script src>, <link href> for stylesheets, CSS @import, and runtime fetch/import of
 * remote code. NOT checked: ordinary links (<a href>) — a link is navigation the user chooses,
 * not code the page executes.
 *
 * Usage: npm run check:no-external-scripts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC = join(ROOT, 'public');

/** Fetching a resource FROM a remote host, by mechanism. */
const RULES = [
  { what: 'script from a remote host', re: /<script[^>]+src\s*=\s*["']https?:\/\/[^"']+/gi },
  { what: 'stylesheet from a remote host', re: /<link[^>]+href\s*=\s*["']https?:\/\/[^"']+\.css/gi },
  { what: 'CSS @import from a remote host', re: /@import[^;]*["']https?:\/\//gi },
  { what: 'remote module import', re: /\bimport\s*\(\s*["']https?:\/\//gi },
];

/** Our own origin in example markup is fine — it documents how integrators embed the widget. */
const ALLOWED = [/https?:\/\/id-call\.eu\//];

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? files(full) : [full];
  }).filter((f) => /\.(html|js|css|mjs)$/.test(f));
}

let failures = 0;
for (const file of files(PUBLIC)) {
  const text = readFileSync(file, 'utf8');
  for (const { what, re } of RULES) {
    for (const hit of text.match(re) || []) {
      if (ALLOWED.some((a) => a.test(hit))) continue;
      console.log(`  ✗ ${relative(ROOT, file)}: ${what}\n      ${hit.slice(0, 110)}`);
      failures++;
    }
  }
}

if (failures) {
  console.log(`\n${failures} external code reference(s). Vendor the file under public/vendor/ instead —`);
  console.log('see public/vendor/qrcodejs/README.md for the pattern (file, LICENSE, provenance, checksum).');
  process.exit(1);
}
console.log('  ✓ everything executable is served from our own origin');
