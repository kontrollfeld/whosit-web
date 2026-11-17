// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Log timestamps (src/log-time.ts): the stamp's shape and zone, both sides of the clock change,
 * the switch to turn it off, and the fallback for a zone the runtime does not know.
 */
import { spawnSync } from 'node:child_process';

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}
function tsx(code, env = {}) {
  const r = spawnSync('npx', ['tsx', '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, EUDI_LOG_TIMEZONE: '', EUDI_LOG_TIMESTAMPS: '', ...env },
  });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

console.log('1. the stamp');
{
  const r = tsx(`
    import { stampWith } from './src/log-time';
    const f = (zone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' });
    process.stdout.write(JSON.stringify([
      stampWith(f('Europe/Berlin'), new Date('2026-11-17T13:38:37Z')),
      stampWith(f('Europe/Berlin'), new Date('2026-07-01T12:00:05Z')),
      stampWith(f('UTC'), new Date('2026-11-17T00:00:00Z')),
    ]));`, { EUDI_LOG_TIMESTAMPS: 'off' });
  let s = [];
  try { s = JSON.parse(r.out); } catch { /* reported below */ }
  check('winter: Berlin is UTC+1', s[0] === '2026-11-17 14:38:37+01:00', r.out || r.err);
  check('summer: Berlin is UTC+2', s[1] === '2026-07-01 14:00:05+02:00', r.out || r.err);
  check('UTC reads +00:00, midnight as 00', s[2] === '2026-11-17 00:00:00+00:00', r.out || r.err);
}

const stamped = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} /;

console.log('2. console lines');
{
  const r = tsx(`import './src/log-time'; console.log('[join] %s room=%s', 'caller', 'abc'); console.error('boom');`);
  const [line] = r.out.split('\n');
  check('console.log is stamped', stamped.test(line), r.out);
  check('the message keeps its format arguments', line.endsWith(' [join] caller room=abc'), r.out);
  check('console.error is stamped', stamped.test(r.err) && r.err.endsWith(' boom'), r.err);
  check('Berlin by default', /\+0[12]:00 /.test(line), line);
}
{
  const r = tsx(`import './src/log-time'; console.log('x');`, { EUDI_LOG_TIMEZONE: 'UTC' });
  check('another zone when set', /^\S+ \S+\+00:00 x$/.test(r.out), r.out);
}
{
  const r = tsx(`import './src/log-time'; console.log('[audit] {}');`, { EUDI_LOG_TIMESTAMPS: 'off' });
  check('EUDI_LOG_TIMESTAMPS=off leaves lines as they were', r.out === '[audit] {}', r.out);
}
{
  const r = tsx(`import './src/log-time'; console.log('x');`, { EUDI_LOG_TIMEZONE: 'Mars/Olympus' });
  check('an unknown zone warns', r.err.includes('EUDI_LOG_TIMEZONE') && r.err.includes('UTC'), r.err);
  check('…and falls back to UTC instead of stopping', r.status === 0 && /\+00:00 x$/.test(r.out), `${r.status} ${r.out}`);
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nall checks passed');
process.exit(failures ? 1 : 0);
