// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * QES ceremony test suite (Node, no browser) — public/qes/ §10 Phase 7.
 *
 * Runs the SAME modules the browser uses (public/qes/* + vendored bundles) under
 * Node's WebCrypto:
 *   1. unit tests of the identity matching (normalization, umlauts, CN fallback)
 *   2. integration test of the two-signer PAdES ceremony: demo certs from PID names,
 *      incremental placeholder + CAdES CMS per signer, prefix invariant, both
 *      signatures cryptographically verified, coverage + identity binding checked
 *      through the validation module.
 *
 * Usage: npm run test:qes
 */
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
globalThis.self = globalThis; // browser modules address WebCrypto as self.crypto

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const qes = (f) => import(join(root, 'public', 'qes', f));

let failed = 0;
function check(ok, label, detail) {
  console.log((ok ? '  ok  ' : '  FAIL') + ' ' + label + (detail !== undefined ? ' → ' + detail : ''));
  if (!ok) failed++;
}

// ---- 1. identity matching (unit) ----
console.log('identity matching:');
const identity = await qes('identity.js');
check(identity.normalizeName('Müller-Lüdenscheidt') === 'mueller luedenscheidt', 'umlaut + hyphen');
check(identity.normalizeName('Weiß') === 'weiss', 'ß transliteration');
check(identity.normalizeName('José  García') === 'jose garcia', 'diacritics + whitespace');
check(identity.matchIdentity({ cn: 'Anna Host', given: 'Anna', family: 'Host' }, { givenName: 'ANNA', familyName: 'Host' }).status === 'match', 'structured match, case-insensitive');
check(identity.matchIdentity({ cn: 'Anna Host', given: 'Anna', family: 'Host' }, { givenName: 'Eva', familyName: 'Host' }).status === 'mismatch', 'given-name mismatch');
check(identity.matchIdentity({ cn: 'X', given: '', family: '' }, { givenName: '', familyName: '' }).status === 'unknown', 'anonymous → unknown');
check(identity.matchIdentity({ cn: 'Müller Anna', given: '', family: '' }, { givenName: 'Anna', familyName: 'Mueller' }).status === 'match', 'CN fallback, reversed order + umlaut');

// ---- 2. two-signer ceremony (integration) ----
console.log('two-signer PAdES ceremony:');
// pkijs needs an explicit engine under Node (the browser default engine self-registers).
const { pkijs } = await import(join(root, 'public', 'vendor', 'pkijs', 'pkijs.bundle.mjs'));
pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto }));

const providers = await qes('providers.js');
const pades = await qes('pades.js');
const verify = await qes('verify.js');

/** Inline provider around the exported demo-cert + CMS builders — the mock's contract. */
async function demoProvider(identityNames) {
  const session = await providers.makeDemoCert(identityNames);
  return {
    qualified: false,
    async authorize() {},
    async sign(data) {
      return { cms: await providers.buildDetachedCms(data, session.cert, session.keys.privateKey), subject: session.subject };
    },
  };
}

// Minimal in-memory test PDF (one page suffices).
function makeTestPdf() {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>';
  const text = 'BT /F1 24 Tf 72 700 Td (QES ceremony test) Tj ET';
  objs[4] = `STREAM:${text}`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
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

const base = makeTestPdf();
const anna = { givenName: 'Anna', familyName: 'Host' };
const guest = { givenName: 'Gustav', familyName: 'Guest' };

const pA = await demoProvider(anna);
const v1 = await pades.addSignature(base, { provider: pA, signerName: 'Anna Host', reason: 'test', firstSignature: true });
check(v1.bytes.byteLength > base.byteLength, 'step 1 grows the file', `${base.byteLength} → ${v1.bytes.byteLength}`);
check(v1.subject === 'Anna Host', 'step 1 subject from PID names', v1.subject);

const pB = await demoProvider(guest);
const v2 = await pades.addSignature(v1.bytes, { provider: pB, signerName: 'Gustav Guest', reason: 'test', firstSignature: false });
check(pades.isPrefixOf(v1.bytes, v2.bytes), 'prefix invariant: signature 1 untouched by step 2');
check(pades.countSignatures(v2.bytes) === 2, 'two signature dictionaries', pades.countSignatures(v2.bytes));

const results = await verify.analyzeAllSignatures(v2.bytes, [
  { label: 'Anna', pid: anna },
  { label: 'Gustav', pid: guest },
]);
check(results.length === 2, 'validation finds both signatures', results.length);
check(results.every((r) => r.verified), 'both CMS cryptographically valid');
check(results[0].binding.status === 'match' && results[0].binding.label === 'Anna', 'signature 1 bound to Anna', results[0].binding.label);
check(results[1].binding.status === 'match' && results[1].binding.label === 'Gustav', 'signature 2 bound to Gustav', results[1].binding.label);
check(results[1].coverage.wholeFile, 'newest signature covers the whole file');
check(results.every((r) => r.details.selfSigned), 'demo certs flagged self-signed');
check(results.every((r) => r.signingTime instanceof Date && Math.abs(Date.now() - r.signingTime) < 10 * 60_000),
  'signing time read from the signature dictionary (/M)', results.map((r) => r.signingTime).join(', '));

// PAdES baseline shape of the CMS: signingCertificateV2 present, signing-time absent.
{
  const identityMod = await qes('identity.js');
  const [sig] = identityMod.extractSignatureRanges(v2.bytes);
  const ci = pkijs.ContentInfo.fromBER(sig.cmsDer.buffer.slice(sig.cmsDer.byteOffset, sig.cmsDer.byteOffset + sig.cmsDer.byteLength));
  const attrs = new pkijs.SignedData({ schema: ci.content }).signerInfos[0].signedAttrs.attributes.map((a) => a.type);
  check(attrs.includes('1.2.840.113549.1.9.16.2.47'), 'signingCertificateV2 attribute present', attrs.join(','));
  check(!attrs.includes('1.2.840.113549.1.9.5'), 'no signing-time attribute (PAdES forbids it)');
}

// Tamper check: flip one byte inside the signed area → newest signature must fail.
const tampered = v2.bytes.slice();
tampered[200] ^= 0xff;
const tamperedRes = await verify.analyzeAllSignatures(tampered, []);
check(tamperedRes.some((r) => !r.verified), 'tampered byte breaks verification');

console.log(failed ? `\n${failed} test(s) FAILED` : '\nall tests passed');
process.exit(failed ? 1 : 0);
