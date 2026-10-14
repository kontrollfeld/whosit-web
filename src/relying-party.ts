// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * WHO is actually asking for someone's ID — and does the page say so?
 *
 * On a white-labelled instance these come apart. The page carries the customer's name, logo and
 * colour (see ./branding), but the wallet shows whoever owns the ACCESS CERTIFICATE behind the
 * EUDIPLO tenant. That is not a configuration detail: EUDIPLO derives `client_id` as
 * `x509_hash:<SHA-256 of the DER>` from the certificate (measured 2026-08-09), so
 * `VERIFIER_CLIENT_ID` has no effect and the tenant alone decides the visible identity.
 *
 * Measured on the first tenant instance (lhd.id-call.eu, August 2026): the page said "LHD
 * Bürgerservice", the wallet said "Kontrollfeld". Nothing in the interface explained the gap.
 *
 * Whoever is shown one organisation and asked by another cannot give informed consent to the
 * request, and Art. 5a(4) EU 2024/1183 binds a request to a declared purpose and a declared
 * relying party. So the gap is not hidden, it is STATED — in the verification dialogue, above the
 * QR code, before anyone opens a wallet. Until now it was only a line in the startup log
 * (`src/server.ts`), which is the one place the person being asked never looks.
 *
 * This applies to every kind of operator, not only public ones. A bank, an insurer, a clinic, a
 * letting agent and a city desk differ in what they may ask for; they do not differ in owing the
 * person an answer to "who is asking".
 *
 * Two variables:
 *
 *   EUDI_RP_NAME     The legal entity that holds the access certificate behind
 *                    EUDIPLO_CLIENT_ID — "Kontrollfeld GmbH", not a domain, not a tenant id.
 *   EUDI_BRAND_NAME  Already exists (./branding): whose name the page carries.
 *
 * NOT switchable off, deliberately: an operator who could suppress the sentence would be back at
 * the state this module exists to end. What an operator CAN do is make it unnecessary — run the
 * instance on their own tenant with their own certificate, set EUDI_RP_NAME to the same entity as
 * the brand, and the sentence disappears because there is nothing left to disclose.
 */
import { isDefaultVerifierTenant, verifierTenantId } from './eudiplo';

export interface RelyingPartyDisclosure {
  /** The legal entity behind the certificate, when the operator has named it. */
  name: string | null;
  /** Whose name the page carries, when that is someone else. */
  onBehalfOf: string | null;
  /** Must the client state this to the user before the wallet is opened? */
  disclose: boolean;
}

/**
 * Work out what has to be said.
 *
 * Disclosure is required when the page is branded AND any of:
 *
 *   - the instance queries through the DEFAULT tenant. Then the certificate is the original
 *     operator's, whatever any name variable claims — this case ignores the names on purpose,
 *     because an operator who sets EUDI_RP_NAME to the customer's own name while running on
 *     someone else's certificate has described the situation wrongly, and the description must
 *     not be able to switch the disclosure off.
 *   - EUDI_RP_NAME is unset. Unknown is not the same as identical; the honest reading of a
 *     missing value is "we cannot confirm these are the same party".
 *   - the two names differ.
 *
 * An UNBRANDED instance discloses nothing: the page carries no one else's name, so there is no
 * gap between what is shown and who asks. That keeps this module a complete no-op on whosit.eu
 * and on every self-hosted instance that has not set EUDI_BRAND_NAME — the same condition
 * ./branding holds itself to.
 */
export function relyingParty(
  brandName: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RelyingPartyDisclosure {
  const name = (env.EUDI_RP_NAME || '').trim() || null;
  const brand = (brandName || '').trim() || null;
  if (!brand) return { name, onBehalfOf: null, disclose: false };
  const disclose = isDefaultVerifierTenant() || !name || name !== brand;
  return { name, onBehalfOf: disclose ? brand : null, disclose };
}

/**
 * The startup line. A warning, not an abort: the instance is not unsafe, it is under-described,
 * and the client already says so in the blunter of its two wordings. Aborting would take a
 * running instance down on the next deployment for something the person is being told anyway.
 */
export function relyingPartyWarning(d: RelyingPartyDisclosure): string | null {
  if (!d.disclose) return null;
  if (!d.name) {
    return (
      `⚠️  This instance is branded "${d.onBehalfOf}" but does not say who actually holds the ` +
      `access certificate (EUDI_RP_NAME is unset). The verification dialogue therefore tells ` +
      `only that the request does NOT come from "${d.onBehalfOf}" — set EUDI_RP_NAME to ` +
      `the legal entity behind tenant "${verifierTenantId()}" so it can name them instead.`
    );
  }
  return (
    `ℹ️  Branded "${d.onBehalfOf}", querying wallets as "${d.name}" (tenant ` +
    `"${verifierTenantId()}"). The verification dialogue states this before the wallet opens. ` +
    `It disappears once the instance runs on ${d.onBehalfOf}'s own tenant and certificate.`
  );
}
