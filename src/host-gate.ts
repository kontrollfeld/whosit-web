// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Who may act as host on this instance?
 *
 * On a tenant instance — a city administration, say — this is the real gap: without the check,
 * anyone who knows the URL can invite citizens to a call under the authority's coat of arms.
 * Guests are NEVER affected: they are invited, not admitted.
 *
 * HOW: the name from the wallet-presented, cryptographically verified PID is matched against a
 * list in the environment. That is considerably stronger than it sounds — the name does not come
 * from an input field but from a state-issued ID. Anyone wanting to pose as authorised needs a
 * REAL ID document carrying exactly that name.
 *
 * THE LIMIT, stated plainly: name equality. There are many genuine IDs for "Michael Müller", and
 * a targeted attempt does not attack the cryptography — it looks for a person with a matching
 * name. Only the date of birth would make the identifier unique, but that attribute is retired
 * under this instance's registration and publicly declared as retired at /wrp-policy; requesting
 * it for this purpose would contradict our own statement. This layer is therefore meant as ONE
 * of two, together with the staff link (see ./staff-token). The target state is an authority
 * staff credential: then a revocable credential replaces the name list, and this checkpoint stays.
 */

/**
 * Make names comparable.
 *
 * NFC, so that "ü" as a single character and as u + diaeresis compare equal — wallets and
 * configuration come from different sources and do not normalise alike. Lower-cased, because ID
 * documents may print "MUSTERMANN". Repeated spaces and hyphens unified, because "Hans-Peter" and
 * "Hans Peter" mean the same person and an over-strict comparison locks out the wrong people.
 */
function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLocaleLowerCase('de-DE')
    .replace(/[-‐-―]/g, ' ')  // hyphens and dashes → space
    .replace(/\s+/g, ' ')
    .trim();
}

/** One list entry: family name and given name, both normalised. */
interface Entry { family: string; given: string; }

/**
 * `EUDI_HOST_ALLOWLIST` — entries separated by `;`, each `FamilyName,GivenName`.
 *
 *     EUDI_HOST_ALLOWLIST=Mustermann,Erika; Schmidt,Hans-Peter; Yılmaz,Ayşe
 *
 * Unset or empty → the check is a no-op. That is the condition for an instance without a tenant
 * setup to be entirely unaffected by this module.
 */
function parse(raw: string): Entry[] {
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(',');
      if (i < 0) return null; // unusable without a comma — see assertHostGateOrExit
      return { family: normalize(entry.slice(0, i)), given: normalize(entry.slice(i + 1)) };
    })
    .filter((e): e is Entry => !!e && !!e.family && !!e.given);
}

const RAW = (process.env.EUDI_HOST_ALLOWLIST || '').trim();
const ALLOWED: Entry[] = parse(RAW);

/** Is the host gate active on this instance at all? */
export function hostGateActive(): boolean {
  return ALLOWED.length > 0;
}

/** How many people are admitted — for the startup log, without naming anyone. */
export function hostGateSize(): number {
  return ALLOWED.length;
}

/**
 * May this person host?
 *
 * Without an active gate: always yes. With the gate: only on a match of BOTH family and given
 * name. If either is missing the answer is no — a participant without a verified name cannot be
 * on the list, and letting them through silently would be exactly the gap this gate closes.
 */
export function mayHost(familyName?: string, givenName?: string): boolean {
  if (!hostGateActive()) return true;
  if (!familyName || !givenName) return false;
  const f = normalize(familyName);
  const g = normalize(givenName);
  return ALLOWED.some((e) => e.family === f && e.given === g);
}

/**
 * What the host MUST disclose for the gate to work at all.
 *
 * Without this it locks out the operator: a room's default discloses only the family name
 * (`rooms.ts`), while `mayHost` requires both — so the host would never get through, and the
 * reason would be written nowhere. Observed in a real wallet's log on 2026-08-15:
 * "Verifier requested items: [family_name]".
 *
 * Disclosure is therefore ENFORCED rather than assumed. Data minimisation still holds: both
 * names are permitted under this instance's policy anyway, and whoever wants to host discloses
 * them necessarily — the gate compares precisely those.
 */
export function enforceHostDisclosure<T extends string>(attrs: readonly T[]): T[] {
  if (!hostGateActive()) return [...attrs];
  const out = [...attrs];
  for (const n of ['given_name', 'family_name'] as unknown as T[]) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Refuse to start when the gate CANNOT work.
 *
 * Two cases, both quietly dangerous:
 *   - Entries without a comma: the list looks populated but contains nobody. An instance that
 *     admits everyone although the operator configured a gate is worse than one without a gate —
 *     because people rely on it.
 *   - The policy asks the host for no name at all (anonymous direction): then there is nothing to
 *     compare and `mayHost` would reject everyone. The instance would be unusable, and the reason
 *     would be written nowhere.
 */
export function assertHostGateOrExit(
  hostDisclosesName: boolean,
  log: (m: string) => void = console.error,
  exit: (code: number) => void = process.exit,
): void {
  if (!RAW) return;
  if (ALLOWED.length === 0) {
    log(
      `FATAL: EUDI_HOST_ALLOWLIST is set but yields no valid entry. Expected ` +
        `"FamilyName,GivenName", multiple separated by ";". An instance that admits everyone ` +
        `as host despite a configured gate is more dangerous than one without a gate — ` +
        `hence aborting.`,
    );
    exit(1);
    return;
  }
  if (!hostDisclosesName) {
    log(
      `FATAL: EUDI_HOST_ALLOWLIST is set, but this instance's WRP policy asks the host for no ` +
        `name. There would be nothing to compare and nobody would get through. Either add ` +
        `given_name and family_name to the policy, or remove the allowlist.`,
    );
    exit(1);
  }
}
