// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The verifier's record of each presentation, for tests that play the verifier.
 *
 * EUDIPLO stores a presentation's result BEFORE it calls the webhook, and the app reads it back
 * from there (`confirmedPresentation` in src/eudiplo.ts) instead of trusting the callback. A test
 * that posts a callback straight to the app therefore records the same body here first — what
 * the real verifier would hold — and the mock's `GET /api/session/:id` answers with `lookup`.
 * A session nobody presented to is `active`, as at EUDIPLO.
 */
export function verifierResults() {
  const results = new Map();
  return {
    record(sessionId, body) {
      if (!sessionId) return;
      const { session: _named, ...rest } = body || {};
      results.set(sessionId, { id: sessionId, ...rest });
    },
    lookup(sessionId) {
      return results.get(sessionId) ?? { id: sessionId, status: 'active' };
    },
  };
}

/** The verifier session whose offer carried `webhookUrl` — matched by path, so a test that
 *  tampers with the token still finds it, and the NEWEST such offer, because a failed
 *  presentation is followed by a fresh offer for the same participant.
 *  `offers` maps session id → URL (or → { url | webhook }), in creation order. */
export function sessionForWebhook(offers, webhookUrl) {
  const path = (u) => { try { return new URL(u).pathname; } catch { return ''; } };
  const want = path(webhookUrl);
  let found;
  for (const [id, v] of offers) {
    const url = typeof v === 'string' ? v : (v?.url ?? v?.webhook);
    if (url && path(url) === want) found = id;
  }
  return found;
}
