// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Extension seam ("ports") between the open-source Community core and an optional,
 * closed-source Pro edition. The core depends ONLY on these interfaces; concrete
 * implementations are resolved at startup by ../pro-loader.
 *
 * Community ships the default implementations (see ./community). Pro can provide its
 * own — e.g. a database-backed RoomStore, an audit-trail VerificationSink, or extra
 * SignalingPlugins — without the core importing any Pro code.
 */
import type { WebSocket } from 'ws';
import type { Room, Participant, Role, Mode } from '../rooms';

export type { Room, Participant, Role, Mode };

export type JoinResult =
  | {
      room: Room;
      participant: Participant;
      resumed: boolean;
      /** On resume, was there still an OPEN socket on this participant — i.e. was the seat
       *  taken over by a second tab? Then the old tab must learn of it and stop reconnecting,
       *  otherwise the two keep reclaiming the seat from each other in turn. */
      replaced?: WebSocket;
      /** The seat was reclaimed via the invitation rather than newly occupied (see
       *  `reclaimRole`). The participant is reset to unverified in the process. */
      reclaimed?: boolean;
    }
  | { error: 'full' };

export interface JoinOptions {
  /** Scheduled call: the role comes from the signed invitation, not from arrival order.
   *  The invitation therefore IS the role — whoever holds the guest link,
   *  may reclaim the guest seat even after losing their tab, mid-call included.
   *  Only set once the invitation has already been verified. */
  reclaimRole?: Role;
}

export interface Located {
  room: Room;
  participant: Participant;
}

/**
 * Where room/participant state lives. Community: in-memory (rooms.ts).
 * Pro could back this with a database for persistence/HA. Methods mirror the current
 * in-memory module and stay synchronous to preserve the core's control flow.
 */
export interface RoomStore {
  join(roomId: string, ws: WebSocket, clientId: string, maxParticipants?: number, opts?: JoinOptions): JoinResult;
  /** All other participants in the room (mesh peers). */
  peersOf(room: Room, p: Participant): Participant[];
  /** Back-compat: the single other participant, if any. */
  peerOf(room: Room, p: Participant): Participant | undefined;
  findByPeerId(room: Room, peerId: string): Participant | undefined;
  findBySession(sessionId: string): Located | undefined;
  findByWs(ws: WebSocket): Located | undefined;
  remove(room: Room, p: Participant): void;
  /**
   * How many rooms are currently held — what a restart would destroy. Read by `GET /health`
   * so a rollout can wait for a quiet moment per instance.
   *
   * OPTIONAL, so a Pro build compiled against an earlier version of this port still satisfies
   * the interface (same reasoning as `VerificationEvent.purposeId`). A store that does not
   * implement it reports "unknown" rather than zero — claiming zero would tell a rollout it is
   * safe to restart precisely when it cannot know.
   */
  activeCount?(): number;
}

/**
 * A verification lifecycle event. Carries only claim KEYS, never PID VALUES — the
 * privacy guarantee that holds in logs also holds here.
 *
 * The `credential-*` types cover in-call credential requests (Pro, see
 * src/credential-requests.ts): `role`/`clientId` identify the TARGET (the participant
 * asked to present), `requestedBy` the requesting host, `credentialId` the catalog entry.
 */
export type VerificationEventType =
  | 'verified' | 'verification-failed'
  | 'credential-requested' | 'credential-presented' | 'credential-declined'
  | 'credential-failed' | 'credential-expired' | 'credential-cancelled';

export interface VerificationEvent {
  type: VerificationEventType;
  at: string;          // ISO-8601 timestamp
  roomId: string;
  role: Role;
  clientId: string;
  attrs: string[];     // attributes the participant was asked to present
  claimKeys: string[]; // keys actually presented (values withheld by design)
  credentialId?: string;  // in-call requests: catalog credential id
  requestedBy?: string;   // in-call requests: clientId of the requesting host
  /** The WRP purpose this presentation was bound to (see ../wrp-policy). Purpose
   *  binding is what makes the attribute whitelist defensible, so the trail records it
   *  alongside the attribute types. Optional for backwards compatibility with a Pro
   *  build compiled against an earlier version of this port. */
  purposeId?: string;
  /** Which credential format the wallet actually presented (`mso_mdoc`,
   *  `dc+sd-jwt`) and via which profile. For evidence purposes: which trust path applied?
   *  Optional — not every response allows this to be determined. */
  credentialFormat?: string;
  profileId?: string;
}

/**
 * Where verification events go. Community: no-op. Pro: an audit trail
 * (who verified what, when) with compliance export — the first planned Pro feature.
 */
export interface VerificationSink {
  record(ev: VerificationEvent): void | Promise<void>;
}

export interface JoinContext { roomId: string; role: Role; clientId: string; resumed: boolean; }
export interface ReadyContext { roomId: string; mode: Mode; }
export interface HangupContext { roomId: string; role: Role; clientId: string; reason: 'hangup' | 'decline' | 'left'; }

/**
 * Optional hooks into the signaling lifecycle. Every method is optional and best-effort:
 * a throwing/rejecting hook is logged and swallowed — it must never break signaling.
 */
export interface SignalingPlugin {
  name: string;
  onJoin?(ctx: JoinContext): void | Promise<void>;
  onVerified?(ev: VerificationEvent): void | Promise<void>;
  onReady?(ctx: ReadyContext): void | Promise<void>;
  onHangup?(ctx: HangupContext): void | Promise<void>;
}

/**
 * Qualified remote signing (QES) at a trust service provider via the CSC API v2 — the
 * `qes-csc` capability. **Pro only, and deliberately without a Community implementation:** the
 * signing flow lives in ./pro under the commercial licence. The core merely asks whether a signer
 * is present; without one it never advertises CSC/QTSP providers (enabledFeatures() in
 * ../server.ts), so the AGPL edition cannot claim a capability it does not have.
 *
 * The shape follows CSC API v2 `signatures/signHash`: the browser builds the PAdES signed
 * attributes (public/qes/pades.js) and hashes them; only the HASH goes to the QTSP, never the
 * document. The authorisation (`sad`) comes from the QTSP's own OAuth flow, in which the signer
 * authenticates to the QTSP directly — this server never sees their credentials.
 *
 * Phase 6. Until then the Pro module registers a placeholder that refuses with
 * `NotYetAvailable`. When the real flow lands, the HTTP route that calls `signHash` must be
 * bound to a verified participant's session — a signing endpoint reachable without that would
 * sign for anyone.
 */
export interface QualifiedSigner {
  /** Signature provider kinds this signer serves (see ../signature-providers). */
  kinds: Array<'csc'>;
  signHash(req: QualifiedSignRequest): Promise<QualifiedSignResult>;
}

export interface QualifiedSignRequest {
  /** Id of the `csc` entry in the signature provider list. */
  providerId: string;
  /** Base64 hashes of the signed attributes, one per document. */
  hashes: string[];
  /** OID of the hash algorithm, e.g. 2.16.840.1.101.3.4.2.1 for SHA-256. */
  hashAlgorithmOid: string;
  /** The QTSP's signing credential and the Signature Activation Data from its OAuth flow. */
  credentialId: string;
  sad: string;
}

export interface QualifiedSignResult {
  /** Base64 raw signature values, same order as `hashes`. */
  signatures: string[];
  /** Base64 DER certificate chain of the signing certificate, leaf first. */
  certificateChain: string[];
}

/**
 * Certificates for signing keys that live on the participant's DEVICE — the `qes-device`
 * capability. **Pro only, no Community implementation**, for the same reason as
 * `QualifiedSigner`.
 *
 * The model is the one a QTSP will follow once it certifies wallet-held keys: the key pair is
 * generated in the phone's secure element (Secure Enclave / StrongBox) and never leaves it; the
 * certificate authority identifies the holder ONCE — here through the PID they just presented
 * in this call — and certifies the public key. Every signature afterwards happens on the device,
 * behind biometrics, with no further call to anyone.
 *
 * The core's part is deliberately narrow: it decides WHO may ask (a participant verified in this
 * call, over their own signalling connection) and hands over the names the verifier reported.
 * The issuer decides everything else. It must never take the subject from the CSR: a CSR is
 * written by the client, the PID was checked by the verifier.
 */
export interface CertificateIssuer {
  issue(req: CertificateRequest): Promise<IssuedCertificate>;
}

export interface CertificateRequest {
  /** DER PKCS#10, signed with the device key — the proof that the requester holds it. */
  csrDer: Uint8Array;
  /** From the PID this participant presented in this call — never from the CSR. */
  subject: { givenName: string; familyName: string };
}

export interface IssuedCertificate {
  /** Base64 DER, leaf first, then the issuing CA. */
  certificateChain: string[];
}

/**
 * A signature provider a Pro module contributes to GET /signature-providers. `module` is the file
 * in `clientAssetsDir` that implements it in the browser; the client loads it from there, so the
 * code never ships with the AGPL client.
 */
export interface ContributedSignatureProvider {
  id: string;
  kind: 'device-local';
  label: string;
  maxLevel: 'B-B' | 'B-T' | 'B-LT' | 'B-LTA';
  module: string;
  /** Where to get the app this provider needs (App Store / TestFlight), shown to those without it. */
  appUrl?: string;
}

/** The pluggable pieces the server resolves once at startup. */
export interface Extensions {
  roomStore: RoomStore;
  verificationSink: VerificationSink;
  plugins: SignalingPlugin[];
  /** Extra feature ids a Pro edition switches on (beyond the active edition's defaults). */
  enabledFeatures: string[];
  /** Qualified remote signing — only a Pro module provides one. Optional, so a Pro build
   *  compiled against an earlier version of this port still satisfies the interface. */
  qualifiedSigner?: QualifiedSigner;
  /** Certificates for device-held signing keys (`qes-device`). Optional, as above. */
  certificateIssuer?: CertificateIssuer;
  /** Signature providers the Pro module adds; offered only while their feature is enabled. */
  signatureProviders?: ContributedSignatureProvider[];
  /** Directory of browser modules the Pro module ships, served under /pro-client/. */
  clientAssetsDir?: string;
}
