// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TrustCall embed — drop-in widget for third-party sites (Pro feature).
 *
 * Two ways to use it:
 *
 * 1) Declarative (auto-init from the <script> tag):
 *    <div id="trustcall"></div>
 *    <script src="https://id-call.eu/embed.js"
 *            data-target="#trustcall"
 *            data-mode="video"
 *            data-request="family_name,age_over_18"
 *            data-lock="true"
 *            data-height="620"></script>
 *
 * 2) Programmatic:
 *    <script src="https://id-call.eu/embed.js"></script>
 *    <script>
 *      const call = TrustCall.embed('#trustcall', {
 *        mode: 'video',
 *        request: ['family_name', 'age_over_18'], // PID attributes to ask the guest for
 *                                                 // (WRP scope: family_name, given_name,
 *                                                 //  age_over_18 — nothing else)
 *        disclose: [],                            // PID attributes the host reveals
 *        lock: true,                              // pin the config (read-only in the widget)
 *        height: 620,
 *        on: {
 *          ready:     (d) => console.log('widget loaded', d),
 *          joined:    (d) => console.log('joined as', d.role),
 *          connected: (d) => console.log('P2P connected', d),
 *          verified:  (d) => console.log('both verified ✓'),
 *          ended:     ()  => console.log('call ended'),
 *        },
 *      });
 *      // call.destroy() removes the widget.
 *    </script>
 *
 * The config travels in the iframe URL HASH (#cfg=…) so it never reaches the server or
 * its logs. The iframe is granted camera/microphone/display-capture. Lifecycle events
 * (never PID values) are relayed via postMessage and dispatched to your callbacks.
 */
(function () {
  'use strict';

  // Origin this script was loaded from → where the TrustCall app lives.
  var SELF = (function () {
    var cs = document.currentScript;
    try { return new URL(cs.src).origin; } catch (e) { return location.origin; }
  })();

  var VALID_MODES = { video: 1, audio: 1, chat: 1 };
  // WRP whitelist (server: src/wrp-policy.ts). birth_date / issuing_country / address were
  // removed with the eIDAS 2.0 WRP scoping — the server narrows or refuses them, so drop
  // them here too and SAY SO, instead of silently shipping a config that won't apply.
  // pseudonym_id is omitted on purpose: it is derived server-side and only valid alongside
  // a real attribute, which an embed config cannot usefully express.
  var VALID_ATTRS = { family_name: 1, given_name: 1, age_over_18: 1 };

  function toList(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return [];
  }
  function sanitizeAttrs(v) {
    var list = toList(v);
    var ok = list.filter(function (k) { return VALID_ATTRS[k]; });
    var bad = list.filter(function (k) { return !VALID_ATTRS[k]; });
    if (bad.length) {
      console.warn('[TrustCall] attribute(s) not permitted by the eIDAS 2.0 WRP scope and ignored: ' +
        bad.join(', ') + ' — allowed: ' + Object.keys(VALID_ATTRS).join(', '));
    }
    return ok;
  }

  // base64url(JSON) — UTF-8 safe.
  function encodeCfg(cfg) {
    var json = JSON.stringify(cfg);
    return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function resolveTarget(target) {
    if (!target) return null;
    if (typeof target === 'string') return document.querySelector(target);
    return target; // assume an element
  }

  function embed(target, options) {
    options = options || {};
    var el = resolveTarget(target);
    if (!el) { console.error('[TrustCall] embed target not found:', target); return null; }

    var origin = options.origin || SELF;
    var src;
    if (options.token) {
      // Hardened mode: a signed token (issued by the operator) carries the config and
      // the allowed origins; the server verifies it. No client-side #cfg needed.
      src = origin + '/?embed=1&tok=' + encodeURIComponent(options.token);
    } else {
      // Open mode: config in the URL hash (never sent to the server).
      var cfg = {};
      if (VALID_MODES[options.mode]) cfg.mode = options.mode;
      if (options.request != null) cfg.request = sanitizeAttrs(options.request);
      if (options.disclose != null) cfg.disclose = sanitizeAttrs(options.disclose);
      if (options.lock) cfg.lock = true;
      src = origin + '/?embed=1#cfg=' + encodeCfg(cfg);
    }

    var iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.title = 'TrustCall';
    // Permissions the verified call needs. Scoped to this iframe's origin.
    iframe.setAttribute('allow', 'camera; microphone; display-capture; fullscreen; clipboard-write');
    iframe.setAttribute('allowfullscreen', '');
    iframe.style.border = '0';
    iframe.style.width = '100%';
    iframe.style.height = (options.height ? Number(options.height) : 640) + 'px';
    iframe.style.borderRadius = '14px';
    iframe.style.display = 'block';
    el.appendChild(iframe);

    var handlers = options.on || {};
    function onMessage(e) {
      if (e.origin !== origin) return;                 // only trust our app's origin
      if (e.source !== iframe.contentWindow) return;    // only this iframe
      var d = e.data;
      if (!d || d.source !== 'trustcall' || !d.type) return;
      var fn = handlers[d.type];
      if (typeof fn === 'function') { try { fn(d); } catch (err) { console.error(err); } }
    }
    window.addEventListener('message', onMessage);

    return {
      iframe: iframe,
      destroy: function () { window.removeEventListener('message', onMessage); if (iframe.parentNode) iframe.parentNode.removeChild(iframe); },
    };
  }

  // Declarative auto-init from the current <script> tag's data-* attributes.
  (function autoInit() {
    var cs = document.currentScript;
    if (!cs) return;
    var t = cs.getAttribute('data-target');
    if (!t) return;
    var run = function () {
      embed(t, {
        token: cs.getAttribute('data-token') || undefined,
        mode: cs.getAttribute('data-mode') || undefined,
        request: cs.getAttribute('data-request') || undefined,
        disclose: cs.getAttribute('data-disclose') || undefined,
        lock: cs.getAttribute('data-lock') === 'true',
        height: cs.getAttribute('data-height') || undefined,
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();
  })();

  window.TrustCall = { embed: embed };
})();
