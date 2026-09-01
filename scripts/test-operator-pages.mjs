// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operator pages: whoever runs an instance provides its imprint, not this repository.
 *
 * Until 2026-09-01 `public/impressum.html` named Kontrollfeld GmbH — address, both managing
 * directors, phone number, register entry — and shipped with every self-hosted instance. The
 * operator thereby published the wrong provider (section 5 DDG requires the actual one), and we
 * were named as responsible for instances we neither run nor know of.
 *
 * `EUDI_OPERATOR_PAGES` points at a directory whose pages take precedence. Three properties have
 * to hold, and the third is the one that is easy to lose:
 *
 *   1. With the directory: the operator's page is served, not the placeholder.
 *   2. A page the operator did NOT provide still resolves — to the placeholder, never a 404. An
 *      imprint link that dead-ends is worse than a page saying none was provided.
 *   3. Without the variable NOTHING changes. This must stay a no-op for every instance that does
 *      not use it, the same rule the branding module follows.
 *
 * Usage: npm run test:operatorpages
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT_WITH = 3991;
const PORT_WITHOUT = 3992;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'operator-pages-'));
mkdirSync(join(dir, 'downloads'), { recursive: true });
writeFileSync(join(dir, 'impressum.html'), '<!doctype html><title>x</title>OPERATOR IMPRINT');
writeFileSync(join(dir, 'presse.html'), '<!doctype html><title>x</title>OPERATOR PRESS');
writeFileSync(join(dir, 'downloads', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
// datenschutz.html deliberately absent — that is case 2.

const servers = [];
function start(port, extraEnv) {
  const p = spawn('npx', ['tsx', 'src/server.ts'], {
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      EUDIPLO_BASE_URL: 'https://verifier.test.invalid',
      EUDIPLO_CLIENT_ID: 'test-tenant',
      EUDIPLO_CLIENT_SECRET: 'test-tenant-secret',
      EUDI_EDITION: 'community',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  p.stdout.on('data', (d) => log.push(d.toString()));
  p.stderr.on('data', (d) => log.push(d.toString()));
  servers.push(p);
  return { p, log };
}

async function waitFor(port, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on :${port} unreachable`);
}

const body = async (port, path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, text: await r.text() };
};

try {
  const withPages = start(PORT_WITH, { EUDI_OPERATOR_PAGES: dir });
  const without = start(PORT_WITHOUT, {});
  await waitFor(PORT_WITH);
  await waitFor(PORT_WITHOUT);

  console.log('\nWith a directory configured');
  {
    const imprint = await body(PORT_WITH, '/impressum.html');
    check('the operator imprint is served', imprint.text.includes('OPERATOR IMPRINT'),
      `got: ${imprint.text.slice(0, 80)}`);
    const short = await body(PORT_WITH, '/impressum');
    check('the extensionless path works too', short.text.includes('OPERATOR IMPRINT'),
      `HTTP ${short.status}`);
    const press = await body(PORT_WITH, '/presse.html');
    check('the press page is served', press.text.includes('OPERATOR PRESS'), `HTTP ${press.status}`);
    const asset = await body(PORT_WITH, '/operator/downloads/logo.svg');
    check('downloads are served below /operator', asset.status === 200 && asset.text.includes('<svg'),
      `HTTP ${asset.status}`);
    const missing = await body(PORT_WITH, '/datenschutz.html');
    check('a page NOT provided falls back to the placeholder, not a 404',
      missing.status === 200 && !missing.text.includes('OPERATOR'), `HTTP ${missing.status}`);
    check('startup names the pages it found',
      withPages.log.join('').includes('Operator pages: impressum, presse'),
      withPages.log.join('').split('\n').filter((l) => l.includes('Operator')).join(' | ') || 'no such line');
  }

  console.log('\nWithout the variable — nothing may change');
  {
    const imprint = await body(PORT_WITHOUT, '/impressum.html');
    check('the placeholder is served', imprint.status === 200 && !imprint.text.includes('OPERATOR'),
      `HTTP ${imprint.status}`);
    // The counterpart — that the shipped page carries no operator data of ours — is asserted
    // once the placeholders replace it. Doing that here first would leave id-call.eu without an
    // imprint between deployment and the pages landing in the volume, and an operating service
    // does not get put into that state. See the issue "Stop shipping our imprint".
    const press = await body(PORT_WITHOUT, '/presse.html');
    check('no press page in a plain instance', press.status === 404, `HTTP ${press.status}`);
    const asset = await body(PORT_WITHOUT, '/operator/downloads/logo.svg');
    check('/operator is not mounted', asset.status === 404, `HTTP ${asset.status}`);
    check('startup says nothing about operator pages',
      !without.log.join('').includes('Operator pages:'), 'the line appears although nothing is configured');
  }
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  failures++;
} finally {
  for (const p of servers) { if (p.pid) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} } }
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
