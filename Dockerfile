# SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
# SPDX-License-Identifier: AGPL-3.0-or-later
# EUDI Verified Call — ein Dockerfile, zwei Ergebnisse.
#
#   docker build .                            → AGPL-Image, frei weitergebbar
#   docker build --build-arg WITH_PRO=1 .     -> the Pro image, DO NOT redistribute
#
# Why the distinction: `pro/` is under a commercial licence that forbids distribution (see
# pro/LICENSE). An image containing `pro/` therefore must not be published. The default build
# leaves the directory out — the result contains AGPL code only and may go into any registry.
#
# This replaces the previous two-repository chain: the Pro image was built from a separate
# repository that pulled the Community core in via `git clone` with a read token, and had to force
# a no-cache rebuild because the clone layer otherwise reused stale code. All of that is gone.

# ---- build stage: Abhängigkeiten installieren, TypeScript übersetzen ----
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
# Catalogue for in-call credentials: the default path is <app root>/credential-catalog.json
COPY credential-catalog.json ./

# Version stamp. `public/version.json` is committed and carries the version from package.json —
# but the commit SHA in it is only as fresh as the last manual stamp. Deployment platforms hand the
# revision they are building to the build (Coolify sets SOURCE_COMMIT), so when it is present,
# re-stamp: then the footer of the running instance proves which revision is actually live.
#
# Without the argument the committed file is left untouched, which is what a plain `docker build .`
# should do — a reproducible build must not invent a SHA it cannot know.
ARG SOURCE_COMMIT=""
COPY scripts/gen-version.mjs ./scripts/gen-version.mjs
RUN if [ -n "$SOURCE_COMMIT" ]; then node scripts/gen-version.mjs; fi
EXPOSE 3000

# The image says for itself whether it is healthy. Node asks its own endpoint — deliberately
# without curl or wget: adding a HTTP client to a production image just so the image can poll
# itself widens the attack surface for nothing, and it is exactly the kind of tool an attacker
# looks for after a break-in.
#
# This matters beyond convenience: deployment platforms run their check INSIDE the container
# (Coolify does), and their default command assumes curl. Without this instruction the container
# is reported unhealthy while the application answers perfectly well, and a rolling update rolls
# back a deployment that was fine.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Modules are NOT loaded automatically — EUDI_MODULES=./pro (or the older EUDI_PRO_MODULE) has to
# be set. If a listed module is missing, does not fit or conflicts, startup aborts in production
# rather than quietly carrying on without it (see src/module-loader.ts).
CMD ["node", "dist/server.js"]
