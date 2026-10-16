#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live feasibility test for channel binding:
 * does the (sandbox) wallet sign OpenID4VP `transaction_data` — i.e. would it co-sign
 * the call's DTLS fingerprint — and how does EUDIPLO behave per credential format?
 *
 * Creates FOUR presentation offers against the live EUDIPLO instance and renders a QR
 * page; scan each with the wallet, the script polls the sessions and prints a verdict:
 *
 *   A  SD-JWT VC + transaction_data   ← the actual feasibility question
 *   B  SD-JWT VC  (control: does the wallet hold/present an SD-JWT PID at all?)
 *   C  mdoc      + transaction_data   (expected: EUDIPLO's mdoc verifier ignores TD —
 *                                      documents the silent-pass limitation)
 *   D  mdoc       (baseline — known-good from production)
 *
 * No webhook needed: results are read by polling GET /api/session/{id}.
 *
 * Run:  node scripts/test-channel-binding.mjs
 * Env (same names/defaults as src/eudiplo.ts): EUDIPLO_BASE_URL, EUDIPLO_ROOT_ID,
 * EUDIPLO_ROOT_SECRET, EUDIPLO_CLIENT_ID.
 * NOTE: authenticating rotates the shared tenant secret — the production app recovers
 * automatically (it re-rotates on 401), a brief transient 401 there is expected.
 */
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// No default credentials: the script requires an explicit environment — most easily
// `set -a; . ./.env; set +a` before invoking it.
const BASE = (process.env.EUDIPLO_BASE_URL || '').replace(/\/+$/, '');
const ROOT_ID = process.env.EUDIPLO_ROOT_ID || '';
const ROOT_SECRET = process.env.EUDIPLO_ROOT_SECRET || '';
const TENANT_ID = process.env.EUDIPLO_CLIENT_ID || '';
if (!BASE || !TENANT_ID || (!process.env.EUDIPLO_CLIENT_SECRET && !ROOT_SECRET)) {
  console.error('Missing configuration: EUDIPLO_BASE_URL, EUDIPLO_CLIENT_ID and');
  console.error('EUDIPLO_CLIENT_SECRET (oder EUDIPLO_ROOT_ID + EUDIPLO_ROOT_SECRET) setzen.');
  process.exit(2);
}
const OUT_HTML = process.env.CB_TEST_HTML || '/tmp/channel-binding-test.html';
const POLL_MS = 4000;
const TIMEOUT_MS = 15 * 60 * 1000;

// A realistic-looking (fake) DTLS fingerprint — in the real feature this would be the
// SHA-256 fingerprint of the participant's pre-generated RTCPeerConnection certificate.
const FAKE_FP = 'SHA-256 ' + Array.from({ length: 32 }, () =>
  Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');

// The wallet only signs TD entries whose credential_ids reference the DCQL credential id.
const TX_DATA = [{ type: 'urn:eudi:webrtc:dtls-binding:1', credential_ids: ['pid'], dtls_fingerprint: FAKE_FP }];

const PID_DOCTYPE = 'eu.europa.ec.eudi.pid.1';
// vct candidates for the German sandbox PID. `urn:eudi:pid:de:1` is what the issuer
// preprod.pid-provider.bundesdruckerei.de uses; the others stay as fallbacks for other
// issuers/environments.
const VCT_CANDIDATES = [
  'urn:eudi:pid:de:1',
  'urn:eudi:pid:1',
  'urn:eu.europa.ec.eudi:pid:1',
];

const DCQL_SDJWT = { credentials: [{ id: 'pid', format: 'dc+sd-jwt', meta: { vct_values: VCT_CANDIDATES }, claims: [{ path: ['family_name'] }, { path: ['given_name'] }] }] };
const DCQL_MDOC = { credentials: [{ id: 'pid', format: 'mso_mdoc', meta: { doctype_value: PID_DOCTYPE }, claims: [{ path: [PID_DOCTYPE, 'family_name'], intent_to_retain: false }, { path: [PID_DOCTYPE, 'given_name'], intent_to_retain: false }] }] };

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) { const e = new Error(`${method} ${path} -> ${res.status}`); e.status = res.status; e.body = json; throw e; }
  return json;
}

async function getToken() {
  const root = await req('POST', '/api/oauth2/token', { client_id: ROOT_ID, client_secret: ROOT_SECRET });
  const rot = await req('POST', `/api/client/${TENANT_ID}/rotate-secret`, {}, root.access_token);
  const tenant = await req('POST', '/api/oauth2/token', { client_id: TENANT_ID, client_secret: rot.secret || rot.clientSecret });
  return tenant.access_token;
}

async function ensureConfig(token, id, dcql, description) {
  try { await req('DELETE', `/api/verifier/config/${id}`, undefined, token); } catch { /* not there yet */ }
  await req('POST', '/api/verifier/config', { id, description, lifeTime: 3600, dcql_query: dcql }, token);
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function main() {
  console.log(`[cb-test] EUDIPLO: ${BASE}`);
  console.log(`[cb-test] fake DTLS fingerprint used in transaction_data:\n          ${FAKE_FP}`);
  const token = await getToken();
  console.log('[cb-test] authenticated ✓');

  await ensureConfig(token, 'cbtest_sdjwt', DCQL_SDJWT, 'channel-binding test (SD-JWT VC PID)');
  await ensureConfig(token, 'cbtest_mdoc', DCQL_MDOC, 'channel-binding test (mdoc PID)');
  console.log('[cb-test] verifier configs registered ✓');

  const TESTS = [
    { key: 'A', title: 'SD-JWT VC + transaction_data (Kern-Frage)', requestId: 'cbtest_sdjwt', td: true },
    { key: 'B', title: 'SD-JWT VC without transaction_data (control)', requestId: 'cbtest_sdjwt', td: false },
    { key: 'C', title: 'mdoc + transaction_data (Limitations-Check)', requestId: 'cbtest_mdoc', td: true },
    { key: 'D', title: 'mdoc without transaction_data (baseline)', requestId: 'cbtest_mdoc', td: false },
  ];

  for (const tst of TESTS) {
    const payload = { response_type: 'uri', requestId: tst.requestId };
    if (tst.td) payload.transaction_data = TX_DATA;
    const offer = await req('POST', '/api/verifier/offer', payload, token);
    tst.uri = offer.uri; tst.crossDeviceUri = offer.crossDeviceUri || offer.uri; tst.session = offer.session;
    console.log(`[cb-test] offer ${tst.key} created — session ${tst.session}`);
  }

  // ---- QR page ----
  const blocks = TESTS.map((tst) => `
    <section>
      <h2>Test ${tst.key} — ${esc(tst.title)}</h2>
      <div class="qr" id="qr-${tst.key}"></div>
      <p><a href="${esc(tst.uri)}">Wallet auf diesem Gerät öffnen</a></p>
      <p class="sess">Session: <code>${esc(tst.session)}</code> · <span id="st-${tst.key}">wartet auf Scan …</span></p>
      <script>new QRCode(document.getElementById('qr-${tst.key}'), { text: ${JSON.stringify(tst.crossDeviceUri)}, width: 260, height: 260 });</script>
    </section>`).join('\n');
  writeFileSync(OUT_HTML, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Channel-Binding-Test — QR-Codes</title>
<style>body{font:16px/1.5 system-ui;max-width:640px;margin:4vh auto;padding:0 16px;color:#1b2433}
section{border:1px solid #cfd8e6;border-radius:12px;padding:16px 20px;margin-bottom:20px}
h2{font-size:1.05rem;margin:0 0 10px} .qr{display:flex;justify-content:center;padding:10px} .sess{color:#5d6b85;font-size:.85rem}
code{background:#f1f5f9;padding:1px 6px;border-radius:6px;font-size:.8em}</style>
<script src="https://cdn.jsdelivr.net/gh/davidshimjs/qrcodejs/qrcode.min.js"></script>
<h1>Channel-Binding-Test</h1>
<p>Scan the tests <strong>one after another</strong> (A to D) with the sandbox wallet. The terminal script polls for results.</p>
${blocks}`);
  console.log(`[cb-test] QR page written: ${OUT_HTML}`);
  try { execSync(`open "${OUT_HTML}"`); } catch { /* non-macOS: open manually */ }

  // ---- poll sessions ----
  const t0 = Date.now();
  const done = new Map();
  while (done.size < TESTS.length && Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    for (const tst of TESTS) {
      if (done.has(tst.key)) continue;
      let sess;
      try { sess = await req('GET', `/api/session/${tst.session}`, undefined, token); }
      catch (e) { console.log(`[cb-test] ${tst.key}: session poll failed (${e.status})`); continue; }
      if (tst.lastStatus !== sess.status) { tst.lastStatus = sess.status; console.log(`[cb-test] ${tst.key}: status → ${sess.status}`); }
      if (['completed', 'failed', 'expired'].includes(sess.status)) {
        let logs = [];
        try { logs = await req('GET', `/api/session/${tst.session}/logs`, undefined, token); } catch { /* optional */ }
        done.set(tst.key, { status: sess.status, errorReason: sess.errorReason, credentials: sess.credentials, logs });
      }
    }
  }

  // ---- verdict ----
  console.log('\n================= ERGEBNIS =================');
  for (const tst of TESTS) {
    const r = done.get(tst.key);
    if (!r) { console.log(`Test ${tst.key} (${tst.title}): ⏳ no completion (timeout / not scanned)`); continue; }
    console.log(`Test ${tst.key} (${tst.title}): ${r.status === 'completed' ? '✅ completed' : '❌ ' + r.status}${r.errorReason ? ' — ' + r.errorReason : ''}`);
    if (r.status !== 'completed' && Array.isArray(r.logs)) {
      for (const l of r.logs.slice(-4)) console.log(`    log: ${JSON.stringify(l).slice(0, 220)}`);
    }
  }
  const A = done.get('A'), B = done.get('B'), C = done.get('C'), D = done.get('D');
  console.log('\n---------------- INTERPRETATION ----------------');
  if (A?.status === 'completed') console.log('🎉 A ok -> the wallet signs transaction_data => CHANNEL BINDING LEVEL 2 IS FEASIBLE (SD-JWT path).');
  else if (A && B?.status === 'completed') console.log('⚠️ A failed, B ok -> the wallet presents SD-JWT but signs no transaction_data (EUDIPLO correctly refuses -> fail-safe, but the feature is blocked).');
  else if (A && B && B.status !== 'completed') console.log('⚠️ B failed -> the wallet holds no SD-JWT PID (or the vct does not match) — check the logs above; extend VCT_CANDIDATES if needed.');
  if (C?.status === 'completed') console.log('📝 C ok -> the mdoc path ignores transaction_data (silent pass) — binding is NOT enforced there (as seen in the source).');
  if (D?.status === 'completed') console.log('✓ D ok → mdoc-Baseline funktioniert (Testaufbau valide).');
  writeFileSync('/tmp/channel-binding-results.json', JSON.stringify({ fp: FAKE_FP, results: Object.fromEntries(done) }, null, 2));
  console.log('\n[cb-test] Rohdaten: /tmp/channel-binding-results.json');
}

main().catch((e) => { console.error('[cb-test] ERROR:', e.status || '', e.body || e.message); process.exit(1); });
