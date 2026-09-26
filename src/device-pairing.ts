// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pairing a phone with a browser participant, so the phone can sign for them (`qes-device`).
 *
 * The signing key lives in the phone's secure element; the participant sits at a browser. A
 * pairing joins the two: the browser asks for a one-time token, shows it as a QR code, the phone
 * (the id-call app) opens it and connects. From then on this server only RELAYS the WebRTC
 * signalling between the two ends — the document itself travels over their own DataChannel,
 * peer to peer, exactly like the document in the call. This server never sees it.
 *
 * What the server does decide, and why it lives here:
 *   - WHO may pair: only a participant verified in this call, over their own connection.
 *   - FOR WHOM the phone acts: the phone has no identity of its own here. Its certificate request
 *     is answered with the names of the participant who created the pairing (see server.ts,
 *     `device-cert-request`). Holding the token is what makes the phone theirs, so the token is
 *     single-use, short-lived, unguessable and never logged.
 *
 * State is in memory, like the rooms: a restart ends every pairing, and the browser simply
 * offers a new QR code.
 */
import { randomBytes } from 'crypto';
import type { WebSocket } from 'ws';
import type { Participant } from './rooms';

/** A token nobody scanned is worthless after this long — the QR code has to be fresh. */
export const PAIR_JOIN_TTL_MS = 5 * 60_000;
/** A joined pairing ends after this long regardless: one signing step, not a standing link. */
export const PAIR_LIFETIME_MS = 30 * 60_000;

export interface Pairing {
  token: string;
  owner: Participant;
  phone?: WebSocket;
  timer: ReturnType<typeof setTimeout>;
}

const byToken = new Map<string, Pairing>();
const byOwner = new Map<Participant, Pairing>();
const byPhone = new Map<WebSocket, Pairing>();

/** A fresh pairing for `owner`, replacing any earlier one of theirs. */
export function createPairing(owner: Participant, onExpire: (p: Pairing) => void): Pairing {
  const previous = byOwner.get(owner);
  if (previous) endPairing(previous);
  const p: Pairing = {
    token: randomBytes(32).toString('base64url'),
    owner,
    timer: setTimeout(() => { if (!p.phone) { endPairing(p); onExpire(p); } }, PAIR_JOIN_TTL_MS),
  };
  byToken.set(p.token, p);
  byOwner.set(owner, p);
  return p;
}

/**
 * The phone presents the token. Single use: the first phone wins, a second presentation of the
 * same token — someone who photographed the QR code over the shoulder — is refused.
 */
export function joinPairing(token: string, phone: WebSocket, onEnd: (p: Pairing) => void): Pairing | undefined {
  const p = byToken.get(token);
  if (!p || p.phone) return undefined;
  byToken.delete(token);
  p.phone = phone;
  byPhone.set(phone, p);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => { endPairing(p); onEnd(p); }, PAIR_LIFETIME_MS);
  return p;
}

export const pairingOfOwner = (owner: Participant): Pairing | undefined => byOwner.get(owner);
export const pairingOfPhone = (phone: WebSocket): Pairing | undefined => byPhone.get(phone);

export function endPairing(p: Pairing): void {
  clearTimeout(p.timer);
  byToken.delete(p.token);
  if (byOwner.get(p.owner) === p) byOwner.delete(p.owner);
  if (p.phone && byPhone.get(p.phone) === p) byPhone.delete(p.phone);
}
