// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The app page's Content-Security-Policy (src/csp.ts) matches the page actually sent.
 *
 * The policy allows inline scripts only by the hash of their exact text. If the page changes and
 * the policy does not follow, the browser silently stops running that script — the app would break
 * for everyone, and only in production. So, against the real server, plain and branded (branding
 * injects a script of its own):
 *
 *   - every route that shows the app sends the policy;
 *   - every inline script in the HTML sent has its hash in script-src, and there is nothing else
 *     inline-ish: no 'unsafe-inline', no 'unsafe-eval' for scripts;
 *   - the frame-ancestors header stays as it was, next to it;
 *   - API answers do not carry the app policy.
 *
 * A browser run of a whole call under the policy (QR, PDF, background blur, WebRTC) found no
 * violation on 2026-11-05; that run needs a camera and is not part of npm test.
 *
 * Usage: npm run test:csp
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures++;
}
const procs = [];
function start(port, extra = {}) {
  const p = spawn('npx', ['tsx', 'src/server.ts'], {
    detached: true,
    env: { ...process.env, PORT: String(port), EUDI_VERIFIER: 'none', NODE_ENV: 'development', EUDI_BRAND_LOGO: '', EUDI_BRAND_NAME: '', EUDI_OPERATOR_PAGES: '', ...extra },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  procs.push(p);
  return `http://127.0.0.1:${port}`;
}
async function up(base) {
  for (let t0 = Date.now(); Date.now() - t0 < 25000; ) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${base} did not start`);
}
const hashes = (html) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);

async function pageCheck(base, label) {
  for (const route of ['/?new=1', `/?room=${randomUUID()}`, '/zurueck', '/index.html']) {
    const r = await fetch(base + route);
    const html = await r.text();
    const csp = r.headers.get('content-security-policy') || '';
    const scriptSrc = (csp.split(/[;,]/).find((d) => d.trim().startsWith('script-src')) || '').trim();
    const need = hashes(html);
    check(`${label} ${route}: policy sent`, scriptSrc.length > 0, csp);
    check(`${label} ${route}: all ${need.length} inline scripts allowed by hash`, need.length > 0 && need.every((h) => scriptSrc.includes(h)), `${need.join(' ')} vs ${scriptSrc}`);
    check(`${label} ${route}: nothing else inline`, !/'unsafe-inline'|'unsafe-eval'/.test(scriptSrc), scriptSrc);
    check(`${label} ${route}: frame-ancestors still there`, /frame-ancestors/.test(csp), csp);
  }
}

try {
  const plain = start(3981);
  const branded = start(3980, { EUDI_BRAND_LOGO: '/logo/logo-horizontal-colour.svg', EUDI_BRAND_NAME: 'Testbetrieb GmbH' });
  // A logo that spells the name: the inline script differs once more, so the policy must follow.
  const wordmark = start(3982, { EUDI_BRAND_LOGO: '/logo/logo-horizontal-colour.svg', EUDI_BRAND_NAME: 'Testbetrieb GmbH', EUDI_BRAND_NAME_IN_LOGO: 'true' });
  const nameOnly = start(3983, { EUDI_BRAND_NAME: 'Testbetrieb GmbH', EUDI_BRAND_NAME_IN_LOGO: 'true' });
  await Promise.all([up(plain), up(branded), up(wordmark), up(nameOnly)]);
  console.log('\nPlain instance');
  await pageCheck(plain, 'plain');
  console.log('\nBranded instance (injects a script of its own)');
  await pageCheck(branded, 'branded');
  const bh = await (await fetch(`${branded}/?new=1`)).text();
  check('the branded page really carries the extra script', /EUDI_BRANDING/.test(bh));
  check('the name is shown beside the logo unless told otherwise', !/brand-name-in-logo/.test(bh));
  console.log('\nBranded instance whose logo carries the name');
  await pageCheck(wordmark, 'wordmark');
  const wh = await (await fetch(`${wordmark}/?new=1`)).text();
  check('the name is hidden beside the logo, before first paint', /classList\.add\('brand-name-in-logo'\)/.test(wh) && /"nameInLogo":true/.test(wh));
  check('the name stays in the page', /Testbetrieb GmbH/.test(wh));
  const nh = await (await fetch(`${nameOnly}/?new=1`)).text();
  check('without a logo the name is never hidden', /EUDI_BRANDING/.test(nh) && !/brand-name-in-logo/.test(nh));
  console.log('\nNot on API answers');
  const ice = await fetch(`${plain}/ice`);
  check('/ice carries no script policy', !/script-src/.test(ice.headers.get('content-security-policy') || ''));
} catch (e) {
  check('test aborted', false, e.message);
} finally {
  for (const p of procs) try { process.kill(-p.pid, 'SIGTERM'); } catch {}
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nall checks passed');
process.exit(failures ? 1 : 0);
