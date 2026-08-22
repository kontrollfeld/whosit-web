// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Ephemeral pairwise pseudonym.
 *
 * `pseudonym_id` gives a peer a stable handle for the person they are talking to WITHOUT
 * learning a name. It is derived here, never requested from the wallet: the ARF PID
 * rulebook (`eu.europa.ec.eudi.pid.1`) defines no `pseudonym_id` claim, so asking for one
 * over OpenID4VP would build a DCQL query no real wallet can satisfy. (The ARF's separate
 * pseudonym attestation is a different credential type and out of scope here.)
 *
 * Construction: HMAC-SHA256(processSalt, roomId ‖ clientId), truncated to 16 hex chars.
 *
 * What this DOES guarantee:
 *   - Pairwise: the same person in a different room gets a different pseudonym, so two
 *     rooms cannot be correlated by comparing pseudonyms.
 *   - Ephemeral: the salt is random per process and never persisted, so a restart makes
 *     every previously issued pseudonym unreproducible. Nothing to hand over, subpoena
 *     or leak — consistent with the zero-retention architecture.
 *   - Stable across a reconnect within the call: `clientId` lives in the browser's
 *     sessionStorage, so the resume path (see rooms.ts) keeps the same pseudonym.
 *
 * What this does NOT guarantee — state it plainly rather than overclaiming:
 *   - It is NOT issuer-bound. It identifies a browser session that passed the PID gate,
 *     not cryptographically the human behind the credential. Two devices of the same
 *     person yield different pseudonyms.
 *   - It is therefore NOT a substitute for an ARF pseudonym attestation, and must not be
 *     used as a long-lived account identifier.
 */
import { createHmac, randomBytes } from 'crypto';

/**
 * Per-process, in-memory salt. Deliberately NOT configurable: a salt in the environment
 * would survive restarts and turn an ephemeral pseudonym into a stable, correlatable id
 * across calls — exactly the property we are avoiding.
 */
const PROCESS_SALT = randomBytes(32);

/** Length in hex chars. 16 → 64 bits, ample against collisions in a single room. */
const ID_LEN = 16;

/**
 * Derive the pseudonym a participant is known by inside ONE room.
 * Same (roomId, clientId) → same value for the lifetime of this process.
 */
export function derivePseudonym(roomId: string, clientId: string): string {
  const h = createHmac('sha256', PROCESS_SALT);
  // Length-prefixed so ('ab','c') and ('a','bc') cannot collide.
  h.update(`${roomId.length}:${roomId}|${clientId.length}:${clientId}`);
  return 'pn_' + h.digest('hex').slice(0, ID_LEN);
}

/**
 * Anonymise an identifier for the audit log — same HMAC, different domain tag so an
 * audit line can never be matched back to a pseudonym shown in a call.
 */
/**
 * `kind` is a domain separator, not a label: the same value under two kinds yields two
 * unrelated hashes, so fields cannot be correlated across a log. `session` was added for the
 * join line — a sessionId is one half of an access credential (the other is the webhook
 * token) and has no business appearing in a log in the clear.
 */
export function auditHash(kind: 'room' | 'subject' | 'session', value: string): string {
  const h = createHmac('sha256', PROCESS_SALT);
  h.update(`audit:${kind}:${value.length}:${value}`);
  return h.digest('hex').slice(0, 12);
}
