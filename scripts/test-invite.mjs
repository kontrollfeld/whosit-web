// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Scheduled calls: an integration test against a real server (no browser, no EUDIPLO).
 *
 * What is being checked is the property that matters: the order of arrival must NO LONGER decide
 * who is the host and what is requested. That is why the guest joins FIRST here — precisely the
 * case that would otherwise swap the roles.
 *
 * The test runs with empty attribute sets (both sides anonymous). That is deliberate: the server
 * then requires no wallet presentation and no EUDIPLO is needed, while role binding, pinning and
 * the time window still exercise exactly the same code paths.
 *
 * Usage: npm run test:invite
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 3987;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-invite-secret-do-not-use-in-production';

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function b64urlJson(s) {
  return JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/** Join and wait for the first meaningful reply (joined | invite-invalid | room-full). */
function join({ roomId, inv, clientId }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const seen = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', roomId, clientId, inv })));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      seen.push(m);
      if (m.type === 'joined' || m.type === 'invite-invalid' || m.type === 'room-full' || m.type === 'link-in-use' || m.type === 'error') {
        clearTimeout(timer);
        // Listen a moment longer so the first status broadcast is captured too.
        setTimeout(() => resolve({ first: m, seen, ws }), 250);
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

async function mint(body) {
  const r = await fetch(`${BASE}/invite`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const server = spawn('npx', ['tsx', 'src/server.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    EUDI_INVITE_SECRET: SECRET,
    EUDI_EDITION: 'community',
    PUBLIC_URL: BASE,
    EUDIPLO_BASE_URL: 'http://127.0.0.1:1', // deliberately unreachable — must never be needed
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(d.toString()));
server.stderr.on('data', (d) => serverLog.push(d.toString()));

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the server did not start:\n${serverLog.join('')}`);
}

try {
  await waitForServer();
  const openSockets = [];

  console.log('\nIssuing an invitation');
  const now = Date.now();
  const soon = { start: new Date(now + 5 * 60_000).toISOString(), end: new Date(now + 35 * 60_000).toISOString() };
  const { status, json: inv } = await mint({ mode: 'chat', requestedAttrs: [], disclosedAttrs: [], ...soon });
  check('POST /invite answers 200', status === 200, `status=${status}`);
  check('two different tokens', !!inv?.hostToken && !!inv?.guestToken && inv.hostToken !== inv.guestToken);
  check('the room ID carries the p- marker', typeof inv?.room === 'string' && inv.room.startsWith('p-'), inv?.room);
  const hostPayload = b64urlJson(inv.hostToken.split('.')[0]);
  const guestPayload = b64urlJson(inv.guestToken.split('.')[0]);
  check('both tokens are for the same room', hostPayload.room === guestPayload.room && hostPayload.room === inv.room);
  check('the roles are recorded differently', hostPayload.role === 'host' && guestPayload.role === 'guest');
  check('the window opens before the appointment starts', guestPayload.nbf < Math.floor(new Date(soon.start).getTime() / 1000));

  console.log('\nThe guest joins FIRST (the case that used to swap the roles)');
  const g = await join({ roomId: inv.room, inv: inv.guestToken, clientId: 'test-guest' });
  openSockets.push(g.ws);
  check('the guest becomes the guest, not the host', g.first.type === 'joined' && g.first.role === 'callee', JSON.stringify(g.first));
  const gStatus = g.seen.find((m) => m.type === 'status');
  check('the agreed scope is pinned (configPinned)', gStatus?.configPinned === true);
  check('the mode is taken from the invitation', gStatus?.mode === 'chat', gStatus?.mode);

  console.log('\nThe host joins afterwards');
  const h = await join({ roomId: inv.room, inv: inv.hostToken, clientId: 'test-host' });
  openSockets.push(h.ws);
  check('the host becomes the host despite arriving later', h.first.type === 'joined' && h.first.role === 'caller', JSON.stringify(h.first));

  console.log('\nDefences');
  const noTok = await join({ roomId: inv.room, clientId: 'test-strip' });
  check('no invitation, no entry to a scheduled room', noTok.first.type === 'invite-invalid', JSON.stringify(noTok.first));
  noTok.ws.close();

  const parts = inv.guestToken.split('.');
  const tampered = `${Buffer.from(JSON.stringify({ ...guestPayload, role: 'host' }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${parts[1]}`;
  const forged = await join({ roomId: inv.room, inv: tampered, clientId: 'test-forge' });
  check('a rewritten role is caught by the signature',
    forged.first.type === 'invite-invalid' && forged.first.reason === 'signature', JSON.stringify(forged.first));
  forged.ws.close();

  const later = await mint({
    mode: 'chat', requestedAttrs: [], disclosedAttrs: [],
    start: new Date(now + 3 * 60 * 60_000).toISOString(), end: new Date(now + 4 * 60 * 60_000).toISOString(),
  });
  const laterStart = new Date(now + 3 * 60 * 60_000);
  const early = await join({ roomId: later.json.room, inv: later.json.guestToken, clientId: 'test-early' });
  check('opened too early -> rejected',
    early.first.type === 'invite-invalid' && early.first.reason === 'too-early', JSON.stringify(early.first));
  // Two separate times: `opensAt` is the nbf, `startsAt` the start of the appointment. Mixing
  // them up makes the waiting screen announce the lead time as the start (15 minutes too early).
  check('returns both the opening AND the start time',
    typeof early.first.opensAt === 'number' && typeof early.first.startsAt === 'number', JSON.stringify(early.first));
  check('the opening is exactly 15 minutes before the start',
    early.first.startsAt - early.first.opensAt === 900, `${early.first.startsAt - early.first.opensAt}s`);
  check('the start time is the appointment named when issuing',
    Math.abs(early.first.startsAt - Math.floor(laterStart.getTime() / 1000)) <= 1,
    `${early.first.startsAt} vs ${Math.floor(laterStart.getTime() / 1000)}`);
  early.ws.close();

  // Deliberately a VALID token from a different appointment: the time window is checked before
  // the room, so a token that has not opened yet would fail for the wrong reason.
  const other = await mint({ mode: 'chat', requestedAttrs: [], disclosedAttrs: [], ...soon });
  const foreign = await join({ roomId: inv.room, inv: other.json.guestToken, clientId: 'test-foreign' });
  check("another appointment's invitation does not open this room",
    foreign.first.type === 'invite-invalid' && foreign.first.reason === 'room-mismatch', JSON.stringify(foreign.first));
  foreign.ws.close();

  console.log('\nLimits of the mint endpoint');
  const past = await mint({ mode: 'chat', requestedAttrs: [], disclosedAttrs: [], start: new Date(now - 5 * 60 * 60_000).toISOString(), end: new Date(now - 4 * 60 * 60_000).toISOString() });
  check('an appointment in the past is refused', past.status === 400, `status=${past.status}`);
  const tooLong = await mint({ mode: 'chat', requestedAttrs: [], disclosedAttrs: [], start: new Date(now + 60_000).toISOString(), end: new Date(now + 20 * 60 * 60_000).toISOString() });
  check('an over-long duration is refused', tooLong.status === 400, `status=${tooLong.status}`);
  const backwards = await mint({ mode: 'chat', requestedAttrs: [], disclosedAttrs: [], start: soon.end, end: soon.start });
  check('an end before the start is refused', backwards.status === 400, `status=${backwards.status}`);

  // --- Rejoining and seat ownership ---------------------------------------------------
  // The practical case: someone opens the appointment link, loses the tab (or the network) and
  // wants back in. A NEW browser identifier must not count as a second person and make the room
  // report "full": the invitation decides who owns the seat.
  console.log('\nRejoining through the same invitation link');
  const rj = await mint({ mode: 'chat', requestedAttrs: [], disclosedAttrs: [], ...soon });
  const rHost = await join({ roomId: rj.json.room, inv: rj.json.hostToken, clientId: 'rj-host' });
  openSockets.push(rHost.ws);
  const rGuest1 = await join({ roomId: rj.json.room, inv: rj.json.guestToken, clientId: 'rj-guest-tab1' });
  check('the guest joins', rGuest1.first.type === 'joined' && rGuest1.first.role === 'callee');

  // A second window while the first is still open. The link MUST let them in even then: a
  // hung session counts as open for up to a minute, and a rejection would lock out exactly the
  // person who owns the seat.
  const rGuestLive = await join({ roomId: rj.json.room, inv: rj.json.guestToken, clientId: 'rj-guest-tab2' });
  check('the same link gets in even while a session is still open',
    rGuestLive.first.type === 'joined' && rGuestLive.first.role === 'callee', JSON.stringify(rGuestLive.first));
  check('the displaced session is told about it', rGuest1.seen.some((m) => m.type === 'session-taken-over')
    || await new Promise((r) => setTimeout(() => r(rGuest1.seen.some((m) => m.type === 'session-taken-over')), 300)));
  rGuestLive.ws.close();
  await new Promise((r) => setTimeout(r, 300));

  // Now the guest drops out (tab closed / network gone) and comes back with a FRESH identifier —
  // exactly what a newly opened window does.
  const guestPeerId = rGuest1.first.peerId;
  // The guest accepts the preview BEFORE dropping out. That creates a state which a successor
  // on the same seat must not inherit — checkable here without EUDIPLO, unlike `verified`
  // (which is true anyway with empty attribute sets).
  rGuest1.ws.send(JSON.stringify({ type: 'confirm' }));
  await new Promise((r) => setTimeout(r, 300));
  rGuest1.ws.close();
  await new Promise((r) => setTimeout(r, 400));
  const rGuest2 = await join({ roomId: rj.json.room, inv: rj.json.guestToken, clientId: 'rj-guest-tab3' });
  openSockets.push(rGuest2.ws);
  check('an orphaned seat is reclaimed through the invitation',
    rGuest2.first.type === 'joined' && rGuest2.first.role === 'callee', JSON.stringify(rGuest2.first));
  check('the reclaimed seat is the same one (peerId unchanged)',
    rGuest2.first.peerId === guestPeerId, `${guestPeerId} -> ${rGuest2.first.peerId}`);
  const rStatus = rGuest2.seen.find((m) => m.type === 'status');
  check('the status arrives (otherwise the following proves nothing)', !!rStatus && !!rStatus.self, JSON.stringify(rStatus));
  check("the predecessor's consent is NOT inherited",
    rStatus?.self?.confirmed === false, JSON.stringify(rStatus?.self));

  // And the counter-proof: without the reset the consent would still be there. The host, who
  // stayed connected throughout, keeps their state — only the taken-over seat is cleared.
  const hStatus = [...rHost.seen].reverse().find((m) => m.type === 'status');
  check('the continuously connected host keeps their seat',
    hStatus?.self?.role === 'caller', JSON.stringify(hStatus?.self));

  console.log('\nNo EUDIPLO needed');
  check('the server contacted no verifier', !serverLog.join('').includes('[eudiplo] offer'));

  for (const ws of openSockets) ws.close();
} catch (e) {
  failures++;
  console.error('\nAborted:', e.message);
  if (serverLog.length) console.error(serverLog.join('').slice(-2000));
} finally {
  server.kill('SIGTERM');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
