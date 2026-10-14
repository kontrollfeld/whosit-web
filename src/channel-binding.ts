// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Channel binding — tying the presented identity to THIS WebRTC connection.
 *
 * Verification answers "who are you". Without binding, however, a valid presentation only
 * proves that a genuine wallet took part SOMEWHERE — not that it sits at the other end of
 * this particular call. Binding closes that gap: the endpoint's DTLS fingerprint goes into
 * the wallet request as `transaction_data`, the wallet signs its hash inside the KB-JWT, and
 * the verifier checks it.
 *
 * WHAT THIS PROVES: the identity belongs to this DTLS key. A presentation intercepted and
 * replayed elsewhere is detected.
 *
 * WHAT IT DOES NOT PROVE: protection against our own, fully compromised server — it sits
 * between the wallet response and the display and could forge both. The defensible claim is
 * "bound to the channel", not "end-to-end secured against the operator".
 *
 * FORMAT-DEPENDENT, and that is the dangerous part: EUDIPLO 6.2.0 validates
 * `transaction_data` ONLY on the SD-JWT path (`sdjwtvcverifier.service.ts`,
 * `validateTransactionDataHashes`). In the mdoc verifier the field does not appear once — it
 * would accept it and silently ignore it. Hence `bindingSupported()`: better to claim no
 * binding at all than one nobody checks.
 */
import { createHash } from 'crypto';
import type { CredentialProfile } from './credential-profiles';

/**
 * OFF until a wallet-supported transaction_data type is established.
 *
 * Measured on 2026-08-10 with the SPRIND wallet: it rejects the request with
 * "Invalid DCQL query: Unsupported transaction data type: eu.whosit.channel-binding.v1".
 * That is CORRECT behaviour and not a wallet bug — OpenID4VP requires a wallet to refuse a
 * `transaction_data` type it does not know, rather than sign something whose meaning it does
 * not understand. A custom type therefore cannot simply be invented; the wallet has to
 * support it.
 *
 * Consequence: binding is OFF by default. Without this switch the service behaves exactly as
 * before. `EUDI_CHANNEL_BINDING_TYPE` allows setting a supported type later without touching
 * the code.
 */
export function bindingEnabled(): boolean {
  return (process.env.EUDI_CHANNEL_BINDING ?? 'off') === 'on';
}

/** Type identifier inside the transaction_data entry. Versioned, because the field ends up
 *  in a signed record and must stay interpretable later. Overridable, because the type MUST
 *  be accepted by the wallet (see bindingEnabled). */
export const CHANNEL_BINDING_TYPE =
  process.env.EUDI_CHANNEL_BINDING_TYPE || 'eu.whosit.channel-binding.v1';

/** SHA-256 fingerprint as 32 uppercase byte pairs: `AB:CD:…` (95 characters). */
const FP_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;

/**
 * Bring a fingerprint into canonical form, or discard it.
 *
 * Accepts both spellings found in the wild: with a leading algorithm (`sha-256 ab:cd:…`, as
 * it appears in SDP) and without (as `RTCCertificate.getFingerprints()` returns it). Anything
 * else — in particular weaker algorithms such as sha-1 — is discarded rather than converted:
 * a fingerprint we cannot unambiguously identify as SHA-256 must not feed into a security
 * claim.
 */
export function normalizeFingerprint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s.length > 200) return null;                 // Schranke gegen absurde Eingaben
  const m = /^([A-Za-z0-9-]+)[\s:]+(.*)$/.exec(s);
  if (m && m[1].includes('-')) {                   // Verfahren vorangestellt?
    if (m[1].toLowerCase() !== 'sha-256') return null;
    s = m[2].trim();
  }
  s = s.toUpperCase();
  return FP_RE.test(s) ? s : null;
}

/** Reads `a=fingerprint:sha-256 …` from an SDP. Deliberately accepts ONLY sha-256 — an offer
 *  carrying nothing but a weaker fingerprint counts as not bindable, rather than as
 *  "close enough". */
export function fingerprintFromSdp(sdp: unknown): string | null {
  if (typeof sdp !== 'string') return null;
  const m = /^a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)\s*$/im.exec(sdp);
  return m ? normalizeFingerprint(m[1]) : null;
}

/**
 * Can binding work at all with the active profiles?
 *
 * Only if EVERY offered profile supports the check. With a mix of SD-JWT and mdoc the wallet
 * decides which format to present — were mdoc to come back, the binding would go unverified
 * while we had already claimed it.
 */
export function bindingSupported(profiles: readonly CredentialProfile[]): boolean {
  if (!bindingEnabled()) return false;
  return profiles.length > 0 && profiles.every((p) => p.format === 'dc+sd-jwt');
}

/** A transaction_data entry as EUDIPLO expects it. `type` and a non-empty `credential_ids`
 *  are mandatory (transaction-data.validator.ts); everything else is free-form. */
export interface TransactionDataEntry {
  type: string;
  credential_ids: string[];
  [key: string]: unknown;
}

/**
 * Build the transaction_data entry — as an OBJECT, not base64url-encoded.
 *
 * EUDIPLO does the encoding itself, and that matters: what gets hashed is exactly the string
 * EUDIPLO writes into the request object. Supplying it pre-encoded would produce a double
 * encoding — and the request would be rejected at type validation anyway (`type` would not be
 * a string but an encoded blob without fields).
 *
 * `credential_ids` refers to the ids in the DCQL query; our ids ARE the profile ids (see
 * buildDcql), so the mapping is exact.
 *
 * The room enters ONLY as a hash. It is a secret — whoever knows it can join — and
 * transaction_data is readable by the wallet and ends up in its history.
 */
export function buildTransactionData(input: {
  credentialIds: readonly string[];
  fingerprint: string;
  roomId: string;
}): TransactionDataEntry {
  return {
    type: CHANNEL_BINDING_TYPE,
    credential_ids: [...input.credentialIds],
    // Which hash algorithms we accept for the hashes inside the KB-JWT.
    transaction_data_hashes_alg: ['sha-256'],
    dtls_fingerprint: input.fingerprint,
    channel: 'webrtc-dtls-srtp',
    room_ref: createHash('sha256').update(input.roomId).digest('hex').slice(0, 16),
  };
}
