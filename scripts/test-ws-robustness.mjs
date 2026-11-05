// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A malformed WebSocket message must never take the server down.
 *
 * Until 2026-11-05 a single frame `null`, sent by anyone without signing in, ended the process:
 * JSON.parse('null') is null, `msg.type` threw inside the async handler, the rejection went
 * unhandled, and Node exits on that — with every call on the instance, since all state is in
 * memory. Here, against the real server as in production: a call is up, a stranger sends every
 * shape of nonsense, and afterwards the server still answers and the call is still there.
 *
 * Usage: npm run test:ws-robustness
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const PORT = 3989;
let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures++;
}
const open = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { 'x-forwarded-proto': 'http' } });
  const seen = [];
  ws.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
  ws.on('open', () => resolve({ ws, seen }));
  ws.on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = [];
const app = spawn('npx', ['tsx', 'src/server.ts'], {
  detached: true,
  env: {
    ...process.env,
    NODE_ENV: 'production', PORT: String(PORT), EUDI_VERIFIER: 'none',
    // Empty, not deleted: a deleted variable would be filled from a local .env by dotenv.
    EUDIPLO_BASE_URL: '', EUDIPLO_CLIENT_ID: '', EUDIPLO_CLIENT_SECRET: '',
    EUDIPLO_ROOT_ID: '', EUDIPLO_ROOT_SECRET: '', PUBLIC_URL: '',
    EUDI_HOST_ALLOWLIST: '', EUDI_HOST_FILE: '', EUDI_PRO_MODULE: '', EUDI_PROMO_ALL_PRO: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (d) => log.push(d.toString()));
app.stderr.on('data', (d) => log.push(d.toString()));

try {
  for (let t0 = Date.now(); ; ) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
    if (app.exitCode !== null || Date.now() - t0 > 25000) throw new Error(`server did not start\n${log.join('')}`);
    await sleep(250);
  }

  console.log('\nA call is up');
  const host = await open();
  host.ws.send(JSON.stringify({ type: 'join', roomId: randomUUID(), clientId: randomUUID() }));
  await sleep(500);
  check('the host is in a room', host.seen.some((m) => m.type === 'status'), JSON.stringify(host.seen.map((m) => m.type)));

  console.log('\nA stranger sends nonsense, one frame each');
  const junk = ['null', '[]', '1', '"x"', 'true', '{}', '{"type":5}', '{"type":null}', '{"type":"join"}',
    '{"type":"join","roomId":{}}', '{"type":"confirm"}', '{"type":"offer","to":{}}', '{"type":"set-config","config":null}'];
  for (const frame of junk) {
    let s;
    try { s = await open(); } catch (e) { check(`server still accepts connections before ${frame}`, false, e.message); break; }
    s.ws.send(frame);
    await sleep(150);
    s.ws.close();
  }
  await sleep(500);

  console.log('\nThe server is still there, and so is the call');
  check('the process is running', app.exitCode === null, `exit ${app.exitCode}\n${log.join('').slice(-800)}`);
  let health = null;
  try { health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); } catch {}
  check('/health answers and counts the room', health?.ok === true && health.activeRooms >= 1, JSON.stringify(health));
  check('the host\'s connection is still open', host.ws.readyState === WebSocket.OPEN, `readyState ${host.ws.readyState}`);
  host.ws.close();
} catch (e) {
  check('test aborted', false, e.message);
} finally {
  try { process.kill(-app.pid, 'SIGTERM'); } catch {}
}
console.log(failures ? `\n${failures} check(s) failed.` : '\nall checks passed');
process.exit(failures ? 1 : 0);
