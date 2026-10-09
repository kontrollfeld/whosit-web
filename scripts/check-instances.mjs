// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Do the deployed instances actually run what was shipped?
 *
 * WHY THIS EXISTS. A deployment can go stale without anything failing: a deploy trigger that
 * misses one instance, or a deployment that reports "Build step skipped", looks like a success
 * while the instance stays branded, reachable, green, and several releases behind.
 *
 * With several instances, "updates reach every instance automatically" has to be verified. This
 * verifies it — from the OUTSIDE, over HTTP, against the running instance, which is the only
 * vantage point a deploy pipeline cannot lie to.
 *
 * WHAT IT CHECKS, per instance:
 *   1. the revision it serves (/version.json) against the one expected
 *   2. that it answers at all, and how (/health)
 *   3. white-label hygiene from /capabilities — the mistakes that are invisible from inside:
 *      a branded instance that never names its actual relying party, or one that offers hosting
 *      to anyone.
 *
 * THE LIST IS NOT IN THIS REPOSITORY. Which instances exist is deployment data, not source.
 * Pass it in:
 *
 *   EUDI_INSTANCES="https://a.example.net,https://b.example.net" node scripts/check-instances.mjs
 *   node scripts/check-instances.mjs --list ./instances.txt --commit f0b3c23
 *
 * Expected revision: --commit, else $CI_COMMIT_SHORT_SHA, else the committed public/version.json.
 * Exit code 1 if any instance lags or is unreachable — so a scheduled job turns red rather than
 * a person having to remember to look.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function instances() {
  const listFile = arg('--list');
  const raw = listFile
    ? readFileSync(listFile, 'utf8')
    : (process.env.EUDI_INSTANCES || '');
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => (/^https?:\/\//.test(s) ? s : `https://${s}`).replace(/\/+$/, ''));
}

/** What every instance is supposed to be serving. */
function expectedCommit() {
  const explicit = arg('--commit') || process.env.EUDI_EXPECTED_COMMIT || process.env.CI_COMMIT_SHORT_SHA;
  if (explicit) return explicit.trim().slice(0, 7);
  return JSON.parse(readFileSync(join(root, 'public/version.json'), 'utf8')).commit;
}

async function getJson(url, timeoutMs = 10_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) return { _error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { _error: e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const targets = instances();
if (!targets.length) {
  console.error('No instances given. Set EUDI_INSTANCES or pass --list <file>.');
  console.error('This is not a failure of the instances — there is nothing to check.');
  process.exit(2);
}

const want = expectedCommit();
console.log(`Expecting revision ${want} on ${targets.length} instance(s)\n`);

let problems = 0;
const note = (host, ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${host} — ${msg}`);
  if (!ok) problems++;
};

for (const base of targets) {
  const host = base.replace(/^https?:\/\//, '');
  const [version, health, caps] = await Promise.all([
    getJson(`${base}/version.json`),
    getJson(`${base}/health`),
    getJson(`${base}/capabilities`),
  ]);

  if (version._error) {
    note(host, false, `unreachable: ${version._error}`);
    continue;
  }

  const got = String(version.commit || '').slice(0, 7);
  note(host, got === want,
    got === want
      ? `${version.version} / ${got}`
      : `serves ${version.version} / ${got}, expected ${want} — THIS IS THE STALE-DEPLOY CASE, force a rebuild without cache`);

  if (health._error) note(host, false, `/health: ${health._error}`);

  // White-label hygiene. Not "is it up" but "is it honest" — the class of mistake that keeps
  // working perfectly while being wrong, which is the only kind worth an automated check.
  if (!caps._error) {
    const rp = caps.relyingParty;
    if (rp && rp.disclose && !rp.name) {
      note(host, false,
        `branded "${rp.onBehalfOf}" but EUDI_RP_NAME is unset — citizens are told only who is NOT asking`);
    }
    const p = caps.policy;
    if (p && p.narrowed) {
      console.log(`      asks [${p.allowedAttributes.join(', ')}] of [${p.registrationPermits.join(', ')}] permitted`);
    }
    // A branded instance without a host gate lets anyone who knows the URL invite citizens to a
    // call under the brand's name. On an unbranded public instance that may be intended; on a
    // branded one it is almost certainly an oversight.
    if (rp && rp.onBehalfOf && caps.hostLogin === false) {
      note(host, false, `branded "${rp.onBehalfOf}" but ANYONE may host — no EUDI_HOST_FILE / EUDI_HOST_ALLOWLIST`);
    }
    if (caps.operatorPages && !caps.operatorPages.includes('impressum')) {
      note(host, false, 'no imprint page — section 5 DDG requires the operator to be named');
    }
  }
}

console.log(problems === 0
  ? `\nAll ${targets.length} instance(s) serve ${want}.`
  : `\n${problems} problem(s). An instance that lags is not a cosmetic issue: it is the product promise broken.`);
process.exit(problems === 0 ? 0 : 1);
