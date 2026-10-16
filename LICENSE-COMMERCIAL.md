# Commercial License (Pro / Enterprise)

The **Community Edition** of whosit (formerly EUDI Verified Call) is licensed under the
**GNU AGPL-3.0-or-later** (see [`LICENSE`](LICENSE)).

The **Pro / Enterprise Edition** — and the right to use this software **without** the
AGPL's network-copyleft obligations (e.g. in a closed-source SaaS) — is available under a
separate **commercial license**.

The commercially licensed code comes as modules released separately, each with its own licence
file: `@whosit/audit-trail`, `@whosit/qes-csc` and `@whosit/qes-device`. None of it is in this repository. The module code can be inspected by
licensees and on request — an audit trail whose code nobody may inspect is a weaker audit trail —
but using it in production requires a licence. The protection is legal, not technical: there is no licence key to circumvent.

Dual licensing is possible because the rights are held in one place and contributors agree to a
**CLA** ([`CLA.md`](CLA.md)) granting the sublicensing right. The CLA is a licence, not an
assignment: contributors keep ownership of their work.

Interested in a commercial licence, in the Pro features (retainable verification audit trail
with export, qualified CSC/QTSP signatures), or in hosted operation
and SLA support? → **<administration@kontrollfeld.de>**

Which features are commercially licensed: those the modules declare in their manifests; the
core's own registry is [`src/core/features.ts`](src/core/features.ts), and
[`README.md`](README.md) summarises both.
