// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Immediate purge of the verifier session at EUDIPLO.
 *
 * WHY THIS EXISTS. EUDIPLO keeps the result of a presentation — the disclosed PID claims —
 * in a session row of its own, so that a relying party can poll for it. This service never
 * polls: EUDIPLO pushes the result to its webhook (see `eudiplo.createVerifierOffer`). From the
 * moment that webhook has been processed, the row serves nobody but an attacker. It is the
 * ONLY place in this architecture where PID values outlive a single request — everything on
 * this service's side lives in process memory (see ./rooms) and the audit trail is PII-free by
 * construction (see ./audit).
 *
 * As of EUDIPLO 8.0.2, unchanged in 9.1 (apps/backend/src/session/):
 *   - the claims sit in `Session.credentials`, encrypted at rest with AES-256-GCM
 *     (`EncryptedJsonTransformer`, key derived from MASTER_SECRET unless a KMS is
 *     configured). That makes a stolen database dump unreadable — and does nothing against
 *     a compromised verifier, which holds the key. Encryption is therefore not an answer to
 *     the question this module answers.
 *   - without an explicit delete the row is removed only by a TIME-BASED sweep:
 *     `SESSION_TTL` (default 24 h) plus `SESSION_TIDY_UP_INTERVAL` (default 1 h). There is
 *     no on-completion hook, and no in-memory storage backend — the only two database types
 *     EUDIPLO supports are PostgreSQL and a file-backed SQLite.
 *   - `DELETE /api/session/:id` is a hard delete, scoped to the tenant, cascading to the
 *     session's log entries. The token already held for creating offers carries the role
 *     it requires (`presentation:request`).
 *
 * So the retention window is this service's to choose, and it chooses "as soon as the result
 * has been consumed".
 *
 * FIRE AND FORGET, deliberately. A failed purge must never fail a verification: the person
 * in front of the camera has done nothing wrong, and refusing the call would not delete
 * anything either. A failure is logged loudly and the instance's own TTL remains the safety
 * net. This is why every function here returns `void` and swallows its errors.
 *
 * NEVER LOGS A SESSION ID IN THE CLEAR. A verifier session id is one half of an access
 * credential; the log shows the same salted short hash the join line uses (`auditHash`).
 */
import { deleteVerifierSession } from './eudiplo';
import { auditHash } from './pseudonym';

/**
 * Why a session is being abandoned. Appears in the log line and nowhere else — but it is
 * what makes the line worth reading: a stream of `left` says people hang up before
 * presenting, a stream of `failed` says presentations are breaking.
 */
export type PurgeReason =
  | 'verified'            // presentation succeeded, result consumed from the webhook payload
  | 'failed'              // presentation failed; a fresh offer (and session) follows
  | 'reissued'            // a new offer replaces an older one for the same participant
  | 'left'                // participant gone (hang-up, grace expiry, seat reclaimed, refused)
  | 'credential-request'; // in-call credential request reached a terminal state

/**
 * Ids already handed to EUDIPLO for deletion.
 *
 * Several paths legitimately purge the same session — the webhook marks it done, the
 * participant then leaves — and a second DELETE would be answered with 204 just the same,
 * since EUDIPLO does not check existence. The set is not about correctness but about not
 * generating traffic and log lines for work already done. Bounded, because it must not
 * become the memory leak in a module whose whole purpose is not keeping things.
 */
const RECENT_LIMIT = 500;
const recentlyPurged = new Set<string>();

/**
 * Delete a verifier session at EUDIPLO — now, not when its TTL runs out.
 *
 * Tolerates `undefined` so callers do not have to branch: an instance running against the
 * EUDIPLO dummy, or an offer from a version that did not report its session id, simply has
 * nothing to purge.
 */
export function purgeVerifierSession(sessionId: string | undefined, reason: PurgeReason): void {
  if (!sessionId) return;
  if (recentlyPurged.has(sessionId)) return;
  remember(sessionId);
  attempt(sessionId, reason, 0);
}

function remember(sessionId: string): void {
  recentlyPurged.add(sessionId);
  if (recentlyPurged.size > RECENT_LIMIT) {
    const oldest = recentlyPurged.values().next().value;
    if (oldest !== undefined) recentlyPurged.delete(oldest);
  }
}

/**
 * Retries after a failure that may pass: no answer, 5xx, 429. Until 2026-11-05 a failed purge was
 * logged and marked done, so the claims stayed at the verifier until its TTL even when the verifier
 * was only briefly away (audit #8). Three more tries — after 30 s, 2 min and 8 min by default
 * (EUDI_PURGE_RETRY_MS sets the first; tests make it short) — and at most RETRY_LIMIT waiting at
 * once, so a verifier that is down for good does not grow a queue here. A refusal (401/403/400)
 * is not retried: the same request would be refused again, and the log says what to fix.
 */
const RETRY_BASE_MS = Math.max(50, Number(process.env.EUDI_PURGE_RETRY_MS || 30_000));
const RETRIES = 3;
const RETRY_LIMIT = 200;
let waiting = 0;
const transient = (e: any): boolean => !e?.status || e.status >= 500 || e.status === 429;

function attempt(sessionId: string, reason: PurgeReason, n: number): void {
  const tag = auditHash('session', sessionId);
  void deleteVerifierSession(sessionId).then(
    () => console.log(`[eudiplo] verifier session purged ${tag} (${reason})${n ? ` on retry ${n}` : ''}`),
    (e: any) => {
      const retry = transient(e) && n < RETRIES && waiting < RETRY_LIMIT;
      // Loud, because the promise of this architecture is on the line: the claims are then
      // still at the verifier until its TTL sweep removes them — unless a retry succeeds.
      console.warn(
        `[eudiplo] PURGE FAILED for verifier session ${tag} (${reason}): ` +
        `${e?.status ? `HTTP ${e.status} ` : ''}${e?.message || e}. ` +
        (retry
          ? `Trying again in ${Math.round((RETRY_BASE_MS * 4 ** n) / 1000)} s.`
          : 'The presented claims stay at the verifier until its own SESSION_TTL sweep removes them.'),
      );
      if (!retry) return;
      waiting++;
      setTimeout(() => { waiting--; attempt(sessionId, reason, n + 1); }, RETRY_BASE_MS * 4 ** n).unref();
    },
  );
}
