<!--
SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
SPDX-License-Identifier: AGPL-3.0-or-later

Note on how this repository works: development happens in a private GitLab project and this is a
read-only mirror. Your pull request is reviewed here and the commits are then ported into GitLab —
they reach this mirror on the next sync, and this PR is closed with a reference to the resulting
commit. Authorship and DCO sign-off travel with the commits. We cannot press "Merge" here: the
mirror is force-updated on every sync, so a merge commit created on GitHub would be destroyed.
-->
## What changes?

<!-- Briefly and in your own words: what was it before, what is it now? -->

## Why?

<!-- Which problem does this solve? For a bug: how could it be reproduced?
     Reference an issue with "Fixes #123". -->

## Edition

<!-- Only fill this in if a capability is affected. Rule of thumb: do WE provide something in
     return for it (retention, infrastructure, a provider contract)? If not → Community.
     The registry in src/core/features.ts gives a reason for every entry. -->

- [ ] Does not affect any feature assignment
- [ ] Community
- [ ] Pro — and the code lives in `pro/` or behind a gate in the core
- [ ] The registry entry in `src/core/features.ts` is up to date (including a short rationale)

## Verification

- [ ] `npm test` passes (typecheck, licence boundary, all integration suites)
- [ ] For a bug fix: a test fails **without** the fix
- [ ] For security-relevant changes: the guarantee is stated as a comment on the code that
      enforces it
- [ ] README updated if operators are affected (configuration, prerequisites, features)

## Legal

- [ ] All commits are signed off with `git commit -s` (DCO)
- [ ] I agree to the [CLA](../CLA.md): my contribution may be shipped under both the **AGPL-3.0**
      and the project's **commercial licence**. I understand that I am not giving up any rights —
      I remain the author and may keep using my own code.

<!-- Without that agreement we cannot use the contribution; the reason is in CONTRIBUTING.md.
     It is not a formality: a single uncovered contribution would block the dual licensing of the
     whole project. The `legal` check in PR checks fails until this box is ticked and every commit
     is signed off; when the PR is ported, the agreement is recorded in the commit message. -->
