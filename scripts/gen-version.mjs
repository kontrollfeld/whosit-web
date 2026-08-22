// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Stamp the current version into public/version.json so the frontend can display
 * it (footer badge). Run before committing a release: `npm run version:stamp`.
 *
 * Source of truth:
 *   - version  → package.json "version" (bump this by hand per release, SemVer)
 *   - commit   → short git SHA (best-effort; falls back to $SOURCE_COMMIT or "dev")
 *   - date     → build date (UTC, YYYY-MM-DD)
 *
 * version.json is COMMITTED (not generated in the Docker build): `.git` is
 * dockerignored, so the container can't read git — the committed file is what ships.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function git(cmd, fallback) {
  try {
    return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return fallback;
  }
}

const commit =
  (process.env.SOURCE_COMMIT || '').slice(0, 7) ||
  git('git rev-parse --short HEAD', 'dev');
const date = new Date().toISOString().slice(0, 10);

const out = { version: pkg.version, commit, date };
writeFileSync(join(root, 'public', 'version.json'), JSON.stringify(out, null, 2) + '\n');
console.log('version.json →', JSON.stringify(out));
