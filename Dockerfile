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
EXPOSE 3000
# The verification trail is NOT loaded automatically — EUDI_PRO_MODULE=./pro has to be set. If
# the module is missing despite the variable being set, startup aborts in production rather than
# quietly carrying on without retention (see src/pro-loader.ts).
CMD ["node", "dist/server.js"]
