// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Running without a verifier — `EUDI_VERIFIER=none`.
 *
 * For evaluating the software before one has a relying-party registration: every call is
 * anonymous, no wallet is ever asked for anything, and the whole instance says so. Video, audio,
 * chat, screen sharing, files and document sharing all work; nothing that needs a verified
 * identity is offered.
 *
 * EXPLICIT, never inferred from missing verifier variables. A real deployment with a typo in
 * EUDIPLO_CLIENT_ID must still refuse to start (./startup-checks) — quietly degrading it into an
 * anonymous-only instance would be exactly the "runs somehow, but wrong" the startup check
 * exists to prevent.
 *
 *   EUDI_VERIFIER=eudiplo   (default)  wallet verification through EUDIPLO
 *   EUDI_VERIFIER=none                 no verifier: anonymous calls only
 */
export type VerifierMode = 'eudiplo' | 'none';

export function verifierModeRaw(env: Record<string, string | undefined> = process.env): string {
  return (env.EUDI_VERIFIER || '').trim().toLowerCase();
}

/** The mode; an unknown value counts as `eudiplo` here — ./startup-checks refuses to start on it. */
export function verifierMode(env: Record<string, string | undefined> = process.env): VerifierMode {
  return verifierModeRaw(env) === 'none' ? 'none' : 'eudiplo';
}

export const verifierDisabled = (env?: Record<string, string | undefined>): boolean => verifierMode(env) === 'none';

/**
 * Capabilities that need a verified identity, and therefore do not exist without a verifier:
 * a scheduled invitation carries requested attributes; an in-call credential request asks the
 * wallet; the Apple Wallet pass belongs to scheduled calls; the qualified and device signatures
 * certify the PID's names. Switched off in enabledFeatures() (../server).
 */
export const NEEDS_VERIFIER: readonly string[] = [
  'planned-invites', 'in-call-credentials', 'wallet-pass', 'qes-csc', 'qes-device',
];
