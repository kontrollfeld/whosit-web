// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Commits from our own team carry the team identity, never a person's.
 *
 * This repository is mirrored publicly. Since 2026-11-04 every commit of ours is authored and
 * committed as "Team Kontrollfeld <gitlab@kontrollfeld.de>" (the history was rewritten to it).
 * A clone with a personal git identity would put a name and an address back on GitHub with the
 * next merge — this check stops that in the merge request, before anything reaches main.
 *
 * Outside contributors keep their own name: only addresses at kontrollfeld.de other than the
 * team address are refused.
 *
 * Usage: node scripts/check-commit-identity.mjs <base>   (checks <base>..HEAD; default origin/main)
 * Fix a refused branch: git config user.name "Team Kontrollfeld"; git config user.email
 * gitlab@kontrollfeld.de; then git rebase <base> --exec 'git commit --amend --no-edit --reset-author'
 */
import { execFileSync } from 'node:child_process';

const TEAM = 'gitlab@kontrollfeld.de';
const base = process.argv[2] || 'origin/main';
const out = execFileSync('git', ['log', '--format=%h%x09%an <%ae>%x09%cn <%ce>%x09%s', `${base}..HEAD`], { encoding: 'utf8' });
const bad = [];
for (const line of out.split('\n').filter(Boolean)) {
  const [sha, author, committer, subject] = line.split('\t');
  for (const [role, who] of [['author', author], ['committer', committer]]) {
    const mail = (who.match(/<([^>]*)>/) || [])[1]?.toLowerCase() || '';
    if (mail.endsWith('@kontrollfeld.de') && mail !== TEAM) bad.push(`${sha} ${role} ${who} — ${subject}`);
  }
}
if (bad.length) {
  console.error(`Commits with a personal team identity (must be "Team Kontrollfeld <${TEAM}>"):`);
  for (const b of bad) console.error(`  ${b}`);
  console.error('\nFix: see the header of scripts/check-commit-identity.mjs');
  process.exit(1);
}
console.log(`commit identity ok (${out.split('\n').filter(Boolean).length} commit(s) checked)`);
