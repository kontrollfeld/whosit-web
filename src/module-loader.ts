// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Load the modules this instance is configured with, and merge what they contribute.
 *
 *   EUDI_MODULES=./pro,@whosit/audit-trail
 *
 * Each entry is a directory or an installed package carrying a `whosit` manifest in its
 * package.json (see ./core/modules). The loader first reads ALL manifests — without running any
 * module code — and checks them: does each one fit this core (`coreApi`), does any claim a core
 * capability, do two claim the same id, feature or path. Only then are the modules imported and
 * their `register(defaults)` called. What comes back is layered over the Community defaults.
 *
 * A module is strictly ADDITIVE and the core never imports one: the core builds and runs
 * completely without any of them (`npm run check:licence-boundary`). Whether a module is open or
 * closed is a property of its repository and licence, not of this mechanism — the point of it is
 * that new functions can be built privately first and published later, one by one.
 *
 * `EUDI_PRO_MODULE` (the single module of the earlier design) still works and is treated as one
 * more entry of the list, so existing instances keep running unchanged.
 *
 * Failure policy: a module that is CONFIGURED but does not load, does not fit or conflicts is a
 * configuration error, not a reason to carry on without it. Whoever configures the audit-trail
 * module runs the instance with retention — continuing silently without it would drop that
 * obligation unnoticed, and the record would be missing exactly when it is needed. So: abort in
 * production, warn loudly and skip the module in development.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { communityRoomStore, noopVerificationSink } from './core/community';
import { ALL_FEATURE_IDS } from './core/features';
import { crossCheckManifests, parseManifest, type LoadedModule, type ModuleManifest } from './core/modules';
import type { Extensions, VerificationSink } from './core/ports';

/** The configured module list, in order, without duplicates. */
export function moduleSpecs(env: NodeJS.ProcessEnv = process.env): { specs: string[]; legacy: boolean } {
  const list = (env.EUDI_MODULES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const legacy = (env.EUDI_PRO_MODULE || '').trim();
  if (legacy) list.push(legacy);
  return { specs: [...new Set(list)], legacy: !!legacy };
}

/** Is this spec a filesystem path (as opposed to a package name)? */
function isPath(spec: string): boolean {
  return spec.startsWith('.') || path.isAbsolute(spec);
}

/** A path spec made absolute. Relative paths resolve against the WORKING DIRECTORY, not against
 *  this file — otherwise `./pro` would look inside `dist/pro` after compilation, which is not
 *  what anyone means when they write it into a .env. */
function absolute(spec: string): string {
  return path.resolve(process.cwd(), spec);
}

/**
 * What to import for a spec. A directory is resolved to the entry its package.json names
 * (`main`, default `index.js`) here rather than by Node: importing a directory works through
 * `require`, but not as an ES module, so it would depend on how the server happens to run
 * (compiled, or under tsx). Package names pass through to Node's resolution.
 */
export function importTarget(spec: string): string {
  if (!isPath(spec)) return spec;
  const abs = absolute(spec);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'));
    return path.join(abs, typeof pkg.main === 'string' ? pkg.main : 'index.js');
  }
  return abs;
}

/** The package.json that belongs to a spec: the directory's own, the nearest one above a file,
 *  or the installed package's. */
function findPackageJson(spec: string): string {
  if (isPath(spec)) {
    const target = absolute(spec);
    // Without this, a mistyped path would walk up to the core's own package.json and report a
    // missing manifest there — true, but pointing at the wrong place.
    if (!fs.existsSync(target)) throw new Error(`${target} does not exist`);
    if (fs.statSync(target).isDirectory()) {
      const own = path.join(target, 'package.json');
      if (!fs.existsSync(own)) throw new Error(`${target} has no package.json`);
      return own;
    }
    let dir = path.dirname(target);
    for (;;) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) return candidate;
      const up = path.dirname(dir);
      if (up === dir) throw new Error('no package.json found at or above this path');
      dir = up;
    }
  }
  // Resolve from the working directory, where the instance's node_modules live.
  const req = createRequire(path.join(process.cwd(), 'package.json'));
  try {
    return req.resolve(`${spec}/package.json`);
  } catch {
    // A package whose `exports` hide package.json: start from its entry point and walk up.
    let dir = path.dirname(req.resolve(spec));
    for (;;) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) return candidate;
      const up = path.dirname(dir);
      if (up === dir) throw new Error('package.json of the installed package not found');
      dir = up;
    }
  }
}

export interface ManifestRead {
  spec: string;
  manifest?: ModuleManifest;
  error?: string;
}

/**
 * Read and check every configured manifest WITHOUT running module code. Used at startup and by
 * `npm run modules`. A module whose manifest has a problem gets `error`; conflicts BETWEEN
 * modules are returned separately and mark the later module of each pair.
 */
export function readManifests(specs: string[]): { reads: ManifestRead[]; conflicts: string[] } {
  const reads: ManifestRead[] = specs.map((spec) => {
    try {
      const file = findPackageJson(spec);
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { spec, manifest: parseManifest(pkg, `module "${spec}"`, ALL_FEATURE_IDS) };
    } catch (e: any) {
      return { spec, error: e?.message || String(e) };
    }
  });
  // Check pairs in order, so that on a conflict the module listed FIRST is kept in development.
  const kept: ModuleManifest[] = [];
  const conflicts: string[] = [];
  for (const r of reads) {
    if (!r.manifest) continue;
    const problems = crossCheckManifests([...kept, r.manifest]);
    if (problems.length) {
      r.error = problems.join('; ');
      conflicts.push(...problems);
    } else {
      kept.push(r.manifest);
    }
  }
  return { reads, conflicts };
}

/** Production aborts, development carries on without the affected module. */
function configurationError(lines: string[]): void {
  const inProduction = (process.env.NODE_ENV || '').trim() === 'production';
  for (const l of lines) console.error(`[modules] ${l}`);
  if (inProduction) {
    console.error('[modules] Startup aborted: a configured module is missing, does not fit or conflicts.');
    console.error('[modules] Running without it could drop an obligation unnoticed (an audit trail, for');
    console.error('[modules] instance). Fix the module, or remove it from EUDI_MODULES / EUDI_PRO_MODULE');
    console.error('[modules] if this instance is meant to run without it. `npm run modules -- check` shows');
    console.error('[modules] the state without starting the server.');
    process.exit(1);
  }
  console.warn('[modules] Continuing without the affected module(s) — production would abort here.');
}

/** One sink per module that brings one; every record goes to all of them, and one failing sink
 *  does not keep the record from the others. Exported for the test. */
export function fanOut(sinks: Array<{ id: string; sink: VerificationSink }>): VerificationSink {
  if (sinks.length === 0) return noopVerificationSink;
  if (sinks.length === 1) return sinks[0].sink;
  return {
    async record(ev) {
      await Promise.all(sinks.map(async ({ id, sink }) => {
        try { await sink.record(ev); } catch (e: any) { console.warn(`[modules] ${id}: verification sink failed:`, e?.message || e); }
      }));
    },
  };
}

export async function loadExtensions(): Promise<Extensions> {
  const defaults: Extensions = {
    roomStore: communityRoomStore,
    verificationSink: noopVerificationSink,
    plugins: [],
    enabledFeatures: [],
    modules: [],
  };

  const { specs, legacy } = moduleSpecs();
  if (specs.length === 0) return defaults;
  if (legacy) console.log('[modules] EUDI_PRO_MODULE is read as one more entry of EUDI_MODULES — prefer the latter.');

  const { reads } = readManifests(specs);
  const failed = reads.filter((r) => r.error);
  if (failed.length) configurationError(failed.map((r) => `"${r.spec}" not loaded: ${r.error}`));

  const merged: Extensions = { ...defaults, plugins: [], enabledFeatures: [], signatureProviders: [], modules: [] };
  const sinks: Array<{ id: string; sink: VerificationSink }> = [];
  // Ports only one implementation can fill. Two modules filling the same one is a conflict that
  // the manifests cannot show, so it is caught here.
  const singleOwner = new Map<string, string>();
  const problems: string[] = [];

  for (const r of reads) {
    if (!r.manifest || r.error) continue;
    const m = r.manifest;
    let ext: Partial<Extensions> | undefined;
    try {
      const mod: any = await import(importTarget(r.spec));
      const reg = mod.register ?? mod.default?.register ?? mod.default ?? mod;
      ext = typeof reg === 'function' ? await reg(defaults) : reg;
    } catch (e: any) {
      problems.push(`"${r.spec}" (${m.id}) failed to load: ${e?.message || e}`);
      continue;
    }

    const clash = (['roomStore', 'qualifiedSigner', 'certificateIssuer'] as const)
      .filter((k) => ext?.[k] && singleOwner.has(k));
    if (clash.length) {
      problems.push(`"${m.id}" provides ${clash.join(', ')}, already provided by "${singleOwner.get(clash[0])}"`);
      continue;
    }
    if (ext?.roomStore) { merged.roomStore = ext.roomStore; singleOwner.set('roomStore', m.id); }
    if (ext?.qualifiedSigner) { merged.qualifiedSigner = ext.qualifiedSigner; singleOwner.set('qualifiedSigner', m.id); }
    if (ext?.certificateIssuer) { merged.certificateIssuer = ext.certificateIssuer; singleOwner.set('certificateIssuer', m.id); }
    if (ext?.verificationSink) sinks.push({ id: m.id, sink: ext.verificationSink });
    merged.plugins.push(...(ext?.plugins ?? []));
    merged.signatureProviders!.push(...(ext?.signatureProviders ?? []));
    // Capabilities come from the manifest. A module that also returns `enabledFeatures` (the
    // earlier, code-only way) may only name what its manifest declares — otherwise the manifest
    // would not be the whole truth, and `npm run modules` would report less than is running.
    const declared = m.features.map((f) => f.id);
    const undeclared = (ext?.enabledFeatures ?? []).filter((id) => !declared.includes(id));
    if (undeclared.length) console.warn(`[modules] "${m.id}" enables undeclared features, ignored: ${undeclared.join(', ')}`);
    merged.enabledFeatures.push(...declared);

    const loaded: LoadedModule = { ...m, spec: r.spec, clientAssetsDir: ext?.clientAssetsDir, routes: typeof ext?.routes === 'function' ? ext.routes : undefined,
      actions: Array.isArray(ext?.actions) ? ext.actions.filter((a) => a && typeof a.id === 'string' && typeof a.choices === 'function' && typeof a.path === 'function') : undefined };
    merged.modules!.push(loaded);
    console.log(`[modules] loaded ${m.id}@${m.version} from "${r.spec}" — features: [${declared.join(', ') || 'none'}]`
      + (loaded.clientAssetsDir ? `, browser files under /modules/${m.id}/${m.clientAliases.map((a) => ` and /${a}/`).join('')}` : '')
      + (loaded.routes ? ', with routes' : '')
      + (loaded.actions?.length ? `, actions [${loaded.actions.map((a) => a.id).join(', ')}]` : ''));
  }

  if (problems.length) configurationError(problems);
  merged.verificationSink = fanOut(sinks);
  return merged;
}
