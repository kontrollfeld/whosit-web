// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The legal precondition for porting a pull request (see .github/CONTRIBUTING.md,
 * "For maintainers: porting a pull request").
 *
 * Dual licensing holds only while every contribution in the combined Pro build is covered by the
 * CLA. So before anyone reviews, two things must be true:
 *
 *   1. The CLA box in the pull request template is ticked.
 *   2. Every commit carries a DCO `Signed-off-by:` line for ITS OWN author's e-mail. A sign-off
 *      by someone else does not count: the DCO is the author's statement, nobody can make it
 *      on their behalf.
 *
 * Runs in the `legal` job of .github/workflows/pr-checks.yml. Reads everything from the
 * environment and needs no token — a check cannot lapse, a token can.
 *
 *   PR_BODY  pull request description
 *   BASE     base commit (the PR's target)
 *   HEAD     head commit (the PR's tip)
 *
 * Locally:  PR_BODY="$(cat body.md)" BASE=origin/main HEAD=HEAD node scripts/check-contribution.mjs
 */
import { execFileSync } from 'node:child_process';

const { PR_BODY = '', BASE, HEAD } = process.env;
if (!BASE || !HEAD) {
  console.error('BASE and HEAD must be set (commit range of the pull request).');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

// 1. CLA box. Matches the template line, tolerant of the case of the x and of spacing.
check(
  'CLA confirmed in the pull request description',
  /^\s*[-*]\s*\[[xX]\]\s*I agree to the \[CLA\]/m.test(PR_BODY),
  'tick "I agree to the CLA" in the PR description (template section "Legal")',
);

// 2. DCO sign-off per commit, bound to the commit's own author. Merge commits are skipped:
// they are dropped when the PR is ported (cherry-pick) and carry no authored content.
const commits = git('rev-list', '--no-merges', '--reverse', `${BASE}..${HEAD}`).split('\n').filter(Boolean);
check('pull request contains commits', commits.length > 0, `no commits in ${BASE}..${HEAD}`);
for (const sha of commits) {
  const email = git('log', '-1', '--format=%ae', sha).trim().toLowerCase();
  const subject = git('log', '-1', '--format=%s', sha).trim();
  const signedOff = git('log', '-1', '--format=%B', sha)
    .split('\n')
    .filter((line) => /^Signed-off-by:/i.test(line))
    .some((line) => line.toLowerCase().includes(`<${email}>`));
  check(
    `${sha.slice(0, 8)} ${subject.slice(0, 60)}`,
    signedOff,
    `no "Signed-off-by: … <${email}>" — amend with "git commit --amend -s" (or "git rebase --signoff ${BASE.slice(0, 8)}")`,
  );
}

if (failures) {
  console.error(`\n${failures} problem(s). Why this matters: .github/CONTRIBUTING.md, "Licence and CLA".`);
  process.exit(1);
}
console.log('\nLegal preconditions met: the pull request may be reviewed and ported.');
