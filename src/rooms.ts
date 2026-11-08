// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-memory room state. A room holds up to `maxParticipants` (2 without the
 * `multi-party` capability; with it — the Community default — more — full mesh, see src/rooms.ts + maxParticipants() in src/server.ts). The first to join
 * is the `caller` (host: configures mode + attributes), all others are `callee` guests
 * who present the host-requested PID attributes.
 *
 * Participants are keyed by a stable `clientId` (kept in the browser's
 * sessionStorage) so a brief WebSocket drop — e.g. a phone backgrounding Safari
 * while the wallet app opens — can RESUME the same participant (and its EUDIPLO
 * verifier session + verification result) instead of losing it.
 */
import { randomUUID } from 'crypto';
import type { WebSocket } from 'ws';
import type { SemanticAttr } from './credential-profiles';
import type { Offer } from './eudiplo';
// The one outbound call this in-memory store makes. It belongs here because this is where a
// participant loses their verifier session, and a purge that depends on a caller remembering
// to make it is not a guarantee.
import { purgeVerifierSession } from './verifier-session';

export type Role = 'caller' | 'callee';
export type Mode = 'video' | 'audio' | 'chat';

export interface Participant {
  clientId: string;
  /** Public id used to address signaling messages between peers (mesh routing).
   *  Unlike sessionId (a secret webhook capability), this may be shared with the room. */
  peerId: string;
  role: Role;
  ws: WebSocket;
  sessionId: string;
  webhookToken: string;  // unguessable secret embedded in the EUDIPLO webhook URL
  verified: boolean;     // has presented their required attrs (true if nothing to present)
  confirmed: boolean;    // has accepted the pre-connect review
  givenName?: string;
  familyName?: string;
  claims?: Record<string, any>; // PID claims this participant presented
  offer?: Offer;
  /** EUDIPLO's session id for the CURRENT offer — the handle used to delete the session
   *  (and the claims it holds) at the verifier as soon as it is no longer needed. Kept next to the
   *  offer rather than inside it because an offer is replaced on every retry while the old
   *  session still has to be purged. See ./verifier-session. */
  verifierSessionId?: string;
  /** DTLS fingerprint of the certificate this participant WILL use for the WebRTC
   *  connection — generated and reported by the client before joining, so it still fits into
   *  the wallet request. Absent for clients without channel binding. */
  dtlsFingerprint?: string;
  /** Was `transaction_data` sent along with the pending offer? A marker between offer and
   *  webhook — only then may a successful presentation count as bound. */
  pendingBinding?: boolean;
  /** Was this participant's presentation actually bound to the fingerprint? True only when
   *  `transaction_data` WAS sent and verification then succeeded — EUDIPLO fails a
   *  presentation whose hash does not match, so a "verified" with the binding sent IS the
   *  proof. See ./channel-binding. */
  channelBound?: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
  /** Set when the participant is removed from the room for good. An offer created for them while
   *  an `await` was pending is then purged at once instead of being stored on someone gone. */
  left?: boolean;
  /** When this participant last asked for a fresh wallet offer (renew-auth is throttled). */
  renewedAt?: number;
  /** Counts the offers asked for this participant. Only the latest one asked for is kept: an
   *  older one that comes back later would replace it with a request for an outdated set of
   *  attributes. See ensureAuthOffer in ./server. */
  offerSeq?: number;
  /** In-call catalog credentials this participant presented DURING the call (Pro).
   *  Values are relayed ONLY to the requester (`forPeerId`) — never room-broadcast.
   *  Kept on the participant so a reconnect/resume re-renders the requester's badges. */
  presentedCredentials?: Array<{
    credentialId: string;
    label: string;
    forPeerId: string;                 // the requester allowed to see the values
    claims: Array<{ name: string; value: any }>;
    at: string;                        // ISO-8601
  }>;
}

export interface Room {
  id: string;
  participants: Participant[];
  mode: Mode;              // video | audio | chat (set by the host)
  requestedAttrs: SemanticAttr[]; // attributes the host requests FROM every guest
  disclosedAttrs: SemanticAttr[]; // attributes the host SHARES about themselves
  /** Set once the call started ('ready' sent): no further joins (no late-join in v1). */
  locked: boolean;
  /** Multi-party only: the host pressed "start", so the room stops accepting joins and
   *  the pre-connect review begins. 1:1 rooms connect automatically and never set this. */
  starting: boolean;
  /** Set up from a signed invitation (scheduled call, see ./invite-token): mode and both
   *  attribute directions are fixed and can NO LONGER be changed — not even by the host. The
   *  guest agreed to exactly this arrangement when accepting the invitation; moving it
   *  afterwards would void that consent. */
  configPinned?: boolean;
  /** Open multi-party room (host opt-in): connect as soon as ≥2 are verified+confirmed,
   *  never lock, allow late-join up to maxParticipants. Every guest shares the SAME
   *  attributes, so a late-joiner introduces no new consent surface. */
  openRoom: boolean;
  /** Pairs the server itself told to connect ('ready'), as "peerIdA|peerIdB" (sorted). Signaling
   *  (offer/answer/ice) is relayed only within these — the gate is the server's, not only the
   *  page's. See linkPair / isLinked. */
  links?: Set<string>;
}

/** Before the call starts, an agreement is to the people who were in the room when it was given.
 *  When that changes — someone leaves, someone new takes a seat — every agreement so far is taken
 *  back and each has to agree again, having seen who is there now (audit #10, 2026-11-05). Not in
 *  an open room: there every guest shares the same attributes and late-join is the point; and not
 *  once the call runs (locked): no new person gets in then. */
export function withdrawConsents(room: Room): void {
  if (room.locked || room.openRoom) return;
  for (const p of room.participants) p.confirmed = false;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
export function linkPair(room: Room, a: Participant, b: Participant): void {
  (room.links ??= new Set()).add(pairKey(a.peerId, b.peerId));
}
export function isLinked(room: Room, a: Participant, b: Participant): boolean {
  return room.links?.has(pairKey(a.peerId, b.peerId)) === true;
}

const rooms = new Map<string, Room>();

/** Reset everything that IDENTIFIES a person. When a seat is reclaimed via the invitation, a
 *  DIFFERENT human may be at the other end — they must not inherit their predecessor's
 *  verification, or the far side would be shown someone else's ID data as theirs. They have to
 *  verify again; only the seat carries over. */
function resetIdentity(p: Participant): void {
  p.verified = false;
  p.confirmed = false;
  p.channelBound = false;
  p.pendingBinding = undefined;
  p.claims = undefined;
  p.givenName = undefined;
  p.familyName = undefined;
  p.offer = undefined;
  p.dtlsFingerprint = undefined;
  p.presentedCredentials = undefined;
  // The predecessor's session at the verifier still holds their claims — dropping the id
  // here without deleting it would leave exactly the record this architecture promises not
  // to keep, and nobody would ever ask for it again.
  purgeVerifierSession(p.verifierSessionId, 'left');
  p.verifierSessionId = undefined;
  p.sessionId = randomUUID();      // the old verifier session must not continue
  p.webhookToken = randomUUID();
}

export function joinRoom(
  roomId: string,
  ws: WebSocket,
  clientId: string,
  maxParticipants = 2,
  opts: { reclaimRole?: Role; arrival?: 'creator' | 'invited'; groupOnlyIfOpen?: boolean } = {},
): { room: Room; participant: Participant; resumed: boolean; replaced?: WebSocket; reclaimed?: boolean } | { error: 'full' } {
  let room = rooms.get(roomId);
  if (!room) {
    // Default: BOTH directions share the family name (host discloses, guest presents) —
    // a verified call is the product's point, so verified-by-default on both sides.
    // The host can still switch either direction to anonymous in the setup.
    room = { id: roomId, participants: [], mode: 'video', requestedAttrs: ['family_name'], disclosedAttrs: ['family_name'], locked: false, starting: false, openRoom: false };
    rooms.set(roomId, room);
  }
  // A private call stays private: more than two only once the host made it a group call.
  if (opts.groupOnlyIfOpen && !room.openRoom) maxParticipants = Math.min(maxParticipants, 2);

  // Resume: same clientId reconnecting → re-attach to the existing participant,
  // keeping its role, EUDIPLO session and verification state. Allowed even when
  // the room is locked (that's the point of the grace window).
  const existing = room.participants.find((p) => p.clientId === clientId);
  if (existing) {
    // If an OPEN socket was still attached, the join comes from a second tab of the same
    // person. The old tab is superseded and must learn of it (see `replaced`).
    const replaced = existing.ws && existing.ws.readyState === 1 && existing.ws !== ws ? existing.ws : undefined;
    existing.ws = ws;
    if (existing.graceTimer) {
      clearTimeout(existing.graceTimer);
      existing.graceTimer = undefined;
    }
    return { room, participant: existing, resumed: true, replaced };
  }

  // The invitation IS the role: it is named in the signed token, so the seat belongs to that
  // role — not to whichever browser tab happened to arrive first. Someone whose tab is gone
  // therefore returns through the same link, even mid-call.
  //
  // The seat is TAKEN OVER even when the old session still counts as connected. Refusing
  // it would stop a forwarded link from throwing out the active far side, but it would also
  // lock the host out of their OWN appointment: a stalled session stays "open" for up to a
  // minute, and re-entering — the one gesture that otherwise fixes everything — would be
  // blocked.
  //
  // Whoever holds the token is entitled to that role; that is the link's promise, and a
  // stalled session must not override it. The old session is superseded cleanly (`replaced` →
  // it learns of this and stops reconnecting), just as with a second tab. Identity is reset in
  // the process: a different human may be at the other end, and they must not inherit their
  // predecessor's verification.
  if (opts.reclaimRole) {
    const holder = room.participants.find((p) => p.role === opts.reclaimRole);
    if (holder) {
      const replaced = holder.ws && holder.ws.readyState === 1 && holder.ws !== ws ? holder.ws : undefined;
      if (holder.graceTimer) { clearTimeout(holder.graceTimer); holder.graceTimer = undefined; }
      holder.clientId = clientId;
      holder.ws = ws;
      resetIdentity(holder);
      withdrawConsents(room);
      return { room, participant: holder, resumed: false, reclaimed: true, replaced };
    }
    // No placeholder left (grace period elapsed): creating a new one is correct — and
    // `locked` must not prevent it, because this very person WAS invited.
    if (room.participants.length < maxParticipants) {
      const p = newParticipant(clientId, ws, opts.reclaimRole);
      withdrawConsents(room);
      room.participants.push(p);
      return { room, participant: p, resumed: false, reclaimed: true };
    }
    return { error: 'full' };
  }

  if (room.locked) return { error: 'full' }; // call started → no late-join (v1)

  if (room.participants.length >= maxParticipants) {
    // Evict a disconnected "ghost" still lingering in its grace window so a fresh
    // person can take the slot instead of being wrongly told the room is full.
    const ghost = room.participants.find((p) => !p.ws || p.ws.readyState !== 1);
    if (ghost) {
      if (ghost.graceTimer) clearTimeout(ghost.graceTimer);
      ghost.left = true;
      room.participants.splice(room.participants.indexOf(ghost), 1);
    } else {
      return { error: 'full' };
    }
  }

  // First/only caller-less slot becomes the caller (host), everyone else a guest — except for
  // someone who followed a link (see JoinOptions.arrival): they are a guest even in an empty room.
  const role: Role = opts.arrival === 'invited' || room.participants.some((p) => p.role === 'caller') ? 'callee' : 'caller';
  const participant = newParticipant(clientId, ws, role);
  withdrawConsents(room);
  room.participants.push(participant);
  return { room, participant, resumed: false };
}

function newParticipant(clientId: string, ws: WebSocket, role: Role): Participant {
  return {
    clientId, peerId: randomUUID(), role, ws,
    sessionId: randomUUID(), webhookToken: randomUUID(),
    verified: false, confirmed: false,
  };
}

/** All OTHER participants in the room (mesh peers of `p`). */
export function peersOf(room: Room, p: Participant): Participant[] {
  return room.participants.filter((x) => x !== p);
}

/** Back-compat convenience for 1:1 paths: the single other participant, if any. */
export function peerOf(room: Room, p: Participant): Participant | undefined {
  return peersOf(room, p)[0];
}

export function findByPeerId(room: Room, peerId: string): Participant | undefined {
  return room.participants.find((p) => p.peerId === peerId);
}

export function findBySession(sessionId: string): { room: Room; participant: Participant } | undefined {
  for (const room of rooms.values()) {
    const participant = room.participants.find((p) => p.sessionId === sessionId);
    if (participant) return { room, participant };
  }
  return undefined;
}

export function findByWs(ws: WebSocket): { room: Room; participant: Participant } | undefined {
  for (const room of rooms.values()) {
    const participant = room.participants.find((p) => p.ws === ws);
    if (participant) return { room, participant };
  }
  return undefined;
}

/**
 * How many rooms this process is holding — i.e. how much a restart would destroy.
 *
 * Counts every room still in the map, including one whose participants are inside their
 * reconnect grace window. That is the conservative reading and the right one for the only
 * caller (`GET /health`, read by the rollout): a room in grace is a call someone still expects
 * to come back to, and restarting takes it away just the same.
 *
 * A room is removed from the map as soon as its last participant leaves (see below), so this
 * needs no sweep of its own.
 */
export function hasRoom(roomId: string): boolean {
  return rooms.has(roomId);
}
export function activeRoomCount(): number {
  return rooms.size;
}
/**
 * Rooms with a CALL in them: two people or more, counting those inside their reconnect grace.
 * A host alone in a room waiting for a guest is not one — counted as one, a tab left open kept an
 * instance "busy" for two days and an update waiting with it (2026-11-08). Restarting still ends
 * that wait; the host's page reconnects to a fresh room and the guest's link still leads there.
 */
export function activeCallCount(): number {
  let n = 0;
  for (const r of rooms.values()) if (r.participants.length >= 2) n++;
  return n;
}

export function removeParticipant(room: Room, participant: Participant): void {
  const i = room.participants.indexOf(participant);
  participant.left = true;
  if (i >= 0) {
    room.participants.splice(i, 1);
    withdrawConsents(room);
    if (room.participants.length === 0) rooms.delete(room.id);
  }
}
