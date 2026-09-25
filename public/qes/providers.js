// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/* SignatureProvider abstraction for the in-call QES ceremony (public/qes/ §5).
 *
 * A provider signs a document digest on behalf of THIS participant. The ceremony code
 * (doc-share.js, later ceremony.js) only ever talks to this interface, so mock (demo),
 * CSC remote signing (Pro, Phase 6) and wallet-native QES (ARF, stub) stay swappable:
 *
 *   { id, label, kind, qualified, maxLevel,
 *     authorize(ctx): Promise<void>,             // OAuth/SCA step; no-op for mock
 *     sign(data): Promise<{ cms, certDerB64, subject }> }
 *
 * sign() receives the PAdES ByteRange payload (the document bytes minus the
 * /Contents gap) and resolves to a FINISHED detached CMS/CAdES container that
 * pades.js embeds — the same contract a CSC QTSP fulfils with signDoc
 * (documentDigests), so the ceremony code never branches on the provider kind.
 *
 * IMPORTANT: the MockSigningProvider produces a DEMO signature — a self-signed,
 * session-lifetime certificate whose subject is filled from the participant's own
 * verified PID claims (so the identity-binding demo of Phase 4 works end-to-end).
 * It is NOT a qualified signature and NOT legally binding; the UI must keep the
 * permanent "Demo" banner visible wherever such a signature appears (`qualified:false`
 * travels with every result). Qualified signatures arrive with the CSC/QTSP provider.
 */

const tr = (s, v) => (typeof t === 'function' ? t(s, v) : s);

let pki = null; // lazy { pkijs, asn1js } from the self-hosted vendor bundle
async function loadPki() {
  if (!pki) pki = await import(new URL('../vendor/pkijs/pkijs.bundle.mjs', import.meta.url).href);
  return pki;
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

/**
 * Build a self-signed demo certificate for this session. Subject comes from the
 * participant's own PID claims when they disclosed a name (givenName/surname/CN),
 * otherwise a clearly-labelled demo placeholder.
 * (Exported for scripts/test-qes.mjs — the Node integration test of the ceremony.)
 */
export async function makeDemoCert(identity) {
  const { pkijs, asn1js } = await loadPki();
  const crypto = self.crypto;

  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

  const given = (identity && identity.givenName) || '';
  const family = (identity && identity.familyName) || '';
  const cn = [given, family].filter(Boolean).join(' ') || tr('Demo-Unterzeichner');

  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: Date.now() });
  const attrs = (name) => {
    const out = [new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: name }) })];
    if (given) out.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.42', value: new asn1js.Utf8String({ value: given }) }));
    if (family) out.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.4', value: new asn1js.Utf8String({ value: family }) }));
    out.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.10', value: new asn1js.Utf8String({ value: 'EUDI Verified Call — DEMO (nicht rechtsgültig)' }) }));
    return out;
  };
  cert.subject.typesAndValues = attrs(cn);
  cert.issuer.typesAndValues = attrs(cn); // self-signed: issuer == subject
  cert.notBefore.value = new Date();
  cert.notAfter.value = new Date(Date.now() + 24 * 60 * 60 * 1000); // demo: 24 h
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, 'SHA-256');

  return { keys, cert, certDer: cert.toSchema(true).toBER(false), subject: cn };
}

/**
 * Detached CAdES-ish CMS over `data`: SignedData v1 with the demo certificate and
 * signed attributes contentType + signingTime + messageDigest. (signingCertificateV2
 * and a qualified timestamp are QTSP/Phase-6 territory — this is the demo shape.)
 */
export async function buildDetachedCms(data, cert, privateKey) {
  const { pkijs, asn1js } = await loadPki();
  const digest = await self.crypto.subtle.digest('SHA-256', data);
  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.7.1' }),
    certificates: [cert],
    signerInfos: [new pkijs.SignerInfo({
      version: 1,
      sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
      signedAttrs: new pkijs.SignedAndUnsignedAttributes({
        type: 0,
        attributes: [
          new pkijs.Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' })] }),
          new pkijs.Attribute({ type: '1.2.840.113549.1.9.5', values: [new asn1js.UTCTime({ valueDate: new Date() })] }),
          new pkijs.Attribute({ type: '1.2.840.113549.1.9.4', values: [new asn1js.OctetString({ valueHex: digest })] }),
        ],
      }),
    })],
  });
  await signedData.sign(privateKey, 0, 'SHA-256');
  const cms = new pkijs.ContentInfo({
    contentType: '1.2.840.113549.1.7.2',
    content: signedData.toSchema(true),
  });
  return cms.toSchema().toBER(false);
}

/** The Community demo provider — see the header note: NOT qualified, NOT binding. */
function mockProvider(entry, getIdentity) {
  let session = null; // { keys, certDer, subject } — one demo cert per page session
  return {
    id: entry.id,
    label: entry.label,
    kind: 'mock',
    qualified: false,
    maxLevel: entry.maxLevel || 'B-B',
    async authorize() { /* no SCA for the demo */ },
    /** data = PAdES ByteRange payload → finished detached CMS (see header). */
    async sign(data) {
      if (!session) session = await makeDemoCert(getIdentity());
      const cms = await buildDetachedCms(data, session.cert, session.keys.privateKey);
      return {
        cms,
        certDerB64: b64(session.certDer),
        subject: session.subject,
      };
    },
  };
}

/** Pro CSC remote signing (Phase 6) — declared here so the seam is visible. The signing flow
 *  itself (QTSP OAuth, signHash) is implemented server-side in the commercially licensed
 *  pro/qes-csc.ts; this client only ever sees a 'csc' entry when that module is loaded. */
function cscProvider(entry) {
  return {
    id: entry.id, label: entry.label, kind: 'csc',
    qualified: true, maxLevel: entry.maxLevel || 'B-T',
    async authorize() { throw new Error('NotYetAvailable: CSC signing lands in Phase 6'); },
    async sign() { throw new Error('NotYetAvailable: CSC signing lands in Phase 6'); },
  };
}

/** ARF wallet-native QES (Annex 2, Topics 16/37) — stub until wallets ship QES. */
function walletNativeProvider(entry) {
  return {
    id: entry.id, label: entry.label, kind: 'wallet-native',
    qualified: true, maxLevel: entry.maxLevel || 'B-T',
    async authorize() { throw new Error('NotYetAvailable: wallet-native QES (ARF Topic 16/37)'); },
    async sign() { throw new Error('NotYetAvailable: wallet-native QES (ARF Topic 16/37)'); },
  };
}

/**
 * Fetch the operator's provider list (server-filtered by edition — Community only
 * ever receives 'mock') and wrap each entry in its implementation.
 * `getIdentity(): { givenName, familyName }` supplies the PID names for the demo cert.
 */
export async function loadSignatureProviders(getIdentity) {
  let entries = [];
  try {
    // window.apiUrl (app.js) rebases the call in the native app; identity in the browser.
    const r = await fetch((window.apiUrl || ((p) => p))('signature-providers'), { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); entries = Array.isArray(j.providers) ? j.providers : []; }
  } catch { /* offline → no providers, signing UI stays hidden */ }
  return entries.map((e) =>
    e.kind === 'mock' ? mockProvider(e, getIdentity)
    : e.kind === 'csc' ? cscProvider(e)
    : walletNativeProvider(e));
}
