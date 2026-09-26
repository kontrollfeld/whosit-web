// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Feature registry — THE single source of truth for which feature belongs to which edition.
 *
 * `GET /capabilities` computes the enabled set from this list plus the active edition and any
 * loaded Pro extensions; the browser then shows optional UI only for ids that are enabled.
 * There is deliberately no second list any more: a Markdown table alongside this file drifted
 * from it three times, so the reasoning now lives here, next to the data it explains.
 *
 * THE SPLIT — three categories, kept apart on purpose:
 *
 *   1. `edition: 'community'` — part of the published source. That is the large majority, for
 *      a sober reason: a gate that only the browser holds can be lifted with one line in an
 *      open client. It protected no revenue, yet made the free edition look crippled.
 *   2. `edition: 'pro'` — only where we render an actual service in return AND the code lives
 *      in ./pro under the commercial licence: retention with liability (`audit-trail`) and
 *      qualified remote signing (`qes-csc`). A Pro entry whose implementation sits in the AGPL
 *      core is only a switch, and anyone may flip a switch in open code — that is why
 *      `multi-party` moved to Community (2026-09-25) rather than being called Pro.
 *   3. **Switchability** — EVERY capability can be turned off via EUDI_FEATURES_OFF (see
 *      UNSWITCHABLE below). Not a stopgap: public authorities must be able to disable
 *      functions for compliance reasons, not because they failed to pay for them.
 *
 * `clientGated` now says only WHETHER the browser reacts to a capability — it is not an
 * edition boundary. Not to be confused with the tiers of the hosted service: there we control
 * the server, and quotas apply irrespective of this file.
 */
export type Edition = 'community' | 'pro';

export interface Feature {
  id: string;
  title: string;
  edition: Edition;
  /** Whether the browser UI toggles on this capability (vs. purely server-side). */
  clientGated: boolean;
}

export const FEATURES: Feature[] = [
  // Community — always enabled.
  { id: 'calls', title: '1:1 Video/Audio/Chat', edition: 'community', clientGated: false },
  { id: 'eudi-verification', title: 'EUDI PID verification + privacy gate', edition: 'community', clientGated: false },
  { id: 'copy-link', title: 'Copy invite link', edition: 'community', clientGated: false },
  { id: 'self-host', title: 'Self-hosting stack', edition: 'community', clientGated: false },
  // Scheduled calls: the signed invitation carries role, agreed attributes and time window,
  // so an appointment link works without a tab left open (see src/invite-token.ts).
  // Additionally config-gated: without EUDI_INVITE_SECRET the instance cannot sign, the
  // capability stays off, and the client falls back to a plain room link.
  { id: 'planned-invites', title: 'Scheduled calls (signed invitation, role-bound)', edition: 'community', clientGated: true },
  // QES in-call document ceremony (see public/qes/). Community ships the doc
  // sharing + mock signing path; CSC/QTSP signature providers are Pro (Phase 6) and
  // hard-gated server-side via /signature-providers.
  { id: 'qes-in-call', title: 'In-call document sharing & signing ceremony (QES)', edition: 'community', clientGated: true },
  // eIDAS 2.0 / EU 2024/1183 compliance. Community on purpose and by decision
  // (2026-08-06): a WRP guarantee that only holds in the paid edition is not a guarantee,
  // and a self-hoster needs `/wrp-policy` to evidence the scope of THEIR instance.
  // Not clientGated — these are unconditional properties, not toggleable UI. The browser
  // reads the attribute list from /capabilities `policy`, not from this capability set.
  { id: 'wrp-policy', title: 'WRP attribute whitelist, purpose binding + public /wrp-policy descriptor', edition: 'community', clientGated: false },
  // Data MINIMISATION, deliberately not monetised: it lets a host ask for LESS (a handle
  // instead of a name). Paywalling that would invert the privacy story. Derived from a
  // per-process salt, so it also costs nothing to operate.
  { id: 'pseudonym-id', title: 'Ephemeral pairwise pseudonym (pseudonym_id, server-derived)', edition: 'community', clientGated: false },
  // The PII-free metadata record. Pro adds RETENTION on top (audit-trail), not the record.
  { id: 'audit-metadata', title: 'PII-free verification audit log (metadata only, every edition)', edition: 'community', clientGated: false },
  // Channel binding: tie the verified identity to the DTLS key of THIS connection
  // (fingerprint → transaction_data → KB-JWT). Community for the same reason as wrp-policy:
  // a security property that only holds in the paid edition is not a property. The
  // evidencable, exportable RECORD of it stays Pro (audit-trail) — the binding itself does not.
  // Not clientGated: it is a property of the connection, not toggleable UI.
  // EFFECTIVE only with SD-JWT VC — EUDIPLO checks transaction_data there and nowhere else;
  // the mdoc verifier silently ignores the field (see ../channel-binding).
  // OFF BY DEFAULT (EUDI_CHANNEL_BINDING): currently rejected by the wallet, which rightly
  // refuses an unknown transaction_data type — see ../channel-binding.
  { id: 'channel-binding', title: 'Channel binding: identity tied to the connection DTLS key (SD-JWT VC, currently disabled)', edition: 'community', clientGated: false },

  // In-call comfort. All of these were Pro until 2026-08-19; their gate was purely
  // client-side, so an open client lifts it with one line. `meeting-controls` was the
  // clearest case: being able to mute yourself is a precondition of video calling, not an
  // enterprise trait — nobody buys a licence for a mute button, but many dismiss an edition
  // that lacks one.
  { id: 'screen-share', title: 'Screen sharing', edition: 'community', clientGated: true },
  { id: 'calendar-invite', title: 'Calendar invite (.ics/Google)', edition: 'community', clientGated: true },
  { id: 'native-share', title: 'Native share (Web Share)', edition: 'community', clientGated: true },
  { id: 'meeting-controls', title: 'Mute / camera toggles', edition: 'community', clientGated: true },
  { id: 'spotlight', title: 'Spotlight / stage layout (auto-focus on screen-share, fluid stage, per-tile fullscreen)', edition: 'community', clientGated: true },
  { id: 'hand-raise', title: 'Raise hand (signal over the chat DataChannel)', edition: 'community', clientGated: true },
  { id: 'file-transfer', title: 'File transfer over DataChannel', edition: 'community', clientGated: true },
  { id: 'emoji', title: 'Emoji picker', edition: 'community', clientGated: true },
  // Additionally config-gated (EUDI_PASS_*): advertised only when a pass certificate is
  // configured — see enabledFeatures() in server.ts. A self-hoster needs their own Apple
  // certificate for this, which is a stronger gate than any edition check.
  { id: 'wallet-pass', title: 'Appointment pass (Apple Wallet) for scheduled calls', edition: 'community', clientGated: true },

  // Pro — retention with liability. The implementation lives in ./pro under a commercial
  // licence; the core only knows the VerificationSink port.
  { id: 'audit-trail', title: 'Verification audit trail with retention and export', edition: 'pro', clientGated: false },
  // Server-enforced via frame headers (frame-ancestors); the client reads it for embed UX.
  // Community, because embedding needs the OPERATOR's configuration — their portals, their
  // origins. We cannot charge for their own arrangements.
  { id: 'embed', title: 'Embeddable iframe widget', edition: 'community', clientGated: false },
  // Community since 2026-09-25 (was 'pro'). Room size limit: EUDI_MAX_PARTICIPANTS with it,
  // 2 without (operators switch it off via EUDI_FEATURES_OFF=multi-party). The mesh logic is
  // spread through the signalling in ../server.ts and the client in public/app.js — all of it
  // AGPL. As 'pro' it was a one-line switch in open code: it protected no revenue, and the
  // label claimed a protection that did not exist. What we DO charge for is operating group
  // calls at scale (relay capacity, support) on the hosted service — not the code.
  { id: 'multi-party', title: 'Multi-party calls (full mesh)', edition: 'community', clientGated: false },
  // PID in BOTH ARF formats — Community since 2026-08-09 (was 'pro').
  // The trigger was not generosity: channel binding (DTLS fingerprint → transaction_data →
  // KB-JWT) only works with SD-JWT VC in the EUDIPLO verifier. Pro-exclusive SD-JWT would
  // have put the strongest security property behind the paywall — see the detailed reasoning
  // at the `pidSdJwt` profile in ../credential-profiles.ts.
  // WHICH of the permitted profiles are actually offered stays the opt-in
  // `EUDI_CREDENTIAL_PROFILES` (still defaulting to `pid_mdoc` only) — the edition permits,
  // the configuration decides.
  { id: 'multi-credential', title: 'Multi-wallet / multi-format verification (mdoc + SD-JWT VC)', edition: 'community', clientGated: false },
  // The host requests further catalog credentials from a participant DURING the call. See
  // src/credential-requests.ts. Community, because the catalogue and the issuer arrangements
  // behind it belong to the operator.
  { id: 'in-call-credentials', title: 'In-call credential requests (catalogue)', edition: 'community', clientGated: false },
  // Pro, server-ENFORCED, and implemented in ./pro (pro/qes-csc.ts, placeholder until Phase 6):
  // /signature-providers ships CSC/QTSP entries only with this capability. It needs BOTH the
  // Pro edition AND a loaded Pro module that provides the `qualifiedSigner` port — the AGPL
  // core alone cannot sign qualified, so it never advertises that it could (see
  // enabledFeatures() in ../server.ts). Without it there is just the demo provider, permanently
  // labelled as not legally binding. Qualified remote signing requires a contract with a trust
  // service provider and costs money per signature.
  { id: 'qes-csc', title: 'Qualified remote signature via CSC/QTSP (QES ceremony, Phase 6)', edition: 'pro', clientGated: false },
  // Pro, server-ENFORCED, implemented in ./pro (pro/qes-device.ts + pro/client/device-local.js)
  // and in the proprietary app (native DeviceSigner plugin). The signing key is generated in the
  // phone's secure element behind biometrics and never leaves it; a certificate authority
  // certifies it once, from the PID the participant presented in this call. This is the model
  // a QTSP will follow for wallet-held keys — until one does, the authority is a DEMO CA and the
  // signature is NOT legally binding. Needs the Pro edition AND the Pro module's
  // `certificateIssuer`, like qes-csc. The key is only reachable from the app — WebCrypto cannot
  // reach the secure element — so a browser participant signs with their PAIRED phone instead
  // (QR code, ../device-pairing.ts, pro/client/paired-phone.js).
  { id: 'qes-device', title: 'Device-bound signature (Secure Enclave / StrongBox, biometric) with a demo CA', edition: 'pro', clientGated: false },
];

export const COMMUNITY_FEATURE_IDS = FEATURES.filter((f) => f.edition === 'community').map((f) => f.id);
export const PRO_FEATURE_IDS = FEATURES.filter((f) => f.edition === 'pro').map((f) => f.id);

export const ALL_FEATURE_IDS: readonly string[] = FEATURES.map((f) => f.id);

/**
 * Capabilities that CANNOT be switched off — for two different reasons.
 *
 * `calls` and `eudi-verification` are the product. Without them there is no verified call,
 * just a server listening on port 3000.
 *
 * `wrp-policy`, `pseudonym-id` and `audit-metadata` are the compliance guarantees — and this
 * is the actual point: **a guarantee the operator can switch off is not a guarantee.** If the
 * attribute whitelist were disableable, nobody could infer from the presence of this software
 * that it is being honoured — which is its entire purpose. Being unswitchable IS the property,
 * not a restriction of it.
 *
 * `self-host` is not a runtime function but a statement about how this is shipped.
 */
export const UNSWITCHABLE: readonly string[] = [
  'calls', 'eudi-verification', 'wrp-policy', 'pseudonym-id', 'audit-metadata', 'self-host',
];

/**
 * Capabilities the operator has switched off, from `EUDI_FEATURES_OFF` (comma-separated).
 *
 * Public authorities must be able to disable functions for compliance reasons — "file transfer
 * during a citizen consultation: not permitted" is a realistic sentence from a real data
 * protection concept, and until now there was no way to honour it. Applies to EVERY capability
 * (Pro ones included: holding a licence does not mean you want the feature on), except those
 * in UNSWITCHABLE.
 *
 * The result also reports what was ignored, so startup can log it. A typo in a feature id
 * should be visible rather than silently doing nothing.
 */
export function parseFeaturesOff(raw: string | undefined = process.env.EUDI_FEATURES_OFF): {
  off: Set<string>;
  unknown: string[];
  refused: string[];
} {
  const wanted = (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  const off = new Set<string>();
  const unknown: string[] = [];
  const refused: string[] = [];
  for (const id of wanted) {
    if (!ALL_FEATURE_IDS.includes(id)) { unknown.push(id); continue; }
    if (UNSWITCHABLE.includes(id)) { refused.push(id); continue; }
    off.add(id);
  }
  return { off, unknown, refused };
}
