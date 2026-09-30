// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Running without a verifier (`EUDI_VERIFIER=none`) — a call without any relying-party setup.
 *
 * For evaluating the software: every call anonymous, no wallet ever asked. What must hold, all
 * against the real server started as in production (NODE_ENV=production), with NO EUDIPLO
 * variable at all:
 *
 *   - it starts, and says what it is (`/capabilities` → verifier: 'none');
 *   - nothing that needs a verified identity is offered;
 *   - host and guest count as verified-anonymous right away, and nobody is sent to a wallet;
 *   - a set-config carrying attributes is REFUSED — the lock is the server's, not the page's;
 *   - the two can still reach the call.
 *
 * Usage: npm run test:verifier-none
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const PORT = 3998;
let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures++;
}

function socket(onOpen) {
  const seen = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { 'x-forwarded-proto': 'http' } });
  const c = {
    ws, seen,
    send: (o) => ws.send(JSON.stringify(o)),
    wait(type, pred = () => true, ms = 8000) {
      const hit = [...seen].reverse().find((m) => m.type === type && pred(m));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { ws.off('message', on); reject(new Error(`timed out waiting for: ${type}`)); }, ms);
        const on = (raw) => {
          let m; try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m.type === type && pred(m)) { clearTimeout(t); ws.off('message', on); resolve(m); }
        };
        ws.on('message', on);
      });
    },
  };
  ws.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
  ws.on('open', () => onOpen(c));
  return c;
}

const log = [];
const app = spawn('npx', ['tsx', 'src/server.ts'], {
  detached: true,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    EUDI_VERIFIER: 'none',
    // Empty, not deleted: a deleted variable would be filled from a local .env by dotenv.
    EUDIPLO_BASE_URL: '', EUDIPLO_CLIENT_ID: '', EUDIPLO_CLIENT_SECRET: '',
    EUDIPLO_ROOT_ID: '', EUDIPLO_ROOT_SECRET: '', PUBLIC_URL: '',
    EUDI_HOST_ALLOWLIST: '', EUDI_HOST_FILE: '', EUDI_PRO_MODULE: '', EUDI_PROMO_ALL_PRO: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (d) => log.push(d.toString()));
app.stderr.on('data', (d) => log.push(d.toString()));

const clients = [];
try {
  for (let t0 = Date.now(); ; ) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
    if (app.exitCode !== null || Date.now() - t0 > 25000) throw new Error(`server did not start\n${log.join('')}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('\nIt starts in production without any verifier variable, and says so');
  const caps = await (await fetch(`http://127.0.0.1:${PORT}/capabilities`)).json();
  check('verifier: "none"', caps.verifier === 'none', JSON.stringify(caps.verifier));
  check('the log says it plainly', /Verifier: NONE/.test(log.join('')));
  for (const id of ['planned-invites', 'in-call-credentials', 'wallet-pass', 'qes-csc', 'qes-device']) {
    check(`${id} not offered`, !caps.enabled.includes(id));
  }
  check('the call itself is', caps.enabled.includes('calls') && caps.enabled.includes('screen-share'));

  console.log('\nHost and guest are anonymous at once — nobody is sent to a wallet');
  const room = randomUUID();
  const host = socket((c) => c.send({ type: 'join', roomId: room, clientId: randomUUID() }));
  clients.push(host);
  const hs = await host.wait('status', (m) => m.self?.verified === true);
  check('the host counts as verified-anonymous', hs.self.verified === true);

  console.log('\nThe lock is the server\'s');
  host.send({ type: 'set-config', mode: 'video', requestedAttrs: ['family_name'], disclosedAttrs: [] });
  const refused = await host.wait('error', (m) => m.code === 'verifier-disabled').catch(() => null);
  check('requesting an attribute is refused', !!refused, 'accepted');
  host.send({ type: 'set-config', mode: 'video', requestedAttrs: [], disclosedAttrs: ['given_name'] });
  await new Promise((r) => setTimeout(r, 300));
  check('disclosing one is refused too', host.seen.filter((m) => m.code === 'verifier-disabled').length === 2);
  host.send({ type: 'set-config', mode: 'chat', requestedAttrs: [], disclosedAttrs: [] });
  await new Promise((r) => setTimeout(r, 300));
  check('an anonymous configuration is accepted', host.seen.filter((m) => m.code === 'verifier-disabled').length === 2);

  const guest = socket((c) => c.send({ type: 'join', roomId: room, clientId: randomUUID() }));
  clients.push(guest);
  const gs = await guest.wait('status', (m) => m.self?.verified === true);
  check('the guest counts as verified-anonymous', gs.self.verified === true);
  check('nobody got a wallet offer', ![...host.seen, ...guest.seen].some((m) => m.type === 'auth'));

  console.log('\nThey reach the call');
  host.send({ type: 'confirm' });
  guest.send({ type: 'confirm' });
  const ready = await Promise.all([host.wait('ready'), guest.wait('ready')]).catch(() => null);
  check('both receive "ready"', !!ready, 'the call never started');
} catch (e) {
  console.error(`\n✗ Test failed: ${e.message}\n${log.join('')}`);
  failures++;
} finally {
  for (const c of clients) try { c.ws.terminate(); } catch {}
  try { process.kill(-app.pid, 'SIGTERM'); } catch {}
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
