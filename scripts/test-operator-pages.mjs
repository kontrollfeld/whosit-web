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
const PORT_BRANDED = 3993;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'operator-pages-'));
mkdirSync(join(dir, 'downloads'), { recursive: true });
writeFileSync(join(dir, 'impressum.html'), '<!doctype html><title>x</title>PROVIDED-BY-OPERATOR-IMPRINT');
writeFileSync(join(dir, 'presse.html'), '<!doctype html><title>x</title>PROVIDED-BY-OPERATOR-PRESS');
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
  // Third instance: operator pages AND branding. This combination broke production on
  // 2026-09-03 — see the check further down.
  const branded = start(PORT_BRANDED, { EUDI_OPERATOR_PAGES: dir, EUDI_BRAND_LOGO: '/operator/logo/x.svg' });
  await waitFor(PORT_WITH);
  await waitFor(PORT_WITHOUT);
  await waitFor(PORT_BRANDED);

  console.log('\nWith a directory configured');
  {
    const imprint = await body(PORT_WITH, '/impressum.html');
    check('the operator imprint is served', imprint.text.includes('PROVIDED-BY-OPERATOR-IMPRINT'),
      `got: ${imprint.text.slice(0, 80)}`);
    const short = await body(PORT_WITH, '/impressum');
    check('the extensionless path works too', short.text.includes('PROVIDED-BY-OPERATOR-IMPRINT'),
      `HTTP ${short.status}`);
    const press = await body(PORT_WITH, '/presse.html');
    check('the press page is served', press.text.includes('PROVIDED-BY-OPERATOR-PRESS'), `HTTP ${press.status}`);
    const asset = await body(PORT_WITH, '/operator/downloads/logo.svg');
    check('downloads are served below /operator', asset.status === 200 && asset.text.includes('<svg'),
      `HTTP ${asset.status}`);
    const missing = await body(PORT_WITH, '/datenschutz.html');
    check('a page NOT provided falls back to the placeholder, not a 404',
      missing.status === 200 && !missing.text.includes('PROVIDED-BY-OPERATOR'), `HTTP ${missing.status}`);
    check('startup names the pages it found',
      withPages.log.join('').includes('Operator pages: impressum, presse'),
      withPages.log.join('').split('\n').filter((l) => l.includes('Operator')).join(' | ') || 'no such line');
  }

  console.log('\nThe fork at "/" — start page versus application');
  {
    // Nothing covered this until 2026-09-12, and it is the one place where a mistake breaks
    // every invitation link that was ever sent. `?room=` must reach the application even when
    // the operator has put a start page in front of it.
    const withoutHome = await body(PORT_WITH, '/');
    check('without start.html the bare URL is not the operator page',
      !withoutHome.text.includes('PROVIDED-BY-OPERATOR-START'), 'a start page appeared from nowhere');

    writeFileSync(join(dir, 'start.html'), '<!doctype html><title>x</title>PROVIDED-BY-OPERATOR-START');
    const home = await body(PORT_WITH, '/');
    check('with start.html "/" serves it — without a restart',
      home.text.includes('PROVIDED-BY-OPERATOR-START'), `got: ${home.text.slice(0, 90)}`);

    for (const q of ['?room=abc123', '?inv=xyz', '?new=1', '?solo=1']) {
      const app = await body(PORT_WITH, `/${q}`);
      check(`"${q}" still opens the application, not the start page`,
        !app.text.includes('PROVIDED-BY-OPERATOR-START'), 'an invitation link landed on the start page');
    }

    const plain = await body(PORT_WITHOUT, '/');
    check('an instance without the variable is untouched',
      !plain.text.includes('PROVIDED-BY-OPERATOR-START'), 'start page leaked into a plain instance');

    const branded = await body(PORT_BRANDED, '/');
    check('with branding as well the start page wins',
      branded.text.includes('PROVIDED-BY-OPERATOR-START'), `got: ${branded.text.slice(0, 90)}`);
  }

  console.log('\nWhat /capabilities announces');
  {
    // The footer links a press page only when one exists (see the tail of public/theme.js).
    // A "Presse" link that 404s is worse than no link, and an instance without a press page
    // must not look as though it had one.
    const withCaps = await (await fetch(`http://127.0.0.1:${PORT_WITH}/capabilities`)).json();
    const withoutCaps = await (await fetch(`http://127.0.0.1:${PORT_WITHOUT}/capabilities`)).json();
    check('announces the pages that exist',
      Array.isArray(withCaps.operatorPages) && withCaps.operatorPages.includes('presse')
      && withCaps.operatorPages.includes('impressum'),
      JSON.stringify(withCaps.operatorPages));
    check('does not announce a page that was not provided',
      !withCaps.operatorPages.includes('datenschutz'),
      'datenschutz.html does not exist yet and is announced anyway');
    check('announces nothing without the variable',
      Array.isArray(withoutCaps.operatorPages) && withoutCaps.operatorPages.length === 0,
      JSON.stringify(withoutCaps.operatorPages));
    // The same rule for the app demo film (see the tail of public/theme.js): the landing page
    // replaces its illustration with the film only where the operator put one. An instance
    // without the file must keep the illustration, not a video element with a dead source.
    check('no media announced before the file exists',
      Array.isArray(withCaps.operatorMedia) && withCaps.operatorMedia.length === 0,
      JSON.stringify(withCaps.operatorMedia));
    check('no media announced without the variable',
      Array.isArray(withoutCaps.operatorMedia) && withoutCaps.operatorMedia.length === 0,
      JSON.stringify(withoutCaps.operatorMedia));
    check('announces the start page where there is one', withCaps.operatorHome === true,
      JSON.stringify(withCaps.operatorHome));
    check('and not where there is none', withoutCaps.operatorHome === false,
      JSON.stringify(withoutCaps.operatorHome));
  }

  console.log('\nWith branding switched on as well');
  {
    // The regression this prevents reached production. Branding registers an interceptor for
    // every *.html path in order to inject the operator's logo and colour. It was registered
    // BEFORE the operator pages, and Express takes the first matching route — so /impressum.html
    // served the placeholder from public/ while /impressum still served the real page. The
    // ordering was harmless until EUDI_BRAND_LOGO was set, which is why it slipped through.
    const withExt = await body(PORT_BRANDED, '/impressum.html');
    const noExt = await body(PORT_BRANDED, '/impressum');
    check('/impressum.html serves the operator page, not the placeholder',
      withExt.text.includes('PROVIDED-BY-OPERATOR-IMPRINT'), `got: ${withExt.text.slice(0, 90)}`);
    check('/impressum does too', noExt.text.includes('PROVIDED-BY-OPERATOR-IMPRINT'),
      `got: ${noExt.text.slice(0, 90)}`);
  }

  console.log('\nA page added while the service is running');
  {
    // The failure this prevents actually happened in production: the available pages were
    // determined once at startup, the operator copied their imprint into the directory
    // afterwards, and the route kept answering 404 — with the variable set and the file in
    // place. Resolution therefore happens per request, and this is where that is held.
    writeFileSync(join(dir, 'datenschutz.html'), '<!doctype html><title>x</title>LATE PRIVACY');
    const late = await body(PORT_WITH, '/datenschutz.html');
    check('is served without a restart', late.text.includes('LATE PRIVACY'),
      `got: ${late.text.slice(0, 80)}`);

    mkdirSync(join(dir, 'media'), { recursive: true });
    writeFileSync(join(dir, 'media', 'appdemo.mp4'), 'not really an mp4, but a file');
    const caps = await (await fetch(`http://127.0.0.1:${PORT_WITH}/capabilities`)).json();
    check('a media file added later is announced', caps.operatorMedia.includes('appdemo'),
      JSON.stringify(caps.operatorMedia));
    const film = await body(PORT_WITH, '/operator/media/appdemo.mp4');
    check('and served below /operator', film.status === 200, `HTTP ${film.status}`);
  }

  console.log('\nWithout the variable — nothing may change');
  {
    const imprint = await body(PORT_WITHOUT, '/impressum.html');
    check('the placeholder is served', imprint.status === 200 && !imprint.text.includes('PROVIDED-BY-OPERATOR'),
      `HTTP ${imprint.status}`);
    // The point of the whole exercise: what ships must not name an operator. The pattern covers
    // the provider details, not the SPDX copyright line — the author of the software and the
    // provider of a service are different roles, and only the second one is wrong here.
    check('the shipped page names no service provider',
      !/Gartenstra|HRB\s*(&nbsp;)?155693|22908|Markus Bruns/.test(imprint.text)
      && !/Diensteanbieter[\s\S]{0,200}Kontrollfeld GmbH/.test(imprint.text),
      'operator data of id-call.eu is still in the shipped page');
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
