// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Conformance and negative tests against ERICA, the BMI's EUDI wallet simulator — with a real
 * EUDIPLO in between, so the cryptography is real for once (every other test uses a fake).
 *
 * What a run covers, per scenario:
 *   - a room of two: the host verifies normally, the guest presents what the scenario says;
 *   - ERICA checks the request EUDIPLO built from OUR configuration (DCQL, JAR, x509_hash …);
 *   - ERICA produces the credential (valid, expired, bad signature, wrong nonce …);
 *   - the app must count the guest as verified exactly when the presentation is good, show the
 *     right name, and never pass on anything that was not requested.
 *
 * Two places where this script does a wallet's work itself instead of ERICA:
 *   - It fetches the request_uri and hands ERICA the request BY VALUE. ERICA refuses http:// and
 *     private addresses (SSRF guard, not configurable), and inside Docker everything is both.
 *   - It encrypts and POSTs the response. ERICA puts `iss`, `aud` and `nonce` into the
 *     direct_post.jwt payload (left over from JARM); OpenID4VP 1.0 has only `vp_token` and
 *     `state` there and EUDIPLO 9.1 rejects unknown keys with HTTP 400. ERICA's error modes all
 *     live inside the vp_token, so nothing is lost by sending it in a spec-conformant envelope.
 *
 * `--live` instead checks only the REQUEST of a live EUDIPLO (ERICA fetches it over HTTPS
 * itself); nothing is presented and the session is deleted afterwards.
 *
 * Usage: npm run test:erica  |  npm run test:erica:live   (both via test/erica/docker-compose.yml)
 * Exit code: number of failed hard checks. Report: $ERICA_REPORT_DIR/junit.xml + sessions.json
 */
import { randomUUID, randomBytes, createHash, createCipheriv, createPublicKey, generateKeyPairSync, diffieHellman } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LIVE = process.argv.includes('--live');
const ERICA = (process.env.ERICA_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const APP = (process.env.APP_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const APP_BOUND = (process.env.APP_BOUND_URL || '').replace(/\/+$/, '');
const REPORT_DIR = process.env.ERICA_REPORT_DIR || 'test/erica/report';
const WAIT_MS = 20000;

/** What every room asks for and shares. Both names, so extractNames is exercised; age_over_18
 *  as well, so the incomplete-birthdate template has something to say. */
const ATTRS = ['given_name', 'family_name', 'age_over_18'];

/** ERICA findings that only exist because the stack runs locally, not because of our
 *  configuration. Reported as skipped in local mode, as failures in live mode. */
const LOCAL_ONLY = {
  'syntax.response_uri.https': 'response_uri is http:// inside the Docker network',
  'url.request_jwt.x5c_trust_anchor': 'local EUDIPLO uses a self-signed access certificate',
};

/** ERICA findings that say nothing about the request, in both modes. Locally they never show:
 *  a LOCAL_ONLY error ends ERICA's validation before its PID profile runs. */
const ERICA_DEFECTS = {
  // PIDPresentationProfile reads request.verifierInfo after normalizeRequest renamed it to
  // verifier_info, so it fails on every request. runLive checks verifier_info itself.
  'profile.verifier_info.presence': 'ERICA bug: fails on every request (checked by this script instead)',
};
/** ERICA errors that are recommendations elsewhere: shown, not enforced. */
const ERICA_STRICTER = {
  'profile.iss.presence': 'OpenID4VP 1.0 does not require iss in the request object, RFC 9101 recommends it; EUDIPLO sets the request object, not the app',
};

// ------------------------------------------------------------------ Report ----
const results = [];          // { suite, name, status: pass|fail|skip|info, detail }
const sessions = [];
let failures = 0;
let suite = '';

function section(name) { suite = name; console.log(`\n${name}`); }

/** hard: a failure counts against the exit code. Otherwise it is reported, not enforced. */
function check(name, ok, detail = '', { hard = true } = {}) {
  const status = ok ? 'pass' : hard ? 'fail' : 'info';
  if (status === 'fail') failures++;
  results.push({ suite, name, status, detail: ok ? '' : detail });
  console.log(`  ${ok ? '✓' : hard ? '✗' : '~'} ${name}${ok ? '' : ` — ${detail}${hard ? '' : ' (informational)'}`}`);
}

function warn(name, detail) {
  results.push({ suite, name, status: 'info', detail });
  console.log(`  ! ${name}${detail ? ` — ${detail}` : ''}`);
}

function skip(name, reason) {
  results.push({ suite, name, status: 'skip', detail: reason });
  console.log(`  - ${name} — skipped: ${reason}`);
}

const xml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

function writeReport() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const suites = [...new Set(results.map((r) => r.suite))].map((name) => {
    const rs = results.filter((r) => r.suite === name);
    const cases = rs.map((r) => {
      const body = r.status === 'fail' ? `<failure message="${xml(r.detail)}"/>`
        : r.status === 'skip' ? `<skipped message="${xml(r.detail)}"/>`
        : r.status === 'info' ? `<system-out>${xml(`informational: ${r.detail}`)}</system-out>` : '';
      return `    <testcase classname="erica.${xml(name)}" name="${xml(r.name)}">${body}</testcase>`;
    });
    const n = (s) => rs.filter((r) => r.status === s).length;
    return `  <testsuite name="${xml(name)}" tests="${rs.length}" failures="${n('fail')}" skipped="${n('skip')}">\n${cases.join('\n')}\n  </testsuite>`;
  });
  writeFileSync(join(REPORT_DIR, 'junit.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="erica">\n${suites.join('\n')}\n</testsuites>\n`);
  writeFileSync(join(REPORT_DIR, 'sessions.json'), JSON.stringify(sessions, null, 2));
}

// ------------------------------------------------------------------- ERICA ----
async function postJson(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
  return data;
}

/** ERICA's request checks, from URL parsing and from the request validation, without duplicates. */
function requestChecks(parsed, session) {
  const all = [...(parsed?.checks || []), ...(session?.requestValidation?.checks || [])];
  return [...new Map(all.map((c) => [c.checkId, c])).values()];
}

/** Turn ERICA's request findings into test results. Only failed ERRORs fail; WARNINGs are shown. */
function reportRequestChecks(checks) {
  const failed = checks.filter((c) => !c.passed);
  check(`ERICA ran ${checks.length} request checks`, checks.length > 0, 'no checks came back');
  for (const c of failed) {
    const label = `${c.checkId}: ${c.issue || c.checkName}`;
    if (!LIVE && LOCAL_ONLY[c.checkId]) skip(label, LOCAL_ONLY[c.checkId]);
    else if (ERICA_DEFECTS[c.checkId]) skip(label, ERICA_DEFECTS[c.checkId]);
    else if (ERICA_STRICTER[c.checkId]) warn(label, ERICA_STRICTER[c.checkId]);
    else if (c.severity === 'ERROR') check(label, false, c.suggestedFix || c.details || '');
    else warn(label, c.suggestedFix || c.details || '');
  }
}

// -------------------------------------------------------------- the wallet ----
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const withLength = (b) => Buffer.concat([u32(b.length), b]);

/** JWE (ECDH-ES direct key agreement, AES-GCM) to the verifier's key from client_metadata. */
function encryptResponse(request, payload) {
  const key = request.client_metadata?.jwks?.keys?.find((k) => k.use === 'enc' || String(k.alg).startsWith('ECDH-ES'));
  if (!key) throw new Error('client_metadata.jwks carries no encryption key');
  const enc = request.client_metadata.encrypted_response_enc_values_supported?.[0] || 'A128GCM';
  const bytes = { A128GCM: 16, A256GCM: 32 }[enc];
  if (!bytes) throw new Error(`unsupported enc ${enc}`);
  const eph = generateKeyPairSync('ec', { namedCurve: key.crv === 'P-384' ? 'P-384' : 'P-256' });
  const z = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y }, format: 'jwk' }) });
  // Concat KDF (RFC 7518 §4.6.2), one round of SHA-256 is enough for up to 256 bits.
  const cek = createHash('sha256')
    .update(Buffer.concat([u32(1), z, withLength(Buffer.from(enc)), withLength(Buffer.alloc(0)), withLength(Buffer.alloc(0)), u32(bytes * 8)]))
    .digest().subarray(0, bytes);
  const { kty, crv, x, y } = eph.publicKey.export({ format: 'jwk' });
  const header = Buffer.from(JSON.stringify({ alg: 'ECDH-ES', enc, ...(key.kid ? { kid: key.kid } : {}), epk: { kty, crv, x, y } })).toString('base64url');
  const iv = randomBytes(12);
  const cipher = createCipheriv(`aes-${bytes * 8}-gcm`, cek, iv);
  cipher.setAAD(Buffer.from(header));
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return [header, '', iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

/** Fetch the request object behind an offer URI, as a wallet would. */
async function fetchRequest(offerUri) {
  const q = new URL(offerUri.replace(/^[a-z0-9+.-]+:\/\//i, 'https://wallet.invalid/')).searchParams;
  const requestUri = q.get('request_uri');
  if (!requestUri) throw new Error(`offer without request_uri: ${offerUri}`);
  const r = await fetch(requestUri, { method: q.get('request_uri_method') === 'post' ? 'POST' : 'GET' });
  if (!r.ok) throw new Error(`request_uri -> HTTP ${r.status}`);
  const jwt = (await r.text()).trim();
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  return { clientId: q.get('client_id'), jwt, payload };
}

/**
 * Present to an offer: ERICA validates the request and builds the credential, we deliver it.
 * Returns ERICA's request checks and EUDIPLO's answer to the response POST.
 */
async function present(offerUri, { mode = 'VALID', template = 'normal', format = 'dc+sd-jwt' } = {}) {
  const { clientId, jwt, payload } = await fetchRequest(offerUri);
  const byValue = `openid4vp://?client_id=${encodeURIComponent(clientId)}&request=${jwt}`;
  const parsed = (await postJson(`${ERICA}/api/parse-url`, { url: byValue })).data;
  if (!parsed?.request) throw new Error(`ERICA could not parse the request: ${JSON.stringify(parsed?.errors ?? parsed).slice(0, 300)}`);
  const debug = await postJson(`${ERICA}/api/debug`, {
    request: parsed.request, simulationMode: mode, pidTemplate: template, preferredFormat: format, postResponseToUri: false,
  });
  const session = debug.data;
  sessions.push({ suite, mode, template, format, session });
  const vpToken = session?.simulatedResponse?.vp_token;
  const decoded = session?.simulatedResponse?.decodedVPTokens || [];
  if (!vpToken) return { checks: requestChecks(parsed, session), decoded, status: 0, body: '' };
  const response = encryptResponse(payload, { vp_token: vpToken, state: payload.state });
  const r = await fetch(payload.response_uri, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ response }),
  });
  return { checks: requestChecks(parsed, session), decoded, status: r.status, body: await r.text() };
}

// ----------------------------------------------------------------- the app ----
function participant(appUrl, { roomId, wantAuth, dtlsFingerprint }) {
  const seen = [];
  const listeners = new Set();
  const ws = new WebSocket(appUrl.replace(/^http/, 'ws'));
  const send = (o) => ws.send(JSON.stringify(o));
  ws.addEventListener('open', () => send({ type: 'join', roomId, clientId: randomUUID(), wantAuth, dtlsFingerprint }));
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    seen.push(m);
    for (const l of listeners) l();
  });
  return {
    seen, send,
    mark: () => seen.length,
    /** First message of `type` matching `pred` at or after index `from`. */
    wait(type, pred = () => true, from = 0, ms = WAIT_MS) {
      const find = () => seen.slice(from).find((m) => m.type === type && pred(m));
      return new Promise((resolve, reject) => {
        const hit = find();
        if (hit) return resolve(hit);
        const timer = setTimeout(() => { listeners.delete(on); reject(new Error(`timed out waiting for ${type}`)); }, ms);
        const on = () => { const h = find(); if (h) { clearTimeout(timer); listeners.delete(on); resolve(h); } };
        listeners.add(on);
      });
    },
    close: () => { try { ws.close(); } catch {} },
  };
}

/** A room of two: the host asks for ATTRS and verifies with a normal PID, then the guest joins
 *  and holds an offer. What the guest presents is up to the scenario. */
async function room(appUrl, { dtlsFingerprint } = {}) {
  const roomId = randomUUID();
  const host = participant(appUrl, { roomId, wantAuth: false });
  const status = await host.wait('status');
  const mark = host.mark();
  host.send({ type: 'set-config', ...(status.mode ? { mode: status.mode } : {}), requestedAttrs: ATTRS, disclosedAttrs: ATTRS });
  const hostAuth = await host.wait('auth', (m) => !!m.uri, mark);
  const r = await present(hostAuth.uri, { mode: 'VALID' });
  if (r.status !== 200) throw new Error(`the host's own presentation failed: HTTP ${r.status} ${r.body.slice(0, 200)}`);
  await host.wait('status', (m) => m.self?.verified === true);
  const guest = participant(appUrl, { roomId, wantAuth: true, dtlsFingerprint });
  const guestAuth = await guest.wait('auth', (m) => !!m.uri);
  return { host, guest, guestAuth };
}

/** Claim values ERICA adds in OVER_DISCLOSURE mode. None of them may ever reach a participant. */
const OVER_DISCLOSED = ['document_number', 'administrative_number', 'issuing_authority', 'T220001293', '123456789012'];

async function scenario(s) {
  section(s.title);
  const appUrl = s.app || APP;
  let host, guest;
  try {
    const r0 = await room(appUrl, { dtlsFingerprint: s.dtlsFingerprint });
    ({ host, guest } = r0);
    const mark = guest.mark();
    const hostMark = host.mark();
    const r = await present(r0.guestAuth.uri, s);
    if (s.reportRequest) reportRequestChecks(r.checks);
    const hard = s.hard !== false;
    // ERICA's own gaps are skips, not failures: they say nothing about the app.
    if (r.status === 0) return skip('scenario', 'ERICA produced no credential for this mode (see the erica container log)');
    const unmet = s.precondition?.(r);
    if (unmet) return skip('scenario', unmet);

    if (s.expect === 'verified') {
      check('EUDIPLO accepts the presentation (HTTP 200)', r.status === 200, `HTTP ${r.status} ${r.body.slice(0, 240)}`, { hard });
      const verified = await guest.wait('status', (m) => m.self?.verified === true, mark).catch(() => null);
      check('the app counts the guest as verified', !!verified, 'no verified status within the timeout', { hard });
      if (!verified) return;
      if (s.channelBound) check('the verification is channel-bound', verified.self.channelBound === true, 'channelBound stayed false', { hard });
      host.send({ type: 'confirm' });
      guest.send({ type: 'confirm' });
      const revealed = await host.wait('status', (m) => m.revealed === true && !!m.peers?.[0]?.name, hostMark).catch(() => null);
      check('the host sees the guest\'s name after both confirmed', !!revealed, 'no name revealed', { hard });
      if (revealed && s.name) check(`the name reads "${s.name}"`, revealed.peers[0].name === s.name, `got "${revealed.peers[0].name}"`, { hard });
    } else if (s.expect === 'any') {
      // Either outcome is acceptable here; if the guest got in, reveal so a leak would show.
      const verified = await guest.wait('status', (m) => m.self?.verified === true, mark, 5000).catch(() => null);
      console.log(`    EUDIPLO answered HTTP ${r.status}; the guest is ${verified ? '' : 'not '}verified`);
      if (verified) {
        host.send({ type: 'confirm' });
        guest.send({ type: 'confirm' });
        await host.wait('status', (m) => m.revealed === true, hostMark).catch(() => null);
      }
    } else {
      check('EUDIPLO rejects the presentation', r.status >= 400, `HTTP ${r.status}`, { hard: false });
      const reissued = await guest.wait('auth', (m) => !!m.uri && m.uri !== r0.guestAuth.uri, mark).catch(() => null);
      check('the guest gets a fresh offer', !!reissued, 'no new offer after the failed presentation', { hard });
      const leaked = guest.seen.slice(mark).some((m) => m.type === 'status' && m.self?.verified === true)
        || host.seen.slice(hostMark).some((m) => m.type === 'status' && m.peers?.some((p) => p.verified === true));
      check('the guest is NOT counted as verified', !leaked, 'a bad presentation verified the guest', { hard });
    }

    if (s.noLeak) {
      // Give a late status a moment, then look at everything either side ever received.
      await new Promise((res) => setTimeout(res, 1000));
      const all = JSON.stringify([...host.seen, ...guest.seen]);
      const found = OVER_DISCLOSED.filter((v) => all.includes(v));
      check('no over-disclosed claim reaches a participant', found.length === 0, `seen: ${found.join(', ')}`);
    }
  } catch (e) {
    check('scenario ran to the end', false, e.message, { hard: s.hard !== false });
  } finally {
    host?.close();
    guest?.close();
  }
}

// ------------------------------------------------------------------- local ----
const fingerprint = () => `sha-256 ${[...randomBytes(32)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')}`;

const SCENARIOS = [
  { title: 'SD-JWT · valid PID', mode: 'VALID', expect: 'verified', name: 'Erika Mustermann', reportRequest: true },
  ...['EXPIRED', 'NOT_YET_VALID', 'INVALID_SIGNATURE', 'MISSING_SIGNATURE', 'WRONG_NONCE', 'WRONG_AUDIENCE', 'MISSING_HOLDER_BINDING', 'MISSING_CLAIMS']
    .map((mode) => ({ title: `SD-JWT · ${mode}`, mode, expect: 'rejected' })),
  { title: 'SD-JWT · OVER_DISCLOSURE', mode: 'OVER_DISCLOSURE', expect: 'any', noLeak: true },
  { title: 'SD-JWT · special characters', mode: 'VALID', template: 'special-characters', expect: 'verified', name: 'Müñez Bjørgßöñ' },
  { title: 'SD-JWT · double name', mode: 'VALID', template: 'name-duplication', expect: 'verified', name: 'Erika Maria Meier-Lüdenscheidt' },
  { title: 'SD-JWT · name prefix', mode: 'VALID', template: 'name-prefix', expect: 'verified', name: 'Friederike Zu Waldenbrück' },
  { title: 'SD-JWT · incomplete birthdate', mode: 'VALID', template: 'incomplete-birthdate', expect: 'verified', name: 'Peter Schmidt', hard: false },
  // ERICA calls its mdoc support incomplete — reported, not enforced.
  { title: 'mdoc · valid PID', mode: 'VALID', format: 'mso_mdoc', expect: 'verified', name: 'Erika Mustermann', hard: false },
  {
    title: 'mdoc · EXPIRED', mode: 'EXPIRED', format: 'mso_mdoc', expect: 'rejected', hard: false,
    // ERICA a34ffd1 ignores EXPIRED for mdoc and issues a valid one; the test would prove nothing.
    precondition: (r) => r.decoded.some((d) => Date.parse(d.metadata?.validUntil) > Date.now())
      && 'ERICA issued an mdoc that is still valid (EXPIRED not implemented for mdoc)',
  },
];

async function runLocal() {
  for (const s of SCENARIOS) await scenario(s);
  if (APP_BOUND) {
    // ERICA ignores transaction_data, i.e. it behaves like a wallet that drops the binding.
    // That must not get through: the KB-JWT has no transaction_data_hashes, EUDIPLO must refuse.
    await scenario({
      title: 'SD-JWT · channel binding dropped by the wallet', app: APP_BOUND, mode: 'VALID', expect: 'rejected',
      dtlsFingerprint: fingerprint(), reportRequest: true,
    });
  }
}

// -------------------------------------------------------------------- live ----
async function runLive() {
  const base = (process.env.EUDIPLO_LIVE_URL || '').replace(/\/+$/, '');
  const clientId = process.env.EUDIPLO_LIVE_CLIENT_ID;
  const secret = process.env.EUDIPLO_LIVE_CLIENT_SECRET;
  section(`Live request check · ${base || '(no EUDIPLO_LIVE_URL)'}`);
  if (!base || !clientId || !secret) {
    check('EUDIPLO_LIVE_URL, EUDIPLO_LIVE_CLIENT_ID and EUDIPLO_LIVE_CLIENT_SECRET are set', false, 'nothing to check against');
    return;
  }
  const { access_token: token } = await postJson(`${base}/api/oauth2/token`, { client_id: clientId, client_secret: secret });
  const auth = { authorization: `Bearer ${token}` };
  let requestId = process.env.EUDIPLO_LIVE_REQUEST_ID;
  if (!requestId) {
    // The configs the app registers (configId in src/server.ts); the PID gate's is what wallets see most.
    const configs = await (await fetch(`${base}/api/verifier/config`, { headers: auth })).json();
    requestId = (Array.isArray(configs) ? configs : []).map((c) => c.id).find((id) => !String(id).startsWith('cred_'));
  }
  check('a verifier config to check exists', !!requestId, 'set EUDIPLO_LIVE_REQUEST_ID');
  if (!requestId) return;
  console.log(`  config ${requestId}`);
  const offer = await postJson(`${base}/api/verifier/offer`, { response_type: 'uri', requestId }, auth);
  const sessionId = offer.session ?? offer.sessionId;
  try {
    // By reference: ERICA fetches the live request_uri over HTTPS itself, with all its checks.
    const parsed = (await postJson(`${ERICA}/api/parse-url`, { url: offer.uri })).data;
    const debug = parsed?.request
      ? await postJson(`${ERICA}/api/debug`, { request: parsed.request, simulationMode: 'VALID', postResponseToUri: false })
      : null;
    sessions.push({ suite, requestId, session: debug?.data, parsed });
    check('ERICA fetched and parsed the live request', !!parsed?.request, JSON.stringify(parsed?.errors ?? parsed).slice(0, 300));
    reportRequestChecks(requestChecks(parsed, debug?.data));
    // What ERICA's verifier_info check should have looked at (parsed.request is the JWT payload).
    // EUDIPLO drops the registration certificate without a word when the tenant has no registrar.
    const info = parsed?.request?.verifier_info;
    check('the request relays the registration certificate (verifier_info)',
      Array.isArray(info) ? info.length > 0 : !!info,
      'no verifier_info; is a registrar configured for the tenant? See README, "Registration certificate"');
  } finally {
    if (sessionId) {
      const r = await fetch(`${base}/api/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: auth });
      check('the live session is deleted again', r.ok || r.status === 404, `HTTP ${r.status}`, { hard: false });
    }
  }
}

// -------------------------------------------------------------------- main ----
try {
  const health = await fetch(`${ERICA}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`ERICA unreachable at ${ERICA}`);
  if (LIVE) await runLive(); else await runLocal();
} catch (e) {
  section('Run');
  check('the run completed', false, e.message);
}
writeReport();
const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${count('pass')} passed, ${count('fail')} failed, ${count('info')} informational, ${count('skip')} skipped`);
console.log(failures ? `\n✗ ${failures} hard check(s) failed` : '\n✓ all hard checks passed');
process.exit(failures);
