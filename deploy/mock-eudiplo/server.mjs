// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ⚠️  A DUMMY — not a verifier. For frontend work only.
 *
 * This server imitates the three EUDIPLO endpoints that `src/eudiplo.ts` calls, and instead of a
 * real wallet presentation it serves a tiny "mock wallet" page: open the offer, click "verify",
 * and this server sends a success callback to the application's webhook. That makes the
 * verify -> review -> connect flow run through on localhost, with no wallet and no registration.
 *
 * WHAT IT DOES NOT DO — and this matters, because otherwise people come to rely on it:
 *
 *   - **No cryptography.** No signature verification, no certificate chain, no status list
 *     lookup, no trust list. It believes any name typed into it.
 *   - **It does not honour the request.** It returns given AND family name regardless of what the
 *     DCQL asked for. A real wallet presents only what was requested. A genuine bug once lived in
 *     exactly that gap: offer creation requested only `family_name`, so the host gate rejected
 *     its own operator — and against this dummy that was green. That is why
 *     `scripts/test-host-login.mjs` builds its OWN verifier, which releases only what was asked
 *     for.
 *   - **No interoperability.** The real stumbling blocks — mdoc status lists, some wallets'
 *     rejection of `trusted_authorities`, format differences between mdoc and SD-JWT VC — do not
 *     exist here. They only show up against a real instance.
 *
 * Anyone wanting to operate the application seriously, or to examine its protocol behaviour,
 * needs **their own EUDIPLO instance** together with an access certificate from a registration
 * authority — see the README. This dummy is no substitute, and is not meant to be one.
 *
 * Start:  SELF_URL=http://localhost:8080 node deploy/mock-eudiplo/server.mjs
 * Point the app at it:  EUDIPLO_BASE_URL=http://localhost:8080
 * Webhook targets: the mock only POSTs to `/webhook/…` on an allowed app origin. Default:
 * localhost, 127.0.0.1 and [::1] (any port). Otherwise set WEBHOOK_ORIGINS=https://app.example.org
 * (comma-separated origins).
 *
 * NOT for production.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8080);
const SELF_URL = (process.env.SELF_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

/** Origins the mock may call back (SSRF guard); default: loopback app origins only. */
const WEBHOOK_ORIGINS = (process.env.WEBHOOK_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

/** Is `raw` a URL the mock may POST to: allowed origin and a `/webhook/…` path? */
function webhookAllowed(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!u.pathname.startsWith('/webhook/')) return false;
  if (WEBHOOK_ORIGINS.length) return WEBHOOK_ORIGINS.includes(u.origin);
  return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/** Escape a value for interpolation into HTML (text and quoted attributes). */
function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** offerId → { webhook, requestId } the app asked us to call back. */
const offers = new Map();
/**
 * The dummy's session store — the thing the real EUDIPLO keeps, and the reason
 * `src/verifier-session.ts` exists: after a presentation the claims sit HERE until someone
 * deletes them. `GET /api/session/:id` shows them, `DELETE /api/session/:id` removes them.
 * The app calls that DELETE the moment it has read the webhook, so against this dummy the
 * GET is already a 404 by the time you try it by hand.
 */
const sessions = new Map();
/** verifier config id → dcql_query (so the mock wallet can render matching claim forms). */
const configs = new Map();

/** Default values the mock wallet pre-fills for non-PID (catalog) claims. */
const CLAIM_DEFAULTS = {
  objekt_id: 'WR-123456',
  adresse: 'Musterstr. 1, 10115 Berlin',
  max_personen: '4',
  gueltig_bis: '2027-12-31',
};

/** Last string segment of a DCQL claim path = the flat claim key. */
function pathKey(path) {
  const strings = (path || []).filter((s) => typeof s === 'string');
  return strings[strings.length - 1] ?? String(path?.[path.length - 1] ?? '');
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(raw));
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

/**
 * The DCQL rules EUDIPLO 8.0.2 enforces on POST /verifier/config (read off its OpenAPI schema,
 * every level `additionalProperties: false`). Returns the first violation, or null.
 */
function dcqlViolation(dcql) {
  const only = (o, keys) => Object.keys(o ?? {}).find((k) => !keys.includes(k));
  for (const c of dcql?.credentials ?? []) {
    const claimKeys = c.format === 'mso_mdoc' ? ['id', 'path', 'values', 'intent_to_retain'] : ['id', 'path', 'values'];
    for (const cl of c.claims ?? []) { const k = only(cl, claimKeys); if (k) return `${c.format} claim: unknown key ${k}`; }
    for (const ta of c.trusted_authorities ?? []) {
      if (ta.type === 'etsi_tl' && (ta.values ?? []).some((v) => typeof v !== 'object')) return 'etsi_tl values must be objects';
    }
  }
  for (const s of dcql?.credential_sets ?? []) { const k = only(s, ['options', 'required']); if (k) return `credential_sets: unknown key ${k}`; }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, SELF_URL);
  const p = url.pathname;

  // --- endpoints the app (src/eudiplo.ts) calls ---
  if (req.method === 'POST' && p === '/api/oauth2/token') return json(res, 200, { access_token: 'mock-token' });
  if (req.method === 'POST' && /^\/api\/client\/[^/]+\/rotate-secret$/.test(p)) return json(res, 200, { secret: 'mock-secret' });
  if (req.method === 'POST' && p === '/api/verifier/config') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const bad = dcqlViolation(body?.dcql_query);
    if (bad) return json(res, 400, { error: `${bad} (EUDIPLO 8 schema)` });
    if (body?.id && body?.dcql_query) configs.set(body.id, body.dcql_query);
    return json(res, 200, { ok: true });
  }

  // The app checks once that the tenant has a registrar configuration, because EUDIPLO
  // otherwise drops the registration certificate silently (see src/registration-cert.ts).
  if (req.method === 'GET' && p === '/api/registrar/config') return json(res, 200, { registrarUrl: 'mock' });

  if (req.method === 'POST' && p === '/api/verifier/offer') {
    const body = JSON.parse((await readBody(req)) || '{}');
    // Like EUDIPLO 7+: the offer schema is strict, an unknown field is a 400.
    const unknown = Object.keys(body).filter((k) => !['response_type', 'requestId', 'webhook', 'redirectUri', 'expected_origin', 'transaction_data', 'skewSeconds'].includes(k));
    if (unknown.length) return json(res, 400, { error: `unrecognized keys: ${unknown.join(',')}` });
    const webhook = body?.webhook?.url;
    if (!webhook) return json(res, 400, { error: 'missing webhook.url' });
    if (!webhookAllowed(webhook)) return json(res, 400, { error: 'webhook.url not allowed: must be /webhook/… on an allowed origin (see WEBHOOK_ORIGINS)' });
    const id = randomUUID();
    offers.set(id, { webhook, requestId: body?.requestId });
    const uri = `${SELF_URL}/simulate/${id}`;
    console.log(`[mock] offer ${id} (config ${body?.requestId}) → webhook ${webhook}`);
    // `session` is what EUDIPLO 8 returns (OfferResponse) and what the app needs in order to
    // delete the session afterwards. A dummy that withheld it would make the purge look
    // untested while it silently did nothing.
    return json(res, 200, { uri, crossDeviceUri: uri, session: id });
  }

  // --- session store (what the app purges) ---
  const sess = p.match(/^\/api\/session\/([0-9a-f-]+)$/i);
  if (sess && req.method === 'GET') {
    const row = sessions.get(sess[1]);
    return row ? json(res, 200, row) : json(res, 404, { error: 'session not found' });
  }
  if (sess && req.method === 'DELETE') {
    // EUDIPLO answers 204 either way — it does not check existence, so a repeated purge is
    // not an error. The dummy behaves the same, otherwise the app would learn a lesson here
    // that the real instance does not teach.
    const existed = sessions.delete(sess[1]);
    console.log(`[mock] session ${sess[1]} deleted (${existed ? 'had claims' : 'was empty'})`);
    res.writeHead(204);
    return res.end();
  }

  // --- the "mock wallet" the tester opens instead of scanning a real QR ---
  const sim = p.match(/^\/simulate\/([0-9a-f-]+)$/i);
  if (sim && req.method === 'GET') {
    const id = sim[1];
    const offer = offers.get(id);
    if (!offer) return html(res, 404, '<p>Unbekanntes/abgelaufenes Angebot.</p>');

    // In-call catalog credential (config id "cred_…"): render a GENERIC claim form from
    // the registered DCQL, so e.g. the Wohnraum-ID flow works end-to-end on localhost.
    if (String(offer.requestId || '').startsWith('cred_')) {
      const dcql = configs.get(offer.requestId);
      const claims = dcql?.credentials?.[0]?.claims ?? [];
      const type = dcql?.credentials?.[0]?.meta?.vct_values?.[0]
        || dcql?.credentials?.[0]?.meta?.doctype_value || 'Credential';
      const fields = claims.map((c) => {
        const key = pathKey(c.path);
        const val = CLAIM_DEFAULTS[key] ?? 'test';
        return `<label>${escapeHtml(key)}<input name="${escapeHtml(key)}" value="${escapeHtml(val)}"></label>`;
      }).join('\n');
      return html(res, 200, `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Mock-Wallet</title>
<style>body{font:16px/1.5 system-ui;max-width:22rem;margin:12vh auto;padding:0 1rem;color:#1b2433}
input{width:100%;padding:.6rem;margin:.2rem 0 .8rem;border:1px solid #cfd8e6;border-radius:8px;font:inherit}
button{width:100%;padding:.7rem;border:0;border-radius:8px;background:#4f46e5;color:#fff;font:inherit;font-weight:600}
small{color:#5d6b85;word-break:break-all}</style>
<h2>🪪 Mock-Wallet — Nachweis</h2>
<p><small>Simulated presentation for <code>${escapeHtml(type)}</code> (local development, no cryptography).</small></p>
<form method=POST action="/simulate/${escapeHtml(id)}">
${fields}
<button>Nachweis teilen ✓</button>
</form>`);
    }
    return html(res, 200, `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Mock-Wallet</title>
<style>body{font:16px/1.5 system-ui;max-width:22rem;margin:12vh auto;padding:0 1rem;color:#1b2433}
input{width:100%;padding:.6rem;margin:.2rem 0 .8rem;border:1px solid #cfd8e6;border-radius:8px;font:inherit}
button{width:100%;padding:.7rem;border:0;border-radius:8px;background:#0369a1;color:#fff;font:inherit;font-weight:600}
small{color:#5d6b85}</style>
<h2>🪪 Mock-Wallet</h2>
<p><small>Not a real identity document — simulates a PID presentation for local development.</small></p>
<form method=POST action="/simulate/${escapeHtml(id)}">
  <label>Vorname<input name=given_name value="Erika"></label>
  <label>Nachname<input name=family_name value="Mustermann"></label>
  <label>Format<select name=format style="width:100%;padding:.6rem;margin:.2rem 0 .8rem;border:1px solid #cfd8e6;border-radius:8px;font:inherit">
    <option value="mdoc">PID · ISO mdoc</option>
    <option value="sdjwt">PID · SD-JWT VC</option>
  </select></label>
  <button>Verifizieren ✓</button>
</form>`);
  }
  if (sim && req.method === 'POST') {
    const id = sim[1];
    const offer = offers.get(id);
    if (!offer) return html(res, 404, '<p>Unbekanntes/abgelaufenes Angebot.</p>');
    const webhook = offer.webhook;
    if (!webhookAllowed(webhook)) return html(res, 400, '<p>Webhook not allowed.</p>');
    const form = new URLSearchParams(await readBody(req));

    // Generic path for in-call catalog credentials: every form field becomes a flat claim.
    if (String(offer.requestId || '').startsWith('cred_')) {
      const values = {};
      for (const [k, v] of form.entries()) values[k] = v;
      const payload = { status: 'completed', session: id, credentials: [{ values: [values] }] };
      sessions.set(id, payload);
      try {
        const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        console.log(`[mock] posted credential presentation for ${id} → ${r.status}`);
      } catch (e) {
        console.error('[mock] webhook POST failed:', e?.message);
        return html(res, 502, '<p>Webhook unreachable. Is the app running, and is PUBLIC_URL correct?</p>');
      }
      offers.delete(id); // one-shot
      return html(res, 200, `<!doctype html><meta charset=utf-8><style>body{font:16px/1.5 system-ui;max-width:22rem;margin:12vh auto;text-align:center;color:#1b2433}</style>
<h2>✓ Credential shared</h2><p>You can return to the call — the requester sees the result on your tile.</p>`);
    }

    const given_name = form.get('given_name') || 'Erika';
    const family_name = form.get('family_name') || 'Mustermann';
    const format = form.get('format') || 'mdoc';
    // Mirror EUDIPLO's success shape: claims live in credentials[].values[]. The claim
    // NAMES/nesting differ by format — mdoc is flat (birth_date, resident_*), SD-JWT VC
    // uses birthdate, a nested address object and age_equal_or_over. The app's
    // normalizeClaims() maps both onto the same canonical keys.
    const values = format === 'sdjwt'
      ? {
          given_name, family_name,
          birthdate: '1984-01-26', issuing_country: 'DE',
          age_equal_or_over: { '18': true },
          address: { street_address: 'Musterstr. 1', locality: 'Berlin', postal_code: '10115', country: 'DE' },
        }
      : {
          given_name, family_name,
          age_over_18: true, birth_date: '1984-01-26', issuing_country: 'DE',
          resident_street: 'Musterstr. 1', resident_postal_code: '10115', resident_city: 'Berlin', resident_country: 'DE',
        };
    const payload = { status: 'completed', session: id, credentials: [{ values: [values] }] };
    sessions.set(id, payload);
    try {
      const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      console.log(`[mock] posted verification for ${id} → ${r.status}`);
    } catch (e) {
      console.error('[mock] webhook POST failed:', e?.message);
      return html(res, 502, '<p>Webhook unreachable. Is the app running, and is PUBLIC_URL correct?</p>');
    }
    offers.delete(id); // one-shot
    return html(res, 200, `<!doctype html><meta charset=utf-8><style>body{font:16px/1.5 system-ui;max-width:22rem;margin:12vh auto;text-align:center;color:#1b2433}</style>
<h2>✓ Verified as ${escapeHtml(given_name)} ${escapeHtml(family_name)}</h2><p>You can return to the other tab — the call connects as soon as both sides have confirmed.</p>`);
  }

  if (p === '/health') return json(res, 200, { ok: true });
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`mock-eudiplo on ${SELF_URL} (PORT ${PORT})`));
