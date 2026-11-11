// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Staff token — the second layer protecting who may host.
 *
 * The name allowlist (./host-gate) binds to a PERSON but cannot tell namesakes apart. This
 * token binds to POSSESSION of an internal link. Only both together deserve the word
 * "dependable": anyone wanting to invite and moderate on the authority's behalf needs a real
 * ID document with a listed name AND the link.
 *
 * NAMED HONESTLY: this is a bearer token. Passed on, it works unchanged; it says nothing
 * about the person holding it. It does not replace identity — that is what the name allowlist
 * is for. Its job is to narrow the circle of those who can even try.
 *
 * Built deliberately like ./invite-token: payload + HMAC, stateless, no database. Its own
 * secret, so revoking one does not devalue the other — someone who must withdraw staff links
 * should not simultaneously invalidate every appointment already issued.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const SECRET = (process.env.EUDI_STAFF_SECRET || '').trim();

/** Without a secret this layer is off — /invite stays open. */
export function staffGateActive(): boolean {
  return SECRET.length > 0;
}

export interface StaffPayload {
  v: 1;
  /** Free-form label, e.g. "counter-3". Appears only in the log and makes a single link
   *  attributable without naming a person. */
  label: string;
  /** Issued at / valid until, in seconds since the epoch. */
  iat: number;
  exp: number;
}

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signStaffToken(payload: StaffPayload): string {
  if (!SECRET) throw new Error('EUDI_STAFF_SECRET is not set');
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${b64url(createHmac('sha256', SECRET).update(body).digest())}`;
}

export type StaffReason = 'missing' | 'malformed' | 'signature' | 'version' | 'expired';
export type StaffResult = { ok: true; payload: StaffPayload } | { ok: false; reason: StaffReason };

/** Do not even hash absurdly long input. */
const MAX_LEN = 4096;

/**
 * Verify signature, version and lifetime — same order as ./invite-token: signature first,
 * content second. Nothing may be concluded from an unsigned payload.
 */
export function verifyStaffToken(token: unknown): StaffResult {
  if (!SECRET) return { ok: false, reason: 'missing' };
  if (typeof token !== 'string' || !token || token.length > MAX_LEN) {
    return { ok: false, reason: 'missing' };
  }
  const dot = token.indexOf('.');
  if (dot < 1) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  const sig = fromB64url(token.slice(dot + 1));
  const want = createHmac('sha256', SECRET).update(body).digest();
  // Match lengths before timingSafeEqual — otherwise it throws instead of comparing.
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) {
    return { ok: false, reason: 'signature' };
  }
  let payload: StaffPayload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload?.v !== 1) return { ok: false, reason: 'version' };
  // Staff and invitation tokens share their shape (v, exp) and could share a key if an operator
  // set EUDI_STAFF_SECRET to the value of EUDI_INVITE_SECRET; a guest's invitation would then open
  // the staff functions. An invitation always names its room and role — a staff token never does
  // (security audit 2026-11-11).
  if ('room' in (payload as object) || 'role' in (payload as object)) return { ok: false, reason: 'malformed' };
  if (typeof payload.exp !== 'number' || Date.now() / 1000 > payload.exp) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
}
