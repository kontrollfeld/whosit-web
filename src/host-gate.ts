// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Who may act as host on this instance?
 *
 * On a tenant instance — a city administration, say — this is the real gap: without the check,
 * anyone who knows the URL can invite citizens to a call under the authority's coat of arms.
 * Guests are NEVER affected: they are invited, not admitted.
 *
 * HOW: the name from the wallet-presented, cryptographically verified PID is matched against a
 * list. That is considerably stronger than it sounds — the name does not come from an input field
 * but from a state-issued ID. Anyone wanting to pose as authorised needs a REAL ID document
 * carrying exactly that name.
 *
 * TWO SOURCES for that list, in this order:
 *
 *   EUDI_HOST_FILE=/data/hosts.json   a file in the instance's data directory, re-read when it
 *                                     changes (see `current()`)
 *   EUDI_HOST_ALLOWLIST=...           the original environment variable, unchanged
 *
 * The file came later and is the better place for three reasons, all of them learned from running
 * this. Staff change: a name added to an environment variable needs a redeployment, and a
 * redeployment DROPS EVERY CALL IN PROGRESS — room state lives in this process (see ./rooms). Data
 * protection: an allowlist is personal data, and in the environment it sits in the deployment
 * platform's UI, which widens who can read it to everyone with access to that platform. And a
 * managed instance needs the list to be writable by something other than a deploy pipeline.
 *
 * The variable keeps working exactly as before; an instance that does not set EUDI_HOST_FILE is
 * entirely unaffected by the file path.
 *
 * THE LIMIT, stated plainly: name equality. There are many genuine IDs for "Michael Müller", and
 * a targeted attempt does not attack the cryptography — it looks for a person with a matching
 * name. Only the date of birth would make the identifier unique, but that attribute is retired
 * under this instance's registration and publicly declared as retired at /wrp-policy; requesting
 * it for this purpose would contradict our own statement. This layer is therefore meant as ONE
 * of two, together with the staff link (see ./staff-token). The target state is an authority
 * staff credential: then a revocable credential replaces the name list, and this checkpoint stays.
 */

import fs from 'fs';

/**
 * Make names comparable.
 *
 * NFC, so that "ü" as a single character and as u + diaeresis compare equal — wallets and
 * configuration come from different sources and do not normalise alike. Lower-cased, because ID
 * documents may print "MUSTERMANN". Repeated spaces and hyphens unified, because "Hans-Peter" and
 * "Hans Peter" mean the same person and an over-strict comparison locks out the wrong people.
 */
function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLocaleLowerCase('de-DE')
    .replace(/[-‐-―]/g, ' ')  // hyphens and dashes → space
    .replace(/\s+/g, ' ')
    .trim();
}

/** One list entry: family name and given name, both normalised. */
interface Entry { family: string; given: string; }

/**
 * `EUDI_HOST_ALLOWLIST` — entries separated by `;`, each `FamilyName,GivenName`.
 *
 *     EUDI_HOST_ALLOWLIST=Mustermann,Erika; Schmidt,Hans-Peter; Yılmaz,Ayşe
 *
 * Unset or empty → the check is a no-op. That is the condition for an instance without a tenant
 * setup to be entirely unaffected by this module.
 */
function parse(raw: string): Entry[] {
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(',');
      if (i < 0) return null; // unusable without a comma — see assertHostGateOrExit
      return { family: normalize(entry.slice(0, i)), given: normalize(entry.slice(i + 1)) };
    })
    .filter((e): e is Entry => !!e && !!e.family && !!e.given);
}

/**
 * `EUDI_HOST_FILE` — JSON, either a bare array or `{ "hosts": [...] }` so the file has room
 * for a comment field without breaking. Each entry is `{ familyName, givenName }` or the same
 * `"Family,Given"` string the variable accepts.
 *
 *     { "hosts": [ { "familyName": "Mustermann", "givenName": "Erika" } ] }
 */
function parseFile(text: string): Entry[] {
  const doc: unknown = JSON.parse(text);
  const list: unknown[] = Array.isArray(doc)
    ? doc
    : Array.isArray((doc as { hosts?: unknown })?.hosts)
      ? ((doc as { hosts: unknown[] }).hosts)
      : [];
  const out: Entry[] = [];
  for (const item of list) {
    if (typeof item === 'string') { out.push(...parse(item)); continue; }
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const family = typeof o.familyName === 'string' ? normalize(o.familyName) : '';
    const given = typeof o.givenName === 'string' ? normalize(o.givenName) : '';
    if (family && given) out.push({ family, given });
  }
  return out;
}

const RAW = (process.env.EUDI_HOST_ALLOWLIST || '').trim();
const FILE = (process.env.EUDI_HOST_FILE || '').trim();
const FROM_ENV: Entry[] = parse(RAW);

/**
 * The file's parsed state, refreshed when the file changes on disk.
 *
 * `mtimeMs` + `size` as the change signal, one `statSync` per lookup — the same shape
 * ./operator-pages uses, and for the same reason: a change must take effect WITHOUT a restart,
 * because a restart drops every call in progress. A lookup happens once per join, so this is not
 * a hot path.
 *
 * A file that cannot be read or parsed does NOT fall back to "no gate". It keeps the last good
 * list and logs once per change. An unreadable list must never turn into an open door — that is
 * the same reasoning as `assertHostGateOrExit`, applied at runtime instead of at startup.
 */
let fileCache: { key: string; entries: Entry[] } | null = null;
let lastFileError = '';

function fromFile(): Entry[] {
  if (!FILE) return [];
  let key: string;
  try {
    const st = fs.statSync(FILE);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    // Missing file. Distinguish two cases: never read → empty (the operator has not written
    // it yet, and assertHostGateOrExit already refused to start if it was the only source);
    // read before → keep what we had, because a file that vanishes must not open the gate.
    if (fileCache) {
      if (lastFileError !== 'missing') {
        lastFileError = 'missing';
        console.error(`[host-gate] ${FILE} disappeared — keeping the last known list of ${fileCache.entries.length}`);
      }
      return fileCache.entries;
    }
    return [];
  }
  if (fileCache?.key === key) return fileCache.entries;
  try {
    const entries = parseFile(fs.readFileSync(FILE, 'utf8'));
    fileCache = { key, entries };
    lastFileError = '';
    console.log(`[host-gate] ${FILE} reloaded — ${entries.length} person(s) admitted`);
    return entries;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (lastFileError !== msg) {
      lastFileError = msg;
      console.error(`[host-gate] ${FILE} is unreadable or not valid JSON (${msg}) — keeping the last known list`);
    }
    return fileCache?.entries ?? [];
  }
}

/**
 * The list in force right now: the file plus the variable.
 *
 * UNION, not precedence. Both are explicit acts by the operator, and dropping one because the
 * other exists would silently lock someone out — the failure mode this whole module is meant to
 * prevent. Duplicates are harmless: `mayHost` asks whether ANY entry matches.
 */
function current(): Entry[] {
  const f = fromFile();
  if (!f.length) return FROM_ENV;
  if (!FROM_ENV.length) return f;
  return [...f, ...FROM_ENV];
}

/**
 * Is the host gate active on this instance at all?
 *
 * Reads the CONFIGURATION — whether the operator asked for a gate — and NOT how many entries
 * came out of it. The difference is the whole safety property of this module: a list that is
 * momentarily empty (file not written yet, a saved typo, a malformed entry) must keep the gate ON
 * and refuse everyone, not turn into an open instance. Deriving this from the parsed count would
 * do exactly the latter, and it would do it silently.
 *
 * `/capabilities.hostLogin` derives from this, so the client also keeps showing the sign-in page
 * rather than a setup form nobody can get past.
 */
export function hostGateActive(): boolean {
  return RAW.length > 0 || FILE.length > 0;
}

/** How many people are admitted — for the startup log and /capabilities, without naming anyone. */
export function hostGateSize(): number {
  return current().length;
}

/**
 * May this person host?
 *
 * Without an active gate: always yes. With the gate: only on a match of BOTH family and given
 * name. If either is missing the answer is no — a participant without a verified name cannot be
 * on the list, and letting them through silently would be exactly the gap this gate closes.
 */
export function mayHost(familyName?: string, givenName?: string): boolean {
  if (!hostGateActive()) return true;
  if (!familyName || !givenName) return false;
  const f = normalize(familyName);
  const g = normalize(givenName);
  return current().some((e) => e.family === f && e.given === g);
}

/**
 * What the host MUST disclose for the gate to work at all.
 *
 * Without this it locks out the operator: a room's default discloses only the family name
 * (`rooms.ts`), while `mayHost` requires both — so the host would never get through, and the
 * reason would be written nowhere. Observed in a real wallet's log on 2026-08-15:
 * "Verifier requested items: [family_name]".
 *
 * Disclosure is therefore ENFORCED rather than assumed. Data minimisation still holds: both
 * names are permitted under this instance's policy anyway, and whoever wants to host discloses
 * them necessarily — the gate compares precisely those.
 */
export function enforceHostDisclosure<T extends string>(attrs: readonly T[]): T[] {
  if (!hostGateActive()) return [...attrs];
  const out = [...attrs];
  for (const n of ['given_name', 'family_name'] as unknown as T[]) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * Refuse to start when the gate CANNOT work.
 *
 * The dividing line between aborting and warning is whether a RESTART is needed to fix it.
 * Aborting on something the operator can fix while the instance runs would cost every call in
 * progress for no gain.
 *
 *   ABORT — the variable is the only source and yields nobody. The list looks populated but
 *     contains no one, and only a redeployment can change that. An instance that admits everyone
 *     as host although the operator configured a gate is worse than one without a gate, because
 *     people rely on it.
 *   ABORT — the policy asks the host for no name at all (anonymous direction): there is nothing
 *     to compare, `mayHost` would reject everyone, and the reason would be written nowhere.
 *   WARN — a file is configured and currently yields nobody. That is the normal state of a
 *     freshly provisioned instance whose list has not been written yet, and it is the SAFE
 *     direction: the gate stays on and refuses everyone until the file appears. It is picked up
 *     without a restart, so aborting would turn a temporary emptiness into an outage.
 */
export function assertHostGateOrExit(
  hostDisclosesName: boolean,
  log: (m: string) => void = console.error,
  exit: (code: number) => void = process.exit,
): void {
  if (!hostGateActive()) return;
  if (current().length === 0) {
    if (!FILE) {
      log(
        `FATAL: EUDI_HOST_ALLOWLIST is set but yields no valid entry. Expected ` +
          `"FamilyName,GivenName", multiple separated by ";". An instance that admits everyone ` +
          `as host despite a configured gate is more dangerous than one without a gate — ` +
          `hence aborting.`,
      );
      exit(1);
      return;
    }
    log(
      `WARNING: the host gate is active but admits nobody yet — ${FILE} is missing, empty or ` +
        `unreadable. Until it names someone, NO ONE can host on this instance. The file is ` +
        `re-read when it changes, so no restart is needed.`,
    );
  }
  if (!hostDisclosesName) {
    log(
      `FATAL: EUDI_HOST_ALLOWLIST is set, but this instance's WRP policy asks the host for no ` +
        `name. There would be nothing to compare and nobody would get through. Either add ` +
        `given_name and family_name to the policy, or remove the allowlist.`,
    );
    exit(1);
  }
}
