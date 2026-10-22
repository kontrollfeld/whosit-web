// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Under whose registration, through which verifier, asking for what — as one small report.
 *
 * WHY. Three things decide what a person sees in their wallet when this instance asks: the
 * verifier tenant (its ACCESS certificate names who asks), the REGISTRATION certificate (what
 * that party is registered to ask for, and why) and the attributes the instance actually
 * requests. All three live outside this process — at EUDIPLO, in the environment — and a mix-up
 * between them does not fail: the request works, under the wrong name or with an expired
 * certificate, until the first wallet refuses. The startup log said some of it once; this says
 * all of it, keeps saying it, and says it where an operator's tooling can read it.
 *
 * WHAT IS IN IT. Only what every wallet that scans this instance's QR code is shown anyway —
 * certificate subjects, validity, the registered purpose and attributes — plus the verifier's
 * host, version and the tenant id, which identify a configuration and grant nothing. No secret,
 * no token, no person: nobody is in this file.
 *
 * WHERE IT GOES. `EUDI_VERIFIER_STATUS_FILE`, one line of JSON, rewritten atomically after each
 * refresh (at startup, then every six hours). Not served over HTTP, for the same reason as the
 * usage file (./usage): the tenant and the verifier version are between the operator and whoever
 * runs the instance. A hosted instance's file is read by the host (whosit-control's host script).
 * Unset, the report is only logged.
 *
 * HOW. Read-only calls with the instance's own tenant token: `GET /api/version`,
 * `GET /api/key-chain?usageType=access` (the key chain EUDIPLO signs requests with — its
 * certificate's SHA-256 is the `x509_hash` client_id the wallet sees) and
 * `GET /api/verifier/config/:id` for the registration certificate EUDIPLO cached for the
 * instance's widest PID config (`registrationCertCache`, EUDIPLO 9). Read off EUDIPLO 9.1.0,
 * crypto/key/key-chain.controller.ts and verifier/presentations/entities/presentation-config.entity.ts.
 * Each lookup fails on its own: a tenant without the role for one still gets the others, and the
 * failure is named in `problems`.
 */
import { X509Certificate } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeJwtPayload, registrationCert } from './registration-cert';
import type { RelyingPartyDisclosure } from './relying-party';

export interface CertificateInfo {
  /** Organisation (O) of the subject, else its common name — who the wallet names. */
  name: string | null;
  subject: string | null;
  issuer: string | null;
  notAfter: string | null;
  /** SHA-256 of the DER, hex — the `x509_hash` client_id. First 16 characters. */
  fingerprint: string | null;
}

export interface RegistrationInfo {
  /** `imported`: from EUDI_REGISTRATION_CERT(_FILE) or the registrar via JWT; `registrar`: issued by EUDIPLO's registrar. */
  source: 'imported' | 'registrar';
  /** The registered party as the certificate names it. */
  name: string | null;
  /** The intermediary, when the registration names one. */
  intermediary: string | null;
  purpose: string | null;
  expiresAt: string | null;
  /** Claim names the certificate authorizes, deduplicated across formats. */
  claims: string[];
}

export interface VerifierStatus {
  v: 1;
  checkedAt: string;
  verifier: 'eudiplo' | 'none';
  host: string | null;
  version: string | null;
  tenant: string | null;
  defaultTenant: boolean;
  relyingParty: RelyingPartyDisclosure;
  accessCertificate: CertificateInfo | null;
  /** How many access key chains the tenant has — more than one and EUDIPLO picks one. */
  accessCertificates: number;
  registrationCertificate: RegistrationInfo | null;
  attributes: { policy: string; requested: string[]; permitted: string[]; narrowed: boolean };
  problems: string[];
}

export interface StatusSources {
  verifierOff: boolean;
  host: string | null;
  tenant: string | null;
  defaultTenant: boolean;
  relyingParty: RelyingPartyDisclosure;
  attributes: VerifierStatus['attributes'];
  /** The PID config whose registration certificate to report, or null when none is registered. */
  scopeConfigId: () => string | null;
  get: (path: string) => Promise<any>;
  now?: () => Date;
}

const short = (v: unknown, max = 200): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};
const isoOf = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
/** One field of a distinguished name in Node's "CN=…\nO=…" form. */
const dnField = (dn: string, key: string): string | null => {
  const m = dn.split('\n').map((l) => l.trim()).find((l) => l.startsWith(`${key}=`));
  return m ? short(m.slice(key.length + 1)) : null;
};
const oneLine = (dn: string | null): string | null => (dn ? short(dn.split('\n').join(', '), 300) : null);

/** The first certificate of a PEM, or of a key chain entry; null when it does not parse. */
export function certificateInfo(pem: unknown, fallback: Record<string, unknown> = {}): CertificateInfo | null {
  if (typeof pem === 'string' && pem.includes('BEGIN CERTIFICATE')) {
    try {
      const first = pem.slice(pem.indexOf('-----BEGIN CERTIFICATE-----'));
      const x = new X509Certificate(first.slice(0, first.indexOf('-----END CERTIFICATE-----') + 25));
      return {
        name: dnField(x.subject, 'O') ?? dnField(x.subject, 'CN'),
        subject: oneLine(x.subject),
        issuer: oneLine(x.issuer),
        notAfter: isoOf(x.validTo),
        fingerprint: x.fingerprint256.replace(/:/g, '').toLowerCase().slice(0, 16),
      };
    } catch { /* fall back to what EUDIPLO says about it */ }
  }
  const subject = short(fallback.subject);
  if (!subject && !fallback.notAfter) return null;
  return { name: subject, subject, issuer: short(fallback.issuer), notAfter: isoOf(fallback.notAfter), fingerprint: null };
}

/** The claim names a registration certificate authorizes — mdoc namespaces dropped. */
export function registeredClaims(payload: Record<string, any>): string[] {
  const out = new Set<string>();
  for (const c of Array.isArray(payload?.credentials) ? payload.credentials : []) {
    for (const cl of Array.isArray(c?.claims) ? c.claims : []) {
      const p = Array.isArray(cl?.path) ? cl.path.map(String) : [];
      if (!p.length) continue;
      const name = p.length === 2 && p[0].includes('.') ? p[1] : p.join('.');
      if (short(name, 80)) out.add(name.slice(0, 80));
    }
  }
  return [...out].slice(0, 40);
}

/** What a registration certificate says, from its payload. Field names per ETSI TS 119 475, read defensively. */
export function registrationInfo(payload: Record<string, any>, source: RegistrationInfo['source']): RegistrationInfo {
  const named = (o: any): string | null => (typeof o === 'string' ? short(o) : o && typeof o === 'object'
    ? short(o.sub_ln) ?? short(o.name) ?? short(o.legal_name) ?? short(o.sub) : null);
  const purposes = Array.isArray(payload?.purpose) ? payload.purpose : [];
  const purpose = purposes.find((x: any) => x?.lang === 'de') ?? purposes[0];
  return {
    source,
    name: named(payload) ?? null,
    intermediary: named(payload?.intermediary),
    purpose: short(purpose?.content ?? purpose?.value, 300),
    expiresAt: isoOf(payload?.exp),
    claims: registeredClaims(payload),
  };
}

/** Collect the report. Never throws: what cannot be read is named in `problems`. */
export async function collectVerifierStatus(s: StatusSources): Promise<VerifierStatus> {
  const now = s.now ? s.now() : new Date();
  const status: VerifierStatus = {
    v: 1,
    checkedAt: now.toISOString(),
    verifier: s.verifierOff ? 'none' : 'eudiplo',
    host: s.verifierOff ? null : s.host,
    version: null,
    tenant: s.verifierOff ? null : s.tenant,
    defaultTenant: !s.verifierOff && s.defaultTenant,
    relyingParty: s.relyingParty,
    accessCertificate: null,
    accessCertificates: 0,
    registrationCertificate: null,
    attributes: s.attributes,
    problems: [],
  };
  if (s.verifierOff) return status;
  if (!s.host) { status.problems.push('EUDIPLO_BASE_URL is not set'); return status; }
  const why = (what: string, e: any) => `${what}: ${e?.status ? `HTTP ${e.status}` : short(e?.message || String(e), 120)}`;

  try {
    const v = await s.get('/api/version');
    status.version = short(v?.version, 40);
  } catch (e) { status.problems.push(why('version', e)); }

  try {
    const chains = await s.get('/api/key-chain?usageType=access');
    const list = Array.isArray(chains) ? chains : [];
    status.accessCertificates = list.length;
    const first = list.find((c: any) => c?.activeCertificate) ?? list[0];
    status.accessCertificate = first ? certificateInfo(first.activeCertificate?.pem, first.activeCertificate ?? {}) : null;
    if (!list.length) status.problems.push('no access certificate: the tenant has no key chain of type "access"');
  } catch (e) { status.problems.push(why('access certificate', e)); }

  const imported = (() => { try { return registrationCert(); } catch { return null; } })();
  if (imported) {
    status.registrationCertificate = registrationInfo(imported.payload, 'imported');
  } else {
    const id = s.scopeConfigId();
    if (!id) status.problems.push('registration certificate: no PID config registered yet');
    else {
      try {
        const cfg = await s.get(`/api/verifier/config/${encodeURIComponent(id)}`);
        const cache = cfg?.registrationCertCache;
        if (cache?.jwt) {
          let payload: Record<string, any> = {};
          try { payload = decodeJwtPayload(String(cache.jwt)); } catch { /* the cache fields below still say something */ }
          const info = registrationInfo(payload, cache.source === 'imported' ? 'imported' : 'registrar');
          info.expiresAt = info.expiresAt ?? isoOf(cache.expiresAt);
          status.registrationCertificate = info;
        } else {
          // EUDIPLO 9 fills the cache after the config save, asynchronously — so right after a
          // startup "none" can simply mean "not yet"; the second round 90 s later settles it.
          status.problems.push('registration certificate: EUDIPLO holds none for this instance (not issued yet, no registrar configuration, or an EUDIPLO before 9)');
        }
      } catch (e) { status.problems.push(why('registration certificate', e)); }
    }
  }
  return status;
}

/** One line, as the file holds it. */
export function serializeStatus(st: VerifierStatus): string {
  return `${JSON.stringify(st)}\n`;
}

/** The startup/refresh log line, plus warnings about what runs out soon. */
export function statusLogLines(st: VerifierStatus, now = new Date()): string[] {
  if (st.verifier === 'none') return [];
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '?');
  const lines = [
    `Verifier status: EUDIPLO ${st.version ?? '?'} at ${st.host ?? '?'}, tenant ${st.tenant ?? '?'}`
    + ` · access certificate ${st.accessCertificate ? `${st.accessCertificate.name ?? '?'} until ${day(st.accessCertificate.notAfter)}` : 'unknown'}`
    + ` · registration certificate ${st.registrationCertificate ? `${st.registrationCertificate.source}, ${st.registrationCertificate.name ?? '?'}${st.registrationCertificate.intermediary ? ` via ${st.registrationCertificate.intermediary}` : ''}, until ${day(st.registrationCertificate.expiresAt)}` : 'unknown'}`,
  ];
  const left = (iso: string | null) => (iso ? (Date.parse(iso) - now.getTime()) / 86_400_000 : Infinity);
  const a = left(st.accessCertificate?.notAfter ?? null);
  if (a < 30) lines.push(`⚠️  The access certificate ${a < 0 ? 'EXPIRED' : `expires in ${Math.ceil(a)} day(s)`} (${day(st.accessCertificate!.notAfter)}) — wallets refuse requests signed with an expired one.`);
  const r = left(st.registrationCertificate?.expiresAt ?? null);
  if (r < 0 && st.registrationCertificate?.source === 'imported') lines.push(`⚠️  The registration certificate EXPIRED on ${day(st.registrationCertificate.expiresAt)} — import a new one from the registrar.`);
  if (st.accessCertificates > 1) lines.push(`ℹ️  The tenant has ${st.accessCertificates} access key chains; EUDIPLO signs with one of them — the report names the first.`);
  for (const p of st.problems) lines.push(`⚠️  Verifier status: ${p}`);
  return lines;
}

let current: VerifierStatus | null = null;
/** The last report, or null before the first refresh. */
export function verifierStatus(): VerifierStatus | null {
  return current;
}

/** Collect, keep, write (when a file is configured) and log. */
export async function refreshVerifierStatus(
  s: StatusSources,
  file = (process.env.EUDI_VERIFIER_STATUS_FILE || '').trim() || null,
): Promise<VerifierStatus> {
  const st = await collectVerifierStatus(s);
  current = st;
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, serializeStatus(st));
      renameSync(`${file}.tmp`, file);
    } catch (e: any) {
      console.warn(`[verifier-status] could not write ${file}: ${e?.message || e}`);
    }
  }
  for (const l of statusLogLines(st)) console.log(l);
  return st;
}
