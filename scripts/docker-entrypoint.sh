#!/bin/sh
# SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The server does not run as root (2026-11-05). Should anyone ever get code to run in it, they get
# the rights of the unprivileged user `node`, not root's.
#
# It starts as root only for one thing: data volumes created by earlier versions belong to root,
# and the server writes there (usage, verifier status, module data). So the data directory is
# handed to `node` first — every start, so a volume restored from a backup is fixed too — and then
# the process gives up root for good (setpriv, part of the base image). A read-only mount inside
# it (operator pages) cannot be chowned and is left as it is.
set -e
if [ "$(id -u)" = "0" ]; then
  for d in "${EUDI_DATA_DIR:-}" /data /app/data; do
    [ -n "$d" ] && [ -d "$d" ] && chown -R node:node "$d" 2>/dev/null || true
  done
  [ -d /data ] || [ -n "${EUDI_DATA_DIR:-}" ] || { mkdir -p /app/data && chown node:node /app/data; }
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
