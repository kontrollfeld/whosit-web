// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Credential profiles — the wallet/format-agnostic layer of the verifier.
 *
 * The app is a thin EUDIPLO client (see `eudiplo.ts`); EUDIPLO speaks OpenID4VP to the
 * wallet. What makes us wallet-agnostic is NOT reimplementing the protocol but VARYING
 * the request and NORMALIZING the response:
 *   - a `CredentialProfile` declares ONE credential kind in ONE format/ecosystem
 *     (format + type + per-format claim paths + trust framework),
 *   - `buildDcql()` turns a set of profiles + the host-requested SEMANTIC attributes
 *     into a single DCQL query (multiple profiles → `credential_sets` alternatives, so
 *     ONE offer/QR is satisfiable by whichever format the wallet holds), and
 *   - `normalizeClaims()` maps a heterogeneous webhook payload (mdoc-namespaced OR
 *     SD-JWT-nested) back into ONE canonical claim vocabulary the rest of the app uses.
 *
 * Edition gate (server-enforced, hard moat): Community may only use the PID mdoc profile;
 * Pro (`EUDI_EDITION=pro`) may use the others too. Which permitted profiles are actually
 * OFFERED is an explicit opt-in via `EUDI_CREDENTIAL_PROFILES` (default: `pid_mdoc` only) —
 * so a deploy never silently changes the live request before the operator has confirmed the
 * EUDIPLO instance supports the extra formats.
 *
 * NOTE (see plan assumption #4): the SD-JWT-VC PID claim names below are best-effort per
 * the ARF PID rulebook and MUST be verified against the target PID issuer / EUDIPLO
 * instance. They are centralized here so a correction is a one-line change.
 */
import { effectiveEdition } from './core/edition';
import {
  ALLOWED_PID_ATTRIBUTES,
  WALLET_REQUESTABLE,
  WRP_PURPOSE_TEXT,
  isAllowedPidAttribute,
  type AllowedPidAttribute,
} from './wrp-policy';

/** OpenID4VP credential formats we can request via EUDIPLO's DCQL. */
export type CredentialFormat = 'mso_mdoc' | 'dc+sd-jwt' | 'jwt_vc_json';

/**
 * How the verifier identifies itself to the wallet (trust-framework lever).
 *
 * CAUTION (measured against a live system on 2026-08-09): the value set here currently has
 * NO EFFECT — EUDIPLO signs the authorization request and picks the scheme itself. On a real
 * instance the result is `x509_hash` (client_id = SHA-256 of the certificate), not the
 * `x509_san_dns` configured below. VERIFIER_CLIENT_ID is equally without effect. Before
 * stating anything about this (documentation, audit, conversation), inspect the actual
 * request: read the x5c header and client_id from the signed JWT.
 */
export type ClientIdScheme = 'x509_san_dns' | 'did' | 'verifier_attestation' | 'redirect_uri';

/**
 * Semantic attributes = the app's format-independent UI vocabulary.
 *
 * This is DERIVED from the WRP vocabulary (see ./wrp-policy) rather than declared here:
 * there must be exactly one place that decides what this Relying Party may ask for.
 * Widening it is therefore impossible without editing the policy file.
 *
 * The type spans the ENTIRE known vocabulary (`KNOWN_PID_ATTRIBUTES`), not what a single
 * instance permits — otherwise `MDOC_KEYS`/`SDJWT_PATHS` could not be written as
 * `Record<SemanticAttr, …>`, and it is precisely that exhaustiveness check by the compiler
 * which rules out an unmappable attribute. What an instance may actually request lives in its
 * policy and is enforced at runtime (egress gate in `eudiplo.ts`); `birth_date`,
 * `issuing_country` and `address` are therefore back in the type, yet still not requestable
 * under the default policy.
 */
export type SemanticAttr = AllowedPidAttribute;

export const SEMANTIC_ATTRS: readonly SemanticAttr[] = ALLOWED_PID_ATTRIBUTES;
export function isSemanticAttr(x: unknown): x is SemanticAttr {
  return isAllowedPidAttribute(x);
}

/** Declarative descriptor of ONE credential kind in ONE format/ecosystem. */
export interface CredentialProfile {
  id: string;                 // stable, e.g. 'pid_mdoc' | 'pid_sdjwt'
  label: string;
  format: CredentialFormat;
  /** Type identifier in the format's own namespace:
   *  mso_mdoc → doctype; dc+sd-jwt → vct; jwt_vc_json → VC `type`. */
  credentialType: string;
  clientIdScheme: ClientIdScheme;
  clientId?: string;          // defaults to VERIFIER_CLIENT_ID
  edition: 'community' | 'pro';
  /** Semantic attribute → DCQL claim path(s) FOR THIS FORMAT ([] if unsupported). */
  claimPaths(attr: SemanticAttr): (string | number)[][];
  supports(attr: SemanticAttr): boolean;
}

/** DCQL (Digital Credentials Query Language) — EUDIPLO expects this as `dcql_query`. */
export interface DcqlCredentialQuery {
  id: string;
  format: CredentialFormat;
  meta: Record<string, unknown>;   // { doctype_value } | { vct_values } | { type_values }
  claims: Array<{ path: (string | number)[]; intent_to_retain?: boolean }>;
  /**
   * WHICH ISSUERS we trust for this credential — the mirror image of the access certificate:
   * there the verifier identifies itself to the wallet, here we decide whose signature under
   * a presented PID we accept.
   *
   * `etsi_tl` points at an ETSI TS 119 602 trust list (LoTE). The verifier fetches it, looks
   * up the issuer of the presented credential, and additionally checks its revocation status
   * using the stored revocation certificate.
   *
   * WITHOUT this entry the verifier has no trust anchor and rejects EVERY presentation
   * ("Configured trust lists: none configured", measured live on 2026-08-09 against EUDIPLO
   * 6.2.0). Version 5.0.0 did not check revocation status and therefore ran without one — the
   * migration made the gap visible, it did not create it.
   */
  trusted_authorities?: Array<{ type: 'etsi_tl' | 'aki' | 'openid_federation'; values: string[] }>;
}
export interface DcqlQuery {
  credentials: DcqlCredentialQuery[];
  /** "any ONE of these options satisfies the request" → multi-format alternatives. */
  credential_sets?: Array<{ options: string[][]; purpose?: string }>;
}

/** A normalized presentation result (canonical keys, format-independent). */
export interface PresentedCredential {
  profileId?: string;
  format?: CredentialFormat;
  claims: Record<string, any>;     // canonical claim vocabulary (see CANONICAL_KEYS)
}

// ---- config ----------------------------------------------------------------
// Effective edition (honors the launch promo EUDI_PROMO_ALL_PRO) — same source of truth
// as the feature gates in server.ts. See ./core/edition.
const PRO = effectiveEdition() === 'pro';
// Which profiles are OFFERED — an explicit opt-in allow-list (comma-separated ids).
// Default = 'pid_mdoc' ONLY, so deploying this never silently changes the live request:
// multi-format (mdoc + SD-JWT) is enabled by the operator only AFTER confirming the target
// EUDIPLO instance supports `dc+sd-jwt` and DCQL `credential_sets` (see file header note).
// Examples: 'pid_mdoc,pid_sdjwt' (multi-format) · 'pid_sdjwt' (pin to SD-JWT only).
const CONFIGURED = (process.env.EUDI_CREDENTIAL_PROFILES || 'pid_mdoc')
  .split(',').map((s) => s.trim()).filter(Boolean);
// No preset: this used to hold the address of an instance we operate, which in a published
// edition would mean shipping someone else's identity as the default. Without effect anyway —
// EUDIPLO derives the client_id from the certificate. Left empty, `createVerifierOffer` omits
// the field (see ./eudiplo).
const DEFAULT_CLIENT_ID = process.env.VERIFIER_CLIENT_ID || '';
const PID_DOCTYPE = process.env.PID_MDOC_DOCTYPE || 'eu.europa.ec.eudi.pid.1';
// Confirmed live 2026-07-10 against the German sandbox (SPRIND wallet ↔ our EUDIPLO):
// the SD-JWT PID is issued with vct `urn:eudi:pid:de:1` by preprod.pid-provider.bundesdruckerei.de.
const PID_VCT = process.env.PID_SDJWT_VCT || 'urn:eudi:pid:de:1';
/**
 * Trust lists (LoTE URLs, comma-separated) against which the verifier checks the issuer of a
 * presented PID — see `trusted_authorities` on DcqlCredentialQuery.
 *
 * Deliberately WITHOUT a preset: which issuer an instance trusts is the operator's decision
 * and must not come from the source code. Left empty, the query goes out unchanged — but the
 * verifier will then reject every presentation, if like EUDIPLO from 6.2.0 it demands a trust
 * anchor.
 *
 * EUDIPLO substitutes `<TENANT_URL>` in these URLs with its own tenant host, so a
 * self-published list can be referenced without an absolute URL.
 */
const TRUST_LIST_URLS = (process.env.EUDI_TRUST_LIST_URLS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Canonical claim vocabulary = the (flat) mdoc PID claim keys the app stores and renders.
 * `normalizeClaims` maps every format INTO this vocabulary, so the review/reveal UI and
 * the audit log stay unchanged regardless of which wallet/format responded.
 *
 * It is scoped to the WRP whitelist, and that is load-bearing in BOTH directions:
 * requests can't ask for more (buildDcql), and responses can't deliver more —
 * `normalizeClaims` keeps only these keys, so an over-disclosing wallet or a stale
 * EUDIPLO verifier config can never get an address or a birth date into a room, a
 * status broadcast or a log line. Minimisation is enforced at the ingress, not trusted.
 */
// What is kept from a response. DERIVED from the active policy rather than enumerated: a
// fixed list would silently discard the value under a policy that permits, say, `address` —
// requested, presented, thrown away, and nobody would see why.
const CANONICAL_KEYS: readonly SemanticAttr[] = WALLET_REQUESTABLE;

// Semantic attribute → canonical mdoc claim keys. Derived attributes (pseudonym_id) have
// no wallet claim and map to nothing — see WALLET_REQUESTABLE in ./wrp-policy.
const MDOC_KEYS: Record<SemanticAttr, string[]> = {
  family_name: ['family_name'],
  given_name: ['given_name'],
  age_over_18: ['age_over_18'],
  pseudonym_id: [],
  // Only for policies that explicitly permit them (see WRP_POLICIES). Being listed does NOT
  // make an attribute requestable — it only makes it mappable.
  birth_date: ['birth_date'],
  issuing_country: ['issuing_country'],
  // mdoc carries the address flat in separate fields, SD-JWT as a nested object.
  address: ['resident_street', 'resident_postal_code', 'resident_city', 'resident_country'],
};

// Semantic attribute → SD-JWT-VC PID claim path(s) (best-effort; see file header note).
const SDJWT_PATHS: Record<SemanticAttr, (string | number)[][]> = {
  family_name: [['family_name']],
  given_name: [['given_name']],
  age_over_18: [['age_equal_or_over', '18']], // some issuers use a flat 'age_over_18'
  pseudonym_id: [],
  birth_date: [['birthdate']], // SD-JWT VC schreibt `birthdate`, mdoc `birth_date`
  issuing_country: [['issuing_country']],
  address: [['address']],      // ganzes Objekt: street_address, locality, postal_code, country
};

/**
 * The INVERSE of MDOC_KEYS/SDJWT_PATHS: how a canonical value is recovered from a RESPONSE
 * when the two formats name it differently or nest it differently.
 *
 * Why this has to be its own table rather than a special case in the body: without it such an
 * attribute silently falls through — requested, presented by the wallet, and discarded while
 * reading. Measured exactly that way on 2026-08-12: `birth_date` only made it through from
 * mdoc, `address` only from SD-JWT. Whoever adds an attribute here adds it to the request
 * mappings above as well — that is why both directions sit side by side.
 *
 * Only the canonical value is read; an age assertion is never turned into a date of birth or
 * the other way round.
 */
interface Reconstruction {
  /** Raw names the value may arrive under — also feeds the search list of the fallback path
   *  in `rawClaims`, so the two routes cannot drift apart. */
  from: string[];
  build: (raw: Record<string, any>) => any;
}

const RECONSTRUCT: Partial<Record<SemanticAttr, Reconstruction>> = {
  // SD-JWT delivers the age assertion nested as age_equal_or_over['18'].
  age_over_18: {
    from: ['age_equal_or_over'],
    build: (r) =>
      r.age_equal_or_over && typeof r.age_equal_or_over === 'object' ? r.age_equal_or_over['18'] : undefined,
  },
  // mdoc: birth_date · SD-JWT VC: birthdate
  birth_date: { from: ['birthdate'], build: (r) => r.birthdate },
  // mdoc carries the address flat; brought here into the SAME object shape SD-JWT delivers,
  // otherwise the rendering would depend on the far side's format.
  address: {
    from: ['resident_street', 'resident_city', 'resident_postal_code', 'resident_country'],
    build: (r) => {
      const parts: Record<string, unknown> = {
        street_address: r.resident_street,
        locality: r.resident_city,
        postal_code: r.resident_postal_code,
        country: r.resident_country,
      };
      for (const k of Object.keys(parts)) if (parts[k] == null) delete parts[k];
      return Object.keys(parts).length ? parts : undefined;
    },
  },
};

/** Canonical names PLUS every raw name a value can arrive under. */
const PROBE_KEYS: readonly string[] = [
  ...CANONICAL_KEYS,
  ...Object.values(RECONSTRUCT).flatMap((r) => r?.from ?? []),
];

// ---- profiles --------------------------------------------------------------
const pidMdoc: CredentialProfile = {
  id: 'pid_mdoc',
  label: 'PID (ISO mdoc)',
  format: 'mso_mdoc',
  credentialType: PID_DOCTYPE,
  clientIdScheme: 'x509_san_dns',
  clientId: DEFAULT_CLIENT_ID,
  edition: 'community',
  // mdoc paths are [namespace/doctype, claimKey] — matches the live verifier config.
  claimPaths: (attr) => (MDOC_KEYS[attr] ?? []).map((k) => [PID_DOCTYPE, k]),
  // A derived attribute (pseudonym_id → no claim keys) is NOT supported by any wallet
  // profile, so it never enters a DCQL query.
  supports: (attr) => (MDOC_KEYS[attr] ?? []).length > 0,
};

const pidSdJwt: CredentialProfile = {
  id: 'pid_sdjwt',
  label: 'PID (SD-JWT VC)',
  format: 'dc+sd-jwt',
  credentialType: PID_VCT,
  clientIdScheme: 'x509_san_dns',
  clientId: DEFAULT_CLIENT_ID,
  // Community since 2026-08-09 (previously 'pro'). The reason is NOT generosity but a
  // consequence that would otherwise contradict the edition rule: channel binding (DTLS
  // fingerprint in `transaction_data` → KB-JWT) is implemented in the EUDIPLO verifier for
  // SD-JWT VC only; the mdoc branch knows no transaction data. Were SD-JWT to stay
  // Pro-exclusive, the STRONGEST security property would be permanently behind a paywall —
  // and of all people the self-hoster with confidentiality requirements (a municipality, a
  // counselling service) would get the weaker identity binding. That violates "the guarantee
  // in Community, retention and analysis in Pro" (see src/core/features.ts).
  edition: 'community',
  claimPaths: (attr) => SDJWT_PATHS[attr] ?? [],
  supports: (attr) => (SDJWT_PATHS[attr] ?? []).length > 0,
};

const ALL_PROFILES: CredentialProfile[] = [pidMdoc, pidSdJwt];

/** Profiles the running edition PERMITS at all (Community: community-only; Pro: all). */
export function activeProfiles(): CredentialProfile[] {
  return ALL_PROFILES.filter((p) => p.edition === 'community' || PRO);
}
/**
 * Profiles actually OFFERED = configured allow-list ∩ edition-permitted, preserving the
 * configured order. Falls back to the mdoc PID profile if nothing valid is configured
 * (e.g. a Community deployment that lists only Pro profiles) — never an empty request.
 */
export function selectedProfiles(): CredentialProfile[] {
  const permitted = activeProfiles();
  const chosen = CONFIGURED
    .map((id) => permitted.find((p) => p.id === id))
    .filter((p): p is CredentialProfile => !!p);
  return chosen.length ? chosen : permitted.filter((p) => p.id === 'pid_mdoc');
}
export function profileById(id: string): CredentialProfile | undefined {
  return ALL_PROFILES.find((p) => p.id === id);
}

function metaFor(p: CredentialProfile): Record<string, unknown> {
  switch (p.format) {
    case 'mso_mdoc': return { doctype_value: p.credentialType };
    case 'dc+sd-jwt': return { vct_values: [p.credentialType] };
    case 'jwt_vc_json': return { type_values: [[p.credentialType]] };
  }
}

/**
 * Build ONE DCQL query for `attrs` across `profiles`. Attributes a profile can't express
 * are skipped. With >1 profile, a `credential_sets` of alternatives is added so the wallet
 * may satisfy the request with ANY single listed format (multi-wallet auto-negotiation).
 * With exactly one profile the output matches the legacy single-format request byte-for-byte.
 */
export function buildDcql(profiles: CredentialProfile[], attrs: SemanticAttr[]): DcqlQuery {
  // Only wallet-requestable attributes reach the query. `pseudonym_id` is derived by this
  // server (see ../pseudonym) and asking a wallet for it would build a request no real
  // wallet can satisfy — the whitelist and the wire format are not the same set.
  const asked = attrs.filter((a) => (WALLET_REQUESTABLE as readonly SemanticAttr[]).includes(a));
  const credentials: DcqlCredentialQuery[] = profiles.map((p) => ({
    id: p.id,
    format: p.format,
    meta: metaFor(p),
    claims: asked
      .filter((a) => p.supports(a))
      // intent_to_retain: false on every claim — the zero-retention promise stated to
      // the wallet, matching the fact that nothing is persisted (see ../audit).
      .flatMap((a) => p.claimPaths(a))
      .map((path) => ({ path, intent_to_retain: false })),
    // Trust anchor for the issuer. Only set when configured — an empty `trusted_authorities`
    // is not the same as an absent one and could, depending on the verifier, be read as
    // "trust nobody".
    ...(TRUST_LIST_URLS.length
      ? { trusted_authorities: [{ type: 'etsi_tl' as const, values: TRUST_LIST_URLS }] }
      : {}),
  }));
  const query: DcqlQuery = { credentials };
  if (profiles.length > 1) {
    // The wallet shows this purpose to the user; keep it identical to the purpose the
    // room UI displays, so consent screen and app screen cannot diverge.
    query.credential_sets = [{ options: profiles.map((p) => [p.id]), purpose: WRP_PURPOSE_TEXT }];
  }
  return query;
}

/**
 * Every claim path this WRP is ever permitted to emit, across all profiles — the
 * allow-list `eudiplo.ensureVerifierConfig` checks an outgoing PID query against.
 * Built from the same profile definitions as `buildDcql`, so the two cannot drift.
 */
export function permittedPidClaimPaths(): Set<string> {
  const out = new Set<string>();
  for (const p of ALL_PROFILES) {
    for (const a of WALLET_REQUESTABLE as readonly SemanticAttr[]) {
      for (const path of p.claimPaths(a)) out.add(JSON.stringify(path));
    }
  }
  return out;
}

// ---- response normalization ------------------------------------------------
/** Recursively search a nested payload for the first value under `key`. */
function deepFind(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const k of Object.keys(obj)) {
    const found = deepFind(obj[k], key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Merge the raw presented claim objects out of an EUDIPLO webhook payload. */
function rawClaims(payload: any): Record<string, any> {
  const out: Record<string, any> = {};
  const creds = payload?.credentials;
  if (Array.isArray(creds)) {
    for (const c of creds) {
      const vals = c?.values;
      if (Array.isArray(vals)) for (const v of vals) if (v && typeof v === 'object') Object.assign(out, v);
    }
  }
  // Fallback for other payload shapes: pull known claim names from anywhere in the tree.
  // Scoped to what THIS deployment's policy permits (PROBE_KEYS = canonical names plus the
  // formats' raw names) — an attribute the policy does not allow is never even searched for,
  // so a payload carrying it is not read either.
  if (Object.keys(out).length === 0) {
    for (const key of PROBE_KEYS) { const v = deepFind(payload, key); if (v != null) out[key] = v; }
  }
  return out;
}

/**
 * Which profile — and therefore which FORMAT — did the wallet actually present?
 *
 * Needed for the audit record: it used to note WHICH attribute types were presented, but not
 * over which trust path. In a later incident one could otherwise not reconstruct whether a
 * session ran over mdoc or SD-JWT VC — and the two differ considerably in the maturity of the
 * verifier implementation.
 *
 * Two routes, in this order:
 *   1. The DCQL response references the credential id from the request (`credentials[].id`),
 *      and our ids ARE the profile ids (see buildDcql) — that is the exact route.
 *   2. If only ONE profile was offered, the format is unambiguous even without a back
 *      reference. That is the common case today (default `pid_mdoc`).
 *
 * Returns `undefined` when neither applies — the record then honestly says nothing, rather
 * than carrying a guess.
 */
export function detectPresentedProfile(
  payload: any,
  offered: readonly CredentialProfile[],
): CredentialProfile | undefined {
  const creds = payload?.credentials;
  if (Array.isArray(creds)) {
    for (const c of creds) {
      const id = typeof c?.id === 'string' ? c.id : undefined;
      const hit = id ? offered.find((p) => p.id === id) : undefined;
      if (hit) return hit;
    }
  }
  return offered.length === 1 ? offered[0] : undefined;
}

/**
 * Normalize a heterogeneous webhook payload into the canonical claim vocabulary,
 * mapping SD-JWT-VC names/nesting onto the flat mdoc keys the app uses.
 * Returns {} for an empty/erroring payload (callers treat empty as "no proof").
 *
 * This is also the minimisation chokepoint on the RESPONSE side: the output is built by
 * copying an explicit key list out of the payload, never by spreading it. Any claim
 * outside the WRP whitelist that a wallet or a stale verifier config happens to include
 * is dropped here and therefore never stored, broadcast or logged.
 */
export function normalizeClaims(payload: any): Record<string, any> {
  const raw = rawClaims(payload);
  const out: Record<string, any> = {};

  // Allow-list copy, not a spread: the canonical name matches directly when both formats
  // share it. Otherwise RECONSTRUCT applies.
  for (const k of CANONICAL_KEYS) {
    const v = raw[k] != null ? raw[k] : RECONSTRUCT[k]?.build(raw);
    if (v != null) out[k] = v;
  }
  return out;
}
