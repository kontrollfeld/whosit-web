// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Device-bound signatures (`qes-device`) end to end — everything but the chip.
 *
 * The real key lives in the phone's secure element, which a test cannot reach. So a WebCrypto
 * key stands in for it behind the SAME contract the app's DeviceSigner plugin fulfils (status,
 * publicKey, sign → DER). Everything else is the real thing: the server with the qes-device module, a
 * guest verified through a verifier stand-in, the certificate request over the signalling
 * connection, the demo CA, the provider module the server ships under /pro-client/, and the PAdES
 * ceremony code the browser runs.
 *
 * What must hold:
 *   - Only a participant verified IN THIS CALL gets a certificate.
 *   - The certificate names the person from their PID, not whatever the CSR claims.
 *   - Proof of possession: a CSR not signed by the key it certifies is refused.
 *   - The signed PDF verifies, is bound to the verified person, and is NOT mistaken for a
 *     self-signed demo — nor for a qualified signature.
 *   - One biometric prompt for the certificate, one per signature. Not more.
 *
 * Usage: npm run test:qes-device
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomUUID, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { requireQesDeviceModule, importClient } from './lib/qes-device-module.mjs';
import { verifierResults } from './lib/verifier-results.mjs';

const QES_DEVICE = requireQesDeviceModule('test-qes-device');

if (!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.self = globalThis; // the browser modules address WebCrypto as self.crypto
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('latin1');
globalThis.btoa ??= (s) => Buffer.from(s, 'latin1').toString('base64');

const VERIFIER_PORT = 3992;
const APP_PORT = 3993;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'whosit-qes-device-'));
const CA_FILE = join(work, 'ca.json');

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
  if (req.method === 'DELETE' && p.startsWith('/api/session/')) { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && p.startsWith('/api/session/')) return json(res, 200, results.lookup(p.split('/').pop()));
  return json(res, 404, {});
});
const results = verifierResults();

// ------------------------------------------------------------------- Client ----
function participant(roomId) {
  const seen = [];
  const ws = new WebSocket(`ws://127.0.0.1:${APP_PORT}`);
  const p = {
    ws,
    send: (o) => ws.send(JSON.stringify(o)),
    async wait(type, pred = () => true, ms = 8000) {
      const hit = [...seen].reverse().find((m) => m.type === type && pred(m));
      if (hit) return hit;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out waiting for: ${type}`)), ms);
        const on = (raw) => {
          let m; try { m = JSON.parse(raw.toString()); } catch { return; }
          if (m.type === type && pred(m)) { clearTimeout(t); ws.off('message', on); resolve(m); }
        };
        ws.on('message', on);
      });
    },
    /** The app's requestDeviceCertificate, over this participant's own connection. */
    async requestCertificate(csr) {
      const reqId = randomUUID();
      p.send({ type: 'device-cert-request', reqId, csr });
      const m = await Promise.race([
        p.wait('device-cert', (x) => x.reqId === reqId),
        p.wait('device-cert-error', (x) => x.reqId === reqId),
      ]);
      if (m.type === 'device-cert-error') throw new Error(`refused: ${m.message}`);
      return m.chain;
    },
    close: () => { try { ws.close(); } catch {} },
  };
  ws.on('message', (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
  ws.on('open', () => p.send({ type: 'join', roomId, clientId: randomUUID(), wantAuth: true }));
  return p;
}

// ---------------------------------------------------------- Secure-element stand-in ----
const b64 = (u) => Buffer.from(new Uint8Array(u)).toString('base64');
/** The DeviceSigner contract, with a non-extractable WebCrypto key where the chip would be. */
async function fakeSecureElement() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const prompts = [];
  const { p1363ToDer } = await import(join(root, 'public', 'qes', 'providers.js'));
  return {
    prompts, keys,
    async status() { return { available: true, hardware: 'secure-enclave' }; },
    async publicKey() { return { spki: b64(await webcrypto.subtle.exportKey('spki', keys.publicKey)) }; },
    async sign({ data, reason }) {
      prompts.push(reason);
      const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(data, 'base64'));
      return { signature: b64(p1363ToDer(sig)) };
    },
  };
}

function makeTestPdf() {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>';
  objs[4] = 'STREAM:BT 72 700 Td (device signature test) Tj ET';
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += objs[i].startsWith('STREAM:')
      ? `${i} 0 obj\n<< /Length ${objs[i].length - 7} >>\nstream\n${objs[i].slice(7)}\nendstream\nendobj\n`
      : `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
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
    EUDI_QES_CA_FILE: CA_FILE,
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

  const { pkijs } = await import(join(root, 'public', 'vendor', 'pkijs', 'pkijs.bundle.mjs'));
  pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto }));
  const providers = await import(join(root, 'public', 'qes', 'providers.js'));
  const pades = await import(join(root, 'public', 'qes', 'pades.js'));
  const verify = await import(join(root, 'public', 'qes', 'verify.js'));
  const loadPki = () => import(join(root, 'public', 'vendor', 'pkijs', 'pkijs.bundle.mjs'));

  console.log('\nThe server offers the provider — and ships its code from the module, not from public/');
  const list = await (await fetch(`http://127.0.0.1:${APP_PORT}/signature-providers`)).json();
  const entry = list.providers.find((p) => p.kind === 'device-local');
  check('a device-local provider is offered', !!entry, JSON.stringify(list.providers));
  check('it is not claimed to be qualified', entry && entry.qualified === false);
  const mod = await fetch(`http://127.0.0.1:${APP_PORT}/${entry?.module}`);
  check('its module is served', mod.ok && /createProvider/.test(await mod.text()), `HTTP ${mod.status}`);
  check('with CORS for the app origin', mod.headers.get('access-control-allow-origin') === '*');
  check('not part of the AGPL client', (await fetch(`http://127.0.0.1:${APP_PORT}/qes/device-local.js`)).status === 404);

  const { createProvider } = await importClient(QES_DEVICE, 'device-local.js');

  console.log('\nWithout a secure element, no provider');
  check('no native signer → not offered', (await createProvider(entry, { native: null, requestCertificate: async () => [] })) === null);
  check('secure element unavailable → not offered',
    (await createProvider(entry, { native: { status: async () => ({ available: false, reason: 'StrongBox missing' }) }, requestCertificate: async () => [] })) === null);

  console.log('\nOnly a participant verified in this call gets a certificate');
  const guest = participant(randomUUID());
  clients.push(guest);
  const auth = await guest.wait('auth');
  const se = await fakeSecureElement();
  const early = await createProvider(entry, { native: se, requestCertificate: guest.requestCertificate, loadPki, buildDetachedCmsWith: providers.buildDetachedCmsWith, getIdentity: () => ({}) });
  let refused = '';
  try { await early.authorize(); } catch (e) { refused = e.message; }
  check('refused before verification', /not verified/.test(refused), refused || 'a certificate was issued');

  const sessionId = String(auth.uri).split('/').pop();
  const presented = { session: sessionId, status: 'completed', credentials: [{ values: [{ given_name: 'Erika', family_name: 'Mustermann' }] }] };
  results.record(sessionId, presented);
  await fetch(offers.get(sessionId), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(presented),
  });
  await guest.wait('status', (m) => m.self?.verified === true);

  console.log('\nThe certificate names the verified person and chains to the demo CA');
  se.prompts.length = 0;
  const provider = await createProvider(entry, { native: se, requestCertificate: guest.requestCertificate, loadPki, buildDetachedCmsWith: providers.buildDetachedCmsWith, getIdentity: () => ({}) });
  await provider.authorize();
  check('one prompt to certify the key', se.prompts.length === 1, JSON.stringify(se.prompts));

  // Reach into the provider's result through a signature: the chain travels in the CMS.
  const signed = await pades.addSignature(makeTestPdf(), { provider, signerName: 'Erika Mustermann', reason: 'test', firstSignature: true });
  check('one more prompt for the signature — not more', se.prompts.length === 2, JSON.stringify(se.prompts));
  const [res] = await verify.analyzeAllSignatures(signed.bytes, [{ label: 'Erika', pid: { givenName: 'Erika', familyName: 'Mustermann' } }]);
  check('the signature verifies', res.verified === true);
  check('bound to the verified person', res.binding.status === 'match', JSON.stringify(res.binding));
  check('subject from the PID, not from the CSR', res.details.subject.given === 'Erika' && res.details.subject.family === 'Mustermann', JSON.stringify(res.details.subject));
  check('not mistaken for a self-signed demo', res.details.selfSigned === false);
  check('the issuer says it is a demo', /Demo/.test(res.details.issuer), res.details.issuer);
  check('signing time present (/M)', res.signingTime instanceof Date);

  const { extractSignatureRanges } = await import(join(root, 'public', 'qes', 'identity.js'));
  const [sig] = extractSignatureRanges(signed.bytes);
  const sd = new pkijs.SignedData({ schema: pkijs.ContentInfo.fromBER(sig.cmsDer.slice().buffer).content });
  const [leaf, ca] = sd.certificates;
  const chainOk = await new pkijs.CertificateChainValidationEngine({ trustedCerts: [ca], certs: [leaf] }).verify();
  check('the leaf chains to the demo CA', chainOk.result === true, chainOk.resultMessage);
  const spkiLeaf = Buffer.from(leaf.subjectPublicKeyInfo.toSchema().toBER(false)).toString('base64');
  check('it certifies the device key', spkiLeaf === (await se.publicKey()).spki);
  const ku = leaf.extensions.find((e) => e.extnID === '2.5.29.15');
  check('keyUsage digitalSignature + nonRepudiation, critical', ku && ku.critical && (new Uint8Array(ku.parsedValue.valueBlock.valueHexView)[0] & 0xc0) === 0xc0);
  const attrs = sd.signerInfos[0].signedAttrs.attributes.map((a) => a.type);
  check('PAdES baseline attributes (signingCertificateV2, no signing-time)', attrs.includes('1.2.840.113549.1.9.16.2.47') && !attrs.includes('1.2.840.113549.1.9.5'), attrs.join(','));

  console.log('\nProof of possession');
  {
    // A CSR for the device's public key, signed by some OTHER key: someone asking for a
    // certificate on a key they do not hold.
    const other = await fakeSecureElement();
    const thief = { ...se, sign: other.sign };
    const forged = await createProvider(entry, { native: thief, requestCertificate: guest.requestCertificate, loadPki, buildDetachedCmsWith: providers.buildDetachedCmsWith, getIdentity: () => ({}) });
    let why = '';
    try { await forged.authorize(); } catch (e) { why = e.message; }
    check('a CSR not signed by its own key is refused', /refused/.test(why), why || 'a certificate was issued');
    check('the server says why', /proof of possession/.test(appLog.join('')));
  }

  console.log('\nThe demo CA key is stored privately');
  check('CA file mode 0600', (statSync(CA_FILE).mode & 0o777) === 0o600, (statSync(CA_FILE).mode & 0o777).toString(8));
  check('no PID name in the server log', !/Mustermann/.test(appLog.join('')));
} catch (e) {
  console.error(`\n✗ Test failed: ${e.stack || e.message}\n${appLog.join('')}`);
  failures++;
} finally {
  for (const c of clients) c.close();
  try { process.kill(-app.pid, 'SIGTERM'); } catch {}
  verifier.close();
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
