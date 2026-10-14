// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The module loader — the seam through which every module, open or closed, reaches the core.
 *
 * What has to hold, and why each point is tested rather than assumed:
 *   - A module that does not fit this core (`coreApi`) is refused BEFORE its code runs. Otherwise
 *     it fails at the first call into a port that changed shape — in the middle of a call.
 *   - A module cannot redeclare a core capability. That is the rule that keeps a module from
 *     switching off or softening a guarantee (whitelist, pseudonym, PII-free record).
 *   - Two modules cannot claim the same id, feature or path, or the second would silently win.
 *   - Production refuses to start when a configured module is missing or broken; development
 *     carries on without it. Running on without the audit-trail module would drop the retention
 *     obligation unnoticed.
 *   - Several modules work side by side: capabilities, browser files and verification sinks of
 *     all of them, and the operator's off switch reaches module capabilities too.
 *
 * The modules used here are fixtures written into a temporary directory — the test must not
 * depend on pro/, which the AGPL core may not import (see check-licence-boundary).
 *
 * Usage: npm run test:modules
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreApiSatisfied, parseManifest, crossCheckManifests, MODULE_API_VERSION } from '../src/core/modules.ts';
import { fanOut, readManifests } from '../src/module-loader.ts';
import { ALL_FEATURE_IDS } from '../src/core/features.ts';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}
function throws(fn, pattern) {
  try { fn(); return false; } catch (e) { return pattern.test(e.message); }
}

const dir = mkdtempSync(join(tmpdir(), 'whosit-modules-'));

/** Write a fixture module: package.json with manifest, an ESM entry, optional browser files. */
function fixture(name, whosit, { entry, client } = {}) {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version: '1.2.3', type: 'module', main: 'index.mjs', whosit }));
  writeFileSync(join(d, 'index.mjs'), entry ?? 'export function register() { return {}; }\n');
  if (client) {
    mkdirSync(join(d, 'client'), { recursive: true });
    for (const [f, body] of Object.entries(client)) writeFileSync(join(d, 'client', f), body);
  }
  return d;
}

const manifest = (over = {}) => ({ whosit: { id: 'sample', coreApi: `^${MODULE_API_VERSION}`, features: [], ...over }, version: '1.0.0' });

try {
  console.log('\nThe core API range');
  check(`"^${MODULE_API_VERSION}" fits`, coreApiSatisfied(`^${MODULE_API_VERSION}`));
  check(`"${MODULE_API_VERSION}.x" fits`, coreApiSatisfied(`${MODULE_API_VERSION}.x`));
  check(`"^${MODULE_API_VERSION}.4.0" fits`, coreApiSatisfied(`^${MODULE_API_VERSION}.4.0`));
  check(`"^${MODULE_API_VERSION + 1}" does not fit`, !coreApiSatisfied(`^${MODULE_API_VERSION + 1}`));
  check('alternatives with || are read', coreApiSatisfied(`^${MODULE_API_VERSION + 1} || ^${MODULE_API_VERSION}`));
  check('an unreadable range is refused, not guessed', throws(() => coreApiSatisfied('>=1 <3'), /not a supported range/));

  console.log('\nA manifest is checked before any module code runs');
  check('a valid manifest is accepted', parseManifest(manifest({ features: [{ id: 'sample-x', title: 'X' }] }), 'm', ALL_FEATURE_IDS).features[0].id === 'sample-x');
  check('no manifest → refused', throws(() => parseManifest({ name: 'x' }, 'm', ALL_FEATURE_IDS), /no "whosit" manifest/));
  check('missing coreApi → refused', throws(() => parseManifest(manifest({ coreApi: undefined }), 'm', ALL_FEATURE_IDS), /coreApi/));
  check('wrong core API → refused', throws(() => parseManifest(manifest({ coreApi: `^${MODULE_API_VERSION + 1}` }), 'm', ALL_FEATURE_IDS), /built for core API/));
  check('invalid id → refused', throws(() => parseManifest(manifest({ id: 'Bad Id' }), 'm', ALL_FEATURE_IDS), /whosit\.id/));
  for (const core of ['screen-share', 'wrp-policy', 'pseudonym-id']) {
    check(`redeclaring the core capability ${core} → refused`,
      throws(() => parseManifest(manifest({ features: [{ id: core, title: 'mine now' }] }), 'm', ALL_FEATURE_IDS), /belongs to the core/));
  }
  check('a feature declared twice → refused',
    throws(() => parseManifest(manifest({ features: [{ id: 'a-b', title: 'A' }, { id: 'a-b', title: 'B' }] }), 'm', ALL_FEATURE_IDS), /twice/));
  check('an alias over a core path → refused',
    throws(() => parseManifest(manifest({ clientAliases: ['qes'] }), 'm', ALL_FEATURE_IDS), /shadow a route/));

  console.log('\nModules are checked against each other');
  const a = parseManifest(manifest({ id: 'mod-a', features: [{ id: 'shared-x', title: 'X' }] }), 'a', ALL_FEATURE_IDS);
  const b = parseManifest(manifest({ id: 'mod-b', features: [{ id: 'shared-x', title: 'X' }] }), 'b', ALL_FEATURE_IDS);
  check('the same feature in two modules is reported', crossCheckManifests([a, b]).some((p) => /shared-x/.test(p)));
  check('distinct modules pass', crossCheckManifests([a]).length === 0);

  console.log('\nEvery verification sink receives the record');
  const got = [];
  const sink = fanOut([
    { id: 'one', sink: { record: (ev) => { got.push(['one', ev.type]); } } },
    { id: 'broken', sink: { record: () => { throw new Error('disk full'); } } },
    { id: 'two', sink: { record: async (ev) => { got.push(['two', ev.type]); } } },
  ]);
  await sink.record({ type: 'verified' });
  check('both working sinks got it, despite a failing one between them', got.length === 2, JSON.stringify(got));

  // ---- fixtures for the running server ----------------------------------------------------
  const sinkFile = join(dir, 'registered.json');
  const modA = fixture('mod-a', {
    id: 'mod-a', coreApi: `^${MODULE_API_VERSION}`,
    features: [{ id: 'mod-a-thing', title: 'Thing A', clientGated: true }],
    clientAliases: ['mod-a-legacy'],
  }, {
    // Proves register() ran and saw the Community defaults it is meant to build on.
    entry: `import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export function register(defaults) {
  fs.writeFileSync(${JSON.stringify(sinkFile)}, JSON.stringify({ hasRoomStore: !!defaults.roomStore, plugins: defaults.plugins.length }));
  return { clientAssetsDir: path.join(here, 'client'), plugins: [{ name: 'mod-a' }] };
}
`,
    client: { 'hello.js': 'export const hello = "from mod-a";\n' },
  });
  const modB = fixture('mod-b', { id: 'mod-b', coreApi: `^${MODULE_API_VERSION}`, features: [{ id: 'mod-b-thing', title: 'Thing B' }] });
  const modOld = fixture('mod-old', { id: 'mod-old', coreApi: `^${MODULE_API_VERSION + 1}`, features: [{ id: 'mod-old-thing', title: 'Old' }] });
  const modClash = fixture('mod-clash', { id: 'mod-clash', coreApi: `^${MODULE_API_VERSION}`, features: [{ id: 'mod-a-thing', title: 'Same as A' }] });
  const modThrows = fixture('mod-throws', { id: 'mod-throws', coreApi: `^${MODULE_API_VERSION}`, features: [] },
    { entry: 'export function register() { throw new Error("cannot open database"); }\n' });

  console.log('\nThe manifests can be read without running module code');
  const { reads } = readManifests([modA, modOld, modClash]);
  check('a fitting module is read', reads[0].manifest?.id === 'mod-a' && !reads[0].error, JSON.stringify(reads[0]));
  check('the module for another core API is marked', /built for core API/.test(reads[1].error || ''), reads[1].error);
  check('the clashing module is marked, the first one kept', /mod-a-thing/.test(reads[2].error || '') && !reads[0].error, reads[2].error);

  // ---- a running server -------------------------------------------------------------------
  const servers = [];
  function start(port, env) {
    const proc = spawn('npx', ['tsx', 'src/server.ts'], {
      detached: true,
      env: {
        ...process.env,
        PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`,
        EUDIPLO_BASE_URL: 'http://127.0.0.1:9/no-verifier', EUDIPLO_CLIENT_ID: 'test-tenant', EUDIPLO_CLIENT_SECRET: 'test-tenant-secret',
        EUDI_PRO_MODULE: '', EUDI_MODULES: '', EUDI_FEATURES_OFF: '', EUDI_PROMO_ALL_PRO: '', EUDI_EDITION: 'community',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = [];
    proc.stdout.on('data', (d) => log.push(d.toString()));
    proc.stderr.on('data', (d) => log.push(d.toString()));
    const exited = new Promise((res) => proc.on('exit', (code) => res(code)));
    const entry = { port, proc, log, exited };
    servers.push(entry);
    return entry;
  }
  async function capabilities(s, timeoutMs = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { const r = await fetch(`http://127.0.0.1:${s.port}/capabilities`); if (r.ok) return await r.json(); } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server on :${s.port} unreachable\n${s.log.join('')}`);
  }

  try {
    const both = start(3781, { EUDI_MODULES: `${modA},${modB}`, EUDI_FEATURES_OFF: 'mod-b-thing' });
    const dev = start(3782, { EUDI_MODULES: `${modA},${modOld},${modClash},${modThrows}` });
    const prod = start(3783, { NODE_ENV: 'production', EUDI_MODULES: `${modA},${modOld}` });
    const prodMissing = start(3784, { NODE_ENV: 'production', EUDI_MODULES: join(dir, 'not-there') });
    const prodThrows = start(3785, { NODE_ENV: 'production', EUDI_MODULES: modThrows });

    console.log('\nTwo modules side by side');
    const capsBoth = await capabilities(both);
    check('both are reported, with version', JSON.stringify(capsBoth.modules) === JSON.stringify([{ id: 'mod-a', version: '1.2.3' }, { id: 'mod-b', version: '1.2.3' }]),
      JSON.stringify(capsBoth.modules));
    check("module A's capability is on", capsBoth.enabled.includes('mod-a-thing'), JSON.stringify(capsBoth.enabled));
    check("the operator's off switch reaches a module capability", !capsBoth.enabled.includes('mod-b-thing'));
    check('a switched-off module capability is not reported as unknown', !/unknown features: .*mod-b-thing/.test(both.log.join('')));
    check('the core capabilities are untouched', capsBoth.enabled.includes('screen-share') && capsBoth.enabled.includes('wrp-policy'));
    const reg = existsSync(sinkFile) ? JSON.parse(readFileSync(sinkFile, 'utf8')) : null;
    check('register() ran and received the Community defaults', reg?.hasRoomStore === true && reg.plugins === 0, JSON.stringify(reg));
    for (const p of ['modules/mod-a', 'mod-a-legacy']) {
      const r = await fetch(`http://127.0.0.1:3781/${p}/hello.js`);
      check(`/${p}/hello.js is served`, r.ok && (await r.text()).includes('from mod-a'), r.status);
    }
    check('a module without browser files serves nothing', (await fetch('http://127.0.0.1:3781/modules/mod-b/hello.js')).status === 404);
    check('an unknown module path falls through to 404', (await fetch('http://127.0.0.1:3781/modules/nope/hello.js')).status === 404);

    console.log('\nDevelopment: broken modules are skipped, loudly');
    const capsDev = await capabilities(dev);
    check('only the fitting module is loaded', JSON.stringify(capsDev.modules?.map((m) => m.id)) === '["mod-a"]', JSON.stringify(capsDev.modules));
    check('the wrong core API is named in the log', /mod-old.*built for core API/.test(dev.log.join('')), dev.log.join(''));
    check('the clash is named in the log', /mod-a-thing.*claimed by both|claimed by both.*mod-a-thing/.test(dev.log.join('')), dev.log.join(''));
    check('the failing register() is named in the log', /cannot open database/.test(dev.log.join('')), dev.log.join(''));
    check('the capability of a refused module is absent', !capsDev.enabled.includes('mod-old-thing'));

    console.log('\nProduction: a configured module that does not load stops the start');
    for (const [name, s, pattern] of [
      ['wrong core API', prod, /built for core API/],
      ['missing directory', prodMissing, /does not exist/],
      ['register() throws', prodThrows, /cannot open database/],
    ]) {
      const code = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('timeout'), 25000))]);
      const log = s.log.join('');
      check(`${name}: exits with 1`, code === 1, `exit ${code}`);
      check(`${name}: says why`, pattern.test(log) && /Startup aborted/.test(log), log);
    }
  } finally {
    for (const { proc } of servers) { try { process.kill(-proc.pid, 'SIGTERM'); } catch {} }
  }
} catch (e) {
  console.error(`\n✗ Test setup failed: ${e.message}`);
  failures++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
