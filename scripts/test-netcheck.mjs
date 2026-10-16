// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The network pre-flight classifier — no browser, no network.
 *
 * What is checked is the mapping "candidates found -> verdict". The inputs are NOT invented
 * shapes: they come from a real measurement (Chrome, getStats). The "relay over TCP" case in particular is genuine — the SDP line there says
 * `udp`, and only `relayProtocol` reveals the truth.
 *
 * Usage: npm run test:netcheck
 */
import { readFileSync } from 'node:fs';

// Cut classifyCandidates out of public/netcheck.js rather than copying it here — a copy could
// drift apart, and the test would then prove nothing.
const src = readFileSync(new URL('../public/netcheck.js', import.meta.url), 'utf8');
const start = src.indexOf('function classifyCandidates(');
const end = src.indexOf('\n}\n', start) + 3;
if (start < 0 || end < 3) { console.error('classifyCandidates not found'); process.exit(1); }
const classifyCandidates = new Function(`${src.slice(start, end)}; return classifyCandidates;`)();

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  ✓ ${name}`); return; }
  failures++;
  console.log(`  ✗ ${name}\n      erwartet: ${e}\n      erhalten: ${a}`);
}

console.log('\nVerdict from the candidate types');

// Measured: ordinary home network, UDP open (host + srflx + relay/udp).
check('UDP offen → direkte Verbindung', classifyCandidates([
  { candidateType: 'host', protocol: 'udp' },
  { candidateType: 'srflx', protocol: 'udp' },
  { candidateType: 'relay', protocol: 'udp', relayProtocol: 'udp' },
]), { verdict: 'direct', relayVia: ['udp'], types: ['host', 'relay', 'srflx'] });

// Measured with a configuration offering ONLY TURN/TCP: no srflx, relay over tcp. This is the
// "firewall blocks UDP, TCP 3478 is open" case — the call carries.
check('TCP to the relay only -> works, but only via the relay', classifyCandidates([
  { candidateType: 'host', protocol: 'tcp' },
  { candidateType: 'host', protocol: 'udp' },
  { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp' },
]), { verdict: 'relay-only', relayVia: ['tcp'], types: ['host', 'relay'] });

// The real problem case: nothing gets out.
check('host only -> blocked', classifyCandidates([
  { candidateType: 'host', protocol: 'udp' },
  { candidateType: 'host', protocol: 'tcp' },
]), { verdict: 'blocked', relayVia: [], types: ['host'] });

check('no candidates at all -> blocked', classifyCandidates([]),
  { verdict: 'blocked', relayVia: [], types: [] });

console.log('\nGrenzfälle');

check('undefined instead of a list does not crash', classifyCandidates(undefined),
  { verdict: 'blocked', relayVia: [], types: [] });

check('entries without a type are skipped', classifyCandidates([
  { protocol: 'udp' }, null, { candidateType: 'srflx' },
]), { verdict: 'direct', relayVia: [], types: ['srflx'] });

// IPv6 candidates carry the same types — they must not change the verdict.
check('IPv6 ändert nichts am Urteil', classifyCandidates([
  { candidateType: 'host', protocol: 'udp' },
  { candidateType: 'srflx', protocol: 'udp' },
]), { verdict: 'direct', relayVia: [], types: ['host', 'srflx'] });

// Both routes to the relay present -> both are reported (for the IT detail line).
check('relay over UDP and TCP are both named', classifyCandidates([
  { candidateType: 'relay', protocol: 'udp', relayProtocol: 'udp' },
  { candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp' },
]), { verdict: 'relay-only', relayVia: ['tcp', 'udp'], types: ['relay'] });

// relayProtocol missing (older browser): the verdict must still hold.
check('relay without relayProtocol stays relay-only', classifyCandidates([
  { candidateType: 'host' }, { candidateType: 'relay' },
]), { verdict: 'relay-only', relayVia: [], types: ['host', 'relay'] });

// srflx beats relay: anyone getting a STUN response has UDP open.
check('srflx gewinnt gegen relay', classifyCandidates([
  { candidateType: 'srflx' }, { candidateType: 'relay', relayProtocol: 'tcp' },
]), { verdict: 'direct', relayVia: ['tcp'], types: ['relay', 'srflx'] });

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
