<!--
SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
SPDX-License-Identifier: AGPL-3.0-or-later
-->
## What changes?

<!-- Briefly and in your own words: what was it before, what is it now? -->

## Why?

<!-- Which problem does this solve? For a bug: how could it be reproduced?
     Reference an issue with "Closes #123". -->

## Edition

<!-- Only fill this in if a capability is affected. Rule of thumb: do WE provide something in
     return for it (retention, infrastructure, a provider contract)? If not → Community.
     The registry in src/core/features.ts gives a reason for every entry. -->

- [ ] Does not affect any feature assignment
- [ ] Community
- [ ] Pro — and the code lives in `pro/` or behind a gate in the core
- [ ] The registry entry in `src/core/features.ts` is up to date (including a short rationale)

## Verification

- [ ] `npm test` passes (typecheck, licence boundary, all nine integration suites)
- [ ] For a bug fix: a test fails **without** the fix
- [ ] For security-relevant changes: the guarantee is stated as a comment on the code that
      enforces it
- [ ] README updated if operators are affected (configuration, prerequisites, features)

## Legal

- [ ] All commits are signed off with `git commit -s` (DCO)
- [ ] I agree to the [CLA](../../CLA.md): my contribution may be shipped under both the **AGPL-3.0**
      and the project's **commercial licence**. I understand that I am not giving up any rights —
      I remain the author and may keep using my own code.

<!-- Without that agreement we cannot merge; the reason is in .gitlab/CONTRIBUTING.md. It is not a
     formality: a single uncovered contribution would block the dual licensing of the whole
     project. There is no bot checking this — the tick above IS the record, so please be accurate.
-->
