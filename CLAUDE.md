# Instructions for AI assistants

## This repository is public

Development happens in a private project; `main` is mirrored to public hosts. **Every commit that
is merged is published — the diff and the commit message**, and it stays in the public history
after the line is later removed. Work branches are not mirrored; what they carry becomes public
with the merge.

- **Nothing that is private because of whose it is:** no customer or prospect names, hosts, logos
  or texts; no internal hosts, addresses, paths or ids of the maintainers' infrastructure; no
  contents of private repositories. In code, comments, tests, documentation and commit messages
  alike. Tests and examples use invented names. A decision is recorded with its date and its
  reason, not with who asked for it.
- **AGPL only, and complete without modules.** No commercially licensed file, no import from a
  module package, no behaviour that only works when a module is present. A capability a module
  needs is added here as a generic port and described without saying who will fill it
  (`npm run check:licence-boundary`, `.github/CONTRIBUTING.md`).
- **Nothing for one customer or one sector.** That is configuration (`EUDI_*`), a policy the
  operator selects, or a module — not a branch in the core.
- **The module contract is a public interface** (`coreApi`, the ports, the manifest block). Change
  it deliberately and say so in the merge request.
- **The maintainers' own commits are authored as the team**, never as a person
  (`scripts/check-commit-identity.mjs`). A ported contribution keeps its author.
- **CI never writes to the repository**; a commit made by a job would be lost at the next sync.
- **Every file carries an SPDX header** or is listed in `REUSE.toml`.
- **Language:** English for code, comments, documentation and commit messages; German for the
  user interface, with translations in `public/translations.json`.

Before a merge request is ready: `npm test`, and read the whole diff and every commit message
once more with one question only — would this be fine on the front page? How contributions from
outside are handled is in `.github/CONTRIBUTING.md`; that file, not this one, is the place for
those rules.

## Logo: change it only when explicitly asked

The whosit logo is approved (variant 2: the large "whosit" wordmark with the gold star as the dot
on the i, above "EUDI VERIFIED CONTACT" at the same width; since 2026-11-13 the ring is the Morse
code QRZ). See `public/logo/README.md`.

- **Change the logo only when the brand owner explicitly asks for it.** A task such as "add the
  logo", "rework the header" or "improve the design" is **not** a request to change or redesign it.
- Show the logo as the **file** from `public/logo/` (`logo-horizontal-colour.svg` on light,
  `logo-horizontal-white.svg` on dark ground). **Never** rebuild it from the mark plus HTML text,
  never derive variants (other proportions, without the star, "compact" and so on).
- Do not edit, regenerate or optimise the files in `public/logo/`.
- The mark-plus-name block (`.brand-operator`) exists only for operators' own branding
  (`EUDI_BRAND_*`). It is not a whosit logo and must not be shown for whosit itself.
- If the logo does not fit somewhere: **ask**, do not adapt it.
- **The one exception: the approved logo animation** (brand owner, 2026-11-13, "QRZ": the ring
  builds up with the tones of the sound mark): `public/logo-animation.js` / `.css`, built at runtime from the unchanged colour file. Where
  the logo is animated — the call, films, press — use exactly this, never another choreography or a
  variant, and nothing like "Who is it? / Wer ist dran?" above it. See `public/logo/README.md`.
