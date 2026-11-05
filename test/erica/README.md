# Conformance tests with ERICA

[ERICA](https://gitlab.opencode.de/bmi/eudi-wallet/erica) is the BMI's wallet simulator for relying
parties. This directory runs it against **this** app with a real EUDIPLO in between. That is the
first test in the repository where the cryptography is real; every other test uses a fake verifier.

**Test stack only.** The trust list here trusts ERICA's signer certificates, whose private keys are
public in the ERICA repository. Anyone can sign a PID with them. Never put them into a real
EUDIPLO; that is also why ERICA is not deployed anywhere.

## Running

```bash
npm run test:erica        # local stack, all scenarios; exit code = failed hard checks
npm run test:erica:down   # remove the containers

# Request check against a live instance (validation only, nothing is presented):
EUDIPLO_LIVE_URL=https://verifier.example \
EUDIPLO_LIVE_CLIENT_ID=… EUDIPLO_LIVE_CLIENT_SECRET=… \
npm run test:erica:live   # optional: EUDIPLO_LIVE_REQUEST_ID=<verifier config id>
```

The first run builds ERICA from source (a few minutes). The report is written to `report/junit.xml`,
and ERICA's full sessions to `report/sessions.json`.

## What runs

| Service | What it is |
|---|---|
| `erica` | ERICA, built from the commit pinned in `docker-compose.yml` (there are no tags or images) |
| `eudiplo` | EUDIPLO 9.1.0, the same version as production, set up by config import from `eudiplo/` |
| `app` | this app with `pid_mdoc,pid_sdjwt`; the wallet picks the format |
| `app-bound` | this app with `pid_sdjwt` and `EUDI_CHANNEL_BINDING=on` |
| `runner` | `scripts/test-erica.mjs`, plain Node 22 without dependencies |

The EUDIPLO import (`eudiplo/whosit/`) holds no private key: the access certificate and the
trust-list signing key are generated at every start (`keySource: regenerate`).

Each scenario opens a room of two: the host verifies with a normal PID, then the guest presents
what the scenario says. Hard checks are about the app: is the guest verified exactly when the
presentation is good, is the name right, does nothing unrequested reach the other side.

## Where the script does a wallet's work itself

- **It fetches the `request_uri` and gives ERICA the request by value.** ERICA only fetches HTTPS
  from public IPs (SSRF guard, not configurable). Inside Docker, both conditions fail. ERICA's
  JAR checks still run on the request passed by value.
- **It encrypts and POSTs the response itself.** ERICA puts `iss`, `aud` and `nonce` into the
  `direct_post.jwt` payload, a leftover from JARM. OpenID4VP 1.0 has only `vp_token` and `state`
  there, and EUDIPLO 9.1 answers unknown keys with HTTP 400. So no ERICA response would ever arrive.
  ERICA's error modes all live inside the `vp_token`, so nothing is lost.

## Known gaps of ERICA (commit `a34ffd1`)

These are reported as skipped, not failed:

- `INVALID_SIGNATURE` crashes inside ERICA ("Invalid JWK EC key") and produces no credential.
- `EXPIRED` is ignored for mdoc: the document is valid for another year. The scenario checks this
  and switches itself on once ERICA delivers an expired mdoc.
- ERICA ignores `transaction_data`. The binding scenario therefore asserts that such a wallet is
  **refused**, which is what a dropped binding must lead to.
- `MODIFIED_CLAIMS`, `FORMAT_MISMATCH`, `MALFORMED_SD_JWT`, `WRONG_ISSUER` and
  `WRONG_CREDENTIAL_TYPE` are announced but not implemented.

- `profile.verifier_info.presence` fails on every request: the PID profile reads
  `request.verifierInfo` after ERICA itself renamed it to `verifier_info`. Skipped; live mode
  checks `verifier_info` itself.

`profile.iss.presence` is shown, not enforced: ERICA demands `iss` in the request object,
OpenID4VP 1.0 does not (RFC 9101 recommends it). EUDIPLO 9.1 builds the request object without it,
and the app has no say in that.

Local-only findings are skipped too: `response_uri` over plain HTTP, and the self-signed access
certificate that no registrar has signed. In live mode they count. Locally ERICA never gets as
far as its PID profile checks (55 in live mode, 29 locally): a local-only error ends the
validation first.

## Findings so far

- ERICA warns that the request object is valid for 60 minutes (`syntax.jwt.exp.duration`, it
  recommends 5–10). This comes from the EUDIPLO configuration, not from the app.
- EUDIPLO drops webhooks to HTTP and private addresses **without a log line** unless
  `OUTBOUND_URL_ALLOW_HTTP` and `OUTBOUND_URL_ALLOW_PRIVATE_NETWORK` are set. Worth remembering if
  a self-hosted instance never hears back.
- EUDIPLO pins the **signer** certificate from a trust list ("Pinned mode: leaf"), not the CA. The
  trust list therefore holds ERICA's two signer certificates, not its root.
- On a failed presentation, EUDIPLO 9.1 puts the reason in `outcome.result` and `outcome.message`.
- A join and a `set-config` right after it ask for two offers at once. Since offers that are
  replaced get deleted at the verifier, the one the client saw first could be gone by the time a
  wallet answered; before that, the older offer could win. Only the latest offer asked for is kept
  now (`offerSeq`, 2026-11-05).

## Bumping ERICA

1. Change the commit in `docker-compose.yml` (`context: …erica.git#<sha>`) and the image tag next
   to it. CI reads the commit from that line.
2. If the signer certificates changed (`src/security/issuer/*-signer-certificate.pem` in ERICA),
   update `eudiplo/whosit/trust-lists/erica.json`.
3. Run `npm run test:erica`. Recheck each item under "Known gaps" above; an item that ERICA has
   fixed should become a hard check.
