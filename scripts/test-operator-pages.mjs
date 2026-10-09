// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operator pages: whoever runs an instance provides its imprint, not this repository.
 *
 * An imprint shipped in `public/impressum.html` with real provider details would go out with
 * every self-hosted instance. The operator would thereby publish the wrong provider (section 5
 * DDG requires the actual one), and the software's author would be named as responsible for
 * instances it neither runs nor knows of.
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
  // Third instance: operator pages AND branding. This combination once broke — see the check
  // further down.
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
    // This is the one place where a mistake breaks every invitation link that was ever sent. `?room=` must reach the application even when
    // the operator has put a start page in front of it.
    // The software ships no front page at all: "/" IS the tool. That is the honest default — an
    // instance someone else runs should not greet visitors with marketing for another service.
    const withoutHome = await body(PORT_WITH, '/');
    check('without start.html the bare URL opens the application',
      withoutHome.text.includes('id="setup"') || withoutHome.text.includes('data-i18n'),
      `got: ${withoutHome.text.slice(0, 90)}`);
    check('and it is not the operator page',
      !withoutHome.text.includes('PROVIDED-BY-OPERATOR-START'), 'a start page appeared from nowhere');

    writeFileSync(join(dir, 'start.html'), '<!doctype html><title>x</title>PROVIDED-BY-OPERATOR-START');
    const home = await body(PORT_WITH, '/');
    check('with start.html "/" serves it — without a restart',
      home.text.includes('PROVIDED-BY-OPERATOR-START'), `got: ${home.text.slice(0, 90)}`);

    for (const q of ['?room=abc123', '?inv=xyz', '?pair=tok', '?new=1', '?solo=1']) {
      const app = await body(PORT_WITH, `/${q}`);
      check(`"${q}" still opens the application, not the start page`,
        !app.text.includes('PROVIDED-BY-OPERATOR-START'), 'an invitation link landed on the start page');
    }

    const plain = await body(PORT_WITHOUT, '/');
    check('an instance without the variable opens the application too',
      plain.status === 200 && !plain.text.includes('PROVIDED-BY-OPERATOR-START'),
      `HTTP ${plain.status}`);

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
    // The same rule for media an operator supplies: announced only where the file is actually
    // there, so a page never points a <video> at a dead source.
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
    // The regression this prevents: branding registers an interceptor for
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
    // The failure this prevents: the available pages were
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

  console.log('\nThe operator\'s own site: short paths, root files, redirects, 404');
  {
    // So an operator's website can grow (FAQ, articles, sitemap) without a
    // release of this application. Everything here is consulted only after the application's own
    // routes — the check with health.html below is the one that must never break.
    mkdirSync(join(dir, 'artikel', 'zwei'), { recursive: true });
    writeFileSync(join(dir, 'technik.html'), '<!doctype html><title>x</title>SITE-TECHNIK');
    writeFileSync(join(dir, 'artikel', 'eins.html'), '<!doctype html><title>x</title>SITE-ARTIKEL-EINS');
    writeFileSync(join(dir, 'artikel', 'zwei', 'index.html'), '<!doctype html><title>x</title>SITE-ARTIKEL-ZWEI');
    writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\nAllow: /\n');
    writeFileSync(join(dir, 'sitemap.xml'), '<?xml version="1.0"?><urlset/>');
    writeFileSync(join(dir, '404.html'), '<!doctype html><title>x</title>SITE-NOT-FOUND');
    writeFileSync(join(dir, 'health.html'), '<!doctype html><title>x</title>SITE-HEALTH-MUST-NOT-WIN');
    writeFileSync(join(dir, 'redirects.json'), JSON.stringify({
      '/alt': '/technik',
      '/operator/technik.html': '/technik',
      '/woanders': 'https://example.org/ziel',
      '/kaputt': 'javascript:alert(1)',
      '/protokoll-relativ': '//evil.example/',
    }));

    const short = await body(PORT_WITH, '/technik');
    check('/technik serves technik.html', short.status === 200 && short.text.includes('SITE-TECHNIK'), `HTTP ${short.status}`);
    const nested = await body(PORT_WITH, '/artikel/eins');
    check('a page in a sub-directory is served', nested.text.includes('SITE-ARTIKEL-EINS'), `HTTP ${nested.status}`);
    const index = await body(PORT_WITH, '/artikel/zwei');
    check('a directory with index.html is served', index.text.includes('SITE-ARTIKEL-ZWEI'), `HTTP ${index.status}`);
    const robots = await body(PORT_WITH, '/robots.txt');
    check('robots.txt is served at the root', robots.status === 200 && robots.text.includes('User-agent'), `HTTP ${robots.status}`);
    const sitemap = await body(PORT_WITH, '/sitemap.xml');
    check('sitemap.xml is served at the root', sitemap.status === 200 && sitemap.text.includes('urlset'), `HTTP ${sitemap.status}`);

    const health = await fetch(`http://127.0.0.1:${PORT_WITH}/health`);
    const healthText = await health.text();
    check('the application wins: health.html does NOT shadow /health',
      health.ok && !healthText.includes('SITE-HEALTH-MUST-NOT-WIN'), `got: ${healthText.slice(0, 80)}`);
    const caps = await fetch(`http://127.0.0.1:${PORT_WITH}/capabilities`);
    check('and /capabilities is still the application', caps.ok && (caps.headers.get('content-type') || '').includes('json'),
      `HTTP ${caps.status} ${caps.headers.get('content-type')}`);
    for (const q of ['?room=abc123', '?new=1']) {
      const app = await body(PORT_WITH, `/${q}`);
      check(`"${q}" still opens the application`, !app.text.includes('SITE-'), 'reached the operator site');
    }

    const noAlias = await body(PORT_WITH, '/technik.html');
    check('/technik.html is not a second address of the page', !noAlias.text.includes('SITE-TECHNIK'), `HTTP ${noAlias.status}`);
    const start = await body(PORT_WITH, '/start');
    check('/start does not publish the start page twice', !start.text.includes('PROVIDED-BY-OPERATOR-START'), `HTTP ${start.status}`);
    for (const bad of ['/..%2Fpackage.json', '/artikel/..%2F..%2Fpackage.json', '/%2e%2e/package.json', '/.env']) {
      const r = await body(PORT_WITH, bad);
      check(`no way out of the directory: ${bad}`, !r.text.includes('"name"') && !r.text.includes('EUDIPLO'), `HTTP ${r.status}`);
    }

    const go = async (p) => fetch(`http://127.0.0.1:${PORT_WITH}${p}`, { redirect: 'manual' });
    const alt = await go('/alt');
    check('a redirect answers 301 to the new address', alt.status === 301 && alt.headers.get('location') === '/technik',
      `HTTP ${alt.status} → ${alt.headers.get('location')}`);
    const old = await go('/operator/technik.html');
    check('a redirect away from /operator/ fires before the static files', old.status === 301 && old.headers.get('location') === '/technik',
      `HTTP ${old.status} → ${old.headers.get('location')}`);
    const ext = await go('/woanders');
    check('an https:// target is allowed', ext.status === 301 && ext.headers.get('location') === 'https://example.org/ziel',
      `HTTP ${ext.status}`);
    const js = await go('/kaputt');
    check('a javascript: target is ignored', js.status !== 301, `HTTP ${js.status} → ${js.headers.get('location')}`);
    const pr = await go('/protokoll-relativ');
    check('a protocol-relative target is ignored', pr.status !== 301, `HTTP ${pr.status} → ${pr.headers.get('location')}`);

    const missing = await fetch(`http://127.0.0.1:${PORT_WITH}/gibt-es-nicht`, { headers: { accept: 'text/html' } });
    const missingText = await missing.text();
    check('an unknown path shows 404.html with status 404', missing.status === 404 && missingText.includes('SITE-NOT-FOUND'),
      `HTTP ${missing.status}`);

    writeFileSync(join(dir, 'faq.html'), '<!doctype html><title>x</title>SITE-FAQ-LATE');
    const late = await body(PORT_WITH, '/faq');
    check('a page added while running is served without a restart', late.text.includes('SITE-FAQ-LATE'), `HTTP ${late.status}`);

    const brandedShort = await body(PORT_BRANDED, '/technik');
    check('with branding switched on, /technik is served too', brandedShort.text.includes('SITE-TECHNIK'), `HTTP ${brandedShort.status}`);

    const plainShort = await body(PORT_WITHOUT, '/technik');
    check('without the variable /technik stays a plain 404', plainShort.status === 404 && !plainShort.text.includes('SITE-'),
      `HTTP ${plainShort.status}`);
    const plainRobots = await body(PORT_WITHOUT, '/robots.txt');
    check('without the variable /robots.txt stays a 404', plainRobots.status === 404, `HTTP ${plainRobots.status}`);
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
