# SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
# SPDX-License-Identifier: AGPL-3.0-or-later
# EUDI Verified Call — one Dockerfile, two results.
#
#   docker build .                            -> the AGPL image, freely redistributable
#   docker build --build-arg WITH_PRO=1 .     -> the Pro image, DO NOT redistribute
#
# Why the distinction: `pro/` is under a commercial licence that forbids distribution (see
# pro/LICENSE). An image containing `pro/` therefore must not be published. The default build
# leaves the directory out — the result contains AGPL code only and may go into any registry.

# ---- build stage: install dependencies, compile TypeScript ----
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# `pro/` is a standalone package with its own tsconfig — the main build above does not know about
# it, which guarantees the licence boundary structurally (verified by
# `npm run check:licence-boundary`).
ARG WITH_PRO=0
COPY pro ./pro
RUN if [ "$WITH_PRO" = "1" ]; then \
      cd pro && npm ci --no-audit && npm run build; \
    else \
      # Empty the directory but keep it: the COPY below needs it, and this way no commercially
      # licensed code ends up in the freely redistributable image.
      find pro -mindepth 1 -delete; \
    fi

# ---- runtime stage: production dependencies, compiled output and static files only ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/pro ./pro
COPY public ./public
COPY assets ./assets

# Version stamp. `public/version.json` is committed and carries the version from package.json —
# but the commit SHA in it is only as fresh as the last manual stamp. Deployment platforms hand the
# revision they are building to the build (commonly as SOURCE_COMMIT), so when it is present,
# re-stamp: then the footer of the running instance proves which revision is actually live.
#
# Without the argument the committed file is left untouched, which is what a plain `docker build .`
# should do — a reproducible build must not invent a SHA it cannot know.
ARG SOURCE_COMMIT=""
COPY scripts/gen-version.mjs ./scripts/gen-version.mjs
RUN if [ -n "$SOURCE_COMMIT" ]; then node scripts/gen-version.mjs; fi
EXPOSE 3000

# Run unprivileged. The only runtime write inside /app is the Pro audit trail and the QES demo CA,
# which default to ./data (EUDI_AUDIT_FILE / EUDI_QES_CA_FILE); create it owned by `node` so it also
# works without a volume. A volume mounted over /app/data (or any path configured via those
# variables) must be writable by uid 1000 — that is the operator's job.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

# The image says for itself whether it is healthy. Node asks its own endpoint — deliberately
# without curl or wget: adding a HTTP client to a production image just so the image can poll
# itself widens the attack surface for nothing, and it is exactly the kind of tool an attacker
# looks for after a break-in.
#
# This matters beyond convenience: deployment platforms run their check INSIDE the container
# (some do), and their default command assumes curl. Without this instruction the container
# is reported unhealthy while the application answers perfectly well, and a rolling update rolls
# back a deployment that was fine.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The verification trail is NOT loaded automatically — EUDI_PRO_MODULE=./pro has to be set. If
# the module is missing despite the variable being set, startup aborts in production rather than
# quietly carrying on without retention (see src/pro-loader.ts).
CMD ["node", "dist/server.js"]
