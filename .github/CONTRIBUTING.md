<!--
SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Contributing

Thanks for your interest in **EUDI Verified Call**! Contributions are welcome.

**Where things live.** Development happens in a private GitLab project; this GitHub repository is
a **read-only mirror** and the public point of contact. That split has one practical consequence:

- **Issues, questions and vulnerability reports:** here, on GitHub.
- **Pull requests:** here too — open them normally. A maintainer ports the reviewed commits into
  GitLab, and they reach this mirror on the next sync. Your PR is then closed with a reference to
  the commit that carries your work; authorship and the DCO sign-off travel with it.
- **What we cannot do:** press *Merge* on GitHub. The mirror is force-updated on every sync, so a
  merge commit created here would be destroyed. That is a property of the mirror, not a judgement
  on the contribution.

## Licence and CLA

This repository carries **two licences**:

- everything **except** `pro/` is **AGPL-3.0-or-later** ([`LICENSE`](../LICENSE))
- **`pro/`** is commercially licensed ([`pro/LICENSE`](../pro/LICENSE)) — readable and auditable,
  but not usable in production without a licence. Nothing under `src/` may import from it; the
  AGPL part must build and run entirely without `pro/` (enforced by
  `npm run check:licence-boundary`).

Contributions need two things:

1. **A DCO sign-off on every commit** — you confirm you hold the rights to what you submit:

   ```
   git commit -s -m "feat: ..."
   ```

2. **Agreement to the CLA** ([`CLA.md`](../CLA.md)), once per person. It grants the sublicensing
   right that makes dual licensing possible. It is a **licence, not an assignment**: you keep
   ownership of your work and may reuse it anywhere, commercially included.

   CLA Assistant records this on the pull request; it comments and blocks until you agree. The
   pull request template also carries a confirmation box.

**Why this is not a formality:** the hosted service runs the AGPL core together with `pro/`. Under
AGPL §13 that would require publishing the whole thing; it is only lawful because the rights are
held in one place. A contribution without these grants would make it unlawful, so we could not
merge it — and having to turn down finished work is worse for everyone than saying so in advance.

> The CLA text has not yet been reviewed by legal counsel; that review is scheduled before the
> first external contribution is merged.

## Before you open a pull request

- Run `npm test` — typecheck, licence boundary and all nine integration suites must pass. The
  `PR checks` workflow runs the same commands, so a green run locally means a green PR.
- Keep the diff focused; match the existing style: **English** for code, comments and
  documentation, **German** for the user interface (with English and French translations in
  `public/translations.json`).
- Update the README where a change affects operators (configuration, prerequisites, features).
- Feature changes: keep the registry in `src/core/features.ts` current — it is the single source of
  truth for which edition a feature belongs to, and each entry carries its reasoning.
- Security-relevant changes: state the property you rely on in a source comment, next to the code
  that enforces it. A guarantee documented somewhere else drifts away from the code.

## Good first issues

- **Extend the local EUDIPLO mock** (`deploy/mock-eudiplo/`): more attributes, error cases, a
  choice of several test identities. Note its deliberate limitation — it returns claims that were
  never requested, which hides protocol errors. Making it honour the DCQL would be a genuine
  improvement.
- **A second WRP policy** in `src/wrp-policy.ts` for a use case other than a municipal citizen
  service — the file explains what a policy has to declare and why the environment may only
  choose between policies, never extend one.
- **Translations**: `public/translations.json` carries English and French alongside the German
  source. Further languages are welcome; the interface is fully keyed.

## Reporting security issues

Please do **not** open public issues for vulnerabilities — see [`SECURITY.md`](SECURITY.md).
