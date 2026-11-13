<p align="center">
  <a href="https://www.whosit.eu">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://www.whosit.eu/operator/logo/logo-horizontal-white.svg">
      <img src="https://www.whosit.eu/operator/logo/logo-horizontal-colour.svg" alt="whosit — EUDI Verified Contact" width="380">
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://www.whosit.eu"><strong>▶&nbsp;Try&nbsp;the&nbsp;live&nbsp;demo&nbsp;at&nbsp;whosit.eu</strong></a>
  &nbsp;·&nbsp;
  <a href="https://testflight.apple.com/join/PfYx2MhR">iPhone app (TestFlight)</a>
  &nbsp;·&nbsp;
  <a href="#self-hosting-in-5-steps">Self-host it</a>
  &nbsp;·&nbsp;
  <a href="#help-with-eidas-20-and-the-eudi-wallet">eIDAS&nbsp;2.0 integration help</a>
</p>

# whosit — Community Edition

**EUDI Verified Call.** Until October 2026 this project was published under that name alone;
repositories, domain and packages now carry the name *whosit*.

> **See it before you set it up:** [**whosit.eu**](https://www.whosit.eu) is our hosted instance of
> this code, with a registered verifier. Open it, share the invitation link, and you are in a call
> within a minute — with an EUDI wallet, including the identity check before connecting.
> Signing a document with the key in your iPhone's security chip needs the
> [iPhone app](https://testflight.apple.com/join/PfYx2MhR). It is a demo instance, not a service
> with guarantees — for your own deployment, see [Self-hosting](#self-hosting-in-5-steps); to try
> it locally without any registration, [Running without a verifier](#running-without-a-verifier).

**Identity-verified peer-to-peer calls (video · audio · chat).** Both sides can identify
themselves with an **EUDI wallet (PID, the EU digital identity)** and see **before connecting**
which fields will be exchanged — the values only once **both** have agreed.

Self-hostable with `docker compose`: Node backend + Traefik (Let's Encrypt, WSS) + coturn
(TURN). No framework, few dependencies, state in RAM.

> **Where to reach us:** <https://github.com/kontrollfeld/whosit-web> — issues, pull requests and
> vulnerability reports belong there. Development itself happens in a private GitLab project, so
> this repository is a **read-only mirror**: maintainers port reviewed commits upstream, and they
> arrive here on the next sync. The copy on **openCode** is a second mirror.
>
> **Licence:** [AGPL-3.0-or-later](LICENSE), all of it. The commercially licensed features are
> modules released separately. See [Licence](#licence) below ·
> Contributing: [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) · Reporting a
> vulnerability: [`.github/SECURITY.md`](.github/SECURITY.md)

---

## Contents
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Self-hosting in 5 steps](#self-hosting-in-5-steps)
- [The compose services](#the-compose-services)
- [EUDIPLO: the verifier you run yourself](#eudiplo-the-verifier-you-run-yourself)
  - ["/" is the application, not a website](#-is-the-application-not-a-website)
  - [Trust lists expire after 30 days](#trust-lists-expire-after-30-days)
  - [Registration certificate (WRPRC)](#registration-certificate-wrprc)
- [Running without a verifier](#running-without-a-verifier)
- [Help with eIDAS 2.0 and the EUDI wallet](#help-with-eidas-20-and-the-eudi-wallet)
- [Local development with the EUDIPLO mock](#local-development-with-the-eudiplo-mock)
- [Conformance tests with ERICA](#conformance-tests-with-erica)
- [Wiring up TURN properly](#wiring-up-turn-properly)
- [Configuration (ENV)](#configuration-env)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [What is included](#what-is-included)
- [Licence](#licence)

## Architecture

```
                              ┌───────────────────── your server ──────────────────────┐
  Browser A ──── HTTPS/WSS ──►│  Traefik (:443)  ──►  app (Node, :3000)                 │
  Browser B ──── HTTPS/WSS ──►│    │ Let's Encrypt      │  Express: static frontend     │
      │                       │    │                    │  + /webhook  + WS signalling  │
      │ Media (DTLS-SRTP)     │    └─ certificates      │  + verify gate                │
      ▼                       │                          ▼                               │
  coturn (TURN :3478) ◄───────┤                    EUDIPLO  ◄─── wallet presentation     │
   (NAT traversal, host net)  └─────────────────────────────────────────────────────────┘

  Signalling (SDP/ICE) goes through the server; the media flows directly P2P
  (A<->B), relayed via coturn only when it has to. Media is always DTLS-SRTP encrypted.
```

**The flow:** the host creates a room → shares the link → both present (if required) PID fields
from their wallet to EUDIPLO → EUDIPLO reports the result back over an **authenticated webhook**
→ both see a **review** (field names only) → after **both** consent, the values are revealed
**and** the WebRTC connection is established.

Roles: the first person in the room is the `caller` (host, WebRTC initiator), the second the
`callee` (guest).

## Prerequisites

- A server with a public IP, **Docker** + **Docker Compose v2**.
- A **domain** with an A/AAAA record pointing at the server (for the Let's Encrypt certificate).
- Open firewall ports: **TCP 80, 443** (web/WSS) and **UDP 3478 + 49160–49200**, **TCP 3478**
  (TURN). For guests on corporate networks, also set up TURN over **443** — see "TURN over 443"
  below.
- **Your own EUDIPLO instance.** This is the biggest hurdle, and it is not a technical one:
  - EUDIPLO 9.1.0 as a container (`ghcr.io/eudiplo/eudiplo`; the old
    `ghcr.io/openwallet-foundation/…` path gets no releases after 8.x), **pin the version**,
    one major at a time. The admin UI (`ghcr.io/eudiplo/eudiplo-client`) must run the same
    version. Database migrations are not reverted by starting an older image: **back up the
    data volume before every upgrade**, a rollback is restoring that backup.
    Upgrading from 8.x: change image name and tag, nothing else in this app. Upgrading from
    6.x: first to 8.0.2 (7.0–7.2 break `/verifier/offer` after the database migration) and
    replace `EUDI_TRUST_LIST_URLS` with `EUDI_TRUST_LIST_IDS`.
  - Its **own subdomain with TLS**: the wallet contacts the verifier directly, so it cannot stay
    on an internal network.
  - An **access certificate from a registration authority**, issued for exactly that hostname
    (in Germany: the German Registrar). **This is an application, not a download** — expect
    weeks. Without the certificate, real wallets reject the request.
  - `VP_REMOVE_TA=true` on the instance, otherwise wallets that reject the DCQL field
    `trusted_authorities` will fail.

  For frontend work there is a **dummy** under `deploy/mock-eudiplo/` with no cryptography. It is
  not a verifier: it also returns claims that were never requested, and therefore hides protocol
  errors. Never use it in a real deployment.

## Self-hosting in 5 steps

```bash
# 1) Get the repository
git clone https://github.com/kontrollfeld/whosit-web.git
cd whosit-web

# 2) Create and fill in the env file (DOMAIN, ACME_EMAIL, TURN_SECRET, TURN_EXTERNAL_IP, EUDIPLO_*)
#    No verifier yet? Set EUDI_VERIFIER=none instead of the EUDIPLO_* lines — see
#    "Running without a verifier" below.
cp .env.selfhost.example .env
$EDITOR .env

# 3) Check DNS: DOMAIN must point AT THIS HOST, or Let's Encrypt will fail
dig +short call.example.org

# 4) Start (builds the app image from ./Dockerfile)
docker compose up -d

# 5) Watch the logs (certificate, coturn, app)
docker compose logs -f
```

Then open `https://<DOMAIN>` in a browser. A badge at the bottom shows the version.

**Generate a secret:** `openssl rand -hex 32` → `TURN_SECRET`. **Public IP:**
`curl -s https://api.ipify.org` → `TURN_EXTERNAL_IP`.

## The compose services

| Service | Role | Network |
|---|---|---|
| `traefik` | HTTP→HTTPS redirect, Let's Encrypt certificates (TLS-ALPN-01), WSS routing to the app | `web` (bridge), ports 80/443 |
| `socket-proxy` | gives Traefik the container list it needs — read-only, nothing else of the Docker API | `docker-api` (internal, no route out) |
| `app` | Node backend (from `./Dockerfile`): frontend + `/webhook` + WebSocket signalling + verify gate | `web`, internally `:3000` |
| `coturn` | TURN relay for NAT traversal | **host** (needs the real IP + port range) |
| `mock-eudiplo` | *(profile `mock`)* local EUDIPLO stand-in, no wallet | `web`, `/mock` |

WebSockets need no special configuration: Traefik passes the HTTP/1.1 upgrade through
transparently.

## EUDIPLO: the verifier you run yourself

The application performs **no EUDI cryptography itself** — **EUDIPLO** does that (mdoc/SD-JWT,
X.509, OpenID4VP). This application ships no verifier and cannot work without one.

Set `EUDIPLO_BASE_URL`, `EUDIPLO_CLIENT_ID` and `EUDIPLO_CLIENT_SECRET` — the fixed tenant client
of your instance. That is the recommended route, because the application then holds only that
client's rights and needs no root access.

**There are no default values.** If a required value is missing, startup aborts under
`NODE_ENV=production` and names the variable — before the port is even open. That is deliberate:
previously, incompletely configured instances quietly ran against someone else's verifier, and
the mistake only surfaced when a citizen opened their wallet.

> What the application expects from EUDIPLO (the endpoints the mock reproduces):
> `POST /api/oauth2/token`, `POST /api/client/:tenant/rotate-secret`,
> `POST /api/verifier/config`, `GET /api/registrar/config` (existence check only),
> `POST /api/verifier/offer` → returns an offer URI; after that
> **EUDIPLO POSTs the result to the application's webhook URL**
> (`…/webhook/:sessionId?t=<token>` — the token is verified server-side).

### "/" is the application, not a website

A fresh instance answers the bare URL with the call screen — set up, invite, identify. There is
no front page in this repository, deliberately: this is a tool for making verified calls, and an
instance you run should not greet visitors with marketing for a service that is not yours. Until
2026-09-13 it did exactly that.

If you want your own front page, put a `start.html` into `EUDI_OPERATOR_PAGES`. It then owns "/",
and anything beside it — stylesheet, images, a film — is served from `/operator/…`.

**The imprint from its details.** Section 5 DDG requires every operator to name themselves. Instead
of writing `impressum.html`, you can put the facts into `impressum.json` in the same directory —
name, street, place, email; optionally country, representative, phone, register, VAT ID,
supervisory authority, editorially responsible person — and the shipped imprint page fills itself
in, in the instance's own look. Every value is escaped text; a file missing a required field is
ignored (the placeholder shows, the startup log names the field). An `impressum.html` always wins.
Field names and an example: `.env.example`.

**The privacy notice, built from the configuration.** Most of what Art. 13 GDPR asks for is a fact
about the software and its settings — which attributes the wallet may be asked for, whose STUN
server sees a visitor's IP address, whether the relay is your own, what a module keeps — and a
handwritten notice goes stale the day one of them changes. Put `datenschutz.json` into the same
directory with what only you can say (purpose, legal basis, hosting, server logs; optionally data
protection officer, supervisory authority, date) and the page at `/datenschutz` is built on every
request from those details and the running configuration (`src/privacy-notice.ts`). The controller
comes from `impressum.json`. Modules describe themselves through a `privacy` paragraph in their
manifest; a loaded module without one is named on the page as having declared nothing, and the
startup log warns. A `datenschutz.html` always wins. Fields and an example: `.env.example`. This is
a well-informed starting point, not legal advice — the operator remains responsible for the text.

**The call setup in your words.** `oberflaeche.json` in the same directory sets what is ticked
when the setup opens (`vorauswahl`), replaces the quick picks above the attribute list
(`schnellwahl`, up to four, each with a name per language) and swaps interface strings for your own
wording (`texte`, keyed by the German source string as in `public/translations.json`, per language)
— "Mietinteressent" instead of "Gast" on a letting agent's instance, for example. It never widens
anything: attributes outside the instance's WRP policy are dropped before the browser sees them,
and a value containing `<`, `>` or `&` makes the whole file invalid, so a text can never become
markup. Read per request; an invalid file is ignored and the reason logged. Format and an example:
`src/operator-ui.ts`.

**Your own site beside the application.** The same directory can hold a whole website without
any change to this code. Pages are served under short paths, `faq.html` at `/faq` and
`artikel/eins.html` (or `artikel/eins/index.html`) at `/artikel/eins`. `robots.txt`, `sitemap.xml`,
`llms.txt` and similar `.txt`/`.xml`/`.ico` files are answered at the root. `redirects.json`
(`{"/old": "/new"}`, targets `/…` or `https://…`) answers with 301, also for old `/operator/…`
addresses. `404.html` is shown with status 404 for any path nothing else answered. All of this is
consulted only **after** every route of the application, so a file can never hide one: a
`health.html` does not shadow `/health`. Files are looked up per request, so a new page needs no
restart.

**Invitation links always reach the application**, start page or not: `/?room=…`, `?inv=`, `?new=`
and `?solo=` bypass it. That fork is covered by `npm run test:operatorpages`, because breaking it
would break every link ever sent, every QR code and the mobile app's universal links.

### Trust lists expire after 30 days

If you configure a trust list in EUDIPLO — the list that says which issuer certificates you
accept — set yourself a reminder, or better, a cron job. EUDIPLO stamps every list with
`NextUpdate = issued + 30 days`, and once that moment passes it **fails closed**: certificate
chain validation refuses every presentation.

The failure is hard to read from the outside, which is the reason this section exists:

* The wallet does everything right and still shows a generic error.
* `POST /presentations/<id>/oid4vp` returns a bare **HTTP 400** with no explanation.
* Only the EUDIPLO log names the cause:
  `Configured trust list is stale (NextUpdate in the past: …)`.

Failing closed is the correct behaviour — the alternative would be accepting credentials whose
issuer you can no longer vouch for. But it means a working instance stops working on a schedule,
and nothing warns you first.

Re-issuing the list resets the clock. **Do not do that by reading the list back and writing it
straight out again:** the management API returns `entities: []` for externally supplied
certificates, because they live in the published list rather than in the stored configuration.
A round-trip therefore publishes an *empty* trust list — which fails exactly like an expired one,
except the certificates are gone as well. Rebuild the entries from the published list instead
(`GET /issuers/<tenant>/trust-list/<id>` returns a signed JWT containing them), and verify
against that public URL afterwards that the entry count and the new `NextUpdate` are what you
expect.

The renewal needs a client with the `presentation:manage` or `issuance:manage` role. A root
client will not do — it only carries `tenants:manage`.

### Registration certificate (WRPRC)

The access certificate says **who** asks — it signs the request. The **registration
certificate** says **what** this relying party is registered to ask for and **why**: a JWT
(`typ: rc-wrp+jwt`, ETSI TS 119 475) from the registrar, whose `credentials` claim lists the
permitted queries and whose `purpose` the wallet shows the user. It travels in the request
object as `verifier_info`. Since the German wallet update of October 2026 a request without one
is refused, and the wallet log says
`WRPRC policy is configured but verifier_info is missing`. The person in front of the phone sees
only a generic error.

**Default route: EUDIPLO has the registrar issue it.** The app sends only the purpose
(`registration_cert: { body: { purpose } }`). EUDIPLO derives the authorized credentials from the
query, has the registrar issue a certificate for exactly that query, and caches it per verifier
config until the query changes or the certificate expires. You need:

1. **A registrar configuration on the EUDIPLO tenant**: in the EUDIPLO UI under
   *Registrar → Registrar Config*, preset **German Sandbox**, plus your registrar login. EUDIPLO
   validates the login against the registrar before saving. **Without that configuration EUDIPLO
   quietly omits the certificate** (`isEnabledForTenant` in `oid4vp.service.ts`). The app checks
   this once after the first verifier config and logs a warning when the configuration is missing.
2. **A privacy policy URL and a support contact.** The registrar requires both. Enter them as
   *Registration Certificate Defaults* in the same form, or set `EUDI_PRIVACY_POLICY_URL` /
   `EUDI_SUPPORT_URI`. If either is missing, EUDIPLO fails the wallet's request with HTTP 400.

**Alternative: import a certificate.** If you already have a JWT from the registrar, set
`EUDI_REGISTRATION_CERT_FILE` (path) or `EUDI_REGISTRATION_CERT` (the JWT itself). This route
still needs the registrar configuration from point 1, and the certificate must list **every**
query exactly. EUDIPLO 9.x compares `{ format, claims, meta }` by the claims' paths, in order;
8.0.2 also compares `intent_to_retain: false` on mdoc. The app checks the 9.x rule — certificates
from the German EUDI Hub (eudi-hub.gov.de, web interface only) list paths alone — so use EUDIPLO 9
with imported certificates. A room may ask for any non-empty subset of the attributes, and each
subset is its own entry: one certificate can hold all of them (one credential entry per subset and
format in the Hub's credential request). `npm run wrprc:credentials` prints the list to
apply for (run it on the server, because profiles and policy change it), and
`npm run wrprc:credentials -- --check` names what is missing. The app refuses an uncovered PID
query with a clear message instead of letting EUDIPLO answer the wallet with a bare 400. At
startup, an unreadable or expired certificate is fatal, and less than 30 days left is a warning.

The certificate expires. Put its `exp` in the same calendar as the trust list.

### Verifier status: what the wallet will be shown

Two seconds and 90 seconds after startup, and every six hours after that, the instance reads back from EUDIPLO
what a wallet will see, using its own tenant token and read-only calls:

- the EUDIPLO **version** (`GET /api/version`)
- the **access certificate**: who it names, until when, and the first 16 hex characters of its
  SHA-256, which is the `x509_hash` client_id (`GET /api/key-chain?usageType=access`)
- the **registration certificate**: imported or issued by EUDIPLO, the registered party, the
  intermediary if one is named, the purpose, the expiry and the claims it covers
  (`registrationCertCache` of the verifier config, EUDIPLO 9)

It also adds the attributes the instance requests. To have a registration certificate to report
before the first call, the instance registers its widest PID config (every attribute its policy
allows) at startup. EUDIPLO 9 issues the certificate after it has answered that save, not before,
so the first round usually reports none yet. The round at 90 seconds finds it. A config that cannot be registered then shows up in the startup log, not as a
sign-in failing on someone's phone.

The summary goes to the log (`Verifier status: EUDIPLO 9.1.0 at …`), with warnings when the access
certificate has less than 30 days left. With `EUDI_VERIFIER_STATUS_FILE` it is also written as one
line of JSON, for the operator's own tooling; whosit-control's overview reads it. It holds no
secret and no personal data. It is still not served over HTTP: the tenant and the verifier version
are between the operator and whoever runs the instance. A lookup the tenant may not make (for
example `key-chain` without `presentation:manage`) is named under `problems`, and the other lookups
still run.

### The wallet touchpoint (d-you Wallet)

Where a person starts a wallet request follows the
[Touchpoint Design Guide](https://bmi.usercontent.opencode.de/eudi-wallet/developer-guide/rp/guide/touchpoint_design/)
of the German EUDI wallet "d-you Wallet" (launch 2 January 2027):

- **Nothing starts by itself.** The card says what is shared, who asks (`rp-disclosure`) and that
  the d-you Wallet app is needed; guests also learn the way out (ask the host to start without an
  ID check). The QR code appears only after "Verifizieren mit d-you Wallet" is pressed.
- **The guest learns it before the call, not at the button.** Setting up the wallet takes minutes and
  the ID card PIN. So whenever the guest is asked for something (not with "Nichts abfragen"), the
  calendar invitation and the share text say to set up the d-you Wallet beforehand and link
  eudi-wallet.gov.de, and the host sees a note next to the invitation link. On the guest's identify
  card a "Das brauchst du" box (wallet, camera/microphone) replaces the one-line wallet note. Only
  German PIDs are accepted so far (the trust list holds the German PID provider), so the texts name
  the d-you Wallet and no other wallet.
- **The button is the unmodified asset** in `public/vendor/d-you/` (CC BY 4.0, BMDS; see its
  README). It is an `<img>`, so an operator's accent colour cannot restyle it. Never rebuild it.
- **The modal** has the guide's anatomy and texts: "Jetzt verifizieren", QR code for another device,
  "oder", the same button for this device, "Was ist die d-you Wallet?". On phones it fills the
  screen. Additions of ours: "Link zum QR-Code kopieren" (the accessible alternative to the QR code)
  and "Code erneuern" (an offer is spent after one attempt).
- **States:** default → "Weiter in der d-you Wallet" → "Verifizierung erfolgreich!" (closes by itself),
  plus our error state with "Neuen Code anzeigen". The loading state needs to know that the wallet
  fetched the request, which the webhook does not say: while the modal is open the client sends
  `auth-watch`, and the server polls `GET /api/session/:id` at EUDIPLO every two seconds (at most ten
  minutes) until it reads `fetched`. A failed lookup simply leaves the modal in its default state.
- **Accessibility:** focus moves into the modal and back, Tab stays inside, Escape closes, state
  changes are announced (`aria-live`).
- **The way back from the wallet** is never the bare room link. If the browser it lands in already
  sits in the room (same device), it goes back into it; otherwise it only says "done, continue on
  the other device or in the app" and joins nothing. Until 2026-10-27 the wallet opened
  `/?room=…`: a phone that scanned the code shown on a computer opened the whosit app with it, and
  the app joined the caller's own room as the guest. Now (`walletReturnUrl` in `src/server.ts`):
  - **Offer for a browser:** `/zurueck?r=<room>`. `r` (not `room`) is never read as a room link,
    so no app build joins on it. It is also an iOS app link (apple-app-site-association; Android
    opens the app for every path anyway); an app that gets it stays in its call or shows "done".
  - **Offer for the app** (WebSocket Origin in `EUDI_APP_ORIGINS`): `/?room=<room>&zurueck=1&app=1`.
    On a real iPhone `/zurueck` kept opening Chrome even after reinstalling the app, while
    `/?room=` — the form every iPhone with the app has known for months — opened the app. The app
    sits in that very room, so it only comes back to the front. `zurueck=1` keeps a browser from
    joining; apps from build 28 also treat it as a return in any other room (`openRoomUrl`) — builds
    26/27 would still join there, which only matters if a second phone with the app scans the code.
  - **If iOS opens the browser anyway** (association file not on the phone, or "open in browser"
    chosen once for the domain): with `app=1` the "done" page tries `whosit://open/zurueck?r=…` once
    by itself and shows "Zurück zur whosit-App". Every app build since 26 reads that like the https
    link.
  - A link opened from the browser's address bar never opens an app — test app links by tapping
    them in Notes or Messages.
  - "Neuen Raum/Anruf starten" (`startFreshCall`) must drop every marker of the old room — `r`,
    `zurueck`, `app`, `inv`, the `/zurueck` path — not just `room`. Until 2026-10-28 it kept them,
    and the app, back from the wallet, landed in the old (full) room again.
- The same modal serves the in-call credential request (a module's, see Modules), without the loading state.
- **Font:** the guide's modal uses Inter; until that is decided the modal keeps IBM Plex.

## Running without a verifier

Wallet verification needs a verifier of your own and a relying-party registration — weeks of
paperwork before the first verified call. To look at the software before that, there are three
levels, and you can move up one at a time:

| | What works | What you need |
|---|---|---|
| **1. Anonymous test** | Video, audio, chat, screen sharing, files, document sharing | `EUDI_VERIFIER=none`, nothing else |
| **2. Verification flow with the mock** | Everything above, plus "share data": the review, the consent screen, names in the call | The bundled EUDIPLO mock (below) — no cryptography, it believes any name typed into it |
| **3. Real operation** | Real wallets, real PID, the signature features | Your own EUDIPLO instance and an access certificate from a registration authority (usually a sandbox registration first), see [EUDIPLO](#eudiplo-the-verifier-you-run-yourself) |

**Level 1** — set `EUDI_VERIFIER=none` and leave the `EUDIPLO_*` variables out:

- Host and guest are fixed to "Anonym bleiben"; "Daten teilen" is locked, with a short note and a
  link to this section. The server enforces it: a `set-config` carrying attributes is refused
  (`verifier-disabled`) and the room's defaults are emptied.
- A permanent **"Testbetrieb ohne Ausweisprüfung"** banner is shown to everyone. The product's
  promise is that you know who you are talking to; a test call must never pass for a verified one.
- Not offered, because each rests on a verified identity: host login (a host gate refuses to
  start together with `none`), in-call credentials, scheduled invitations, the Apple Wallet pass,
  the qualified and the device/phone signature.
- `GET /capabilities` reports `"verifier": "none"`.

Explicit on purpose. Missing `EUDIPLO_*` values **without** the switch still refuse to start in
production: a real deployment with a typo in `EUDIPLO_CLIENT_ID` must not quietly turn into an
anonymous one.

`npm run test:verifier-none` checks all of this against a server started in production mode
with no verifier variable at all.

## Help with eIDAS 2.0 and the EUDI wallet

Going from level 1 to level 3 is mostly not code: the relying-party registration, the access
certificate, a verifier that has to be pinned and maintained, trust lists that expire, and the
question of which attributes a use case may ask for at all. **Kontrollfeld GmbH**, who maintain
this project, help organisations integrate eIDAS 2.0 identity flows and the EUDI wallet into their
own applications — with this software or without it.

→ [kontrollfeld.de/leistungen/eudi-wallet](https://www.kontrollfeld.de/leistungen/eudi-wallet/)
(in German) · **administration@kontrollfeld.de**

## Local development with the EUDIPLO mock

The bundled mock (`deploy/mock-eudiplo/server.mjs`, **no dependencies**) implements exactly those
endpoints and replaces the wallet scan with a small "mock wallet" page. That way the **complete**
flow (verify → review → connect) runs on `localhost` — camera included, because `localhost` is a
*secure context* (no HTTPS or ngrok needed).

**Once, install the dependencies:**

```bash
npm ci
```

**Then three terminals:**

```bash
# 1) Mock EUDIPLO  (endpoints + mock wallet page on :8080)
npm run mock:eudiplo            # SELF_URL=http://localhost:8080 (default)

# 2) The app against the mock — the mock ignores the client ID and secret, but without
#    them the app never sends it a request ("verifier offer failed" in the browser)
EUDIPLO_BASE_URL=http://localhost:8080 \
EUDIPLO_CLIENT_ID=local-mock \
EUDIPLO_CLIENT_SECRET=local-mock-secret \
PUBLIC_URL=http://localhost:3000 \
ALLOWED_ORIGINS=http://localhost:3000 \
npm run dev

# 3) Testing: open TWO tabs on http://localhost:3000 (host + guest)
```

Click-through: the host sets up the call and shares the link (the second tab). "Verifizieren mit
d-you Wallet" opens the wallet modal; its button for this device leads to the **mock wallet**
(opening it counts as "fetched", so the modal switches to "Weiter in der d-you Wallet") → enter a
name → "Verify ✓" → the mock fires the webhook → "Verifizierung erfolgreich!" → both confirm the
review → the P2P connection is up.

> The mock is **for development only**: no cryptography, it believes any name typed into it.
> Never use it in production. Extending it (more attributes, error cases) makes a good
> `good first issue`.

**Via compose instead of npm** (on a server with a domain): `docker compose --profile mock up -d`
and set `EUDIPLO_BASE_URL=http://mock-eudiplo:8080` in `.env`, plus any non-placeholder values for
`EUDIPLO_CLIENT_ID` and `EUDIPLO_CLIENT_SECRET` — the mock ignores them, the startup check does
not. The mock wallet is then reachable at `https://<DOMAIN>/mock` (`SELF_URL` is set accordingly).

## Conformance tests with ERICA

The mock above proves the flow, not the cryptography. For that there is a second, heavier test:
[ERICA](https://gitlab.opencode.de/bmi/eudi-wallet/erica), the BMI's wallet simulator, presents
real SD-JWT and mdoc PIDs to a real EUDIPLO 9.1, which reports to the app as in production. Only
Docker is needed:

```bash
npm run test:erica        # builds ERICA (pinned commit), EUDIPLO, the app; runs all scenarios
npm run test:erica:down   # removes the containers again
```

What it covers: ERICA's HAIP checks of the request EUDIPLO builds from our configuration; that
expired, not-yet-valid, unsigned, wrong-nonce, wrong-audience, unbound and incomplete
presentations do **not** verify anyone; that names with umlauts, prefixes and double names arrive
intact; that over-disclosed claims never reach the other side; that a wallet ignoring channel
binding is refused. The report lands in `test/erica/report/junit.xml`.

`npm run test:erica:live` checks the **request** of a live EUDIPLO instead (validation only, no
presentation; the session is deleted afterwards). Passing ERICA is not a certification. Details,
known gaps of ERICA and how to bump it: [test/erica/README.md](test/erica/README.md).

## Wiring up TURN properly

`coturn` runs with **TURN REST** (`use-auth-secret` + `--static-auth-secret=$TURN_SECRET`): the
client obtains **short-lived** credentials derived from that same secret — no static
username/password.

> The backend serves the ICE configuration from `GET /ice`. If `TURN_URL`
> (`turn:<DOMAIN>:3478`) **and** `TURN_SECRET` are set (the latter identical to coturn's
> `static-auth-secret`), the response contains ephemeral TURN REST credentials:
>
> ```
> username   = <unixTimestamp + TTL> ":eudi"
> credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
> iceServers = [{ urls: ["turn:<DOMAIN>:3478", "…?transport=tcp"], username, credential }]
> ```
>
> The client fetches `/ice` on load and **before every** `RTCPeerConnection` (fresh
> credentials). Without `TURN_URL`/`TURN_SECRET`, `/ice` returns STUN plus a public fallback
> relay. In `docker-compose.yml`, `TURN_URL`/`TURN_SECRET` are already passed through to the app
> service — you share the same `TURN_SECRET` with the coturn service.

**One coturn per port and host.** A second coturn on the same machine that also binds 3478 (for
another application) does not fail to start: Linux lets both listen (`SO_REUSEPORT`) and hands
each new client to one of them at random. With two different secrets, about every second
allocation then fails with `401` — calls work sometimes, mostly over Wi-Fi, and rarely between
two phones on mobile data, which always need the relay. `ss -lunp | grep :3478` shows two
`turnserver` processes. Give each coturn its own listening port **and** its own relay port range.
On whosit.eu this happened in October 2026; whosit's coturn has run on **3479** with relays
**49201–49300** since then.

### TURN over 443 — for corporate and government networks

The normal situation there: outgoing **UDP blocked entirely**, TCP only on **80/443**. That rules
out port 3478 whether UDP or TCP — a call cannot be established at all. Over 443 the traffic
looks like HTTPS and passes most filters.

This is **not** needed for media confidentiality (DTLS-SRTP encrypts end to end regardless); it
is purely about reachability.

**Recommended: Traefik terminates TLS on 443 and forwards to coturn.** That keeps 443 with
Traefik, the distinction is made by SNI, and coturn needs **no** certificate of its own —
`no-tls` can stay.

No second TURN server: the same coturn, the same `TURN_SECRET`, the same relay ports — just a
second door.

#### 1. DNS

An A record `turn.<your-domain>` pointing at **the same** public IP as the application. The name
is a formality for the certificate: Let's Encrypt will not issue one for a bare IP, and that is
exactly where the 443 route fails without this step.

```bash
dig +short A turn.<your-domain> @1.1.1.1     # must return the server IP
```

> Your own machine may still fail to resolve the name minutes later while public resolvers
> already know it — a cached "does not exist" from an earlier query. When testing, check against
> `@1.1.1.1`, otherwise you mistake a local cache entry for a server fault.

#### 2. Traefik: a TCP router by SNI

A **dynamic** configuration file (in Coolify: Server → Proxy → *Dynamic Configurations*, e.g.
`turn-tls.yaml`). The main proxy file stays untouched — if in doubt, delete the file again and
everything is as before.

```yaml
tcp:
  routers:
    turn-tls:
      entryPoints:
        - https                      # Coolify calls it `https`, not `websecure`
      rule: "HostSNI(`turn.<your-domain>`)"
      service: turn-tcp
      tls:
        certResolver: letsencrypt    # the same resolver as for the website
        domains:
          - main: "turn.<your-domain>"
  services:
    turn-tcp:
      loadBalancer:
        servers:
          - address: "host.docker.internal:3478"
```

Three points where this otherwise fails:

- **`routers:` and `services:` are siblings** under `tcp:`, not nested.
- **No `passthrough`.** Traefik MUST terminate TLS — coturn then receives ordinary TURN/TCP on
  3478 and needs no certificate of its own; `--no-tls` can stay.
- **`host.docker.internal`** only works if the proxy container has
  `extra_hosts: ['host.docker.internal:host-gateway']` set (the default in Coolify). coturn runs
  on the host network and is reachable that way.
- **Set `--relay-ip` to the public address** when coturn listens on all interfaces. Traefik
  reaches coturn via `host.docker.internal`, i.e. the Docker bridge (`10.0.0.1`), and without
  `relay-ip` coturn binds the relay port to the address the request came in on. The allocation
  succeeds and advertises the public IP (`external-ip`), but the port is only open on the bridge:
  nobody can send media to it. On a host whose public IP sits on an interface (e.g. Hetzner):
  `--relay-ip=<public IP>`. Behind 1:1 NAT (e.g. AWS) it is the private interface address
  instead, with `--external-ip=<public>/<private>`.

`HostSNI` with a concrete name cannot capture other connections: everything else on 443 continues
unchanged.

#### 3. In the application

```
TURN_TLS_URL=turns:turn.<your-domain>:443?transport=tcp
```

Then **restart** — the variable is read at process start, saving alone is not enough. `/ice`
appends the entry at the **end** of the list: the browser tries them in order, and the slowest
route should apply when nothing else works, not be preferred.

#### Proving that it actually carries traffic

A valid certificate only proves that **Traefik** answers — not that coturn is behind it. Three
stages, each sharper than the last:

```bash
# a) Is TLS served under the right name?  (via the IP, bypassing local DNS)
echo | openssl s_client -connect <IP>:443 -servername turn.<your-domain> 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

**b) Is there actually a STUN server behind it?** Send a 20-byte binding request through the TLS
connection; response type `0x0101` is a binding success.

**c) The real proof: a complete TURN allocation.** Send an allocate request with
`REQUESTED-TRANSPORT=UDP`, take `realm` and `nonce` from the `401` response, and send it again
with `USERNAME`/`REALM`/`NONCE` and `MESSAGE-INTEGRITY` (key =
`MD5(username:realm:credential)` from `/ice`). Response type `0x0103` with `XOR-RELAYED-ADDRESS`
means a relay port was actually allocated. That is exactly what the browser would do — and still
not enough: an allocated port can be unreachable (see `relay-ip` above). The last proof is media
through it: two `RTCPeerConnection`s, both `iceTransportPolicy: 'relay'` with only the `turns:`
entry, exchanging a DataChannel message.

In the browser the same thing can be checked with an ICE gathering run using **only** the
`turns:` entry (no STUN, no UDP TURN). Two traps there:

- **The candidate line always says `udp`**, even when the relay was reached over TCP/TLS — that
  field describes the relay↔peer leg. Whether you got out over TCP is revealed **only** by
  `relayProtocol` from `getStats()`.
- An `RTCPeerConnection` error **701 "Failed to establish connection"** can simply mean the
  browser cannot resolve the hostname. So before debugging the server, check whether your own
  machine knows the name.

**Alternative without Traefik** (your own host, 443 free): in
`deploy/coturn/turnserver.conf` remove `no-tls`/`no-dtls`, set `tls-listening-port=443` (or
5349) and `cert=`/`pkey=`, and mount a certificate into the container.

## Configuration (ENV)

Full template: [`.env.selfhost.example`](.env.selfhost.example).

| Variable | Purpose |
|---|---|
| `DOMAIN` | Public domain (DNS must point at the host) |
| `ACME_EMAIL` | Let's Encrypt contact address |
| `TURN_SECRET` | Shared secret for TURN REST (`openssl rand -hex 32`) |
| `TURN_EXTERNAL_IP` | Public IP that coturn advertises as its relay address |
| `EUDI_VERIFIER` | `eudiplo` (default) or `none` — run without any verifier: anonymous calls only, with a permanent test-mode banner. See [Running without a verifier](#running-without-a-verifier) |
| `EUDIPLO_BASE_URL` | EUDIPLO endpoint (real, or `http://mock-eudiplo:8080`) |
| `EUDIPLO_CLIENT_ID` | EUDIPLO tenant |
| `EUDIPLO_CLIENT_SECRET` | Tenant client secret — the recommended route |
| `EUDIPLO_ROOT_ID` / `EUDIPLO_ROOT_SECRET` | Legacy alternative: EUDIPLO root login (rotates the tenant secret) |
| `VERIFIER_REQUEST_ID` | Fallback verifier ID (normally computed per attribute set) |
| `EUDI_PRIVACY_POLICY_URL` / `EUDI_SUPPORT_URI` | *(optional)* Privacy policy and support contact for the registration certificate; otherwise the tenant's registrar defaults apply. See [Registration certificate](#registration-certificate-wrprc) |
| `EUDI_REGISTRATION_CERT_FILE` / `EUDI_REGISTRATION_CERT` | *(optional)* Import a registration certificate (JWT) instead of having EUDIPLO issue one |
| `EUDIPLO_ACCESS_KEY_CHAIN_ID` | *(optional)* The EUDIPLO key chain (type `access`) that signs this instance's requests; unset, the tenant's default. With it, or with an imported registration certificate, the instance registers its verifier configs under ids of its own |
| `EUDI_TRUST_LIST_IDS` | Id(s) of the trust list(s) on your EUDIPLO instance that decide which PID issuers are accepted — the last path segment of `…/issuers/<tenant>/trust-list/<id>` |
| `EUDI_STATUS_CHECK_MODE` | *(optional, EUDIPLO 9.1)* `strict` (default), `best_effort` or `disabled`: what happens when the issuer's status list cannot be fetched. Under `strict`, a status list that returns 404 rejects every PID, reported by EUDIPLO as `trust_list_unavailable`. Sent with every verifier config; relax it only against a sandbox, and a start warns while it is relaxed |
| `ALLOWED_ORIGINS` | *(optional)* permitted WebSocket origins (CSWSH protection); default: same host |
| `EUDI_MODULES` | Modules to load, comma-separated: directories or installed packages, e.g. `./pro`. See [Modules](#modules). A listed module that does not load, does not fit or conflicts → startup aborts in production, instead of silently running without it |
| `EUDI_PRO_MODULE` | The earlier single-module variable — still read, as one more entry of `EUDI_MODULES` |
| `EUDI_EDITION` | `community` (default) or `pro` — reported in `/capabilities`. It no longer unlocks anything: a module's features are on exactly when the module is loaded |
| `EUDI_FEATURES_OFF` | Comma-separated list of features to switch off, e.g. `file-transfer,screen-share` — module features included |
| `EUDI_USAGE_FILE` | *(optional)* Call minutes: per calendar month (German time) the number of calls and their total seconds — nobody and no single call in it. Written when a call ends, never served over HTTP; unset, counted in memory and logged only. A call runs while at least two are connected; a dropped connection that does not come back ends it when it dropped, not when the reconnect wait runs out. Put it on the persistent volume. See `src/usage.ts` |
| `EUDI_QES_CA_FILE` | *(Pro)* Key and certificate of the demo CA for device-bound signatures; default `qes-demo-ca.json` next to `EUDI_AUDIT_FILE`. Must be on a persistent volume |
| `EUDI_IOS_APP_URL` | *(Pro)* Where browser users get the iPhone app for "Mit dem Smartphone signieren"; default the public TestFlight link |

Otherwise the application derives its public origin from the proxy headers — behind Traefik that
works with no further effort.

## Security

- **WSS everywhere**, HTTP→HTTPS redirect enforced (Traefik).
- **Authenticated webhook** (per-session token in the URL, `timingSafeEqual` server-side).
- **Hardened WebSocket**: origin check, `maxPayload`, rate limit, room ID validation; a message
  that is not an object with a string `type` is dropped, and no message can take the process
  down (`npm run test:ws-robustness`).
- **The call gate is the server's:** offer, answer and ICE candidates are relayed only between a
  pair the server itself told to connect (`ready`), and only while both are verified and have
  agreed. A client of someone's own making gets nothing through before that — not even a
  network address (`npm run test:signaling-gate`). The page refuses an offer before `ready` too.
- **Agreement is to the people reviewed:** it is accepted only while the review is open, and
  before the call starts any change of who is in the room takes every agreement back — a person
  who takes a free seat never inherits the other side's agreement (`npm run test:consent-binding`).
  A short trip to the wallet app and back is not such a change: the seat and the agreement stay.
- **coturn** as a relay only, private IP ranges blocked (SSRF protection), secret never
  committed.
- **Webhook token never logged:** the token in the callback URL authenticates the wallet's
  result; the application never writes it anywhere (`npm run test:purge` checks the log). The
  compose file keeps Traefik's access log off. If you switch it on, drop the request path, which
  carries the token: `--accesslog.fields.names.RequestPath=drop`.
- **No replay:** the webhook token is consumed after a successful check — an intercepted callback
  cannot be replayed. Otherwise the verification record would be forgeable, and a record showing
  more events than actually happened is worthless as evidence.
- **Zero retention at the verifier:** EUDIPLO keeps the result of a presentation in a session
  row of its own so a relying party can poll for it. This application never polls — the result
  arrives at its webhook — and therefore deletes that session (`DELETE /api/session/:id`)
  immediately: after a successful presentation, after a failed one, and when a participant
  leaves with the QR code still unused. Without it the claims would stay at the verifier until
  its time-based sweep (`SESSION_TTL`, 24 h by default) removed them. See
  [`src/verifier-session.ts`](src/verifier-session.ts) and `npm run test:purge`.

  Since 2026-11-05 also in the corners: a wallet that answers after the person left (the
  callback for an unknown session deletes the verifier's copy, at most 30 a minute); a module's
  presentation that ran out before anyone asked for it; an offer finished while the person was
  already leaving. A delete that fails for a reason that may pass (no answer, 5xx, 429) is tried
  again after 30 s, 2 min and 8 min (`EUDI_PURGE_RETRY_MS` sets the first wait); a refusal
  (401/403) is not, the log says what to fix. Every call to the verifier gives up after 10 s.

  Two things to know when operating this:
  - the tenant client needs the role **`presentation:request`** — the same one that creates the
    offer. Without it EUDIPLO answers the delete with 403; the call still works, the log then
    says `PURGE FAILED`, and the instance's TTL is all that is left.
  - the purge is a safeguard, not the only one. Keep the verifier's own retention short as
    well (`SESSION_TTL`, `SESSION_TIDY_UP_INTERVAL`, or `sessionConfig.ttlSeconds` per tenant),
    so an instance that is unreachable for a moment does not quietly become an archive.
- **No framing** without explicit configuration (no wildcard default).
- **Content-Security-Policy on the app page:** scripts only from this origin, plus the page's own
  inline scripts by the hash of their exact text — computed from the HTML actually sent, so a
  branded page is covered too; an injected script has another hash and does not run
  ([`src/csp.ts`](src/csp.ts), `npm run test:csp`). Module pages are not covered: they bring their
  own markup. A whole call under the policy (QR, PDF viewer, background blur, WebRTC) was run in a
  browser without a single violation.
- **No Docker socket in Traefik:** it reads the container list through a read-only socket proxy
  on an internal network; the API's write side (create, exec, …) is refused.
- **Registration certificate:** an expired one is refused at startup, and one that runs out while
  the instance runs is no longer sent — EUDIPLO issues one via its registrar until a new one is set.
- **Baseline headers** on every answer: HSTS, `nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin` (room links carry the room id), a `Permissions-Policy` that
  switches off what the app never uses.
- **Limits on by default** (since 2026-11-05): `POST /invite` 100 and `GET /wallet-pass` 30 per
  client IP per 10 minutes (`EUDI_RATE_LIMIT_*`, `0` = off). A pass without an invitation is only
  signed for a room that is open right now — otherwise anyone could have passes signed with the
  operator's certificate under a title of their choosing.
- **Brakes per address** (on by default): at most 30 open connections, 60 new rooms per
  10 minutes (each creates a verifier session) and 120 `/ice` requests per 10 minutes per client
  IP; a fresh wallet offer at most every 10 s per person. TURN credentials last 6 h (was 24 h).
  They are not bound to a room yet: the page and every app build in use fetch `/ice` before
  joining (network check, camera test, phone pairing). `npm run test:abuse-limits`.
- **Not root:** the container starts as root only to hand data volumes from earlier versions to
  the user `node`, then runs as `node` (`scripts/docker-entrypoint.sh`).
- **Dependencies checked:** the `audit` job runs `npm audit --omit=dev --audit-level=high` on every
  pipeline — a warning, not a blocker, so a fix of our own is never held up by a new advisory.
- **Startup check:** in production the server refuses to start when required values are missing or
  recognised placeholders are present — naming only variables, never values.
- Found a vulnerability? → [`.github/SECURITY.md`](.github/SECURITY.md), please **not** as a
  public issue.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No certificate / "acme" error | DNS does not point at the host, or port 443 is closed. Check `dig +short $DOMAIN` and the firewall. |
| The call only connects on the same Wi-Fi | TURN unreachable or not wired up. Open UDP 3478 + 49160–49200; is `TURN_EXTERNAL_IP` correct? See [TURN](#wiring-up-turn-properly). |
| Every sign-in fails with a bare HTTP 400 | A trust list configured in EUDIPLO has expired. See [Trust lists expire](#trust-lists-expire-after-30-days). |
| Wallet refuses with "verifier_info is missing" | No registration certificate reaches the wallet, usually because the EUDIPLO tenant has no registrar configuration. See [Registration certificate](#registration-certificate-wrprc). |
| The mock verifies but the app does not react | `PUBLIC_URL` is wrong → the webhook URL is unreachable. It must be the URL at which the app is reachable *for the mock*. |
| WebSocket 403 | `ALLOWED_ORIGINS` does not match the domain being used. |
| Camera/microphone blocked | Only over HTTPS or `localhost` (secure context). |

## What is included

The **complete call — 1:1 and multi-party (mesh)** — and **all** security and privacy properties — nothing is cut back
there, and neither is the convenience: video, audio, chat, EUDI PID verification with a
mutual privacy gate, attribute allowlist and purpose limitation, an ephemeral pseudonym, a
PII-free verification record, channel binding, both wallet formats (mdoc + SD-JWT VC),
microphone and camera toggles, screen sharing, stage layout, hand raising, file transfer, emoji,
calendar entries, an Apple Wallet pass, document sharing and signing, iframe embedding,
in-call credentials, custom branding, and a self-hosting stack with your own TURN server.

**Comfort around the call** (all in the community edition, all local to the device):

- **Device check before the call.** A card next to inviting/identifying shows the camera picture, a
  microphone level, camera/microphone/speaker selection (speaker only where the browser has
  `setSinkId`), a test sound (the whosit sound mark; the neutral tone on operator-branded
  instances), and "join muted" / "join with camera off". Without a chosen camera the front one is
  asked for (`facingMode: 'user'`) — phones and the app could otherwise open the back camera. The permission prompt comes
  here, not after both sides have identified. A running check hands its stream to the call (no
  second prompt); switching the call type stops it. Chosen devices are remembered in
  `localStorage` (`eudi_devices`); the "join muted" choices are not.
- **Arrival notice.** When the other side joins, and again when it has identified ("Dein Gast hat
  sich ausgewiesen"): a short sound (Web Audio, so only after the page has seen a gesture), and
  while you are away the title reads "● Dein Gast ist da". Hosts can additionally allow a system
  notification (button in the invitation card; hidden in the app and wherever the browser cannot
  notify). "Away" is a hidden tab OR a window without focus — another app in front of a visible
  browser window does not make the page `hidden`. Who is already there when you arrive is not
  announced.
- **"Du bist stummgeschaltet."** While muted, the level of a *clone* of the microphone track is
  measured (the muted original reads as silence); about 1.2 s of speech within 2 s shows a bubble
  above the call controls with "Mikrofon einschalten", at most every 30 s. Nothing is sent.
- **Screen stays on** during the call via the Screen Wake Lock API where available (re-acquired
  when the page becomes visible again).
- A new data channel learns the current mute/camera state, so "join muted" and late joiners show
  the right badges. Audio calls play the remote sound from a hidden `<audio>` element.
- **The whosit sound mark** (`public/sounds/`): the Morse code QRZ ("who is calling me?"). The
  whole mark plays once for everyone when a call connects — and that is the only sound of a call
  (since 2026-11-02: no arrival sound any more, and the mark is never replayed when a call ends;
  a guest's arrival still shows in the tab title and as a system notification). The answer alone
  is what the "Töne" switch plays when turned on.
  Instances with operator branding keep a neutral two-tone chime and never play the mark.
  "Branding" means an operator NAME (`EUDI_BRAND_NAME`), as for the `branded` class: a logo alone
  is not one (www.whosit.eu sets `EUDI_BRAND_LOGO` to our own mark — until 2026-10-29 that silenced
  the mark there and hid the whosit background). Brand assets like the logo: copied unchanged from the media kit, see the README there.
- **The logo animation** (`public/logo-animation.js` / `.css`, the one approved animation of the
  logo, see `public/logo/README.md`): once when a call connects, in step with the sound mark, as a
  light card in the middle that lets taps through and fades after about 3 s. Only on unbranded
  instances, not with "reduce motion", independent of the "Töne" switch (it is silent). The logo
  file is fetched on the first gesture together with the sound mark, so picture and sound start
  together.
  The picture follows the sound's clock (`whositLogoAnimation.play(box, { clock })`): Web Audio's
  start time minus the output latency in the call, the media element's `currentTime` at app start
  (it loads first, then plays) — a late sound no longer leaves the picture ahead.
  In the **app**, a page of its own greets once per launch (`#app-intro`, `playAppIntro`, since
  2026-10-31): the same logo animation with the sound mark 12 dB quieter
  (`sounds/whosit-klangzeichen-leise.mp3`; iOS ignores media volume, so the level is in the file)
  on a sky whose colours move with the sound — blue first, turquoise while the ring builds up, gold
  with the star; nothing moves over the logo itself (the waves and the glow were
  removed on 2026-11-05, so only the Morse signal reads) — then the app fades in underneath
  (about 3.5 s; a tap skips it, 8 s at most whatever happens). The sky and the logo both follow
  the sound's clock. The colour logo needs light ground, so in dark mode it sits in a light halo.
  The logo is made visible and its animation started in the same task — with a frame between
  the two, the finished logo flashed up first (fixed 2026-11-05).
  Not when the app opens on an invitation or a wallet return, not with "reduce motion", silent
  when "Töne" is off. A head script in `index.html` shows the page from the first paint
  (`html.ai-on`, not `app-intro`: that class would also match the page's own `display: none`),
  so nothing of the app flashes first; `playAppIntro` takes it away on a branded instance. The
  launch address is kept in `LAUNCH_QUERY`, because boot adds `?room=` for a new call.
- **"Töne" switch** (`#sound-toggle`): a speaker button in the footer on the website, the row
  "Töne" in the app's settings (moved there like the theme button). Off silences the sound mark — not the device check's test tone, not the tab title or the system
  notification. Stored per browser as `eudi_sounds` = `0` (unset = on); switching it back on plays
  the arrival sound once, so you hear what you chose.
- **Background: blur or replace** (`background-effects`). Tiles in the device check and behind the
  "Hintergrund" button in the call: no effect, blur, a whosit background (the logo *file* from
  `public/logo/`, the white file repeated as a faint brick pattern so that some are in view in
  any crop, only on unbranded instances), and an own picture. (Four drawn backgrounds were
  removed on 2026-10-29; a stored choice of one falls back to no effect.)
  `public/background.mjs` segments the camera on the device with MediaPipe (self-hosted in
  `public/vendor/mediapipe/`, SIMD build only) and composites onto a canvas whose
  `captureStream()` track replaces the camera track in the stream and in every sender — the
  other side only receives the composited picture. Every camera frame is first copied onto a
  canvas and only canvases are composited: WebKit (Safari, the iOS app) ignores the composite
  operation when a `<video>` is drawn directly, so until 2026-10-29 the cut-out came out as the
  raw picture there. Without any mask after 4 s the effect fails visibly instead of passing on
  the room. Lazy: the ~11 MB of WebAssembly load only when
  someone picks an effect. The choice is remembered in `eudi_devices`, an own picture (scaled to
  ≤1280 px) in `eudi_bg_custom`; neither leaves the browser. While the logo or an own picture is
  on, the self-view is not mirrored (the writing would read backwards). Stopping a stream also
  stops the real camera behind the effect (`stopMediaStream`). **Stay on MediaPipe 0.10.x** unless
  a newer one is checked: 1.x sends usage metrics to Google (see the vendor README).

**Three features are commercially licensed** — where there is a real obligation behind them. They
come as modules released separately (see [Modules](#modules)), not in this repository.

| Feature | Module | Why |
|---|---|---|
| Verification trail with retention and export | `@whosit/audit-trail` | Responsibility for retained evidence: deadlines, export, liability |
| Qualified remote signatures (CSC/QTSP) | `@whosit/qes-csc` | Requires a contract with a trust service provider, with a per-signature cost. Placeholder until Phase 6; without the module no CSC provider is offered |
| Device-bound signatures (Secure Enclave / StrongBox) | `@whosit/qes-device` | The key is generated in the phone's secure element behind biometrics and never leaves it; a certificate authority certifies it once from the PID presented in the call. Today that authority is a **demo CA** — the signature is not legally binding. App only, see below |

### Modules

Functions beyond the core come as **modules**: a directory or npm package with a `whosit`
manifest in its `package.json`, loaded through `EUDI_MODULES` — a path or a package name. Ours
(`@whosit/audit-trail`, `@whosit/qes-csc` and `@whosit/qes-device`) are released on their own and installed from a package registry.

```json
"whosit": {
  "id": "audit-trail",
  "coreApi": "^1",
  "features": [{ "id": "audit-trail", "title": "Verification audit trail with retention and export" }]
}
```

```bash
EUDI_MODULES=@whosit/audit-trail,@whosit/qes-device   # or paths: ./instance/node_modules/@whosit/…
```

- **The manifest is read first, without running module code.** A module built for another core
  API (`coreApi`), one that claims a feature of the core, or two modules claiming the same id,
  feature or path are refused before anything is wired. Then each module's `register(defaults)`
  returns what it adds through the ports in [`src/core/ports.ts`](src/core/ports.ts): a
  verification sink, signalling plugins, a signer, browser files.
- **A module can only add.** It cannot redeclare or switch off a capability of the core, so the
  attribute allowlist, purpose limitation, pseudonym and PII-free record stay out of its reach.
- **Its features are on exactly when it is loaded,** and `EUDI_FEATURES_OFF` switches them off
  like any other. `GET /capabilities` lists the loaded modules with their versions.
- **Browser files** a module ships are served under `/modules/<id>/`, plus any `clientAliases`.
- **Routes** (`routes(router, ctx)` in what `register()` returns, ports `ModuleRoutes`): pages and
  an API of its own, mounted under `/modules/<id>/` and its `clientAliases`, after its browser
  files, and **only while one of its features is on** — `EUDI_FEATURES_OFF` takes the pages down.
  The core's own routes come first. `ctx` brings:
  - `presentations` — a **wallet presentation outside a call** (`src/presentations.ts`), for a form
    or a delivery. Only attributes the instance's WRP policy permits (anything else and the
    room-scoped `pseudonym_id` are refused, not narrowed); the wallet is asked for exactly those,
    and only those come back even when it presents more; the verifier session is purged at once;
    the values are handed to the module **once** (with the secret from `start`, never by id alone)
    and dropped after ten minutes at the latest; the record names attributes, never values. The
    callback arrives on the core's `/webhook/:sessionId` like a room's.
  - `staff` — the instance's staff links (`EUDI_STAFF_SECRET`); without a secret `active()` is
    false and every token fails, so a module keeps its staff pages closed.
  - `dataDir` — `<EUDI_DATA_DIR or /data>/modules/<id>`, created; `publicOrigin(req)`; `brandName`.
  Optional additions to the API, so `coreApi` stays `^1`. Tested in `test:module-presentations`
  with a throwaway module.
- **Actions in a call** (`actions` in what `register()` returns, ports `ModuleAction`,
  `src/call-actions.ts`): something a module does WITH a guest while the call goes on — a form,
  later a signature or a delivery. One page serves both ways: without a call it asks the wallet
  itself (`presentations`), in a call it takes the identity from the call. The host opens
  "Aktionen" (shown when `/capabilities` says `actions: true`) and picks an action and a choice
  for a guest; the guest sees who asks, for what and **which verified data** the module will
  receive — what the choice needs AND the guest presented in this call — and agrees; the module's
  page opens in a panel over the call (a sheet on the right, full screen on a phone; audio and
  video keep running) with `?ruf=<token>`. `ctx.calls.redeem(token)` hands the module that
  identity once, only after the guest agreed and only while they are still in the call;
  `ctx.calls.done(token, { summary })` tells the host ("Erledigt: … — Eingang 42"). Declining,
  withdrawing and leaving end it and tell the other side; an open action ends after 30 minutes.
  The guest's consent is the core's own dialog, which names the data before the module sees any.
  `ctx.frameOrigins` lists the app origins that may frame the module's page (for
  `frame-ancestors`). Tested in `test:call-actions`.
- **Further credentials** (`credentialCatalog` in what `register()` returns, since 2026-11-02):
  requesting a driving licence or a membership in a call is no longer the core's — the
  `in-call-credentials` capability is declared by the module that brings the catalog
  (@whosit/nachweise, its list curated by us, the instance's order picks from it). Without such a
  module the capability does not exist; `EUDI_CREDENTIAL_CATALOG` is no longer read. The core
  keeps the engine (`src/credential-catalog.ts`: every entry the module hands over is validated on
  each read, the DCQL query, the claims from the verifier's answer; `src/credential-requests.ts`:
  consent, wallet, result for the host). A host starts it from "Aktionen": a module action with
  `credential: true` runs this flow instead of opening a panel. Outside a call a module asks with
  `ctx.presentations.startCredential({ credentialId })` — only ids the catalog holds, the
  mandatory claims or nothing. Tested in `test:credential-module`.
- **Several modules side by side** are fine; their verification sinks all receive every record.
- **Failure:** in production a listed module that does not load stops the start. In development
  it is skipped with a warning.
- **Check without starting:** `EUDI_MODULES=… npm run modules -- check` lists the modules,
  their features and whether they fit, and exits non-zero if one would not load.

The module API is versioned (`MODULE_API_VERSION` in [`src/core/modules.ts`](src/core/modules.ts))
and still internal — every incompatible change raises it, so a mismatch shows at startup rather
than in the middle of a call.

### Device-bound signatures

The model a trust service provider will follow once it certifies wallet-held keys, built now so
the key custody can be proven out before one does:

1. The app's native `DeviceSigner` plugin (in the proprietary app repository) creates a P-256 key
   in the **Secure Enclave** (iOS) or **StrongBox** (Android), usable only after biometric
   authentication, and exports nothing but the public key. Without StrongBox the Android app
   offers no device signature at all — it does not fall back to the weaker TEE.
2. The browser module `client/device-local.js` of `@whosit/qes-device` (served under
   `/modules/qes-device/` and `/pro-client/`, never part of the AGPL client) builds a CSR and has the device sign it — the first biometric prompt.
3. The server hands it to the module's demo CA — only for a participant verified in
   this call, over their own signalling connection. The CA checks the proof of possession and
   certifies the key with the **names from the PID**, not from the CSR.
4. Every document signature is made on the device, one biometric prompt each, and embedded as
   PAdES baseline B-B (signingCertificateV2, no signing-time attribute).

**In a browser, the phone signs.** WebCrypto cannot reach the secure element, so a browser is
offered "Mit dem Smartphone signieren" instead (the module's `client/paired-phone.js`):

1. The browser asks for a one-time pairing token — only a participant verified in this call gets
   one — and shows it as a QR code (`https://<host>/?pair=<token>`).
2. The phone's camera opens it in the app (universal link). The two ends open a WebRTC
   DataChannel of their own; the server relays only SDP and ICE (`src/device-pairing.ts`). The
   document goes peer to peer — the server never sees it, the same promise as in the call.
3. The phone shows **every page** of the document (the module's `client/paired-signer.js`), the person
   confirms with Face ID, and the phone adds the signature to exactly those bytes and returns the
   grown PDF. Deliberately not "send the hash": a phone signing a hash handed to it signs whatever
   the browser claims.
4. The certificate is issued in the name of the participant who **created** the pairing — the
   phone has no identity of its own in the call. Holding the token is what makes it theirs, so the
   token is single-use, expires unscanned after 5 minutes, is never logged, and the phone's
   certificate request is refused once its owner has left the call.

What operators need to know:
- **"Get the app":** wherever someone meets the phone signature without the app — under the
  provider choice in the call, in the QR dialog, on the page a browser opens instead of the app —
  a card links to it: `EUDI_IOS_APP_URL`, by default the public TestFlight link. After the App
  Store release, set it to `https://apps.apple.com/app/id6792466540`; no client change needed.
- **No software key anywhere.** A browser is never offered a provider that signs locally — it
  would claim a custody it does not have.
- **Universal link:** `?pair=` is in the apple-app-site-association (`EUDI_IOS_APP_ID`); an app
  build older than the pairing support opens a fresh room instead, which the user notices at once.
- **When the link opens Safari anyway** — and it will: iOS reads the association file from
  **Apple's CDN**, which serves a changed file only hours later (`max-age` 6 h, check with
  `curl https://app-site-association.cdn-apple.com/a/v1/<host>`), and a user who once chose "open
  in Safari" stays in Safari for the whole domain. The page then does **not** present the token
  (that would use it up) but offers "In der whosit-App öffnen" via the app's own scheme
  `whosit://open?pair=…`.
- **The CA key** lives in `EUDI_QES_CA_FILE` (mode 0600); by default `qes-demo-ca.json` next to
  the audit trail (`EUDI_AUDIT_FILE`), i.e. on the volume that already has to be persistent. A
  new CA after a restart makes every earlier signature unverifiable against the current one.
- **Not yet proven:** that the key really sits in hardware. The next step is key attestation
  (Android key attestation, Apple App Attest), checked by the CA before it certifies.
- **Checking a signed PDF elsewhere:** the signatures are standard PAdES (baseline B-B), so any
  validator reads them — checked with Stirling PDF 3.0 (PDFBox). Expect "signature valid, covers
  the whole document" and "no trusted certification path": the issuer is the demo CA. Give the
  validator the demo CA certificate as a trusted root and the chain validates as well.
- `npm run test:qes-device` covers everything but the chip, with a software key behind the
  plugin's contract; `npm run test:qes-pairing` the pairing (token, relay, the owner's
  certificate, the DataChannel framing).

The registry in [`src/core/features.ts`](src/core/features.ts) is authoritative for the core — it
gives a reason for every entry; each module declares its own features in its manifest.
`GET /capabilities` shows what a running instance actually offers, modules included.

**Every feature can be switched off:** `EUDI_FEATURES_OFF=file-transfer,screen-share` — intended
for operators who must disable functionality for compliance reasons. Excluded are the call itself
and the privacy guarantees: a guarantee the operator can switch off would not be one.

## Licence

**AGPL-3.0-or-later** ([`LICENSE`](LICENSE)) — the whole repository. Strong copyleft with a network
clause: anyone operating a *modified* version as a service must offer its source code to their
users. Running it unmodified, self-hosting it and using it commercially are all free.

**The commercially licensed features are modules, released separately** (`@whosit/audit-trail`, `@whosit/qes-csc` and `@whosit/qes-device`). They are not
in this repository, and nothing here imports from them: the core builds and runs completely
without any module (verified by `npm run check:licence-boundary`, which also fails if a
commercially licensed file ever lands here). The core's feature registry does not name their
features either — each module declares its own. `docker build .` produces the core image, freely
redistributable; an instance that runs modules builds FROM it.

**The module code can be inspected** by licensees and, on request, by anyone evaluating it: an
audit trail or a signature whose code nobody may inspect is a weaker one. The protection is legal,
not technical — there is no licence key to circumvent.

Commercial licence, hosted operation or an SLA:
[`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md) · **administration@kontrollfeld.de**

Third-party components and their licences: [`NOTICE`](NOTICE).

## Contributing

Contributions are welcome — [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) explains the
process (DCO sign-off plus a one-time CLA agreement, [`CLA.md`](CLA.md)). Code of conduct:
[`.github/CODE_OF_CONDUCT.md`](.github/CODE_OF_CONDUCT.md).

For the maintainers: commit messages, branch names and merge request titles are in English, and
our own commits carry the team identity `Team Kontrollfeld <gitlab@kontrollfeld.de>`, never a
person's — set it per clone with `git config user.name/user.email`. Merges are fast-forward, so no
merge commit with the merging person's name reaches the public mirror; the `identity` job refuses
a merge request with a personal kontrollfeld.de identity (`scripts/check-commit-identity.mjs`).

```bash
npm test        # typecheck, licence boundary and all integration tests
```
