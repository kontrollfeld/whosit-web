// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Network pre-flight — can this network carry a call at all?
 *
 * On corporate and government networks calls fail at firewalls, and until now nobody noticed until
 * the call collapsed: the client reported the failure only once the connection had already failed
 * — in the middle of the appointment, with no explanation and no way out. This check runs quietly
 * in the background when the page loads and speaks up ONLY when something is in the way.
 *
 * METHOD: a dedicated RTCPeerConnection using exactly the ICE servers the call uses (otherwise it
 * would be testing something other than reality), a throwaway DataChannel, an offer — and then an
 * evaluation of which candidate types the browser finds.
 *
 * WHY getStats() AND NOT THE CANDIDATE LINE: measured on 2026-08-12 against real production, a
 * relay candidate ALWAYS carries `udp` in the SDP line, even when the relay was reached over TCP —
 * that field describes the relay<->peer leg, not browser<->relay. Whether we got out over TCP is
 * stated only in `RTCIceCandidateStats.relayProtocol`. A classifier parsing the line would be
 * silently wrong: it would report "UDP works" where in truth only TCP carried.
 */

/**
 * Candidate statistics -> verdict. A pure function, checkable without a browser
 * (see scripts/test-netcheck.mjs).
 *
 * @param {Array<{candidateType?: string, relayProtocol?: string}>} cands
 * @returns {{verdict: 'direct'|'relay-only'|'blocked', relayVia: string[], types: string[]}}
 */
function classifyCandidates(cands) {
  const types = new Set();
  const relayVia = new Set();
  for (const c of cands || []) {
    if (!c || !c.candidateType) continue;
    types.add(c.candidateType);
    if (c.candidateType === 'relay' && c.relayProtocol) relayVia.add(c.relayProtocol);
  }
  // srflx means a STUN response came back, so outgoing UDP is open. A direct connection is then
  // likely — and even if not, the relay stands ready.
  const verdict = types.has('srflx') ? 'direct'
    : types.has('relay') ? 'relay-only'
    : 'blocked';
  return { verdict, relayVia: [...relayVia].sort(), types: [...types].sort() };
}

/**
 * The check in the browser. Returns the same verdict as classifyCandidates, plus the measured
 * duration. Never throws — a failure of the check must not prevent a call.
 */
async function runNetCheck(iceServers, { timeoutMs = 8000 } = {}) {
  const started = Date.now();
  let pc = null;
  try {
    if (typeof RTCPeerConnection !== 'function') return { verdict: 'unknown', relayVia: [], types: [] };
    pc = new RTCPeerConnection({ iceServers });
    pc.createDataChannel('netcheck'); // ohne Kanal sammelt der Browser gar nicht erst
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      const done = () => resolve();
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') done(); };
      setTimeout(done, timeoutMs); // vollständiges Sammeln kann hängen — nicht ewig warten
    });
    const cands = [];
    const stats = await pc.getStats();
    stats.forEach((s) => {
      if (s.type === 'local-candidate') cands.push({ candidateType: s.candidateType, relayProtocol: s.relayProtocol });
    });
    return { ...classifyCandidates(cands), ms: Date.now() - started };
  } catch (e) {
    console.warn('[netcheck] Prüfung fehlgeschlagen:', e && e.message);
    return { verdict: 'unknown', relayVia: [], types: [], ms: Date.now() - started };
  } finally {
    try { if (pc) pc.close(); } catch { /* egal */ }
  }
}

// Exposed as a global rather than a module: public/ ships without a build step, and app.js is a
// classic script. app.js invokes the check with ITS iceServers.
window.EUDI_NETCHECK = { runNetCheck, classifyCandidates };
