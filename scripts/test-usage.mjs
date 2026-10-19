// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Call minutes (src/usage.ts): what is counted, what is not, and that nobody is in the file.
 *
 * Two halves. The counting rules against the module directly, with explicit times — month
 * boundaries in German time, a group call that goes on after one person leaves, the end of a
 * dropped connection. Then a real call against the real server (EUDI_VERIFIER=none, so no wallet
 * is needed to reach `ready`): connect, talk for two seconds, hang up — and read the file.
 *
 * Usage: npm run test:usage
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { monthOf, initUsage, callStarted, participantLeft, usageSnapshot, serialize } from '../src/usage.ts';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures++;
}
const tmp = mkdtempSync(join(tmpdir(), 'usage-'));
const T = (iso) => Date.parse(iso);

console.log('\nMonths follow German time');
check('31 Oct 23:30 UTC is already November in Berlin', monthOf(T('2026-10-31T23:30:00Z')) === '2026-11', monthOf(T('2026-10-31T23:30:00Z')));
check('31 Oct 22:30 UTC is still October', monthOf(T('2026-10-31T22:30:00Z')) === '2026-10', monthOf(T('2026-10-31T22:30:00Z')));

console.log('\nCounting');
initUsage(join(tmp, 'a.json'));
const raum = {};
callStarted(raum, T('2026-10-19T10:00:00Z'));
callStarted(raum, T('2026-10-19T10:00:30Z'));
participantLeft(raum, 2, T('2026-10-19T10:05:00Z'));
check('a group call goes on while two remain', !usageSnapshot().months['2026-10'], JSON.stringify(usageSnapshot()));
participantLeft(raum, 1, T('2026-10-19T10:10:00Z'));
check('ends below two, timed from the FIRST ready', JSON.stringify(usageSnapshot().months['2026-10']) === '{"calls":1,"seconds":600}', JSON.stringify(usageSnapshot()));
participantLeft(raum, 0, T('2026-10-19T10:20:00Z'));
check('the last one leaving does not count it again', usageSnapshot().months['2026-10'].calls === 1, JSON.stringify(usageSnapshot()));
participantLeft({}, 0, T('2026-10-19T11:00:00Z'));
check('a room that never connected is no call', usageSnapshot().months['2026-10'].calls === 1, JSON.stringify(usageSnapshot()));
const zwei = {};
callStarted(zwei, T('2026-10-31T22:50:00Z'));
participantLeft(zwei, 1, T('2026-10-31T23:20:00Z'));
check('a call over the month boundary counts in the month it began', usageSnapshot().months['2026-10'].calls === 2 && !usageSnapshot().months['2026-11'], JSON.stringify(usageSnapshot()));

console.log('\nThe file: compact, nobody in it, survives a restart');
const text = readFileSync(join(tmp, 'a.json'), 'utf8');
check('one line in the fixed shape the host reads with sed', text === '{"months":{"2026-10":{"calls":2,"seconds":2400}}}\n', JSON.stringify(text));
check('serialize sorts months', serialize({ months: { '2026-11': { calls: 1, seconds: 2 }, '2026-09': { calls: 3, seconds: 4 } } }) === '{"months":{"2026-09":{"calls":3,"seconds":4},"2026-11":{"calls":1,"seconds":2}}}\n', '');
initUsage(join(tmp, 'a.json'));
check('read back at startup', usageSnapshot().months['2026-10']?.seconds === 2400, JSON.stringify(usageSnapshot()));
writeFileSync(join(tmp, 'kaputt.json'), '{nicht json');
initUsage(join(tmp, 'kaputt.json'));
check('a broken file starts from zero instead of failing', JSON.stringify(usageSnapshot()) === '{"months":{}}', JSON.stringify(usageSnapshot()));
check('and is set aside, not overwritten', readdirSync(tmp).some((f) => f.startsWith('kaputt.json.unreadable-')), readdirSync(tmp).join(','));
writeFileSync(join(tmp, 'boese.json'), JSON.stringify({ months: { '../x': { calls: 1, seconds: 1 }, '2026-10': { calls: -5, seconds: 'viel' } } }));
initUsage(join(tmp, 'boese.json'));
check('only well-formed months and numbers are taken over', JSON.stringify(usageSnapshot()) === '{"months":{}}', JSON.stringify(usageSnapshot()));
initUsage(null);
const ohne = {};
callStarted(ohne, 0); participantLeft(ohne, 1, 60_000);
check('without a file it still counts, in memory', usageSnapshot().months[monthOf(0)]?.seconds === 60, JSON.stringify(usageSnapshot()));

// ── A real call ─────────────────────────────────────────────────────────────────────────────
console.log('\nA real call against the real server');
const PORT = 3994;
const datei = join(tmp, 'daten', 'nutzung.json');
const log = [];
const app = spawn('npx', ['tsx', 'src/server.ts'], {
  detached: true,
  env: {
    ...process.env, NODE_ENV: 'production', PORT: String(PORT), EUDI_VERIFIER: 'none', EUDI_USAGE_FILE: datei,
    EUDIPLO_BASE_URL: '', EUDIPLO_CLIENT_ID: '', EUDIPLO_CLIENT_SECRET: '', EUDIPLO_ROOT_ID: '', EUDIPLO_ROOT_SECRET: '',
    PUBLIC_URL: '', EUDI_HOST_ALLOWLIST: '', EUDI_HOST_FILE: '', EUDI_PRO_MODULE: '', EUDI_PROMO_ALL_PRO: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (d) => log.push(d.toString()));
app.stderr.on('data', (d) => log.push(d.toString()));

function socket(roomId) {
  const seen = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { 'x-forwarded-proto': 'http' } });
  const c = {
    ws, seen, send: (o) => ws.send(JSON.stringify(o)),
    wait(type, ms = 8000) {
      const hit = seen.find((m) => m.type === type);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for: ${type}`)), ms);
        ws.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.type === type) { clearTimeout(t); resolve(m); } } catch {} });
      });
    },
  };
  ws.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
  ws.on('open', () => c.send({ type: 'join', roomId, clientId: randomUUID() }));
  return c;
}

const clients = [];
try {
  for (let t0 = Date.now(); ; ) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
    if (app.exitCode !== null || Date.now() - t0 > 25000) throw new Error(`server did not start\n${log.join('')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  check('says where it counts', log.join('').includes(`[usage] call minutes → ${datei}`), log.join('').slice(0, 300));
  const room = randomUUID();
  const host = socket(room); clients.push(host);
  await host.wait('status');
  const guest = socket(room); clients.push(guest);
  await guest.wait('status');
  host.send({ type: 'confirm' }); guest.send({ type: 'confirm' });
  await Promise.all([host.wait('ready'), guest.wait('ready')]);
  check('nothing written while the call runs', !existsSync(datei), 'written early');
  await new Promise((r) => setTimeout(r, 2200));
  guest.send({ type: 'hangup' });
  for (let i = 0; i < 20 && !existsSync(datei); i++) await new Promise((r) => setTimeout(r, 100));
  const d = existsSync(datei) ? JSON.parse(readFileSync(datei, 'utf8')) : null;
  const monat = d && Object.values(d.months)[0];
  check('one call, about two seconds', monat?.calls === 1 && monat.seconds >= 2 && monat.seconds <= 4, JSON.stringify(d));
  const roh = existsSync(datei) ? readFileSync(datei, 'utf8') : '';
  check('no room id in the file', !roh.includes(room), roh);
  const oeffentlich = JSON.stringify(await (await fetch(`http://127.0.0.1:${PORT}/capabilities`)).json()) + JSON.stringify(await (await fetch(`http://127.0.0.1:${PORT}/health`)).json());
  check('not served over HTTP', !/months|seconds/.test(oeffentlich), oeffentlich.slice(0, 200));
} catch (e) {
  console.error(`\n✗ Test failed: ${e.message}\n${log.join('')}`);
  failures++;
} finally {
  for (const c of clients) try { c.ws.terminate(); } catch {}
  try { process.kill(-app.pid, 'SIGTERM'); } catch {}
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
