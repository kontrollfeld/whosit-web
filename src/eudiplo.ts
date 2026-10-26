// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin transport client for the EUDIPLO verifier instance.
 *
 * EUDIPLO does the OpenID4VP heavy lifting (mdoc/SD-JWT, X.509, signed/encrypted
 * requests). This module is protocol-agnostic: it authenticates (tenant secret rotates →
 * recover via the root account), registers a verifier config from a ready-made DCQL query,
 * and creates the presentation offer. WHAT to ask for (format/type/claim paths/trust
 * framework) and HOW to read the response is decided by `credential-profiles.ts`
 * (`buildDcql`/`normalizeClaims`) — so different OpenID4VP wallets are supported by varying
 * the query, not by changing this transport.
 */
import type { DcqlQuery } from './credential-profiles';
import { normalizeClaims, permittedPidClaimPaths } from './credential-profiles';
import { PolicyViolationError, WRP_PURPOSE_ID, WRP_PURPOSE_TEXT } from './wrp-policy';
import { registrationCert, uncoveredCredentials } from './registration-cert';

/**
 * WRP compliance: every PID presentation request leaves the process through
 * `ensureVerifierConfig(id, dcql, 'pid')`, which validates the query's claim paths
 * against `wrp-policy.ALLOWED_PID_ATTRIBUTES` and throws `PolicyViolationError`
 * otherwise. That makes the whitelist a property of the EGRESS, not of any one caller:
 * a future code path that hand-builds a DCQL query, or a bug in `buildDcql`, still cannot
 * get an unlisted attribute in front of a wallet.
 *
 * This gate is HARD in both enforcement modes — `EUDI_WRP_STRICT` only decides whether an
 * out-of-scope *request* is refused or narrowed upstream (see wrp-policy.wrpStrict). By
 * the time a query reaches here it must already be in scope, in every mode.
 *
 * The policy itself lives in `./wrp-policy` (no dependencies, auditable in one screen) and
 * is re-exported below so callers have a single import point.
 */
export {
  ALLOWED_PID_ATTRIBUTES,
  RETIRED_ATTRIBUTES,
  WALLET_REQUESTABLE,
  DERIVED_ATTRIBUTES,
  WRP_PURPOSE_ID,
  WRP_PURPOSE_TEXT,
  WRP_COMPLIANCE_NOTE,
  PolicyViolationError,
  assertAllowedAttributes,
  partitionAttributes,
  resolveAttributes,
  isAllowedPidAttribute,
  isWalletRequestable,
  requiresWalletPresentation,
  wrpStrict,
  policyDescriptor,
  type AllowedPidAttribute,
} from './wrp-policy';

/**
 * NO DEFAULTS for the instance address or credentials.
 *
 * Every deployment brings its OWN verifier (its own EUDIPLO instance, its own access
 * certificate on its own domain). A default would let an incompletely configured server run
 * quietly against someone else's host instead of surfacing the configuration error.
 *
 * If something is missing, startup aborts (`assertProductionConfig` in ./core/startup-checks),
 * or the first token request fails with a message naming the missing variable — never its
 * value.
 */
const BASE = (process.env.EUDIPLO_BASE_URL || '').replace(/\/+$/, '');
const ROOT_ID = process.env.EUDIPLO_ROOT_ID || '';
const ROOT_SECRET = process.env.EUDIPLO_ROOT_SECRET || '';
/** This instance's tenant at the verifier. The request appears in the wallet under ITS
 *  certificate — the tenant, not VERIFIER_CLIENT_ID, determines the visible identity. */
const DEFAULT_TENANT_ID = 'kontrollfeld-admin';
const TENANT_ID = process.env.EUDIPLO_CLIENT_ID || DEFAULT_TENANT_ID;

/** Which verifier tenant is in effect — for the startup log and operational checks. */
export function verifierTenantId(): string {
  return TENANT_ID;
}
/**
 * Is this instance running on the DEFAULT tenant?
 *
 * The question is about the effective value, not about whether a variable is set: anyone
 * copying an existing environment into a new deployment HAS set it — to the copied
 * environment's tenant. That is exactly the mix-up this is meant to surface.
 */
export function isDefaultVerifierTenant(): boolean {
  return TENANT_ID === DEFAULT_TENANT_ID;
}
/**
 * Fixed credentials of the tenant client. When set, the app authenticates EXCLUSIVELY with
 * them — no root login, no secret rotation. This is the normal case on your own EUDIPLO
 * instance and the safer path: the app then holds only its tenant's rights
 * (`presentation:*`, `registrar:manage`), not `tenants:manage`.
 *
 * Without this variable the legacy path `rotateAndGetToken()` applies — needed for a SHARED
 * instance whose tenant secret one does not know and had to obtain via root. It remains for
 * self-hosters in that situation.
 */
const CLIENT_SECRET = process.env.EUDIPLO_CLIENT_SECRET || '';
export interface Offer {
  uri: string; // same-device (tap to open the wallet on this phone)
  crossDeviceUri: string; // cross-device (render as QR, scan with a separate phone)
  /**
   * EUDIPLO's own session id for this offer — the handle needed to DELETE the session once
   * the call is done with it (see ./verifier-session). NOT `participant.sessionId`: that one
   * belongs to this service, appears in the webhook URL, and means nothing to the verifier.
   *
   * Optional because an older instance (or the dummy) may not report it. Without it the
   * session cannot be purged early and falls back to the instance's TTL — which is why the
   * startup checks name it.
   */
  sessionId?: string;
}

let cachedToken: string | null = null;
let tokenExpiry = 0;
let cachedTenantSecret: string | null = null;

async function postJson(path: string, body: unknown, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    const err: any = new Error(`EUDIPLO ${path} -> ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** Root login → rotate the tenant secret → tenant token. The tenant secret is
 *  not static (it gets rotated), so it is recovered through the root account. */
let rootPathWarned = false;
async function rotateAndGetToken(): Promise<string> {
  // Legacy path for a SHARED instance whose tenant secret one does not know. For the normal
  // case — your own instance — EUDIPLO_CLIENT_SECRET is the way. Without root credentials this
  // path is unusable; the message names variables, not values.
  if (!ROOT_ID || !ROOT_SECRET) {
    throw new Error(
      'EUDIPLO: no verifier access configured. Set EUDIPLO_CLIENT_SECRET (recommended: the ' +
      'fixed tenant client of your own instance) or EUDIPLO_ROOT_ID + EUDIPLO_ROOT_SECRET ' +
      '(the legacy path for a shared instance).',
    );
  }
  if (!rootPathWarned) {
    rootPathWarned = true;
    console.warn(
      '⚠️  DEPRECATED: EUDIPLO_ROOT_ID + EUDIPLO_ROOT_SECRET are in use. This legacy path logs in ' +
      'as root (tenants:manage) on the verifier and rotates the tenant secret on every token ' +
      'request, so this application holds root rights there. Use EUDIPLO_CLIENT_ID + ' +
      'EUDIPLO_CLIENT_SECRET (a fixed tenant client) instead.',
    );
  }
  const root = await postJson('/api/oauth2/token', { client_id: ROOT_ID, client_secret: ROOT_SECRET });
  const rot = await postJson(`/api/client/${TENANT_ID}/rotate-secret`, {}, root.access_token);
  const secret = rot.secret || rot.clientSecret;
  if (!secret) throw new Error('rotate-secret returned no secret');
  cachedTenantSecret = secret;
  const tenant = await postJson('/api/oauth2/token', { client_id: TENANT_ID, client_secret: secret });
  return tenant.access_token;
}

async function getToken(forceRotate = false): Promise<string> {
  if (!forceRotate && cachedToken && Date.now() < tokenExpiry) return cachedToken;

  // Own instance: fixed tenant client, no root involved. `forceRotate` here only means "the
  // token expired, fetch a new one" — nothing is rotated, since rotating a statically
  // configured secret would invalidate one's own configuration.
  if (CLIENT_SECRET) {
    const t = await postJson('/api/oauth2/token', { client_id: TENANT_ID, client_secret: CLIENT_SECRET });
    cachedToken = t.access_token;
    tokenExpiry = Date.now() + 20 * 60 * 1000;
    return cachedToken!;
  }

  // Reuse the last known tenant secret first; only rotate when it no longer works.
  // This keeps secret rotations rare, so other clients of a shared tenant are not
  // repeatedly locked out.
  if (!forceRotate && cachedTenantSecret) {
    try {
      const t = await postJson('/api/oauth2/token', { client_id: TENANT_ID, client_secret: cachedTenantSecret });
      cachedToken = t.access_token;
      tokenExpiry = Date.now() + 20 * 60 * 1000;
      return cachedToken!;
    } catch {
      /* secret was rotated elsewhere → fall through and recover */
    }
  }

  cachedToken = await rotateAndGetToken();
  tokenExpiry = Date.now() + 20 * 60 * 1000;
  return cachedToken!;
}

function extractOffer(data: any): Offer {
  if (typeof data === 'string') return { uri: data, crossDeviceUri: data };
  const uri: string =
    data.uri || data.bootstrapAuthorizationRequestUrl || data.authorizationRequestUri || data.url || '';
  const crossDeviceUri: string = data.crossDeviceUri || uri;
  // `session` is what EUDIPLO 8 calls it (OfferResponse in offer-request.dto.ts) and what
  // the webhook payload repeats. `sessionId` is accepted as well so a renaming upstream does
  // not silently switch the purge off — losing the id costs zero-retention, not the call,
  // and a failure that quiet would never be noticed.
  const sessionId: unknown = data.session ?? data.sessionId;
  return { uri, crossDeviceUri, ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}) };
}

const registeredConfigs = new Set<string>();

/** EUDIPLO 9.1 `statusCheckMode` of a verifier config: what to do when the issuer's status list
 *  cannot be fetched. EUDIPLO defaults to `strict` (reject). */
export const STATUS_CHECK_MODES = ['strict', 'best_effort', 'disabled'] as const;
export type StatusCheckMode = typeof STATUS_CHECK_MODES[number];

/**
 * `EUDI_STATUS_CHECK_MODE`, or `undefined` when unset or invalid (startup-checks refuses an
 * invalid value). Sent with every config, because the app writes each config itself: a mode
 * set by hand in the EUDIPLO UI would be lost on the next registration, and a config for a new
 * attribute set would start out `strict` again.
 */
export function statusCheckMode(env: NodeJS.ProcessEnv = process.env): StatusCheckMode | undefined {
  const v = (env.EUDI_STATUS_CHECK_MODE || '').trim();
  return (STATUS_CHECK_MODES as readonly string[]).includes(v) ? (v as StatusCheckMode) : undefined;
}

/**
 * What a verifier config is for. `pid` = the pre-connect identity gate, subject to the
 * WRP attribute whitelist. `catalog` = an in-call credential request (see
 * src/credential-requests.ts): a different credential type with its own
 * claim vocabulary and its own consent step, so the PID whitelist does not apply — but it
 * must be named explicitly, so no caller reaches the unchecked path by forgetting an
 * argument.
 */
export type VerifierConfigKind = 'pid' | 'catalog';

/**
 * Reject a PID query that asks for anything outside the whitelist.
 *
 * Checks the claim PATHS on the wire, not the semantic attribute names a caller passed
 * in — the paths are what the wallet actually receives, so this catches a hand-built
 * query, a drifted profile definition and a tampered claim path alike.
 * Also enforces `intent_to_retain: false` on every claim: a retention flag on the wire
 * would contradict the zero-retention architecture even if the data were then discarded.
 */
function assertPidQueryWithinPolicy(dcql: DcqlQuery): void {
  const permitted = permittedPidClaimPaths();
  const rejected: string[] = [];
  for (const cred of dcql.credentials ?? []) {
    for (const claim of cred.claims ?? []) {
      const key = JSON.stringify(claim.path);
      if (!permitted.has(key)) rejected.push(`${cred.format}:${(claim.path ?? []).join('.')}`);
      else if (claim.intent_to_retain) rejected.push(`${cred.format}:${(claim.path ?? []).join('.')}#intent_to_retain`);
    }
  }
  if (rejected.length) throw new PolicyViolationError([...new Set(rejected)]);
}

/** What goes into `registration_cert` of a verifier config (EUDIPLO 9.1 schema, unchanged since 8.0.2). */
type RegistrationCertSpec =
  | { jwt: string }
  | { body: { purpose: { lang: string; content: string }[]; privacy_policy?: string; support_uri?: string } };

/**
 * The registration certificate spec for config `id`, or undefined.
 *
 * Two routes, see ./registration-cert:
 *
 * 1. IMPORTED — `EUDI_REGISTRATION_CERT(_FILE)` holds a JWT from the registrar. It must cover
 *    the query exactly. For PID a certificate that does not is an error HERE, because EUDIPLO
 *    would accept the config and then answer the wallet with HTTP 400. Catalog queries
 *    (Pro, other credential types) are normally not covered by the PID registration, so they
 *    get the certificate only when it does cover them.
 * 2. ISSUED BY EUDIPLO (default, PID only) — we send only the purpose. EUDIPLO derives the
 *    authorized credentials from this very DCQL query, has the registrar issue the
 *    certificate, and caches it per config until the query or the spec changes. Privacy
 *    policy and support contact come from the tenant's registrar defaults unless set here.
 *    Without a registrar configuration EUDIPLO ignores the spec, so this is never worse than
 *    sending nothing.
 */
function registrationCertFor(id: string, dcql: DcqlQuery, kind: VerifierConfigKind): RegistrationCertSpec | undefined {
  const cert = registrationCert();
  if (cert) {
    const missing = uncoveredCredentials(dcql, cert.payload);
    if (!missing.length) return { jwt: cert.jwt };
    if (kind === 'catalog') return undefined;
    throw new Error(
      `Registration certificate (${cert.source}) does not cover verifier config ${id}: credential(s) ` +
      `${missing.join(', ')} are not listed in its \`credentials\` claim with exactly these claims. ` +
      'Run `npm run wrprc:credentials` for the entries the registration has to contain.',
    );
  }
  if (kind !== 'pid') return undefined;
  const privacy = (process.env.EUDI_PRIVACY_POLICY_URL || '').trim();
  const support = (process.env.EUDI_SUPPORT_URI || '').trim();
  return {
    body: {
      purpose: [{ lang: 'de', content: WRP_PURPOSE_TEXT }],
      ...(privacy ? { privacy_policy: privacy } : {}),
      ...(support ? { support_uri: support } : {}),
    },
  };
}

/**
 * EUDIPLO forwards the certificate only when the tenant has a registrar configuration
 * (8.0.2 and 9.1, oid4vp.service.ts: `isEnabledForTenant`). Without one it drops it silently and
 * every wallet that enforces WRPRC refuses the request. Checked once per process, after
 * the first config that carried a certificate; never throws.
 */
let registrarChecked = false;
async function warnIfRegistrarMissing(token: string): Promise<void> {
  if (registrarChecked) return;
  registrarChecked = true;
  try {
    const res = await fetch(`${BASE}/api/registrar/config`, { headers: { Authorization: `Bearer ${token}` } });
    const text = res.ok ? await res.text() : '';
    if (res.status === 404 || (res.ok && (!text || text === 'null'))) {
      console.error(
        '[eudiplo] ⚠️ The tenant has NO registrar configuration. EUDIPLO then leaves the registration ' +
        'certificate out of the request (verifier_info), and wallets that require it refuse every sign-in. ' +
        'Set one up in the EUDIPLO UI (Registrar → Registrar Config) — see the README, "Registration certificate".',
      );
    } else if (!res.ok) {
      console.warn(`[eudiplo] Could not check the registrar configuration (HTTP ${res.status}) — make sure one exists, see the README.`);
    }
  } catch (e: any) {
    console.warn(`[eudiplo] Could not check the registrar configuration: ${e?.message || e}`);
  }
}

/** Register (idempotently) a verifier config from a ready-made DCQL query. The query is
 *  built profile-aware by `credential-profiles.buildDcql` (mdoc and/or SD-JWT etc.).
 *  `kind: 'pid'` additionally enforces the WRP whitelist — see assertPidQueryWithinPolicy.
 *  The check runs BEFORE the registration cache, so a cached id can't skip it. */
export async function ensureVerifierConfig(id: string, dcql: DcqlQuery, kind: VerifierConfigKind): Promise<void> {
  if (kind === 'pid') assertPidQueryWithinPolicy(dcql);
  if (registeredConfigs.has(id)) return;
  const formats = [...new Set(dcql.credentials.map((c) => c.format))].join('+');
  const purpose = kind === 'pid' ? ` purpose=${WRP_PURPOSE_ID}` : '';
  const regCert = registrationCertFor(id, dcql, kind);
  const statusMode = statusCheckMode();
  const body = {
    id,
    description: `OpenID4VP verifier (${formats})${purpose}`,
    lifeTime: 3600,
    // Unset → field omitted → EUDIPLO's default (`strict`); older EUDIPLO versions never see it.
    ...(statusMode ? { statusCheckMode: statusMode } : {}),
    dcql_query: dcql,
    // EUDIPLO puts it into the request object as `verifier_info` — see ./registration-cert.
    ...(regCert ? { registration_cert: regCert } : {}),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt === 1);
    try {
      await postJson('/api/verifier/config', body, token);
      registeredConfigs.add(id);
      if (regCert) void warnIfRegistrarMissing(token);
      return;
    } catch (e: any) {
      // POST is an upsert since EUDIPLO 7, so 409 no longer means "exists already": it means
      // the config is file-managed (config import) and refuses API writes. Caching that as
      // success would leave a stale config in place without a word.
      if (e.status === 409) {
        throw new Error(`EUDIPLO: verifier config ${id} is file-managed and refuses API updates — detach it in EUDIPLO or drop it from the config import`);
      }
      if (e.status === 401 && attempt === 0) { cachedToken = null; continue; }
      throw e;
    }
  }
}

/**
 * Create a verifier offer for the registered config `requestId`. EUDIPLO POSTs the result
 * to `webhookUrl` when the wallet responds.
 *
 * NO `client_id` / `client_id_scheme` in the body: EUDIPLO derives the client_id from the
 * access certificate (`x509_hash:<SHA-256 of the DER>`), so the fields
 * never had an effect. 6.2.0 dropped them silently; since 7.0 the offer schema is strict and
 * answers them with HTTP 400 — every sign-in would fail.
 */
export async function createVerifierOffer(
  webhookUrl: string,
  requestId: string,
  redirectUri?: string,
  transactionData?: readonly Record<string, unknown>[],
): Promise<Offer> {
  const payload: Record<string, unknown> = {
    response_type: 'uri',
    requestId,
    // Channel binding (see ./channel-binding). PER SESSION, not per configuration — the
    // fingerprint belongs to this one call, whereas the configuration is shared. EUDIPLO
    // prefers the session value over the configured one (oid4vp.service.ts).
    ...(transactionData?.length ? { transaction_data: [...transactionData] } : {}),
    // No EUDIPLO-level webhook auth header: instead the caller embeds a per-session
    // secret token in `webhookUrl` (…/webhook/:sessionId?t=<token>), which the server
    // verifies. This authenticates the callback without depending on EUDIPLO's auth
    // schema, and rejects forged POSTs from anyone who only guesses the sessionId.
    webhook: { url: webhookUrl, auth: { type: 'none' } },
    // Same-device return: after the wallet finishes, EUDIPLO redirects the user-agent
    // here. It points at the room URL — on iOS a Universal Link reopens the app, in a
    // browser it returns to the tab. Harmless for cross-device (redirect fires on the
    // wallet device); the webhook + client polling drive the flow regardless.
    ...(redirectUri ? { redirectUri } : {}),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt === 1); // force a fresh rotation on retry
    try {
      const data = await postJson('/api/verifier/offer', payload, token);
      const offer = extractOffer(data);
      warnIfUnpurgeable(offer);
      return offer;
    } catch (e: any) {
      if (e.status === 401 && attempt === 0) {
        cachedToken = null; // token went stale → retry with a rotated secret
        continue;
      }
      throw e;
    }
  }
  throw new Error('createVerifierOffer: unreachable');
}

/**
 * One warning, once, when an offer comes back without a session id.
 *
 * Without the id the session cannot be deleted early and stays at the verifier until its TTL
 * sweep — the zero-retention promise then holds only as far as the instance's own
 * configuration reaches. That is a genuine degradation and must be visible; but it is a
 * property of the instance, not of the call, so it is said once rather than on every offer.
 */
let warnedNoSessionId = false;
function warnIfUnpurgeable(offer: Offer): void {
  if (offer.sessionId || warnedNoSessionId || !BASE) return;
  warnedNoSessionId = true;
  console.warn(
    '[eudiplo] the verifier reports no session id with its offers — presented claims can ' +
    'then NOT be deleted right after the call and remain at the verifier until its own ' +
    'SESSION_TTL sweep. Expected with EUDIPLO 8 (field `session` of the offer response); ' +
    'check the version, and lower SESSION_TTL / SESSION_TIDY_UP_INTERVAL there in the meantime.',
  );
}

/**
 * Delete a verifier session at EUDIPLO — hard, not "mark as done".
 *
 * `DELETE /api/session/:id` (session.controller.ts) removes the row that holds the
 * presented claims and cascades to that session's log entries. It is scoped to the caller's tenant
 * and answers 204 even for an id that does not exist, so a double call is harmless and a
 * foreign id is not an information leak either.
 *
 * Callers should go through `verifier-session.purgeVerifierSession`, which owns the policy
 * (when, how loudly to complain, no double calls). This function is the transport only —
 * consistent with the rest of this module.
 *
 * Without a configured instance (dev against the dummy) there is nothing to delete and
 * nothing to complain about.
 */
export async function deleteVerifierSession(sessionId: string): Promise<void> {
  if (!BASE || !sessionId) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt === 1);
    const res = await fetch(`${BASE}/api/session/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok || res.status === 404) return; // 204 expected; 404 = already gone, same outcome
    if (res.status === 401 && attempt === 0) {
      cachedToken = null; // token went stale → retry once with a fresh one
      continue;
    }
    const err: any = new Error(
      res.status === 403
        ? 'EUDIPLO refuses DELETE /api/session/:id (403) — the tenant client needs the role ' +
          'presentation:request (the same one that creates the offer)'
        : `EUDIPLO DELETE /api/session/:id -> ${res.status}`,
    );
    err.status = res.status;
    throw err;
  }
}

/** Names from a webhook payload (thin wrapper over the format-aware normalizer). */
export function extractNames(payload: any): { givenName?: string; familyName?: string } {
  const c = normalizeClaims(payload);
  return {
    givenName: c.given_name != null ? String(c.given_name) : undefined,
    familyName: c.family_name != null ? String(c.family_name) : undefined,
  };
}

/**
 * Decide whether a webhook payload proves a SUCCESSFUL presentation.
 * Requires a positive signal — an explicit ok-status OR actually-presented claims
 * (normalized across formats). Absence of an error is NOT success (an empty {} must
 * fail), and any explicit error/negative status fails.
 *
 * `presentedClaimCount` lets callers with a NON-PID claim vocabulary (in-call catalog
 * credentials) supply their own "claims actually presented" signal instead of the
 * PID normalizer; the explicit-error/ok status logic stays shared.
 */
/** A code-shaped string: the only kind of payload value that may reach the log. */
const CODE_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;
const codeOf = (v: unknown): string | undefined =>
  typeof v === 'string' && CODE_SHAPE.test(v) ? v : undefined;

/**
 * The machine-readable reason of a failed presentation. EUDIPLO 9 documents `outcome.error`
 * (e.g. `access_denied` when the user declines); the other places are checked because the
 * shape was only read off the source, never observed for every failure path. Only
 * code-shaped strings count, so nothing else from the payload reaches the log.
 */
export function failureCode(payload: any): string | undefined {
  const p = payload || {};
  const perCredential = Array.isArray(p.outcome?.credentials)
    ? p.outcome.credentials.map((c: any) => codeOf(c?.error)).find(Boolean)
    : undefined;
  return codeOf(p.outcome?.error) ?? codeOf(p.outcome?.failureCode) ?? codeOf(p.failureCode)
    ?? codeOf(p.error) ?? perCredential ?? (p.status === 'cancelled' ? 'cancelled' : undefined);
}

/**
 * Log suffix for a failed presentation: ` (code)`, or — when no code is recognised — the
 * payload's SHAPE (status and field names, never values), so the next failure shows where
 * the code actually sits.
 */
export function failureLogSuffix(payload: any): string {
  const code = failureCode(payload);
  if (code) return ` (${code})`;
  const keysOf = (o: any) => (o && typeof o === 'object' && !Array.isArray(o)
    ? Object.keys(o).filter((k) => CODE_SHAPE.test(k)).slice(0, 20) : []);
  const outcome = keysOf(payload?.outcome);
  return ` (code unknown: status=${codeOf(payload?.status) ?? '-'} keys=[${keysOf(payload).join(',')}]`
    + (outcome.length ? ` outcome=[${outcome.join(',')}]` : '') + ')';
}

export function isVerificationSuccess(payload: any, presentedClaimCount?: number): boolean {
  const p = payload || {};
  // EUDIPLO 9 also calls the webhook for failed, declined and cancelled presentations
  // (`status` + `outcome.result`, no `credentials`).
  const explicitError =
    p.error != null || p.errorDescription != null ||
    p.status === 'failed' || p.status === 'error' || p.status === 'cancelled' ||
    p.verified === false ||
    (p.outcome?.result != null && p.outcome.result !== 'success');
  if (explicitError) return false;
  const explicitOk =
    p.status === 'completed' || p.status === 'valid' ||
    p.state === 'completed' || p.verified === true;
  const count = presentedClaimCount ?? Object.keys(normalizeClaims(p)).length;
  return explicitOk || count > 0;
}
