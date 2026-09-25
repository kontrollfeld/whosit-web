// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The edition split — the boundary that can slip silently.
 *
 * Two directions of failure, both expensive:
 *   - TOO MUCH in Community means a Pro feature is given away. Nobody notices, because nothing
 *     breaks — there is simply less revenue, and unnoticed at that.
 *   - TOO LITTLE in Community means the published edition looks crippled. That is the very
 *     reason the split was redrawn on 2026-08-19 (the rationale lives in src/core/features.ts,
 *     entry by entry), and it would be a shame to undo it with one careless registry edit.
 *
 * Until 2026-08-19 there was NO automated test for this — the Pro case was only checked by hand.
 * Both cases are therefore tested against the real endpoint rather than against the registry
 * alone: between registry and response sit `enabledFeatures()`, the promo resolution and the
 * config gates, which is exactly where things go wrong.
 *
 * Usage: npm run test:editions
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT_COMMUNITY = 3771;
const PORT_PRO = 3772;
const PORT_PROMO = 3773;
const PORT_PRO_MODULE = 3775;

/** The two Pro features — where we genuinely provide something in return, with the code in pro/. */
const PRO_IDS = ['audit-trail', 'qes-csc'];

/** Community features whose loss MUST be noticed immediately (the 2026-08-19 split, plus
 *  multi-party on 2026-09-25: its code is all AGPL, so a Pro label was only a switch). */
const MOVED_TO_COMMUNITY = [
  'meeting-controls', 'screen-share', 'spotlight', 'hand-raise',
  'file-transfer', 'emoji', 'calendar-invite', 'native-share',
  'embed', 'in-call-credentials', 'multi-party',
];

// The Pro module straight from source (the server runs under tsx, which imports .ts), so the
// test needs no `npm run build:pro` first. Its audit trail writes into a throwaway directory.
const PRO_MODULE = './pro/index.ts';
const auditDir = mkdtempSync(join(tmpdir(), 'id-call-editions-'));
const withProModule = { EUDI_PRO_MODULE: PRO_MODULE, EUDI_AUDIT_FILE: join(auditDir, 'audit.jsonl') };

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const servers = [];
function startServer(port, extraEnv) {
  // detached + its own process group: `npx` is only the wrapper — signalling it would leave the
  // actual Node process alive and the server behind (see test-host-login).
  const s = spawn('npx', ['tsx', 'src/server.ts'], {
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      // A complete but fictitious verifier configuration: the test never talks to a verifier,
      // but it needs a configuration that assertProductionConfig lets through.
      EUDIPLO_BASE_URL: 'http://127.0.0.1:9/no-verifier',
      EUDIPLO_CLIENT_ID: 'test-tenant',
      EUDIPLO_CLIENT_SECRET: 'test-tenant-secret',
      // Must stay OFF, otherwise the promo raises the edition to `pro` and the Community case
      // would prove nothing. Preventing exactly that mix-up is the point of this test.
      EUDI_PROMO_ALL_PRO: '',
      EUDI_PRO_MODULE: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  s.stdout.on('data', (d) => log.push(d.toString()));
  s.stderr.on('data', (d) => log.push(d.toString()));
  servers.push({ port, proc: s, log });
  return s;
}

async function waitForCapabilities(port, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/capabilities`);
      if (r.ok) return await r.json();
    } catch { /* not ready yet */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  const entry = servers.find((s) => s.port === port);
  throw new Error(`Server on :${port} unreachable.\n${(entry?.log || []).join('')}`);
}

function stopAll() {
  for (const { proc } of servers) {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

try {
  startServer(PORT_COMMUNITY, { EUDI_EDITION: 'community' });
  startServer(PORT_PRO, { EUDI_EDITION: 'pro' });
  startServer(PORT_PROMO, { EUDI_EDITION: 'community', EUDI_PROMO_ALL_PRO: 'true', ...withProModule });
  startServer(PORT_PRO_MODULE, { EUDI_EDITION: 'pro', ...withProModule });

  const [community, pro, promo, proModule] = await Promise.all([
    waitForCapabilities(PORT_COMMUNITY),
    waitForCapabilities(PORT_PRO),
    waitForCapabilities(PORT_PROMO),
    waitForCapabilities(PORT_PRO_MODULE),
  ]);

  console.log('\nCommunity instance: the Pro features stay off');
  check('the edition is reported as community', community.edition === 'community', JSON.stringify(community.edition));
  for (const id of PRO_IDS) {
    check(`${id} not included`, !community.enabled.includes(id), 'would be given away');
  }

  console.log('\nCommunity instance: the 2026-08-19 split holds');
  for (const id of MOVED_TO_COMMUNITY) {
    check(`${id} included`, community.enabled.includes(id),
      'slipped back into Pro — that makes the published edition look crippled');
  }

  console.log('\nCommunity instance: the guarantees that hold in EVERY edition');
  for (const id of ['wrp-policy', 'pseudonym-id', 'audit-metadata', 'channel-binding', 'multi-credential']) {
    check(`${id} included`, community.enabled.includes(id),
      'a guarantee that only holds in the paid edition is not a guarantee');
  }

  console.log('\nPro instance with the Pro module: the Pro features are added');
  check('the edition is reported as pro', proModule.edition === 'pro', JSON.stringify(proModule.edition));
  for (const id of PRO_IDS) {
    check(`${id} included`, proModule.enabled.includes(id), 'the Pro feature is not being unlocked');
  }
  check('Pro contains everything from Community',
    community.enabled.every((id) => proModule.enabled.includes(id)),
    `missing in Pro: ${community.enabled.filter((id) => !proModule.enabled.includes(id)).join(',')}`);

  console.log('\nPro edition WITHOUT the module: qualified signing is not claimed');
  // The signing lives in pro/qes-csc.ts. EUDI_EDITION=pro alone is a switch in open code; if it
  // were enough, qes-csc would be Pro in name only and the AGPL core would advertise CSC
  // providers it cannot serve.
  check('audit-trail included (edition gate)', pro.enabled.includes('audit-trail'));
  check('qes-csc NOT included', !pro.enabled.includes('qes-csc'),
    'advertised without the Pro module — the AGPL core cannot sign qualified');
  const providers = await (await fetch(`http://127.0.0.1:${PORT_PRO}/signature-providers`)).json();
  check('/signature-providers ships the demo provider only',
    providers.providers.every((p) => p.kind === 'mock'), JSON.stringify(providers.providers));

  console.log('\nConfig gates apply independently of the edition');
  // Without EUDI_PASS_* / EUDI_INVITE_SECRET these two must NOT be advertised — not even in
  // Pro. Otherwise the client shows a button that the server answers with a 404.
  for (const id of ['wallet-pass', 'planned-invites']) {
    check(`${id} off without configuration (Community)`, !community.enabled.includes(id));
    check(`${id} off without configuration (Pro)`, !pro.enabled.includes(id));
  }

  console.log('\nThe operator off-switch works — and protects the guarantees');
  // Public bodies must be able to switch features off for compliance reasons. At the same time
  // that must NOT apply to the privacy guarantees: a guarantee the operator can switch off would
  // not be one. Both are checked here against the real endpoint.
  const PORT_OFF = 3774;
  startServer(PORT_OFF, {
    EUDI_EDITION: 'pro',
    ...withProModule,
    EUDI_FEATURES_OFF: 'file-transfer,screen-share,multi-party,audit-trail,wrp-policy,pseudonym-id,does-not-exist',
  });
  const off = await waitForCapabilities(PORT_OFF);
  for (const id of ['file-transfer', 'screen-share', 'multi-party']) {
    check(`${id} switched off`, !off.enabled.includes(id), "the operator's decision had no effect");
  }
  check('a Pro feature can be switched off too', !off.enabled.includes('audit-trail'),
    'holding a licence does not mean you must run the feature');
  for (const id of ['wrp-policy', 'pseudonym-id']) {
    check(`${id} NOT switchable`, off.enabled.includes(id),
      'a privacy guarantee that can be switched off is not a guarantee');
  }
  check('features not listed stay untouched', off.enabled.includes('emoji'), JSON.stringify(off.enabled));
  check('the remaining Pro feature stays active in Pro',
    off.enabled.includes('qes-csc'), JSON.stringify(off.enabled));

  console.log('\nThe launch promo raises the features but does not disguise where they came from');
  check('the effective edition is pro', promo.edition === 'pro', JSON.stringify(promo.edition));
  check('the configured edition stays honestly community', promo.configuredEdition === 'community', JSON.stringify(promo.configuredEdition));
  check('the promo flag is reported', promo.promo === true, JSON.stringify(promo.promo));
  for (const id of PRO_IDS) {
    check(`${id} unlocked by the promo`, promo.enabled.includes(id));
  }
} catch (e) {
  console.error(`\n✗ Test setup failed: ${e.message}`);
  failures++;
} finally {
  stopAll();
  rmSync(auditDir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
