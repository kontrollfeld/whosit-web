// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pages that belong to the OPERATOR of an instance, not to the software.
 *
 * An imprint names whoever runs the service, so it cannot ship with the software: section 5 DDG
 * requires the actual provider, and the software's authors must not be named as responsible for
 * instances they neither run nor know of. A privacy notice has the same property, and a press area is operator
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
  /** Which pages existed AT STARTUP. For the log line only — resolution happens per
   *  request, so a page added later is served without a restart. */
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
    // An imprint given as details counts as provided — see readImprint below.
    if (!available.includes('impressum')) {
      const i = readImprint({ dir, available: [] });
      if (i && 'imprint' in i) available = OPERATOR_PAGES.filter((p) => p === 'impressum' || available.includes(p));
    }
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
  // Checked per request, NOT against the list from startup. An operator who drops an imprint into
  // the directory must not have to restart the service for it — and if they did, they would first
  // see a 404 and go looking for the mistake somewhere else entirely. A stat() per request is nothing next to reading the file.
  const full = path.join(cfg.dir, `${name}.html`);
  try { if (!fs.statSync(full).isFile()) return null; } catch { return null; }
  return full;
}

/**
 * Media an operator may provide, same idea as the pages: it belongs to whoever runs the
 * instance. The app demo film shows one particular product, so it must not ship with the software — a
 * self-hoster would otherwise advertise a product that is not theirs.
 *
 * Files live in `<dir>/media/` and are already reachable through the /operator/ mount; this list
 * exists so the client can ask whether they are there instead of probing with a request that
 * would 404 on most instances.
 */
export const OPERATOR_MEDIA = ['appdemo'] as const;
export type OperatorMedia = (typeof OPERATOR_MEDIA)[number];

/** Which media files exist right now. Checked per request, like the pages. */
export function availableMedia(cfg: OperatorPagesConfig): OperatorMedia[] {
  return OPERATOR_MEDIA.filter((m) => {
    try { return fs.statSync(path.join(cfg.dir, 'media', `${m}.mp4`)).isFile(); } catch { return false; }
  });
}

/**
 * The operator's start page, where there is one.
 *
 * Different in kind from the pages above, which override a shipped placeholder: this one
 * REPLACES the application at "/". An instance without it opens the call screen directly, and
 * that is the honest default — this software is a tool for making verified calls, not a website,
 * and a self-hoster should not find someone else's marketing on their own front page.
 *
 * The operator of whosit.eu keeps its start page here for the same reason the imprint lives
 * here: it describes one particular service, and it would be wrong on any other instance.
 *
 * Resolved per request like everything else in this module — see the note above
 * `resolveOperatorPage` for what happens when that is done once at startup instead.
 */
export function resolveOperatorHome(cfg: OperatorPagesConfig): string | null {
  const full = path.join(cfg.dir, 'start.html');
  try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
}

/**
 * The operator's own site next to the application: pages under short paths, a few files at the
 * root, redirects and a 404 page — all from the same directory.
 *
 * Why this exists: with only the three pages above plus files below /operator/, every further page
 * (an FAQ, an article, a product page) would end up at an address like /operator/faq.html, there
 * would be no way to answer /robots.txt or /sitemap.xml, and renaming a page would break every
 * link to it. A website must not need a release of the application to grow.
 *
 * The rule that keeps this safe: it is consulted LAST, after every route of the application (see
 * the fallback at the end of the routes in ./server). A file in the directory can therefore never
 * hide a function of the application — `health.html` does not shadow /health. Without
 * EUDI_OPERATOR_PAGES nothing here is registered and the response stays what it was.
 *
 *   /faq                 → <dir>/faq.html
 *   /artikel/eins        → <dir>/artikel/eins.html, else <dir>/artikel/eins/index.html
 *   /robots.txt          → <dir>/robots.txt  (root files: .txt, .xml, .ico only)
 *   redirects.json       → { "/alt": "/neu", "/operator/x.html": "/x" }, answered with 301
 *   404.html             → shown with status 404 for any path nothing else answered
 */

/** A path segment an operator page may use: lower-case letters, digits, hyphens. No dots, so no
 *  `..` and no file extensions — `/faq.html` is not an alias of `/faq`, one address per page. */
const PAGE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
/** Files allowed at the root: robots.txt, sitemap.xml, llms.txt, favicon.ico and the verification
 *  files of search engines. Deliberately NOT .html or .js — pages go through the short paths. */
const ROOT_FILE = /^[a-z0-9][a-z0-9._-]*\.(txt|xml|ico)$/i;
/** Names that already have a meaning: start.html is "/" and 404.html is the error page. Serving
 *  them under /start and /404 as well would publish the same page twice. */
const RESERVED = new Set(['start', '404']);
const MAX_DEPTH = 4;

function isFile(full: string): boolean {
  try { return fs.statSync(full).isFile(); } catch { return false; }
}

/** Resolve a request path to a page or root file of the operator's site, or null. */
export function resolveOperatorSitePath(cfg: OperatorPagesConfig, urlPath: string): string | null {
  let p: string;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  const segments = p.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (segments.length === 1 && segments[0] === '') return null;   // "/" belongs to the start page
  if (segments.length === 1 && ROOT_FILE.test(segments[0])) {
    const full = path.join(cfg.dir, segments[0]);
    return isFile(full) ? full : null;
  }
  if (segments.length > MAX_DEPTH || !segments.every((s) => PAGE_SEGMENT.test(s))) return null;
  if (segments.length === 1 && RESERVED.has(segments[0])) return null;
  const base = path.join(cfg.dir, ...segments);
  if (isFile(`${base}.html`)) return `${base}.html`;
  const index = path.join(base, 'index.html');
  return isFile(index) ? index : null;
}

/** The operator's 404 page, if there is one. */
export function resolveOperatorNotFound(cfg: OperatorPagesConfig): string | null {
  const full = path.join(cfg.dir, '404.html');
  return isFile(full) ? full : null;
}

/** redirects.json, re-read only when the file changes. A broken file is reported once and then
 *  treated as empty — a typo must not take the site down, and it must not go unnoticed either. */
let redirectCache: { mtimeMs: number; map: Map<string, string> } | null = null;

/** Where a path should be redirected to, or null. Targets must be a path on this site ("/…") or
 *  an https:// address; anything else in the file is ignored. */
export function resolveOperatorRedirect(cfg: OperatorPagesConfig, urlPath: string): string | null {
  const file = path.join(cfg.dir, 'redirects.json');
  let mtimeMs: number;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { redirectCache = null; return null; }
  if (!redirectCache || redirectCache.mtimeMs !== mtimeMs) {
    const map = new Map<string, string>();
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [from, to] of Object.entries(raw ?? {})) {
        if (typeof to !== 'string' || !from.startsWith('/')) continue;
        // `/\\host` counts as protocol-relative in browsers, like `//host`.
        if (!(to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\')) && !to.startsWith('https://')) continue;
        map.set(from, to);
      }
    } catch (e) {
      console.warn(`[operator-pages] redirects.json ignored: ${(e as Error).message}`);
    }
    redirectCache = { mtimeMs, map };
  }
  return redirectCache.map.get(urlPath) ?? null;
}

/**
 * A structured imprint: the operator's details as `impressum.json` instead of a whole HTML page.
 *
 * WHY. Section 5 DDG asks for a handful of facts — who, where, how to reach them, register, VAT ID,
 * supervisory authority — and writing a page for that is a hurdle with a cost: an instance without
 * an imprint is one a competitor can send a warning letter about. With the facts alone, the
 * placeholder page in public/ fills itself in, in the instance's own look. A hosting provider can
 * write this file from an order form without ever handing HTML to the instance.
 *
 *   impressum.html   wins, as before — an operator's own page is never second-guessed
 *   impressum.json   rendered into public/impressum.html between its `imprint:start/end` marks
 *   neither          the placeholder, saying no details were provided
 *
 * Every value is text, escaped here; nothing in the file can add markup. A file that is not valid
 * — missing name, address, place or email, or a field that is not a short line of text — is treated
 * as absent and logged at startup, so a broken file shows the placeholder rather than a half page.
 */
export interface Imprint {
  name: string;            // provider: person, company with legal form, authority
  strasse: string;         // street and number
  ort: string;             // postcode and place
  land?: string;
  vertreten?: string;      // who represents a legal person (managing director, head of the authority)
  email: string;
  telefon?: string;
  register?: string;       // court and number, e.g. "Amtsgericht Charlottenburg, HRB 123456 B"
  ustId?: string;          // VAT ID under section 27a UStG
  aufsicht?: string;       // supervisory authority, where the business needs a licence
  verantwortlich?: string; // responsible for editorial content, section 18(2) MStV
}

const PFLICHT = ['name', 'strasse', 'ort', 'email'] as const;
const FREI = ['land', 'vertreten', 'telefon', 'register', 'ustId', 'aufsicht', 'verantwortlich'] as const;
const ZEILE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i;

/** The file's content checked, or `{ fehler }` saying why it is not used. */
export function parseImprint(raw: unknown): { imprint: Imprint } | { fehler: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { fehler: 'kein JSON-Objekt' };
  const o = raw as Record<string, unknown>;
  const unbekannt = Object.keys(o).filter((k) => !(PFLICHT as readonly string[]).includes(k) && !(FREI as readonly string[]).includes(k));
  if (unbekannt.length) return { fehler: `unbekannte Felder: ${unbekannt.join(', ')}` };
  const out: Record<string, string> = {};
  for (const k of [...PFLICHT, ...FREI]) {
    const v = o[k];
    if (v === undefined || v === null || v === '') {
      if ((PFLICHT as readonly string[]).includes(k)) return { fehler: `${k} fehlt` };
      continue;
    }
    if (typeof v !== 'string' || !ZEILE.test(v.trim())) return { fehler: `${k} ist keine Textzeile (höchstens 200 Zeichen)` };
    out[k] = v.trim();
  }
  if (!EMAIL.test(out.email)) return { fehler: 'email ist keine E-Mail-Adresse' };
  return { imprint: out as unknown as Imprint };
}

/** The imprint from the operator's directory, read per request like everything here. */
export function readImprint(cfg: OperatorPagesConfig): { imprint: Imprint } | { fehler: string } | null {
  const full = path.join(cfg.dir, 'impressum.json');
  let text: string;
  try { text = fs.readFileSync(full, 'utf8'); } catch { return null; }
  try { return parseImprint(JSON.parse(text)); } catch { return { fehler: 'kein gültiges JSON' }; }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The placeholder page with the details in place of its "no details provided" block. */
export function renderImprint(placeholder: string, i: Imprint): string {
  const teile = [
    '<h2>Diensteanbieter</h2>',
    `<p><strong>${esc(i.name)}</strong><br />${esc(i.strasse)}<br />${esc(i.ort)}${i.land ? `<br />${esc(i.land)}` : ''}</p>`,
    i.vertreten ? `<p>Vertreten durch: ${esc(i.vertreten)}</p>` : '',
    '<h2>Kontakt</h2>',
    `<p>E-Mail: <a href="mailto:${esc(i.email)}">${esc(i.email)}</a>${i.telefon ? `<br />Telefon: ${esc(i.telefon)}` : ''}</p>`,
    i.register ? `<h2>Registereintrag</h2>\n<p>${esc(i.register)}</p>` : '',
    i.ustId ? `<h2>Umsatzsteuer-Identifikationsnummer</h2>\n<p>gem&auml;&szlig; &sect;&nbsp;27a Umsatzsteuergesetz: ${esc(i.ustId)}</p>` : '',
    i.aufsicht ? `<h2>Aufsichtsbeh&ouml;rde</h2>\n<p>${esc(i.aufsicht)}</p>` : '',
    i.verantwortlich ? `<h2>Verantwortlich f&uuml;r den Inhalt nach &sect;&nbsp;18 Abs.&nbsp;2 MStV</h2>\n<p>${esc(i.verantwortlich)}</p>` : '',
  ].filter(Boolean).join('\n      ');
  return placeholder
    .replace(/<!-- imprint:start[\s\S]*?<!-- imprint:end -->/, () => teile)
    .replace(/(<meta name="description" content=")[^"]*(")/, (_m, a, b) => `${a}Impressum: ${esc(i.name)}${b}`);
}
