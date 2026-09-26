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
export async function loadPki() {
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

/** ECDSA signature: IEEE P1363 (r‖s, what WebCrypto returns) → DER Ecdsa-Sig-Value (what CMS
 *  carries, and what the secure elements return natively). */
export function p1363ToDer(sig) {
  const u = new Uint8Array(sig);
  const half = u.length / 2;
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.subarray(i);
    return b[0] & 0x80 ? Uint8Array.of(0x02, b.length + 1, 0, ...b) : Uint8Array.of(0x02, b.length, ...b);
  };
  const r = int(u.subarray(0, half)), s = int(u.subarray(half));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}

/**
 * Detached CAdES CMS over `data`, signed by an EXTERNAL signer — PAdES baseline B-B shape
 * (ETSI EN 319 142-1): signed attributes contentType, messageDigest and signingCertificateV2.
 *
 * `certsDer` is the chain, leaf first. `signFn(signedAttrsDer)` receives exactly the bytes that
 * get signed (the DER SET OF signed attributes) and must return a DER ECDSA-with-SHA-256
 * signature over them. That is the whole contract, so the key can live anywhere: in WebCrypto
 * for the demo, in the phone's secure element for the device provider — whose code then never
 * needs the private key, only a function that asks the hardware.
 *
 * NO signing-time attribute: PAdES forbids it; the signing time is the /M entry of the
 * signature dictionary (set by the placeholder, read back by identity.js).
 * signingCertificateV2 binds the signature to ITS certificate — without it a validator cannot
 * rule out a certificate substituted afterwards, and EU DSS does not accept the container as
 * baseline.
 */
export async function buildDetachedCmsWith(data, certsDer, signFn) {
  const { pkijs, asn1js } = await loadPki();
  const sha256 = (b) => self.crypto.subtle.digest('SHA-256', b);
  const toAb = (u) => { const v = new Uint8Array(u); return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength); };
  const certs = certsDer.map((d) => pkijs.Certificate.fromBER(toAb(d)));
  const leaf = certs[0];
  const digest = await sha256(data);
  const leafHash = await sha256(toAb(certsDer[0]));

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: leaf.issuer, serialNumber: leaf.serialNumber }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: '2.16.840.1.101.3.4.2.1' }),      // SHA-256
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: '1.2.840.10045.4.3.2' }),     // ecdsa-with-SHA256
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({
      type: 0,
      attributes: [
        new pkijs.Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' })] }),
        new pkijs.Attribute({ type: '1.2.840.113549.1.9.4', values: [new asn1js.OctetString({ valueHex: digest })] }),
        // id-aa-signingCertificateV2 (RFC 5035): SEQUENCE { SEQUENCE OF ESSCertIDv2 { certHash } }.
        // hashAlgorithm is omitted because SHA-256 is its DEFAULT; issuerSerial is optional.
        new pkijs.Attribute({ type: '1.2.840.113549.1.9.16.2.47', values: [
          new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [
            new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: leafHash })] }),
          ] })] }),
        ] }),
      ],
    }),
  });
  // What is signed is the DER encoding of the attributes as a SET OF (RFC 5652 §5.4) — the same
  // bytes as the [0] IMPLICIT field in the container, with the tag byte replaced.
  const signedAttrs = new Uint8Array(signerInfo.signedAttrs.toSchema().toBER(false));
  signedAttrs[0] = 0x31;
  const signature = await signFn(signedAttrs);
  signerInfo.signature = new asn1js.OctetString({ valueHex: toAb(signature) });

  const signedData = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: '2.16.840.1.101.3.4.2.1' })],
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.7.1' }),
    certificates: certs,
    signerInfos: [signerInfo],
  });
  const cms = new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: signedData.toSchema(true) });
  return cms.toSchema().toBER(false);
}

/** The demo shape of the above: a WebCrypto key signs. (Kept under its old name for the
 *  mock and scripts/test-qes.mjs; goes with the mock once the device provider has proven out.) */
export async function buildDetachedCms(data, cert, privateKey) {
  return buildDetachedCmsWith(data, [cert.toSchema(true).toBER(false)], async (bytes) =>
    p1363ToDer(await self.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes)));
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
 * A provider a Pro module contributes (kind 'device-local'). Its implementation is NOT part of
 * this client: the server names a module under /pro-client/ and we load it from there — so an
 * AGPL build without the Pro module never even receives the code. Everything the module needs
 * from here is handed over, rather than imported: in the app the module comes from the server
 * origin while this file comes from the local bundle, and a relative import would cross that
 * boundary.
 *
 * The module exports `createProvider(entry, deps)` and returns a provider, or null when this
 * device cannot sign (e.g. a browser: WebCrypto cannot reach the secure element).
 */
async function contributedProvider(entry, getIdentity, ctx) {
  const url = (window.apiUrl || ((p) => p))(entry.module);
  const mod = await import(new URL(url, location.href).href);
  const native = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DeviceSigner) || null;
  return mod.createProvider(entry, {
    loadPki, buildDetachedCmsWith, getIdentity, native,
    requestCertificate: ctx && ctx.requestDeviceCertificate,
    // For a provider that signs on ANOTHER device (paired phone): pairing over the signalling
    // connection, WebRTC to the phone, the QR library the page already has, the PAdES module.
    server: ctx && ctx.server,
    getIceServers: ctx && ctx.getIceServers,
    QRCode: window.QRCode,
    loadPades: () => import(new URL('./pades.js', import.meta.url).href),
    t: typeof t === 'function' ? t : (s) => s,
  });
}

/**
 * Fetch the operator's provider list (server-filtered by edition — Community only
 * ever receives 'mock') and wrap each entry in its implementation.
 * `getIdentity(): { givenName, familyName }` supplies the PID names for the demo cert;
 * `ctx.requestDeviceCertificate(csrB64)` lets a device provider ask the server for its
 * certificate over the signalling connection.
 */
export async function loadSignatureProviders(getIdentity, ctx) {
  let entries = [];
  try {
    // window.apiUrl (app.js) rebases the call in the native app; identity in the browser.
    const r = await fetch((window.apiUrl || ((p) => p))('signature-providers'), { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); entries = Array.isArray(j.providers) ? j.providers : []; }
  } catch { /* offline → no providers, signing UI stays hidden */ }
  const out = [];
  for (const e of entries) {
    if (e.kind === 'device-local') {
      // A provider that cannot load or does not fit this device is left out, not shown broken.
      try { const p = await contributedProvider(e, getIdentity, ctx); if (p) out.push(p); }
      catch (err) { console.warn('signature provider ' + e.id + ' unavailable:', err && err.message); }
      continue;
    }
    out.push(e.kind === 'mock' ? mockProvider(e, getIdentity)
      : e.kind === 'csc' ? cscProvider(e)
      : walletNativeProvider(e));
  }
  // The device provider first: when the hardware can sign, that is the signature to offer.
  return out.sort((a, b) => (b.kind === 'device-local') - (a.kind === 'device-local'));
}
