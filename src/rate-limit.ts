// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal in-memory rate limit for the unauthenticated endpoints (`/invite`, `/wallet-pass`).
 *
 * Fixed window per client IP, no dependency, no persistence: a restart resets the counters,
 * which is acceptable for a brake against bulk use. It is NOT a defence against a distributed
 * flood — that belongs in front of the application.
 *
 * Client IP: Express `trust proxy` is deliberately not set, so behind a reverse proxy the
 * socket address is the proxy for everyone. Only when the socket peer is loopback or private
 * (i.e. a proxy in the same network) the LAST `X-Forwarded-For` entry is used — the one that
 * immediate proxy appended. Earlier entries are client-supplied and never trusted; from a
 * public peer the header is ignored altogether.
 */
import type { RequestHandler, Request } from 'express';
import { isIP } from 'net';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_BUCKETS = 10_000;

function isPrivateAddress(addr: string): boolean {
  let a = addr.toLowerCase();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168);
  }
  if (a === '::1') return true;
  return /^f[cd][0-9a-f]{2}:/.test(a);     // fc00::/7
}

export function clientIp(req: Request): string {
  const peer = req.socket.remoteAddress || 'unknown';
  if (isPrivateAddress(peer)) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff.join(',') : xff;
    const last = raw ? raw.split(',').pop()!.trim() : '';
    if (last) return last;
  }
  return peer;
}

/** `perWindow` requests per 10 minutes per IP; `0` (or invalid) = off. */
export function rateLimit(perWindow: number): RequestHandler {
  if (!Number.isFinite(perWindow) || perWindow <= 0) return (_req, _res, next) => next();
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = Date.now();
  return (req, res, next) => {
    const now = Date.now();
    // Drop expired buckets once per window; if the map is still full, forget the oldest
    // entries rather than grow without bound.
    if (now - lastSweep >= WINDOW_MS || buckets.size >= MAX_BUCKETS) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
      while (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value as string);
      lastSweep = now;
    }
    const ip = clientIp(req);
    let b = buckets.get(ip);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + WINDOW_MS }; buckets.set(ip, b); }
    if (++b.count > perWindow) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((b.resetAt - now) / 1000))));
      res.status(429).json({ error: 'rate limited' });
      return;
    }
    next();
  };
}

/** Requests per 10 minutes from an env variable; unset = `fallback`, `0` = off. */
export function rateLimitFromEnv(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
