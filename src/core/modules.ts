// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Module manifests — what a module declares about itself BEFORE any of its code runs.
 *
 * A module is an npm package (or a directory with a package.json) that the server loads through
 * `EUDI_MODULES` (see ../module-loader). Its package.json carries a `whosit` block:
 *
 *   "whosit": {
 *     "id": "audit-trail",
 *     "coreApi": "^1",
 *     "features": [
 *       { "id": "audit-trail", "title": "Verification audit trail with retention and export" }
 *     ],
 *     "clientAliases": ["pro-client"],
 *     "privacy": { "title": "Prüfprotokoll", "text": "Was das Modul speichert, wie lange …" }
 *   }
 *
 * Why a static manifest and not just `register()`: the questions "which modules are installed,
 * which features do they bring, do they fit this core" have to be answerable without executing
 * the module — at startup before anything is wired, and by `npm run modules -- check` in CI.
 * The same split as Drupal's `.info.yml` next to the module code.
 *
 * Features are declared HERE, by the module, and no longer in ./features: the open core must not
 * carry the names of closed modules. A module can only ADD capabilities. It cannot redeclare a
 * core capability, so it cannot switch one off or soften one — the attribute whitelist, purpose
 * binding, pseudonym and the PII-free record stay out of its reach (see UNSWITCHABLE).
 */

/**
 * The version of the interface between the core and its modules — `Extensions` and the ports in
 * ./ports, plus this manifest format. A module declares which versions it was built for
 * (`coreApi: "^1"`); the loader refuses a module that does not fit, rather than letting it fail
 * at the first call into a port that changed shape.
 *
 * Raise the MAJOR on any change that would break an existing module: a removed or renamed port
 * method, a changed argument shape, a manifest field that changed meaning. Adding an optional
 * field is not such a change. Until the API has stood still for a few months it is internal and
 * may move — but every move is a new major, so the mismatch is caught at startup.
 */
export const MODULE_API_VERSION = 1;

/** A capability a module brings, as listed in its manifest. */
export interface ModuleFeature {
  id: string;
  title: string;
  /** Whether the browser UI toggles on this capability (see `clientGated` in ./features). */
  clientGated: boolean;
}

export interface ModuleManifest {
  id: string;
  /** The package version, for `GET /capabilities` and `npm run modules`. */
  version: string;
  coreApi: string;
  features: ModuleFeature[];
  /** Extra URL prefixes for the module's browser files, besides `/modules/<id>/`. Exists for
   *  paths that clients already have baked in (`/pro-client/` in shipped app builds). */
  clientAliases: string[];
  /** What the module does with personal data, in its own words (German, plain text, paragraphs
   *  separated by a blank line). Rendered into the instance's generated privacy notice
   *  (../privacy-notice). Optional — a module that leaves it out is named there as one that
   *  declared nothing. An optional field: no change of MODULE_API_VERSION. */
  privacy?: { title: string; text: string };
}

/** Ids of modules, features and aliases: lowercase, digits and hyphens, starting with a letter. */
const ID = /^[a-z][a-z0-9-]{1,47}$/;

/** Prefixes a module alias must not shadow — routes and static directories of the core
 *  (src/server.ts, public/). Extend when the core gains a top-level path. */
const RESERVED_PREFIXES = new Set([
  'modules', 'qes', 'vendor', 'fonts', 'operator', 'webhook', 'capabilities', 'health', 'ice',
  'invite', 'wallet-pass', 'signature-providers', 'credential-catalog', 'wrp-policy', 'wrp-policies',
  'impressum', 'datenschutz', 'presse',
]);

/**
 * Does this core satisfy a module's `coreApi` range?
 *
 * Deliberately a small subset of semver ranges, because only the major matters here: `1`,
 * `1.x`, `^1`, `^1.2.0`, `~1.0`, alternatives joined with `||`. Anything else is refused as
 * unreadable instead of being guessed at — a guessed compatibility is how a module ends up
 * running against an interface it was never built for.
 */
export function coreApiSatisfied(range: string, version: number = MODULE_API_VERSION): boolean {
  const alternatives = range.split('||').map((s) => s.trim());
  if (alternatives.some((a) => !/^[~^]?\d+(\.(\d+|x))?(\.(\d+|x))?$/.test(a))) {
    throw new Error(`coreApi "${range}" is not a supported range — use e.g. "^${version}"`);
  }
  return alternatives.some((a) => Number(a.replace(/^[~^]/, '').split('.')[0]) === version);
}

/**
 * Read and validate the `whosit` block of a module's package.json. Throws with a message that
 * names the module and the field, because this ends up in a startup log that someone reads
 * under time pressure.
 *
 * `coreIds` are the core's own capability ids: a module may not redeclare one of them.
 */
export function parseManifest(pkg: any, where: string, coreIds: readonly string[]): ModuleManifest {
  const m = pkg?.whosit;
  const fail = (msg: string): never => { throw new Error(`${where}: ${msg}`); };
  if (!m || typeof m !== 'object') fail('package.json has no "whosit" manifest — is this a whosit module?');
  if (typeof m.id !== 'string' || !ID.test(m.id)) fail(`"whosit.id" must match ${ID} (got ${JSON.stringify(m.id)})`);
  if (typeof m.coreApi !== 'string') fail('"whosit.coreApi" is missing — which core API was this module built for?');
  let fits: boolean;
  try { fits = coreApiSatisfied(m.coreApi); } catch (e: any) { return fail(e.message); }
  if (!fits) {
    fail(`built for core API "${m.coreApi}", this core provides ${MODULE_API_VERSION}. `
      + 'Update the module or the core so that they match.');
  }

  const features: ModuleFeature[] = [];
  for (const f of m.features ?? []) {
    if (typeof f?.id !== 'string' || !ID.test(f.id)) fail(`feature id ${JSON.stringify(f?.id)} must match ${ID}`);
    if (typeof f.title !== 'string' || !f.title.trim()) fail(`feature "${f.id}" has no title`);
    // The rule that keeps modules from weakening the core: they cannot touch its capabilities.
    if (coreIds.includes(f.id)) fail(`feature "${f.id}" belongs to the core — a module can only add capabilities`);
    if (features.some((x) => x.id === f.id)) fail(`feature "${f.id}" is declared twice`);
    features.push({ id: f.id, title: f.title.trim(), clientGated: f.clientGated === true });
  }

  const clientAliases: string[] = [];
  for (const a of m.clientAliases ?? []) {
    if (typeof a !== 'string' || !ID.test(a)) fail(`client alias ${JSON.stringify(a)} must match ${ID}`);
    if (RESERVED_PREFIXES.has(a)) fail(`client alias "${a}" would shadow a route of the core`);
    clientAliases.push(a);
  }

  let privacy: ModuleManifest['privacy'];
  if (m.privacy !== undefined) {
    const t = m.privacy?.title, x = m.privacy?.text;
    if (typeof t !== 'string' || !t.trim() || t.length > 120) fail('"whosit.privacy.title" must be a text of at most 120 characters');
    if (typeof x !== 'string' || !x.trim() || x.length > 4000) fail('"whosit.privacy.text" must be a text of at most 4000 characters');
    privacy = { title: t.trim(), text: x.trim() };
  }

  return {
    id: m.id,
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    coreApi: m.coreApi,
    features,
    clientAliases,
    ...(privacy ? { privacy } : {}),
  };
}

/**
 * Check a SET of manifests against each other: two modules with the same id, the same feature or
 * the same alias cannot both be loaded, because the second would silently win. Returns problems
 * rather than throwing, so the caller can report all of them at once.
 */
export function crossCheckManifests(manifests: ModuleManifest[]): string[] {
  const problems: string[] = [];
  const owner = new Map<string, string>();
  const claim = (kind: string, key: string, id: string) => {
    const k = `${kind}:${key}`;
    const prev = owner.get(k);
    if (prev) problems.push(`${kind} "${key}" is claimed by both "${prev}" and "${id}"`);
    else owner.set(k, id);
  };
  for (const m of manifests) {
    claim('module id', m.id, m.id);
    for (const f of m.features) claim('feature', f.id, m.id);
    for (const a of m.clientAliases) claim('client alias', a, m.id);
  }
  return problems;
}

/** A module after loading: its manifest, where it came from, and where its browser files are. */
export interface LoadedModule extends ModuleManifest {
  /** As written in EUDI_MODULES — a path or a package name. */
  spec: string;
  /** Directory of browser files the module ships, served under `/modules/<id>/`. */
  clientAssetsDir?: string;
  /** HTTP routes the module adds (ports `ModuleRoutes`), mounted next to its browser files. */
  routes?: import('./ports').ModuleRoutes;
  /** Actions in a call (ports `ModuleAction`). */
  actions?: import('./ports').ModuleAction[];
}
