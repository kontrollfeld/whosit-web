// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Startup configuration check — the bolt against "runs somehow, but wrong".
 *
 * Two reasons this exists; the second matters more day to day:
 *
 * 1. SECURITY: `eudiplo.ts` used to fall back to an instance we operate, root secret included.
 *    An incompletely configured deployment would then quietly authenticate against someone
 *    else's verifier instead of surfacing the mistake.
 * 2. SELF-HOSTING: every deployment brings its OWN verifier — its own EUDIPLO instance, its own
 *    access certificate on its own domain. Configuration is therefore the single most common
 *    source of failure, and without this check it only shows up when a citizen opens their
 *    wallet and EUDIPLO returns a 401. At that point nobody knows WHICH value was missing.
 *    This file says so at startup instead.
 *
 * Two rules that must never be broken here:
 *
 * 1. **Never print values.** A message names the variable and the problem, never the content.
 *    Startup logs end up in log aggregators, issue reports and screenshots.
 * 2. **Only abort in production.** `NODE_ENV=production` → abort; otherwise warn. The
 *    development flow (`npm run dev` against the EUDIPLO dummy) stays usable unchanged.
 *
 * Deliberately NOT required:
 * - `PUBLIC_URL`. Leaving it unset is the *correct* state: the webhook origin is derived per
 *   request from `x-forwarded-host`/`-proto`, which works behind a reverse proxy and for several
 *   hostnames at once. Pinning it would break that. Only a *set* value is checked — for whether
 *   it still holds a placeholder.
 * - Config-gated secrets (`EUDI_INVITE_SECRET`, `EUDI_STAFF_SECRET`, `EUDI_PASS_*`). If they are
 *   missing, the server does not advertise the corresponding capability — the feature is then
 *   off, not insecure. See `enabledFeatures()` in ../server.
 */

/** A configuration problem found. `variable` is the name, never the value. */
export interface ConfigProblem {
  variable: string;
  problem: string;
  /** `true` = refuse to start (in production), `false` = warn only. */
  fatal: boolean;
}

/**
 * Values that unmistakably came from a template and never belong in production.
 * Deliberately specific: a pattern like `/secret/` would wrongly match genuine random values.
 * `kontrollfeld-secret` is listed because that exact string used to be a default in the source
 * — it is therefore publicly known, and must be rejected even when set on purpose.
 */
const PLACEHOLDERS = [
  '__set_me__',
  // The literal stand-in .env.example prints wherever it says `openssl rand -hex 32`. Anyone
  // who copied the file and did not run the command is holding a publicly known "secret".
  '__openssl_rand_hex_32__',
  'change-me',
  'changeme',
  'CHANGE-ME',
  'kontrollfeld-secret',
  'your-root-id',
  'your-tenant-id',
  'your-org',
  'example.org',
  'example.com',
  'call.example',
];

/** Does the value look copied from `.env.example`? Case-insensitive. */
function looksLikePlaceholder(value: string): boolean {
  const v = value.toLowerCase();
  return PLACEHOLDERS.some((p) => v.includes(p.toLowerCase()));
}

const isSet = (v: string | undefined): boolean => !!(v && v.trim());

export interface CheckContext {
  env?: Record<string, string | undefined>;
  /** Is the `embed` feature active here? (from enabledFeatures(), see ../server) */
  embedEnabled?: boolean;
}

/**
 * Collect every configuration problem without logging or exiting.
 *
 * Pure, and therefore directly testable (`scripts/test-startup-guard.mjs`) — all side effects
 * live in `assertProductionConfig()` alone.
 */
export function collectConfigProblems(ctx: CheckContext = {}): ConfigProblem[] {
  const env = ctx.env ?? process.env;
  const out: ConfigProblem[] = [];

  // --- verifier address -------------------------------------------------------------
  if (!isSet(env.EUDIPLO_BASE_URL)) {
    out.push({
      variable: 'EUDIPLO_BASE_URL',
      problem: 'missing — no wallet verification can happen without a verifier. This '
        + 'application ships NO verifier: you need your own EUDIPLO instance (pin 8.0.2, its '
        + 'own subdomain with TLS, an access certificate from a registration authority). '
        + 'See the README.',
      fatal: true,
    });
  } else if (looksLikePlaceholder(env.EUDIPLO_BASE_URL!)) {
    out.push({ variable: 'EUDIPLO_BASE_URL', problem: 'still holds the example value from .env.example', fatal: true });
  }

  // --- verifier tenant --------------------------------------------------------------
  // Without its own tenant the instance requests under SOMEONE ELSE'S registration: the
  // wallet shows the default tenant's certificate. In public-authority operation that is the
  // gravest silent mistake there is — see src/wrp-policy.ts.
  if (!isSet(env.EUDIPLO_CLIENT_ID)) {
    out.push({
      variable: 'EUDIPLO_CLIENT_ID',
      problem: 'missing — the instance would query wallets through the default tenant and so '
        + 'appear under a registration that is not its own. Set your own EUDIPLO tenant.',
      fatal: true,
    });
  } else if (looksLikePlaceholder(env.EUDIPLO_CLIENT_ID!)) {
    out.push({ variable: 'EUDIPLO_CLIENT_ID', problem: 'still holds the example value from .env.example', fatal: true });
  }

  // --- verifier access: fixed tenant client OR the legacy root path -----------------
  const hasClientSecret = isSet(env.EUDIPLO_CLIENT_SECRET);
  const hasRootPath = isSet(env.EUDIPLO_ROOT_ID) && isSet(env.EUDIPLO_ROOT_SECRET);
  if (!hasClientSecret && !hasRootPath) {
    out.push({
      variable: 'EUDIPLO_CLIENT_SECRET',
      problem: 'missing — no verifier access configured. A fixed tenant client is recommended '
        + '(EUDIPLO_CLIENT_SECRET); alternatively the legacy path via EUDIPLO_ROOT_ID + '
        + 'EUDIPLO_ROOT_SECRET.',
      fatal: true,
    });
  }
  for (const name of ['EUDIPLO_CLIENT_SECRET', 'EUDIPLO_ROOT_SECRET'] as const) {
    const v = env[name];
    if (isSet(v) && looksLikePlaceholder(v!)) {
      out.push({
        variable: name,
        problem: name === 'EUDIPLO_ROOT_SECRET' && v!.toLowerCase().includes('kontrollfeld-secret')
          ? 'holds the value that used to be a default in the source code. That value is '
            + 'publicly known and therefore compromised — rotate it at the verifier.'
          : 'still holds a placeholder from .env.example',
        fatal: true,
      });
    }
  }

  // --- trust lists in the pre-7.0 form ----------------------------------------------
  // EUDIPLO 7 accepts an `etsi_tl` reference only as an object. A URL string still registers,
  // so nothing complains until a citizen presents their PID and every verification comes back
  // as a bare HTTP 400. Refusing to start is the kinder failure. The message names the
  // replacement, never the value.
  if (isSet(env.EUDI_TRUST_LIST_URLS)) {
    out.push({
      variable: 'EUDI_TRUST_LIST_URLS',
      problem: 'no longer supported — EUDIPLO 7 and later reject trust lists given as URLs, and '
        + 'every verification would fail. Set EUDI_TRUST_LIST_IDS to the id of the list instead '
        + '(the last path segment of …/issuers/<tenant>/trust-list/<id>) and remove this variable.',
      fatal: true,
    });
  }

  // --- secrets copied verbatim from the template ------------------------------------
  // These are config-gated: unset simply means the feature is off, which is safe (see the
  // header). Set to the template's stand-in is the opposite of safe — the value is in a public
  // repository, so invitations could be forged, staff links minted and framing tokens issued by
  // anyone who read it. That is a live hole, not a missing feature, hence fatal.
  for (const name of ['EUDI_INVITE_SECRET', 'EUDI_STAFF_SECRET', 'EMBED_SIGNING_SECRET', 'TURN_SECRET'] as const) {
    const v = env[name];
    if (isSet(v) && looksLikePlaceholder(v!)) {
      out.push({
        variable: name,
        problem: 'still holds the stand-in from .env.example, which is published with this '
          + 'repository and therefore known to everyone. Generate one: openssl rand -hex 32',
        fatal: true,
      });
    }
  }

  // --- a branded instance carrying the original operator's identity -----------------
  // The failure this prevents was observed while setting up the first tenant instance: a
  // deployment duplicated from an existing one keeps every variable, and the ones that assert
  // WHO OWNS THIS DOMAIN keep asserting the wrong owner — quietly, because everything still
  // works.
  //
  //   EUDI_IOS_APP_ID / EUDI_ANDROID_* make this host serve a `.well-known` file naming a
  //   specific mobile app as the domain's owner, which hands that app the right to open this
  //   host's invitation links.
  //   EUDI_PASS_* sign an Apple Wallet pass with a particular organisation's pass certificate,
  //   which is then handed out under this instance's brand.
  //
  // A WARNING, not an abort: an operator may legitimately ship their own app and hold their own
  // pass certificate, and this check cannot tell that apart from an inherited value — only the
  // operator can. Naming the consequence is what they need; refusing to start would be a guess.
  const brand = (env.EUDI_BRAND_NAME || '').trim();
  if (brand) {
    const inherited = (['EUDI_IOS_APP_ID', 'EUDI_ANDROID_PACKAGE', 'EUDI_ANDROID_SHA256', 'EUDI_PASS_TYPE_ID', 'EUDI_PASS_TEAM_ID', 'EUDI_PASS_CERT'] as const)
      .filter((n) => isSet(env[n]));
    if (inherited.length) {
      out.push({
        variable: inherited.join(', '),
        problem: 'set on a BRANDED instance. These name a mobile app and a pass certificate as '
          + 'belonging to this host. If they were inherited from another deployment, this host '
          + 'now vouches for someone else\'s app and signs wallet passes with someone else\'s '
          + 'certificate under this brand. Keep them only if they are this brand\'s own.',
        fatal: false,
      });
    }
  }

  // --- framing / clickjacking -------------------------------------------------------
  // Only relevant when `embed` is active and the signed-token mode is not in use. A missing
  // value used to produce `frame-ancestors *`, i.e. framing from anywhere.
  if (ctx.embedEnabled && !isSet(env.EMBED_SIGNING_SECRET)) {
    const anc = (env.EMBED_ALLOWED_ANCESTORS || '').trim();
    if (!anc) {
      out.push({
        variable: 'EMBED_ALLOWED_ANCESTORS',
        problem: 'missing while the embed feature is active — framing therefore stays '
          + 'denied. List the permitted embedding origins, or set EMBED_SIGNING_SECRET for '
          + 'the hardened token mode.',
        fatal: false,
      });
    } else if (anc === '*') {
      out.push({
        variable: 'EMBED_ALLOWED_ANCESTORS',
        problem: 'is set to "*" — any third-party page could frame the app (clickjacking). '
          + 'List specific origins, or use EMBED_SIGNING_SECRET.',
        fatal: true,
      });
    }
  }

  // --- set but unfinished origin configuration --------------------------------------
  // PUBLIC_URL may be absent (the origin is derived per request). If it IS set, it must be
  // usable — a placeholder here breaks wallet redirects.
  const pub = env.PUBLIC_URL;
  if (isSet(pub) && (looksLikePlaceholder(pub!) || pub!.startsWith('http://localhost'))) {
    out.push({
      variable: 'PUBLIC_URL',
      problem: 'is set but points at a placeholder or localhost. Either set it to the public '
        + 'address or leave it out entirely — without it the origin is derived per request '
        + 'from x-forwarded-host, which is correct behind a proxy.',
      fatal: true,
    });
  }

  return out;
}

/**
 * Check the configuration and end the process when it is unusable in production.
 *
 * In production (`NODE_ENV=production`) every `fatal` problem leads to `process.exit(1)`.
 * Otherwise all problems are logged as warnings and startup continues.
 */
export function assertProductionConfig(ctx: CheckContext = {}): void {
  const env = ctx.env ?? process.env;
  const problems = collectConfigProblems(ctx);
  if (!problems.length) return;

  const isProd = (env.NODE_ENV || '').trim() === 'production';
  const fatal = problems.filter((p) => p.fatal);

  const label = isProd && fatal.length ? '❌ Incomplete configuration' : '⚠️  Configuration notes';
  console.error(`${label} (${problems.length}):`);
  for (const p of problems) {
    console.error(`   ${p.fatal ? '✖' : '•'} ${p.variable}: ${p.problem}`);
  }

  if (isProd && fatal.length) {
    console.error('');
    console.error(`Startup aborted: ${fatal.length} required value(s) missing or still on a`);
    console.error('placeholder. See .env.example and the README. (NODE_ENV=production enforces');
    console.error('this check; in development these are warnings only.)');
    process.exit(1);
  }
  if (!isProd) {
    console.error('   → In production (NODE_ENV=production) startup would abort here.');
  }
}
