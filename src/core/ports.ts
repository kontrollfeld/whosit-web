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

/** The pluggable pieces the server resolves once at startup. */
export interface Extensions {
  roomStore: RoomStore;
  verificationSink: VerificationSink;
  plugins: SignalingPlugin[];
  /** Extra feature ids a Pro edition switches on (beyond the active edition's defaults). */
  enabledFeatures: string[];
}
