// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/* Identity binding for the in-call signing ceremony —
 * the product's core claim: "the signer IS the verified call partner".
 *
 * After every signing step the RECEIVING side re-derives the signer's identity from
 * the DOCUMENT ITSELF (never from a chat message): the newest CMS container is pulled
 * out of the PDF's last /ByteRange, its signature is verified against the signed
 * bytes, the signing certificate is parsed (PKI.js) and its subject attributes are
 * matched against the PID claims that signer presented in the call. The match runs
 * exclusively client-side — neither certificate contents nor PID values touch the
 * server.
 *
 * Matching is tolerant where eID reality demands it: Unicode NFC, case-insensitive,
 * German umlaut transliteration (ä↔ae, ß↔ss), stripped diacritics and collapsed
 * whitespace. Certificates without given/surname attributes fall back to a CN
 * comparison (both orderings). With no PID claims to compare against (anonymous
 * participant) the result is 'unknown', shown as such — never silently green.
 */

let pki = null;
async function loadPki() {
  if (!pki) pki = await import(new URL('../vendor/pkijs/pkijs.bundle.mjs', import.meta.url).href);
  return pki;
}

const OID = { cn: '2.5.4.3', surname: '2.5.4.4', serial: '2.5.4.5', given: '2.5.4.42', org: '2.5.4.10' };

function toU8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }
function latin1(bytes) {
  const u = toU8(bytes);
  let s = '';
  for (let i = 0; i < u.byteLength; i += 65536) s += String.fromCharCode(...u.subarray(i, Math.min(i + 65536, u.byteLength)));
  return s;
}
function hexToU8(h) { return new Uint8Array(h.match(/.{2}/g).map((b) => parseInt(b, 16))); }

/**
 * Parse ALL embedded signatures ({ ranges, cmsDer }) in file order. The newest
 * incremental update is the LAST entry. (Shared with qes/verify.js.)
 */
export function extractSignatureRanges(bytes) {
  const s = latin1(bytes);
  const out = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m;
  while ((m = re.exec(s))) {
    const [b0, l0, b1, l1] = m.slice(1).map(Number);
    const hexStr = s.slice(b0 + l0, b1).replace(/[<>]/g, '').replace(/(00)+$/, '');
    if (hexStr.length && hexStr.length % 2 === 0) {
      out.push({ ranges: [b0, l0, b1, l1], cmsDer: hexToU8(hexStr), pdfTime: sigDictTime(s, m.index, b1) });
    }
  }
  return out;
}

/**
 * The /M (signing time) of the signature dictionary around a /ByteRange. PAdES forbids the CMS
 * signing-time attribute, so this is where the claimed time lives. The dictionary's entries sit
 * around the /Contents gap: looked for right after the gap first, then just before /ByteRange.
 * A claimed time, like the CMS attribute was — not a timestamp.
 */
function sigDictTime(s, byteRangeAt, contentsEnd) {
  const re = /\/M\s*\(D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?\)/;
  const m = re.exec(s.slice(contentsEnd, contentsEnd + 1024)) || re.exec(s.slice(Math.max(0, byteRangeAt - 1024), byteRangeAt));
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', se = '00', tz = 'Z'] = m;
  const zone = tz === 'Z' ? 'Z' : tz.replace(/'/g, '').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${zone}`);
  return Number.isNaN(t.getTime()) ? null : t;
}

export function subjectAttrs(cert) {
  const get = (oid) => {
    const tv = cert.subject.typesAndValues.find((t) => t.type === oid);
    return tv ? String(tv.value.valueBlock.value || '') : '';
  };
  return { cn: get(OID.cn), given: get(OID.given), family: get(OID.surname), serial: get(OID.serial), org: get(OID.org) };
}

/** Full verification input for ONE extracted signature: CMS check + cert details. */
export async function verifyExtractedSignature(bytes, sig) {
  const { pkijs } = await loadPki();
  const [b0, l0, b1, l1] = sig.ranges;
  const u = toU8(bytes);
  const payload = new Uint8Array(l0 + l1);
  payload.set(u.subarray(b0, b0 + l0), 0);
  payload.set(u.subarray(b1, b1 + l1), l0);
  const ci = pkijs.ContentInfo.fromBER(sig.cmsDer.buffer.slice(sig.cmsDer.byteOffset, sig.cmsDer.byteOffset + sig.cmsDer.byteLength));
  const sd = new pkijs.SignedData({ schema: ci.content });
  let verified = false;
  try { verified = await sd.verify({ signer: 0, data: payload.buffer, checkChain: false }); } catch { /* stays false */ }
  const cert = (sd.certificates && sd.certificates[0]) || null;
  let details = null;
  if (cert) {
    const issuerCn = cert.issuer.typesAndValues.find((t) => t.type === OID.cn);
    const issuerOrg = cert.issuer.typesAndValues.find((t) => t.type === OID.org);
    // Self-signed heuristic (demo certs): identical subject/issuer DER.
    const selfSigned = cert.subject.toSchema().toBER(false).byteLength === cert.issuer.toSchema().toBER(false).byteLength
      && hexOf(cert.subject.toSchema().toBER(false)) === hexOf(cert.issuer.toSchema().toBER(false));
    details = {
      subject: subjectAttrs(cert),
      issuer: [issuerCn && issuerCn.value.valueBlock.value, issuerOrg && issuerOrg.value.valueBlock.value].filter(Boolean).join(' · '),
      serial: hexOf(cert.serialNumber.valueBlock.valueHexView || cert.serialNumber.valueBlock.valueHex),
      notBefore: cert.notBefore.value, notAfter: cert.notAfter.value,
      selfSigned,
    };
  }
  // Signing time: the signed attribute (OID 1.2.840.113549.1.9.5) of older demo signatures,
  // otherwise the /M of the signature dictionary (see sigDictTime).
  let signingTime = null;
  try {
    const attrs = sd.signerInfos[0].signedAttrs && sd.signerInfos[0].signedAttrs.attributes;
    const st = attrs && attrs.find((a) => a.type === '1.2.840.113549.1.9.5');
    if (st) signingTime = st.values[0].toDate();
  } catch { /* optional */ }
  if (!signingTime && sig.pdfTime) signingTime = sig.pdfTime;
  return { verified, details, signingTime };
}
function hexOf(buf) { return [...toU8(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }

/**
 * Analyze the NEWEST signature in a signed PDF: cryptographic check of the CMS
 * against its ByteRange + parsed subject of the signing certificate.
 * Returns { count, verified, subject } or null when no signature was found.
 */
export async function analyzeNewestSignature(bytes) {
  const sigs = extractSignatureRanges(bytes);
  if (!sigs.length) return null;
  const r = await verifyExtractedSignature(bytes, sigs[sigs.length - 1]);
  return { count: sigs.length, verified: r.verified, subject: r.details ? r.details.subject : null };
}

/** Tolerant normalization: NFC → umlaut transliteration → strip diacritics → casefold. */
export function normalizeName(s) {
  return String(s || '')
    .normalize('NFC')
    .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/gi, 'ss')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

/**
 * Match a certificate subject against the signer's presented PID names.
 * pid = { givenName, familyName } (empty strings when nothing was presented).
 * → { status: 'match'|'mismatch'|'unknown', certName, pidName }
 */
export function matchIdentity(subject, pid) {
  const certName = subject ? (subject.cn || [subject.given, subject.family].filter(Boolean).join(' ')) : '';
  const pidGiven = normalizeName(pid && pid.givenName);
  const pidFamily = normalizeName(pid && pid.familyName);
  const pidName = [pid && pid.givenName, pid && pid.familyName].filter(Boolean).join(' ');
  if (!subject) return { status: 'unknown', certName, pidName };
  if (!pidGiven && !pidFamily) return { status: 'unknown', certName, pidName };

  const cGiven = normalizeName(subject.given);
  const cFamily = normalizeName(subject.family);
  if (cGiven && cFamily) {
    const ok = (!pidGiven || cGiven === pidGiven) && (!pidFamily || cFamily === pidFamily);
    return { status: ok ? 'match' : 'mismatch', certName, pidName };
  }
  // No structured name attributes → compare the CN against both name orderings.
  const cn = normalizeName(subject.cn);
  const a = normalizeName(pidName);
  const b = normalizeName([pid.familyName, pid.givenName].filter(Boolean).join(' '));
  const ok = !!cn && (cn === a || cn === b || (!!pidFamily && !pidGiven && cn === pidFamily));
  return { status: ok ? 'match' : 'mismatch', certName, pidName };
}
