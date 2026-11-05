// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/* Lightweight i18n for the vanilla-JS frontend — no external libraries.
 *
 * Model (gettext-style): GERMAN is the source language and doubles as the key.
 *   - Static HTML keeps its German text; elements opt in via `data-i18n` (plain text),
 *     `data-i18n-html` (trusted markup from the app's own dictionary) or
 *     `data-i18n-attr="placeholder,aria-label"` (attribute values). The element's own
 *     initial (whitespace-normalized) content IS the dictionary key.
 *   - Dynamic strings in app.js are wrapped in t('deutscher Text').
 *   - translations.json = { "<locale>": { "<German source>": "<translation>", … } }.
 *     German needs no entry (identity), and any missing entry falls back to German —
 *     which also covers the moment before the async dictionary has loaded.
 *
 * Locale resolution: ?lang=xx → localStorage → navigator.languages → 'de'.
 * Only locales present in translations.json (plus 'de') are considered available;
 * EU_LOCALES documents the full target set — add a language by adding its object
 * to translations.json, nothing else.
 */
'use strict';

/** All 24 official EU languages (target set; available = subset present in the JSON). */
const EU_LOCALES = ['bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'ga', 'hr', 'hu', 'it', 'lt', 'lv', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'sl', 'sv'];
const SOURCE_LOCALE = 'de';

let i18nDict = {};          // translations.json content
let i18nLocale = SOURCE_LOCALE;
// The operator's own wording (/capabilities `ui.texte`, see src/operator-ui.ts): German source →
// replacement, per locale. Checked before the dictionary. Plain text only — the server refuses a
// file whose values contain < > &, and the markup path below still inserts them as text.
let i18nOverrides = {};

/** Normalize whitespace so pretty-printed HTML and JSON keys compare equal. */
function i18nNorm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

/**
 * Translate a German source string (optionally with {placeholders}).
 * Falls back to the German input when the locale is German, the dictionary
 * hasn't loaded yet, or the entry is missing.
 */
function t(source, vars) {
  const key = i18nNorm(source);
  const own = i18nOverrides[i18nLocale];
  const table = i18nDict[i18nLocale];
  let out = (own && own[key]) || (table && table[key]) || source;
  if (vars) for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(vars[k]);
  return out;
}

/** Pick the UI locale: explicit ?lang → saved choice → browser languages → German. */
function detectLocale(available) {
  const fromUrl = new URLSearchParams(location.search).get('lang');
  if (fromUrl && available.includes(fromUrl)) { try { localStorage.setItem('eudi_lang', fromUrl); } catch {} return fromUrl; }
  try {
    const saved = localStorage.getItem('eudi_lang');
    if (saved && available.includes(saved)) return saved;
  } catch {}
  for (const l of navigator.languages || [navigator.language]) {
    const two = String(l || '').slice(0, 2).toLowerCase();
    if (available.includes(two)) return two;
  }
  return SOURCE_LOCALE;
}

/**
 * Replace text/markup/attributes of all opted-in elements under `root`.
 * The original German content is captured once (dataset) so re-applying — e.g. after
 * a language switch — stays idempotent.
 */
function applyI18n(root) {
  const scope = root || document;
  for (const el of scope.querySelectorAll('[data-i18n]')) {
    if (!el.dataset.i18nKey) el.dataset.i18nKey = i18nNorm(el.textContent);
    el.textContent = t(el.dataset.i18nKey);
  }
  for (const el of scope.querySelectorAll('[data-i18n-html]')) {
    if (!el.dataset.i18nKey) el.dataset.i18nKey = i18nNorm(el.innerHTML);
    // An operator's wording is text, never markup — whatever it contains.
    const own = i18nOverrides[i18nLocale] && i18nOverrides[i18nLocale][el.dataset.i18nKey];
    if (own) { el.textContent = own; continue; }
    // Dictionary values may contain markup (<strong>, <em>); the dictionary ships with
    // the app and is trusted — never feed user input through this path.
    el.innerHTML = t(el.dataset.i18nKey);
  }
  for (const el of scope.querySelectorAll('[data-i18n-attr]')) {
    for (const attr of el.dataset.i18nAttr.split(',')) {
      const a = attr.trim();
      const store = 'i18nAttr' + a.replace(/[^a-z]/gi, '');
      if (!el.dataset[store]) el.dataset[store] = el.getAttribute(a) || '';
      if (el.dataset[store]) el.setAttribute(a, t(el.dataset[store]));
    }
  }
}

/**
 * Take the operator's wording and re-translate what it touches. Only plain-string values are
 * kept; anything else in the object is ignored rather than trusted.
 */
function setI18nOverrides(texte) {
  const next = {};
  if (texte && typeof texte === 'object') {
    for (const [locale, table] of Object.entries(texte)) {
      if (!table || typeof table !== 'object') continue;
      next[locale] = {};
      for (const [k, v] of Object.entries(table)) if (typeof v === 'string' && !/[<>&]/.test(v)) next[locale][i18nNorm(k)] = v;
    }
  }
  if (JSON.stringify(next) === JSON.stringify(i18nOverrides)) return false;
  // Only the elements whose text an override touches (now or before) are re-translated. A full
  // applyI18n() would also reset elements app.js has filled since (previews, labels, status) to
  // their static source text.
  const keys = new Set([...Object.values(i18nOverrides), ...Object.values(next)].flatMap((tab) => Object.keys(tab)));
  i18nOverrides = next;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18nKey || i18nNorm(el.textContent);
    if (!keys.has(key)) continue;
    el.dataset.i18nKey = key;
    el.textContent = t(key);
  }
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    const key = el.dataset.i18nKey || i18nNorm(el.innerHTML);
    if (!keys.has(key)) continue;
    el.dataset.i18nKey = key;
    const own = i18nOverrides[i18nLocale] && i18nOverrides[i18nLocale][key];
    if (own) el.textContent = own; else el.innerHTML = t(key);
  }
  for (const el of document.querySelectorAll('[data-i18n-attr]')) {
    for (const attr of el.dataset.i18nAttr.split(',')) {
      const a = attr.trim();
      const store = 'i18nAttr' + a.replace(/[^a-z]/gi, '');
      const raw = el.dataset[store] || el.getAttribute(a) || '';
      if (!keys.has(i18nNorm(raw))) continue;
      el.dataset[store] = raw;
      el.setAttribute(a, t(raw));
    }
  }
  return true;
}

/**
 * Populate the footer language switcher with all AVAILABLE locales (German + every
 * locale present in translations.json) — adding a language to the JSON automatically
 * adds it here. Labels are the languages' own native names via Intl.DisplayNames.
 * Switching persists the choice and reloads; the session resumes via clientId.
 */
function initLangSwitcher(available) {
  const sel = document.getElementById('lang-switch');
  if (!sel || available.length < 2) return;
  for (const code of available) {
    const opt = document.createElement('option');
    opt.value = code;
    let name = code.toUpperCase();
    try { const n = new Intl.DisplayNames([code], { type: 'language' }).of(code); if (n) name = n[0].toUpperCase() + n.slice(1); } catch {}
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = i18nLocale;
  sel.addEventListener('change', () => {
    try { localStorage.setItem('eudi_lang', sel.value); } catch {}
    // Drop any ?lang= from the URL — it would override the new choice on reload.
    const url = new URL(location.href);
    url.searchParams.delete('lang');
    location.replace(url.toString());
  });
  sel.hidden = false;
}

/** Resolves once translations are loaded and the static DOM is translated. */
const i18nReady = (async () => {
  try {
    const res = await fetch('translations.json');
    if (res.ok) i18nDict = await res.json();
  } catch { /* offline/missing → stay German */ }
  const available = [SOURCE_LOCALE, ...Object.keys(i18nDict)].filter((l, i, a) => EU_LOCALES.includes(l) && a.indexOf(l) === i);
  i18nLocale = detectLocale(available);
  document.documentElement.lang = i18nLocale;
  if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
  if (i18nLocale !== SOURCE_LOCALE) applyI18n();
  initLangSwitcher(available);
  return i18nLocale;
})();
