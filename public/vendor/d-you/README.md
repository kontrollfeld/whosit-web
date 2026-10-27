<!--
SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# d-you Wallet button

The "Verifizieren mit d-you Wallet" / "Verify with d-you Wallet" button of the German EUDI wallet,
used on the identification card and in the wallet modal (see public/app.js, `openWalletModal`).

**Source:** asset package of the Touchpoint Design Guide,
<https://bmi.usercontent.opencode.de/eudi-wallet/developer-guide/rp/guide/touchpoint_design/>
(`/eudi-wallet/developer-guide/assets/d-you-button-assets.zip`, SHA-256
`673a85be84c893f23103059117b571a37acb3e24979f533ad43847cb90d23e6f`)
**Fetched:** 2026-10-27 · `svg/button/d-you-wallet_button_verify_{de,en}.svg`

| File | SHA-256 |
|---|---|
| d-you-wallet_button_verify_de.svg | `cdf93bd3c64cb2372bc948d36b124295c8d051aaeedc89a3aeac6336fcce736d` |
| d-you-wallet_button_verify_en.svg | `b08d4b78dbdbaa06cf3d8c0a011a3c106b4ea120a4267b2b80ea18149e49ee8e` |

**Licence:** CC BY 4.0 — © 2025 Bundesministerium für Digitales und Staatsmodernisierung (the
developer guide's repository, gitlab.opencode.de/bmi/eudi-wallet/developer-guide, LICENSE; the
package itself carries no separate licence file). Not modified. CC BY 4.0 §2(b)(2): trademark
rights are not licensed — the name and logo "d-you" stay with their owner, and the guide's rules
below are what makes using them appropriate. Not covered by this repository's AGPL licence.

## Rules (from the guide), and why the files are kept byte for byte

- Use the unmodified asset. Do not recreate, restyle or recolour it, and do not change its label,
  logo, trust anchor (black-red-gold bar) or shape. Scale proportionally only.
- No shadows, glows or animation; free space around it; never combined with another logo.
- An operator's accent colour (`EUDI_BRAND_*`) must not reach it. It is an `<img>` for that reason.
- The button type is fixed: "Verifizieren mit" — whosit only ever asks for credentials. The
  "Hinzufügen zu" (issuance) variant is deliberately not vendored.

An update is a deliberate commit: replace the files, note the new date and checksums here.
