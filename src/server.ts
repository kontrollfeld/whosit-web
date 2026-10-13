// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * EUDI-verified WebRTC PoC — signaling server.
 *
 * Flow:
 *   1. Two browsers join the same room over WebSocket (caller = first, callee = second).
 *   2. Each gets its own EUDIPLO verifier offer (QR) asking for PID given_name + family_name.
 *   3. The wallet presents → EUDIPLO POSTs the result to /webhook/:sessionId.
 *   4. Once BOTH participants are verified, the server sends `ready`; the caller
 *      creates the WebRTC offer. SDP/ICE are relayed peer-to-peer through this server.
 *   5. Media (A/V) and a chat DataChannel then flow directly P2P between the browsers.
 */
import 'dotenv/config';
import path from 'path';
import http from 'http';
import { randomUUID, createHash, timingSafeEqual, createHmac } from 'crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

import fs from 'fs';
import { readBranding, brandHtml } from './branding';
import { readOperatorPages, resolveOperatorPage, resolveOperatorHome, availableMedia, OPERATOR_PAGES,
  resolveOperatorSitePath, resolveOperatorRedirect, resolveOperatorNotFound } from './operator-pages';
import { createVerifierOffer, extractNames, ensureVerifierConfig, isVerificationSuccess, verifierTenantId, isDefaultVerifierTenant } from './eudiplo';

import { relyingParty, relyingPartyWarning } from './relying-party';

/** This instance's brand — null when unbranded, in which case all branding is a no-op. */
const BRANDING = readBranding();
const OPERATOR = readOperatorPages();
/** Who the wallet will show as asking, against whose name the page carries (see
 *  ./relying-party). Computed once: both inputs are environment variables. */
const RELYING_PARTY = relyingParty(BRANDING?.name);
import { buildDcql, selectedProfiles, normalizeClaims, detectPresentedProfile, type SemanticAttr, type CredentialProfile } from './credential-profiles';
import { buildTransactionData, bindingSupported, bindingEnabled, normalizeFingerprint, fingerprintFromSdp, type TransactionDataEntry } from './channel-binding';
import {
  resolveAttributes, partitionAttributes, PolicyViolationError, policyDescriptor,
  isDerived, requiresWalletPresentation, wrpStrict, WRP_PURPOSE_ID,
  activePolicyName, assertPolicyOrExit, assertNarrowOrExit,
} from './wrp-policy';

// Very early, before any server is built: an unknown policy name must not end in a silent
// fallback to the default registration.
assertPolicyOrExit();
// And a narrowing must fit the policy it narrows. Same reasoning, one step further in: an
// attribute the operator believes they configured but that the policy does not permit would
// simply never be requested, and nothing would point at the variable.
assertNarrowOrExit();
import { recordAudit, setAuditForwarder } from './audit';
import { derivePseudonym, auditHash } from './pseudonym';
import { mayHost, hostGateActive, hostGateSize, assertHostGateOrExit, enforceHostDisclosure } from './host-gate';
import { staffGateActive, verifyStaffToken } from './staff-token';
import { rateLimit, rateLimitFromEnv } from './rate-limit';

// A configured host gate must also be ABLE to work. If this instance's policy permits no
// name, there would be nothing to compare and nobody would ever get through — an unusable
// instance whose reason is written nowhere.
assertHostGateOrExit(
  policyDescriptor().walletRequestable.includes('given_name') &&
  policyDescriptor().walletRequestable.includes('family_name'),
);
import type { Room, Participant, Role, Mode } from './rooms';
import { loadExtensions } from './pro-loader';
import { communityRoomStore, noopVerificationSink } from './core/community';
import type { Extensions, SignalingPlugin, VerificationEvent, VerificationEventType } from './core/ports';
import { catalogEntry, publicCatalog, buildCatalogDcql, extractCatalogClaims, hasMandatoryClaims, claimKey, loadCatalog, credentialTypes } from './credential-catalog';
import { createRequest, requestBySession, requestById, hasPending, openRequestsInvolving, finishRequest, type CredentialRequest } from './credential-requests';
import { purgeVerifierSession } from './verifier-session';
import { createPairing, joinPairing, pairingOfOwner, pairingOfPhone, endPairing } from './device-pairing';
import { COMMUNITY_FEATURE_IDS, PRO_FEATURE_IDS, parseFeaturesOff } from './core/features';
import { configuredEdition, effectiveEdition, promoAllPro } from './core/edition';
import { verifierMode, NEEDS_VERIFIER } from './core/verifier-mode';
import { assertProductionConfig } from './core/startup-checks';
import { buildTerminPass, walletPassConfigured } from './wallet-pass';
import { publicSignatureProviders } from './signature-providers';
import {
  inviteConfigured, isPlannedRoomId, mintInvitePair, newPlannedRoomId, verifyInvite,
  verifyInviteForRoom, type InvitePayload,
} from './invite-token';

const GRACE_MS = 90_000; // keep a disconnected participant this long so it can resume
/**
 * Scheduled calls hold the seat considerably longer. For an appointment, waiting is the normal
 * case — someone who opens the window at 14:00 and waits for 14:15 will have their device
 * sleep in between. After 90 seconds they would be removed, return via the invitation, and
 * `resetIdentity` would demand a SECOND wallet presentation.
 *
 * Harmless, because in a `p-` room every seat is bound to a role from the signed token: a
 * waiting seat blocks nobody — only the holder of that same token could occupy it anyway,
 * which is precisely the person we are holding it for.
 */
const PLANNED_GRACE_MS = 15 * 60_000;

// Apply the WRP whitelist to a client-supplied attribute list (see ./wrp-policy).
//
// An out-of-scope attribute is always AUDITED, never silently dropped, and — with
// EUDI_WRP_STRICT=on — refused outright with `policy_violation`.
//
// Otherwise (transitional default) it is narrowed to the whitelist, because older clients
// still offer birth_date/issuing_country/address and do not understand a policy_violation
// error. Narrowing keeps those sessions working
// on LESS data than they asked for. Either way the wallet request is identical — the
// egress gate in eudiplo.ts is hard in both modes.
function applyPolicy(
  attrs: any, roomId: string, p: Participant | undefined,
): { attrs: SemanticAttr[]; rejected: string[] } {
  const { allowed, rejected } = resolveAttributes(attrs); // throws in strict mode
  if (rejected.length) auditPolicyViolation(roomId, p, allowed, rejected, 'narrowed');
  return { attrs: allowed, rejected };
}

// One place that writes a policy event, so a violation can never be applied without a
// record. `attrs` is what we ended up using, `rejected` what was refused/dropped.
function auditPolicyViolation(
  roomId: string, p: Participant | undefined,
  attrs: readonly string[], rejected: readonly string[],
  status: 'narrowed' | 'rejected',
): void {
  console.warn(`[policy] ${status} attrs=[${rejected.join(',')}] room=${roomId.slice(0, 8)}`);
  recordAudit({
    event: 'policy-violation', status,
    roomId, clientId: p?.clientId, role: p?.role, attrs, rejected,
  });
}
// Stable config id for a (profile-set × attribute-set) combination — so a Community
// mdoc-only request and a Pro multi-format request register distinct EUDIPLO configs.
function configId(profileIds: string[], attrs: string[]): string {
  const key = [...profileIds].sort().join('|') + '::' + [...attrs].sort().join(',');
  return 'pid_req_' + createHash('sha1').update(key).digest('hex').slice(0, 12);
}
/**
 * Issue and send a fresh wallet offer.
 *
 * EUDIPLO consumes an offer on the FIRST presentation attempt, even when that attempt fails or
 * is cancelled. It then rejects every further presentation — towards the wallet, not towards
 * this service: nothing reports it. Anyone rescanning the same QR code runs into a dead end that
 * looks, from outside, like a wallet bug.
 *
 * The old offer is therefore discarded rather than reused.
 */
async function reissueAuthOffer(participant: Participant, room: Room, origin: string): Promise<void> {
  participant.offer = undefined;
  participant.pendingBinding = undefined;
  // The consumed session is of no further use to anyone — least of all to the person who
  // just failed to present. Purged here rather than in ensureAuthOffer alone, because the
  // early return below (nothing left to present) skips that path entirely.
  purgeVerifierSession(participant.verifierSessionId, 'failed');
  participant.verifierSessionId = undefined;
  const attrs = attrsFor(room, participant);
  if (!requiresWalletPresentation(attrs)) return;
  try {
    await ensureAuthOffer(participant, attrs, origin, room.id);
    send(participant.ws, { type: 'auth', uri: participant.offer!.uri, crossDeviceUri: participant.offer!.crossDeviceUri });
  } catch (e: any) {
    console.error('[eudiplo] Erneuerung des Angebots fehlgeschlagen:', e?.body || e?.message || e);
    send(participant.ws, { type: 'error', message: 'EUDIPLO offer failed' });
  }
}

// Create the EUDIPLO presentation offer a participant needs to present `attrs`.
// The active credential profiles decide the DCQL query (mdoc and/or SD-JWT etc.) and the
// trust framework; multiple profiles → one offer the wallet can satisfy in any format.
async function ensureAuthOffer(participant: Participant, attrs: SemanticAttr[], origin: string, roomId?: string): Promise<void> {
  // Last line of defence before a wallet request is built. `attrs` normally arrived via
  // applyPolicy() and is already in scope — but a Pro RoomStore may hand back a room
  // PERSISTED before the WRP scoping. Refusing would strand that room, so degrade to the
  // allowed subset and audit; the offer is then narrower than the stored config, never wider.
  const { allowed, rejected } = partitionAttributes(attrs);
  if (rejected.length) auditPolicyViolation(roomId ?? '', participant, allowed, rejected, 'narrowed');
  attrs = allowed;
  const profiles = selectedProfiles();
  const dcql = buildDcql(profiles, attrs);
  const requestId = configId(profiles.map((p) => p.id), attrs);
  // kind:'pid' → the WRP whitelist is enforced against the outgoing query (see eudiplo.ts).
  await ensureVerifierConfig(requestId, dcql, 'pid');
  console.log(`[eudiplo] offer ${participant.role} attrs=[${attrs.join(',')}] profiles=[${profiles.map((p) => p.id).join(',')}]`);
  const webhookUrl = `${origin}/webhook/${participant.sessionId}?t=${participant.webhookToken}`;
  const redirectUri = roomId ? `${origin}/?room=${encodeURIComponent(roomId)}` : undefined;
  // Channel binding: only when the client reported a fingerprint AND the active profiles
  // support the check. Both must hold — see ./channel-binding.
  const txData = bindingFor(participant, profiles, roomId);
  participant.channelBound = undefined;          // only becomes true through verification
  // Whatever session this participant held before is now unreachable — overwriting the id
  // without deleting it would strand the claims at the verifier until its TTL sweep.
  purgeVerifierSession(participant.verifierSessionId, 'reissued');
  participant.verifierSessionId = undefined;
  participant.offer = await createVerifierOffer(webhookUrl, requestId, redirectUri, txData);
  participant.verifierSessionId = participant.offer.sessionId;
  participant.pendingBinding = txData.length > 0;
}

/** A single, unmistakable warning: the client wants binding, the configuration cannot deliver
 *  it. No abort — an operator's configuration mistake should not take down the whole service —
 *  but it must never go unnoticed either, and the binding is then claimed nowhere
 *  (channelBound stays false). */
let warnedUnboundable = false;

function bindingFor(participant: Participant, profiles: CredentialProfile[], roomId?: string): TransactionDataEntry[] {
  if (!participant.dtlsFingerprint || !roomId) return [];
  // Being switched off is the normal case (see bindingEnabled) — no warning for that, or
  // every startup would carry a warning that means nothing.
  if (!bindingEnabled()) return [];
  if (!bindingSupported(profiles)) {
    if (!warnedUnboundable) {
      warnedUnboundable = true;
      console.warn(
        '[channel-binding] the client asks for channel binding, but the active profiles ' +
        `[${profiles.map((p) => p.id).join(',')}] cannot provide it — EUDIPLO evaluates ` +
        'transaction_data for dc+sd-jwt only. The connection continues WITHOUT binding and is ' +
        'not reported as bound anywhere. Remedy: ' +
        'EUDI_CREDENTIAL_PROFILES=pid_sdjwt (see src/channel-binding.ts).',
      );
    }
    return [];
  }
  return [buildTransactionData({
    credentialIds: profiles.map((p) => p.id),
    fingerprint: participant.dtlsFingerprint,
    roomId,
  })];
}

// How long an in-call credential request may sit open (consent + wallet round-trip).
const CREDENTIAL_REQUEST_TTL_MS = Math.max(60, Number(process.env.EUDI_CREDENTIAL_REQUEST_TTL || 300)) * 1000;

// EUDIPLO offer for an in-call credential request — same transport as the PID gate,
// but the DCQL comes from the catalog entry and the session is the REQUEST's own.
async function ensureCredentialOffer(r: CredentialRequest, origin: string, roomId?: string): Promise<void> {
  const c = r.credential;
  const requestId = 'cred_' + createHash('sha1')
    .update([c.id, c.format, credentialTypes(c).join('+'), ...c.claims.map((cl) => cl.path.join('.'))].join('|'))
    .digest('hex').slice(0, 12);
  // kind:'catalog' → a non-PID credential type with its own consent step; the PID
  // attribute whitelist does not apply (see VerifierConfigKind in eudiplo.ts).
  await ensureVerifierConfig(requestId, buildCatalogDcql(c), 'catalog');
  console.log(`[eudiplo] in-call offer ${c.id} for ${r.target.role} (${r.target.clientId.slice(0, 8)})`);
  const webhookUrl = `${origin}/webhook/${r.sessionId}?t=${r.webhookToken}`;
  const redirectUri = roomId ? `${origin}/?room=${encodeURIComponent(roomId)}` : undefined;
  r.offer = await createVerifierOffer(webhookUrl, requestId, redirectUri);
  r.verifierSessionId = r.offer.sessionId;
}

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

// Pluggable pieces (room store, verification sink, signaling plugins). Starts as the
// Community defaults and is replaced once loadExtensions() resolves — before listen(),
// so no request is ever served with a half-initialized set. See ./pro-loader.
let ext: Extensions = { roomStore: communityRoomStore, verificationSink: noopVerificationSink, plugins: [], enabledFeatures: [] };

// Which edition this instance declares itself as. `pro` switches on the Pro features
// (audit-trail, qes-csc — the latter only with the Pro module loaded); everything else is Community. The
// promo switch (EUDI_PROMO_ALL_PRO) forces the EFFECTIVE edition to `pro` for everyone —
// see ./core/edition. CONFIGURED_EDITION keeps the real, licensed edition for transparency.
const CONFIGURED_EDITION = configuredEdition();
// EUDI_VERIFIER=none: evaluation without a verifier — every call anonymous (./core/verifier-mode).
const VERIFIER_OFF = verifierMode() === 'none';
const PROMO_ALL_PRO = promoAllPro();
const EDITION: 'community' | 'pro' = effectiveEdition();
// Capabilities switched off by the operator. Resolved ONCE at startup, so the startup message
// cannot diverge from what the instance actually does.
const FEATURES_OFF = parseFeaturesOff();

// onReady must fire at most once per room (maybeConnect may run several times).
const readyFired = new WeakSet<Room>();

// Fire a lifecycle hook on every plugin, best-effort: a throwing/rejecting hook is
// logged and swallowed so a plugin can never break signaling.
function firePlugins(fn: (p: SignalingPlugin) => void | Promise<void>): void {
  for (const p of ext.plugins) {
    try { Promise.resolve(fn(p)).catch((e) => console.warn(`[pro] plugin ${p.name} hook failed:`, e?.message || e)); }
    catch (e: any) { console.warn(`[pro] plugin ${p.name} hook failed:`, e?.message || e); }
  }
}
// Record a verification event. Goes to the always-on, PII-free audit log (./audit) which
// then forwards to the Pro verificationSink (retainable trail) when one is loaded — so
// the compliance record exists in every edition and Pro adds retention, not the record.
function recordVerification(ev: VerificationEvent): void {
  recordAudit({
    event: ev.type,
    status: ev.type === 'verified' || ev.type === 'credential-presented' ? 'success'
      : ev.type === 'credential-requested' ? 'pending' : 'failure',
    roomId: ev.roomId,
    clientId: ev.clientId,
    role: ev.role,
    attrs: ev.attrs,
    claimKeys: ev.claimKeys,
    credentialId: ev.credentialId,
    requestedByClientId: ev.requestedBy,
    credentialFormat: ev.credentialFormat,
    profileId: ev.profileId,
  });
}

const app = express();
// SDP/ICE travel over WebSocket, not HTTP — no HTTP route needs a large body, so
// keep the JSON limit tight (webhook payloads are small) to bound memory/DoS.
app.use(express.json({ limit: '256kb' }));

// Framing policy when the `embed` feature is active:
//   - EMBED_ALLOWED_ANCESTORS set → embedding allowed for exactly those origins.
//   - EMBED_SIGNING_SECRET set → framing DENIED by default; only /?embed=1&tok=<valid> opens
//     it, for the origins named in the signed token (hardened mode).
//   - NEITHER set → framing denied, as without the feature.
// Otherwise: deny framing entirely (clickjacking protection). See scripts/embed-token.mjs.
//
// NO WILDCARD DEFAULT: enabling `embed` without configured origins must not let ANY
// third-party page frame the app — an attack surface created by omission rather than by
// decision. Opening framing is always a deliberate act; `assertProductionConfig`
// rejects a configured `*` in production.
const EMBED_ANCESTORS = (process.env.EMBED_ALLOWED_ANCESTORS || '').trim();
const EMBED_SECRET = (process.env.EMBED_SIGNING_SECRET || '').trim();

function b64urlToBuf(s: string): Buffer { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
interface EmbedPayload { m?: string; r?: string[]; d?: string[]; l?: boolean; o?: string[]; e?: number }
// Verify an embed token: "<payload-b64url>.<hmac-b64url>", HMAC-SHA256 over the payload.
function verifyEmbedToken(tok: string): EmbedPayload | null {
  if (!EMBED_SECRET) return null;
  const parts = tok.split('.');
  if (parts.length !== 2) return null;
  const expected = createHmac('sha256', EMBED_SECRET).update(parts[0]).digest();
  let sig: Buffer;
  try { sig = b64urlToBuf(parts[1]); } catch { return null; }
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  let payload: EmbedPayload;
  try { payload = JSON.parse(b64urlToBuf(parts[0]).toString('utf8')); } catch { return null; }
  if (payload.e && Date.now() / 1000 > payload.e) return null; // expired
  return payload;
}

app.use((_req, res, next) => {
  if (enabledFeatures().has('embed') && !EMBED_SECRET && EMBED_ANCESTORS) {
    res.setHeader('Content-Security-Policy', `frame-ancestors ${EMBED_ANCESTORS}`);
  } else {
    // Community, or hardened embed (token gate handled per-request in the "/" route).
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  }
  next();
});

// Root shows the LANDING page; the call app only when explicitly entered:
//   /?room=…  invitation links (unchanged, keep working)
//   /?new=1   "Anruf starten" CTA → app generates a fresh room
//   /?solo=1  internal single-device test path
//   /?embed=1 embedded widget (iframe on a third-party page, Pro)
// iOS Universal Links: with EUDI_IOS_APP_ID set (e.g. "TEAMID.com.example.app"), the
// apple-app-site-association file tells iOS that ?room= links on this domain open the
// native app when installed (Safari otherwise). Served without extension and as JSON
// per Apple's spec. Unset (default): 404 — self-hosters opt in with their own app ID.
const IOS_APP_ID = (process.env.EUDI_IOS_APP_ID || '').trim();
app.get('/.well-known/apple-app-site-association', (_req, res) => {
  if (!IOS_APP_ID) { res.status(404).end(); return; }
  res.type('application/json').json({
    applinks: {
      details: [{
        appIDs: [IOS_APP_ID],
        components: [
          // Only room links open the app — the marketing pages stay in the browser.
          { '/': '/', '?': { room: '?*' } },
          { '/': '/index.html', '?': { room: '?*' } },
          // Pairing a phone to sign for a browser participant (qes-device, ./device-pairing).
          // Unlike `inv` below this is safe to route to the app before every installed build
          // understands it: an older build would open a fresh room, but a pairing QR code is
          // only ever scanned right after it is shown — the user notices at once, and a browser
          // could not do anything with the link either (the key has to be in the app).
          { '/': '/', '?': { pair: '?*' } },
          { '/': '/index.html', '?': { pair: '?*' } },
          // DELIBERATELY NOT YET: `?inv=` (scheduled call). The shipped app only understands
          // the parameter from the next build onwards — an older app would capture the
          // appointment link, ignore the parameter and open a FRESH ad-hoc room. Without this
          // entry the link opens the browser, where it works. Once a build with inv support is
          // rolled out, add here:
          //   { '/': '/', '?': { inv: '?*' } },
          //   { '/': '/index.html', '?': { inv: '?*' } },
        ],
      }],
    },
  });
});

// Android App Links: with EUDI_ANDROID_PACKAGE + EUDI_ANDROID_SHA256 set, the Digital
// Asset Links file lets links on this domain open the installed Android app (verified links).
// SHA256 = comma-separated cert fingerprint(s) from Play App Signing. Unset: 404.
const ANDROID_PACKAGE = (process.env.EUDI_ANDROID_PACKAGE || '').trim();
const ANDROID_SHA256 = (process.env.EUDI_ANDROID_SHA256 || '').split(',').map((s) => s.trim()).filter(Boolean);
app.get('/.well-known/assetlinks.json', (_req, res) => {
  if (!ANDROID_PACKAGE || ANDROID_SHA256.length === 0) { res.status(404).end(); return; }
  res.type('application/json').json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: ANDROID_SHA256 },
  }]);
});

// Scheduled call (`planned-invites`, see ./invite-token). Mints two invitations for ONE fresh
// room: one for the host, one to share. Both carry the same arrangement, so that at
// appointment time arrival order does not decide who hosts and what is requested. No server
// state — no room is created here yet.
const INVITE_LEAD_S = 15 * 60;         // this far before the appointment the link opens
const INVITE_TRAIL_S = 2 * 60 * 60;    // this long after the end it remains valid
const INVITE_MAX_AHEAD_S = 400 * 24 * 60 * 60;
const INVITE_MAX_DURATION_S = 12 * 60 * 60;

// The mint endpoint is also called from the app (capacitor://localhost), i.e. a foreign
// origin: a JSON POST triggers a preflight that has to be answered.
const inviteCors: express.RequestHandler = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
};
app.options('/invite', inviteCors);
// Per-IP brake on the unauthenticated mint/sign endpoints (see ./rate-limit); 0 = off.
const RATE_LIMIT_INVITE = rateLimitFromEnv('EUDI_RATE_LIMIT_INVITE', 30);
const RATE_LIMIT_WALLET_PASS = rateLimitFromEnv('EUDI_RATE_LIMIT_WALLET_PASS', 30);
app.post('/invite', inviteCors, rateLimit(RATE_LIMIT_INVITE), (req, res) => {
  if (!enabledFeatures().has('planned-invites')) {
    res.status(501).json({ error: 'planned invites not configured' }); return;
  }
  // Staff token (tenant instance, see ./staff-token). Without EUDI_STAFF_SECRET the layer is
  // off and /invite stays open, so existing deployments where any visitor may create an
  // appointment keep working.
  if (staffGateActive()) {
    const tok = (req.headers['x-staff-token'] as string | undefined) ?? (req.body || {}).staff;
    const v = verifyStaffToken(tok);
    if (!v.ok) {
      // The outward reason is deliberately coarse: someone without a token should not learn
      // whether one is expired or wrongly signed. The log keeps the precise reason.
      console.log(`[staff] Terminausstellung abgelehnt — grund=${v.reason}`);
      res.status(401).json({ error: 'staff token required' });
      return;
    }
    console.log(`[staff] Termin ausgestellt von "${v.payload.label}"`);
  }
  const body = (req.body || {}) as Record<string, unknown>;
  const mode: Mode = body.mode === 'audio' || body.mode === 'chat' ? body.mode : 'video';
  const start = Date.parse(String(body.start ?? ''));
  const end = Date.parse(String(body.end ?? ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    res.status(400).json({ error: 'invalid start/end' }); return;
  }
  const now = Date.now();
  // Only an hour of leeway backwards (time zone and clock errors), a good year forwards: a
  // token valid for years is standing access, not an appointment.
  if (start < now - 60 * 60 * 1000 || start > now + INVITE_MAX_AHEAD_S * 1000) {
    res.status(400).json({ error: 'start out of range' }); return;
  }
  if (end - start > INVITE_MAX_DURATION_S * 1000) {
    res.status(400).json({ error: 'duration too long' }); return;
  }
  const room = newPlannedRoomId();
  // The same WRP check as in set-config: what does not pass here must not survive inside a
  // token either. It is checked again on join (see handleJoin) — the policy may have tightened
  // between issuing and the appointment.
  let requestedAttrs: SemanticAttr[];
  let disclosedAttrs: SemanticAttr[];
  try {
    requestedAttrs = applyPolicy(body.requestedAttrs, room, undefined).attrs;
    disclosedAttrs = applyPolicy(body.disclosedAttrs, room, undefined).attrs;
  } catch (e) {
    if (e instanceof PolicyViolationError) {
      auditPolicyViolation(room, undefined, [], e.rejected, 'rejected');
      res.status(400).json({ error: e.code, message: e.message, rejected: e.rejected }); return;
    }
    throw e;
  }
  const nbf = Math.floor(start / 1000) - INVITE_LEAD_S;
  const exp = Math.floor(end / 1000) + INVITE_TRAIL_S;
  const { hostToken, guestToken } = mintInvitePair({
    room, m: mode, r: requestedAttrs, d: disclosedAttrs, nbf, exp,
  });
  console.log(`[invite] geplant room=${room} mode=${mode} request=[${requestedAttrs.join(',')}] disclose=[${disclosedAttrs.join(',')}] gueltig=${new Date(nbf * 1000).toISOString()}…${new Date(exp * 1000).toISOString()}`);
  res.json({ room, hostToken, guestToken, nbf, exp, requestedAttrs, disclosedAttrs, mode });
});

// Apple Wallet appointment pass: a scheduled verified call as .pkpass (Community `wallet-pass`,
// config-gated — see src/wallet-pass.ts). Stateless: everything the pass
// needs travels in the query; the QR/back-link is the room URL on THIS origin.
app.get('/wallet-pass', rateLimit(RATE_LIMIT_WALLET_PASS), (req, res) => {
  if (!enabledFeatures().has('wallet-pass')) { res.status(404).end(); return; }
  // Scheduled call: the pass carries the HOST invitation, not the room id — otherwise it
  // would lead into a room its holder cannot enter without a token.
  const inv = String(req.query.inv || '');
  if (inv) {
    const v = verifyInvite(inv);
    if (!v.ok) { res.status(400).json({ error: `invalid invite (${v.reason})` }); return; }
    const title = String(req.query.title || 'EUDI Verified Call').slice(0, 120);
    const lang = ['de', 'en', 'fr'].includes(String(req.query.lang)) ? String(req.query.lang) : 'de';
    const start = new Date(String(req.query.start || ''));
    const end = new Date(String(req.query.end || ''));
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      res.status(400).json({ error: 'invalid start/end' }); return;
    }
    try {
      const roomUrl = `${publicOriginFrom(req)}/?inv=${encodeURIComponent(inv)}`;
      const pkpass = buildTerminPass({ roomUrl, roomId: v.payload.room, title, start, end, locale: lang });
      res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
      res.setHeader('Content-Disposition', 'attachment; filename="termin.pkpass"');
      res.send(pkpass);
    } catch (e) {
      console.error('[wallet-pass] build failed:', (e as Error).message);
      res.status(500).json({ error: 'pass generation failed' });
    }
    return;
  }
  const room = String(req.query.room || '');
  const title = String(req.query.title || 'EUDI Verified Call').slice(0, 120);
  const lang = ['de', 'en', 'fr'].includes(String(req.query.lang)) ? String(req.query.lang) : 'de';
  const start = new Date(String(req.query.start || ''));
  const end = new Date(String(req.query.end || ''));
  if (!/^[A-Za-z0-9-]{8,64}$/.test(room) || isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
    res.status(400).json({ error: 'invalid room/start/end' }); return;
  }
  try {
    const roomUrl = `${publicOriginFrom(req)}/?room=${encodeURIComponent(room)}`;
    const pkpass = buildTerminPass({ roomUrl, roomId: room, title, start, end, locale: lang });
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', 'attachment; filename="termin.pkpass"');
    res.send(pkpass);
  } catch (e) {
    console.error('[wallet-pass] build failed:', (e as Error).message);
    res.status(500).json({ error: 'pass generation failed' });
  }
});

// Must be registered BEFORE express.static: the query fork below decides what "/" means, and
// the static handler would answer with index.html before it ever runs.
app.get('/', (req, res, next) => {
  const isEmbed = 'embed' in req.query;
  // Hardened embedding: a valid signed token gates BOTH the allowed ancestor origins and
  // the requestable attributes. Without EMBED_SIGNING_SECRET this block is inert (open mode).
  if (isEmbed && EMBED_SECRET && enabledFeatures().has('embed')) {
    const payload = verifyEmbedToken(String(req.query.tok || ''));
    if (!payload) {
      res.status(403).setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.type('html').send('<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2rem;color:#1b2433">Ungültiges oder abgelaufenes Embed-Token.</body>');
      return;
    }
    const origins = payload.o && payload.o.length ? payload.o.join(' ') : "'self'";
    res.setHeader('Content-Security-Policy', `frame-ancestors ${origins}`);
    return next(); // serve the app (index.html)
  }
  // `inv` marks a scheduled call: the room id sits inside the signed invitation, not in the
  // URL — so this parameter must open the app, not an operator's start page. `pair` is the
  // phone-signature QR code (./device-pairing): without it, a phone whose link is not taken
  // by the app would land on the operator's start page and never see the pairing page.
  if ('room' in req.query || 'inv' in req.query || 'pair' in req.query || 'new' in req.query || 'solo' in req.query || isEmbed) {
    return BRANDING ? sendBranded(res, 'index.html') : next();
  }
  // Where the operator supplies a start page, it owns "/" — see ./operator-pages. Without one
  // the bare URL opens the tool itself: this is a calling application, not a website, and an
  // instance someone else runs should not greet visitors with the project's marketing.
  const home = OPERATOR ? resolveOperatorHome(OPERATOR) : null;
  if (home) { res.set('Cache-Control', 'no-cache').sendFile(home); return; }
  return BRANDING ? sendBranded(res, 'index.html') : next();
});

/**
 * Serve HTML carrying this instance's branding (see ./branding).
 *
 * Must run BEFORE express.static, otherwise the static handler ships the file unchanged.
 * Without branding configuration this is a pure pass-through — the file is served unchanged.
 */
function sendBranded(res: express.Response, file: string): void {
  const full = path.join(__dirname, '..', 'public', file);
  if (!BRANDING) { res.sendFile(full); return; }
  fs.readFile(full, 'utf8', (err, html) => {
    if (err) { res.status(404).end(); return; }
    res.type('html').set('Cache-Control', 'no-cache').send(brandHtml(html, BRANDING));
  });
}
// MUST be registered BEFORE the branding interceptor below. Express takes the first matching
// route, and that one matches every *.html — with branding switched on it would serve the
// placeholder from public/ and make the operator's real imprint unreachable under
// /impressum.html, while /impressum still worked. The interceptor only exists when branding
// is configured, so a wrong order only shows once EUDI_BRAND_LOGO is set.
// Operator pages (imprint, privacy notice, press) take precedence over the neutral placeholders
// in public/. Registered before express.static, which would otherwise ship the placeholder.
// Without EUDI_OPERATOR_PAGES nothing is registered here and the behaviour is unchanged.
if (OPERATOR) {
  app.get(/^\/(impressum|datenschutz|presse)(\.html)?$/, (req, res, next) => {
    const file = resolveOperatorPage(OPERATOR, req.path);
    if (!file) return next();                       // not provided → placeholder from public/
    res.set('Cache-Control', 'no-cache').sendFile(file);
  });
  // Redirects AWAY from /operator/… have to be answered before the static mount below, which
  // would otherwise serve the old file and the redirect could never fire. Only for /operator/
  // sources: that prefix belongs to the operator, so nothing of the application can be shadowed.
  // Every other redirect is answered by the fallback after the application's routes.
  app.get(/^\/operator\//, (req, res, next) => {
    const to = resolveOperatorRedirect(OPERATOR, req.path);
    if (to) { res.redirect(301, to); return; }
    next();
  });
  // Everything else in the directory: images, the logo package, downloads. Read-only, and only
  // below /operator/ so it can never collide with a route of the application.
  app.use('/operator', express.static(OPERATOR.dir, {
    index: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
}

if (BRANDING) {
  app.get(/\.html$/, (req, res, next) => {
    // Only real files inside the public directory, no path tricks.
    const rel = path.normalize(req.path).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '');
    const full = path.join(__dirname, '..', 'public', rel);
    if (!full.startsWith(path.join(__dirname, '..', 'public'))) return next();
    fs.access(full, fs.constants.R_OK, (e) => (e ? next() : sendBranded(res, rel)));
  });
}
// no-cache so browsers always pick up the latest frontend (avoids stale app.js).
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// Browser modules shipped by the Pro module (ext.clientAssetsDir), e.g. the device signature
// provider. Served from pro/, never from public/: that is what keeps them out of the AGPL client.
// Resolved per request because the extensions load after the routes are registered. CORS open,
// because the native app imports them from its local bundle origin — a module script is subject
// to CORS, a classic one would not be.
let proClientStatic: express.RequestHandler | null = null;
app.use('/pro-client', (req, res, next) => {
  if (!ext.clientAssetsDir) return next();
  res.setHeader('Access-Control-Allow-Origin', '*');
  proClientStatic ??= express.static(ext.clientAssetsDir, {
    setHeaders: (r) => r.setHeader('Cache-Control', 'no-cache'),
  });
  proClientStatic(req, res, next);
});

// The native app fetches these read-only, credential-free endpoints from its local
// bundle origin (e.g. https://localhost) — allow that cross-origin read. `*` is safe
// here: no cookies, no per-user data, everything below is public to any web visitor.
const publicCors: express.RequestHandler = (_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
};

/**
 * Liveness — and how much would be destroyed by a restart.
 *
 * `activeRooms` exists because room state lives in this process (see ./rooms: `const rooms = new
 * Map()`). A redeployment therefore drops every call in progress, silently, mid-sentence. With
 * many instances this has to be something a deployment can ASK, so a rollout can wait for a quiet moment per instance instead of taking a
 * guess for all of them.
 *
 * Deliberately a count and nothing else: no room ids, no participants, no timestamps. This
 * endpoint is public (the Docker HEALTHCHECK calls it from inside the container, monitoring from
 * outside), and "how many calls are happening right now" is already close enough to the edge.
 */
app.get('/health', publicCors, (_req, res) => {
  // `null` when the configured store cannot report it (an older Pro build). A rollout must
  // treat that as "cannot confirm it is quiet", not as zero.
  const activeRooms = ext.roomStore.activeCount ? ext.roomStore.activeCount() : null;
  res.json({ ok: true, publicUrl: PUBLIC_URL, activeRooms });
});

// ICE configuration for the browser. Serves STUN plus, when a TURN relay is configured
// (TURN_URL + TURN_SECRET), SHORT-LIVED TURN-REST credentials derived per request from
// the shared secret (coturn `use-auth-secret`): no long-term credentials are stored or
// shipped to the client. Without an own TURN, falls back to a public relay so zero-config
// cross-network calls keep working (unreliable — configure your own coturn for production).
const TURN_URL = (process.env.TURN_URL || '').trim();       // e.g. turn:call.example.org:3478
/**
 * TURN over TLS, usually on 443 — e.g. `turns:turn.example.org:443?transport=tcp`.
 *
 * The reason is the corporate-network case: there, outbound UDP is often blocked entirely and
 * TCP limited to 80/443. The regular relay port 3478 then fails, whether UDP or TCP, and the
 * call cannot be established. Over 443 the traffic looks like HTTPS and passes most filters.
 *
 * Uses the same secret and the same short-lived credentials as `TURN_URL`; it is the same
 * coturn, just a different route to it. Without this variable no TLS route is advertised — an
 * unset value must never advertise an unreachable server.
 */
const TURN_TLS_URL = (process.env.TURN_TLS_URL || '').trim();
const TURN_SECRET = (process.env.TURN_SECRET || '').trim();
const TURN_TTL = Number(process.env.TURN_TTL || 86400);     // credential lifetime, seconds
// STUN_URLS (comma-separated) replaces the defaults; `none` advertises no STUN server at all.
const STUN_DEFAULT = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
const STUN_RAW = (process.env.STUN_URLS || '').trim();
const STUN_LIST = STUN_RAW.split(',').map((u) => u.trim()).filter(Boolean);
const STUN_URLS = STUN_RAW.toLowerCase() === 'none' ? [] : (STUN_LIST.length ? STUN_LIST : STUN_DEFAULT);
// The public relay below is a third party with shared credentials; TURN_PUBLIC_FALLBACK=off
// removes it (default on, as before).
const TURN_PUBLIC_FALLBACK = (process.env.TURN_PUBLIC_FALLBACK || '').trim().toLowerCase() !== 'off';
const FALLBACK_TURN = [
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
app.get('/ice', publicCors, (_req, res) => {
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = (STUN_URLS.length ? [{ urls: STUN_URLS }] : []);
  if (TURN_URL && TURN_SECRET) {
    // TURN REST: username = "<unix-expiry>:<name>", credential = base64(HMAC-SHA1(secret, username)).
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:eudi`;
    const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls: [TURN_URL, `${TURN_URL}?transport=tcp`], username, credential });
    // TLS route LAST: the browser tries entries in order, and relaying over 443 is the
    // slowest path (TLS handshake, TCP overhead, everything through a proxy). It should apply
    // when nothing else works — not be preferred.
    if (TURN_TLS_URL) iceServers.push({ urls: [TURN_TLS_URL], username, credential });
  } else if (TURN_PUBLIC_FALLBACK) {
    iceServers.push(...FALLBACK_TURN);
  }
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers, ttl: TURN_TTL });
});

// Which features this instance enables — the browser hides Pro-only UI unless listed.
// Community: only community features. Pro (EUDI_EDITION=pro): + the whole Pro set. Plus any
// features a loaded Pro module switches on via the seam (ext.enabledFeatures).
function enabledFeatures(): Set<string> {
  const enabled = new Set<string>(COMMUNITY_FEATURE_IDS);
  if (EDITION === 'pro') PRO_FEATURE_IDS.forEach((id) => enabled.add(id));
  for (const id of ext.enabledFeatures) enabled.add(id);
  // Config-gate: only advertise the wallet pass when a signing certificate is set up,
  // so the client button never dead-ends on an unconfigured instance.
  if (!walletPassConfigured()) enabled.delete('wallet-pass');
  // Without a signing secret this instance can neither issue nor verify invitations — so it
  // stays with a plain room link, rather than promising an appointment link that carries
  // nothing after the next restart.
  if (!inviteConfigured()) enabled.delete('planned-invites');
  // Qualified signing is implemented in the commercially licensed Pro module (pro/qes-csc.ts),
  // not here. Without that module the AGPL core has nothing that could sign qualified — so it
  // must not advertise CSC/QTSP providers, whatever EUDI_EDITION says. This is what makes
  // `qes-csc` a Pro feature in substance rather than a switch in open code.
  if (!ext.qualifiedSigner) enabled.delete('qes-csc');
  // Same reasoning for device-bound signatures: the certificate authority lives in pro/.
  if (!ext.certificateIssuer) enabled.delete('qes-device');
  // Without a verifier nothing that rests on a verified identity exists (./core/verifier-mode).
  if (VERIFIER_OFF) for (const id of NEEDS_VERIFIER) enabled.delete(id);
  // LAST: the operator's off switch. After the config gates, so that it also applies when a
  // Pro module contributed a capability via ext.enabledFeatures — the operator's decision
  // takes precedence over everything else. UNSWITCHABLE is already filtered out in
  // parseFeaturesOff (see ./core/features).
  for (const id of FEATURES_OFF.off) enabled.delete(id);
  return enabled;
}
app.get('/capabilities', publicCors, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  // `edition` is the EFFECTIVE edition the client gates on (promo raises it to pro).
  // `configuredEdition` + `promo` stay honest about WHY Pro is on. The client only reads
  // `enabled`, so unlocking Pro during the promo needs no client change.
  // `policy` publishes the WRP scope (allowed attributes, purpose binding, retention,
  // enforcement mode) so the client renders its checkbox group FROM the server's whitelist
  // instead of a hard-coded copy that could drift — and so an integrator can read the
  // scope before sending a request that would be narrowed or refused.
  res.json({
    edition: EDITION, configuredEdition: CONFIGURED_EDITION, promo: PROMO_ALL_PRO,
    enabled: [...enabledFeatures()],
    // 'none' = no wallet verification on this instance (EUDI_VERIFIER=none): the client fixes
    // both sides to anonymous and shows a permanent "test mode" banner. Enforced here, not there.
    verifier: VERIFIER_OFF ? 'none' : 'eudiplo',
    // Does this instance require sign-in before someone can host? The client then shows a
    // SIGN-IN page instead of the setup form. Without this it would keep showing a "what do I
    // share" choice that does not exist — the attributes are enforced, and anyone unticking
    // them is refused without learning why.
    hostLogin: hostGateActive(),
    // Who the wallet will name as asking, when that is not who the page appears to be (see
    // ./relying-party). The client states it above the QR code. Always present, so a client
    // never has to guess from the absence of a field whether disclosure applies.
    relyingParty: RELYING_PARTY,
    // Which operator pages this instance actually has (see ./operator-pages). The footer links
    // them only when they exist: a "Presse" link that 404s is worse than no link, and a
    // self-hoster who has not written a press page must not appear to have one. Resolved live,
    // so a page dropped into the directory shows up without a restart.
    operatorPages: OPERATOR
      ? OPERATOR_PAGES.filter((x) => resolveOperatorPage(OPERATOR, `/${x}`) !== null)
      : [],
    // Media the operator provides (see ./operator-pages). An operator's own pages can use
    // this to tell whether a file is there before pointing a <video> at it — otherwise a
    // missing file shows a broken player rather than nothing.
    operatorMedia: OPERATOR ? availableMedia(OPERATOR) : [],
    // Whether "/" is the operator's own page rather than the application. Announced for the
    // same reason as the pages: so a client can tell without probing.
    operatorHome: OPERATOR ? resolveOperatorHome(OPERATOR) !== null : false,
    policy: policyDescriptor(),
  });
});

/**
 * The WRP policy on its own endpoint — a stable, cacheable reference an auditor or
 * integrator can cite without parsing the capability payload. Same descriptor.
 */
app.get('/wrp-policy', publicCors, (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(policyDescriptor());
});

// The in-call credential catalog (display data only — labels + field names, no DCQL
// internals). Community answers with an empty list; the client then hides the UI, and
// the server-side handlers below refuse regardless (hard gate).
app.get('/credential-catalog', publicCors, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ credentials: enabledFeatures().has('in-call-credentials') ? publicCatalog() : [] });
});

// Signature providers for the in-call QES ceremony. Hard
// edition gate like the credential catalog: CSC/QTSP entries (incl. their OAuth client
// config) only leave the server when the Pro `qes-csc` feature is active — Community
// always gets the mock provider only (demo signature, not legally binding).
app.get('/signature-providers', publicCors, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const features = enabledFeatures();
  res.json({
    providers: publicSignatureProviders(
      features.has('qes-csc'),
      features.has('qes-device') ? (ext.signatureProviders ?? []) : [],
    ),
  });
});

// Room size: full mesh with the `multi-party` capability (Community);
// 1:1 when the operator switches it off. See src/rooms.ts + maxParticipants() in src/server.ts for realistic limits per call mode.
const MAX_PARTICIPANTS_MESH = Math.max(2, Number(process.env.EUDI_MAX_PARTICIPANTS || 5));
function isMultiParty(): boolean { return enabledFeatures().has('multi-party'); }
function maxParticipants(): number {
  return isMultiParty() ? MAX_PARTICIPANTS_MESH : 2;
}

// Audit event for an in-call credential request (claim KEYS only, never values).
// `role`/`clientId` identify the TARGET; `requestedBy` the requesting host.
function credentialAudit(r: CredentialRequest, type: VerificationEventType, claimKeys: string[]): VerificationEvent {
  const ev: VerificationEvent = {
    type, at: new Date().toISOString(),
    roomId: r.room.id, role: r.target.role, clientId: r.target.clientId,
    attrs: r.credential.claims.map(claimKey), claimKeys,
    credentialId: r.credential.id, requestedBy: r.requester.clientId,
  };
  recordVerification(ev);
  return ev;
}

// Webhook branch for an IN-CALL credential request session (Pro). Same token check as
// the gate; claims are extracted via the CATALOG paths (not the PID normalizer) and the
// values go to the REQUESTER only — never into the room broadcast or the logs.
function handleCredentialWebhook(r: CredentialRequest, req: express.Request, res: express.Response): void {
  const presented = String(req.query.t || '');
  const a = Buffer.from(presented);
  const b = Buffer.from(r.webhookToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.warn('[webhook] rejected in-call credential callback: bad/missing token');
    res.status(401).send('unauthorized');
    return;
  }
  const payload = req.body || {};
  if (typeof payload.session === 'string' && payload.session) r.verifierSessionId = payload.session;
  const claims = extractCatalogClaims(r.credential, payload);
  // Success needs a positive signal AND every mandatory claim — a partial presentation
  // the requester can't use must not light up a green badge.
  const ok = isVerificationSuccess(payload, Object.keys(claims).length) && hasMandatoryClaims(r.credential, claims);
  if (ok) {
    finishRequest(r, 'presented');
    // Display rows ordered by catalog declaration; only declared claims are picked up.
    const display = r.credential.claims
      .filter((cl) => claimKey(cl) in claims)
      .map((cl) => ({ name: cl.name, value: claims[claimKey(cl)] }));
    (r.target.presentedCredentials ??= []).push({
      credentialId: r.credential.id, label: r.credential.label,
      forPeerId: r.requester.peerId, claims: display, at: new Date().toISOString(),
    });
    console.log(`[webhook] in-call credential ${r.credential.id} presented, claims=[${Object.keys(claims).join(',')}]`);
    const ev = credentialAudit(r, 'credential-presented', Object.keys(claims));
    firePlugins((p) => p.onVerified?.(ev));
    send(r.requester.ws, {
      type: 'credential-presented', requestId: r.requestId, from: r.target.peerId,
      credentialId: r.credential.id, label: r.credential.label, claims: display,
    });
    send(r.target.ws, { type: 'credential-presented-ack', requestId: r.requestId, credentialId: r.credential.id, label: r.credential.label });
    broadcastStatus(r.room); // requester re-renders badges from status (resume-safe)
  } else {
    if (isVerificationSuccess(payload, Object.keys(claims).length)) {
      console.warn(`[webhook] in-call credential ${r.credential.id}: ok-status but mandatory claims missing — payload shape unknown?`);
    }
    finishRequest(r, 'failed');
    console.log(`[webhook] in-call credential ${r.credential.id} presentation failed`);
    credentialAudit(r, 'credential-failed', []);
    send(r.requester.ws, { type: 'credential-failed', requestId: r.requestId, from: r.target.peerId, label: r.credential.label });
    send(r.target.ws, { type: 'credential-failed', requestId: r.requestId, label: r.credential.label });
  }
  res.status(200).send('OK');
}

// EUDIPLO posts the verification result here once the wallet has responded.
app.post('/webhook/:sessionId', (req, res) => {
  // In-call credential sessions live in their own registry (disjoint UUID namespaces).
  const credentialRequest = requestBySession(req.params.sessionId);
  if (credentialRequest) {
    handleCredentialWebhook(credentialRequest, req, res);
    return;
  }
  const hit = ext.roomStore.findBySession(req.params.sessionId);
  if (!hit) {
    console.warn(`[webhook] no participant for session (left the room?)`);
    res.status(404).send('unknown session');
    return;
  }
  const { room, participant } = hit;

  // Authenticate the callback: the token was embedded in the webhook URL we handed
  // to EUDIPLO; a forged POST that only knows the sessionId won't have it. Constant-
  // time compare to avoid leaking the token via timing.
  const presented = String(req.query.t || '');
  const a = Buffer.from(presented);
  const b = Buffer.from(participant.webhookToken);
  // An EMPTY token is never valid: without this check an empty `?t=` would succeed against an
  // empty stored value (two empty buffers are equal in length and content). Security must not
  // depend on nobody ever clearing the token.
  if (!presented || !participant.webhookToken || a.length !== b.length || !timingSafeEqual(a, b)) {
    console.warn(`[webhook] rejected ${participant.role}: bad/missing token`);
    res.status(401).send('unauthorized');
    return;
  }

  const wsAlive = participant.ws.readyState === participant.ws.OPEN;
  console.log(`[webhook] matched ${participant.role} (${participant.clientId.slice(0, 8)}) wsAlive=${wsAlive}`);
  const payload = req.body || {};

  // Require a POSITIVE proof of a successful presentation (see isVerificationSuccess).
  // normalizeClaims maps any format (mdoc / SD-JWT / …) onto the canonical claim keys.
  const claims = normalizeClaims(payload);
  const success = isVerificationSuccess(payload);
  // Attributes this participant was asked to present (for the audit event).
  const attrs = attrsFor(room, participant);
  // EUDIPLO names its own session in the payload. Preferred over the id we noted when the
  // offer was created: it is the authoritative one, and it keeps the purge working even for
  // an offer whose response carried no id.
  if (typeof payload.session === 'string' && payload.session) participant.verifierSessionId = payload.session;

  if (success) {
    // ZERO RETENTION, and this is the line that makes the phrase true: everything this
    // service will ever know about the presentation has just been read out of `payload`.
    // The verifier's copy — the only persisted one anywhere in this architecture — goes
    // now, not when its TTL expires. Before the host gate below, because a refused host
    // must not leave their claims behind either. See ./verifier-session.
    purgeVerifierSession(participant.verifierSessionId, 'verified');
    participant.verifierSessionId = undefined;
    // REPLAY PROTECTION: the token is consumed from here on. Otherwise both sessionId AND
    // webhookToken would stay valid indefinitely after a successful check — an intercepted
    // callback could be replayed any number of times. The attribute values would stay
    // filtered by the whitelist, so this is not about a data leak but about the RECORD:
    // `recordVerification` and the host gate would run again each time. An audit record
    // showing more events than actually happened is worthless as evidence.
    //
    // Rotated rather than cleared: an empty token would be valid against an empty `?t=` (see
    // above). The FAILURE path deliberately does not rotate — there `reissueAuthOffer` renews
    // the offer under the same session, so the token must stay valid. The in-call credential
    // branch does the same by removing the session entirely in `finishRequest()`.
    participant.webhookToken = randomUUID();
    const { givenName, familyName } = extractNames(payload);
    participant.verified = true;
    // Channel binding: EUDIPLO fails a presentation whose KB-JWT does not carry the
    // transaction_data hashes, or carries them wrongly (sdjwtvcverifier.service.ts). A success
    // AFTER the binding was sent is therefore the proof that the wallet signed exactly this
    // DTLS fingerprint — nothing needs recomputing here.
    participant.channelBound = participant.pendingBinding === true;
    participant.pendingBinding = undefined;
    // `claims` came through normalizeClaims, which copies an allow-list of whitelisted
    // keys — so an over-disclosing presentation cannot widen what we hold here. This
    // object lives in process memory only (see rooms.ts) and is never persisted.
    participant.claims = claims;
    // Derived attributes are computed AFTER the cryptographic check, from the server's own salt —
    // never taken from the payload, so a wallet cannot dictate its own pseudonym.
    if (attrs.some(isDerived)) {
      participant.claims.pseudonym_id = derivePseudonym(room.id, participant.clientId);
    }
    // Prefer claims read from the expected credential path over a whole-payload search.
    participant.givenName = claims.given_name != null ? String(claims.given_name) : givenName;
    participant.familyName = claims.family_name != null ? String(claims.family_name) : familyName;
    // Log only which claim KEYS were presented — never PID values (privacy/DSGVO).
    console.log(`[webhook] ${participant.role} verified, claims=[${Object.keys(claims).join(',')}] kanalgebunden=${participant.channelBound ? 'ja' : 'nein'}`);

    // Host gate (tenant instance, see ./host-gate). HERE and not earlier: the verified name
    // is only known now. Anyone not listed is removed from the room — otherwise an
    // unauthorised host would stay seated while the citizen waits, leaving the room in a
    // half-established state.
    if (participant.role === 'caller' && !mayHost(participant.familyName, participant.givenName)) {
      console.log(`[host-gate] host refused room=${auditHash('room', room.id)} — not on the allowlist`);
      // The event yes, the name no: a refusal must not become the place where PID values
      // suddenly appear in the log.
      recordAudit({
        event: 'host-denied', status: 'refused',
        roomId: room.id, clientId: participant.clientId, role: participant.role, attrs,
      });
      send(participant.ws, { type: 'host-denied' });
      const peers = ext.roomStore.peersOf(room, participant);
      purgeVerifierSession(participant.verifierSessionId, 'left');
      ext.roomStore.remove(room, participant);
      for (const peer of peers) send(peer.ws, { type: 'peer-left', from: participant.peerId });
      if (peers.length) broadcastStatus(room);
      res.status(200).send('OK');
      return;
    }
    // Which format actually arrived? For the audit record — mdoc and SD-JWT VC differ
    // considerably in verifier maturity, so the trust path belongs in the evidence. Not
    // determinable → left empty.
    const presented = detectPresentedProfile(payload, selectedProfiles());
    const ev: VerificationEvent = {
      type: 'verified', at: new Date().toISOString(),
      roomId: room.id, role: participant.role, clientId: participant.clientId,
      attrs, claimKeys: Object.keys(claims),
      credentialFormat: presented?.format, profileId: presented?.id,
    };
    recordVerification(ev);
    firePlugins((p) => p.onVerified?.(ev));
    broadcastStatus(room);
    maybeConnect(room);
  } else {
    console.log(`[webhook] ${participant.role} verification failed`);
    recordVerification({
      type: 'verification-failed', at: new Date().toISOString(),
      roomId: room.id, role: participant.role, clientId: participant.clientId,
      attrs, claimKeys: [],
    });
    send(participant.ws, { type: 'auth-failed' });
    // An offer is consumed by EUDIPLO after ONE attempt ("The presentation offer has already
    // been used"). Without renewal the page would keep showing the same dead QR code — the
    // retry could not possibly succeed.
    void reissueAuthOffer(participant, room, publicOriginFrom(req));
  }

  res.status(200).send('OK');
});

// The operator's own site (see ./operator-pages): short paths, root files, redirects, 404 page.
// Registered AFTER every route of the application on purpose — a file in the operator's directory
// must never hide a function of the application, and placed here it cannot: anything the
// application answers never reaches this point. Without EUDI_OPERATOR_PAGES it is not registered
// and an unknown path ends in Express's plain 404.
if (OPERATOR) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const to = resolveOperatorRedirect(OPERATOR, req.path);
    if (to) { res.redirect(301, to); return; }
    const page = resolveOperatorSitePath(OPERATOR, req.path);
    if (page) { res.set('Cache-Control', 'no-cache').sendFile(page); return; }
    const notFound = resolveOperatorNotFound(OPERATOR);
    if (notFound && req.accepts('html')) {
      res.status(404).set('Cache-Control', 'no-cache').sendFile(notFound);
      return;
    }
    next();
  });
}

const server = http.createServer(app);

const MAX_WS_MESSAGE = 256 * 1024; // SDP/ICE are small; bound frame size against DoS.

// Reject cross-site WebSocket connections (CSWSH). A same-origin browser sends an
// Origin whose host matches the request Host; a foreign attacker page does not.
// Optional ALLOWED_ORIGINS (comma-separated) overrides the same-host heuristic.
// The native app (Capacitor shell) serves its bundle from a local origin and is
// allowed ADDITIVELY via EUDI_APP_ORIGINS (set to "" to refuse app clients).
const APP_ORIGINS = (process.env.EUDI_APP_ORIGINS ?? 'capacitor://localhost,https://localhost,ionic://localhost')
  .split(',').map((s) => s.trim()).filter(Boolean);
function wsOriginAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (no Origin header)
  if (APP_ORIGINS.includes(origin)) return true;
  let originHost: string;
  try { originHost = new URL(origin).host; } catch { return false; }
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length) {
    return allow.some((a) => { try { return new URL(a).host === originHost; } catch { return a === origin; } });
  }
  const host = String(req.headers['x-forwarded-host'] || req.headers['host'] || '').split(',')[0].trim();
  return !!host && originHost === host;
}

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_WS_MESSAGE,
  verifyClient: ({ req }, done) => {
    if (wsOriginAllowed(req)) return done(true);
    console.warn(`[ws] rejected cross-origin connection from ${req.headers.origin}`);
    done(false, 403, 'origin not allowed');
  },
});

/**
 * Liveness check. Without it the server never notices an UNCLEAN disappearance: a closed
 * laptop lid, a dead spot or a killed browser produce no `close`, and the operating system
 * only gives up the TCP connection after hours. The seat would stay occupied that long and the
 * room would report "full" although nobody is there.
 *
 * Whoever fails to answer two consecutive pings counts as gone and is disconnected hard.
 * `terminate()` triggers a regular `close`, so the same paths apply afterwards as when closing
 * a tab: grace period, then the seat is free. Until then the socket is already not open, so
 * the ghost cleanup in joinRoom() can hand out the seat immediately — after at most
 * 2×HEARTBEAT_MS instead of hours.
 */
const HEARTBEAT_MS = 30_000;
const wsAlive = new WeakSet<WebSocket>();
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!wsAlive.has(ws)) { ws.terminate(); continue; }
    wsAlive.delete(ws); // must be re-set by a pong before the next sweep
    try { ws.ping(); } catch { /* socket already tearing down — the next sweep clears it */ }
  }
}, HEARTBEAT_MS);
// Do not keep the process alive (tests, clean shutdown).
heartbeat.unref?.();
wss.on('close', () => clearInterval(heartbeat));

// ---- helpers -------------------------------------------------------------

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// The public origin the wallet/EUDIPLO must reach this server at. An explicit non-localhost
// PUBLIC_URL wins; otherwise derive it from the reverse-proxy headers, so it just works
// behind a proxy such as Traefik without any env config.
function publicOriginFrom(req: http.IncomingMessage): string {
  const env = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  // Honor an explicitly-set PUBLIC_URL (incl. http://localhost for local dev + the
  // EUDIPLO mock). Only a placeholder is ignored; when unset we derive from the proxy
  // headers so it just works behind a reverse proxy without any env config.
  if (env && !env.includes('CHANGE-ME')) return env;
  const h = req.headers;
  // On a WebSocket upgrade the forwarded proto is ws/wss; the webhook is plain
  // HTTP(S), so normalise it (wss -> https, ws -> http).
  let proto = String(h['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto === 'wss') proto = 'https';
  else if (proto === 'ws') proto = 'http';
  if (!proto) proto = 'https';
  const host = String(h['x-forwarded-host'] || h['host'] || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : env || `http://localhost:${PORT}`;
}

function fullName(p?: Participant): string {
  if (!p) return '';
  return [p.givenName, p.familyName].filter(Boolean).join(' ').trim();
}

/** The attributes THIS participant is on the hook for: a guest presents what the host
 *  requested, the host presents what it chose to disclose. Used for the offer and for
 *  every audit event about that participant. */
function attrsFor(room: Room, p: Participant): SemanticAttr[] {
  return p.role === 'callee' ? room.requestedAttrs : room.disclosedAttrs;
}

// Tell each participant about the room config + everyone's state. Actual values
// (names + claims) are withheld until ALL present have confirmed the review — before
// that each side only learns WHICH fields will be shared, never the contents.
function broadcastStatus(room: Room): void {
  const multiParty = isMultiParty();
  const openRoom = multiParty && room.openRoom;
  const confirmedCount = room.participants.filter((p) => p.verified && p.confirmed).length;
  // Open room: values are revealed among the ≥2 confirmed participants; a mid-verify
  // late-joiner doesn't un-reveal the others (per-peer gate below). Otherwise: reveal
  // only once ALL present have confirmed.
  const revealed = openRoom ? confirmedCount >= 2 : (room.participants.length >= 2 && room.participants.every((p) => p.verified && p.confirmed));
  // When the review panel opens on the client. Open room: per-person (as soon as verified).
  // Gathered multi-party (>2 present): once the host started. Otherwise (1:1, or a
  // multi-party-capable room that so far only has host+1 guest): once 2 are present —
  // waiting for an explicit "start" would just be friction for the common 1:1 case.
  const gatheredMultiParty = multiParty && room.participants.length > 2;
  const reviewOpen = openRoom ? true : (gatheredMultiParty ? room.starting : room.participants.length >= 2);
  // Values flow only between people who have BOTH verified and confirmed. Checking the
  // SUBJECT alone is not enough: in an open room, anyone who had merely joined would receive the
  // names and claims of everyone already confirmed — reciprocity, the one thing the review screen
  // promises ("the contents only become visible once both agree"), would not hold.
  //
  // Both terms are needed and they are not the same: the SUBJECT gate stops us handing out the
  // data of someone who has not agreed to share it, the RECIPIENT gate stops us handing data to
  // someone who has not agreed to the exchange at all.
  //
  // For 1:1 and gathered multi-party rooms the extra terms are redundant — there `revealed` already requires
  // every participant present to be verified and confirmed, so both terms are always true.
  const showValues = (recipient: Participant, subject: Participant) =>
    revealed
    && (!openRoom || (recipient.verified && recipient.confirmed))
    && (!openRoom || (subject.verified && subject.confirmed));
  for (const p of room.participants) {
    const peers = ext.roomStore.peersOf(room, p).map((peer) => ({
      peerId: peer.peerId,
      role: peer.role,
      verified: peer.verified,
      confirmed: peer.confirmed,
      // Channel binding. The fingerprint is no secret — it is in the SDP anyway — but the
      // client needs it FROM THE SERVER in order to hold it against the remote description it
      // actually received. Only sent along when the binding is in fact evidenced.
      channelBound: peer.channelBound === true,
      dtlsFingerprint: peer.channelBound ? peer.dtlsFingerprint : undefined,
      name: showValues(p, peer) ? fullName(peer) : undefined,
      claims: showValues(p, peer) ? peer.claims : undefined,
      // In-call catalog credentials the peer presented TO ME (requester-only values;
      // driven from status so a reconnect/resume re-renders the badges).
      credentials: showValues(p, peer)
        ? peer.presentedCredentials?.filter((c) => c.forPeerId === p.peerId)
        : undefined,
    }));
    send(p.ws, {
      type: 'status',
      mode: room.mode,
      requestedAttrs: room.requestedAttrs,
      disclosedAttrs: room.disclosedAttrs,
      configPinned: room.configPinned === true,
      revealed,
      multiParty,
      openRoom,
      starting: room.starting,
      reviewOpen,
      self: {
        peerId: p.peerId, role: p.role, verified: p.verified, confirmed: p.confirmed,
        channelBound: p.channelBound === true,
        name: showValues(p, p) ? fullName(p) : undefined, claims: showValues(p, p) ? p.claims : undefined,
        // What I shared in-call (labels only — I know my own values).
        sharedCredentials: p.presentedCredentials?.map((c) => ({ credentialId: c.credentialId, label: c.label, at: c.at })),
      },
      peers,
    });
  }
}

// The gate: connect only once ALL present participants (≥2) have presented whatever
// they must (verified) AND accepted the pre-connect review (confirmed). Locks the room
// (no late-join, v1 — see src/rooms.ts + maxParticipants() in src/server.ts) and tells everyone which mesh links to open.
// Glare avoidance: of each pair, the LOWER peerId creates the offer.
function maybeConnect(room: Room): void {
  if (isMultiParty() && room.openRoom) return maybeConnectOpen(room);
  if (room.participants.length < 2) return;
  // A genuinely gathered multi-party room (>2 present) waits for the host to press
  // start; 1:1 — and a multi-party-capable room that so far only has host+1 guest —
  // connects automatically, matching reviewOpen in broadcastStatus above.
  if (isMultiParty() && room.participants.length > 2 && !room.starting) return;
  if (!room.participants.every((p) => p.verified && p.confirmed)) return;
  room.locked = true;
  for (const p of room.participants) {
    const peers = ext.roomStore.peersOf(room, p).map((peer) => ({
      peerId: peer.peerId,
      name: fullName(peer),
      role: peer.role,
      initiator: p.peerId < peer.peerId, // I open the offer to peers with a higher id
    }));
    send(p.ws, { type: 'ready', mode: room.mode, peers });
  }
  if (!readyFired.has(room)) {
    readyFired.add(room);
    firePlugins((p) => p.onReady?.({ roomId: room.id, mode: room.mode }));
  }
}

// Open room: connect the confirmed participants pairwise as soon as ≥2 exist; never lock,
// so late-joiners can verify+confirm and get meshed in. Re-run on each verify/confirm/join
// — already-connected pairs are a no-op on the client; new pairs form. Every guest shares
// the SAME attributes, so a late-joiner adds no new consent surface for the others.
function maybeConnectOpen(room: Room): void {
  const active = room.participants.filter((p) => p.verified && p.confirmed);
  if (active.length < 2) return;
  for (const p of active) {
    const peers = active.filter((x) => x !== p).map((peer) => ({
      peerId: peer.peerId,
      name: fullName(peer),
      role: peer.role,
      initiator: p.peerId < peer.peerId,
    }));
    send(p.ws, { type: 'ready', mode: room.mode, peers });
  }
  if (!readyFired.has(room)) {
    readyFired.add(room);
    firePlugins((p) => p.onReady?.({ roomId: room.id, mode: room.mode }));
  }
}

// ---- websocket signaling -------------------------------------------------

wss.on('connection', (ws, request) => {
  const origin = publicOriginFrom(request);

  // Freshly connected counts as alive; every pong confirms it again (see HEARTBEAT_MS).
  wsAlive.add(ws);
  ws.on('pong', () => wsAlive.add(ws));

  // Per-connection token bucket: refill 20/s up to 40 → smooths bursts (a normal
  // session sends a handful of messages) but throttles a flood of join/offer/ice.
  let tokens = 40;
  const refill = setInterval(() => { tokens = Math.min(40, tokens + 20); }, 1000);
  ws.on('close', () => clearInterval(refill));

  ws.on('message', async (raw) => {
    if (tokens <= 0) return; // over budget → silently drop
    tokens--;
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      await handleJoin(ws, String(msg.roomId || ''), String(msg.clientId || ''), msg.wantAuth === true, origin, msg.dtlsFingerprint, msg.inv);
      return;
    }

    // Host (caller) configures the exchange: mode + what to request + what to share.
    // Locked once a guest joins. Changing the host's disclosure re-issues its offer.
    if (msg.type === 'set-config') {
      const hit = ext.roomStore.findByWs(ws);
      if (!hit || hit.participant.role !== 'caller') return;
      const { room, participant: host } = hit;
      if (room.participants.some((p) => p.role === 'callee')) return; // locked
      // Scheduled call: the arrangement is in the invitation the guest agreed to — not even
      // the host can shift it any more (see ./invite-token). The client therefore renders the
      // setup read-only (configPinned in the status).
      if (room.configPinned) return;
      // Without a verifier there is nothing to request or disclose — not even a derived
      // attribute, since pseudonym_id is derived FROM the PID. Refused outright rather than
      // narrowed: a client that asks for attributes here has misread the instance, and should
      // hear so instead of believing its request went through.
      const asks = (v: unknown) => Array.isArray(v) && v.length > 0;
      if (VERIFIER_OFF && (asks(msg.requestedAttrs) || asks(msg.disclosedAttrs))) {
        send(ws, { type: 'error', code: 'verifier-disabled', message: 'this instance runs without a verifier — calls are anonymous' });
        return;
      }
      // Policy gate BEFORE anything is applied, so a violation can never leave the room
      // config half-updated. Both directions go through it together: in strict mode a
      // violation in either one rejects the whole change; in transitional mode both are
      // narrowed and audited, and the corrected config is broadcast below — so even an old
      // client ends up in a state the server actually holds.
      let nextRequest: SemanticAttr[];
      let nextDisclose: SemanticAttr[];
      try {
        nextRequest = applyPolicy(msg.requestedAttrs, room.id, host).attrs;
        nextDisclose = applyPolicy(msg.disclosedAttrs, room.id, host).attrs;
      } catch (e) {
        if (e instanceof PolicyViolationError) {
          auditPolicyViolation(room.id, host, [], e.rejected, 'rejected');
          send(ws, { type: 'error', code: e.code, message: e.message, rejected: e.rejected });
          return; // config unchanged — the client keeps the last accepted state
        }
        throw e;
      }
      if (msg.mode === 'video' || msg.mode === 'audio' || msg.mode === 'chat') room.mode = msg.mode;
      room.openRoom = isMultiParty() && msg.openRoom === true; // late-join multi-guest room
      room.requestedAttrs = nextRequest;
      // ENFORCE BEFORE ANYTHING ELSE. From here on only `newDisclose` exists — the list the
      // client asked for must not survive this block. Two ways it goes wrong if it does:
      //   - The wallet is only asked for what the client wanted, e.g. "requested items:
      //     [family_name]" — the given name is missing, so the gate can never match and refuses its own operator. The dummy verifier hides
      //     this, because it sends both names regardless.
      //   - With an EMPTY selection no offer would be created at all, the host would count as
      //     verified immediately, and since the gate only applies in the webhook they would
      //     get through with NO ID document whatsoever. That is not a blemish; it voids the
      //     gate.
      const newDisclose = enforceHostDisclosure(nextDisclose) as SemanticAttr[];
      // Compare against the equally enforced previous list, otherwise every setup on a tenant
      // instance reports "changed" and triggers another wallet request.
      const changed = JSON.stringify(newDisclose) !== JSON.stringify(room.disclosedAttrs);
      room.disclosedAttrs = newDisclose;
      if (changed) {
        // Nothing to present = anonymous, OR only derived attributes (pseudonym_id needs
        // no wallet ceremony — see requiresWalletPresentation in ./wrp-policy).
        host.verified = !requiresWalletPresentation(newDisclose);
        host.claims = undefined;
        host.offer = undefined;
        host.confirmed = false;
        if (requiresWalletPresentation(newDisclose)) {
          try {
            await ensureAuthOffer(host, newDisclose, origin, room.id);
            send(host.ws, { type: 'auth', uri: host.offer!.uri, crossDeviceUri: host.offer!.crossDeviceUri });
          } catch (e: any) {
            console.error('[eudiplo] host disclosure offer failed:', e?.body || e?.message || e);
            send(host.ws, { type: 'error', message: 'EUDIPLO offer failed' });
          }
        }
      }
      broadcastStatus(room);
      maybeConnect(room);
      return;
    }

    // Pre-connect review: each side accepts or declines.
    // This is the consent record for the symmetric double-opt-in — audited (types only)
    // because "the user agreed" is the legal basis for the exchange that follows, and it
    // must be evidenced.
    // "Renew code" — the case the server cannot detect: the wallet consumed the offer,
    // EUDIPLO rejects it, and the server is not told. Without this path the only remedy
    // would be reloading the page.
    if (msg.type === 'renew-auth') {
      const hit = ext.roomStore.findByWs(ws);
      if (!hit || hit.participant.verified) return;
      void reissueAuthOffer(hit.participant, hit.room, origin);
      return;
    }
    if (msg.type === 'confirm') {
      const hit = ext.roomStore.findByWs(ws);
      if (!hit) return;
      hit.participant.confirmed = true;
      recordAudit({
        event: 'consent-granted', status: 'success',
        roomId: hit.room.id, clientId: hit.participant.clientId, role: hit.participant.role,
        attrs: attrsFor(hit.room, hit.participant),
      });
      broadcastStatus(hit.room);
      maybeConnect(hit.room);
      return;
    }
    // Host starts a multi-party call: lock the room (no more joins) and open the review.
    if (msg.type === 'start-call') {
      const hit = ext.roomStore.findByWs(ws);
      if (!hit || hit.participant.role !== 'caller') return;
      const { room } = hit;
      if (!isMultiParty() || room.starting) return;
      if (room.participants.length < 2) return;         // nobody to call yet
      if (!room.participants.every((p) => p.verified)) return; // wait until everyone present is verified
      room.starting = true;
      room.locked = true;
      broadcastStatus(room);
      maybeConnect(room);
      return;
    }

    if (msg.type === 'decline') {
      const hit = ext.roomStore.findByWs(ws);
      if (!hit) return;
      hit.participant.confirmed = false;
      recordAudit({
        event: 'consent-declined', status: 'rejected',
        roomId: hit.room.id, clientId: hit.participant.clientId, role: hit.participant.role,
        attrs: attrsFor(hit.room, hit.participant),
      });
      for (const peer of ext.roomStore.peersOf(hit.room, hit.participant)) send(peer.ws, { type: 'declined' });
      firePlugins((p) => p.onHangup?.({ roomId: hit.room.id, role: hit.participant.role, clientId: hit.participant.clientId, reason: 'decline' }));
      return;
    }

    // ---- Pairing a phone to sign for a browser participant (Pro, qes-device) ---------
    // See ./device-pairing. The browser (owner) asks for a one-time token and shows it as a QR
    // code; the phone presents it; afterwards this server only relays their WebRTC signalling —
    // the document goes peer to peer and never passes through here.
    if (msg.type === 'pair-create') {
      const reqId = typeof msg.reqId === 'string' ? msg.reqId.slice(0, 64) : '';
      const hit = ext.roomStore.findByWs(ws);
      if (!enabledFeatures().has('qes-device') || !ext.certificateIssuer) return send(ws, { type: 'pair-error', reqId, message: 'unavailable' });
      if (!hit || !hit.participant.verified) return send(ws, { type: 'pair-error', reqId, message: 'not verified' });
      const owner = hit.participant;
      const pairing = createPairing(owner, () => send(owner.ws, { type: 'pair-closed', reason: 'expired' }));
      // The link's origin comes from THIS request (like the wallet's webhook), not from
      // PUBLIC_URL: that constant falls back to localhost when the variable is unset, which is
      // common behind a reverse proxy — the phone's camera would then open localhost:3000.
      send(ws, { type: 'pair-created', reqId, token: pairing.token, url: `${origin}/?pair=${pairing.token}` });
      return;
    }
    if (msg.type === 'pair-join') {
      // A phone, not a participant: it must not be in a room over this connection.
      if (ext.roomStore.findByWs(ws) || pairingOfPhone(ws)) return;
      const token = typeof msg.token === 'string' ? msg.token.slice(0, 128) : '';
      const pairing = token ? joinPairing(token, ws, (p) => {
        send(p.owner.ws, { type: 'pair-closed', reason: 'expired' });
        if (p.phone) send(p.phone, { type: 'pair-closed', reason: 'expired' });
      }) : undefined;
      if (!pairing) return send(ws, { type: 'pair-error', message: 'invalid or used token' });
      send(ws, { type: 'pair-joined', name: fullName(pairing.owner) });
      send(pairing.owner.ws, { type: 'pair-phone-joined' });
      return;
    }
    if (msg.type === 'pair-signal' || msg.type === 'pair-close') {
      const asPhone = pairingOfPhone(ws);
      const hit = asPhone ? undefined : ext.roomStore.findByWs(ws);
      const pairing = asPhone || (hit && pairingOfOwner(hit.participant));
      if (!pairing || !pairing.phone) return;
      const other = asPhone ? pairing.owner.ws : pairing.phone;
      if (msg.type === 'pair-close') {
        endPairing(pairing);
        send(other, { type: 'pair-closed', reason: 'ended' });
        return;
      }
      // Opaque to the server: SDP and ICE candidates. Bounded, because relaying is all it does.
      const data = msg.data;
      if (JSON.stringify(data ?? null).length > 65_536) return;
      send(other, { type: 'pair-signal', data });
      return;
    }

    // ---- Certificate for a device-held signing key (Pro, qes-device) ----------------
    // The device generated its key in the secure element and sends a CSR signed with it. The
    // server decides WHO may ask: only a participant verified in THIS call, over their own signalling
    // connection. The names come from their PID as the verifier reported it, never from the
    // CSR. See CertificateIssuer in ./core/ports.
    if (msg.type === 'device-cert-request') {
      const reqId = typeof msg.reqId === 'string' ? msg.reqId.slice(0, 64) : '';
      const fail = (message: string) => send(ws, { type: 'device-cert-error', reqId, message });
      if (!enabledFeatures().has('qes-device') || !ext.certificateIssuer) return fail('unavailable');
      // Either the participant's own device (the app, in the call) or a phone paired to them
      // (./device-pairing) — then the phone signs FOR the owner, and only while the owner is
      // still in the call.
      const pairing = pairingOfPhone(ws);
      const participant = pairing
        ? (ext.roomStore.findBySession(pairing.owner.sessionId) ? pairing.owner : undefined)
        : ext.roomStore.findByWs(ws)?.participant;
      if (!participant || !participant.verified) return fail('not verified');
      if (!participant.givenName && !participant.familyName) return fail('no name presented');
      // A P-256 CSR is a few hundred bytes; anything far larger is not one.
      const csrB64 = typeof msg.csr === 'string' && msg.csr.length <= 8192 ? msg.csr : '';
      if (!csrB64) return fail('bad request');
      try {
        const issued = await ext.certificateIssuer.issue({
          csrDer: new Uint8Array(Buffer.from(csrB64, 'base64')),
          subject: { givenName: participant.givenName || '', familyName: participant.familyName || '' },
        });
        send(ws, { type: 'device-cert', reqId, chain: issued.certificateChain });
      } catch (e: any) {
        console.warn(`[qes-device] certificate refused: ${e?.message || e}`);
        fail('refused');
      }
      return;
    }

    // ---- In-call credential requests (Pro, server-enforced) -------------------
    // Host asks a participant for a further catalog credential
    // DURING the call. See src/credential-requests.ts for the state machine.
    if (msg.type === 'credential-request') {
      if (!enabledFeatures().has('in-call-credentials')) return; // hard edition gate
      const hit = ext.roomStore.findByWs(ws);
      if (!hit || hit.participant.role !== 'caller') return; // v1: host-only
      const { room, participant: requester } = hit;
      const target = typeof msg.to === 'string' ? ext.roomStore.findByPeerId(room, msg.to) : undefined;
      if (!target || target === requester) return;
      // Mid-call only: both ends of this pair have passed the gate + review.
      if (!(requester.verified && requester.confirmed && target.verified && target.confirmed)) return;
      const credential = catalogEntry(String(msg.credentialId || ''));
      if (!credential) {
        send(ws, { type: 'credential-error', message: 'unknown credential' });
        return;
      }
      if (hasPending(target, credential.id)) {
        send(ws, { type: 'credential-error', message: 'request already pending', credentialId: credential.id, to: target.peerId });
        return;
      }
      const r = createRequest(room, requester, target, credential, CREDENTIAL_REQUEST_TTL_MS, (expired) => {
        credentialAudit(expired, 'credential-expired', []);
        send(expired.requester.ws, { type: 'credential-expired', requestId: expired.requestId, from: expired.target.peerId, label: expired.credential.label });
        send(expired.target.ws, { type: 'credential-expired', requestId: expired.requestId, label: expired.credential.label });
      });
      console.log(`[credential] host requests ${credential.id} from ${target.role} (${target.clientId.slice(0, 8)}) room=${room.id}`);
      credentialAudit(r, 'credential-requested', []);
      send(requester.ws, { type: 'credential-pending', requestId: r.requestId, to: target.peerId, credentialId: credential.id, label: credential.label });
      // The consent prompt: who asks, which credential, EXACTLY which fields — before
      // anything goes near the wallet.
      send(target.ws, {
        type: 'credential-requested', requestId: r.requestId, from: requester.peerId,
        fromName: fullName(requester),
        credential: {
          id: credential.id, label: credential.label, description: credential.description,
          claims: credential.claims.map((cl) => ({ name: cl.name, mandatory: cl.mandatory !== false })),
        },
      });
      return;
    }

    // Target consents → create the EUDIPLO offer and hand back the wallet link/QR.
    if (msg.type === 'credential-accept') {
      const r = requestById(String(msg.requestId || ''));
      const hit = ext.roomStore.findByWs(ws);
      if (!r || !hit || hit.participant !== r.target || r.status !== 'pending') return;
      r.status = 'accepted';
      try {
        if (!r.offer) await ensureCredentialOffer(r, origin, hit.room.id);
        send(r.target.ws, { type: 'credential-auth', requestId: r.requestId, label: r.credential.label, uri: r.offer!.uri, crossDeviceUri: r.offer!.crossDeviceUri });
      } catch (e: any) {
        console.error('[eudiplo] in-call credential offer failed:', e?.body || e?.message || e);
        finishRequest(r, 'failed');
        credentialAudit(r, 'credential-failed', []);
        send(r.target.ws, { type: 'credential-failed', requestId: r.requestId, label: r.credential.label });
        send(r.requester.ws, { type: 'credential-failed', requestId: r.requestId, from: r.target.peerId, label: r.credential.label });
      }
      return;
    }

    if (msg.type === 'credential-decline') {
      const r = requestById(String(msg.requestId || ''));
      const hit = ext.roomStore.findByWs(ws);
      if (!r || !hit || hit.participant !== r.target) return;
      finishRequest(r, 'declined');
      credentialAudit(r, 'credential-declined', []);
      send(r.requester.ws, { type: 'credential-declined', requestId: r.requestId, from: r.target.peerId, label: r.credential.label });
      return;
    }

    // Requester withdraws an open request → the target's prompt closes.
    if (msg.type === 'credential-cancel') {
      const r = requestById(String(msg.requestId || ''));
      const hit = ext.roomStore.findByWs(ws);
      if (!r || !hit || hit.participant !== r.requester) return;
      finishRequest(r, 'cancelled');
      credentialAudit(r, 'credential-cancelled', []);
      send(r.target.ws, { type: 'credential-cancelled', requestId: r.requestId, label: r.credential.label });
      return;
    }

    // Relay SDP/ICE to the ADDRESSED peer (`to` = peerId); the reply carries `from` so
    // the receiver knows which mesh link it belongs to. The server never inspects SDP.
    if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') {
      // Shape guard: signaling payloads are objects. (Frame size is already bounded
      // by the WS maxPayload.)
      if (typeof msg.data !== 'object' || msg.data === null) return;
      const hit = ext.roomStore.findByWs(ws);
      if (!hit) return;
      // Channel binding, server-side half: is the sender really establishing the connection
      // with the certificate they had attested? A client switching to a different key after
      // verification would otherwise have bypassed the binding. The counter-check on the
      // client side (see public/app.js) catches the opposite case — a server lying here.
      if ((msg.type === 'offer' || msg.type === 'answer') && hit.participant.channelBound) {
        const sdpFp = fingerprintFromSdp((msg.data as any).sdp);
        if (sdpFp && sdpFp !== hit.participant.dtlsFingerprint) {
          console.warn(`[channel-binding] SDP fingerprint differs from the bound identity (${hit.participant.role}) — rejected`);
          recordAudit({
            event: 'verification-failed', roomId: hit.room.id, clientId: hit.participant.clientId,
            role: hit.participant.role, status: 'rejected', rejected: ['channel-binding#fingerprint-mismatch'],
          });
          send(ws, { type: 'error', message: 'channel binding mismatch' });
          return;
        }
      }
      const target = typeof msg.to === 'string'
        ? ext.roomStore.findByPeerId(hit.room, msg.to)
        : ext.roomStore.peerOf(hit.room, hit.participant); // 1:1 fallback (no `to`)
      if (target && target !== hit.participant) send(target.ws, { type: msg.type, from: hit.participant.peerId, data: msg.data });
      return;
    }

    // Hangup: I leave the call — tell every peer; each remaining pair keeps talking.
    //
    // Then actually REMOVE me from the room. `hangup` is an explicit, deliberate end —
    // unlike a WebSocket close, which keeps the participant alive for GRACE_MS so a phone
    // returning from the wallet app can resume (see the 'close' handler below). Conflating
    // the two would leave a hung-up participant in the room as verified+confirmed, so re-opening
    // the room URL would resume that ghost, get `ready` again and render a permanent
    // "connecting" call against a peer whose PeerConnection was long gone.
    // With the slot freed, re-opening a finished room either says "room full" (it stays
    // locked) or, once empty, hands out a fresh room. The resume path is unaffected.
    if (msg.type === 'hangup') {
      const hit = ext.roomStore.findByWs(ws);
      if (!hit) return;
      const { room, participant } = hit;
      for (const peer of ext.roomStore.peersOf(room, participant)) {
        send(peer.ws, { type: 'hangup', from: participant.peerId });
      }
      firePlugins((p) => p.onHangup?.({ roomId: room.id, role: participant.role, clientId: participant.clientId, reason: 'hangup' }));
      if (participant.graceTimer) { clearTimeout(participant.graceTimer); participant.graceTimer = undefined; }
      purgeVerifierSession(participant.verifierSessionId, 'left');
      ext.roomStore.remove(room, participant);
    }
  });

  ws.on('close', () => {
    // A paired phone that goes away ends its pairing; the browser learns it at once, rather than
    // waiting for a signature that will not come.
    const asPhone = pairingOfPhone(ws);
    if (asPhone) {
      endPairing(asPhone);
      send(asPhone.owner.ws, { type: 'pair-closed', reason: 'phone-left' });
      return;
    }
    const hit = ext.roomStore.findByWs(ws);
    if (!hit) return;
    const { room, participant } = hit;
    // Don't drop the participant right away: a reconnect (e.g. a phone returning
    // from the wallet app) should resume the same session. Only after the grace
    // period without a reconnect do we free the slot and tell the peer.
    if (participant.graceTimer) clearTimeout(participant.graceTimer);
    const grace = isPlannedRoomId(room.id) ? PLANNED_GRACE_MS : GRACE_MS;
    participant.graceTimer = setTimeout(() => {
      // Open in-call credential requests involving the leaver die with them.
      for (const r of openRequestsInvolving(participant)) {
        finishRequest(r, 'expired');
        credentialAudit(r, 'credential-expired', []);
        const other = r.requester === participant ? r.target : r.requester;
        send(other.ws, { type: 'credential-expired', requestId: r.requestId, from: participant.peerId, label: r.credential.label });
      }
      const peers = ext.roomStore.peersOf(room, participant);
      purgeVerifierSession(participant.verifierSessionId, 'left');
      ext.roomStore.remove(room, participant);
      for (const peer of peers) send(peer.ws, { type: 'peer-left', from: participant.peerId });
      if (peers.length) broadcastStatus(room);
      firePlugins((p) => p.onHangup?.({ roomId: room.id, role: participant.role, clientId: participant.clientId, reason: 'left' }));
      console.log(`[room] removed ${participant.role} (${participant.clientId.slice(0, 8)}) after grace`);
    }, grace);
    console.log(`[room] ${participant.role} (${participant.clientId.slice(0, 8)}) disconnected — ${grace / 1000}s grace`);
  });
});

async function handleJoin(ws: WebSocket, roomId: string, clientId: string, wantAuth = false, origin = PUBLIC_URL, dtlsFingerprint?: unknown, inviteTok?: unknown): Promise<void> {
  if (!roomId) {
    send(ws, { type: 'error', message: 'missing roomId' });
    return;
  }
  // Constrain the client-supplied room id: unguessable-length, URL/log-safe charset.
  // Blocks absurdly long or "speaking" ids (enumeration, log injection, memory abuse).
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(roomId)) {
    send(ws, { type: 'error', message: 'invalid roomId' });
    return;
  }
  if (!clientId) clientId = randomUUID(); // fallback: no resume, but still works

  // Scheduled room: valid invitation required, without exception. Because the marker sits in
  // the room id, the rule applies statelessly and independently of arrival order — a truncated
  // ?room=… without a token can no longer occupy the host seat.
  let invite: InvitePayload | null = null;
  if (isPlannedRoomId(roomId)) {
    const v = verifyInviteForRoom(inviteTok, roomId);
    if (!v.ok) {
      console.log(`[invite] Beitritt abgelehnt room=${roomId} grund=${v.reason}`);
      // Both times, named separately: `opensAt` is the `nbf` from the token, while the
      // appointment starts `INVITE_LEAD_S` later. The start is DERIVED, because the payload
      // does not carry it — change the lead time and the display shifts for tokens already
      // issued. That is the price for leaving the token format untouched and all links in
      // circulation unaffected.
      send(ws, {
        type: 'invite-invalid',
        reason: v.reason,
        opensAt: v.opensAt,
        startsAt: v.opensAt !== undefined ? v.opensAt + INVITE_LEAD_S : undefined,
      });
      return;
    }
    // Hold the arrangement against the WRP policy again BEFORE anyone is in the room: the
    // policy may have tightened between issuing and the appointment, and a token must not
    // outlive it. Refusing before the join saves having to roll back.
    try {
      invite = {
        ...v.payload,
        r: applyPolicy(v.payload.r, roomId, undefined).attrs,
        d: applyPolicy(v.payload.d, roomId, undefined).attrs,
      };
    } catch (e) {
      if (e instanceof PolicyViolationError) {
        auditPolicyViolation(roomId, undefined, [], e.rejected, 'rejected');
        console.log(`[invite] Beitritt abgelehnt room=${roomId} grund=policy rejected=[${e.rejected.join(',')}]`);
        send(ws, { type: 'invite-invalid', reason: 'policy', rejected: e.rejected });
        return;
      }
      throw e;
    }
  }
  // An invitation for an ad-hoc room is not evaluated: role and arrangement are decided by
  // the room id alone, otherwise there would be two routes to the same state.

  // Role from the invitation rather than from arrival order. The room store assigns it
  // "first come, first served" — for a scheduled call that is precisely the cause of the
  // problem. If the guest arrives first, a room without a host comes into being; the rest of
  // the server copes with that (maybeConnect only requires two confirmed participants), and
  // the guest can even verify in advance while waiting.
  const wanted: Role | undefined = invite ? (invite.role === 'host' ? 'caller' : 'callee') : undefined;

  const result = ext.roomStore.join(roomId, ws, clientId, maxParticipants(), { reclaimRole: wanted });
  if ('error' in result) {
    send(ws, { type: 'room-full' });
    console.log(`[room] Beitritt abgelehnt room=${roomId.slice(0, 8)} grund=${result.error}`);
    return;
  }

  const { room, participant, resumed } = result;
  // Second tab of the same person: the old tab lost the seat and must stop reclaiming it —
  // otherwise the two keep tearing the session away from each other.
  if (result.replaced) {
    send(result.replaced, { type: 'session-taken-over' });
    try { result.replaced.close(4001, 'session taken over'); } catch { /* already closed */ }
    console.log(`[room] ${participant.role} (${clientId.slice(0, 8)}) taken over in another tab`);
  }
  if (result.reclaimed) {
    console.log(`[invite] ${participant.role} reclaimed their seat via the invitation room=${roomId.slice(0, 8)}`);
  }
  if (invite) {
    if (wanted && participant.role !== wanted) participant.role = wanted;
    // First join into this room: adopt the agreed scope and pin it.
    if (!room.configPinned) {
      room.mode = invite.m;
      room.requestedAttrs = invite.r;
      room.disclosedAttrs = invite.d;
      room.configPinned = true;
    }
  }
  // Channel binding: the fingerprint MUST be known before the offer, because it travels into
  // the wallet request. That is why the client generates its DTLS certificate up front and
  // reports it here, rather than at SDP exchange time. An unusable value is discarded (the
  // connection then runs without binding), never approximated.
  const fp = normalizeFingerprint(dtlsFingerprint);
  if (fp) {
    // Return with a DIFFERENT key (typically: page reloaded, the browser generates a fresh
    // certificate). The existing binding then applies to a key no longer in use — it lapses,
    // and so does the pending offer, so a new one is built with the currently valid
    // fingerprint. Better to demand another presentation than to claim a binding that points
    // at nothing.
    if (participant.dtlsFingerprint && participant.dtlsFingerprint !== fp) {
      if (participant.channelBound) {
        console.warn(`[channel-binding] ${participant.role} returns with a new key — binding lapses, another presentation required`);
        participant.verified = false;
        participant.channelBound = false;
      }
      participant.offer = undefined;
      participant.pendingBinding = undefined;
    }
    participant.dtlsFingerprint = fp;
  } else if (dtlsFingerprint != null) {
    console.warn(`[channel-binding] unbrauchbarer Fingerprint verworfen (${participant.role})`);
  }
  console.log(`[join] ${participant.role} (${clientId.slice(0, 8)}) room=${roomId} resumed=${resumed} verified=${participant.verified} binding=${fp ? 'angefragt' : 'nein'} session=${auditHash('session', participant.sessionId)}`);
  firePlugins((p) => p.onJoin?.({ roomId: room.id, role: participant.role, clientId: participant.clientId, resumed }));

  // What this participant must present:
  //  - guest (callee): the attributes the host requested
  //  - host (caller): the attributes the host chose to disclose (none → anonymous)
  //  - wantAuth (solo test path) changes nothing here: it must never lower the host's requirements
  // With the host gate active, the host must disclose BOTH given and family name — otherwise
  // there would be nothing to compare and they would never get through. Set on the room, not
  // just on the request, so that interface, wallet query and check all show the same thing.
  if (participant.role === 'caller') {
    room.disclosedAttrs = enforceHostDisclosure(room.disclosedAttrs) as SemanticAttr[];
  }
  // Without a verifier the room's defaults (family name both ways) cannot be met: nobody is
  // asked for anything, so every participant counts as verified-anonymous right below.
  if (VERIFIER_OFF) { room.requestedAttrs = []; room.disclosedAttrs = []; }
  const requiredAttrs = participant.role === 'callee' ? room.requestedAttrs : room.disclosedAttrs;
  // Decide the "nothing to present" case up front so the very first status is correct.
  // Covers both anonymous (empty) and derived-only sets — see ./wrp-policy.
  if (!participant.verified && !requiresWalletPresentation(requiredAttrs)) participant.verified = true;

  send(ws, { type: 'joined', role: participant.role, peerId: participant.peerId, resumed });
  broadcastStatus(room);
  maybeConnect(room); // a resumed-and-confirmed participant jumps straight to the call

  if (participant.verified) return; // nothing to present (or resumed-verified)

  try {
    if (!participant.offer) await ensureAuthOffer(participant, requiredAttrs, origin, roomId);
    send(ws, { type: 'auth', uri: participant.offer!.uri, crossDeviceUri: participant.offer!.crossDeviceUri });
  } catch (e: any) {
    console.error('[eudiplo] offer failed:', e?.body || e?.message || e);
    send(ws, { type: 'error', message: 'EUDIPLO verifier offer failed' });
  }
}

// Resolve Community/Pro extensions BEFORE serving, so every request sees a fully
// initialized set. Community (no EUDI_PRO_MODULE) resolves synchronously-fast.
loadExtensions().then((resolved) => {
  ext = resolved;
  // Point the always-on audit log at the resolved verification sink. Community's sink is
  // a no-op, so the audit log is the only record; Pro's is the retainable trail.
  setAuditForwarder((ev) => {
    try { Promise.resolve(ext.verificationSink.record(ev)).catch((e) => console.warn('[audit] sink failed:', e?.message || e)); }
    catch (e: any) { console.warn('[audit] sink failed:', e?.message || e); }
  });
  // Load (and log) the in-call credential catalog up front, so a broken/missing file
  // is visible at startup — not first when a host opens the request menu.
  if (enabledFeatures().has('in-call-credentials')) loadCatalog();
  // Check the configuration BEFORE the port is open. An incompletely configured instance
  // should not fail first at the initial wallet check in production — there the error is a 401
  // from EUDIPLO and nobody knows which value was missing. Names variables only, never values
  // (see ./core/startup-checks).
  assertProductionConfig({ embedEnabled: enabledFeatures().has('embed') });
  server.listen(PORT, () => {
    console.log(`id-call-web listening on :${PORT}`);
    console.log(`Edition: ${CONFIGURED_EDITION}${PROMO_ALL_PRO ? ' + PROMO (effective: pro)' : ''}`);
    console.log(`WRP policy: name=${activePolicyName()} purpose=${WRP_PURPOSE_ID} attrs=[${policyDescriptor().allowedAttributes.join(',')}] retention=none enforcement=${policyDescriptor().enforcement}`);
    // Under WHOSE registration this instance queries wallets. The worst mix-up in
    // public-authority operation is a subdomain requesting under someone else's identity — it
    // would otherwise go unnoticed, because the interface would be branded and the request
    // would work.
    console.log(VERIFIER_OFF
      ? 'Verifier: NONE (EUDI_VERIFIER=none) — no wallet verification, every call is anonymous'
      : `Verifier: eudiplo-tenant=${verifierTenantId()}${isDefaultVerifierTenant() ? ' (Standard)' : ''}`);
    // Who the person being asked will be told is asking. Unlike the warning further down, this
    // one is not about a misconfiguration — it reports a property of a white-labelled instance
    // that the operator should be able to confirm at a glance.
    {
      const w = relyingPartyWarning(RELYING_PARTY);
      if (w) console.log(w);
    }
    // A narrowed instance asks for less than its registration permits. Report both, because
    // "which attributes does this instance request" is the first question in any data
    // protection review and the answer is now in two places.
    {
      const p = policyDescriptor();
      if (p.narrowed) {
        console.log(`WRP narrowing (EUDI_WRP_NARROW): asking for [${p.allowedAttributes.join(', ')}] of the [${p.registrationPermits.join(', ')}] this policy permits`);
      }
    }
    // Make it visible whether the gate applies. An access control whose state you cannot see
    // is one you rely on mistakenly.
    console.log(hostGateActive()
      ? `Host gate: ACTIVE, ${hostGateSize()} person(s) admitted`
      : 'Host gate: off — anyone can host on this instance');

    // Operator pages: report what was actually found. A mistyped path would otherwise only
    // surface when a visitor clicks the imprint — and an instance without an imprint is a legal
    // problem, not a cosmetic one.
    if (OPERATOR) {
      const missing = OPERATOR_PAGES.filter((x) => !OPERATOR.available.includes(x));
      console.log(`Operator pages: ${OPERATOR.available.join(', ') || 'NONE FOUND'} in ${OPERATOR.dir}`
        + (missing.length ? ` — not provided: ${missing.join(', ')}` : ''));
    }
    console.log(staffGateActive()
      ? 'Staff token: ACTIVE — appointments only with a valid link'
      : 'Staff token: off — any visitor can issue appointments');
    if (enabledFeatures().has('planned-invites') && !staffGateActive()) {
      console.log('⚠️  planned-invites is enabled but EUDI_STAFF_SECRET is not set: POST /invite is open to anyone who can reach this server. Set EUDI_STAFF_SECRET to restrict who can issue appointments.');
    }
    // Make disabled functions visible. A switch whose state you cannot see is one you rely on
    // mistakenly — and in operation people otherwise spend a long time hunting for why a
    // button is missing.
    if (FEATURES_OFF.off.size) {
      console.log(`Disabled (EUDI_FEATURES_OFF): ${[...FEATURES_OFF.off].join(', ')}`);
    }
    if (FEATURES_OFF.unknown.length) {
      console.log(`⚠️  EUDI_FEATURES_OFF names unknown features: ${FEATURES_OFF.unknown.join(', ')} — typo? Valid names are in src/core/features.ts and GET /capabilities.`);
    }
    if (FEATURES_OFF.refused.length) {
      console.log(`⚠️  Not switchable, therefore ignored: ${FEATURES_OFF.refused.join(', ')} — the verified call and the privacy guarantees (attribute whitelist, pseudonym, PII-free record) apply in every instance. A guarantee you can switch off would not be one.`);
    }
    if (activePolicyName() !== 'p2p-call' && isDefaultVerifierTenant()) {
      console.log(`⚠️  This instance runs under WRP policy "${activePolicyName()}" but queries wallets through the DEFAULT verifier tenant. The wallet will therefore show the default identity, not the authority's — the request would run under someone else's registration. An authority instance needs its OWN EUDIPLO tenant with its own certificate (EUDIPLO_CLIENT_ID). Until then the verification dialogue discloses the gap to whoever is asked (see src/relying-party.ts); that makes it honest, not correct.`);
    }
    if (!wrpStrict()) {
      console.log('ℹ️  WRP enforcement is TRANSITIONAL (EUDI_WRP_STRICT unset): out-of-scope attribute requests are narrowed to the whitelist + audited, not refused. Set EUDI_WRP_STRICT=on once the updated app/clients have rolled out.');
    }
    if (PROMO_ALL_PRO) {
      console.log('🎁 LAUNCH PROMO active (EUDI_PROMO_ALL_PRO) — full Pro feature set free for EVERYONE, no gate. Unset to switch back to the configured edition.');
    }
    if (!(TURN_URL && TURN_SECRET) && TURN_PUBLIC_FALLBACK) {
      console.log('⚠️  No own TURN server configured (TURN_URL/TURN_SECRET): /ice hands out the public relay openrelay.metered.ca with shared credentials, so callers\' IP addresses reach that third party. Configure TURN_URL and TURN_SECRET, or set TURN_PUBLIC_FALLBACK=off.');
    }
    console.log(`PUBLIC_URL (env) = ${PUBLIC_URL}`);
    if (!process.env.PUBLIC_URL || PUBLIC_URL.includes('CHANGE-ME') || PUBLIC_URL.startsWith('http://localhost')) {
      console.log('ℹ️  No explicit PUBLIC_URL set — webhook origin is derived per-request from x-forwarded-host/proto (works behind Traefik/Coolify).');
    }
  });
});
