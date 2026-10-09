// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the registration certificate (WRPRC) has to authorize for THIS configuration.
 *
 * EUDIPLO 8.0.2 compares every outgoing DCQL credential EXACTLY against the certificate's
 * `credentials` claim (see src/registration-cert.ts). A room may ask for any non-empty subset
 * of the wallet-requestable attributes, and each subset is a different claims array — so the
 * registration has to list each of them. This prints that list, built by the same
 * `buildDcql` the server uses, so it cannot drift from what actually goes on the wire.
 *
 * With EUDI_REGISTRATION_CERT(_FILE) set it also says which entries the current certificate
 * is missing, and exits 1 when any are.
 *
 *   npm run wrprc:credentials            JSON for the registrar application
 *   npm run wrprc:credentials -- --check only the coverage report
 */
import { buildDcql, selectedProfiles, type SemanticAttr } from '../src/credential-profiles';
import { WALLET_REQUESTABLE } from '../src/wrp-policy';
import { canonicalJson, loadRegistrationCert, registrableShape, uncoveredCredentials } from '../src/registration-cert';

const attrs = [...WALLET_REQUESTABLE] as SemanticAttr[];
const profiles = selectedProfiles();

const subsets: SemanticAttr[][] = [];
for (let mask = 1; mask < 1 << attrs.length; mask++) subsets.push(attrs.filter((_, i) => mask & (1 << i)));

const entries = new Map<string, { attrs: SemanticAttr[]; shape: ReturnType<typeof registrableShape> }>();
for (const subset of subsets) {
  for (const cred of buildDcql(profiles, subset).credentials) {
    if (!cred.claims.length) continue; // a profile that can express none of these asks nothing
    const shape = registrableShape(cred);
    const key = canonicalJson(shape);
    if (!entries.has(key)) entries.set(key, { attrs: subset, shape });
  }
}

const checkOnly = process.argv.includes('--check');
if (!checkOnly) {
  console.error(`# ${entries.size} credential entries for profiles [${profiles.map((p) => p.id).join(', ')}], attributes [${attrs.join(', ')}]`);
  console.log(JSON.stringify([...entries.values()].map((e) => e.shape), null, 2));
}

const cert = loadRegistrationCert();
if (!cert) {
  console.error('# No EUDI_REGISTRATION_CERT(_FILE) set — nothing to check against.');
  process.exit(0);
}
const missing = [...entries.values()].filter((e) =>
  uncoveredCredentials({ credentials: [{ id: 'x', ...e.shape }] } as any, cert.payload).length > 0);
const exp = typeof cert.payload.exp === 'number' ? new Date(cert.payload.exp * 1000).toISOString() : 'none';
console.error(`# ${cert.source}: ${entries.size - missing.length}/${entries.size} covered, exp ${exp}`);
for (const m of missing) console.error(`#   missing: ${m.shape.format} [${m.attrs.join(', ')}]`);
process.exit(missing.length ? 1 : 0);
