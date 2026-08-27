// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Render the capability list into `.env.selfhost.example` from the registry.
 *
 * Why generated and not written by hand: a Markdown table listing the same capabilities drifted
 * from `src/core/features.ts` three times (`multi-credential` was wrong for ten days,
 * `channel-binding` was missing entirely), which is why FEATURES.md was abolished. Putting the
 * same list into an env template by hand would repeat that mistake, with a worse consequence:
 * a self-hoster reading it has no way to notice, and would switch off a capability that is not
 * called that any more — silently, because an unknown id is ignored.
 *
 * The registry is parsed from the source rather than imported, like check-licence-boundary.mjs:
 * these scripts must run without a build step.
 *
 *   npm run env:features         write the block
 *   npm run check:env-features   fail if the block is stale (runs in CI)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src', 'core', 'features.ts');
const ENV = join(root, '.env.selfhost.example');
const BEGIN = '# >>> capabilities — generated from src/core/features.ts, do not edit by hand';
const END = '# <<< end of generated block';

const src = readFileSync(SRC, 'utf8');

const features = [...src.matchAll(
  /\{\s*id:\s*'([^']+)',\s*title:\s*'((?:[^'\\]|\\.)*)',\s*edition:\s*'(community|pro)'/g,
)].map(([, id, title, edition]) => ({ id, title: title.replace(/\\'/g, "'"), edition }));

const unswitchable = (src.match(/export const UNSWITCHABLE[^=]*=\s*\[([\s\S]*?)\]/) || [, ''])[1]
  .match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [];

if (features.length < 10 || unswitchable.length === 0) {
  console.error('Could not parse the registry — has the shape of features.ts changed?');
  process.exit(1);
}

const pad = Math.max(...features.map((f) => f.id.length)) + 2;
const line = (f) => `#   ${f.id.padEnd(pad)}${f.title}`;
const group = (title, list) => (list.length ? [`# ${title}`, ...list.map(line), '#'] : []);

const block = [
  BEGIN,
  '#',
  ...group('ALWAYS ON — cannot be switched off: the product itself, and the guarantees:',
    features.filter((f) => unswitchable.includes(f.id))),
  ...group('INCLUDED IN THIS EDITION — switch off any of these with EUDI_FEATURES_OFF:',
    features.filter((f) => f.edition === 'community' && !unswitchable.includes(f.id))),
  ...group('COMMERCIAL LICENCE REQUIRED — inactive here, listed so you know what exists:',
    features.filter((f) => f.edition === 'pro')),
  END,
].join('\n');

const env = readFileSync(ENV, 'utf8');
const i = env.indexOf(BEGIN);
const j = env.indexOf(END);
if (i === -1 || j === -1) {
  console.error(`Markers missing in ${ENV} — expected:\n${BEGIN}\n${END}`);
  process.exit(1);
}
const next = env.slice(0, i) + block + env.slice(j + END.length);

if (process.argv.includes('--check')) {
  if (next !== env) {
    console.error('.env.selfhost.example is out of date with src/core/features.ts.');
    console.error('Fix: npm run env:features, then commit the file.');
    process.exit(1);
  }
  console.log(`.env.selfhost.example matches the registry (${features.length} capabilities).`);
} else {
  writeFileSync(ENV, next);
  console.log(`.env.selfhost.example updated — ${features.length} capabilities, ${unswitchable.length} unswitchable.`);
}
