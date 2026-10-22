// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The verifier status report (src/verifier-status.ts): under whose certificate, through which
 * verifier, asking for what.
 *
 * Two halves. The pure functions against fixed inputs — a real certificate, registration payloads
 * in the shapes the field names allow. Then the server against a fake EUDIPLO that answers like
 * 9.1: it must register its widest PID config at startup (so the registration certificate exists
 * before the first call), read version, access certificate and registration certificate back,
 * write them as one line to EUDI_VERIFIER_STATUS_FILE and hold no secret in that file.
 *
 * Usage: npm run test:verifierstatus
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  certificateInfo, registrationInfo, registeredClaims, collectVerifierStatus, statusLogLines,
} from '../src/verifier-status.ts';

const VERIFIER_PORT = 3988;
const APP_PORT = 3989;

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures++;
}

// A throwaway self-signed certificate (key discarded): CN=whosit verifier test, O=Kontrollfeld GmbH,
// valid until 2036-10-19.
const PEM = `-----BEGIN CERTIFICATE-----
MIIB5DCCAYugAwIBAgIUJENzaocJyOwjeFPo/VvV4s09PMQwCgYIKoZIzj0EAwIw
SDEdMBsGA1UEAwwUd2hvc2l0IHZlcmlmaWVyIHRlc3QxGjAYBgNVBAoMEUtvbnRy
b2xsZmVsZCBHbWJIMQswCQYDVQQGEwJERTAeFw0yNjEwMjIxMzU0MzRaFw0zNjEw
MTkxMzU0MzRaMEgxHTAbBgNVBAMMFHdob3NpdCB2ZXJpZmllciB0ZXN0MRowGAYD
VQQKDBFLb250cm9sbGZlbGQgR21iSDELMAkGA1UEBhMCREUwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAT82cYso2XciFsscqhFv2bdEG3FXzRhAuerfsD8YfkICJDi
dGUjk5HnkUMJaifxVMMKjeHUYQAjAJH+zxFAmbl3o1MwUTAdBgNVHQ4EFgQUcL52
A6N+TGGir9PEqLSL+1wuzoYwHwYDVR0jBBgwFoAUcL52A6N+TGGir9PEqLSL+1wu
zoYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiB0OQqUXaiBABpM
tXhgoFAfjFpSUlGnSHVxW3Mk3RF6MQIgb6upN9ZJveynEEmoQxxzJ/fczj5YxPrf
3bqZn0o5F34=
-----END CERTIFICATE-----`;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtFor = (payload) => `${b64({ alg: 'ES256', typ: 'rc-wrp+jwt' })}.${b64(payload)}.c2ln`;
const WRPRC = {
  sub: 'DE:HRB12345',
  sub_ln: 'Muster Immobilien GmbH',
  name: 'Muster Immobilien',
  intermediary: { sub: 'DE:HRB99999', name: 'Kontrollfeld GmbH' },
  purpose: [{ lang: 'en', content: 'Identity check' }, { lang: 'de', content: 'Identitätsprüfung vor Video-Besichtigungen' }],
  credentials: [
    { format: 'mso_mdoc', meta: { doctype_value: 'eu.europa.ec.eudi.pid.1' }, claims: [{ path: ['eu.europa.ec.eudi.pid.1', 'given_name'] }, { path: ['eu.europa.ec.eudi.pid.1', 'family_name'] }] },
    { format: 'dc+sd-jwt', meta: { vct_values: ['urn:eudi:pid:de:1'] }, claims: [{ path: ['given_name'] }, { path: ['age_equal_or_over', '18'] }] },
  ],
  exp: Math.floor(Date.parse('2027-04-01T00:00:00Z') / 1000),
};

// ------------------------------------------------------------ pure functions ----
console.log('pure functions');
{
  const c = certificateInfo(PEM);
  check('certificate: organisation is the name', c?.name === 'Kontrollfeld GmbH', JSON.stringify(c));
  check('certificate: validity read from the certificate itself', c?.notAfter?.startsWith('2036-10-19'), c?.notAfter);
  check('certificate: fingerprint is the SHA-256 of the DER', c?.fingerprint === '047ded1ab43c9632', c?.fingerprint);
  check('certificate: subject on one line', c?.subject?.includes('CN=whosit verifier test') && !c.subject.includes('\n'), c?.subject);
  const f = certificateInfo('not a pem', { subject: 'CN=Fallback', notAfter: '2027-01-01T00:00:00Z' });
  check('certificate: unparsable PEM falls back to what EUDIPLO says', f?.name === 'CN=Fallback' && f.notAfter === '2027-01-01T00:00:00.000Z', JSON.stringify(f));
  check('certificate: nothing at all is null', certificateInfo(undefined) === null);

  const r = registrationInfo(WRPRC, 'registrar');
  check('registration: legal name preferred', r.name === 'Muster Immobilien GmbH', r.name);
  check('registration: intermediary named', r.intermediary === 'Kontrollfeld GmbH', r.intermediary);
  check('registration: German purpose preferred', r.purpose === 'Identitätsprüfung vor Video-Besichtigungen', r.purpose);
  check('registration: expiry from exp', r.expiresAt === '2027-04-01T00:00:00.000Z', r.expiresAt);
  check('registration: claims deduplicated, mdoc namespace dropped', JSON.stringify(registeredClaims(WRPRC)) === JSON.stringify(['given_name', 'family_name', 'age_equal_or_over.18']), JSON.stringify(registeredClaims(WRPRC)));
  const bare = registrationInfo({}, 'imported');
  check('registration: empty payload does not throw', bare.name === null && bare.claims.length === 0);
  const hostile = registrationInfo({ sub_ln: 'A\nB\u0007C'.padEnd(500, 'x') }, 'imported');
  check('registration: control characters and length stripped', !/[\n\u0007]/.test(hostile.name) && hostile.name.length <= 200, JSON.stringify(hostile.name));

  const base = {
    verifierOff: false, host: 'verifier.example', tenant: 't', defaultTenant: false,
    relyingParty: { name: null, onBehalfOf: null, disclose: false },
    attributes: { policy: 'p2p-call', requested: ['given_name'], permitted: ['given_name'], narrowed: false },
    scopeConfigId: () => 'cfg',
  };
  const failing = await collectVerifierStatus({ ...base, get: async (p) => { const e = new Error('x'); e.status = p.includes('key-chain') ? 403 : 500; throw e; } });
  check('collect: each failed lookup is named, none throws', failing.problems.length === 3 && failing.problems.some((p) => p.includes('access certificate: HTTP 403')), JSON.stringify(failing.problems));
  const off = await collectVerifierStatus({ ...base, verifierOff: true, get: async () => { throw new Error('must not be called'); } });
  check('collect: EUDI_VERIFIER=none asks nobody', off.verifier === 'none' && off.problems.length === 0 && off.tenant === null);
  const soon = statusLogLines({ ...failing, problems: [], accessCertificate: { name: 'X', subject: null, issuer: null, notAfter: new Date(Date.now() + 5 * 86400000).toISOString(), fingerprint: null } });
  check('log: an access certificate running out is warned about', soon.some((l) => l.includes('expires in 5 day')), soon.join(' | '));
}

// ------------------------------------------------------------ server ----
console.log('server against a fake EUDIPLO 9.1');
const configs = new Map();
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const seenAuth = new Set();
const verifier = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'POST' && p === '/api/oauth2/token') return json(res, 200, { access_token: 'tenant-token' });
  if (p.startsWith('/api/') && p !== '/api/oauth2/token') seenAuth.add(req.headers.authorization || '');
  if (req.method === 'POST' && p === '/api/verifier/config') {
    const body = JSON.parse((await readBody(req)) || '{}');
    // Like EUDIPLO with a registrar: the certificate is issued from the query and cached.
    configs.set(body.id, { ...body, registrationCertCache: { jwt: jwtFor(WRPRC), source: 'registrar', expiresAt: WRPRC.exp } });
    return json(res, 200, { ok: true });
  }
  const one = p.match(/^\/api\/verifier\/config\/(.+)$/);
  if (req.method === 'GET' && one) return configs.has(one[1]) ? json(res, 200, configs.get(one[1])) : json(res, 404, {});
  if (req.method === 'GET' && p === '/api/version') return json(res, 200, { version: '9.1.0' });
  if (req.method === 'GET' && p === '/api/key-chain') {
    return json(res, 200, [{ id: 'k1', usageType: 'access', activeCertificate: { pem: PEM, subject: 'whosit verifier test', notAfter: '2036-10-19T13:54:34.000Z' } }]);
  }
  return json(res, 404, { error: 'not found' });
});

const dir = mkdtempSync(join(tmpdir(), 'verifier-status-'));
const file = join(dir, 'verifier-status.json');
const appLog = [];
let app;
try {
  await new Promise((r) => verifier.listen(VERIFIER_PORT, r));
  app = spawn('npx', ['tsx', 'src/server.ts'], {
    detached: true,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      PUBLIC_URL: `http://127.0.0.1:${APP_PORT}`,
      EUDI_EDITION: 'community',
      EUDIPLO_BASE_URL: `http://127.0.0.1:${VERIFIER_PORT}`,
      EUDIPLO_CLIENT_ID: 'muster-tenant',
      EUDIPLO_CLIENT_SECRET: 'muster-secret-never-in-the-file',
      EUDI_VERIFIER_STATUS_FILE: file,
      EUDI_PROMO_ALL_PRO: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout.on('data', (d) => appLog.push(d.toString()));
  app.stderr.on('data', (d) => appLog.push(d.toString()));
  const t0 = Date.now();
  while (!existsSync(file) && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 250));
  check('status file written after startup', existsSync(file), appLog.join(''));
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8');
    const st = JSON.parse(raw);
    check('one line', raw.trim().split('\n').length === 1);
    check('no secret in the file', !raw.includes('muster-secret') && !raw.includes('tenant-token'));
    check('scope config registered at startup, before any call', configs.size === 1 && [...configs.keys()][0].startsWith('pid_req_'), [...configs.keys()].join(','));
    check('verifier host, version and tenant', st.host === `127.0.0.1:${VERIFIER_PORT}` && st.version === '9.1.0' && st.tenant === 'muster-tenant' && st.defaultTenant === false, JSON.stringify(st));
    check('access certificate from the key chain', st.accessCertificate?.name === 'Kontrollfeld GmbH' && st.accessCertificate.fingerprint === '047ded1ab43c9632', JSON.stringify(st.accessCertificate));
    check('registration certificate from the config cache', st.registrationCertificate?.source === 'registrar' && st.registrationCertificate.name === 'Muster Immobilien GmbH' && st.registrationCertificate.intermediary === 'Kontrollfeld GmbH', JSON.stringify(st.registrationCertificate));
    check('requested attributes are the policy\'s', Array.isArray(st.attributes?.requested) && st.attributes.requested.includes('given_name'), JSON.stringify(st.attributes));
    check('no problems', st.problems.length === 0, JSON.stringify(st.problems));
    check('every lookup carried the tenant token', [...seenAuth].every((a) => a === 'Bearer tenant-token') && seenAuth.size === 1, [...seenAuth].join(','));
    check('summary in the log', appLog.join('').includes('Verifier status: EUDIPLO 9.1.0'), appLog.join('').slice(-1500));
  }
} finally {
  if (app) { try { process.kill(-app.pid, 'SIGTERM'); } catch {} }
  verifier.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
