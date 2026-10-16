// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/* Theme switcher — light / dark / auto (OS).
 *
 * Model: the CSS carries BOTH palettes (style.css & landing.css `:root` tokens).
 *   - Auto (default): `@media (prefers-color-scheme: dark)` decides; nothing stored.
 *   - Explicit choice: `<html data-theme="light|dark">` overrides the media query,
 *     persisted in localStorage('eudi_theme').
 *
 * This file MUST be loaded synchronously in <head> (before first paint): the IIFE
 * below applies a stored choice immediately, so there is no light→dark flash.
 * The toggle button (`#theme-toggle`, optional per page) cycles auto → dark → light
 * and shows the icon of the ACTIVE state (auto = monitor, dark = moon, light = sun).
 * Labels go through t() from i18n.js when present (loads later; German fallback).
 */
'use strict';

(function applyStoredTheme() {
  try {
    const t = localStorage.getItem('eudi_theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch { /* storage blocked → stay on auto */ }
})();

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  const ICONS = {
    // Lucide-style outline icons (one icon style everywhere)
    auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  };
  const LABELS = {
    auto: 'Design: automatisch (Systemeinstellung)',
    dark: 'Design: dunkel',
    light: 'Design: hell',
  };
  const ORDER = ['auto', 'dark', 'light'];

  function current() {
    const t = document.documentElement.dataset.theme;
    return t === 'light' || t === 'dark' ? t : 'auto';
  }
  function render() {
    const mode = current();
    // t() comes from i18n.js when the page ships it; otherwise German source text.
    const label = typeof t === 'function' ? t(LABELS[mode]) : LABELS[mode];
    btn.innerHTML = ICONS[mode];
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
  btn.addEventListener('click', () => {
    const next = ORDER[(ORDER.indexOf(current()) + 1) % ORDER.length];
    if (next === 'auto') {
      delete document.documentElement.dataset.theme;
      try { localStorage.removeItem('eudi_theme'); } catch { /* ignore */ }
    } else {
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('eudi_theme', next); } catch { /* ignore */ }
    }
    render();
  });
  render();
});

/* Footer link for operator pages that actually exist.
 *
 * Imprint and privacy notice are linked statically — every instance needs them, and the shipped
 * placeholders make sure the link never dead-ends. A press page is different: most instances will
 * not have one. So the link is added from `/capabilities` (`operatorPages`), and an instance
 * without a press page shows no press link at all.
 *
 * Deliberately in theme.js: it is the one script every page loads. Failure is silent — a footer
 * link is not worth an error message, and the page must not depend on the request succeeding.
 */
(function operatorFooterLinks() {
  // This file is loaded SYNCHRONOUSLY in <head> (see the top of the file), so the footer does not
  // exist yet at this point. Wait for the parsed document.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', operatorFooterLinks);
    return;
  }
  var nav = document.querySelector('.site-footer nav');
  if (!nav || !window.fetch) return;
  var LABEL = { presse: { de: 'Presse', en: 'Press', fr: 'Presse' } };
  var lang = (document.documentElement.lang || 'de').slice(0, 2);
  fetch('/capabilities', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (caps) {
      if (!caps) return;
      appDemo(caps);
      if (!caps.operatorPages) return;
      caps.operatorPages.forEach(function (page) {
        if (!LABEL[page]) return;                                  // imprint/privacy: already linked
        if (nav.querySelector('a[href^="' + page + '"]')) return;  // do not duplicate
        var a = document.createElement('a');
        a.href = page + '.html';
        a.textContent = LABEL[page][lang] || LABEL[page].de;
        nav.appendChild(a);
      });
    })
    .catch(function () {});
})();
