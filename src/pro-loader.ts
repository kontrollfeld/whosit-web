// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resolve the active Extensions at startup.
 *
 * Community returns the built-in defaults. If EUDI_PRO_MODULE names an installed Pro
 * package, it is dynamically imported and may override the room store / verification
 * sink / add plugins via an exported `register(defaults)` (or a plain export shape).
 *
 * Pro is strictly OPTIONAL and additive: any resolution failure logs a warning and
 * falls back to Community, so the open-source core never hard-depends on Pro code.
 *
 * Example — the commercially licensed module in ./pro:
 *   export function register(defaults) {
 *     return { verificationSink: myAuditTrail, plugins: [myPlugin] };
 *   }
 * Enable with:  EUDI_PRO_MODULE=./pro
 */
import { resolve, isAbsolute } from 'path';
import { communityRoomStore, noopVerificationSink } from './core/community';
import type { Extensions } from './core/ports';

export async function loadExtensions(): Promise<Extensions> {
  const defaults: Extensions = {
    roomStore: communityRoomStore,
    verificationSink: noopVerificationSink,
    plugins: [],
    enabledFeatures: [],
  };

  const spec = (process.env.EUDI_PRO_MODULE || '').trim();
  if (!spec) return defaults;

  // Resolve relative paths against the WORKING DIRECTORY, not against this file. Otherwise
  // `./pro` would look inside `dist/pro` after compilation — not what anyone means when they
  // write it into a .env. Package names (`@scope/name`) pass through untouched.
  const target = spec.startsWith('.') && !isAbsolute(spec) ? resolve(process.cwd(), spec) : spec;

  try {
    const mod: any = await import(target);
    const reg = mod.register ?? mod.default?.register ?? mod.default ?? mod;
    const ext = typeof reg === 'function' ? await reg(defaults) : reg;
    const merged: Extensions = {
      roomStore: ext?.roomStore ?? defaults.roomStore,
      verificationSink: ext?.verificationSink ?? defaults.verificationSink,
      plugins: [...defaults.plugins, ...(ext?.plugins ?? [])],
      enabledFeatures: [...defaults.enabledFeatures, ...(ext?.enabledFeatures ?? [])],
      qualifiedSigner: ext?.qualifiedSigner ?? defaults.qualifiedSigner,
      certificateIssuer: ext?.certificateIssuer ?? defaults.certificateIssuer,
      signatureProviders: [...(defaults.signatureProviders ?? []), ...(ext?.signatureProviders ?? [])],
      clientAssetsDir: ext?.clientAssetsDir ?? defaults.clientAssetsDir,
    };
    console.log(`[pro] loaded "${spec}" — plugins: [${merged.plugins.map((p) => p.name).join(', ') || 'none'}]`
      + `, qualified signer: ${merged.qualifiedSigner ? 'yes' : 'no'}`
      + `, device certificates: ${merged.certificateIssuer ? 'yes' : 'no'}`);
    return merged;
  } catch (e: any) {
    // A module that is CONFIGURED but fails to load is a configuration error, not Community
    // operation. Whoever sets `EUDI_PRO_MODULE` runs this instance with retention — carrying
    // on silently without an audit trail would drop that obligation unnoticed, and the record
    // would then be missing exactly when it is needed. So: abort in production, warn loudly
    // in development.
    const inProduction = (process.env.NODE_ENV || '').trim() === 'production';
    console.error(`[pro] could not load module "${spec}": ${e?.message || e}`);
    if (inProduction) {
      console.error('[pro] Startup aborted: EUDI_PRO_MODULE is set but the module does not load.');
      console.error('[pro] Without it this instance would run WITHOUT a retainable audit trail,');
      console.error('[pro] and that must not happen unnoticed. Either build the module');
      console.error('[pro] (npm run build:pro) or remove EUDI_PRO_MODULE if this instance is');
      console.error('[pro] meant to run as Community.');
      process.exit(1);
    }
    console.warn('[pro] Continuing with Community defaults (production would abort here).');
    return defaults;
  }
}
