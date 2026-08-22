// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin transport client for the shared EUDIPLO instance (reused from eudi_wallet_login).
 *
 * EUDIPLO does the OpenID4VP heavy lifting (mdoc/SD-JWT, X.509, signed/encrypted
 * requests). This module is protocol-agnostic: it authenticates (tenant secret rotates →
 * recover via the root account), registers a verifier config from a ready-made DCQL query,
 * and creates the presentation offer. WHAT to ask for (format/type/claim paths/trust
 * framework) and HOW to read the response is decided by `credential-profiles.ts`
 * (`buildDcql`/`normalizeClaims`) — so different OpenID4VP wallets are supported by varying
 * the query, not by changing this transport.
 */
import type { DcqlQuery, ClientIdScheme } from './credential-profiles';
import { normalizeClaims, permittedPidClaimPaths } from './credential-profiles';
import { PolicyViolationError, WRP_PURPOSE_ID } from './wrp-policy';

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
 * There used to be fallbacks here pointing at an instance we operate, root secret included.
 * That was already questionable and is now simply wrong: every deployment brings its OWN
 * verifier (its own EUDIPLO instance, its own access certificate on its own domain). A default
 * would let an incompletely configured server run quietly against someone else's host —
 * meanwhile shut down — instead of surfacing the configuration error.
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
 * copying an existing environment into an authority deployment HAS set it — to the original
 * operator's tenant. That is exactly the mix-up this is meant to surface.
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
/**
 * Documentary only: EUDIPLO derives the `client_id` from the access certificate
 * (`x509_hash:<SHA-256 of the DER>`) — measured on 2026-08-09. Whatever is set here has no
 * effect in the request object. No default: a foreign hostname as a preset would be
 * misleading, and when empty `createVerifierOffer` omits the field entirely.
 */
const VERIFIER_CLIENT_ID = process.env.VERIFIER_CLIENT_ID || '';

export interface Offer {
  uri: string; // same-device (tap to open the wallet on this phone)
  crossDeviceUri: string; // cross-device (render as QR, scan with a separate phone)
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
 *  not static (it gets rotated), so we recover it through the root account. */
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
  // This keeps secret rotations rare so we don't fight the eudi_wallet_login app
  // over the shared tenant.
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
  return { uri, crossDeviceUri };
}

const registeredConfigs = new Set<string>();

/**
 * What a verifier config is for. `pid` = the pre-connect identity gate, subject to the
 * WRP attribute whitelist. `catalog` = an in-call credential request (Pro, e.g.
 * Wohnraum-ID, see src/credential-requests.ts): a different credential type with its own
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
 * would contradict the zero-retention architecture even if we then discarded the data.
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

/** Register (idempotently) a verifier config from a ready-made DCQL query. The query is
 *  built profile-aware by `credential-profiles.buildDcql` (mdoc and/or SD-JWT etc.).
 *  `kind: 'pid'` additionally enforces the WRP whitelist — see assertPidQueryWithinPolicy.
 *  The check runs BEFORE the registration cache, so a cached id can't skip it. */
export async function ensureVerifierConfig(id: string, dcql: DcqlQuery, kind: VerifierConfigKind): Promise<void> {
  if (kind === 'pid') assertPidQueryWithinPolicy(dcql);
  if (registeredConfigs.has(id)) return;
  const formats = [...new Set(dcql.credentials.map((c) => c.format))].join('+');
  const purpose = kind === 'pid' ? ` purpose=${WRP_PURPOSE_ID}` : '';
  const body = { id, description: `OpenID4VP verifier (${formats})${purpose}`, lifeTime: 3600, dcql_query: dcql };
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt === 1);
    try {
      await postJson('/api/verifier/config', body, token);
      registeredConfigs.add(id);
      return;
    } catch (e: any) {
      if (e.status === 409) { registeredConfigs.add(id); return; } // already exists
      if (e.status === 401 && attempt === 0) { cachedToken = null; continue; }
      throw e;
    }
  }
}

/**
 * Create a verifier offer for the registered config `requestId`. `clientIdScheme` +
 * `clientId` (from the selected credential profile) set the trust framework the verifier
 * presents to the wallet. EUDIPLO POSTs the result to `webhookUrl` when the wallet responds.
 */
export async function createVerifierOffer(
  webhookUrl: string,
  requestId: string,
  clientIdScheme: ClientIdScheme = 'x509_san_dns',
  clientId: string = VERIFIER_CLIENT_ID,
  redirectUri?: string,
  transactionData?: readonly Record<string, unknown>[],
): Promise<Offer> {
  const payload: Record<string, unknown> = {
    response_type: 'uri',
    requestId,
    client_id_scheme: clientIdScheme,
    // Only send when set: without a default the value can be empty, and an empty `client_id`
    // is not the same as an absent one. It has no effect either way (see above).
    ...(clientId ? { client_id: clientId } : {}),
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
    // here. We point it at the room URL — on iOS a Universal Link reopens the app, in a
    // browser it returns to the tab. Harmless for cross-device (redirect fires on the
    // wallet device); the webhook + client polling drive the flow regardless.
    ...(redirectUri ? { redirectUri } : {}),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt === 1); // force a fresh rotation on retry
    try {
      const data = await postJson('/api/verifier/offer', payload, token);
      return extractOffer(data);
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
export function isVerificationSuccess(payload: any, presentedClaimCount?: number): boolean {
  const p = payload || {};
  const explicitError =
    p.error != null || p.errorDescription != null ||
    p.status === 'failed' || p.status === 'error' || p.verified === false;
  if (explicitError) return false;
  const explicitOk =
    p.status === 'completed' || p.status === 'valid' ||
    p.state === 'completed' || p.verified === true;
  const count = presentedClaimCount ?? Object.keys(normalizeClaims(p)).length;
  return explicitOk || count > 0;
}
