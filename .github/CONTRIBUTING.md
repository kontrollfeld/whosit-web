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

   You agree by ticking the CLA box in the pull request template. The `PR checks` workflow
   fails until that box is ticked and every commit carries a sign-off matching its author, so
   you see at once what is missing. There is no bot and no third-party service: when the PR is
   ported, the maintainer writes your agreement into the commit itself (see
   [below](#for-maintainers-porting-a-pull-request)), so the record lives in the history and
   cannot expire or be lost with an external account.

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

**Larger changes: open an issue first.** A new feature, a new dependency or anything touching the
verification flow is easier to agree on before the code exists. It saves you work we might not be
able to take.

## What happens to your pull request

There are three outcomes, and each is fine:

- **Accepted.** The commits are ported into GitLab unchanged, with you as author, and reach this
  mirror on the next sync. The PR is closed with a link to the resulting commit.
- **Accepted in part, or adapted.** If only part of a change fits, or it needs rework we would
  rather do ourselves, the maintainer takes that part. You stay the author of what is yours; the
  PR says what was taken and why.
- **Declined.** The PR is closed with a reason. Nothing is ported and nothing of it ships in this
  project. **Your code stays yours**: you may keep it in your own fork, under the AGPL, and
  publish or use it there as you like. A decline says the change does not fit this project's
  direction, not that it is wrong.

We are not obliged to merge a contribution ([CLA](../CLA.md) §6). We will always say why we don't.

**Contributions to `pro/`** (usually fixes) are welcome under the same CLA, and ship under the
commercial licence of that directory, not the AGPL. New Pro features are developed by the
maintainer; please don't open PRs that add them.

## For maintainers: porting a pull request

GitHub is a force-updated mirror, so a PR is never merged there. Port it into GitLab like this:

1. **Check the legal part first.** `PR checks` must be green, including the `legal` job (CLA box
   ticked, a sign-off matching the author on every commit). Without both, do not port; ask for them
   on the PR.
2. **Take the commits with their authorship.** On a branch in the GitLab checkout:

   ```bash
   git fetch https://github.com/kontrollfeld/id-call-web.git pull/<N>/head:pr-<N>
   git switch -c contrib/pr-<N> origin/main
   git cherry-pick -x --signoff origin/main..pr-<N>   # keeps the contributor as author
   ```

   `-x` records the original commit; `--signoff` adds yours below theirs (the DCO chain).
3. **Write down the CLA agreement in the commit** by amending the last ported commit's message
   with this trailer:

   ```
   CLA-Accepted: CLA 1.0, @<github-user>, https://github.com/kontrollfeld/id-call-web/pull/<N>
   ```

   The history is the record. It is mirrored publicly and needs no account, bot or token that
   could lapse. The first contribution of each person is the one that matters; still add the
   trailer to every ported PR, so no single commit has to be looked up.
4. **Adapting or taking only part?** Leave the contributor as author of the commits that are theirs,
   put your own changes in separate commits, and say on the PR what was taken.
5. **Merge request in GitLab** as usual (full pipeline). After the next mirror sync, close the
   GitHub PR with a link to the commit.
6. **Declining:** close the PR with a reason and port nothing. If parts of it are reused later
   after all, port them as in steps 2 and 3, with the contributor as author, rather than retyping
   them. Otherwise the history no longer shows whose code it is.

A pull request that bypasses step 1 is the one thing that can break dual licensing, because one
uncovered contribution in the combined Pro build would oblige us to publish all of it under the
AGPL. That is why the check comes before the review, not after it.

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
