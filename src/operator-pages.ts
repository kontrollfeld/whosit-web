// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pages that belong to the OPERATOR of an instance, not to the software.
 *
 * An imprint names whoever runs the service. Until now this repository shipped ours, which meant
 * every self-hosted instance published Kontrollfeld GmbH as its provider — wrong for the operator
 * (section 5 DDG requires the actual one) and wrong for us (named as responsible for instances we
 * neither run nor know of). A privacy notice has the same property, and a press area is operator
 * content by definition.
 *
 * So: the repository ships neutral placeholders that say no imprint has been provided, and an
 * operator puts their real pages in a directory of their own:
 *
 *   EUDI_OPERATOR_PAGES=/data/pages     impressum.html · datenschutz.html · presse.html
 *
 * Files found there are served at the matching path and take precedence over the placeholders.
 * Anything else in that directory is served read-only under /operator/ — a press page needs its
 * logo package and screenshots, and those are operator content too.
 *
 * Deliberately NOT a template engine and not multi-tenant: one instance, one operator (same
 * reasoning as ./branding). Whoever runs the service writes plain HTML and drops it in.
 */
import fs from 'fs';
import path from 'path';

/** Pages an operator may provide. The name is both the file name and the URL path. */
export const OPERATOR_PAGES = ['impressum', 'datenschutz', 'presse'] as const;
export type OperatorPage = (typeof OPERATOR_PAGES)[number];

export interface OperatorPagesConfig {
  /** Absolute path of the directory. */
  dir: string;
  /** Which of the known pages actually exist right now. */
  available: OperatorPage[];
}

/**
 * Read the configuration. Returns null when the feature is off — the caller then registers no
 * routes at all and the response stays exactly what it was.
 *
 * A configured but unusable directory is NOT silently ignored: it returns an empty `available`
 * list, and the caller logs it. A typo in a path must be visible at startup, not when a visitor
 * hits a 404 on the imprint.
 */
export function readOperatorPages(env: NodeJS.ProcessEnv = process.env): OperatorPagesConfig | null {
  const raw = (env.EUDI_OPERATOR_PAGES || '').trim();
  if (!raw) return null;
  const dir = path.resolve(raw);
  let available: OperatorPage[] = [];
  try {
    available = OPERATOR_PAGES.filter((p) => {
      const full = path.join(dir, `${p}.html`);
      try { return fs.statSync(full).isFile(); } catch { return false; }
    });
  } catch { /* unreadable directory → empty list, reported by the caller */ }
  return { dir, available };
}

/**
 * Resolve a request path to an operator page file, or null.
 *
 * Accepts `/impressum` and `/impressum.html` alike: the pages in this repository link with the
 * extension, and an operator writing their own links should not have to know which form is right.
 */
export function resolveOperatorPage(cfg: OperatorPagesConfig, urlPath: string): string | null {
  const name = urlPath.replace(/^\/+/, '').replace(/\.html$/, '');
  if (!(OPERATOR_PAGES as readonly string[]).includes(name)) return null;
  if (!cfg.available.includes(name as OperatorPage)) return null;
  return path.join(cfg.dir, `${name}.html`);
}
