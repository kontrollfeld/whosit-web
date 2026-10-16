// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/* Validation view for the in-call signing ceremony.
 *
 * Analyzes EVERY signature embedded in the current PDF — including pre-existing ones
 * in a document that arrived already signed — and produces one verdict per signature:
 *
 *   - cryptographic CMS check against the signature's own ByteRange
 *   - certificate details (subject, issuer, serial, validity, self-signed → demo)
 *   - claimed signing time from the signed attributes
 *   - ByteRange coverage: which portion of the file the signature protects; the
 *     NEWEST signature must cover the entire file (minus its /Contents gap)
 *   - identity binding against BOTH call participants ("Du" / peer / none)
 *
 * Honest scope: this is a browser-side plausibility check for the demo ceremony —
 * chain building, revocation (OCSP/CRL) and qualified-status checks are exactly what
 * ETSI-compliant validators (EU DSS) exist for; the UI links there for anything that
 * has to be legally reliable.
 */

import { extractSignatureRanges, verifyExtractedSignature, matchIdentity } from './identity.js';

/**
 * Analyze all signatures in `bytes`.
 * identities = [{ label, pid: { givenName, familyName } }, …] — the call participants.
 * Returns [{ index, verified, details, signingTime, coverage, binding }].
 */
export async function analyzeAllSignatures(bytes, identities) {
  const sigs = extractSignatureRanges(bytes);
  const total = bytes.byteLength;
  const out = [];
  for (let i = 0; i < sigs.length; i++) {
    const sig = sigs[i];
    const r = await verifyExtractedSignature(bytes, sig);
    const [b0, l0, b1, l1] = sig.ranges;
    const end = b1 + l1;
    const coverage = {
      from: b0, to: end,
      // A PAdES signature must start at byte 0; the newest one must reach the file end.
      complete: b0 === 0 && (i < sigs.length - 1 || end === total),
      wholeFile: b0 === 0 && end === total,
    };
    // Whose signature is this? Try every participant; first match wins.
    let binding = { status: r.details ? 'none' : 'invalid', label: '' };
    if (r.details) {
      for (const id of identities) {
        const m = matchIdentity(r.details.subject, id.pid);
        if (m.status === 'match') { binding = { status: 'match', label: id.label }; break; }
        if (m.status === 'unknown') binding = { status: 'unknown', label: '' };
      }
    }
    out.push({ index: i + 1, verified: r.verified, details: r.details, signingTime: r.signingTime, coverage, binding });
  }
  return out;
}
