// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Actions in a call — a module's form, signature or delivery, run WITH a participant while the
 * call goes on (ports `ModuleAction`, `CallPort`).
 *
 *   host   "Aktionen" → picks an action and a choice for a guest            action-start
 *   guest  sees who asks, for what, and WHICH verified data the module       action-requested
 *          will take from this call; agrees or declines                      action-accept/-decline
 *   guest  gets the module's page in a panel over the call, with a           action-open
 *          one-time token in its address
 *   module exchanges the token for the guest's identity (redeem), once;
 *          reports done (done) — the host is told, the panel closes          action-done
 *
 * The identity the module gets is what the guest presented IN THIS CALL, narrowed to what the
 * chosen action needs, at the moment of the exchange, and only while the guest is still in the
 * room — read from the participant, never from the token. The token carries nothing; it is a
 * random handle, valid for one exchange and one "done", for at most RUN_TTL_MS.
 *
 * The guest's consent is the "Öffnen" in the core's own dialog, which names the data before the
 * module ever sees a byte of it — not a dialog of the module's that the core could not vouch for.
 */
import { randomBytes } from 'crypto';
import type { Participant, Room } from './rooms';
import type { CallIdentity } from './core/ports';

const RUN_TTL_MS = 30 * 60_000;
const MAX_RUNS = 1000;

export type RunState = 'requested' | 'open' | 'redeemed' | 'done';

export interface ActionRun {
  id: string;
  token: string;
  module: string;
  action: string;
  choice: string;
  /** Menu text of the action and the choice's label — shown to both, no personal data. */
  label: string;
  title: string;
  /** What the action may take from the call: choice attrs ∩ what the guest presented. */
  attrs: string[];
  path: string;
  room: Room;
  host: Participant;
  guest: Participant;
  state: RunState;
  expires: number;
}

const runs = new Map<string, ActionRun>();
const byToken = new Map<string, ActionRun>();

function drop(r: ActionRun): void {
  runs.delete(r.id);
  byToken.delete(r.token);
}

export function sweepRuns(now = Date.now()): ActionRun[] {
  const gone: ActionRun[] = [];
  for (const r of runs.values()) if (r.expires <= now) { drop(r); gone.push(r); }
  return gone;
}

export function createRun(init: Omit<ActionRun, 'id' | 'token' | 'state' | 'expires'>): ActionRun | null {
  sweepRuns();
  if (runs.size >= MAX_RUNS) return null;
  const r: ActionRun = {
    ...init,
    id: randomBytes(12).toString('base64url'),
    token: randomBytes(32).toString('base64url'),
    state: 'requested',
    expires: Date.now() + RUN_TTL_MS,
  };
  runs.set(r.id, r);
  byToken.set(r.token, r);
  return r;
}

export const runById = (id: unknown): ActionRun | undefined => (typeof id === 'string' ? runs.get(id) : undefined);

/** Open runs that involve this participant (as host or guest) — to end them when they leave. */
export function runsOf(p: Participant): ActionRun[] {
  return [...runs.values()].filter((r) => r.host === p || r.guest === p);
}

export function endRun(r: ActionRun): void { drop(r); }

/** The panel address for the guest: the module's page plus the token. */
export function panelPath(r: ActionRun): string {
  return `${r.path}${r.path.includes('?') ? '&' : '?'}ruf=${encodeURIComponent(r.token)}`;
}

/**
 * CallPort.redeem. `stillHere` answers whether the guest is still in the room (the room store
 * knows; this file does not).
 */
export function redeem(token: string, module: string, stillHere: (r: ActionRun) => boolean): CallIdentity | null {
  const r = typeof token === 'string' ? byToken.get(token) : undefined;
  if (!r || r.module !== module || r.state !== 'open' || r.expires <= Date.now()) return null;
  if (!stillHere(r) || !r.guest.verified) return null;
  r.state = 'redeemed';
  const all = r.guest.claims ?? {};
  const claims: Record<string, unknown> = {};
  for (const a of r.attrs) if (a in all && all[a] !== null && all[a] !== undefined) claims[a] = all[a];
  return { claims, attrs: [...r.attrs], at: new Date().toISOString(), action: r.action, choice: r.choice };
}

/** CallPort.done: returns the run so the caller can tell host and guest; null when unknown. */
export function finish(token: string, module: string): ActionRun | null {
  const r = typeof token === 'string' ? byToken.get(token) : undefined;
  if (!r || r.module !== module || (r.state !== 'open' && r.state !== 'redeemed')) return null;
  r.state = 'done';
  drop(r);
  return r;
}

/** For the test. */
export function openRunCount(): number { sweepRuns(); return runs.size; }
