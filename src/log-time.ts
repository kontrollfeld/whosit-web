// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A timestamp in front of every console line, in one time zone — so an operator reading
 * `docker logs` can tell when a join, a verification or a webhook happened without converting
 * from UTC in their head.
 *
 *   2026-11-17 14:38:37+01:00 [webhook] caller verified, claims=[family_name] …
 *
 * EUDI_LOG_TIMEZONE   any IANA zone (default Europe/Berlin); an unknown zone falls back to UTC
 *                     with a warning rather than stopping the start
 * EUDI_LOG_TIMESTAMPS `off` when the log collector adds its own (`docker logs -t`, journald)
 *
 * The offset is part of the stamp: the clock change in March and October repeats or skips an
 * hour, and the offset keeps those lines unambiguous. Only the first line of a multi-line message
 * is stamped. Imported first by server.ts, so the start-up report carries stamps too.
 */
import { format } from 'util';

const DEFAULT_ZONE = 'Europe/Berlin';

/** The formatter for `zone`, or null when the runtime does not know that zone. */
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'longOffset',
    });
  } catch {
    return null;
  }
}

/** `2026-11-17 14:38:37+01:00` for `date` in the formatter's zone. */
export function stampWith(fmt: Intl.DateTimeFormat, date: Date): string {
  const p: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  // longOffset reads "GMT+01:00", or plain "GMT" at offset zero.
  const offset = (p.timeZoneName || 'GMT').replace(/^GMT/, '') || '+00:00';
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}${offset}`;
}

function install(): void {
  if ((process.env.EUDI_LOG_TIMESTAMPS || '').trim().toLowerCase() === 'off') return;
  const wanted = (process.env.EUDI_LOG_TIMEZONE || '').trim() || DEFAULT_ZONE;
  let fmt = formatterFor(wanted);
  const unknown = !fmt;
  if (!fmt) fmt = formatterFor('UTC')!;
  const f = fmt;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => original(`${stampWith(f, new Date())} ${format(...args)}`);
  }
  if (unknown) console.warn(`⚠️  EUDI_LOG_TIMEZONE: "${wanted}" is no time zone this runtime knows — log times are UTC.`);
}

install();
