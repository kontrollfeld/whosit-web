// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-call credential catalog (Pro) — operator-defined credentials the HOST may request
 * from a participant DURING the call, e.g. a membership or housing credential. See
 * src/credential-requests.ts.
 *
 * Deliberately NOT built on the PID `SemanticAttr` vocabulary: domain credentials bring
 * their own claims. One catalog entry is BOTH the DCQL source (claim paths) and the UI
 * source (display names) — the consent prompt, the wallet request and the result popover
 * all render from the same declaration, so they can never drift apart.
 *
 * The catalog is a JSON file (path via EUDI_CREDENTIAL_CATALOG, default
 * ./credential-catalog.json next to package.json). It is only ever read when the
 * server-enforced `in-call-credentials` feature is active (Pro).
 */
import fs from 'fs';
import path from 'path';
import type { CredentialFormat, DcqlQuery } from './credential-profiles';
import { claimQuery } from './credential-profiles';

export interface CatalogClaim {
  /** DCQL claim path in the credential's own namespace (e.g. ["objekt_id"]). */
  path: (string | number)[];
  /** Display name shown in the consent prompt and the result popover. */
  name: string;
  mandatory?: boolean;
}

export interface CatalogCredential {
  id: string;
  label: string;
  description?: string;
  format: CredentialFormat;
  /** Type in the format's namespace: dc+sd-jwt → vct; mso_mdoc → doctype; jwt_vc_json → VC type.
   *  May be an ARRAY of accepted alternatives (SD-JWT `vct_values`) — issuers are not always
   *  consistent (e.g. an issuer may put a literal name into vct rather than its URL),
   *  so a catalog entry can match several. mdoc uses only the FIRST (doctype_value is single). */
  credentialType: string | string[];
  claims: CatalogClaim[];
}

/** The accepted type identifiers as a (non-empty) array. */
export function credentialTypes(c: CatalogCredential): string[] {
  return Array.isArray(c.credentialType) ? c.credentialType : [c.credentialType];
}

const FORMATS: CredentialFormat[] = ['mso_mdoc', 'dc+sd-jwt', 'jwt_vc_json'];
const CATALOG_PATH = process.env.EUDI_CREDENTIAL_CATALOG
  || path.join(__dirname, '..', 'credential-catalog.json');

function validEntry(e: any): e is CatalogCredential {
  return e && typeof e === 'object'
    && typeof e.id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(e.id)
    && typeof e.label === 'string' && e.label.length > 0
    && FORMATS.includes(e.format)
    && (
      (typeof e.credentialType === 'string' && e.credentialType.length > 0)
      || (Array.isArray(e.credentialType) && e.credentialType.length > 0
          && e.credentialType.every((t: any) => typeof t === 'string' && t.length > 0))
    )
    && Array.isArray(e.claims) && e.claims.length > 0
    && e.claims.every((c: any) => c && typeof c.name === 'string'
      && Array.isArray(c.path) && c.path.length > 0
      && c.path.every((s: any) => typeof s === 'string' || typeof s === 'number'));
}

let cached: CatalogCredential[] | null = null;

/** Load + validate the catalog once; invalid entries are skipped with a warning. */
export function loadCatalog(): CatalogCredential[] {
  if (cached) return cached;
  cached = [];
  let raw: string;
  try {
    raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  } catch {
    console.warn(`[catalog] no credential catalog at ${CATALOG_PATH} — in-call requests disabled`);
    return cached;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e: any) {
    console.warn(`[catalog] ${CATALOG_PATH} is not valid JSON:`, e?.message || e);
    return cached;
  }
  const list = Array.isArray(parsed) ? parsed : [];
  for (const entry of list) {
    if (validEntry(entry)) cached.push(entry);
    else console.warn(`[catalog] skipping invalid entry:`, JSON.stringify(entry)?.slice(0, 120));
  }
  console.log(`[catalog] loaded ${cached.length} credential(s): [${cached.map((c) => c.id).join(', ')}]`);
  return cached;
}

export function catalogEntry(id: string): CatalogCredential | undefined {
  return loadCatalog().find((c) => c.id === id);
}

/** The client-facing shape: display data only — enough to render menu + consent prompt. */
export function publicCatalog(): Array<{
  id: string; label: string; description?: string;
  claims: Array<{ name: string; mandatory: boolean }>;
}> {
  return loadCatalog().map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    claims: c.claims.map((cl) => ({ name: cl.name, mandatory: cl.mandatory !== false })),
  }));
}

function metaFor(c: CatalogCredential): Record<string, unknown> {
  const types = credentialTypes(c);
  switch (c.format) {
    case 'mso_mdoc': return { doctype_value: types[0] };
    case 'dc+sd-jwt': return { vct_values: types };
    case 'jwt_vc_json': return { type_values: types.map((t) => [t]) };
  }
}

/** DCQL query for ONE catalog credential (single format — no credential_sets needed). */
export function buildCatalogDcql(c: CatalogCredential): DcqlQuery {
  return {
    credentials: [{
      id: c.id,
      format: c.format,
      meta: metaFor(c),
      claims: c.claims.map((cl) => claimQuery(c.format, cl.path)),
    }],
  };
}

/** Stable claim key for a catalog claim: its last string path segment (audit/log key). */
export function claimKey(cl: CatalogClaim): string {
  const strings = cl.path.filter((s): s is string => typeof s === 'string');
  return strings[strings.length - 1] ?? String(cl.path[cl.path.length - 1]);
}

// ---- webhook claim extraction (generic, catalog-path-driven) -----------------

/** Merge the raw presented claim objects out of an EUDIPLO webhook payload. */
function mergedValues(payload: any): Record<string, any> {
  const out: Record<string, any> = {};
  const creds = payload?.credentials;
  if (Array.isArray(creds)) {
    for (const c of creds) {
      const vals = c?.values;
      if (Array.isArray(vals)) for (const v of vals) if (v && typeof v === 'object') Object.assign(out, v);
    }
  }
  return out;
}

function walkPath(obj: any, p: (string | number)[]): any {
  let cur = obj;
  for (const seg of p) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg as any];
  }
  return cur;
}

function deepFind(obj: any, key: string): any {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const k of Object.keys(obj)) {
    const found = deepFind(obj[k], key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Extract the catalog-declared claims from a webhook payload, keyed by `claimKey`.
 * Tries the full DCQL path first, then the flat last segment (mdoc responses come
 * back flat, without the doctype namespace), then a deep search as last resort.
 * Only declared claims are ever picked up — undeclared payload fields are ignored.
 */
export function extractCatalogClaims(c: CatalogCredential, payload: any): Record<string, any> {
  const merged = mergedValues(payload);
  const out: Record<string, any> = {};
  for (const cl of c.claims) {
    const key = claimKey(cl);
    let v = walkPath(merged, cl.path);
    if (v === undefined) v = merged[key];
    if (v === undefined) v = deepFind(payload, key);
    if (v !== undefined && v !== null) out[key] = v;
  }
  return out;
}

/** All mandatory claims present? (A partial presentation must not count as success.) */
export function hasMandatoryClaims(c: CatalogCredential, claims: Record<string, any>): boolean {
  return c.claims.filter((cl) => cl.mandatory !== false).every((cl) => claimKey(cl) in claims);
}
