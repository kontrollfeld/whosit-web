// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signature providers for the in-call QES ceremony (public/qes/).
 *
 * A provider tells the CLIENT how to sign: 'mock' (Community demo — self-signed
 * certificate, NOT legally binding), 'csc' (Pro — remote QES at a QTSP via the CSC
 * API) or 'wallet-native' (stub for ARF wallet QES). The configuration is a
 * JSON file (path via EUDI_SIGNATURE_PROVIDERS); without one, Community serves a
 * single built-in mock entry so the demo ceremony works out of the box.
 *
 * Edition gate: GET /signature-providers only ever ships 'csc'/'wallet-native'
 * entries when the server-enforced `qes-csc` feature is active — the CSC
 * OAuth/client configuration never reaches a Community client (hard gate, mirrors
 * the credential-catalog pattern). `qes-csc` needs the Pro edition AND the Pro module's
 * `qualifiedSigner` (pro/qes-csc.ts): the signing itself is not part of the AGPL core.
 */
import fs from 'fs';
import path from 'path';

export type SignatureProviderKind = 'mock' | 'csc' | 'wallet-native' | 'device-local';
export type SignatureLevel = 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';

export interface SignatureProviderEntry {
  id: string;
  kind: SignatureProviderKind;
  label: string;
  /** Highest PAdES level this provider can produce (mock: B-B). */
  maxLevel: SignatureLevel;
  /** Browser module implementing the provider (kind 'device-local', contributed by the Pro
   *  module, never configured by file), relative to the server root: `pro-client/<file>`. */
  module?: string;
  /** Where to get the app a contributed provider needs (App Store / TestFlight). */
  appUrl?: string;
  /** CSC API v2 connection data (kind 'csc' only) — passed to the Pro client as-is. */
  csc?: {
    baseUrl: string;
    clientId: string;
    scopes?: string[];
    authMode?: string;
  };
}

const KINDS: SignatureProviderKind[] = ['mock', 'csc', 'wallet-native'];
const LEVELS: SignatureLevel[] = ['B-B', 'B-T', 'B-LT', 'B-LTA'];

/** Built-in default so the Community demo works without any configuration. */
const BUILTIN_MOCK: SignatureProviderEntry = {
  id: 'mock', kind: 'mock', label: 'Demo-Signatur', maxLevel: 'B-B',
};

const PROVIDERS_PATH = process.env.EUDI_SIGNATURE_PROVIDERS
  || path.join(__dirname, '..', 'signature-providers.json');

function validEntry(e: any): e is SignatureProviderEntry {
  return e && typeof e === 'object'
    && typeof e.id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(e.id)
    && typeof e.label === 'string' && e.label.length > 0
    && KINDS.includes(e.kind)
    && LEVELS.includes(e.maxLevel)
    && (e.kind !== 'csc' || (e.csc && typeof e.csc.baseUrl === 'string' && typeof e.csc.clientId === 'string'));
}

let cached: SignatureProviderEntry[] | null = null;

/**
 * Load + validate the provider config once; falls back to the built-in mock.
 * The committed ./signature-providers.json mirrors the built-in default and serves
 * as the operator's starting point (see README).
 */
export function loadSignatureProviders(): SignatureProviderEntry[] {
  if (cached) return cached;
  cached = [];
  let raw: string;
  try {
    raw = fs.readFileSync(PROVIDERS_PATH, 'utf8');
  } catch {
    cached = [BUILTIN_MOCK]; // no file → demo-only default
    return cached;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e: any) {
    console.warn(`[signature] ${PROVIDERS_PATH} is not valid JSON:`, e?.message || e);
    cached = [BUILTIN_MOCK];
    return cached;
  }
  for (const entry of (Array.isArray(parsed) ? parsed : [])) {
    if (validEntry(entry)) cached.push(entry);
    else console.warn('[signature] skipping invalid provider entry:', JSON.stringify(entry)?.slice(0, 120));
  }
  if (!cached.length) cached = [BUILTIN_MOCK];
  console.log(`[signature] providers: [${cached.map((p) => `${p.id}(${p.kind})`).join(', ')}]`);
  return cached;
}

/**
 * The client-facing list, filtered by edition: configured non-mock providers require the
 * server-enforced `qes-csc` feature (Pro edition + Pro module); contributed ones (the Pro
 * module's device provider) are passed in only while `qes-device` is enabled. `qualified` is
 * derived, never configured — neither a mock nor a demo CA can claim to be qualified.
 */
export function publicSignatureProviders(
  cscEnabled: boolean,
  contributed: ReadonlyArray<Omit<SignatureProviderEntry, 'csc'>> = [],
): Array<SignatureProviderEntry & { qualified: boolean }> {
  const configured = loadSignatureProviders().filter((p) => p.kind === 'mock' || cscEnabled);
  // A contributed id never shadows a configured one: the operator's file wins.
  const extra = contributed.filter((c) => !configured.some((p) => p.id === c.id));
  return [...configured, ...extra].map((p) => ({ ...p, qualified: p.kind === 'csc' }));
}
