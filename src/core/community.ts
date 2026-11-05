// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Community Edition default implementations of the extension ports.
 * These preserve the exact current behavior: in-memory rooms + no verification sink.
 */
import { joinRoom, peerOf, peersOf, findByPeerId, findBySession, findByWs, removeParticipant, activeRoomCount, hasRoom } from '../rooms';
import type { RoomStore, VerificationSink, VerificationEvent } from './ports';

/** In-memory room store — the existing rooms.ts module behind the RoomStore port. */
export const communityRoomStore: RoomStore = {
  join: joinRoom,
  peerOf,
  peersOf,
  findByPeerId,
  findBySession,
  findByWs,
  remove: removeParticipant,
  activeCount: activeRoomCount,
  has: hasRoom,
};

/** Verification events go nowhere in Community; Pro replaces this with an audit trail. */
export const noopVerificationSink: VerificationSink = {
  record(_ev: VerificationEvent): void { /* no-op */ },
};
