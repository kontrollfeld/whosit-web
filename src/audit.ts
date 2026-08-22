// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Compliance audit log — anonymised metadata only, in EVERY edition.
 *
 * Two things are deliberately separated:
 *
 *   - THIS module (Community, always on) is the *accountability* record an approved WRP
 *     needs: for each verification attempt, WHEN it happened, under WHICH purpose, WHICH
 *     attribute TYPES were requested, which claim KEYS came back, and whether it
 *     succeeded. It writes to stdout as one JSON line per event and to nothing else —
 *     no database, no file, no PII. A compliance guarantee that only holds in the paid
 *     edition is not a guarantee, which is why this is not Pro-gated.
 *
 *   - The Pro `verificationSink` (`audit-trail` feature, see core/ports.ts) is the
 *     *retainable, queryable* trail on top: same events, persisted and exportable.
 *     `recordAudit` forwards to it when a Pro extension is loaded.
 *
 * Zero-retention invariants enforced here:
 *   1. No attribute VALUES ever enter an entry — only names/keys. `sanitizeKeys` clamps
 *      the shape so a future caller cannot easily smuggle a value through a "keys" field.
 *   2. Room and participant identifiers are HMAC-hashed with the per-process salt
 *      (`pseudonym.auditHash`), so log lines are unlinkable after a restart and cannot be
 *      joined back to a person or to a pseudonym shown in a call.
 *   3. stdout only. If an operator ships stdout to a log store, what lands there is
 *      already anonymised — the decision cannot leak PID data.
 */
import { auditHash } from './pseudonym';
import { WRP_PURPOSE_ID } from './wrp-policy';
import type { Role, VerificationEvent, VerificationEventType } from './core/ports';

/**
 * Audit event vocabulary. A superset of the Pro sink's `VerificationEventType`: the
 * extra, Community-only entries (`policy-violation`, `consent-granted`,
 * `consent-declined`) are logged locally but NOT forwarded, so the Pro port contract
 * stays exactly as published.
 */
export type AuditEventType =
  | VerificationEventType
  | 'policy-violation'
  | 'consent-granted'
  | 'consent-declined'
  /** A tenant instance's host gate refused someone (see ../host-gate).
   *  Deliberately its own event type: someone who WANTED to act on an authority's behalf belongs
   *  Recorded traceably — but without a name, only as an event: a refusal must not become the
 *  one place where PID values suddenly appear in the log. */
  | 'host-denied';

export type AuditStatus = 'success' | 'failure' | 'rejected' | 'narrowed' | 'pending' | 'refused';

export interface AuditInput {
  event: AuditEventType;
  /** Raw room id — hashed before it is written. */
  roomId: string;
  /** Raw participant clientId — hashed before it is written. Optional for room events. */
  clientId?: string;
  role?: Role;
  /** Attribute TYPES requested (names only). */
  attrs?: readonly string[];
  /** Claim KEYS actually presented (names only, never values). */
  claimKeys?: readonly string[];
  status: AuditStatus;
  /** Credential format actually presented, e.g. `mso_mdoc` / `dc+sd-jwt`, plus the profile
   *  id. For evidence purposes: which trust path applied in this session? No PII —
   *  a format designation says nothing about the person. Absent when it cannot be determined. */
  credentialFormat?: string;
  profileId?: string;
  /** Policy violations: the attribute names that were refused or dropped. */
  rejected?: readonly string[];
  /** In-call credential requests (Pro): catalog credential id + requesting host. */
  credentialId?: string;
  requestedByClientId?: string;
}

/** What actually gets written. No field here can hold an attribute value. */
export interface AuditEntry {
  at: string;
  purposeId: string;
  event: AuditEventType;
  status: AuditStatus;
  room: string;              // HMAC, 12 hex
  subject?: string;          // HMAC, 12 hex
  role?: Role;
  attrs: string[];
  claimKeys: string[];
  credentialFormat?: string;
  profileId?: string;
  rejected?: string[];
  credentialId?: string;
  requestedBy?: string;      // HMAC, 12 hex
}

const STDOUT_ON = (process.env.EUDI_AUDIT_STDOUT ?? 'on') !== 'off';

/**
 * Keep only identifier-shaped strings, bounded in count and length. This is a
 * belt-and-braces check on top of the real guarantee (callers pass `Object.keys(...)`,
 * never values): if a claim VALUE ever reached this function it must not be written.
 *
 * Two rules do the work:
 *   - no spaces or free-text punctuation → drops names, addresses, sentences;
 *   - must START WITH A LETTER → drops dates, postcodes, numbers, which a character
 *     class alone would have let through ('1964-08-12' is identifier-shaped).
 * Every real claim key satisfies both: `given_name`, `age_over_18`, `pseudonym_id`,
 * `de.wohnraum.1.tenant_id`, `mso_mdoc:…#intent_to_retain`.
 *
 * Its limit, stated rather than papered over: a short alphabetic token ('DE', 'true') is
 * shape-indistinguishable from a claim key, so this filter cannot catch one. No regex can.
 * That is why it is the SECOND line of defence and not the guarantee — the guarantee is
 * that call sites pass key sets (`Object.keys(claims)`), which is worth checking in review
 * whenever a new `recordAudit` call is added.
 */
function sanitizeKeys(list: readonly string[] | undefined): string[] {
  if (!list) return [];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!s || s.length > 64) continue;
    // `#` is allowed because the policy layer appends reason markers to a rejected name
    // (`pseudonym_id#requires-a-wallet-attribute`, `<path>#intent_to_retain`), and losing
    // those would strip the reason out of exactly the entries that need it.
    if (!/^[A-Za-z][A-Za-z0-9_.:#-]*$/.test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= 32) break;
  }
  return out;
}

/** Which of our event types the Pro sink's published union accepts. */
const SINK_TYPES: ReadonlySet<string> = new Set<VerificationEventType>([
  'verified', 'verification-failed',
  'credential-requested', 'credential-presented', 'credential-declined',
  'credential-failed', 'credential-expired', 'credential-cancelled',
]);

type Forwarder = (ev: VerificationEvent) => void;
let forward: Forwarder | null = null;

/**
 * Wire the Pro verification sink in. Called once at startup by the server after
 * `loadExtensions()` resolves, so the core never imports Pro code.
 */
export function setAuditForwarder(fn: Forwarder | null): void {
  forward = fn;
}

export function buildAuditEntry(input: AuditInput): AuditEntry {
  const entry: AuditEntry = {
    at: new Date().toISOString(),
    purposeId: WRP_PURPOSE_ID,
    event: input.event,
    status: input.status,
    room: auditHash('room', input.roomId),
    attrs: sanitizeKeys(input.attrs),
    claimKeys: sanitizeKeys(input.claimKeys),
  };
  if (input.clientId) entry.subject = auditHash('subject', input.clientId);
  if (input.role) entry.role = input.role;
  // Passed through sanitizeKeys like the claim names: formats are identifiers
  // (`mso_mdoc`, `dc+sd-jwt`, `pid_mdoc`) and must not smuggle in free text.
  // Exception: the `+` in `dc+sd-jwt` — hence normalised before the check.
  const fmt = sanitizeKeys([String(input.credentialFormat ?? '').replace(/\+/g, '-')])[0];
  if (fmt) entry.credentialFormat = fmt;
  const pid = sanitizeKeys([input.profileId ?? ''])[0];
  if (pid) entry.profileId = pid;
  const rejected = sanitizeKeys(input.rejected);
  if (rejected.length) entry.rejected = rejected;
  if (input.credentialId) entry.credentialId = input.credentialId;
  if (input.requestedByClientId) entry.requestedBy = auditHash('subject', input.requestedByClientId);
  return entry;
}

/**
 * Record one audit event. Never throws: an audit failure must not break signaling
 * (the event is already reflected in the WS state the participants see).
 */
export function recordAudit(input: AuditInput): void {
  let entry: AuditEntry;
  try {
    entry = buildAuditEntry(input);
  } catch (e: any) {
    console.warn('[audit] could not build entry:', e?.message || e);
    return;
  }

  if (STDOUT_ON) {
    // One JSON line per event — greppable, shippable, and free of PII by construction.
    try { console.log('[audit] ' + JSON.stringify(entry)); }
    catch (e: any) { console.warn('[audit] serialize failed:', e?.message || e); }
  }

  // Forward to the Pro trail, but only the event types its published contract declares.
  if (forward && SINK_TYPES.has(input.event)) {
    try {
      forward({
        type: input.event as VerificationEventType,
        at: entry.at,
        // The sink is a Pro extension inside the same trust boundary and its own docs
        // promise a retainable trail, so it receives the REAL room/client ids (it needs
        // them to correlate); values still never leave this process.
        roomId: input.roomId,
        role: input.role ?? 'callee',
        clientId: input.clientId ?? '',
        attrs: entry.attrs,
        claimKeys: entry.claimKeys,
        purposeId: WRP_PURPOSE_ID,
        ...(input.credentialId ? { credentialId: input.credentialId } : {}),
        ...(input.requestedByClientId ? { requestedBy: input.requestedByClientId } : {}),
      });
    } catch (e: any) {
      console.warn('[audit] sink failed:', e?.message || e);
    }
  }
}
