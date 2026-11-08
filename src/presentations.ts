// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Wallet presentations outside a call — the `presentations` port a module asks (see
 * ./core/ports `PresentationPort`). A form, a delivery or a receipt needs a verified person, not
 * a room.
 *
 * The same rules as in a call, enforced HERE and not in the module:
 *   - Only attributes the instance's WRP policy permits (./wrp-policy `partitionAttributes`); a
 *     request for anything else is refused, not narrowed — a module asking for an attribute the
 *     registration does not cover is a configuration error that must be seen.
 *   - Exactly the attributes asked for: the wallet is asked for those, and only those come back
 *     (an over-disclosing presentation cannot widen what the module receives).
 *   - Derived attributes (`pseudonym_id`) are room-scoped and make no sense here: refused.
 *   - Zero retention: the verifier's session is purged the moment the callback is read; the
 *     values sit in this process's memory until the module takes them ONCE, at most
 *     `TTL_MS`, and are never written anywhere by the core.
 *   - The record (./audit) carries attribute and claim NAMES, never values.
 *
 * The callback arrives on the core's `/webhook/:sessionId` route — the id namespace is shared
 * with rooms and in-call requests (random UUIDs), and `handleWebhook` is asked first.
 */
import { randomUUID, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { createVerifierOffer, confirmedPresentation, ensureVerifierConfig, isVerificationSuccess, failureLogSuffix } from './eudiplo';
import { buildDcql, selectedProfiles, normalizeClaims, detectPresentedProfile, pidConfigId, type SemanticAttr } from './credential-profiles';
import { partitionAttributes, policyDescriptor, isDerived, requiresWalletPresentation } from './wrp-policy';
import { purgeVerifierSession } from './verifier-session';
import { catalogEntry, buildCatalogDcql, extractCatalogClaims, hasMandatoryClaims, catalogConfigId } from './credential-catalog';
import type { PresentationPort, PresentationStart, PresentationState, VerificationEvent } from './core/ports';

/** How long an unanswered or untaken presentation is kept. A wallet hand-over takes a minute or
 *  two; ten is generous and still bounds what sits in memory. */
// EUDI_PRESENTATION_TTL_MS only shortens it, for the test of what happens on expiry.
const TTL_MS = Math.min(10 * 60_000, Number(process.env.EUDI_PRESENTATION_TTL_MS) || 10 * 60_000);
/** A bound on concurrent open presentations, so a flood of starts cannot grow memory without end
 *  (the module's own route is rate limited too). */
const MAX_OPEN = 2000;

interface Open {
  id: string;
  /** Held by the module (and its browser page); required to poll. The id alone travels to
   *  EUDIPLO and back and must not be enough to read the result. */
  secret: string;
  /** In the webhook URL; rotated after a success like a room's (replay protection). */
  webhookToken: string;
  module: string;
  attrs: SemanticAttr[];
  /** A catalog credential instead of PID attributes (startCredential). */
  credential?: string;
  verifierSessionId?: string;
  state: 'pending' | 'ok' | 'failed';
  claims?: Record<string, unknown>;
  format?: string;
  profileId?: string;
  at?: string;
  expires: number;
}

const open = new Map<string, Open>();

function sweep(now = Date.now()): void {
  for (const [id, p] of open) {
    if (p.expires > now) continue;
    purgeVerifierSession(p.verifierSessionId, 'left');
    open.delete(id);
  }
}
setInterval(sweep, 60_000).unref();

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return a.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

export interface PresentationDeps {
  /** ./server recordVerification — the audit line and the modules' verification sinks. */
  record(ev: VerificationEvent): void;
}

export class PresentationRefused extends Error {
  constructor(message: string, readonly attrs: string[] = []) { super(message); }
}

/** The port for one module. `module` names it in logs and records. */
export function presentationPort(module: string, deps: PresentationDeps): PresentationPort {
  return {
    allowedAttributes: () => [...policyDescriptor().allowedAttributes].filter((a) => !isDerived(a as SemanticAttr)),

    async start({ attrs, origin, returnUrl }): Promise<PresentationStart> {
      sweep();
      if (open.size >= MAX_OPEN) throw new PresentationRefused('too many open presentations');
      const wanted = [...new Set((attrs ?? []).map(String))];
      const { allowed, rejected } = partitionAttributes(wanted);
      const derived = allowed.filter((a) => isDerived(a));
      if (rejected.length || derived.length) {
        throw new PresentationRefused(`attributes not permitted here: ${[...rejected, ...derived].join(', ')}`, [...rejected, ...derived]);
      }
      if (!requiresWalletPresentation(allowed)) throw new PresentationRefused('nothing to present');
      const profiles = selectedProfiles();
      const requestId = pidConfigId(profiles.map((p) => p.id), allowed);
      await ensureVerifierConfig(requestId, buildDcql(profiles, allowed), 'pid');
      const p: Open = {
        id: randomUUID(), secret: randomUUID(), webhookToken: randomUUID(), module,
        attrs: allowed, state: 'pending', expires: Date.now() + TTL_MS,
      };
      const offer = await createVerifierOffer(`${origin}/webhook/${p.id}?t=${p.webhookToken}`, requestId, returnUrl);
      p.verifierSessionId = offer.sessionId;
      open.set(p.id, p);
      console.log(`[presentation] ${module}: offer attrs=[${allowed.join(',')}]`);
      return { id: p.id, secret: p.secret, uri: offer.uri, crossDeviceUri: offer.crossDeviceUri, expiresAt: new Date(p.expires).toISOString() };
    },

    async startCredential({ credentialId, origin, returnUrl }): Promise<PresentationStart> {
      sweep();
      if (open.size >= MAX_OPEN) throw new PresentationRefused('too many open presentations');
      // Only what the instance's catalog holds — the module that provides it decides that list,
      // the core validates it (../credential-catalog).
      const c = catalogEntry(String(credentialId || ''));
      if (!c) throw new PresentationRefused(`unknown credential: ${String(credentialId).slice(0, 40)}`);
      const dcql = buildCatalogDcql(c);
      const requestId = catalogConfigId(c);
      await ensureVerifierConfig(requestId, dcql, 'catalog');
      const p: Open = {
        id: randomUUID(), secret: randomUUID(), webhookToken: randomUUID(), module,
        attrs: [], credential: c.id, state: 'pending', expires: Date.now() + TTL_MS,
      };
      const offer = await createVerifierOffer(`${origin}/webhook/${p.id}?t=${p.webhookToken}`, requestId, returnUrl);
      p.verifierSessionId = offer.sessionId;
      open.set(p.id, p);
      console.log(`[presentation] ${module}: offer credential=${c.id}`);
      return { id: p.id, secret: p.secret, uri: offer.uri, crossDeviceUri: offer.crossDeviceUri, expiresAt: new Date(p.expires).toISOString() };
    },

    poll(id, secret): PresentationState {
      const p = open.get(id);
      if (!p || p.module !== module || !same(String(secret ?? ''), p.secret)) return { state: 'unknown' };
      // Expired: gone at the verifier too, not only here (audit #7) — a wallet that answers late
      // would otherwise leave its claims there until the verifier's own TTL.
      if (p.expires <= Date.now()) { purgeVerifierSession(p.verifierSessionId, 'left'); open.delete(id); return { state: 'expired' }; }
      if (p.state === 'pending') return { state: 'pending' };
      if (p.state === 'failed') { open.delete(id); return { state: 'failed' }; }
      // Handed over ONCE. From here on the core holds nothing of it.
      open.delete(id);
      return { state: 'ok', attrs: [...p.attrs], claims: p.claims ?? {}, at: p.at!, format: p.format, profileId: p.profileId, credential: p.credential };
    },

    cancel(id, secret): void {
      const p = open.get(id);
      if (!p || p.module !== module || !same(String(secret ?? ''), p.secret)) return;
      purgeVerifierSession(p.verifierSessionId, 'left');
      open.delete(id);
    },
  };
}

/**
 * The verifier's callback for a module presentation. Returns false when the session is not one of
 * ours (then the caller tries rooms and in-call requests).
 */
export async function handlePresentationWebhook(req: Request, res: Response, deps: PresentationDeps): Promise<boolean> {
  const p = open.get(req.params.sessionId);
  if (!p) return false;
  const token = String(req.query.t || '');
  if (!same(token, p.webhookToken)) {
    console.warn(`[presentation] ${p.module}: rejected callback — bad/missing token`);
    res.status(401).send('unauthorized');
    return true;
  }
  if (p.state !== 'pending') { res.status(409).send('already answered'); return true; }
  // The body is only the trigger; the result is read back from the verifier (see
  // confirmedPresentation in ./eudiplo for why a token-carrying callback is not enough).
  const payload = await confirmedPresentation(req.body, p.verifierSessionId);
  if (!payload) {
    console.log(`[presentation] ${p.module}: callback for a replaced offer ignored`);
    res.status(200).send('OK');
    return true;
  }
  // A second copy of this callback was answered while we asked (the token rotates below).
  if (p.state !== 'pending' || p.webhookToken !== token) { res.status(409).send('already answered'); return true; }
  if (typeof payload.session === 'string' && payload.session) p.verifierSessionId = payload.session;
  // Only what was asked for: normalizeClaims copies the policy's allowlist, this narrows it to the
  // presentation's own attributes.
  const claims: Record<string, unknown> = {};
  let ok: boolean;
  const cred = p.credential ? catalogEntry(p.credential) : undefined;
  if (p.credential) {
    // A catalog credential: its own claims, by the catalog's paths — and every mandatory one, or
    // a partial presentation would pass as a whole one.
    Object.assign(claims, cred ? extractCatalogClaims(cred, payload) : {});
    ok = !!cred && isVerificationSuccess(payload, Object.keys(claims).length) && hasMandatoryClaims(cred, claims);
  } else {
    const all = normalizeClaims(payload);
    for (const a of p.attrs) if (a in all) claims[a] = all[a];
    ok = isVerificationSuccess(payload);
  }
  purgeVerifierSession(p.verifierSessionId, ok ? 'verified' : 'failed');
  p.verifierSessionId = undefined;
  p.webhookToken = randomUUID();
  const ev: VerificationEvent = {
    type: ok ? 'verified' : 'verification-failed', at: new Date().toISOString(),
    // Rooms are hashed into the record; a module presentation is its own scope.
    roomId: `${p.module}:${p.id}`, role: 'callee', clientId: p.id,
    attrs: [...p.attrs], claimKeys: ok ? Object.keys(claims) : [],
    ...(p.credential ? { credentialId: p.credential } : {}),
  };
  if (ok) {
    const presented = detectPresentedProfile(payload, selectedProfiles());
    Object.assign(p, { state: 'ok', claims, at: ev.at, format: presented?.format, profileId: presented?.id });
    ev.credentialFormat = presented?.format; ev.profileId = presented?.id;
    console.log(`[presentation] ${p.module}: verified, claims=[${Object.keys(claims).join(',')}]`);
  } else {
    p.state = 'failed';
    console.log(`[presentation] ${p.module}: failed${failureLogSuffix(payload)}`);
  }
  deps.record(ev);
  res.status(200).send('OK');
  return true;
}

/** For the test: how many presentations the core still holds. */
export function openPresentationCount(): number { sweep(); return open.size; }
