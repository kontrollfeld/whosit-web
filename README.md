# EUDI Verified Call — Community Edition

**Identity-verified peer-to-peer calls (video · audio · chat).** Both sides can identify
themselves with an **EUDI wallet (PID, the EU digital identity)** and see **before connecting**
which fields will be exchanged — the values only once **both** have agreed.

Self-hostable with `docker compose`: Node backend + Traefik (Let's Encrypt, WSS) + coturn
(TURN). No framework, few dependencies, state in RAM.

> **Where to reach us:** <https://github.com/kontrollfeld/id-call-web> — issues, pull requests and
> vulnerability reports belong there. Development itself happens in a private GitLab project, so
> this repository is a **read-only mirror**: maintainers port reviewed commits upstream, and they
> arrive here on the next sync. The copy on **openCode** is a second mirror.
>
> **Licence:** [AGPL-3.0-or-later](LICENSE) — with one exception: [`pro/`](pro/) carries its own
> commercial licence ([`pro/LICENSE`](pro/LICENSE)). See [Licence](#licence) below ·
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
- [Local development with the EUDIPLO mock](#local-development-with-the-eudiplo-mock)
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
  - EUDIPLO 8.0.2 as a container (`ghcr.io/openwallet-foundation/eudiplo`), **pin the
    version** — 6→7 and 7→8 were both breaking changes. Upgrading from 6.x: go straight to
    8.0.2 (7.0–7.2 break `/verifier/offer` after the database migration), back up the data
    volume first, and replace `EUDI_TRUST_LIST_URLS` with `EUDI_TRUST_LIST_IDS`.
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
git clone https://github.com/kontrollfeld/id-call-web.git
cd id-call-web

# 2) Create and fill in the env file (DOMAIN, ACME_EMAIL, TURN_SECRET, TURN_EXTERNAL_IP, EUDIPLO_*)
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

> What the application expects from EUDIPLO (the four endpoints the mock reproduces):
> `POST /api/oauth2/token`, `POST /api/client/:tenant/rotate-secret`,
> `POST /api/verifier/config`, `POST /api/verifier/offer` → returns an offer URI; after that
> **EUDIPLO POSTs the result to the application's webhook URL**
> (`…/webhook/:sessionId?t=<token>` — the token is verified server-side).

### "/" is the application, not a website

A fresh instance answers the bare URL with the call screen — set up, invite, identify. There is
no front page in this repository, deliberately: this is a tool for making verified calls, and an
instance you run should not greet visitors with marketing for a service that is not yours. Until
2026-09-13 it did exactly that.

If you want your own front page, put a `start.html` into `EUDI_OPERATOR_PAGES`. It then owns "/",
and anything beside it — stylesheet, images, a film — is served from `/operator/…`.

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

## Local development with the EUDIPLO mock

The bundled mock (`deploy/mock-eudiplo/server.mjs`, **no dependencies**) implements exactly those
endpoints and replaces the wallet scan with a small "mock wallet" page. That way the **complete**
flow (verify → review → connect) runs on `localhost` — camera included, because `localhost` is a
*secure context* (no HTTPS or ngrok needed).

**Three terminals:**

```bash
# 1) Mock EUDIPLO  (endpoints + mock wallet page on :8080)
npm run mock:eudiplo            # SELF_URL=http://localhost:8080 (default)

# 2) The app against the mock
EUDIPLO_BASE_URL=http://localhost:8080 \
PUBLIC_URL=http://localhost:3000 \
ALLOWED_ORIGINS=http://localhost:3000 \
npm run dev

# 3) Testing: open TWO tabs on http://localhost:3000 (host + guest)
```

Click-through: the host sets up the call and shares the link (the second tab). Where the QR code
would normally be, the link leads to the **mock wallet** → enter a name → "Verify ✓" → the mock
fires the webhook → both confirm the review → the P2P connection is up.

> The mock is **for development only**: no cryptography, it believes any name typed into it.
> Never use it in production. Extending it (more attributes, error cases) makes a good
> `good first issue`.

**Via compose instead of npm** (on a server with a domain): `docker compose --profile mock up -d`
and set `EUDIPLO_BASE_URL=http://mock-eudiplo:8080` in `.env`; the mock wallet is then reachable
at `https://<DOMAIN>/mock` (`SELF_URL` is set accordingly).

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
means a relay port was actually allocated. That is exactly what the browser would do.

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
| `EUDIPLO_BASE_URL` | EUDIPLO endpoint (real, or `http://mock-eudiplo:8080`) |
| `EUDIPLO_CLIENT_ID` | EUDIPLO tenant |
| `EUDIPLO_CLIENT_SECRET` | Tenant client secret — the recommended route |
| `EUDIPLO_ROOT_ID` / `EUDIPLO_ROOT_SECRET` | Legacy alternative: EUDIPLO root login (rotates the tenant secret) |
| `VERIFIER_REQUEST_ID` | Fallback verifier ID (normally computed per attribute set) |
| `EUDI_TRUST_LIST_IDS` | Id(s) of the trust list(s) on your EUDIPLO instance that decide which PID issuers are accepted — the last path segment of `…/issuers/<tenant>/trust-list/<id>` |
| `ALLOWED_ORIGINS` | *(optional)* permitted WebSocket origins (CSWSH protection); default: same host |
| `EUDI_EDITION` | `community` (default) or `pro` — unlocks the three commercially licensed features |
| `EUDI_PRO_MODULE` | Path to the Pro module, e.g. `./pro`. Only with a valid licence. Set but not loadable → startup aborts in production, instead of silently running without retention |
| `EUDI_FEATURES_OFF` | Comma-separated list of features to switch off, e.g. `file-transfer,screen-share` |

Otherwise the application derives its public origin from the proxy headers — behind Traefik that
works with no further effort.

## Security

- **WSS everywhere**, HTTP→HTTPS redirect enforced (Traefik).
- **Authenticated webhook** (per-session token in the URL, `timingSafeEqual` server-side).
- **Hardened WebSocket**: origin check, `maxPayload`, rate limit, room ID validation.
- **coturn** as a relay only, private IP ranges blocked (SSRF protection), secret never
  committed.
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

  Two things to know when operating this:
  - the tenant client needs the role **`presentation:request`** — the same one that creates the
    offer. Without it EUDIPLO answers the delete with 403; the call still works, the log then
    says `PURGE FAILED`, and the instance's TTL is all that is left.
  - the purge is a safeguard, not the only one. Keep the verifier's own retention short as
    well (`SESSION_TTL`, `SESSION_TIDY_UP_INTERVAL`, or `sessionConfig.ttlSeconds` per tenant),
    so an instance that is unreachable for a moment does not quietly become an archive.
- **No framing** without explicit configuration (no wildcard default).
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

**Three features are commercially licensed** — where there is a real obligation behind them, and
the code lives in [`pro/`](pro/):

| Feature | Why |
|---|---|
| Verification trail with retention and export | Responsibility for retained evidence: deadlines, export, liability |
| Qualified remote signatures (CSC/QTSP) | Requires a contract with a trust service provider, with a per-signature cost. Placeholder until Phase 6; without the Pro module no CSC provider is offered |
| Device-bound signatures (Secure Enclave / StrongBox) | The key is generated in the phone's secure element behind biometrics and never leaves it; a certificate authority certifies it once from the PID presented in the call. Today that authority is a **demo CA** — the signature is not legally binding. App only, see below |

### Device-bound signatures

The model a trust service provider will follow once it certifies wallet-held keys, built now so
the key custody can be proven out before one does:

1. The app's native `DeviceSigner` plugin (in the proprietary app repository) creates a P-256 key
   in the **Secure Enclave** (iOS) or **StrongBox** (Android), usable only after biometric
   authentication, and exports nothing but the public key. Without StrongBox the Android app
   offers no device signature at all — it does not fall back to the weaker TEE.
2. The browser module `pro/client/device-local.js` (served under `/pro-client/`, never part of
   the AGPL client) builds a CSR and has the device sign it — the first biometric prompt.
3. The server hands it to the demo CA (`pro/qes-device.ts`) — only for a participant verified in
   this call, over their own signalling connection. The CA checks the proof of possession and
   certifies the key with the **names from the PID**, not from the CSR.
4. Every document signature is made on the device, one biometric prompt each, and embedded as
   PAdES baseline B-B (signingCertificateV2, no signing-time attribute).

**In a browser, the phone signs.** WebCrypto cannot reach the secure element, so a browser is
offered "Mit dem Smartphone signieren" instead (`pro/client/paired-phone.js`):

1. The browser asks for a one-time pairing token — only a participant verified in this call gets
   one — and shows it as a QR code (`https://<host>/?pair=<token>`).
2. The phone's camera opens it in the app (universal link). The two ends open a WebRTC
   DataChannel of their own; the server relays only SDP and ICE (`src/device-pairing.ts`). The
   document goes peer to peer — the server never sees it, the same promise as in the call.
3. The phone shows **every page** of the document (`pro/client/paired-signer.js`), the person
   confirms with Face ID, and the phone adds the signature to exactly those bytes and returns the
   grown PDF. Deliberately not "send the hash": a phone signing a hash handed to it signs whatever
   the browser claims.
4. The certificate is issued in the name of the participant who **created** the pairing — the
   phone has no identity of its own in the call. Holding the token is what makes it theirs, so the
   token is single-use, expires unscanned after 5 minutes, is never logged, and the phone's
   certificate request is refused once its owner has left the call.

What operators need to know:
- **No software key anywhere.** A browser is never offered a provider that signs locally — it
  would claim a custody it does not have.
- **Universal link:** `?pair=` is in the apple-app-site-association (`EUDI_IOS_APP_ID`); an app
  build older than the pairing support opens a fresh room instead, which the user notices at once.
- **The CA key** lives in `EUDI_QES_CA_FILE` (mode 0600); by default `qes-demo-ca.json` next to
  the audit trail (`EUDI_AUDIT_FILE`), i.e. on the volume that already has to be persistent. A
  new CA after a restart makes every earlier signature unverifiable against the current one.
- **Not yet proven:** that the key really sits in hardware. The next step is key attestation
  (Android key attestation, Apple App Attest), checked by the CA before it certifies.
- `npm run test:qes-device` covers everything but the chip, with a software key behind the
  plugin's contract; `npm run test:qes-pairing` the pairing (token, relay, the owner's
  certificate, the DataChannel framing).

The registry in [`src/core/features.ts`](src/core/features.ts) is authoritative — it is the
single source of truth for the split and gives a reason for every entry. `GET /capabilities`
shows what a running instance actually offers.

**Every feature can be switched off:** `EUDI_FEATURES_OFF=file-transfer,screen-share` — intended
for operators who must disable functionality for compliance reasons. Excluded are the call itself
and the privacy guarantees: a guarantee the operator can switch off would not be one.

## Licence

**AGPL-3.0-or-later** ([`LICENSE`](LICENSE)) for everything **except** [`pro/`](pro/).

Strong copyleft with a network clause: anyone operating a *modified* version as a service must
offer its source code to their users. Running it unmodified, self-hosting it and using it
commercially are all free.

**`pro/` carries its own commercial licence** ([`pro/LICENSE`](pro/LICENSE)): readable and
auditable, but production use requires a licence. The code is in the open because a verification
trail whose code nobody may inspect is a weaker verification trail — whoever buys evidence should
be able to see the code it rests on. The protection is legal, not technical: there is no licence
key to circumvent.

Nothing under `src/` imports from `pro/`; the AGPL edition builds and runs completely without the
directory (verified by `npm run check:licence-boundary`). `docker build .` therefore produces an
image **without** `pro/` that may be redistributed freely;
`docker build --build-arg WITH_PRO=1 .` produces the Pro image.

Commercial licence, hosted operation or an SLA:
[`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md) · **administration@kontrollfeld.de**

Third-party components and their licences: [`NOTICE`](NOTICE).

## Contributing

Contributions are welcome — [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md) explains the
process (DCO sign-off plus a one-time CLA agreement, [`CLA.md`](CLA.md)). Code of conduct:
[`.github/CODE_OF_CONDUCT.md`](.github/CODE_OF_CONDUCT.md).

```bash
npm test        # typecheck, licence boundary and all integration tests
```
