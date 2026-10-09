// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Instance branding — name, accent colour, logo.
 *
 * One instance carries exactly one brand (see src/wrp-policy.ts), so environment variables
 * suffice: there is no tenant resolution and there are no tenant files. Deliberately: a
 * deployment per authority is the architecture, not multi-tenancy.
 *
 * Without `EUDI_BRAND_NAME`/`EUDI_BRAND_ACCENT` everything here is a no-op: `snippets()`
 * returns empty strings and the response stays byte-for-byte what it was. That is the
 * condition for an unbranded instance to be entirely unaffected by this module.
 */

export interface Branding {
  name?: string;
  accent?: string;      // light mode
  accentDark?: string;  // dark mode; when absent, the light one is lightened
  logo?: string;        // URL path, e.g. /brand/logo.svg
}

const HEX = /^#([0-9a-f]{6})$/i;

function rgb(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
const toHex = (c: [number, number, number]) => '#' + c.map((x) => clamp(x).toString(16).padStart(2, '0')).join('');
/** Amount `t`: 1 = all the way to the target colour. */
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function readBranding(env: NodeJS.ProcessEnv = process.env): Branding | null {
  const name = (env.EUDI_BRAND_NAME || '').trim();
  const accent = (env.EUDI_BRAND_ACCENT || '').trim();
  const accentDark = (env.EUDI_BRAND_ACCENT_DARK || '').trim();
  const logo = (env.EUDI_BRAND_LOGO || '').trim();
  if (!name && !accent && !logo) return null;
  // An unusable colour is discarded rather than approximated — otherwise a CSS value no
  // browser understands would end up in the page, leaving the interface half-branded with no
  // explanation.
  const ok = (c: string) => (rgb(c) ? c : undefined);
  return { name: name || undefined, accent: ok(accent), accentDark: ok(accentDark), logo: logo || undefined };
}

/**
 * Derive the accent tokens for one mode.
 *
 * The shipped palette derives them differently per mode: in light, `--accent-strong` is DARKER
 * than the accent and `--accent-soft` is almost white; in dark, `strong` is LIGHTER and `soft`
 * is almost the background. Treating both the same way produces unreadable surfaces in dark
 * mode.
 */
function accentTokens(hex: string, mode: 'light' | 'dark'): string {
  const c = rgb(hex);
  if (!c) return '';
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  const darkBg: [number, number, number] = [11, 18, 32]; // --bg in dark mode
  const strong = mode === 'light' ? mix(c, black, 0.18) : mix(c, white, 0.28);
  const soft = mode === 'light' ? mix(c, white, 0.92) : mix(c, darkBg, 0.86);
  const a = mode === 'light' ? 0.4 : 0.45;
  const ring = mode === 'light' ? 0.16 : 0.2;
  // Foreground on the accent: from perceived luminance, not guessed.
  const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const onAccent = lum > 0.6 ? '#06111d' : '#ffffff';
  return [
    `--accent: ${hex};`,
    `--accent-strong: ${toHex(strong)};`,
    `--accent-soft: ${toHex(soft)};`,
    `--on-accent: ${onAccent};`,
    `--accent-border: rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a});`,
    `--accent-ring: rgba(${c[0]}, ${c[1]}, ${c[2]}, ${ring});`,
  ].join(' ');
}

const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]!));

/**
 * What gets injected into `<head>`.
 *
 * ORDER MATTERS: the `<style>` block MUST come after `style.css`/`pages.css`, i.e. directly
 * before `</head>`. Placed earlier, the stylesheet wins the cascade and the branding has no
 * effect.
 */
export function snippets(b: Branding | null): { head: string; tail: string } {
  if (!b) return { head: '', tail: '' };
  const head =
    `<script>window.EUDI_BRANDING=${JSON.stringify({ name: b.name, logo: b.logo })};</script>` +
    `<script src="/branding.js" defer></script>`;
  if (!b.accent) return { head, tail: '' };
  const dark = b.accentDark || toHex(mix(rgb(b.accent)!, [255, 255, 255], 0.35));
  const tail =
    `<style id="brand-accent">` +
    `:root{${accentTokens(b.accent, 'light')}}` +
    `:root[data-theme="dark"]{${accentTokens(dark, 'dark')}}` +
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${accentTokens(dark, 'dark')}}}` +
    `</style>`;
  return { head, tail };
}

/**
 * Apply branding to an HTML document. Returned unchanged when there is no branding.
 *
 * The title is REPLACED, not appended. A second `<title>` before `</head>` would have no
 * effect: the browser takes the first one, and the tab would keep showing the wrong brand.
 */
export function brandHtml(html: string, b: Branding | null): string {
  const { head, tail } = snippets(b);
  if (!head && !tail && !b?.name) return html;
  let out = html;
  if (head) out = out.replace(/<head(\s[^>]*)?>/i, (m) => m + head);
  if (tail) out = out.replace(/<\/head>/i, tail + '</head>');
  if (b?.name) {
    // Only the FIRST occurrence, and only if there is one — otherwise the page would end up
    // with no title at all.
    out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(b.name)}</title>`);
  }
  return out;
}
