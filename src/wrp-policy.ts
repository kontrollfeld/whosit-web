// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * WRP policy — the regulatory boundary of this Relying Party, in one dependency-free file.
 *
 * To be an approvable Wallet Relying Party under eIDAS 2.0 (EU 2024/1183) / the ARF, this
 * service must NOT act as an open proxy for arbitrary identity queries. So the set of
 * attributes a client may ever cause us to ask a wallet for is fixed HERE, at compile
 * time, and cannot be widened by any request, room config, embed parameter or env var.
 *
 * Why its own module (and not, say, inside eudiplo.ts): this is the one artifact an
 * auditor should be able to read end-to-end without following imports. Both the transport
 * layer (`eudiplo.ts`, which enforces it against the outgoing DCQL query) and the request
 * vocabulary (`credential-profiles.ts`, whose `SemanticAttr` is DERIVED from it) point at
 * this single source of truth. `eudiplo.ts` re-exports it for convenience.
 *
 * Two properties matter and are tested by construction:
 *   1. `ALLOWED_PID_ATTRIBUTES` is the ONLY place the permitted set is written down.
 *   2. Nothing outside it can reach a wallet — see the egress gate in `eudiplo.ts`.
 *
 * WHAT IS CONFIGURABLE, AND WHAT IS NOT. No env var can ever WIDEN what a wallet is asked.
 * That property is unchanged and load-bearing. What an operator may do is SELECT among the
 * named policies written down below (`EUDI_WRP_POLICY`) — each one reviewed, committed, and
 * readable in this same file.
 *
 * Why selection and not free configuration: a second deployment can serve a different legal
 * entity (an authority under its own WRP registration) whose lawful attribute set differs
 * from ours. Letting the environment invent an attribute would hand the boundary to whoever
 * controls the deployment and break the "read one file end-to-end" promise above. Letting it
 * pick from a fixed menu keeps both: the menu is here, in code, and every entry is bounded by
 * `KNOWN_PID_ATTRIBUTES` — which in turn cannot grow without a mapping in
 * `credential-profiles.ts`, because `MDOC_KEYS`/`SDJWT_PATHS` are `Record<SemanticAttr, …>`
 * and the compiler refuses an unmapped attribute.
 *
 * The other knob is `EUDI_WRP_STRICT`: whether an out-of-scope REQUEST is refused outright or
 * quietly narrowed to the whitelist. Both modes send the wallet exactly the same thing —
 * the knob changes error reporting, never data minimisation. See `wrpStrict()`.
 */

/**
 * Attributes an approved WRP may request for the purpose declared in `WRP_PURPOSE_ID`.
 * Data minimisation (Art. 5a(4) EU 2024/1183): the least identifying set that still
 * supports "I know who I am talking to".
 *
 *   given_name    — first name (PID)
 *   family_name   — last name (PID)
 *   age_over_18   — ZKP-style age assertion; the BOOLEAN only, never a birth date
 *   pseudonym_id  — ephemeral pairwise identifier, DERIVED server-side (see pseudonym.ts);
 *                   deliberately NOT requested from the wallet, see WALLET_REQUESTABLE
 */
/**
 * The complete vocabulary this codebase can put into a wallet request — the OUTER bound.
 * No policy below may exceed it, and it cannot grow without a claim mapping in
 * `credential-profiles.ts` (`MDOC_KEYS`/`SDJWT_PATHS` are `Record<SemanticAttr, …>`, so the
 * compiler rejects an unmapped addition). Being listed here does NOT make an attribute
 * requestable — only a policy that names it does.
 */
export const KNOWN_PID_ATTRIBUTES = [
  'given_name',
  'family_name',
  'age_over_18',
  'pseudonym_id',
  'birth_date',
  'issuing_country',
  'address',
] as const;

export type AllowedPidAttribute = (typeof KNOWN_PID_ATTRIBUTES)[number];

export interface WrpPolicy {
  /** Stable id, published under /wrp-policy and used in audit lines. */
  purposeId: string;
  purposeText: string;
  complianceNote: string;
  /** What this registration permits. A SUBSET of KNOWN_PID_ATTRIBUTES, by construction. */
  attributes: readonly AllowedPidAttribute[];
}

/**
 * The menu. One entry per approved WRP registration.
 *
 * Adding an entry is a code change, a review and a deploy — deliberately. The attribute set
 * of an entry must follow that entity's actual registration, not the other way round: the
 * registration decides what may lawfully be asked, this file only records it.
 */
export const WRP_POLICIES: Record<string, WrpPolicy> = {
  /** id-call.eu itself. These are exactly the values that shipped before policies existed —
   *  an instance without EUDI_WRP_POLICY must behave identically. */
  'p2p-call': {
    purposeId: 'identity-verification-p2p-call',
    purposeText: 'Identitätsverifikation für sichere P2P-Kommunikation',
    complianceNote: 'Gemäß eIDAS 2.0 WRP-Zulassung auf datensparsame Basis-Attribute beschränkt.',
    attributes: ['given_name', 'family_name', 'age_over_18', 'pseudonym_id'],
  },

  /**
   * TEMPLATE for a public-authority instance — to copy, not to use.
   *
   * NOT IN SERVICE and not fit for use. An authority MUST replace three things before this
   * becomes a real policy:
   *
   * 1. **The attribute list.** It is a placeholder here. What may lawfully be requested is
   *    decided by the authority's WRP registration — this file merely records it, it does not
   *    create any entitlement.
   * 2. **`purposeText` and `complianceNote`.** Both are shown to the citizen and appear in the
   *    audit record, and must name the actual body and the actual purpose. Placeholder text
   *    would not be purpose binding, it would be an assertion.
   * 3. **The verifier identity.** The instance must run under the authority's OWN EUDIPLO
   *    tenant with their certificate, otherwise it requests under someone else's
   *    registration. The server warns at startup when a non-default policy runs on the
   *    default tenant.
   *
   * Deliberately in source and NOT extendable by environment variable: which attributes a
   * policy permits should be readable and versioned, not settable at runtime.
   */
  'kommune-buergerservice': {
    purposeId: 'buergerservice-identitaetspruefung',
    purposeText: 'Identitätsprüfung im Bürgerservice der Kommune (VORLAGE — ersetzen)',
    complianceNote:
      'VORLAGE — durch die tatsächliche WRP-Zulassung der Behörde ersetzen. Abfrage beschränkt auf die für den Vorgang erforderlichen Angaben.',
    attributes: ['given_name', 'family_name', 'birth_date', 'address', 'pseudonym_id'],
  },
};

// Backwards compatibility: the template used to be named after its first prospective user.
// The old name stays valid so that an already-configured EUDI_WRP_POLICY does not trigger a
// startup abort (assertPolicyOrExit lets no unknown name through — correct in general, but
// here it would be a self-inflicted outage). Points at the same policy.
WRP_POLICIES['lhd-buergerservice'] = WRP_POLICIES['kommune-buergerservice'];

/** Selected per deployment. An unknown name must stop the server — see assertPolicyOrExit. */
const POLICY_NAME = (process.env.EUDI_WRP_POLICY || 'p2p-call').trim();
const ACTIVE: WrpPolicy = WRP_POLICIES[POLICY_NAME] ?? WRP_POLICIES['p2p-call'];

export function activePolicyName(): string {
  return WRP_POLICIES[POLICY_NAME] ? POLICY_NAME : 'p2p-call';
}

/**
 * `EUDI_WRP_NARROW` — per-instance NARROWING within the selected policy.
 *
 * The rule at the top of this file is unchanged and stays load-bearing: no environment
 * variable may ever WIDEN what a wallet is asked. This one cannot. It is intersected with
 * the active policy, never unioned, so the result is always a SUBSET of a set that was
 * written down, reviewed and committed above.
 *
 * Why it exists: a hosted instance runs under the operator's registration but serves ONE
 * customer's purpose, and that purpose is almost always narrower than the registration. The
 * registration is drawn wide enough to cover every deployment; a single deployment covers one.
 * A support line that only needs "who am I talking to" should not ask for a date of birth
 * merely because the registration would permit it, whether it belongs to an insurer, a notary,
 * a clinic, a landlord or a public authority. Data minimisation (Art. 5a(4) EU 2024/1183) is an
 * obligation per PROCESSING, not per registration — so an instance must be able to ask for LESS
 * without a code change, while asking for MORE stays a code change forever.
 *
 * What it is NOT: a way to configure a new policy. An attribute that is not in the selected
 * policy is refused at startup, not silently ignored — see `assertNarrowOrExit`.
 *
 * Unset or empty → no-op: `ALLOWED_PID_ATTRIBUTES` is exactly the policy's set, and an
 * instance that does not use this variable is entirely unaffected.
 *
 *     EUDI_WRP_NARROW=given_name,family_name
 */
const NARROW: readonly string[] = (process.env.EUDI_WRP_NARROW || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Is this instance asking for less than its registration permits? */
export function wrpNarrowed(): boolean {
  return NARROW.length > 0;
}

/**
 * Refuse to start on a policy name that does not exist.
 *
 * Falling back silently would be the worst outcome: a deployment meant to run under an
 * authority's narrow registration would quietly serve ours instead, and nothing in the UI
 * would say so. Called from the server's startup path.
 */
export function assertPolicyOrExit(log: (m: string) => void = console.error): void {
  if (WRP_POLICIES[POLICY_NAME]) return;
  log(
    `FATAL: EUDI_WRP_POLICY="${POLICY_NAME}" is not a known WRP policy. ` +
      `Known: [${Object.keys(WRP_POLICIES).join(', ')}]. ` +
      `Silently falling back to the default policy would run this instance under the wrong ` +
      `registration — hence the abort.`,
  );
  process.exit(1);
}

/**
 * What this instance may ask for: the ACTIVE policy, optionally narrowed by
 * `EUDI_WRP_NARROW`. Everything downstream reads this and needs no change — the retired
 * set, the wallet-requestable set, the egress gate and the published descriptor all derive
 * from here, so a narrowed instance is narrow everywhere at once.
 *
 * `filter` over `KNOWN_PID_ATTRIBUTES` rather than over the policy: it fixes the canonical
 * ORDER in one place, so neither the policy's spelling nor the operator's spelling of
 * EUDI_WRP_NARROW can change the EUDIPLO config id derived from this list.
 */
export const ALLOWED_PID_ATTRIBUTES: readonly AllowedPidAttribute[] =
  KNOWN_PID_ATTRIBUTES.filter(
    (a) => ACTIVE.attributes.includes(a) && (NARROW.length === 0 || NARROW.includes(a)),
  );

/**
 * Refuse to start on a narrowing that does not fit the selected policy.
 *
 * Three separate refusals, all of them silent failures if they were tolerated:
 *
 *   1. A name outside the policy. Ignoring it would mean the operator believes they
 *      configured an attribute and the instance never asks for it — the mistake would only
 *      surface as "the wallet did not show the field", with nothing pointing at this
 *      variable. Note the asymmetry that makes this safe: an unrecognised name can only
 *      ever be REFUSED here, never granted. There is no path from this variable to a wider
 *      request.
 *   2. An empty intersection. An instance that may ask for nothing can verify nobody; every
 *      call would end in the anonymous direction while the interface still offers
 *      identification.
 *   3. Nothing but derived attributes. `pseudonym_id` alone builds a DCQL query with zero
 *      claims — a wallet prompt that proves nothing (same rule the request path applies in
 *      `assertAllowedAttributes`).
 *
 * Called from the server's startup path, right after `assertPolicyOrExit`.
 */
export function assertNarrowOrExit(log: (m: string) => void = console.error): void {
  if (!NARROW.length) return;
  const policyAttrs = ACTIVE.attributes as readonly string[];
  const unknown = NARROW.filter((a) => !policyAttrs.includes(a));
  if (unknown.length) {
    log(
      `FATAL: EUDI_WRP_NARROW names [${unknown.join(', ')}], which policy ` +
        `'${activePolicyName()}' does not permit. This variable can only narrow, never widen: ` +
        `pick from [${policyAttrs.join(', ')}], or change the policy in src/wrp-policy.ts — ` +
        `which is a code change, a review and a deploy, deliberately.`,
    );
    process.exit(1);
  }
  if (!ALLOWED_PID_ATTRIBUTES.length) {
    log(
      `FATAL: EUDI_WRP_NARROW leaves no attribute at all. An instance that may ask for ` +
        `nothing can verify nobody — unset the variable instead of emptying it.`,
    );
    process.exit(1);
  }
  if (!requiresWalletPresentation(ALLOWED_PID_ATTRIBUTES)) {
    log(
      `FATAL: EUDI_WRP_NARROW leaves only derived attributes ` +
        `[${ALLOWED_PID_ATTRIBUTES.join(', ')}]. Those are computed by this server, not ` +
        `presented by a wallet, so the request would carry no claim and prove nothing. ` +
        `Add at least one of [${ACTIVE.attributes.filter((a) => a !== 'pseudonym_id').join(', ')}].`,
    );
    process.exit(1);
  }
}

/**
 * Attributes this codebase COULD ask for but this deployment's policy does not permit.
 *
 * DERIVED, not written down: known vocabulary minus the active policy. That matters since
 * policies became selectable — a hard-coded list would keep publishing `address` as "given
 * up" on an instance whose registration actually permits it, i.e. the endpoint would lie at
 * exactly the point where it is meant to be checkable.
 *
 * Enforces nothing — the refusal comes from these simply not being in
 * `ALLOWED_PID_ATTRIBUTES`. It earns its place twice over:
 *   - `PolicyViolationError` names them separately, so a caller learns their request was
 *     once valid and is now deliberately gone, instead of reading "not permitted" and
 *     hunting for a typo;
 *   - `policyDescriptor()` publishes them, which turns the allow-list into a FALSIFIABLE
 *     claim: not just "we ask for these four" but "these three we gave up". For an
 *     auditor that documents a data-minimisation decision rather than a mere absence.
 *
 * These are exactly what an ALREADY-SHIPPED client (the TestFlight build, a cached embed)
 * can still put on the wire, which is what the transitional mode below exists for.
 */
export const RETIRED_ATTRIBUTES: readonly AllowedPidAttribute[] = KNOWN_PID_ATTRIBUTES.filter(
  (a) => !ALLOWED_PID_ATTRIBUTES.includes(a),
);

/** Attributes computed by this server rather than presented by a wallet.
 *  MUST be declared before WALLET_REQUESTABLE — that derives from this, and `const` is not
 *  hoisted: the other way round, the module crashes on load. */
export const DERIVED_ATTRIBUTES: readonly AllowedPidAttribute[] = ['pseudonym_id'];

/**
 * Of the allowed attributes, those actually asked of the wallet over OpenID4VP.
 *
 * DERIVED rather than enumerated, ever since policies became selectable: a fixed list would
 * have kept requesting only the original three under a policy with additional attributes —
 * the permission would sit in the policy, the request would stay narrow, and nobody would see
 * the contradiction.
 *
 * `pseudonym_id` drops out here: the ARF PID rulebook (`eu.europa.ec.eudi.pid.1`) knows no
 * such claim, and asking for it would produce a DCQL no wallet can satisfy. It is derived
 * instead — see `pseudonym.ts`.
 */
export const WALLET_REQUESTABLE: readonly AllowedPidAttribute[] = ALLOWED_PID_ATTRIBUTES.filter(
  (a) => !(DERIVED_ATTRIBUTES as readonly string[]).includes(a),
);

/**
 * Purpose binding. ONE purpose, hard-coded: every presentation request this service can
 * emit serves it, which is what makes the whitelist above defensible. The id is the
 * stable key used in the audit log; the text is what the user is shown and what is put
 * into the DCQL `purpose` field for the wallet to display.
 */
export const WRP_PURPOSE_ID = ACTIVE.purposeId;
export const WRP_PURPOSE_TEXT = ACTIVE.purposeText;
/** Shown under the attribute picker; also the wording used on the public pages. */
export const WRP_COMPLIANCE_NOTE = ACTIVE.complianceNote;

/**
 * Enforcement mode for out-of-scope REQUESTS.
 *
 *   off (default, "transitional") — narrow the request to the whitelist, audit the
 *     violation, carry on. Exists because clients are already deployed: the iOS/Android
 *     build in TestFlight still offers birth_date / issuing_country / address, and it does
 *     not understand a `policy_violation` error, so refusing would surface as an opaque
 *     failure with the room config silently not applying. Narrowing keeps those users
 *     working — on less data than they asked for, which is the safe direction.
 *   on ("strict") — refuse with `policy_violation` (HTTP 400 / WS error), the clearest
 *     position for an approval audit. Flip this once the updated app has rolled out.
 *
 * What does NOT change between the modes: the DCQL query sent to the wallet, the claims
 * accepted back, and the audit record. A narrowed request and a refused one both result in
 * zero out-of-scope attributes reaching a wallet — the egress gate in `eudiplo.ts` is hard
 * in both modes. This knob is about how loudly we fail, not about what we ask for.
 *
 * Read per call rather than cached at import: keeps it testable and lets an operator flip
 * it with a restart-free config reload if one is ever added.
 */
export function wrpStrict(): boolean {
  return (process.env.EUDI_WRP_STRICT ?? 'off') === 'on';
}

export function isAllowedPidAttribute(x: unknown): x is AllowedPidAttribute {
  return typeof x === 'string' && (ALLOWED_PID_ATTRIBUTES as readonly string[]).includes(x);
}
export function isWalletRequestable(a: AllowedPidAttribute): boolean {
  return WALLET_REQUESTABLE.includes(a);
}
export function isDerived(a: AllowedPidAttribute): boolean {
  return DERIVED_ATTRIBUTES.includes(a);
}

/**
 * Does this attribute set require a wallet ceremony at all?
 *
 * False for the empty set (the anonymous direction) AND for a set of nothing but derived
 * attributes — `pseudonym_id` alone would build a DCQL query with zero claims, i.e. a
 * wallet prompt that proves nothing. Callers use this instead of `attrs.length === 0` to
 * decide "this participant has nothing to present".
 */
export function requiresWalletPresentation(attrs: readonly AllowedPidAttribute[]): boolean {
  return attrs.some((a) => isWalletRequestable(a));
}

/**
 * A client asked for something outside the whitelist. Carries `status = 400` so HTTP
 * callers can pass it straight through, and `code` so the WebSocket path can send a
 * machine-readable rejection. `rejected` never contains attribute VALUES — only names.
 */
export class PolicyViolationError extends Error {
  readonly status = 400;
  readonly code = 'policy_violation';
  readonly rejected: string[];
  /** Of `rejected`, those that this service USED to support (see RETIRED_ATTRIBUTES). */
  readonly retired: string[];
  constructor(rejected: string[]) {
    // Name the retired attributes separately. "removed with the eIDAS 2.0 scoping" tells a
    // caller their request was once valid and is now deliberately gone — actionable.
    // "not permitted" alone would read like a typo and send someone hunting for the right
    // spelling. This is the whole reason RETIRED_ATTRIBUTES exists as a constant.
    const retired = rejected.filter((r) => (RETIRED_ATTRIBUTES as readonly string[]).includes(r));
    const others = rejected.filter((r) => !retired.includes(r));
    const parts: string[] = [];
    if (retired.length) {
      parts.push(
        `[${retired.join(', ')}] were removed with the eIDAS 2.0 purpose scoping ` +
          `(EU 2024/1183) and are no longer requestable`,
      );
    }
    if (others.length) {
      parts.push(`[${others.join(', ')}] are not permitted for purpose '${WRP_PURPOSE_ID}'`);
    }
    super(`Policy violation: ${parts.join('; ')}. Allowed: [${ALLOWED_PID_ATTRIBUTES.join(', ')}].`);
    this.name = 'PolicyViolationError';
    this.rejected = rejected;
    this.retired = retired;
  }
}

/** Marker appended to a rejected name when the set is structurally incoherent rather
 *  than out of scope — so an audit line says WHY, not just WHAT. */
const NEEDS_WALLET_ATTR = '#requires-a-wallet-attribute';

/**
 * Normalise an allowed set: de-duplicate and return it in canonical (whitelist) order, so
 * the order a client sends cannot change the resulting EUDIPLO config id.
 */
function canonical(attrs: readonly AllowedPidAttribute[]): AllowedPidAttribute[] {
  const set = new Set(attrs);
  return ALLOWED_PID_ATTRIBUTES.filter((a) => set.has(a));
}

/**
 * The strict gate. Throws `PolicyViolationError` on ANY non-whitelisted entry, including
 * retired ones. An empty list is valid and means "request nothing" (anonymous direction).
 *
 * Used directly where refusal is always right (an operator-issued embed token, a test).
 * The request path goes through `resolveAttributes` so the transitional mode applies.
 */
export function assertAllowedAttributes(attrs: unknown): AllowedPidAttribute[] {
  if (attrs == null) return [];
  if (!Array.isArray(attrs)) throw new PolicyViolationError(['<not-an-array>']);
  const rejected = attrs.filter((a) => !isAllowedPidAttribute(a)).map((a) => String(a).slice(0, 64));
  if (rejected.length) throw new PolicyViolationError([...new Set(rejected)]);
  const out = canonical(attrs as AllowedPidAttribute[]);
  // A request of nothing but derived attributes is incoherent: it would show the user a
  // wallet prompt that asks for no claim and proves nothing, while the UI calls the
  // result "verified". pseudonym_id supplements a presentation, it cannot be one.
  if (out.length && !requiresWalletPresentation(out)) {
    throw new PolicyViolationError(out.map((a) => a + NEEDS_WALLET_ATTR));
  }
  return out;
}

/**
 * The non-throwing gate: returns the allowed subset plus what was dropped and why.
 *
 * Two callers need exactly this, for the same reason — something outside our control
 * already carries an out-of-scope attribute and refusing would strand a working session:
 *   - the transitional request path (an already-deployed client), and
 *   - a Pro RoomStore handing back a room PERSISTED before the WRP scoping.
 * The result is always NARROWER than the input, never wider.
 */
export function partitionAttributes(attrs: unknown): {
  allowed: AllowedPidAttribute[];
  rejected: string[];
} {
  const list = Array.isArray(attrs) ? attrs : [];
  const keep: AllowedPidAttribute[] = [];
  const rejected: string[] = [];
  for (const a of list) {
    if (isAllowedPidAttribute(a)) keep.push(a);
    else rejected.push(String(a).slice(0, 64));
  }
  let allowed = canonical(keep);
  // Same coherence rule as the throwing gate, degraded instead of refused: if stripping
  // out-of-scope attributes left nothing but derived ones, fall back to fully anonymous
  // rather than emitting a wallet request with no claims.
  if (allowed.length && !requiresWalletPresentation(allowed)) {
    rejected.push(...allowed.map((a) => a + NEEDS_WALLET_ATTR));
    allowed = [];
  }
  return { allowed, rejected: [...new Set(rejected)] };
}

/**
 * The request path's single entry point: apply the whitelist according to the current
 * enforcement mode.
 *
 * Returns the attributes to use plus `rejected` (names only) whenever something was out
 * of scope — non-empty means the caller MUST audit it, in both modes. In strict mode it
 * throws instead, so a caller that forgets to check `rejected` still cannot apply an
 * out-of-scope config.
 */
export function resolveAttributes(attrs: unknown): {
  allowed: AllowedPidAttribute[];
  rejected: string[];
} {
  if (wrpStrict()) return { allowed: assertAllowedAttributes(attrs), rejected: [] };
  return partitionAttributes(attrs);
}

/** Public, cacheable description of this WRP's policy (served at /capabilities). */
export function policyDescriptor() {
  return {
    policyId: activePolicyName(),
    purposeId: WRP_PURPOSE_ID,
    purposeText: WRP_PURPOSE_TEXT,
    complianceNote: WRP_COMPLIANCE_NOTE,
    allowedAttributes: [...ALLOWED_PID_ATTRIBUTES],
    /**
     * What the REGISTRATION permits, as against what this instance actually asks.
     *
     * Published so the two cannot be confused by a reader, and so a narrowing is
     * falsifiable in the same way `retiredAttributes` makes the whitelist falsifiable: an
     * auditor can see "the registration allows five, this instance asks for two" without
     * access to the deployment. Identical to `allowedAttributes` when EUDI_WRP_NARROW is
     * unset, which is the honest representation of "not narrowed".
     */
    registrationPermits: KNOWN_PID_ATTRIBUTES.filter((a) => ACTIVE.attributes.includes(a)),
    narrowed: wrpNarrowed(),
    walletRequestable: [...WALLET_REQUESTABLE],
    derivedAttributes: [...DERIVED_ATTRIBUTES],
    retiredAttributes: [...RETIRED_ATTRIBUTES],
    regulation: 'EU 2024/1183',
    retention: 'none',
    /** 'strict' refuses an out-of-scope request; 'transitional' narrows it. Either way
     *  nothing outside `allowedAttributes` reaches a wallet — see wrpStrict(). */
    enforcement: wrpStrict() ? 'strict' : 'transitional',
  };
}
