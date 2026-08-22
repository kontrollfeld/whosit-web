// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-call credential request registry (Pro) — the state machine behind a "Nachforderung"
 * (see src/credential-requests.ts):
 *
 *   pending → accepted → presented | declined | failed | expired | cancelled
 *
 * Each request gets its own EUDIPLO session (sessionId + webhookToken), exactly the
 * security pattern of the pre-connect PID gate. State is in-memory and bounded: every
 * request carries a TTL timer that always fires, and terminal requests are dropped from
 * the registry immediately — so the maps can never grow past the open-request set.
 */
import { randomUUID } from 'crypto';
import type { Room, Participant } from './rooms';
import type { CatalogCredential } from './credential-catalog';
import type { Offer } from './eudiplo';

export type CredentialRequestStatus =
  | 'pending' | 'accepted'
  | 'presented' | 'declined' | 'failed' | 'expired' | 'cancelled';

const TERMINAL: ReadonlySet<CredentialRequestStatus> =
  new Set(['presented', 'declined', 'failed', 'expired', 'cancelled']);

export interface CredentialRequest {
  requestId: string;
  credential: CatalogCredential;
  room: Room;
  requester: Participant; // the host (caller) — the only party that ever sees the values
  target: Participant;    // the participant asked to present
  status: CredentialRequestStatus;
  sessionId: string;      // fresh EUDIPLO session, NOT the participant's gate session
  webhookToken: string;   // unguessable secret embedded in the webhook URL
  offer?: Offer;
  timer: ReturnType<typeof setTimeout>;
}

const bySession = new Map<string, CredentialRequest>();
const byId = new Map<string, CredentialRequest>();

export function createRequest(
  room: Room,
  requester: Participant,
  target: Participant,
  credential: CatalogCredential,
  ttlMs: number,
  onExpire: (r: CredentialRequest) => void,
): CredentialRequest {
  const r: CredentialRequest = {
    requestId: randomUUID(),
    credential, room, requester, target,
    status: 'pending',
    sessionId: randomUUID(),
    webhookToken: randomUUID(),
    timer: setTimeout(() => {
      if (TERMINAL.has(r.status)) return; // finished in time — timer is a no-op
      finishRequest(r, 'expired');
      onExpire(r);
    }, ttlMs),
  };
  bySession.set(r.sessionId, r);
  byId.set(r.requestId, r);
  return r;
}

export function requestBySession(sessionId: string): CredentialRequest | undefined {
  return bySession.get(sessionId);
}

export function requestById(requestId: string): CredentialRequest | undefined {
  return byId.get(requestId);
}

/** An open (non-terminal) request for the same credential to the same target? */
export function hasPending(target: Participant, credentialId: string): boolean {
  for (const r of byId.values()) {
    if (r.target === target && r.credential.id === credentialId && !TERMINAL.has(r.status)) return true;
  }
  return false;
}

/** All open requests a participant is involved in (as requester or target). */
export function openRequestsInvolving(p: Participant): CredentialRequest[] {
  return [...byId.values()].filter((r) => !TERMINAL.has(r.status) && (r.requester === p || r.target === p));
}

/** Move a request to a terminal state: stop the timer, drop it from the registry. */
export function finishRequest(r: CredentialRequest, status: CredentialRequestStatus): void {
  r.status = status;
  clearTimeout(r.timer);
  bySession.delete(r.sessionId);
  byId.delete(r.requestId);
}
