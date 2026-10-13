<!--
SPDX-FileCopyrightText: 2012 davidshimjs
SPDX-License-Identifier: MIT
-->

# qrcodejs

Renders the wallet request as a QR code (`new QRCode(element, …)`, see public/app.js).

**Source:** <https://github.com/davidshimjs/qrcodejs> · **Licence:** MIT (see LICENSE)
**Fetched:** 2026-09-02 from `cdn.jsdelivr.net/gh/davidshimjs/qrcodejs/qrcode.min.js`
**SHA-256:** `c541ef06327885a8415bca8df6071e14189b4855336def4f36db54bde8484f36`

## Why it is vendored rather than loaded from a CDN

Until 2026-09-02 this file was pulled from jsdelivr at runtime, without a version pin and without
an `integrity` attribute. Three reasons that had to end, in order of severity:

1. Whoever controls that repository could inject arbitrary JavaScript into the page that builds
   the wallet request — the page where a manipulated script could rewrite the presentation offer
   while the user believes they are identifying themselves to the verifier. `gh/…` always serves the
   current tip, so a change there would have taken effect here without anyone agreeing to it.
2. Every visitor's browser contacted a third party, which contradicted the privacy notice. The
   fonts in ../../fonts are self-hosted for exactly this reason.
3. Where such CDNs are blocked — common in corporate and public-sector networks — no QR code
   appeared at all, and the user saw no error, just a page that did not work.

An update is therefore a deliberate, reviewable commit: replace the file, note the new date and
checksum here.
