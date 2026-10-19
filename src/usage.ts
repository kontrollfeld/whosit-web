// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Call minutes — how much an instance is used, as two numbers per month and nothing else.
 *
 * WHAT IS COUNTED. A call runs while at least two participants are connected to each other: from
 * the moment the room sends `ready` until fewer than two are left. Group calls count once, by the
 * clock, not once per participant — "call minutes", not "participant minutes". A participant whose
 * connection drops is given time to come back (GRACE_MS, longer for planned rooms); if they do not,
 * the call is counted as having ended when the connection DROPPED, not when the wait ran out — the
 * wait is ours, not the customer's.
 *
 * WHAT IS NOT COUNTED, and why. No room id, no participant, no name, no time of day, no single
 * call: the file holds, per calendar month (Europe/Berlin), how many calls ended and how many
 * seconds they lasted in total. That is enough to bill free minutes and an overage, and it is not
 * personal data — there is nobody in it. A per-call record with times would be: whoever knows they
 * called someone at 14:05 could find their call in it. Billing does not need that, so it is not
 * kept, and an operator who wants it would have to add it on purpose.
 *
 * WHERE IT GOES. `EUDI_USAGE_FILE` — on the persistent volume, rewritten atomically when a call
 * ends. Not served over HTTP: an instance's usage is between the operator and whoever runs it. A
 * hosted instance's file is read by the host (whosit-control's host script) from the data volume.
 * Unset, the numbers live in memory only and are logged once per call end — still useful to see,
 * and nothing is written anywhere the operator did not choose.
 *
 * In every edition, deliberately: an instance without modules runs the core alone, and those are
 * exactly the instances a free tier with paid minutes is for.
 *
 * Calls running across a restart are lost to the count — the room state is in memory, and so is
 * the start time. Updates wait for quiet (see whosit-control), so in practice this is a crash.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MonthUsage { calls: number; seconds: number }
export interface UsageFile { months: Record<string, MonthUsage> }

const ZONE = 'Europe/Berlin';
const running = new WeakMap<object, number>();
let data: UsageFile = { months: {} };
let file: string | null = null;

/** Calendar month of `t` in German time, `YYYY-MM` — billing months follow the customer's calendar. */
export function monthOf(t: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit' }).formatToParts(new Date(t));
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
}

/** Read the file once at startup. A missing file is a first start; a broken one is reported and replaced. */
export function initUsage(path = (process.env.EUDI_USAGE_FILE || '').trim() || null): void {
  file = path;
  data = { months: {} };
  if (!file) {
    console.log('[usage] EUDI_USAGE_FILE not set — call minutes are counted in memory only');
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.months === 'object') {
      for (const [m, v] of Object.entries(parsed.months as Record<string, MonthUsage>)) {
        if (/^\d{4}-\d{2}$/.test(m) && Number.isFinite(v?.calls) && Number.isFinite(v?.seconds)) {
          data.months[m] = { calls: Math.max(0, Math.floor(v.calls)), seconds: Math.max(0, Math.floor(v.seconds)) };
        }
      }
    }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      // Set aside, not overwritten: the months in it are what a bill is made from, and a file
      // that one tool cannot parse may still be readable by a person.
      const aside = `${file}.unreadable-${Date.now()}`;
      try { renameSync(file, aside); } catch { /* reported below either way */ }
      console.warn(`[usage] ${file} unreadable (${e?.message || e}) — moved to ${aside}, counting from zero`);
    }
  }
  console.log(`[usage] call minutes → ${file}`);
}

/** The room has connected (`ready`). Idempotent: a second `ready` for the same running call is the same call. */
export function callStarted(room: object, at = Date.now()): void {
  if (!running.has(room)) running.set(room, at);
}

/**
 * A participant has left `room` and `remaining` are still in it. Below two, the call is over —
 * counted as ending at `endedAt`, which is when the leaving participant's connection dropped.
 */
export function participantLeft(room: object, remaining: number, endedAt = Date.now()): void {
  const start = running.get(room);
  if (start === undefined || remaining >= 2) return;
  running.delete(room);
  const seconds = Math.max(0, Math.round((endedAt - start) / 1000));
  const m = monthOf(start);
  const cur = data.months[m] || { calls: 0, seconds: 0 };
  data.months[m] = { calls: cur.calls + 1, seconds: cur.seconds + seconds };
  console.log(`[usage] call ended after ${seconds}s — ${m}: ${data.months[m].calls} calls, ${Math.round(data.months[m].seconds / 60)} min`);
  persist();
}

export function usageSnapshot(): UsageFile {
  return JSON.parse(JSON.stringify(data));
}

/**
 * One line, keys in a fixed order: `{"months":{"2026-10":{"calls":3,"seconds":1234}}}`. The host
 * script reads it with sed, not a JSON parser (the host has none it could trust) — so the shape is
 * an interface, and it stays this compact.
 */
export function serialize(d: UsageFile = data): string {
  const months = Object.keys(d.months).sort()
    .map((m) => `"${m}":{"calls":${d.months[m].calls},"seconds":${d.months[m].seconds}}`).join(',');
  return `{"months":{${months}}}\n`;
}

function persist(): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, serialize());
    renameSync(`${file}.tmp`, file);
  } catch (e: any) {
    console.warn(`[usage] could not write ${file}: ${e?.message || e}`);
  }
}
