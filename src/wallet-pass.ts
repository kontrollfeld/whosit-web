// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Apple Wallet appointment pass (Community `wallet-pass`, config-gated via EUDI_PASS_*) —
 * a scheduled verified call
 * as a .pkpass "appointment ticket": appears on the lock screen at call time
 * (relevantDate) and carries the room link as QR + back-field (Universal Link →
 * opens the app when installed).
 *
 * The pass is a RECEIPT/REMINDER, not a credential: it is signed with the
 * operator's Apple Pass Type ID certificate (env), NOT with a QES/QTSP identity,
 * and it is copyable (no holder binding). Data minimization: no personal names —
 * only title, time and the room URL the holder already knows.
 *
 * Config (all three required to enable the feature):
 *   EUDI_PASS_TYPE_ID   pass type identifier (e.g. pass.eu.whosit.termin)
 *   EUDI_PASS_TEAM_ID   Apple team id (e.g. W63PMKNPKY)
 *   EUDI_PASS_CERT      pass certificate AND private key (concatenated PEM) — as
 *                       file path, inline PEM, or base64-encoded PEM (env-UI-safe)
 * The Apple WWDR G4 intermediate ships in assets/pass/ (public certificate).
 *
 * No zip dependency: pkpass tolerates STORED (uncompressed) entries, so a minimal
 * ZIP writer (local headers + central directory + EOCD, CRC-32) is inlined below.
 */
import forge from 'node-forge';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ASSET_DIR = path.join(__dirname, '..', 'assets', 'pass');

// ---- config ----------------------------------------------------------------
const PASS_TYPE_ID = (process.env.EUDI_PASS_TYPE_ID || '').trim();
const PASS_TEAM_ID = (process.env.EUDI_PASS_TEAM_ID || '').trim();
const PASS_CERT_RAW = (process.env.EUDI_PASS_CERT || '').trim();

/** EUDI_PASS_CERT accepts a file path, inline PEM, or base64-encoded PEM (env-UI-safe). */
function resolveCertPem(): string | null {
  if (!PASS_CERT_RAW) return null;
  if (PASS_CERT_RAW.startsWith('-----BEGIN')) return PASS_CERT_RAW;
  if (existsSync(PASS_CERT_RAW)) return readFileSync(PASS_CERT_RAW, 'utf8');
  try {
    const decoded = Buffer.from(PASS_CERT_RAW, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded;
  } catch { /* not base64 */ }
  return null;
}

export function walletPassConfigured(): boolean {
  // Fail closed: also require the runtime assets (icons + WWDR) — a deployment that
  // forgot to ship assets/ must hide the feature instead of 500ing on every pass.
  return !!(PASS_TYPE_ID && PASS_TEAM_ID && resolveCertPem()
    && existsSync(path.join(ASSET_DIR, 'icon.png'))
    && existsSync(path.join(ASSET_DIR, 'AppleWWDRCAG4.pem')));
}

// ---- minimal ZIP (store only) ----------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(0, 6);          // flags
    local.writeUInt16LE(0, 8);          // method: stored
    local.writeUInt16LE(0, 10);         // mod time
    local.writeUInt16LE(0x21, 12);      // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);         // extra len
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);       // version made by
    central.writeUInt16LE(20, 6);       // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);       // method
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/attrs = 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---- PKCS#7 detached signature over manifest.json --------------------------
let cached: { cert: forge.pki.Certificate; key: forge.pki.PrivateKey; wwdr: forge.pki.Certificate } | null = null;
function loadSigner() {
  if (cached) return cached;
  const pem = resolveCertPem();
  if (!pem) throw new Error('EUDI_PASS_CERT not resolvable (path, PEM or base64)');
  const certMatch = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  const keyMatch = pem.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/);
  if (!certMatch || !keyMatch) throw new Error('EUDI_PASS_CERT must contain certificate AND private key (PEM)');
  const wwdrPem = readFileSync(path.join(ASSET_DIR, 'AppleWWDRCAG4.pem'), 'utf8');
  cached = {
    cert: forge.pki.certificateFromPem(certMatch[0]),
    key: forge.pki.privateKeyFromPem(keyMatch[0]),
    wwdr: forge.pki.certificateFromPem(wwdrPem),
  };
  return cached;
}
function signManifest(manifest: Buffer): Buffer {
  const { cert, key, wwdr } = loadSigner();
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifest.toString('binary'));
  p7.addCertificate(cert);
  p7.addCertificate(wwdr);
  p7.addSigner({
    key: key as forge.pki.rsa.PrivateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest }, // computed at sign time
      { type: forge.pki.oids.signingTime, value: new Date() as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

// ---- pass building ----------------------------------------------------------
export interface TerminPassOptions {
  roomUrl: string;   // absolute https room link (QR + back field)
  roomId: string;    // serial number
  title: string;
  start: Date;
  end: Date;
  locale?: string;   // 'de' | 'en' | 'fr' — label language (values stay as given)
}

const LABELS: Record<string, { date: string; time: string; link: string; open: string; note: string }> = {
  de: { date: 'Datum', time: 'Uhrzeit', link: 'Anruf-Link', open: 'Anruf jetzt öffnen', note: 'Dieser Pass ist eine Termin-Erinnerung. Der Link öffnet den verifizierten Anruf — die Ausweis-Prüfung findet erst im Anruf statt.' },
  en: { date: 'Date', time: 'Time', link: 'Call link', open: 'Open the call now', note: 'This pass is an appointment reminder. The link opens the verified call — identity verification happens in the call itself.' },
  fr: { date: 'Date', time: 'Heure', link: 'Lien d’appel', open: 'Ouvrir l’appel', note: 'Ce pass est un rappel de rendez-vous. Le lien ouvre l’appel vérifié — la vérification d’identité a lieu dans l’appel.' },
};

/** The host of the room link, shown under the QR code; the product name if the URL is unusable. */
function passHost(roomUrl: string): string {
  try { return new URL(roomUrl).host || 'EUDI Verified Call'; } catch { return 'EUDI Verified Call'; }
}

export function buildTerminPass(opts: TerminPassOptions): Buffer {
  const L = LABELS[opts.locale || 'de'] || LABELS.de;
  const fmtDate = new Intl.DateTimeFormat(opts.locale || 'de', { dateStyle: 'full', timeZone: 'Europe/Berlin' }).format(opts.start);
  const fmtTime = new Intl.DateTimeFormat(opts.locale || 'de', { timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(opts.start) +
    '–' + new Intl.DateTimeFormat(opts.locale || 'de', { timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(opts.end);

  const pass = {
    formatVersion: 1,
    passTypeIdentifier: PASS_TYPE_ID,
    teamIdentifier: PASS_TEAM_ID,
    organizationName: 'whosit',
    serialNumber: opts.roomId,
    description: opts.title,
    // brand: light slate surface, navy text, accent labels (public/style.css §1)
    backgroundColor: 'rgb(245, 248, 252)',
    foregroundColor: 'rgb(27, 36, 51)',
    labelColor: 'rgb(3, 105, 161)',
    relevantDate: opts.start.toISOString(),
    expirationDate: new Date(opts.end.getTime() + 24 * 3600 * 1000).toISOString(),
    barcodes: [{ format: 'PKBarcodeFormatQR', message: opts.roomUrl, messageEncoding: 'iso-8859-1', altText: passHost(opts.roomUrl) }],
    eventTicket: {
      primaryFields: [{ key: 'title', value: opts.title }],
      secondaryFields: [
        { key: 'date', label: L.date, value: fmtDate },
        { key: 'time', label: L.time, value: fmtTime },
      ],
      backFields: [
        // attributedValue renders as a TAPPABLE link in Wallet (universal link →
        // opens the app when installed, browser otherwise); value = copyable fallback.
        { key: 'link', label: L.link, attributedValue: `<a href="${opts.roomUrl}">${L.open}</a>`, value: opts.roomUrl },
        { key: 'note', label: 'EUDI Verified Call', value: L.note },
      ],
    },
  };

  const files: { name: string; data: Buffer }[] = [
    { name: 'pass.json', data: Buffer.from(JSON.stringify(pass), 'utf8') },
    { name: 'icon.png', data: readFileSync(path.join(ASSET_DIR, 'icon.png')) },
    { name: 'icon@2x.png', data: readFileSync(path.join(ASSET_DIR, 'icon@2x.png')) },
    { name: 'logo.png', data: readFileSync(path.join(ASSET_DIR, 'logo.png')) },
    { name: 'logo@2x.png', data: readFileSync(path.join(ASSET_DIR, 'logo@2x.png')) },
  ];
  // manifest = SHA-1 of every file (Apple pkpass format)
  const manifest: Record<string, string> = {};
  for (const f of files) {
    const md = forge.md.sha1.create();
    md.update(f.data.toString('binary'));
    manifest[f.name] = md.digest().toHex();
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
  const signature = signManifest(manifestBuf);
  return zipStore([...files, { name: 'manifest.json', data: manifestBuf }, { name: 'signature', data: signature }]);
}
