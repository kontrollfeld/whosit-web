// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signed invitations for SCHEDULED calls.
 *
 * WHY THIS IS NEEDED. Rooms live purely in process memory and vanish once the last
 * participant leaves (see ./rooms). A shared link used to carry only the room id — neither the
 * role nor the configuration. At appointment time it therefore produced a FRESH room with
 * default settings, and whoever arrived first became host. An asymmetric arrangement ("I
 * disclose my given name, you show your family name") could not be delivered at all: it lived
 * only in the inviter's open tab.
 *
 * SOLUTION. The invitation carries the arrangement itself, HMAC-signed: room, role, mode, both
 * attribute directions, time window. No server state, no database, survives restart and
 * deployment. Modelled on the embed token (scripts/embed-token.mjs) — with one decisive
 * difference: there the payload is a HINT for the client, here it is ENFORCED by the server.
 * The guest must not be able to alter the arrangement they agreed to.
 *
 * WHY THE MARKER SITS IN THE ROOM ID. The payload is readable (signed, not encrypted), so the
 * room id inside it is known. Without a further rule one could strip the `&inv=`, join with a
 * bare `?room=<id>` and become host again by arriving first. A scheduled room's id therefore
 * carries a prefix, and for such rooms the server requires a valid invitation without
 * exception. That is verifiable statelessly and independent of who arrives first.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { Mode } from './rooms';
import type { SemanticAttr } from './credential-profiles';

const SECRET = (process.env.EUDI_INVITE_SECRET || '').trim();

/** No secret, no scheduled calls — the capability then stays off (see server.ts). */
export function inviteConfigured(): boolean {
  return SECRET.length > 0;
}

/** Rooms with this prefix can ONLY be entered with a valid invitation. */
const PLANNED_PREFIX = 'p-';

export function isPlannedRoomId(id: string): boolean {
  return id.startsWith(PLANNED_PREFIX);
}

/** 'p-' + 32 hex characters — fits the server's room-id rule ([A-Za-z0-9_-]{8,64}). */
export function newPlannedRoomId(): string {
  return PLANNED_PREFIX + randomUUID().replace(/-/g, '');
}

export interface InvitePayload {
  v: 1;
  room: string;
  role: 'host' | 'guest';
  m: Mode;
  /** What the GUEST presents. */
  r: SemanticAttr[];
  /** What the HOST discloses about themselves. */
  d: SemanticAttr[];
  /** Gültig ab / bis, Sekunden seit Epoche. */
  nbf: number;
  exp: number;
}

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signInvite(payload: InvitePayload): string {
  if (!SECRET) throw new Error('EUDI_INVITE_SECRET is not set');
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${b64url(createHmac('sha256', SECRET).update(body).digest())}`;
}

/** Host and guest invitation for the SAME room — identical arrangement, different role. */
export function mintInvitePair(cfg: Omit<InvitePayload, 'v' | 'role'>): {
  hostToken: string;
  guestToken: string;
} {
  return {
    hostToken: signInvite({ v: 1, role: 'host', ...cfg }),
    guestToken: signInvite({ v: 1, role: 'guest', ...cfg }),
  };
}

export type InviteReason =
  | 'unconfigured'   // the instance cannot verify invitations (no secret)
  | 'malformed'      // absent, wrong format, not JSON
  | 'signature'      // not signed by this instance (or altered)
  | 'version'        // unknown payload version
  | 'room-mismatch'  // the invitation is for a different room
  | 'too-early'      // the appointment is still in the future
  | 'expired';       // the appointment is over

export type InviteResult =
  | { ok: true; payload: InvitePayload }
  /** `opensAt` = `nbf`, i.e. when the link BECOMES usable — not the appointment time, which
   *  is `INVITE_LEAD_S` later. The field was called `startsAt` until 2026-08-11; that name is
   *  what made the confusion possible — the waiting screen announced the lead time as the
   *  start. */
  | { ok: false; reason: InviteReason; opensAt?: number };

/** Do not even hash absurdly long input (log and memory hygiene). */
const MAX_TOKEN_LEN = 4096;

/**
 * Verify signature, version and time window. The order is deliberate: signature first, content
 * second — nothing is decided from an unsigned payload, not even the error message.
 *
 * For a JOIN this is NOT ENOUGH: there the invitation must also apply to exactly the requested
 * room, otherwise any valid token would open every scheduled room. Use verifyInviteForRoom()
 * for that.
 */
export function verifyInvite(tok: unknown): InviteResult {
  if (!SECRET) return { ok: false, reason: 'unconfigured' };
  if (typeof tok !== 'string' || !tok || tok.length > MAX_TOKEN_LEN) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = tok.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };

  const expected = createHmac('sha256', SECRET).update(parts[0]).digest();
  let sig: Buffer;
  try { sig = fromB64url(parts[1]); } catch { return { ok: false, reason: 'malformed' }; }
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return { ok: false, reason: 'signature' };
  }

  let payload: InvitePayload;
  try { payload = JSON.parse(fromB64url(parts[0]).toString('utf8')); } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload?.v !== 1) return { ok: false, reason: 'version' };
  if (payload.role !== 'host' && payload.role !== 'guest') return { ok: false, reason: 'malformed' };
  if (typeof payload.room !== 'string' || !payload.room) return { ok: false, reason: 'malformed' };
  if (typeof payload.nbf !== 'number' || typeof payload.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }

  const now = Date.now() / 1000;
  if (now < payload.nbf) return { ok: false, reason: 'too-early', opensAt: payload.nbf };
  if (now > payload.exp) return { ok: false, reason: 'expired' };

  return { ok: true, payload };
}

/** Like verifyInvite(), additionally bound to exactly one room — for joining. */
export function verifyInviteForRoom(tok: unknown, roomId: string): InviteResult {
  const res = verifyInvite(tok);
  if (!res.ok) return res;
  if (res.payload.room !== roomId) return { ok: false, reason: 'room-mismatch' };
  return res;
}
