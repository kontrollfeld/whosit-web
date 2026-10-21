// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Registration certificate (WRPRC, ETSI TS 119 475) — the second certificate a Wallet Relying
 * Party needs next to the access certificate.
 *
 * The access certificate proves WHO asks (it signs the request object). The registration
 * certificate states WHAT this party is registered to ask for and WHY: a JWT (`typ`
 * `rc-wrp+jwt`) issued by the registrar, whose `credentials` claim lists the queries this
 * registration covers and whose `purpose` the wallet shows the user. It travels inside the
 * request object as `verifier_info: [{ format: "registration_cert", data: <jwt> }]`.
 *
 * Since the German sandbox wallet update of 2026-10 a request WITHOUT it is refused:
 * "WRPRC policy is configured but verifier_info is missing". Measured 2026-10-09.
 *
 * Who puts it on the wire: EUDIPLO, not us. We hand the JWT over in the verifier config
 * (`registration_cert: { jwt }`); EUDIPLO (8.0.2 and 9.1) forwards it unchanged — but ONLY when the
 * tenant has a registrar configuration (`registrarService.isEnabledForTenant`), otherwise it
 * drops the certificate WITHOUT A WORD and the wallet refuses again. See
 * `eudiplo.warnIfRegistrarMissing`.
 *
 * And it checks first: every DCQL credential must appear in the certificate's `credentials`
 * claim, compared as canonical JSON of `{ format, claims, meta }` — exact claims array, in
 * order, including `intent_to_retain`. Anything else is HTTP 400 when the wallet fetches the
 * request ("overasking prevented"), i.e. a sign-in that fails on the phone with no hint on
 * our side. `uncoveredCredentials` reproduces that comparison so the mismatch is reported
 * HERE, by name, at config time. Read off EUDIPLO 8.0.2,
 * apps/backend/src/registrar/registration-certificate.service.ts
 * (`validateRegistrationCertificate`, `dcqlCredentialFingerprint`, `canonicalJson`).
 * EUDIPLO 9 compares `{ format, claims: [{ path }], meta }` only — still exact and in order, but
 * it ignores `intent_to_retain`. This mirror keeps the stricter 8.0.2 rule: whatever passes here
 * passes there too, and a certificate that works today keeps working against either version.
 */
import { readFileSync } from 'node:fs';
import type { DcqlQuery } from './credential-profiles';

export interface RegistrationCert {
  jwt: string;
  payload: Record<string, any>;
  /** Where it came from — names a variable, never the value. */
  source: 'EUDI_REGISTRATION_CERT' | 'EUDI_REGISTRATION_CERT_FILE';
}

type Env = Record<string, string | undefined>;

/** Decode the payload of a compact JWS. Throws on anything that is not one. */
export function decodeJwtPayload(jwt: string): Record<string, any> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('not a compact JWT (expected three dot-separated parts)');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('JWT payload is not an object');
  return payload;
}

/**
 * Read the certificate from the environment. `null` when none is configured; throws when one
 * is configured but unusable — a broken certificate must not degrade to "no certificate".
 */
export function loadRegistrationCert(env: Env = process.env): RegistrationCert | null {
  const file = (env.EUDI_REGISTRATION_CERT_FILE || '').trim();
  const inline = (env.EUDI_REGISTRATION_CERT || '').trim();
  let jwt: string;
  let source: RegistrationCert['source'];
  if (file) {
    source = 'EUDI_REGISTRATION_CERT_FILE';
    try { jwt = readFileSync(file, 'utf8').trim(); } catch (e: any) { throw new Error(`${source}: cannot read file (${e?.code || e?.message})`); }
  } else if (inline) {
    source = 'EUDI_REGISTRATION_CERT';
    jwt = inline;
  } else {
    return null;
  }
  try {
    return { jwt, payload: decodeJwtPayload(jwt), source };
  } catch (e: any) {
    throw new Error(`${source}: ${e?.message || e}`);
  }
}

let cached: RegistrationCert | null | undefined;
/** The process-wide certificate, read once. */
export function registrationCert(): RegistrationCert | null {
  if (cached === undefined) cached = loadRegistrationCert();
  return cached;
}

/** Canonical JSON as EUDIPLO computes it: object keys sorted, array order kept. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** The part of a credential entry EUDIPLO compares. DCQL-only fields (`id`,
 *  `trusted_authorities`, …) are not part of a registration and drop out. */
export function registrableShape(cred: any): { format: unknown; claims: unknown; meta: unknown } {
  const claims = Array.isArray(cred?.claims) ? cred.claims : Array.isArray(cred?.claim) ? cred.claim : undefined;
  return { format: cred?.format, claims, meta: cred?.meta && typeof cred.meta === 'object' ? cred.meta : {} };
}

/** Ids of the DCQL credentials the certificate does NOT authorize. Empty = EUDIPLO accepts. */
export function uncoveredCredentials(dcql: DcqlQuery, payload: Record<string, any>): string[] {
  const requested = Array.isArray(dcql?.credentials) ? dcql.credentials : [];
  if (!requested.length) return [];
  const authorized = new Set(
    (Array.isArray(payload?.credentials) ? payload.credentials : []).map((c: any) => canonicalJson(registrableShape(c))),
  );
  return requested.filter((c) => !authorized.has(canonicalJson(registrableShape(c)))).map((c) => c.id);
}

/** Seconds left until `exp`; `undefined` when the certificate states none. */
export function secondsUntilExpiry(payload: Record<string, any>, now = Date.now()): number | undefined {
  return typeof payload?.exp === 'number' ? payload.exp - Math.floor(now / 1000) : undefined;
}
