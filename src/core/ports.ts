// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Extension seam ("ports") between the open-source core and its modules. The core depends ONLY
 * on these interfaces; concrete implementations are resolved at startup by ../module-loader.
 *
 * Community ships the default implementations (see ./community). A module can provide its
 * own — e.g. a database-backed RoomStore, an audit-trail VerificationSink, or extra
 * SignalingPlugins — without the core importing any module code.
 *
 * These interfaces are the module API, versioned as MODULE_API_VERSION in ./modules. A change
 * that would break an existing module raises that version.
 */
import type { WebSocket } from 'ws';
import type { Room, Participant, Role, Mode } from '../rooms';
import type { LoadedModule } from './modules';

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
  /** How this person came to the room, as the client says: `creator` opened it, `invited` followed
   *  a link. A link never makes its holder the host — a guest who arrives while the host is away
   *  (longer than the grace period) waits as a guest instead of finding the setup form — and the
   *  creator gets the host seat back. Absent (older clients, embeds): first to arrive hosts. */
  arrival?: 'creator' | 'invited';
  /** More than two only where the host ticked "Gruppenanruf" (room.openRoom): a forwarded link
   *  otherwise let a third person into what the host had set up as a private 1:1 call. */
  groupOnlyIfOpen?: boolean;
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
  /** Of those, how many hold a call — two participants or more. OPTIONAL in the same way; a store
   *  without it is read by its rooms (`activeCount`), the cautious reading. */
  activeCalls?(): number;
  /** Whether a room with this id is open right now. OPTIONAL like activeCount; without it the
   *  callers that need it (the ad-hoc wallet pass) refuse rather than assume. */
  has?(roomId: string): boolean;
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
 * signing flow lives in the module @whosit/qes-csc under the commercial licence. The core merely asks whether a signer
 * is present; without one it never advertises CSC/QTSP providers (enabledFeatures() in
 * ../server.ts), so the AGPL edition cannot claim a capability it does not have.
 *
 * The shape follows CSC API v2 `signatures/signHash`: the browser builds the PAdES signed
 * attributes (public/qes/pades.js) and hashes them; only the HASH goes to the QTSP, never the
 * document. The authorisation (`sad`) comes from the QTSP's own OAuth flow, in which the signer
 * authenticates to the QTSP directly — this server never sees their credentials.
 *
 * Phase 6. Until then the qes-csc module registers a placeholder that refuses with
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
 * A signature provider a module contributes to GET /signature-providers. `module` is the file
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

/**
 * A wallet presentation OUTSIDE a call, for a module (a form, a delivery, a receipt). The core
 * keeps the rules: only attributes the instance's WRP policy permits, exactly those asked for,
 * zero retention at the verifier, values handed to the module once and then dropped, the record
 * without values (implementation: ../presentations).
 */
export interface PresentationPort {
  /** What this instance may ask a wallet for at all — offer nothing else to a form builder. */
  allowedAttributes(): string[];
  /** Start one. Refuses (throws) an attribute the policy does not permit. `origin` is the public
   *  origin the verifier calls back (ModuleContext.publicOrigin); `returnUrl` where a wallet on
   *  the same device sends the browser afterwards. */
  start(req: { attrs: string[]; origin: string; returnUrl?: string }): Promise<PresentationStart>;
  /** A further credential from the instance's catalog (../credential-catalog) instead of PID
   *  attributes — e.g. a driving licence for a form. Refuses an id the catalog does not hold.
   *  Optional, so a module checks for it (cores before 2026-11-02 do not have it). */
  startCredential?(req: { credentialId: string; origin: string; returnUrl?: string }): Promise<PresentationStart>;
  /** Its state. `ok` carries the claims and is answered ONCE — afterwards `unknown`. */
  poll(id: string, secret: string): PresentationState;
  /** Give up on it (the person left); purges the verifier session. */
  cancel(id: string, secret: string): void;
}

export interface PresentationStart {
  id: string;
  /** Required to poll; keep it with the person's session, never in a URL the verifier sees. */
  secret: string;
  /** Same-device link and the QR code content for another device. */
  uri: string;
  crossDeviceUri: string;
  expiresAt: string;
}

export type PresentationState =
  | { state: 'pending' | 'failed' | 'expired' | 'unknown' }
  | {
      state: 'ok';
      /** The attributes that were asked for. */
      attrs: string[];
      /** Canonical claim keys (given_name, family_name, birth_date, address, …) → values; only
       *  attributes from `attrs`, and only those the wallet actually presented. */
      claims: Record<string, unknown>;
      at: string;
      format?: string;
      profileId?: string;
      /** For startCredential: the catalog credential; `claims` are keyed by its claim keys. */
      credential?: string;
    };

/** The instance's staff links (EUDI_STAFF_SECRET, ../staff-token) for a module's own staff
 *  pages. Without a secret there are no staff links: `active()` is false and every token fails —
 *  a module must then keep its staff pages closed, not open. */
export interface StaffPort {
  active(): boolean;
  verify(token: unknown): { ok: true; label: string } | { ok: false };
}

/**
 * Something a module offers to do WITH a participant DURING a call — send a form, have a document
 * signed. The host picks it from the call's "Aktionen" menu; the guest agrees and gets the
 * module's page in a panel over the call, with a one-time token in its address
 * (`?ruf=<token>`). The page exchanges the token (CallPort.redeem) for the guest's identity as
 * verified IN THIS CALL — no second wallet presentation — and reports back when it is done
 * (CallPort.done); the host is told. The same page serves the case without a call, where the
 * module asks the wallet itself (PresentationPort). Implementation: ../call-actions.
 */
export interface ModuleAction {
  /** Unique within the module. */
  id: string;
  /** The host's menu entry, e.g. "Formular senden". */
  label: string;
  /** What the host picks from right now (e.g. the published forms). Empty: not offered. `attrs`
   *  are the PID attributes the choice would take from the call. */
  choices(): ActionChoice[] | Promise<ActionChoice[]>;
  /** The page the guest's panel opens, relative to the instance (e.g. /formular/f/abc). */
  path(choiceId: string): string;
  /** A credential request instead of a page: the choices are catalog credential ids, and the
   *  core runs its own in-call credential flow (consent, wallet, result for the host). */
  credential?: boolean;
}
export interface ActionChoice { id: string; label: string; attrs: string[]; }

/** The call side of an action, for a module's routes. */
export interface CallPort {
  /** Exchange the token from the panel's address — once — for the guest's identity: only
   *  attributes the guest presented in this call AND the chosen action needs, and only while the
   *  guest is still in the call. Null otherwise. */
  redeem(token: string): CallIdentity | null;
  /** The action is finished; the host sees `summary` (no personal data — an entry number). */
  done(token: string, info?: { summary?: string }): boolean;
}
export interface CallIdentity {
  claims: Record<string, unknown>;
  attrs: string[];
  /** When the guest was verified in the call. */
  at: string;
  action: string;
  choice: string;
}

/** What a module's routes get from the core. */
export interface ModuleContext {
  presentations: PresentationPort;
  staff: StaffPort;
  /** The origin the outside world reaches this instance at (proxy headers or PUBLIC_URL). */
  publicOrigin(req: import('http').IncomingMessage): string;
  /** A directory for this module's own files, under the instance's data volume. Created. */
  dataDir: string;
  /** The operator's brand name, or null on whosit itself — for page titles. */
  brandName: string | null;
  /** Actions in a call (ModuleAction): exchange the panel's token, report done. */
  calls: CallPort;
  /** Origins that may frame this instance's pages besides itself — the native app's bundle
   *  origin(s), whose call screen opens an action's page in a panel. For `frame-ancestors`. */
  frameOrigins: string[];
}

/**
 * HTTP routes a module adds. The core mounts the router under `/modules/<id>/` and under each of
 * the module's `clientAliases`, after its browser files and only while one of its features is on.
 * A module may only add: the core's own routes come first and cannot be shadowed.
 */
export type ModuleRoutes = (router: import('express').Router, ctx: ModuleContext) => void;

/** The pluggable pieces the server resolves once at startup. A module's `register()` returns a
 *  subset of these; the loader merges all modules into one. */
export interface Extensions {
  roomStore: RoomStore;
  verificationSink: VerificationSink;
  plugins: SignalingPlugin[];
  /** Capability ids the loaded modules bring — from their manifests (see ./modules). */
  enabledFeatures: string[];
  /** Qualified remote signing — only a module provides one. Optional, so a module build
   *  compiled against an earlier version of this port still satisfies the interface. */
  qualifiedSigner?: QualifiedSigner;
  /** Certificates for device-held signing keys (`qes-device`). Optional, as above. */
  certificateIssuer?: CertificateIssuer;
  /** Signature providers a module adds; offered only while their feature is enabled. */
  signatureProviders?: ContributedSignatureProvider[];
  /** Directory of browser files a module ships, served under /modules/<id>/ (and its aliases). */
  clientAssetsDir?: string;
  /** HTTP routes the module adds (see ModuleRoutes). Optional — an addition, not a change. */
  routes?: ModuleRoutes;
  /** Actions in a call (see ModuleAction). Optional. */
  actions?: ModuleAction[];
  /** The catalog of further credentials a host may request (../credential-catalog) — only a
   *  module provides one (@whosit/nachweise); entries are validated on every read. */
  credentialCatalog?: () => unknown[];
  /** The loaded modules — set by the loader, not by a module. */
  modules?: LoadedModule[];
}
