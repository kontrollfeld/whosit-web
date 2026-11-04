<!--
SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public GitHub issue.

- **GitHub private vulnerability reporting** (preferred): the *Security* tab of this repository
  → *Report a vulnerability*. It keeps the report, the fix and the advisory together — and the fix
  is developed in a private fork, so it only becomes visible with the advisory.
- Email: **<info@kontrollfeld.de>**
- Response within **72 hours**, then coordinated disclosure.

> Where this repository sits: development happens in a private GitLab project; this GitHub
> repository is a read-only mirror and the public point of contact. Reports arriving here are read.
> Fixes land in GitLab and reach this mirror on the next sync.

Include: affected version (see the footer badge / `public/version.json`), a description, and
reproduction steps or a proof of concept.

## Scope

In scope: the app server (`src/`), the signaling protocol, the EUDIPLO webhook handling, the
self-hosting stack (`docker-compose.yml`, coturn). Out of scope: third-party services (your
EUDIPLO instance, TURN infrastructure you operate) and the dev-only `deploy/mock-eudiplo`
(explicitly not for production).

## Hardening

Security properties are documented where they are implemented — the source comments state what
is guaranteed and what is deliberately not. Worth reading before deploying:

- `src/wrp-policy.ts` — the attribute whitelist and purpose binding, fixed in source and not
  extendable by environment variable
- `src/core/startup-checks.ts` — what production refuses to start without
- `src/audit.ts` — what is recorded and what is deliberately never recorded
- `src/server.ts`, webhook section — callback authentication and replay protection
- `src/channel-binding.ts` — binding the verified identity to the connection's DTLS key

## Before self-hosting

- Set strong secrets (`TURN_SECRET`, EUDIPLO credentials); never use the example values. This is
  now **enforced** in production: with `NODE_ENV=production` the server refuses to start when a
  required value is missing or still holds a placeholder — before the port opens. See
  `src/core/startup-checks.ts`. In development the same findings are warnings only.
- Serve only over HTTPS/WSS (the provided Traefik config enforces this).
- Restrict `ALLOWED_ORIGINS` to your domain if you don't want same-host-only WS behaviour.
