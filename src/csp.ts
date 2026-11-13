// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content-Security-Policy for the app page (2026-11-05, hardening package C).
 *
 * The page shows people's verified names and identity data. If anything ever managed to get a
 * script into it — a flaw in our code, a compromised dependency served from our own origin aside —
 * the browser should refuse to run it. So: scripts only from this origin, plus the page's own
 * inline scripts by the hash of their exact text (computed from the HTML actually sent, so a
 * branded page with its injected config is covered too). An injected <script> has another hash.
 *
 * Only on the app page, not site-wide: module pages are served by modules and bring their own
 * markup; a policy written here would break them without anyone noticing until a customer did.
 *
 * Every source and why:
 *   script-src 'wasm-unsafe-eval'  background effects compile MediaPipe's WebAssembly
 *   worker-src blob:              the background effect's clock runs in a worker made from a Blob
 *   img-src data: blob:           QR codes (data URIs), shared images and PDFs (object URLs)
 *   media-src blob: data:         the generated tones
 *   style-src 'unsafe-inline'     style attributes in the markup; styles cannot run code
 *   connect-src wss://<host>      the signaling socket ('self' alone misses wss in older Safari)
 *   frame-src 'self'              a module's action panel during a call
 */
import { createHash } from 'crypto';

export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m; (m = re.exec(html)); ) out.push(`'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  return out;
}

export function appPagePolicy(html: string, host?: string): string {
  const ws = host && /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? ` wss://${host} ws://${host}` : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHashes(html).join(' ')}`.trim(),
    "worker-src 'self' blob:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    `connect-src 'self'${ws}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
