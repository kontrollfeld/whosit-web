// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Sign with your phone" — the pairing between a browser participant and their phone.
 *
 * The phone has no identity of its own in the call: it signs FOR whoever created the pairing, and
 * its certificate carries THEIR names. So the token is the whole question, and this test asks it
 * from every side:
 *
 *   - only a participant verified in this call can create one;
 *   - it is single-use: a second phone with the same token (a photographed QR code) is refused;
 *   - the phone's certificate names the owner — and is refused once the owner has left the call;
 *   - the server relays the WebRTC signalling both ways and nothing else, and tells the browser
 *     at once when the phone goes away;
 *   - the byte framing used over the DataChannel reassembles a document exactly and rejects a
 *     corrupted one.
 *
 * WebRTC itself cannot run here (Node has no RTCPeerConnection); the DataChannel is replaced by a
 * pair of in-memory ends. Everything else is the real server, the real qes-device module and the real
 * client modules.
 *
 * Usage: npm run test:qes-pairing
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { requireQesDeviceModule, importClient } from './lib/qes-device-module.mjs';
import { verifierResults } from './lib/verifier-results.mjs';

const QES_DEVICE = requireQesDeviceModule('test-qes-pairing');

globalThis.self = globalThis;

const VERIFIER_PORT = 3994;
const APP_PORT = 3995;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'whosit-qes-pairing-'));

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures++;
}

// ------------------------------------------------------------ Verifier stand-in ----
const offers = new Map();
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const verifier = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'POST' && p === '/api/oauth2/token') return json(res, 200, { access_token: 'test-token' });
  if (req.method === 'POST' && p === '/api/verifier/config') return json(res, 200, { ok: true });
  if (req.method === 'POST' && p === '/api/verifier/offer') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const id = randomUUID();
    offers.set(id, body.webhook.url);
    const uri = `http://127.0.0.1:${VERIFIER_PORT}/simulate/${id}`;
    return json(res, 200, { uri, crossDeviceUri: uri, session: id });
  }
  if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && p.startsWith('/api/session/')) return json(res, 200, results.lookup(p.split('/').pop()));
  return json(res, 404, {});
});
const results = verifierResults();

// ------------------------------------------------------------------- Clients ----
function socket(onOpen, port = APP_PORT) {
  const seen = [];
  // Without PUBLIC_URL the server derives its origin from the proxy headers, as behind a reverse proxy.
  // Here there is no proxy, so say what one would: plain http.
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-forwarded-proto': 'http' } });
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
    /** First of several message types — for "either the answer or the refusal". */
    first(types, pred = () => true, ms = 8000) { return Promise.race(types.map((t) => c.wait(t, pred, ms))); },
    close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
  };
  ws.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
  ws.on('open', () => onOpen && onOpen(c));
  return c;
}
const opened = (c) => new Promise((r) => (c.ws.readyState === 1 ? r() : c.ws.once('open', r)));

async function verifiedParticipant(roomId, names, port = APP_PORT) {
  const p = socket((c) => c.send({ type: 'join', roomId, clientId: randomUUID(), wantAuth: true }), port);
  const auth = await p.wait('auth');
  const sessionId = String(auth.uri).split('/').pop();
  const presented = { session: sessionId, status: 'completed', credentials: [{ values: [names] }] };
  results.record(sessionId, presented);
  const r = await fetch(offers.get(sessionId), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(presented),
  });
  if (!r.ok) throw new Error(`webhook ${offers.get(sessionId)} -> ${r.status} ${await r.text()}`);
  await p.wait('status', (m) => m.self?.verified === true);
  return p;
}

async function pairCreate(owner) {
  const reqId = randomUUID();
  owner.send({ type: 'pair-create', reqId });
  return owner.first(['pair-created', 'pair-error'], (m) => m.reqId === reqId);
}

/** What the phone's device-local.js does: CSR signed by the key → certificate over ITS socket. */
function phoneCertRequester(phone) {
  return async (csr) => {
    const reqId = randomUUID();
    phone.send({ type: 'device-cert-request', reqId, csr });
    const m = await phone.first(['device-cert', 'device-cert-error'], (x) => x.reqId === reqId);
    if (m.type === 'device-cert-error') throw new Error(`refused: ${m.message}`);
    return m.chain;
  };
}

const b64 = (u) => Buffer.from(new Uint8Array(u)).toString('base64');
async function fakeSecureElement() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const { p1363ToDer } = await import(join(root, 'public', 'qes', 'providers.js'));
  return {
    async status() { return { available: true, hardware: 'secure-enclave' }; },
    async publicKey() { return { spki: b64(await webcrypto.subtle.exportKey('spki', keys.publicKey)) }; },
    async sign({ data }) {
      return { signature: b64(p1363ToDer(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(data, 'base64')))) };
    },
  };
}

function makeTestPdf() {
  const objs = [null, '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'];
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

// ------------------------------------------------------------------- Server ----
const appLog = [];
const app = spawn('npx', ['tsx', 'src/server.ts'], {
  detached: true,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    PUBLIC_URL: `http://127.0.0.1:${APP_PORT}`,
    EUDI_EDITION: 'community',
    EUDI_PRO_MODULE: '',
    EUDI_MODULES: QES_DEVICE,
    EUDI_AUDIT_FILE: join(work, 'audit.jsonl'),
    EUDI_IOS_APP_ID: 'ABCDE12345.com.example.app',
    EUDIPLO_BASE_URL: `http://127.0.0.1:${VERIFIER_PORT}`,
    EUDIPLO_CLIENT_ID: 'test-tenant',
    EUDIPLO_CLIENT_SECRET: 'test-tenant-secret',
    EUDI_PROMO_ALL_PRO: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (d) => appLog.push(d.toString()));
app.stderr.on('data', (d) => appLog.push(d.toString()));

const clients = [];
try {
  await new Promise((r) => verifier.listen(VERIFIER_PORT, r));
  for (let t0 = Date.now(); ; ) {
    try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/health`)).ok) break; } catch {}
    if (Date.now() - t0 > 25000) throw new Error(`app unreachable\n${appLog.join('')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  const base = `http://127.0.0.1:${APP_PORT}`;

  console.log('\nThe browser is offered the phone, and gets its code from the module');
  const { providers: list } = await (await fetch(`${base}/signature-providers`)).json();
  const phoneEntry = list.find((p) => p.id === 'phone');
  check('a "sign with your phone" provider is offered', phoneEntry?.module === 'pro-client/paired-phone.js', JSON.stringify(list));
  for (const f of ['paired-phone.js', 'paired-signer.js', 'pair-channel.js']) {
    check(`/pro-client/${f} is served`, (await fetch(`${base}/pro-client/${f}`)).ok);
  }
  const aasa = await (await fetch(`${base}/.well-known/apple-app-site-association`)).json();
  check('pairing links open the app (universal link)', JSON.stringify(aasa).includes('"pair"'), JSON.stringify(aasa));

  console.log('\nOnly a participant verified in this call can pair');
  {
    const stranger = socket((c) => c.send({ type: 'join', roomId: randomUUID(), clientId: randomUUID(), wantAuth: true }));
    clients.push(stranger);
    await stranger.wait('auth');
    const r = await pairCreate(stranger);
    check('an unverified participant is refused', r.type === 'pair-error' && /not verified/.test(r.message), JSON.stringify(r));
    const nobody = socket();
    clients.push(nobody);
    await opened(nobody);
    const r2 = await pairCreate(nobody);
    check('a connection outside any call is refused', r2.type === 'pair-error', JSON.stringify(r2));
  }

  const owner = await verifiedParticipant(randomUUID(), { given_name: 'Erika', family_name: 'Mustermann' });
  clients.push(owner);
  const created = await pairCreate(owner);
  check('a verified participant gets a token', created.type === 'pair-created' && created.token.length >= 40, JSON.stringify(created));
  check('and a link the app opens', created.url === `${base}/?pair=${created.token}`, created.url);

  console.log('\nThe token is single-use');
  const phone = socket((c) => c.send({ type: 'pair-join', token: created.token }));
  clients.push(phone);
  const joined = await phone.first(['pair-joined', 'pair-error']);
  check('the phone joins', joined.type === 'pair-joined', JSON.stringify(joined));
  check('the browser learns it', !!(await owner.wait('pair-phone-joined')));
  const second = socket((c) => c.send({ type: 'pair-join', token: created.token }));
  clients.push(second);
  check('a second phone with the same token is refused', (await second.first(['pair-joined', 'pair-error'])).type === 'pair-error');
  const bogus = socket((c) => c.send({ type: 'pair-join', token: 'x'.repeat(43) }));
  clients.push(bogus);
  check('an invented token is refused', (await bogus.first(['pair-joined', 'pair-error'])).type === 'pair-error');

  console.log('\nThe server relays signalling both ways, opaquely');
  owner.send({ type: 'pair-signal', data: { sdp: { type: 'offer', sdp: 'v=0 offer' } } });
  check('browser → phone', (await phone.wait('pair-signal')).data?.sdp?.sdp === 'v=0 offer');
  phone.send({ type: 'pair-signal', data: { ice: { candidate: 'candidate:1' } } });
  check('phone → browser', (await owner.wait('pair-signal')).data?.ice?.candidate === 'candidate:1');
  second.send({ type: 'pair-signal', data: { sdp: 'injected' } });
  await new Promise((r) => setTimeout(r, 300));
  check('a refused phone cannot inject signalling', !owner.seen.some((m) => m.type === 'pair-signal' && m.data?.sdp === 'injected'));

  console.log('\nThe phone signs in the name of the browser participant');
  const [{ createProvider }, providers, pades, verify] = await Promise.all([
    importClient(QES_DEVICE, 'device-local.js'),
    import(join(root, 'public', 'qes', 'providers.js')),
    import(join(root, 'public', 'qes', 'pades.js')),
    import(join(root, 'public', 'qes', 'verify.js')),
  ]);
  const { pkijs } = await providers.loadPki();
  pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto }));
  const device = await createProvider({ id: 'device', label: 'x' }, {
    native: await fakeSecureElement(), requestCertificate: phoneCertRequester(phone),
    loadPki: providers.loadPki, buildDetachedCmsWith: providers.buildDetachedCmsWith,
  });
  await device.authorize();
  const signed = await pades.addSignature(makeTestPdf(), { provider: device, signerName: 'Erika Mustermann', reason: 'test', firstSignature: true });
  const [res] = await verify.analyzeAllSignatures(signed.bytes, [{ label: 'Erika', pid: { givenName: 'Erika', familyName: 'Mustermann' } }]);
  check('the signature verifies', res.verified === true);
  check('the certificate names the owner, though the phone never verified', res.binding.status === 'match', JSON.stringify(res.details?.subject));

  console.log('\nThe byte framing over the DataChannel');
  {
    const { sendBytes, receiver, listen, CHUNK } = await importClient(QES_DEVICE, 'pair-channel.js');
    // Attached the way the modules attach it: a DataChannel delivers MessageEvents, not strings.
    {
      let hit = null;
      const dc = {};
      listen(dc, { onMessage: (m) => { hit = m; }, onPayload() {}, onError() {} });
      await dc.onmessage({ data: JSON.stringify({ t: 'status', s: 'reviewing' }) });
      check('listen() reads the message out of the event', hit && hit.s === 'reviewing', JSON.stringify(hit));
    }
    const got = [];
    let corrupted = null;
    const handler = receiver({ onMessage: (m) => got.push(['msg', m]), onPayload: (h, b) => got.push(['payload', h, b]), onError: (e) => { corrupted = e; } });
    const end = { bufferedAmount: 0, sent: [], send(s) { this.sent.push(s); } };
    const doc = new Uint8Array(CHUNK * 3 + 123).map((_, i) => (i * 31) & 0xff);
    await sendBytes(end, 'doc', doc, { name: 'x.pdf' });
    for (const s of end.sent) await handler(s);
    const p = got.find((g) => g[0] === 'payload');
    check('a multi-chunk document arrives byte-identical', p && p[1].name === 'x.pdf' && Buffer.compare(Buffer.from(p[2]), Buffer.from(doc)) === 0);
    const end2 = { bufferedAmount: 0, sent: [], send(s) { this.sent.push(s); } };
    await sendBytes(end2, 'doc', doc);
    const tampered = JSON.parse(end2.sent[2]);
    tampered.d = Buffer.from('tampered').toString('base64');
    end2.sent[2] = JSON.stringify(tampered);
    for (const s of end2.sent) await handler(s);
    check('a corrupted document is rejected, not handed on', corrupted && /corrupted/.test(corrupted.message) && got.filter((g) => g[0] === 'payload').length === 1);
  }

  console.log('\nWhen the phone goes away, the browser knows at once');
  await phone.close();
  check('pair-closed reaches the browser', (await owner.wait('pair-closed')).reason === 'phone-left');

  console.log('\nOnce the owner has left the call, their phone signs for nobody');
  {
    const created2 = await pairCreate(owner);
    const phone2 = socket((c) => c.send({ type: 'pair-join', token: created2.token }));
    clients.push(phone2);
    await phone2.wait('pair-joined');
    owner.send({ type: 'hangup' });
    await new Promise((r) => setTimeout(r, 400));
    const device2 = await createProvider({ id: 'device', label: 'x' }, {
      native: await fakeSecureElement(), requestCertificate: phoneCertRequester(phone2),
      loadPki: providers.loadPki, buildDetachedCmsWith: providers.buildDetachedCmsWith,
    });
    let why = '';
    try { await device2.authorize(); } catch (e) { why = e.message; }
    check('certificate refused after the owner hung up', /not verified/.test(why), why || 'a certificate was issued');
  }

  check('no token in the server log', !appLog.join('').includes(created.token));

  console.log('\nThe QR link points at the instance, also without PUBLIC_URL');
  {
    // The normal case behind a reverse proxy: PUBLIC_URL unset. Built from the PUBLIC_URL
    // constant, whose fallback is localhost, the link would open localhost:3000 on the phone.
    // It comes from the request instead, like the wallet's webhook.
    const PORT2 = APP_PORT + 10;
    const env2 = { ...process.env,
      PORT: String(PORT2), EUDI_EDITION: 'community', EUDI_PRO_MODULE: '', EUDI_MODULES: QES_DEVICE,
      EUDI_AUDIT_FILE: join(work, 'audit2.jsonl'), EUDIPLO_BASE_URL: `http://127.0.0.1:${VERIFIER_PORT}`,
      EUDIPLO_CLIENT_ID: 'test-tenant', EUDIPLO_CLIENT_SECRET: 'test-tenant-secret', EUDI_PROMO_ALL_PRO: '' };
    // Empty, not deleted: a deleted variable would be filled from a local .env by dotenv.
    env2.PUBLIC_URL = '';
    const app2 = spawn('npx', ['tsx', 'src/server.ts'], { detached: true, env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
    const log2 = []; app2.stdout.on('data', (d) => log2.push(d.toString())); app2.stderr.on('data', (d) => log2.push(d.toString()));
    try {
      for (let t0 = Date.now(); ; ) {
        try { if ((await fetch(`http://127.0.0.1:${PORT2}/health`)).ok) break; } catch {}
        if (Date.now() - t0 > 25000) throw new Error('second instance unreachable');
        await new Promise((r) => setTimeout(r, 250));
      }
      const o2 = await verifiedParticipant(randomUUID(), { given_name: 'Erika', family_name: 'Mustermann' }, PORT2);
      clients.push(o2);
      const c2 = await pairCreate(o2);
      check('the link uses the requested host, not localhost', c2.url?.startsWith(`http://127.0.0.1:${PORT2}/?pair=`) && !c2.url.includes('localhost'), c2.url);
    } catch (e) { console.error(log2.join('')); throw e; } finally { try { process.kill(-app2.pid, 'SIGTERM'); } catch {} }
  }
} catch (e) {
  console.error(`\n✗ Test failed: ${e.stack || e.message}\n${appLog.join('')}`);
  failures++;
} finally {
  for (const c of clients) try { c.ws.terminate(); } catch {}
  try { process.kill(-app.pid, 'SIGTERM'); } catch {}
  verifier.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
