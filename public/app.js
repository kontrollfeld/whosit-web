// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/* EUDI Verified Call — browser client (signaling + WebRTC).
 *
 * Model: the host (caller) configures the exchange — connection mode (video/audio/
 * chat), which PID attributes they REQUEST from the guest, and which they DISCLOSE
 * about themselves. Both present what they must (wallet scan), then both see a
 * pre-connect REVIEW of what is shared; only when BOTH confirm does the call connect.
 *
 * Resilience: a stable clientId (sessionStorage) + auto-reconnect resume a session
 * across brief WebSocket drops (phone in the wallet app).
 * `?solo=1` is an internal single-device loopback test path (no visible UI).
 */
'use strict';

// ---- native app shell (Capacitor) ----
// The bundled app serves these files from a local origin and talks to a remote
// server: window.EUDI_APP_CONFIG.apiBase (injected by app/scripts/sync-web.mjs)
// overrides the base for API calls, the WebSocket, and invite links. In the
// browser it is undefined and everything stays relative (same-origin).
const APP_CONFIG = window.EUDI_APP_CONFIG || null;
const API_BASE = (APP_CONFIG && APP_CONFIG.apiBase) ? APP_CONFIG.apiBase.replace(/\/+$/, '') : '';
function apiUrl(path) { return API_BASE ? `${API_BASE}/${path}` : path; }
function wsUrl() {
  if (API_BASE) return API_BASE.replace(/^http/, 'ws');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}
function isNativeApp() { return !!(APP_CONFIG && APP_CONFIG.native) || !!window.Capacitor; }
window.apiUrl = apiUrl; // shared with lazy-loaded modules (public/qes/*)

// ICE servers come from the server's /ice endpoint (STUN + short-lived TURN-REST
// credentials for the configured relay). We keep a STUN-only fallback so a call can
// still start if /ice is briefly unreachable, and refresh before each peer connection
// so the ephemeral TURN credentials are always fresh.
let iceServers = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];
async function refreshIce() {
  try {
    const r = await fetch(apiUrl('ice'), { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.iceServers) && j.iceServers.length) iceServers = j.iceServers;
    }
  } catch { /* keep the current iceServers */ }
}

// ---- capability gating ----
// Optional UI appears only when /capabilities names the ID. The default is the EMPTY set, so a
// failed fetch shows nothing rather than offering something the server refuses (fail-closed). A
// capability can be absent because it is Pro, because its configuration is missing, or because
// the operator switched it off via EUDI_FEATURES_OFF — to the client those are the same.
let caps = new Set();
/** A tenant instance with a host gate: setup is preceded by a sign-in. */
let hostLoginRequired = false;
function capOn(id) { return caps.has(id); }
function applyCapabilities() {
  // "With an appointment" needs only ONE of the two: the signed invitation (`planned-invites`,
  // config-gated via EUDI_INVITE_SECRET) or the calendar exports (`calendar-invite`). Both are
  // Community; the check remains because an instance without an invite secret offers only the
  // exports.
  const canPlan = capOn('planned-invites') || capOn('calendar-invite');
  if (inviteWhenSeg) { inviteWhenSeg.hidden = !canPlan; if (inviteWhenSeg.hidden) setInviteWhen('now'); }
  if (scheduleShare && inviteWhen === 'later') scheduleShare.hidden = !capOn('calendar-invite');
  if (walletPassBtn) walletPassBtn.hidden = !capOn('wallet-pass');
  shareBtn.hidden = !(navigator.share && capOn('native-share'));
  if (!capOn('screen-share')) screenBtn.hidden = true; // screen btn is re-evaluated in revealCall()
  // Chat/meeting convenience (mic and camera run through showMediaControls via capOn).
  emojiBtn.hidden = !capOn('emoji');
  fileBtn.hidden = !capOn('file-transfer');
  updateDocBtn(); // QES document button (Community) — mid-call visibility re-check
}
// The WRP scope this instance is approved for (src/wrp-policy.ts, served by /capabilities
// and /wrp-policy). Starts as the local mirror of the whitelist so the setup UI is correct
// before the fetch resolves; the server's answer then narrows it if the two ever diverge.
// Narrowing only — the client can never widen its own request scope, and the server would
// narrow or refuse it anyway.
let wrpPolicy = null;
function allowedAttrKeys() {
  if (wrpPolicy && Array.isArray(wrpPolicy.allowedAttributes)) {
    return ATTRIBUTES.map((a) => a.key).filter((k) => wrpPolicy.allowedAttributes.includes(k));
  }
  return ATTRIBUTES.map((a) => a.key);
}
// Attributes the server derives itself instead of asking the wallet for (pseudonym_id).
function derivedKeys() {
  return (wrpPolicy && Array.isArray(wrpPolicy.derivedAttributes)) ? wrpPolicy.derivedAttributes : ['pseudonym_id'];
}
async function refreshCaps() {
  try {
    const r = await fetch(apiUrl('capabilities'), { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.enabled)) caps = new Set(j.enabled);
      if (j.policy && typeof j.policy === 'object') wrpPolicy = j.policy;
      hostLoginRequired = j.hostLogin === true;
    }
  } catch { /* keep defaults (all off, local whitelist mirror) */ }
  applyCapabilities();
  applyPolicyTexts();
  refreshCredCatalog(); // Nachweis-Katalog — no-op, wenn kein Katalog konfiguriert ist
}
// Fill the compliance note and the purpose-binding line from the server's policy, so the
// text the user consents to and the purpose sent to the wallet are the same string.
function applyPolicyTexts() {
  if (!wrpPolicy) return;
  for (const el of document.querySelectorAll('[data-policy-note]')) {
    if (wrpPolicy.complianceNote) el.textContent = t(wrpPolicy.complianceNote);
  }
  for (const el of document.querySelectorAll('[data-policy-purpose]')) {
    if (wrpPolicy.purposeText) el.textContent = t(wrpPolicy.purposeText);
  }
}
const $ = (id) => document.getElementById(id);

// ---- DOM ----
const statusBar = $('status-bar');
const offlineBar = $('offline-bar');
const offlineRetryBtn = $('offline-retry-btn');
const netcheckBar = $('netcheck-bar');
const netcheckMsg = $('netcheck-msg');
const netcheckTech = $('netcheck-tech');
const authRenewBtn = $('auth-renew');
const inviteWait = $('invite-wait');
const inviteCountdown = $('invite-countdown');
const inviteRetryBtn = $('invite-retry-btn');
const restartBtn = $('restart-btn');
const restartLabel = $('restart-label');
const benefitsBox = $('benefits');
const headerSub = document.querySelector('header .sub');
const setupBox = $('setup');
const modeSeg = $('mode-seg');
const discloseSeg = $('disclose-seg');
const requestSeg = $('request-seg');
const requestExtra = $('request-extra');
const discloseListEl = $('disclose-list');
const requestListEl = $('request-list');
const presetsEl = $('presets');
const openroomRow = $('openroom-row');
const openroomToggle = $('openroom-toggle');
const previewRequest = $('preview-request');
const previewDisclose = $('preview-disclose');
const shareBox = $('share');
const shareInput = $('share-url');
const copyBtn = $('copy-btn');
const copyLabel = $('copy-label');
const shareBtn = $('share-btn');
const scheduleBlock = $('schedule-block');
const calTitle = $('cal-title');
const calDate = $('cal-date');
const calTime = $('cal-time');
const calDuration = $('cal-duration');
const icsBtn = $('ics-btn');
const walletPassBtn = $('wallet-pass-btn');
const inviteWhenSeg = $('invite-when-seg');
const newCallBtn = $('new-call-btn');
const scheduleShare = $('schedule-share');
const shareHint = $('share-hint');
const hostLinkRow = $('host-link-row');
const hostUrlInput = $('host-url');
const copyHostBtn = $('copy-host-btn');
const copyHostLabel = $('copy-host-label');
const hostLinkHint = $('host-link-hint');
const gcalBtn = $('gcal-btn');
const authBox = $('auth');
const authTitle = $('auth-title');
const authHint = $('auth-hint');
const consentListEl = $('consent-list');
const qrContainer = $('qrcode');
const authLink = $('auth-link');
const selfChip = $('self-chip');
const selfLabel = $('self-label');
const peerChipsEl = $('peer-chips');
const startBar = $('start-bar');
const startBtn = $('start-btn');
const startHint = $('start-hint');
const startBtnLabel = $('start-btn-label');
const reviewBox = $('review');
const reviewSelf = $('review-self');
const reviewPeer = $('review-peer');
const reviewModeEl = $('review-mode');
const confirmBtn = $('confirm-btn');
const declineBtn = $('decline-btn');
const reviewWait = $('review-wait');
const resultBox = $('result');
const resultSelf = $('result-self');
const resultPeer = $('result-peer');
const callBanner = $('call-banner');
const bannerText = $('banner-text');
const peersBox = $('peers');
const videosEl = $('videos');
const localVideo = $('local-video');
const localNameTag = $('local-name');
const chatBox = $('chat');
const chatLog = $('chat-log');
const chatInput = $('chat-input');
const chatSend = $('chat-send');
const callControls = $('call-controls');
const hangupBtn = $('hangup-btn');
const screenBtn = $('screen-btn');
const screenLabel = $('screen-label');
const handBtn = $('hand-btn');
const handLabel = $('hand-label');
const compatNote = $('compat-note');
const micBtn = $('mic-btn');
const micLabel = $('mic-label');
const camBtn = $('cam-btn');
const camLabel = $('cam-label');
const emojiBtn = $('emoji-btn');
const emojiPalette = $('emoji-palette');
const fileBtn = $('file-btn');
const fileInput = $('file-input');

// setStatus translates centrally (t() falls back to the German source), so every call
// site keeps its readable German literal. The raw source is kept so the bar can be
// re-translated once the async dictionary arrives (first messages fire before load).
function statusState(msg) {
  const x = String(msg);
  if (/Fehler|fehlgeschlagen|verloren|voll|abgelehnt|nicht unterst/i.test(x)) return 'error';
  if (/Weise dich|weise dich|Bitte Kamera|Prüfe, was/i.test(x)) return 'prompt';
  if (/wartet|warte|ausstehend|wird aufgebaut|betreten|neu verbinden/i.test(x)) return 'wait';
  if (/✓|zugestimmt|geschafft|steht\.|Verbunden/i.test(x)) return 'ok';
  return 'info';
}
function setStatus(msg, state) { statusBar.dataset.raw = msg; statusBar.dataset.state = state || statusState(msg); statusBar.textContent = t(msg); }
i18nReady.then(() => { if (statusBar.dataset.raw) setStatus(statusBar.dataset.raw); });
function setLocalLabel(name) { localNameTag.textContent = name ? name + ' · ' + t('Du') : t('Du'); }

// ---- attributes / formatting ----
// Requestable attributes = the WRP whitelist (server: src/wrp-policy.ts). This list is a
// MIRROR for labels/icons, not the authority: the server narrows or refuses anything
// outside its own whitelist, and /capabilities publishes the authoritative set, which
// allowedAttrKeys() below reconciles against this list.
// Geburtsdatum, Ausstellungsland and Adresse were removed with the WRP scoping.
const ATTRIBUTES = [
  { key: 'family_name', label: 'Nachname' },
  { key: 'given_name', label: 'Vorname' },
  { key: 'age_over_18', label: 'Über 18 Jahre', note: 'ohne Geburtsdatum' },
  // Derived server-side (HMAC, per room, gone with the process) — not a wallet claim.
  // Only meaningful IN ADDITION to a real attribute; on its own it is not verification.
  { key: 'pseudonym_id', label: 'Pseudonym', note: 'einmalige Kennung statt Name' },
];
const PRESETS = {
  age: ['age_over_18'],
  name: ['family_name', 'given_name'],
  full: ['family_name', 'given_name', 'age_over_18'],
};
const labelFor = (k) => (ATTRIBUTES.find((a) => a.key === k) || {}).label || k;
const modeLabel = (m) => (m === 'audio' ? 'Audio' : m === 'chat' ? 'Chat' : 'Video');

// per-attribute Lucide-style icons (inner SVG markup), shown in checklists + data rows
const ATTR_ICONS = {
  family_name: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  given_name: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  age_over_18: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  pseudonym_id: '<path d="M2 12h4l3-9 4 18 3-9h6"/>',
};
function attrIconEl(key) {
  const inner = ATTR_ICONS[key];
  if (!inner) return null;
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg class="attr-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  return wrap.firstChild;
}

function titleCase(s) { return String(s || '').toLowerCase().split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' '); }
// One renderer per whitelisted attribute. `default: null` means an unknown claim key is
// never rendered — so even if a payload carried something out of scope (the server strips
// it in normalizeClaims), it could not surface in the UI either.
function attrResult(key, claims) {
  switch (key) {
    case 'family_name': return claims.family_name != null ? { label: 'Nachname', value: titleCase(claims.family_name) } : null;
    case 'given_name': return claims.given_name != null ? { label: 'Vorname', value: titleCase(claims.given_name) } : null;
    case 'age_over_18': return claims.age_over_18 != null ? { label: 'Über 18 Jahre', badge: (claims.age_over_18 === true || claims.age_over_18 === 'true') ? 'Ja' : 'Nein' } : null;
    // Not a wallet claim: derived by the server per room, gone when the process restarts.
    case 'pseudonym_id': return claims.pseudonym_id != null ? { label: 'Pseudonym', value: String(claims.pseudonym_id) } : null;
    default: return null;
  }
}
function renderResultInto(container, claims, attrs, emptyMsg) {
  container.innerHTML = '';
  let any = false;
  for (const k of (attrs && attrs.length ? attrs : [])) {
    const r = claims ? attrResult(k, claims) : null;
    if (!r) continue;
    any = true;
    const row = document.createElement('div');
    row.className = 'result-row';
    const lab = document.createElement('span'); lab.className = 'r-label';
    const ic = attrIconEl(k); if (ic) lab.appendChild(ic);
    const txt = document.createElement('span'); txt.textContent = t(r.label); lab.appendChild(txt);
    row.appendChild(lab);
    if (r.badge) { const b = document.createElement('span'); b.className = 'r-badge'; b.textContent = '✓ ' + t(r.badge); row.appendChild(b); }
    else { const val = document.createElement('span'); val.className = 'r-value'; val.textContent = r.value; row.appendChild(val); }
    container.appendChild(row);
  }
  if (!any) { const e = document.createElement('div'); e.className = 'result-empty'; e.textContent = t(emptyMsg); container.appendChild(e); }
}
// Pre-confirm review: show only WHICH fields will be shared — values stay masked
// until both sides confirm (the server doesn't even send them before then).
function renderFieldList(container, attrs, emptyMsg) {
  container.innerHTML = '';
  if (!attrs || !attrs.length) { const e = document.createElement('div'); e.className = 'result-empty'; e.textContent = emptyMsg; container.appendChild(e); return; }
  for (const k of attrs) {
    const row = document.createElement('div'); row.className = 'result-row pending';
    const lab = document.createElement('span'); lab.className = 'r-label';
    const ic = attrIconEl(k); if (ic) lab.appendChild(ic);
    const txt = document.createElement('span'); txt.textContent = t(labelFor(k)); lab.appendChild(txt);
    const val = document.createElement('span'); val.className = 'r-value masked'; val.textContent = '•••';
    row.append(lab, val); container.appendChild(row);
  }
}
function renderConsent(attrs) {
  consentListEl.innerHTML = '';
  for (const k of (attrs && attrs.length ? attrs : [])) {
    const li = document.createElement('li'); li.textContent = t(labelFor(k)); consentListEl.appendChild(li);
  }
}

// ---- host setup (config) ----
// Each direction is independently anonymous or sharing: discloseMode = what I (host)
// share, requestMode = what I ask of the guest. 'anon' => empty attr list.
let mode = 'video';
let discloseMode = 'data'; // default: host shares the family name too (matches the server's room default)
let requestMode = 'data';
let setupBuilt = false;
// A strict checkbox group over the WRP whitelist — there is no free-text field for
// attribute names anywhere in this UI, so a user cannot compose a request the server
// would narrow or refuse. The compliance note sits in index.html (data-policy-note)
// directly beneath each group.
function buildChecklist(container, prefix, defaultKeys) {
  const allowed = allowedAttrKeys();
  for (const a of ATTRIBUTES) {
    if (!allowed.includes(a.key)) continue; // server narrowed the scope → don't offer it
    const row = document.createElement('label'); row.className = 'attr-row';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = prefix + '-' + a.key;
    if (defaultKeys.includes(a.key)) cb.checked = true;
    cb.addEventListener('change', onConfigChange);
    const span = document.createElement('span'); span.className = 'attr-label'; span.textContent = t(a.label);
    if (a.note) { const n = document.createElement('span'); n.className = 'attr-note'; n.textContent = ' · ' + t(a.note); span.appendChild(n); }
    const ic = attrIconEl(a.key);
    row.append(cb); if (ic) row.append(ic); row.append(span);
    container.appendChild(row);
  }
}
function sanitizeKeys(arr, fallback) {
  const allowed = allowedAttrKeys();
  const list = Array.isArray(arr) ? arr.filter((k) => allowed.includes(k)) : null;
  return list && list.length ? [...new Set(list)] : fallback;
}
function buildSetup() {
  if (setupBuilt) return;
  setupBuilt = true;
  // Re-apply the embed mode: renderStatus() sets `mode` from the server's room default
  // (video) before we get here, which would otherwise discard the embedder's mode.
  if (embedCfg && (embedCfg.mode === 'video' || embedCfg.mode === 'audio' || embedCfg.mode === 'chat')) mode = embedCfg.mode;
  // Embed config seeds the initial requested/disclosed attributes (Pro).
  // Scheduled call: the agreed scope comes from the invitation. Without this, setup showed the
  // local defaults, i.e. something other than what the server actually holds.
  const reqDefault = inviteCfg ? sanitizeKeys(inviteCfg.request, [])
    : embedCfg ? sanitizeKeys(embedCfg.request, requestMode === 'anon' ? [] : ['family_name']) : ['family_name'];
  const discDefault = inviteCfg ? sanitizeKeys(inviteCfg.disclose, [])
    : embedCfg ? sanitizeKeys(embedCfg.disclose, []) : ['family_name'];
  buildChecklist(requestListEl, 'request', reqDefault);
  buildChecklist(discloseListEl, 'disclose', discDefault);
  presetsEl.querySelectorAll('[data-preset]').forEach((btn) => btn.addEventListener('click', () => applyPreset(btn.dataset.preset)));
  modeSeg.querySelectorAll('[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
    mode = btn.dataset.mode;
    modeSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    onConfigChange();
  }));
  discloseSeg.querySelectorAll('[data-disclose]').forEach((btn) => btn.addEventListener('click', () => setDiscloseMode(btn.dataset.disclose)));
  requestSeg.querySelectorAll('[data-request]').forEach((btn) => btn.addEventListener('click', () => setRequestMode(btn.dataset.request)));
  // Reflect current (possibly embed-seeded) state in the segmented controls.
  modeSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  discloseSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.disclose === discloseMode));
  requestSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.request === requestMode));
  discloseListEl.hidden = discloseMode === 'anon';
  requestExtra.hidden = requestMode === 'anon';
  // "Allow more guests later" — only meaningful with the multi-party capability (Pro).
  openroomRow.hidden = !capOn('multi-party');
  openroomToggle.addEventListener('change', onConfigChange);
  const c = currentAttrs();
  updatePreview(c.requestedAttrs, c.disclosedAttrs);
  syncPresetChips();
  if (embedCfg) {
    onConfigChange(); // push the embed-seeded config to the server
    if (embedCfg.lock) lockSetup(); // embedder pinned the config → read-only
  }
  // Scheduled call: pinned. No set-config — the server refuses it for this room anyway (the
  // agreed scope is in the invitation, which the guest consented to).
  if (inviteCfg) lockSetup();
}
function setDiscloseMode(m) {
  discloseMode = m;
  discloseSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.disclose === m));
  discloseListEl.hidden = m === 'anon';
  if (m === 'data' && attrsChecked('disclose').length === 0) { const cb = document.getElementById('disclose-family_name'); if (cb) cb.checked = true; }
  onConfigChange();
}
function setRequestMode(m) {
  requestMode = m;
  requestSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.request === m));
  requestExtra.hidden = m === 'anon';
  if (m === 'data' && attrsChecked('request').length === 0) { const cb = document.getElementById('request-family_name'); if (cb) cb.checked = true; }
  onConfigChange();
}
function attrsChecked(prefix) { return ATTRIBUTES.map((a) => a.key).filter((k) => { const cb = document.getElementById(prefix + '-' + k); return cb && cb.checked; }); }
function applyPreset(name) {
  const keys = PRESETS[name] || [];
  for (const a of ATTRIBUTES) { const cb = document.getElementById('request-' + a.key); if (cb) cb.checked = keys.includes(a.key); }
  requestMode = 'data';
  requestSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.request === 'data'));
  requestExtra.hidden = false;
  onConfigChange();
}
function currentAttrs() {
  return {
    requestedAttrs: requestMode === 'anon' ? [] : attrsChecked('request'),
    disclosedAttrs: discloseMode === 'anon' ? [] : attrsChecked('disclose'),
  };
}
// Re-render the setup checkboxes FROM the server's room config. Used after a rejected or
// narrowed config change: the server holds something different from what we sent, so the
// UI must stop showing the selection it did not get. Does not re-send anything.
function applyServerConfig(msg) {
  if (!setupBuilt || setupLocked) return;
  const apply = (prefix, list) => {
    const keys = Array.isArray(list) ? list : [];
    for (const a of ATTRIBUTES) { const cb = document.getElementById(prefix + '-' + a.key); if (cb) cb.checked = keys.includes(a.key); }
    return keys.length > 0;
  };
  const hasRequest = apply('request', msg.requestedAttrs);
  const hasDisclose = apply('disclose', msg.disclosedAttrs);
  requestMode = hasRequest ? 'data' : 'anon';
  discloseMode = hasDisclose ? 'data' : 'anon';
  requestSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.request === requestMode));
  discloseSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.disclose === discloseMode));
  requestExtra.hidden = requestMode === 'anon';
  discloseListEl.hidden = discloseMode === 'anon';
  updatePreview(msg.requestedAttrs, msg.disclosedAttrs);
  syncPresetChips();
}
// A selection of nothing but derived attributes is not a valid request — it would mean a
// wallet prompt that asks for no claim. The server treats it as a violation; rather than
// let the host hit that, keep the selection coherent the same way an empty selection
// already is (see setRequestMode/setDiscloseMode): tick the family name back on.
function ensureWalletAttr(prefix) {
  const checked = attrsChecked(prefix);
  const derived = derivedKeys();
  if (!checked.length || checked.some((k) => !derived.includes(k))) return;
  const cb = document.getElementById(prefix + '-family_name');
  if (cb) cb.checked = true;
}
function updatePreview(req, disc) {
  previewDisclose.textContent = disc && disc.length ? disc.map((k) => t(labelFor(k))).join(', ') : t('nichts (anonym)');
  previewRequest.textContent = req && req.length ? req.map((k) => t(labelFor(k))).join(', ') : t('nichts (anonym)');
}
// Presets are shortcuts, not state: highlight one only while the checked set matches it.
function syncPresetChips() {
  const key = (requestMode === 'anon' ? [] : attrsChecked('request')).sort().join(',');
  presetsEl.querySelectorAll('[data-preset]').forEach((btn) => {
    const set = [...(PRESETS[btn.dataset.preset] || [])].sort().join(',');
    btn.classList.toggle('active', !!key && key === set);
  });
}
function onConfigChange() {
  // Coherence first, so what we preview is what we send and what the server accepts. The
  // re-ticked checkbox IS the feedback — same as the existing empty-selection guards. A
  // status-bar message would be pointless: the set-config below triggers a status
  // broadcast that overwrites it within milliseconds.
  ensureWalletAttr('request');
  ensureWalletAttr('disclose');
  const { requestedAttrs, disclosedAttrs } = currentAttrs();
  updatePreview(requestedAttrs, disclosedAttrs);
  syncPresetChips();
  wsSend({ type: 'set-config', mode, requestedAttrs, disclosedAttrs, openRoom: openroomToggle.checked });
  refreshPlannedInvite(); // geplanter Anruf: Einladung traegt die Abrede → neu ausstellen
}
let setupLocked = false;
function lockSetup() {
  if (setupLocked) return; setupLocked = true;
  setupBox.querySelectorAll('input, .seg button, .presets button').forEach((el) => { el.disabled = true; });
  setupBox.querySelectorAll('.attr-row').forEach((r) => r.classList.add('locked'));
}

// ---- identity ----
/**
 * Who counts as the SAME person in a room. The identifier is tied to the room and lives in
 * localStorage — not per tab.
 *
 * Why no longer per tab: a tab is not a person. Someone who opens the appointment link in the
 * morning out of curiosity, forgets the tab and clicks again at the appointment time would
 * otherwise get a second identifier, occupy both seats themselves and lock their counterpart out
 * ("the room is full"). Tied to the room, the new tab takes over the existing seat instead — and
 * the old one is told about it (`session-taken-over`).
 *
 * Parallel calls in several tabs remain possible: different rooms, different keys.
 * For the one case where you DELIBERATELY want to be in the same room twice — two tabs as two
 * test participants — there is `?fresh=1`.
 */
function stableClientId(room) {
  const key = 'eudi_clientId_' + (room || 'adhoc');
  let store;
  try { store = localStorage; localStorage.getItem(key); }
  catch { store = sessionStorage; } // Safari im privaten Modus o. Ä.
  if (new URLSearchParams(location.search).get('fresh') === '1') {
    return (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  }
  let id = store.getItem(key);
  if (!id) { id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2); store.setItem(key, id); }
  return id;
}

const params = new URLSearchParams(location.search);
const soloMode = params.get('solo') === '1';

// ---- scheduled call: the invitation carries room, role and agreed scope -------------
// Why at all: rooms live only in the server's memory, so an appointment link carrying a bare room
// ID conveyed neither the role nor the agreed attributes — at appointment time the order of
// arrival decided who was host. See src/invite-token.ts.
// The payload is signed but NOT encrypted: here it is read purely for display. Only the check in
// the server is binding.
const inviteToken = params.get('inv');
function parseInviteCfg(tok) {
  try {
    const j = b64urlJson(tok.split('.')[0]);
    if (!j || typeof j.room !== 'string' || !j.room) return null;
    return {
      room: j.room,
      role: j.role === 'host' ? 'host' : 'guest',
      mode: j.m,
      request: Array.isArray(j.r) ? j.r : [],
      disclose: Array.isArray(j.d) ? j.d : [],
      nbf: j.nbf, exp: j.exp,
    };
  } catch { return null; }
}
const inviteCfg = inviteToken ? parseInviteCfg(inviteToken) : null;

let roomId = inviteCfg ? inviteCfg.room : params.get('room');
if (!roomId && !inviteToken) {
  roomId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  params.delete('new'); // entry flag from a start page's CTA — not part of the room URL
  params.set('room', roomId);
  // Keep the hash: in embed mode it carries the #cfg config (parsed further below) —
  // dropping it here silently discarded the embedder's configuration.
  history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash || ''}`);
}
/**
 * Staff token of a tenant instance (see src/staff-token.ts).
 *
 * Once invoked via `?staff=…` it stays in the browser — otherwise a staff member would have to
 * copy the link out of an email before every appointment. It is NOT left in the address bar: a
 * bearer token in the URL otherwise ends up in screenshots, in history and in shared links.
 */
const staffToken = (function () {
  const key = 'eudi_staff_token';
  let store = null;
  try { store = localStorage; localStorage.getItem(key); } catch { /* privater Modus */ }
  const ausUrl = params.get('staff');
  if (ausUrl) {
    try { if (store) store.setItem(key, ausUrl); } catch {}
    params.delete('staff');
    history.replaceState(null, '', `${location.pathname}${params.toString() ? '?' + params.toString() : ''}${location.hash || ''}`);
    return ausUrl;
  }
  try { return (store && store.getItem(key)) || null; } catch { return null; }
})();

// Only NOW, because the identifier is tied to the room (see stableClientId).
const clientId = stableClientId(roomId);

// Invite links must always point at the server, not at the app bundle's local origin.
function linkFor(query) {
  return API_BASE ? `${API_BASE}/?${query}` : `${location.origin}${location.pathname}?${query}`;
}
// In a scheduled call the room ID is NOT an invitation link (without a token the server refuses
// the join) — there the field is filled from the stored guest token, see applyPlannedLinks();
// without a stored token the card stays hidden.
if (roomId && !inviteCfg) shareInput.value = linkFor(`room=${roomId}`);

// ---- embed mode: config via URL hash, lifecycle events to the parent page ----
// Config is passed in the hash (#cfg=<base64url JSON>) so it never hits the server/logs.
// { mode, request:[attrKeys], disclose:[attrKeys], lock } — see the embed section in src/server.ts.
const isEmbedded = params.get('embed') === '1' || (() => { try { return window.self !== window.top; } catch { return true; } })();
function b64urlJson(b64) { return JSON.parse(decodeURIComponent(escape(atob(b64.replace(/-/g, '+').replace(/_/g, '/'))))); }
function parseEmbedCfg() {
  // Hardened mode: signed token in the query (?tok=). The server already verified its
  // integrity (a tampered token → 403, page never loads), so we trust the payload for
  // config. Compact keys: m=mode, r=request, d=disclose, l=lock.
  const tok = params.get('tok');
  if (tok) { try { const j = b64urlJson(tok.split('.')[0]); return { mode: j.m, request: j.r, disclose: j.d, lock: j.l }; } catch {} }
  // Open mode: config in the URL hash (#cfg=…).
  try {
    const m = (location.hash || '').match(/(?:^#|&)cfg=([^&]+)/);
    if (m) return b64urlJson(m[1]);
  } catch {}
  return null;
}
const embedCfg = isEmbedded ? parseEmbedCfg() : null;
if (isEmbedded) document.documentElement.classList.add('embedded');
if (embedCfg) {
  if (embedCfg.mode === 'video' || embedCfg.mode === 'audio' || embedCfg.mode === 'chat') mode = embedCfg.mode;
  if (Array.isArray(embedCfg.request)) requestMode = embedCfg.request.length ? 'data' : 'anon';
  // Embeds keep their previous semantics: no explicit disclose config → anonymous host
  // (the operator decides; the app-default 'data' applies only outside embeds).
  discloseMode = Array.isArray(embedCfg.disclose) && embedCfg.disclose.length ? 'data' : 'anon';
}
// The host opens the appointment through THEIR link: the guest token is not carried in it. If it
// was on this device when the invitation was issued, the guest link can be shared again.
if (inviteCfg && inviteCfg.role === 'host') {
  try {
    const g = localStorage.getItem('eudi_invite_' + inviteCfg.room);
    if (g) { plannedGuestUrl = linkFor('inv=' + encodeURIComponent(g)); shareInput.value = plannedGuestUrl; }
  } catch {}
}

// Scheduled call: adopt the mode and both directions from the invitation, so that preview and
// setup show the same thing the server holds.
if (inviteCfg) {
  if (inviteCfg.mode === 'video' || inviteCfg.mode === 'audio' || inviteCfg.mode === 'chat') mode = inviteCfg.mode;
  requestMode = inviteCfg.request.length ? 'data' : 'anon';
  discloseMode = inviteCfg.disclose.length ? 'data' : 'anon';
}

// Post a non-sensitive lifecycle event to the embedding page (never PID values).
let embedConnectedSent = false;
let embedVerifiedSent = false;
function postToParent(type, extra) {
  if (!isEmbedded) return;
  try { window.parent.postMessage(Object.assign({ source: 'trustcall', type }, extra || {}), '*'); } catch {}
}

copyBtn.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shareInput.value); } catch { shareInput.select(); document.execCommand('copy'); }
  copyLabel.textContent = t('Kopiert ✓');
  setTimeout(() => { copyLabel.textContent = t('Link kopieren'); }, 1500);
});

// ---- invite mode: now vs. scheduled -----------------------------------------
// One card, one action: the link row always applies; 'later' additionally opens the
// schedule fields and the extra share formats (.ics / Google / Wallet pass).
let inviteWhen = 'now';
function setInviteWhen(when) {
  const later = when === 'later';
  inviteWhen = later ? 'later' : 'now';
  if (scheduleBlock) scheduleBlock.hidden = !later;
  if (scheduleShare) scheduleShare.hidden = !later || !capOn('calendar-invite');
  if (shareHint) shareHint.textContent = !later
    ? t('Teile diesen Link mit der Person, die du anrufen möchtest.')
    : capOn('calendar-invite')
      ? t('Wähle den Termin und teile die Einladung — als Link, Kalendereintrag oder Wallet-Karte.')
      : t('Wähle den Termin und teile den Einladungs-Link — er gilt dann auch ohne geöffnetes Fenster.');
  if (inviteWhenSeg) inviteWhenSeg.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b.dataset.when === when);
  });
}
if (inviteWhenSeg) {
  inviteWhenSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-when]');
    if (!b) return;
    setInviteWhen(b.dataset.when);
    if (inviteWhen === 'later') refreshPlannedInvite();
    else resetPlannedLinks();
  });
}

// ---- scheduled call: issuing invitations (Community `planned-invites`) ----
//
// The appointment link has to work without an open tab, so the invitation carries the agreed
// scope itself (src/invite-token.ts). Two links are created for the same room:
//
//   guest link  -> is shared, joins as the guest and presents the agreed data
//   host link   -> your own access; belongs in the calendar and in the wallet card,
//                  but NOT in the sharing field: whoever opens it joins as the host
//
// Without the capability (no EUDI_INVITE_SECRET on the server) everything stays as before: a bare
// room link that only carries as long as this tab is open.
let plannedInvite = null;   // { key, room, hostToken, guestToken }
let plannedGuestUrl = null;
let plannedHostUrl = null;
let plannedPending = false;

function plannedConfigKey(range, c) {
  return JSON.stringify([mode, c.requestedAttrs, c.disclosedAttrs, range.start.toISOString(), range.end.toISOString()]);
}
function resetPlannedLinks() {
  plannedInvite = null; plannedGuestUrl = null; plannedHostUrl = null;
  if (roomId && !inviteCfg) shareInput.value = linkFor(`room=${roomId}`);
  if (hostLinkRow) hostLinkRow.hidden = true;
  if (hostLinkHint) hostLinkHint.hidden = true;
}
/**
 * Ensure there is an invitation matching BOTH the configuration and the appointment.
 * If either changes, a new one is issued — a token carrying a superseded agreement would be worse
 * than none: the appointment would then run with the old attributes.
 */
async function ensurePlannedInvite() {
  if (!capOn('planned-invites') || inviteWhen !== 'later' || inviteCfg) return null;
  const range = scheduledRange();
  if (!range) return null;
  const c = currentAttrs();
  const key = plannedConfigKey(range, c);
  if (plannedInvite && plannedInvite.key === key) return plannedInvite;
  try {
    const r = await fetch(apiUrl('invite'), {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' },
        staffToken ? { 'x-staff-token': staffToken } : {}),
      body: JSON.stringify({
        mode,
        requestedAttrs: c.requestedAttrs,
        disclosedAttrs: c.disclosedAttrs,
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j || !j.hostToken || !j.guestToken || !j.room) throw new Error('unerwartete Antwort');
    plannedInvite = { key, room: j.room, hostToken: j.hostToken, guestToken: j.guestToken };
    plannedGuestUrl = linkFor('inv=' + encodeURIComponent(j.guestToken));
    plannedHostUrl = linkFor('inv=' + encodeURIComponent(j.hostToken));
    // The host link carries only the host token. So that the guest link is not lost when the host
    // later opens the appointment through THEIR link, it stays on this device.
    try { localStorage.setItem('eudi_invite_' + j.room, j.guestToken); } catch {}
    shareInput.value = plannedGuestUrl;
    if (hostLinkRow && hostUrlInput) { hostUrlInput.value = plannedHostUrl; hostLinkRow.hidden = false; }
    if (hostLinkHint) hostLinkHint.hidden = false;
    return plannedInvite;
  } catch (e) {
    console.warn('[invite] konnte keine Einladung ausstellen:', e && e.message);
    return null;
  }
}
// Typing in the date/time field should not mint on every keystroke.
let plannedTimer = null;
function refreshPlannedInvite() {
  if (!capOn('planned-invites') || inviteWhen !== 'later' || inviteCfg) return;
  clearTimeout(plannedTimer);
  plannedTimer = setTimeout(() => { if (!plannedPending) { plannedPending = true; ensurePlannedInvite().finally(() => { plannedPending = false; }); } }, 350);
}

// ---- calendar invite (.ics download / Google Calendar) ----
const CAL_TITLE_FALLBACK = 'EUDI Verified Call';
function calTitleValue() { return calTitle.value.trim() || CAL_TITLE_FALLBACK; }
// Default the schedule to the next full quarter hour, today.
(function initSchedule() {
  const d = new Date(Date.now() + 15 * 60000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  calDate.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  calTime.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
})();

// A different appointment is a different invitation (the time window sits inside the token).
[calDate, calTime, calDuration].forEach((el) => {
  if (el) el.addEventListener('change', refreshPlannedInvite);
});
if (copyHostBtn) copyHostBtn.addEventListener('click', async () => {
  if (!hostUrlInput.value) return;
  try { await navigator.clipboard.writeText(hostUrlInput.value); }
  catch { hostUrlInput.select(); document.execCommand('copy'); }
  if (copyHostLabel) {
    copyHostLabel.textContent = t('Kopiert ✓');
    setTimeout(() => { copyHostLabel.textContent = t('Meinen Zugang kopieren'); }, 1500);
  }
});

// Returns { start: Date, end: Date } from the inputs, or null if incomplete/invalid.
function scheduledRange() {
  if (!calDate.value || !calTime.value) return null;
  const start = new Date(`${calDate.value}T${calTime.value}`);
  if (isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + (parseInt(calDuration.value, 10) || 30) * 60000);
  return { start, end };
}
// Format a Date as UTC basic form for iCalendar / Google Calendar: 20260703T140000Z
function toCalUTC(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
/**
 * Description for .ics and Google Calendar — plain text with real line breaks; the RFC 5545
 * escaping is done by the caller.
 *
 * The calendar entry is also the invitation: it gets forwarded. That is why the GUEST link comes
 * first under "to join" — it is the link recipients need. `hostLink` (set only when there is an
 * invitation) comes right at the end as a clearly separated block, because a forwarded host access
 * would swap the roles of the appointment: the guest token would occupy the callee seat and the
 * real guest could no longer get in. The line therefore says itself that it must be deleted before
 * forwarding — and it sits at the end, where that can be done in one stroke.
 */
function calDescription(guestLink, hostLink) {
  const lines = [
    t('Verifizierter Anruf per EUDI-Wallet.'),
    '',
    t('Zum Beitreten diesen Link öffnen:'),
    guestLink,
    '',
    t('Beide Seiten können sich vor dem Gespräch mit ihrer EUDI-Wallet (digitaler Personalausweis) ausweisen. Was geteilt wird, seht ihr vorher — und entscheidet selbst. Der Anruf läuft im Browser, Ende-zu-Ende verschlüsselt und direkt zwischen euren Geräten.'),
  ];
  if (hostLink) {
    lines.push(
      '',
      t('— Nur für dich als Gastgeber. Diese zwei Zeilen vor dem Weiterleiten löschen:'),
      hostLink,
    );
  }
  return lines.join('\n');
}
/**
 * Line folding per RFC 5545 §3.1: a content line should not exceed 75 octets, the remainder moves
 * into continuation lines beginning with a space. Counting is in UTF-8 octets — umlauts and "—"
 * are several — and the iteration runs over codepoints so that no character is cut in half.
 */
function foldIcsLine(line) {
  const enc = new TextEncoder();
  let out = '';
  let width = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (width + n > 75) { out += '\r\n '; width = 1; }
    out += ch;
    width += n;
  }
  return out;
}
function flashInvalid() {
  const target = !calDate.value ? calDate : calTime;
  target.focus();
  target.style.borderColor = 'var(--danger)';
  setTimeout(() => { target.style.borderColor = ''; }, 1200);
}

icsBtn.addEventListener('click', async () => {
  const range = scheduledRange();
  if (!range) { flashInvalid(); return; }
  const inv = await ensurePlannedInvite();
  // With an invitation shareInput carries the guest link, otherwise the bare room link.
  const guestLink = shareInput.value;
  const hostLink = inv ? plannedHostUrl : null;
  // Escape per RFC 5545: backslash, comma, semicolon, newline.
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');
  const uid = `${inv ? inv.room : roomId}@id-call-web`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EUDI Verified Call//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toCalUTC(new Date())}`,
    `DTSTART:${toCalUTC(range.start)}`,
    `DTEND:${toCalUTC(range.end)}`,
    `SUMMARY:${esc(calTitleValue())}`,
    `DESCRIPTION:${esc(calDescription(guestLink, hostLink))}`,
    // Location/URL is the calendar's one-click button — and the one field that is easily missed
    // when forwarding. As soon as there are two roles it therefore stays empty: the host access
    // must not travel along, and the guest link would put the host into their guest's seat.
    // Without an invitation the room link is the same for everyone — then the button may stay.
    ...(hostLink ? [] : [`URL:${esc(guestLink)}`, `LOCATION:${esc(guestLink)}`]),
    'END:VEVENT', 'END:VCALENDAR',
  ].map(foldIcsLine).join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const slug = calTitleValue().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'termin';
  a.href = url; a.download = `${slug}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Apple Wallet Termin-Pass (`wallet-pass`, server-side signed .pkpass). A plain
// navigation download: Safari/iOS offer "Zur Wallet hinzufügen" natively.
if (walletPassBtn) walletPassBtn.addEventListener('click', async () => {
  const range = scheduledRange();
  if (!range) { flashInvalid(); return; }
  const inv = await ensurePlannedInvite();
  const u = new URL(apiUrl('wallet-pass'), location.href);
  // The card belongs to the host — it carries their access, not the bare room ID (which alone
  // would be rejected at the appointment).
  if (inv) u.searchParams.set('inv', inv.hostToken);
  else u.searchParams.set('room', roomId);
  u.searchParams.set('title', calTitleValue());
  u.searchParams.set('start', range.start.toISOString());
  u.searchParams.set('end', range.end.toISOString());
  u.searchParams.set('lang', (typeof i18nLocale === 'string' && i18nLocale) || 'de');
  location.href = u.toString();
});

gcalBtn.addEventListener('click', async () => {
  const range = scheduledRange();
  if (!range) { flashInvalid(); return; }
  const inv = await ensurePlannedInvite();
  const guestLink = shareInput.value;
  const hostLink = inv ? plannedHostUrl : null;
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', calTitleValue());
  u.searchParams.set('dates', `${toCalUTC(range.start)}/${toCalUTC(range.end)}`);
  u.searchParams.set('details', calDescription(guestLink, hostLink));
  // No location as soon as there are two roles — see the reasoning at the .ics.
  if (!hostLink) u.searchParams.set('location', guestLink);
  window.open(u.toString(), '_blank', 'noopener');
});

// ---- native share (Web Share API; shown only where supported AND enabled) ----
// Visibility is controlled by applyCapabilities(); here we only wire the handler.
if (navigator.share) {
  shareBtn.addEventListener('click', async () => {
    await ensurePlannedInvite(); // geteilt wird der GAST-Link (steht dann in shareInput)
    const range = scheduledRange();
    let text = t('Verifizierter Anruf per EUDI-Wallet — hier beitreten:');
    if (range) {
      const when = range.start.toLocaleString(i18nLocale, { dateStyle: 'full', timeStyle: 'short' });
      text = t('{title} — {when} Uhr.', { title: calTitleValue(), when }) + '\n' + t('Verifizierter Anruf per EUDI-Wallet, hier beitreten:');
    }
    try {
      await navigator.share({ title: calTitleValue(), text, url: shareInput.value });
    } catch (e) { /* user cancelled or share failed — no-op */ }
  });
}

// ---- state ----
let ws;
let myRole = null;
let myPeerId = null;
let myName = '';
let selfVerified = false;
let callStarted = false;
let ended = false;
let isOpenRoom = false; // multi-guest room with late-join (server-driven)
let lastStatusMsg = null; // latest status: claims per peer feed the tile banderoles + chip rebuilds
let reconnectAttempts = 0;
let loopbackPeers = [];

function isHost() { return myRole === 'caller' && !soloMode; }
function wsSend(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

// ---- channel binding ----
// The DTLS fingerprint has to be fixed BEFORE the wallet request, otherwise it cannot be signed
// along with it. Normally it only comes into being with the SDP offer — so we bring the
// certificate forward: created once, held here, handed to the real connection later. See
// src/channel-binding.ts.
let localCert = null;          // RTCCertificate, wiederverwendet über Reconnects hinweg
let localFingerprint = null;   // 'AB:CD:…' (SHA-256, Großschreibung)

async function ensureLocalCertificate() {
  if (localFingerprint !== null || localCert) return;
  try {
    localCert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' });
    // Preferably straight from the certificate. Not available everywhere — then the detour via a
    // throwaway offer using the same certificate, which works without exception.
    let fp = null;
    if (typeof localCert.getFingerprints === 'function') {
      const hit = localCert.getFingerprints().find((f) => (f.algorithm || '').toLowerCase() === 'sha-256');
      if (hit && hit.value) fp = hit.value;
    }
    if (!fp) {
      const probe = new RTCPeerConnection({ certificates: [localCert] });
      probe.createDataChannel('probe');
      const offer = await probe.createOffer();
      probe.close();
      fp = sdpFingerprint256(offer);
    }
    localFingerprint = fp ? String(fp).toUpperCase() : null;
  } catch (e) {
    // No certificate, no binding — the call still runs, just unbound, and nothing claims
    // otherwise.
    console.warn('[channel-binding] Zertifikat konnte nicht erzeugt werden:', e && e.message);
    localCert = null; localFingerprint = null;
  }
}

/** Reads `a=fingerprint:sha-256` and nothing else. Deliberately stricter than sdpFingerprint()
 *  (which takes any algorithm for the SAS): only what is unambiguously SHA-256 may feed into a
 *  security guarantee — otherwise the binding could be defeated through a weaker algorithm. */
function sdpFingerprint256(desc) {
  const m = desc && desc.sdp && desc.sdp.match(/^a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)\s*$/im);
  return m ? m[1].toUpperCase() : null;
}

/** The counter-check on the client side: does the remote description actually received carry the
 *  fingerprint the other side's identity was bound to? Catches a server that substitutes a
 *  different SDP while passing it through. On a mismatch we abort — a connection whose far end is
 *  not the verified one is precisely what the whole verification is meant to prevent. */
function verifyPeerBinding(peerId) {
  const p = peers.get(peerId);
  const info = lastStatusMsg && (lastStatusMsg.peers || []).find((x) => x.peerId === peerId);
  if (!p || !info || !info.channelBound || !info.dtlsFingerprint) return true; // nichts zugesichert
  const actual = sdpFingerprint256(p.pc.remoteDescription);
  if (actual && actual !== String(info.dtlsFingerprint).toUpperCase()) {
    console.error('[channel-binding] Fingerprint der Gegenstelle weicht von der geprüften Identität ab');
    ended = true;
    teardownCall();
    showEnded('Sicherheitsprüfung fehlgeschlagen: Die Verbindung gehört nicht zur geprüften Identität. Der Anruf wurde abgebrochen.');
    return false;
  }
  return true;
}

/**
 * Reconnecting — with a growing interval and WITHOUT giving up.
 *
 * Before: 60 attempts at a fixed 1.5 s interval, 90 seconds in total, then the end. But for a
 * scheduled call, waiting is the normal case: someone who enters the room at 14:00 and waits until
 * 14:15 has a device that goes to sleep in between. On waking, the budget had long been spent, the
 * window showed a frozen picture from earlier — and because the preview never arrived, the host
 * could not consent. The call did not happen even though everything was ready server-side. As long
 * as the page is open we therefore no longer give up.
 */
const RECONNECT_MAX_MS = 20_000;
let reconnectTimer = null;
let linkDown = false;

function scheduleReconnect() {
  if (ended || reconnectTimer) return;
  // 1.5 · 3 · 6 · 12 · 20 · 20 … — fast enough for a network hiccup, frugal enough for the long
  // wait.
  const delay = Math.min(RECONNECT_MAX_MS, 1500 * Math.pow(2, Math.min(reconnectAttempts, 4)));
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

/**
 * Try immediately, without waiting for the running interval (device back, button pressed).
 * CONNECTING counts as "already running": a second socket alongside would not terminate the first,
 * and both would register for the same room. If the hanging attempt fails, its `close` restarts
 * the schedule anyway.
 */
function reconnectNow() {
  if (ended) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempts = 0;
  connect();
}

// Exactly the moments when a waiting device comes back. Without them the rebuild would only start
// after the next interval — and before that it did not happen at all.
window.addEventListener('online', reconnectNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectNow(); });

/**
 * The display is the more important part: a frozen window that does not say it is frozen looks
 * like a working one. A call failed on precisely that — both waited for the other, and one was
 * only looking at an old picture.
 */
function setLinkDown(down) {
  if (down === linkDown) return;
  linkDown = down;
  if (offlineBar) offlineBar.hidden = !down;
  document.body.classList.toggle('link-down', down);
  if (down && !callStarted) setStatus('Verbindung unterbrochen – neu verbinden …');
}
if (offlineRetryBtn) offlineRetryBtn.addEventListener('click', reconnectNow);

/**
 * Show the result of the network pre-flight — and ONLY when something is in the way. In the normal
 * case (a direct connection is possible) the interface stays unchanged; an all-clear nobody needs
 * is just noise.
 *
 * The message itself avoids jargon. "STUN", "TURN" and "candidate" do not help the person in front
 * of the screen — they belong in the collapsed detail line that can be passed to the IT
 * department.
 */
async function runNetworkCheck() {
  if (!netcheckBar || !window.EUDI_NETCHECK || isEmbedded) return;
  const res = await window.EUDI_NETCHECK.runNetCheck(iceServers);
  if (res.verdict === 'direct' || res.verdict === 'unknown') return;

  const blocked = res.verdict === 'blocked';
  netcheckBar.classList.toggle('is-blocked', blocked);
  netcheckMsg.textContent = blocked
    ? t('Dein Netzwerk scheint Anrufe zu blockieren. Ein Gespräch wird hier voraussichtlich nicht zustande kommen — versuche es über ein anderes Netz, etwa den Mobilfunk deines Telefons.')
    : t('Dein Netzwerk lässt keine direkte Verbindung zu. Der Anruf läuft dann über einen Umweg-Server — er funktioniert, kann aber etwas schwächer in Bild und Ton sein.');
  // For the IT department: what was found and WHERE access has to be opened. The addresses come
  // from the configuration actually in use — not from the app host, which may be an entirely
  // different machine, and not from hard-wired ports, which drift apart.
  const relayHosts = [...new Set(iceServers
    .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
    .filter((u) => /^turns?:/.test(String(u)))
    .map((u) => String(u).replace(/^turns?:/, '').split('?')[0]))];
  netcheckTech.textContent = t('Gefunden: {types}. {relay}Freigegeben sein muss ausgehend: {hosts} sowie der UDP-Bereich für die Medien (Standard 49160–49300).', {
    types: res.types.join(', ') || '—',
    relay: res.relayVia.length ? t('Relais erreichbar über {via}. ', { via: res.relayVia.join(', ') }) : '',
    hosts: relayHosts.join(', ') || '—',
  });
  netcheckBar.hidden = false;
}

/** Joining — both when the connection is established AND when a scheduled appointment opens on an
 *  already-open socket (see enterWhenOpen). */
async function sendJoin() {
  await ensureLocalCertificate();
  wsSend({ type: 'join', roomId, clientId, wantAuth: soloMode, dtlsFingerprint: localFingerprint || undefined, inv: inviteToken || undefined });
}

function connect() {
  // Pin this to THIS socket: a displaced predecessor often reports its `close` only later. Without
  // the check it would then declare the fresh socket dead and start a second schedule — two chains
  // reconnecting each other.
  const sock = new WebSocket(wsUrl());
  ws = sock;
  sock.onopen = async () => {
    if (ws !== sock) return;
    reconnectAttempts = 0;
    setLinkDown(false);
    if (!callStarted) setStatus('Verbunden – Raum wird betreten …');
    await sendJoin();
  };
  sock.onclose = () => {
    if (ended || ws !== sock) return;
    setLinkDown(true);
    scheduleReconnect();
  };
  sock.onerror = () => {};
  sock.onmessage = (ev) => { if (ws !== sock) return; let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
}

function handle(msg) {
  switch (msg.type) {
    case 'joined':
      myRole = msg.role;
      myPeerId = msg.peerId || myPeerId;
      if (myRole === 'callee') { setupBox.hidden = true; shareBox.hidden = true; }
      postToParent('joined', { role: msg.role });
      break;
    case 'room-full':
      setStatus('Dieser Raum ist bereits voll.');
      setupBox.hidden = true; shareBox.hidden = true; authBox.hidden = true;
      restartLabel.textContent = t('Neuen Raum starten'); restartBtn.hidden = false;
      break;
    // Someone is already active in the room with THIS link. That is different from "full": a new
    // room does not help here — the question is whether the link is being used twice.
    case 'link-in-use':
      setStatus('Dieser Einladungslink wird gerade schon benutzt. Falls du selbst noch ein anderes Fenster offen hast, schließe es und lade diese Seite neu.');
      setupBox.hidden = true; shareBox.hidden = true; authBox.hidden = true;
      break;
    // Taken over in another tab or window. Reconnecting MUST end here — otherwise both sides
    // reclaim the seat from each other every second.
    case 'session-taken-over':
      ended = true;
      teardownCall();
      showEnded('Dieser Anruf wurde in einem anderen Fenster geöffnet. Dort geht es weiter — dieses Fenster kannst du schließen.');
      break;
    // Sign-in refused: this person is not on the instance's allowlist. Deliberately an ending
    // rather than an error inside a running flow — the server has removed the participant from
    // the room, so there would be no "try again" to offer.
    case 'host-denied':
      ended = true;
      teardownCall();
      showEnded('Diese Kennung ist hier nicht freigeschaltet. Nur berechtigte Personen können auf dieser Seite einen Anruf führen — wende dich an die zuständige Stelle, wenn das ein Irrtum ist.');
      restartBtn.hidden = true; // ein neuer Raum hülfe nicht, die Sperre gilt für die Instanz
      break;
    case 'invite-invalid': showInviteProblem(msg.reason, msg.opensAt, msg.startsAt); break;
    case 'auth': showAuth(msg); break;
    case 'auth-failed': setStatus('Bestätigung fehlgeschlagen – bitte erneut scannen.'); break;
    case 'status': renderStatus(msg); break;
    case 'ready': startCall(msg); break;
    case 'declined': onDeclined(); break;
    case 'offer': onRemoteOffer(msg.from, msg.data); break;
    case 'answer': onRemoteAnswer(msg.from, msg.data); break;
    case 'ice': onRemoteIce(msg.from, msg.data); break;
    case 'peer-left': onPeerGone(msg.from); break;
    case 'hangup': onPeerGone(msg.from); break;
    // in-call credential requests (Pro) — see the section further below
    case 'credential-pending':
      pendingCredRequests.set(msg.requestId, { to: msg.to, credentialId: msg.credentialId, label: msg.label });
      addChat('System', '🪪 ' + t('Nachweis angefordert:') + ' ' + msg.label + ' …');
      break;
    case 'credential-requested': showCredPrompt(msg); break;
    case 'credential-auth': showCredAuth(msg); break;
    case 'credential-presented':
      credRequestOver(msg, peerName(msg.from) + ' — ' + msg.label + ' ' + t('geteilt ✓'));
      break;
    case 'credential-presented-ack':
      credRequestOver(msg, t('Du hast einen Nachweis geteilt:') + ' ' + msg.label + ' ✓');
      break;
    case 'credential-declined': credRequestOver(msg, t('Nachweis-Anfrage abgelehnt:') + ' ' + msg.label); break;
    case 'credential-cancelled': credRequestOver(msg, t('Nachweis-Anfrage zurückgezogen:') + ' ' + msg.label); break;
    case 'credential-expired': credRequestOver(msg, t('Nachweis-Anfrage abgelaufen:') + ' ' + msg.label); break;
    case 'credential-failed': credRequestOver(msg, t('Nachweis konnte nicht geprüft werden:') + ' ' + msg.label); break;
    case 'credential-error': addChat('System', '🪪 ' + t('Nachweis-Anfrage nicht möglich.')); break;
    // The server refused an out-of-scope attribute request (WRP whitelist, strict mode).
    // The room config is UNCHANGED, so re-render the setup from the last accepted state
    // rather than leaving the checkboxes showing something that was never applied.
    case 'error':
      if (msg.code === 'policy_violation') {
        const rejected = Array.isArray(msg.rejected) ? msg.rejected : [];
        // Name withdrawn attributes explicitly: "no longer exists" is different information from
        // "does not exist" — the former explains why a previously valid link or an older client
        // is now refused. The list comes from /capabilities.
        const retiredList = (wrpPolicy && Array.isArray(wrpPolicy.retiredAttributes)) ? wrpPolicy.retiredAttributes : [];
        const retired = rejected.filter((k) => retiredList.includes(k));
        const reason = retired.length === rejected.length && retired.length
          ? t('mit der eIDAS-2.0-Zweckbindung entfernt und nicht mehr abfragbar.')
          : t('diese Instanz fragt nur datensparsame Basis-Attribute ab.');
        setStatus(t('Nicht zugelassen:') + ' ' + rejected.join(', ') + ' — ' + reason);
        if (lastStatusMsg) applyServerConfig(lastStatusMsg);
        break;
      }
      setStatus(t('Fehler:') + ' ' + msg.message);
      break;
  }
}

function showAuth(msg) {
  // The server only sends 'auth' when this participant must present something, so
  // always render it (don't gate on a possibly-stale selfVerified flag).
  if (callStarted) return;
  qrContainer.innerHTML = '';
  // A freshly arrived offer makes the renew button usable again.
  if (authRenewBtn) authRenewBtn.disabled = false;
  const qrData = msg.crossDeviceUri || msg.uri;
  // eslint-disable-next-line no-undef
  new QRCode(qrContainer, { text: qrData, width: 232, height: 232, correctLevel: QRCode.CorrectLevel.M });
  authLink.href = msg.uri || qrData;
}

function renderAuthCard(role, attrs, opts) {
  // Sign-in rather than disclosure: on an instance with a host gate this is the proof THAT you
  // may host — not the choice of WHAT you share. The label has to say so, otherwise people look
  // for a selection that does not exist.
  if (opts && opts.login) {
    authTitle.textContent = t('Anmelden mit deiner EUDI-Wallet');
    authHint.innerHTML = t('Nur freigeschaltete Personen können hier einen Anruf führen. Weise dich aus — diese Angaben werden geprüft:');
    renderConsent(attrs);
    return;
  }
  if (role === 'caller') {
    authTitle.textContent = t('Eigene Daten freigeben');
    authHint.innerHTML = t('Scanne mit deiner <strong>EUDI-Wallet</strong>, um diese Angaben zu teilen:');
  } else {
    authTitle.textContent = t('Identität bestätigen');
    authHint.innerHTML = t('Du gibst <strong>nur diese Angaben</strong> aus deinem Personalausweis frei — sonst nichts:');
  }
  renderConsent(attrs);
}

function roleLabelFor(role) { return role === 'caller' ? t('Gastgeber:in') : t('Gast'); }

// ---- progress stepper (role-aware; hidden in solo/embed) ----
// Host flow: set up & invite → everyone identifies & confirms → connected.
// Guest flow: identify → confirm → connected. Rendered from renderStatus/revealCall.
const stepperEl = $('stepper');
const STEPS_HOST = ['Einrichten & einladen', 'Ausweisen & bestätigen', 'Verbunden'];
const STEPS_GUEST = ['Ausweisen', 'Bestätigen', 'Verbunden'];
function updateStepper(active) {
  if (!stepperEl || soloMode || isEmbedded) return;
  const labels = myRole === 'callee' ? STEPS_GUEST : STEPS_HOST;
  stepperEl.innerHTML = '';
  labels.forEach((label, i) => {
    const li = document.createElement('li');
    li.className = i < active ? 'done' : i === active ? 'active' : '';
    // The last step is a destination, not a stop along the way: whoever is there has arrived.
    // Hence a tick there too instead of the number — otherwise "3 Connected" reads like an open
    // item even though the connection has long been up.
    const done = i < active || (i === active && i === labels.length - 1);
    const no = document.createElement('span'); no.className = 'step-dot'; no.textContent = done ? '✓' : String(i + 1);
    const tx = document.createElement('span'); tx.textContent = t(label);
    li.append(no, tx);
    stepperEl.appendChild(li);
  });
  stepperEl.hidden = false;
}

function updateChips(msg) {
  // self — names are masked until all confirm, so verified shows "bestätigt ✓"
  const hostDiscloses = isHost() && msg.disclosedAttrs && msg.disclosedAttrs.length;
  if (msg.self.name) { selfChip.className = 'id-chip verified'; selfLabel.textContent = `${t('Du')}: ${titleCase(msg.self.name)} ✓`; }
  else if (hostDiscloses && msg.self.verified) { selfChip.className = 'id-chip verified'; selfLabel.textContent = t('Du: bestätigt ✓'); }
  // A host who WANTS to share data but is not yet identified: show their STATE, not their role.
  // This used to read "You: Host" — which made your own open task the only participant state
  // missing from the chip row, while the counterpart next to it already showed "Guest: confirmed
  // ✓". From that it is not apparent that you still have to scan; that is exactly how a call
  // appears to have "got stuck".
  else if (hostDiscloses) { selfChip.className = 'id-chip pending'; selfLabel.textContent = t('Du: noch nicht ausgewiesen'); }
  // Anonymous host: "Host" is right here — there is nothing to do.
  else if (isHost()) { selfChip.className = 'id-chip host'; selfLabel.textContent = t('Du: Gastgeber:in'); }
  else if (msg.self.verified) { selfChip.className = 'id-chip verified'; selfLabel.textContent = t('Du: bestätigt ✓'); }
  // A guest who still has to present — the same open task as for the host above.
  // `pending` makes the chip pulse (see style.css): "it's your turn" should not only be readable
  // but visible. Only these two branches pulse; an anonymous host or a finished participant has
  // nothing to do and stays calm.
  else { selfChip.className = 'id-chip pending'; selfLabel.textContent = t('Du: noch nicht bestätigt'); }
  selfChip.classList.add('you'); // color code: self = blue, everyone else = green
  if (handRaised) selfLabel.textContent += ' ✋';

  // one chip per peer (rebuilt each status)
  const list = msg.peers || [];
  peerChipsEl.innerHTML = '';
  if (!list.length) {
    const chip = document.createElement('div'); chip.className = 'id-chip';
    chip.innerHTML = '<span class="dot"></span>';
    const s = document.createElement('span'); s.textContent = `${roleLabelFor(myRole === 'caller' ? 'callee' : 'caller')}: ${t('wartet …')}`;
    chip.appendChild(s); peerChipsEl.appendChild(chip);
    return;
  }
  for (const peer of list) {
    const chip = document.createElement('div'); chip.className = 'id-chip';
    chip.innerHTML = '<span class="dot"></span>';
    const s = document.createElement('span');
    const role = roleLabelFor(peer.role);
    if (peer.name) { chip.className = 'id-chip verified'; s.textContent = `${role}: ${titleCase(peer.name)} ✓`; }
    else if (peer.role === 'caller') { chip.className = 'id-chip host'; s.textContent = peer.verified ? `${role}: ${t('bestätigt ✓')}` : `${role}: ${t('Bestätigung ausstehend')}`; }
    else if (peer.verified) { chip.className = 'id-chip verified'; s.textContent = `${role}: ${t('bestätigt ✓')}`; }
    else { s.textContent = `${role}: ${t('Bestätigung ausstehend')}`; }
    if (peer.peerId && handsUp.has(peer.peerId)) s.textContent += ' ✋';
    chip.classList.add('guest');
    chip.appendChild(s); peerChipsEl.appendChild(chip);
  }
}

function selfAttrs(msg) { return myRole === 'caller' ? msg.disclosedAttrs : msg.requestedAttrs; }
function peerAttrsOf(msg) { return myRole === 'caller' ? msg.requestedAttrs : msg.disclosedAttrs; }

// What a given peer shares depends on their role (host discloses, guests present requested).
function attrsForPeer(msg, peer) { return peer.role === 'caller' ? msg.disclosedAttrs : msg.requestedAttrs; }

// Pre-confirm: field names only (no values available yet).
function renderReview(msg) {
  renderFieldList(reviewSelf, selfAttrs(msg), 'Du teilst nichts (anonym).');
  const peers = msg.peers || [];
  if (peers.length <= 1) {
    renderFieldList(reviewPeer, peers[0] ? attrsForPeer(msg, peers[0]) : [], 'Dein Gegenüber bleibt anonym.');
  } else {
    // No names here: before consent only WHICH fields will be shared is shown, never a value.
    renderPeerBlocks(reviewPeer, peers, (el, peer) => renderFieldList(el, attrsForPeer(msg, peer), 'bleibt anonym.'), false);
  }
  reviewModeEl.textContent = modeLabel(msg.mode);
}

// The "Geprüfte Angaben" card is collapsible: in a VIDEO call the same data lives on the
// tiles (click a name badge → banderole), so the card starts collapsed; in chat/audio
// there are no tiles, so it stays open. The toggle lets the user override either way.
const resultToggle = $('result-toggle');
const resultToggleLabel = $('result-toggle-label');
let resultCollapseInit = false;
function setResultCollapsed(c) {
  resultBox.classList.toggle('collapsed', c);
  resultToggle.setAttribute('aria-expanded', String(!c));
  resultToggleLabel.textContent = c ? t('Anzeigen') : t('Ausblenden');
}
resultToggle.addEventListener('click', () => setResultCollapsed(!resultBox.classList.contains('collapsed')));

// Post-confirm (msg.revealed): the actual values, now sent by the server.
function renderResult(msg) {
  if (!resultCollapseInit) { resultCollapseInit = true; resultToggle.hidden = false; setResultCollapsed((msg.mode || mode) === 'video'); }
  renderResultInto(resultSelf, msg.self.claims, selfAttrs(msg), 'Du teilst nichts (anonym).');
  appendSharedCredentialRows(resultSelf, msg.self.sharedCredentials);
  const peers = msg.peers || [];
  if (peers.length <= 1) {
    renderResultInto(resultPeer, peers[0] && peers[0].claims, peers[0] ? attrsForPeer(msg, peers[0]) : [], 'Dein Gegenüber bleibt anonym.');
    if (peers[0]) appendCredentialRows(resultPeer, peers[0].credentials);
  } else {
    renderPeerBlocks(resultPeer, peers, (el, peer) => {
      renderResultInto(el, peer.claims, attrsForPeer(msg, peer), 'bleibt anonym.');
      appendCredentialRows(el, peer.credentials);
    }, true);
  }
}

// For >1 peer: a labelled sub-block per peer inside the given column.
//
// `withNames` is a safety catch, not a style option: the PRE-CONNECT review must never put a
// name in the heading, whatever the server happens to send. It once did — in an open room the
// server disclosed names and claims to someone who had not yet confirmed, and the heading was
// where that became visible. The server gate is fixed (see showValues in src/server.ts); this
// makes the review screen incapable of showing a value even if a future gate leaks again.
function renderPeerBlocks(container, peers, renderInto, withNames) {
  container.innerHTML = '';
  for (const peer of peers) {
    const head = document.createElement('div'); head.className = 'peer-block-head';
    head.textContent = (withNames && peer.name ? titleCase(peer.name) : roleLabelFor(peer.role));
    const inner = document.createElement('div');
    container.append(head, inner);
    renderInto(inner, peer);
  }
}

function renderStatus(msg) {
  lastStatusMsg = msg;
  selfVerified = msg.self.verified;
  if (msg.self.name) myName = msg.self.name;
  myRole = msg.self.role || myRole;
  mode = msg.mode || mode;

  // --- internal Solo-Demo (?solo=1) ---
  if (soloMode) {
    selfChip.classList.toggle('verified', msg.self.verified);
    selfLabel.textContent = msg.self.verified ? `${t('Du')}: ${titleCase(msg.self.name) || t('verifiziert')} ✓` : t('Du: nicht verifiziert');
    if (msg.self.verified) { authBox.hidden = true; setLocalLabel(titleCase(msg.self.name)); startLoopback(titleCase(msg.self.name)); }
    else setStatus('Solo-Demo: bitte mit der Wallet ausweisen.');
    return;
  }

  if (callStarted) { updateChips(msg); updateStepper(2); if (msg.revealed) { renderResult(msg); resultBox.hidden = false; } updateCredBadges(msg); return; }

  const peerList = msg.peers || [];
  const peerPresent = peerList.length > 0;
  isOpenRoom = !!msg.openRoom;
  // Gate on EVERYONE present: all verified / all confirmed (self + all peers).
  const allVerified = msg.self.verified && peerPresent && peerList.every((p) => p.verified);
  const allConfirmed = msg.self.confirmed && peerPresent && peerList.every((p) => p.confirmed);
  // Multi-party: the review only opens once the host started (server sets reviewOpen).
  const reviewOpen = msg.reviewOpen !== false; // 1:1 (undefined) → always open
  updateChips(msg);
  // Reset before the phase branches take effect — renderStatus returns early in several places,
  // so no highlight from an earlier phase is left standing.
  setActiveCard(null);
  // Progress: connected > identify/confirm > set up & invite (host) / identify (guest).
  updateStepper(msg.revealed && (!isOpenRoom || msg.self.confirmed) ? 2
    : isHost() ? (peerPresent ? 1 : 0)
    : (msg.self.verified ? 1 : 0));

  // ---- PHASE: revealed → values become visible, call connects ----
  // `msg.revealed` is a ROOM flag (≥2 confirmed). In an open room a late-joiner who has
  // not yet confirmed must still run their OWN verify→review→confirm first, so don't sweep
  // them into the connected view until they've confirmed themselves.
  if (msg.revealed && (!isOpenRoom || msg.self.confirmed)) {
    setupBox.hidden = true; shareBox.hidden = true; authBox.hidden = true; reviewBox.hidden = true; startBar.hidden = true;
    renderResult(msg);
    resultBox.hidden = false;
    setStatus(isOpenRoom ? 'Verbunden ✓ — weitere Gäste können jederzeit beitreten.' : 'Alle haben zugestimmt ✓ — Verbindung wird aufgebaut …');
    if (!embedVerifiedSent) { embedVerifiedSent = true; postToParent('verified', { self: !!msg.self.verified }); }
    return;
  }
  resultBox.hidden = true;

  // ---- PHASE (gathered multi-party only, >2 present): host waits for everyone, then
  // starts. A plain host+1-guest call skips this — waiting for an explicit start would
  // just be friction — and falls through to the normal review below, same as 1:1.
  startBar.hidden = true;
  if (msg.multiParty && !isOpenRoom && !msg.starting && peerList.length > 1) {
    reviewBox.hidden = true;
    if (!isHost() && msg.self.verified) {
      setupBox.hidden = true; shareBox.hidden = true; authBox.hidden = true;
      setStatus('Bestätigt ✓ – warte, bis der Gastgeber den Anruf startet …');
      return;
    }
    if (isHost() && allVerified) {
      startBar.hidden = false;
      startBtnLabel.textContent = t('Anruf starten') + ` (${peerList.length + 1})`;
      startHint.textContent = t('Warte, bis alle beigetreten sind — dann starte den Anruf.');
    }
  }

  // ---- PHASE: pre-connect review ----
  // Open room: each person reviews + confirms independently (same attribute policy for all,
  // so late-join adds no new consent surface). Otherwise: gated on ALL present.
  // Show the review as long as YOU have not confirmed; after that the waiting branch takes over
  // (self.confirmed && !allConfirmed) — otherwise the button would spring back after the click.
  const wantReview = isOpenRoom ? (msg.self.verified && !msg.self.confirmed) : (reviewOpen && allVerified && !msg.self.confirmed);
  if (wantReview) {
    setupBox.hidden = true; authBox.hidden = true; startBar.hidden = true;
    // In an OPEN room the host keeps the invitation link — that is the whole point of the room:
    // people join over time. Hiding it here left the host with no way to invite anyone else the
    // moment they had verified themselves, and the link is not recoverable from the review
    // screen. Same rule as the waiting branch a few lines below.
    shareBox.hidden = !(isOpenRoom && isHost());
    renderReview(msg);
    reviewBox.hidden = false;
    reviewWait.hidden = true; setConfirmWaiting(false);
    setStatus('Prüfe, was geteilt wird, und bestätige zum Verbinden.');
    return;
  }
  reviewBox.hidden = true;

  // Open room: confirmed but fewer than 2 present → wait (host keeps the invite link visible).
  if (isOpenRoom && msg.self.confirmed && !msg.revealed) {
    setupBox.hidden = true; authBox.hidden = true; startBar.hidden = true;
    shareBox.hidden = !isHost();
    setStatus('Bestätigt ✓ – warte auf weitere Teilnehmer …');
    return;
  }
  // Non-open: confirmed, waiting for the others to confirm.
  if (!isOpenRoom && reviewOpen && allVerified && msg.self.confirmed && !allConfirmed) {
    setupBox.hidden = true; shareBox.hidden = true; authBox.hidden = true; startBar.hidden = true;
    renderReview(msg); reviewBox.hidden = false;
    reviewWait.hidden = true; setConfirmWaiting(true);
    setStatus('Du hast bestätigt — wartet auf die anderen …');
    return;
  }

  // ---- PHASE: sign-in (tenant instance with a host gate only) ----
  //
  // Before everything else, and deliberately WITHOUT a setup form: on such an instance,
  // identifying yourself is not a choice about what the guest sees, but the question of whether
  // you may host at all. An interface showing checkboxes to deselect here promises a freedom that
  // does not exist — and anyone choosing "anonymous" is refused without learning why.
  //
  // Guests are never affected: they arrive via an invitation link and are `callee`.
  if (hostLoginRequired && isHost() && !msg.self.verified) {
    setupBox.hidden = true;
    shareBox.hidden = true;
    reviewBox.hidden = true;
    startBar.hidden = true;
    renderAuthCard('caller', msg.disclosedAttrs, { login: true });
    authBox.hidden = false;
    setActiveCard(authBox);
    setStatus('Melde dich mit deiner EUDI-Wallet an, um einen Anruf zu führen.');
    return;
  }

  // ---- PHASE: setup / scan ----
  const someoneUnverified = peerPresent && peerList.some((p) => !p.verified);
  if (isHost()) {
    buildSetup();
    setupBox.hidden = false;
    if (peerPresent || msg.configPinned) lockSetup();
    // Scheduled call: the invitation was sent long ago, and appointment fields do not belong in a
    // call that already IS one. The card only stays if this device still has the guest link —
    // then the host can send it again.
    if (msg.configPinned) {
      if (inviteWhenSeg) inviteWhenSeg.hidden = true;
      if (scheduleBlock) scheduleBlock.hidden = true;
      if (scheduleShare) scheduleShare.hidden = true;
      if (hostLinkRow) hostLinkRow.hidden = true;
      if (hostLinkHint) hostLinkHint.hidden = true;
      if (shareHint) shareHint.textContent = t('Das ist der Link, den du für diesen Termin geteilt hast.');
    }
    shareBox.hidden = !!msg.configPinned && !plannedGuestUrl;
    // host disclosure scan?
    const hostMustScan = !msg.self.verified && msg.disclosedAttrs.length > 0;
    if (hostMustScan) { renderAuthCard('caller', msg.disclosedAttrs); authBox.hidden = false; }
    else authBox.hidden = true;

    // What is the host's next task? Identifying comes before inviting; if everyone is present and
    // you are done yourself, there is nothing to press -> highlight no card.
    setActiveCard(hostMustScan ? authBox : (!peerPresent && !shareBox.hidden) ? shareBox : null);

    if (!msg.self.verified) setStatus('Weise dich aus, um deine gewählten Daten zu teilen.');
    else if (!peerPresent) setStatus(msg.configPinned ? 'Geplanter Anruf — warte auf deinen Gast …' : 'Richte den Anruf ein und teile den Einladungs-Link.');
    else if (someoneUnverified) setStatus('Warte auf die Bestätigung deiner Gäste …');
    else setStatus('Gleich geschafft …');
  } else {
    setupBox.hidden = true; shareBox.hidden = true;
    if (!msg.self.verified && msg.requestedAttrs.length) { renderAuthCard('callee', msg.requestedAttrs); authBox.hidden = false; }
    else authBox.hidden = true;
    // For the guest the identification card is the only one — highlight it, but dim nothing.
    setActiveCard(authBox.hidden ? null : authBox);

    if (!msg.self.verified) setStatus('Du wurdest eingeladen – weise dich mit deiner EUDI-Wallet aus.');
    else if (!allVerified) setStatus('Bestätigt ✓ – warte auf die anderen …');
    else setStatus('Gleich geschafft …');
  }
}

/**
 * Desktop: exactly ONE card is the one you are on right now.
 *
 * The stepper at the top promises an order ("set up & invite -> identify & confirm -> connected"),
 * but on desktop the body showed all three cards as equals — setting up, inviting and identifying
 * at once. As a result the eye falls on the largest box (setup) instead of on the open task
 * (scan the QR code).
 *
 * Deliberately NOT the phone's wizard: desktop has the space, and the invitation link is not a
 * station but a reference the host wants to keep in view. So leave everything visible and only
 * steer attention. On small screens and in the app the step wizard already does this — the CSS
 * rules hang off `body:not(.wizard)`, so the two never overlap.
 */
function setActiveCard(el) {
  for (const c of [setupBox, shareBox, authBox]) {
    if (!c) continue;
    c.classList.toggle('is-active', !!el && c === el);
    // Dim visible cards only, and only when there is an active one at all: when there is nothing
    // to do (everyone present, you are finished), nothing should be dimmed either.
    c.classList.toggle('is-muted', !!el && c !== el && !c.hidden);
  }
}

// ---- review actions ----
// The connect button carries the waiting state itself: after the click, "waiting for confirmation".
const CONFIRM_LABEL = 'Verbinden ✓', CONFIRM_WAIT = 'Warte auf Bestätigung …';
function setConfirmWaiting(w) {
  confirmBtn.classList.toggle('waiting', w);
  confirmBtn.disabled = w; declineBtn.disabled = w;
  confirmBtn.textContent = t(w ? CONFIRM_WAIT : CONFIRM_LABEL);
}
startBtn.addEventListener('click', () => { startBtn.disabled = true; wsSend({ type: 'start-call' }); });
confirmBtn.addEventListener('click', () => { wsSend({ type: 'confirm' }); reviewWait.hidden = true; setConfirmWaiting(true); });
declineBtn.addEventListener('click', () => { wsSend({ type: 'decline' }); ended = true; teardownCall(); showEnded('Du hast abgelehnt. Es wird keine Verbindung aufgebaut.'); });
function onDeclined() { if (ended) return; ended = true; teardownCall(); showEnded('Das Gegenüber hat abgelehnt. Es wird keine Verbindung aufgebaut.'); }

// ---- WebRTC (full mesh: one RTCPeerConnection per peer) ----
// peerId -> { pc, dc, pendingIce, remoteDescSet, initiator, name, role, video, tile }
const peers = new Map();
// ICE candidates that arrive BEFORE their peer's RTCPeerConnection exists (peerId → []).
// This happens when the offerer gathers+sends candidates while the answerer is still in
// its getUserMedia permission prompt (peer not yet created). Without buffering, those
// candidates are lost and ICE fails until a later iceRestart re-sends them — the exact
// "video/chat only connects once a 3rd person joins" bug in open rooms. Drained in getPeer.
const earlyIce = new Map();
let localStream = null;
let callConnectedOnce = false; // set once ≥1 peer is connected → later peers are late-joiners

// Screen sharing (video mode): swap the outgoing camera track for a display track via
// sender.replaceTrack across ALL peer connections — same m-line, no renegotiation.
let screenStream = null;
let cameraTrack = null;

async function ensureMedia() {
  if (localStream !== null) return localStream;
  if (mode === 'chat') { localStream = false; return false; }
  try {
    localStream = await navigator.mediaDevices.getUserMedia(mode === 'audio' ? { audio: true, video: false } : { audio: true, video: true });
    if (mode === 'video') localVideo.srcObject = localStream;
  } catch (e) { console.warn('getUserMedia failed:', e && e.message); localStream = false; }
  return localStream;
}
function localTracks() { return localStream && localStream.getTracks ? localStream.getTracks() : []; }

// Create/find the per-peer connection. `meta` = { name, role, initiator }.
function getPeer(peerId, meta) {
  let p = peers.get(peerId);
  if (p) { if (meta) Object.assign(p, { name: meta.name ?? p.name, role: meta.role ?? p.role, initiator: meta.initiator ?? p.initiator }); return p; }
  // The pre-generated certificate MUST go in here — otherwise the browser would mint a new key,
  // and the fingerprint the wallet co-signed would be worthless.
  const pc = new RTCPeerConnection(localCert ? { iceServers, certificates: [localCert] } : { iceServers });
  p = { pc, dc: null, pendingIce: [], remoteDescSet: false, initiator: !!(meta && meta.initiator), name: meta && meta.name, role: meta && meta.role, video: null, tile: null };
  peers.set(peerId, p);
  // Adopt any candidates that arrived before this peer existed (offerer was faster than
  // our media-permission prompt). They wait in pendingIce until the remote desc is set.
  const early = earlyIce.get(peerId);
  if (early) { p.pendingIce.push(...early); earlyIce.delete(peerId); }
  // A new peer appearing after the call is already running = a late-joiner (open room).
  if (callConnectedOnce) addChat('System', (meta && meta.name ? titleCase(meta.name) : t('Ein Teilnehmer')) + ' ' + t('ist dem Anruf beigetreten.'));
  // DataChannels arrive in-band and are routed by LABEL: 'chat' (default) drives the
  // chat/file/control plane; 'qes' belongs to the in-call document ceremony (created on
  // demand by either side — see public/qes/). Registered for BOTH offerer and answerer,
  // since a 'qes' channel may be opened by the remote side regardless of who offered.
  pc.ondatachannel = (e) => {
    if (e.channel.label === 'qes') { qesAdoptChannel(peerId, e.channel); return; }
    p.dc = e.channel; wireChat(p.dc, peerId);
  };
  pc.onicecandidate = (e) => { if (e.candidate) wsSend({ type: 'ice', to: peerId, data: e.candidate }); };
  pc.ontrack = (e) => attachRemote(peerId, e.streams[0]);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') { revealCall(); updateSas(); }
    else if (pc.connectionState === 'failed') setStatus('Verbindung zu einem Teilnehmer fehlgeschlagen (evtl. TURN nötig).');
  };
  for (const tr of localTracks()) pc.addTrack(tr, localStream);
  // A freshly established connection must not undercut the mute: someone who is muted and then
  // gets a new counterpart (rejoin, second participant) would otherwise be audible again over
  // that connection.
  enforceLocalMuteState();
  return p;
}

/**
 * Enforce muting at the SENDERS, not only on `localStream`.
 *
 * The button used to switch off `localStream.getAudioTracks()` and nothing else. That only works
 * as long as every connection sends exactly that track object — if a sender holds a different one
 * for any reason (replacement, clone, a connection built later), the audio stays on while the
 * button reads "muted". Exactly that happened on 2026-08-11: still audible as host despite being
 * muted.
 *
 * Hence the opposite direction here: walk ALL senders and force the state. This is the point at
 * which audio leaves the machine — what is off here is really off.
 */
function enforceLocalMuteState() {
  for (const p of peers.values()) {
    if (!p.pc || typeof p.pc.getSenders !== 'function') continue;
    for (const s of p.pc.getSenders()) {
      if (!s.track) continue;
      if (s.track.kind === 'audio') s.track.enabled = !micMuted;
      else if (s.track.kind === 'video' && !localSharing) s.track.enabled = !camOff;
    }
  }
}

// Show a peer's remote stream in its own video tile (created on first track).
function attachRemote(peerId, stream) {
  const p = peers.get(peerId);
  if (!p || mode !== 'video') { revealCall(); return; }
  if (!p.tile) {
    const tile = document.createElement('div'); tile.className = 'tile'; tile.dataset.peer = peerId;
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true;
    const nameEl = document.createElement('div'); nameEl.className = 'name verified'; nameEl.textContent = p.name ? titleCase(p.name) : t('Gegenüber');
    tile.append(video, nameEl); videosEl.appendChild(tile);
    p.tile = tile; p.video = video;
    applyStage(); // pick up cursor/title + any pending screen-share auto-stage for this peer
  }
  p.video.srcObject = stream;
  revealCall();
}

function removePeer(peerId) {
  const p = peers.get(peerId);
  if (!p) return;
  try { if (p.dc) p.dc.close(); } catch {}
  try { p.pc.close(); } catch {}
  if (p.tile) p.tile.remove();
  peers.delete(peerId);
}

// 'ready' (may repeat on resume): open/refresh a connection to every listed peer.
// Of each pair, the side with the lower peerId is the offerer (server sets `initiator`).
async function startCall(msg) {
  if (ended) return;
  if (msg.mode) mode = msg.mode;

  if (!callStarted) {
    callStarted = true;
    document.body.classList.add('in-call');
    reviewBox.hidden = true; authBox.hidden = true; shareBox.hidden = true; setupBox.hidden = true; benefitsBox.hidden = true; startBar.hidden = true;
    setLocalLabel(titleCase(myName) || '');
    setStatus(mode === 'chat' ? 'Verbindung wird aufgebaut …' : 'Bitte Kamera/Mikrofon erlauben – dann wird verbunden …');
    await ensureMedia();
    setStatus('Verbindung wird aufgebaut …');
    await refreshIce();
  }

  for (const info of (msg.peers || [])) {
    const p = getPeer(info.peerId, info);
    if (p.tile && info.name) p.tile.querySelector('.name').textContent = titleCase(info.name);
    if (info.initiator && p.pc.connectionState !== 'connected') {
      if (!p.dc) { p.dc = p.pc.createDataChannel('chat'); wireChat(p.dc, info.peerId); }
      try {
        const offer = await p.pc.createOffer(p.offered ? { iceRestart: true } : undefined);
        await p.pc.setLocalDescription(offer); p.offered = true;
        wsSend({ type: 'offer', to: info.peerId, data: offer });
      } catch (e) { console.warn('createOffer:', e && e.message); }
    }
    // Non-initiators receive their channels via pc.ondatachannel (label-routed, getPeer).
  }
}

async function onRemoteOffer(from, offer) {
  if (ended || !from) return;
  await ensureMedia();
  await refreshIce();
  const p = getPeer(from); // pc.ondatachannel (label-routed) is set in getPeer
  await p.pc.setRemoteDescription(offer);
  if (!verifyPeerBinding(from)) return;
  p.remoteDescSet = true; flushIce(from);
  const answer = await p.pc.createAnswer();
  await p.pc.setLocalDescription(answer);
  wsSend({ type: 'answer', to: from, data: answer });
  updateSas();
}
async function onRemoteAnswer(from, answer) {
  const p = from && peers.get(from);
  if (ended || !p || p.pc.signalingState !== 'have-local-offer') return;
  await p.pc.setRemoteDescription(answer);
  if (!verifyPeerBinding(from)) return;
  p.remoteDescSet = true; flushIce(from);
  updateSas();
}
function onRemoteIce(from, candidate) {
  if (ended || !from) return;
  const p = peers.get(from);
  // Peer not created yet (still in our getUserMedia prompt): stash the candidate so it
  // isn't lost — getPeer adopts it the moment the connection is created.
  if (!p) { const buf = earlyIce.get(from) || earlyIce.set(from, []).get(from); buf.push(candidate); return; }
  if (!p.remoteDescSet) { p.pendingIce.push(candidate); return; }
  p.pc.addIceCandidate(candidate).catch((e) => console.warn('addIceCandidate:', e && e.message));
}
function flushIce(from) {
  const p = peers.get(from); if (!p) return;
  while (p.pendingIce.length) p.pc.addIceCandidate(p.pendingIce.shift()).catch((e) => console.warn('addIceCandidate:', e && e.message));
}

// ---- screen sharing (applies across all peer connections) ----
function localVideoSenders() {
  const senders = [];
  for (const p of peers.values()) { const s = p.pc.getSenders().find((s) => s.track && s.track.kind === 'video'); if (s) senders.push(s); }
  return senders;
}
function screenShareSupported() {
  return capOn('screen-share') && mode === 'video' && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && localVideoSenders().length > 0;
}
function setScreenBtn(active) {
  screenBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  screenLabel.textContent = active ? t('Teilen beenden') : t('Bildschirm teilen');
}
async function startScreenShare() {
  const senders = localVideoSenders();
  if (!senders.length) return;
  let stream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
  catch (e) { return; } // user cancelled the picker
  const track = stream.getVideoTracks()[0];
  if (!track) { stream.getTracks().forEach((t) => t.stop()); return; }
  // The SAS overlay also owns these senders (canvas track) — release them back to the
  // real camera first, so the "camera track to restore later" below is the actual
  // camera, not the composited canvas stream.
  sasOverlayResumeAfterScreenShare = sasOverlayActive;
  if (sasOverlayActive) await stopSasOverlay();
  cameraTrack = senders[0].track;          // remember camera track to restore later
  screenStream = stream;
  for (const s of senders) { try { await s.replaceTrack(track); } catch {} }
  enforceLocalMuteState();
  localVideo.srcObject = stream;           // show what you're sharing in your own tile
  track.addEventListener('ended', stopScreenShare); // native "Stop sharing" button
  setScreenBtn(true);
  localSharing = true; broadcast({ k: 'screen', on: true }); applyStage();
}
async function stopScreenShare() {
  if (!screenStream) return;
  for (const s of localVideoSenders()) { if (cameraTrack) { try { await s.replaceTrack(cameraTrack); } catch {} } }
  enforceLocalMuteState();
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null; cameraTrack = null;
  if (localStream) localVideo.srcObject = localStream;
  setScreenBtn(false);
  localSharing = false; broadcast({ k: 'screen', on: false }); applyStage();
  if (sasOverlayResumeAfterScreenShare) { sasOverlayResumeAfterScreenShare = false; startSasOverlay(); }
}
function toggleScreenShare() { if (screenStream) stopScreenShare(); else startScreenShare(); }

// ---- spotlight / stage layout (video only) ----
// Click a tile to promote it to a large "stage" (others become a thumbnail strip); click
// it again for the grid. A peer starting a screen-share is auto-staged so the shared
// screen is big and readable (object-fit: contain, no cropping). Screen state is signaled
// to peers over the existing chat DataChannel ({ k:'screen', on }).
let stagePeer = null;        // 'self' | peerId | null (grid)
let stageAuto = false;       // current stage was set by a screen-share (auto), not a click
let localSharing = false;    // this participant is sharing their screen
const screenSharers = new Set(); // peerIds currently sharing their screen

function spotlightOn() { return capOn('spotlight') && mode === 'video'; }
function tileFor(key) { return videosEl.querySelector(`.tile[data-peer="${key}"]`); }
// Whether THIS tile can go fullscreen at all. Desktop/Android: element fullscreen.
// iOS Safari: no element fullscreen — only the native <video> player supports it.
function tileVideo(tile) { return tile.querySelector('video'); }
function fullscreenAvailable(tile) {
  if (document.fullscreenEnabled || document.webkitFullscreenEnabled) return true;
  const v = tileVideo(tile);
  return !!(v && (v.webkitEnterFullscreen || v.webkitSupportsFullscreen));
}
// Native fullscreen for a single tile (⇒ a shared screen fills the whole monitor).
function toggleTileFullscreen(tile) {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); return; }
  if (tile.requestFullscreen) { tile.requestFullscreen().catch(() => {}); return; }
  if (tile.webkitRequestFullscreen) { tile.webkitRequestFullscreen(); return; }
  // iOS: fall back to the native <video> fullscreen player (element FS is unavailable).
  const v = tileVideo(tile);
  if (v && v.webkitEnterFullscreen) { try { v.webkitEnterFullscreen(); } catch {} }
}
// Add the per-tile fullscreen button once (idempotent).
function ensureTileControls(tile) {
  if (!tile || tile.querySelector('.tile-fs')) return;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'tile-fs'; btn.setAttribute('aria-label', t('Vollbild'));
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleTileFullscreen(tile); }); // don't also toggle spotlight
  tile.appendChild(btn);
}
function applyStage() {
  const on = spotlightOn();
  videosEl.classList.toggle('spotlightable', on);
  // Break the video section out of the narrow reading column so the stage grows with
  // the viewport (fluid). Only during a video call with the Pro spotlight capability.
  peersBox.classList.toggle('fluid', on);
  // A manually staged peer that has since left → fall back to the grid.
  if (stagePeer && stagePeer !== 'self' && !tileFor(stagePeer) && !stageAuto) { stagePeer = null; }
  const staged = on ? stagePeer : null;
  videosEl.classList.toggle('stage-mode', !!staged && !!tileFor(staged));
  for (const tile of videosEl.querySelectorAll('.tile')) {
    const key = tile.dataset.peer;
    if (on) {
      ensureTileControls(tile);
      const fsBtn = tile.querySelector('.tile-fs');
      if (fsBtn) fsBtn.style.display = fullscreenAvailable(tile) ? '' : 'none'; // hide where FS isn't possible (iOS div)
    }
    tile.classList.toggle('on-stage', !!staged && key === staged);
    tile.classList.toggle('is-screen', key === 'self' ? localSharing : screenSharers.has(key));
    if (on) tile.title = key === staged ? t('Zurück zum Raster') : t('Groß anzeigen');
    else tile.removeAttribute('title');
    renderTileBadges(tile, key);
  }
}
// ---- unified tile status badges (mic/camera/hand/screen/document) ----
// Same icon as the matching control button, so the state reads without checking the
// controls; the "off"/active tint matches the button's own pressed/muted styling.
const BADGE_ICONS = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  cam: '<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>',
  screen: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  doc: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
};
function badgeIconEl(kind, off) {
  const b = document.createElement('span');
  b.className = 'tile-badge' + (off ? ' off' : '');
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BADGE_ICONS[kind]}</svg>`;
  return b;
}
function renderTileBadges(tile, key) {
  const isSelf = key === 'self';
  const wantHand = isSelf ? handRaised : handsUp.has(key);
  const wantMicOff = isSelf ? micMuted : peerMicMuted.has(key);
  const wantCamOff = isSelf ? camOff : peerCamOff.has(key);
  const wantScreen = isSelf ? localSharing : screenSharers.has(key);
  const wantDoc = !qesBox.hidden; // shared session — same for both sides
  let badges = tile.querySelector('.tile-badges');
  const anyActive = wantHand || wantMicOff || wantCamOff || wantScreen || wantDoc;
  if (!anyActive) { if (badges) badges.remove(); return; }
  if (!badges) { badges = document.createElement('div'); badges.className = 'tile-badges'; tile.appendChild(badges); }
  badges.innerHTML = '';
  if (wantHand) { const b = document.createElement('span'); b.className = 'tile-badge'; b.textContent = '✋'; badges.appendChild(b); }
  if (wantMicOff) badges.appendChild(badgeIconEl('mic', true));
  if (wantCamOff) badges.appendChild(badgeIconEl('cam', true));
  if (wantScreen) badges.appendChild(badgeIconEl('screen', false));
  if (wantDoc) badges.appendChild(badgeIconEl('doc', false));
}
/** Re-render badges on every tile — call after any state change (mic/cam/hand/screen/doc). */
function refreshAllBadges() { for (const tile of videosEl.querySelectorAll('.tile')) renderTileBadges(tile, tile.dataset.peer); }
function toggleStage(key) { if (!spotlightOn()) return; stageAuto = false; stagePeer = stagePeer === key ? null : key; applyStage(); }
function autoStage(key) { if (!spotlightOn()) return; stagePeer = key; stageAuto = true; applyStage(); }
function clearAutoStage(key) { if (stageAuto && stagePeer === key) { stagePeer = null; stageAuto = false; } applyStage(); }
// Someone else's screen-share state (received over the DataChannel).
function onPeerScreen(peerId, on) {
  if (!peerId) return;
  if (on) { screenSharers.add(peerId); addChat('System', peerName(peerId) + ' ' + t('teilt den Bildschirm.')); autoStage(peerId); }
  else { screenSharers.delete(peerId); clearAutoStage(peerId); }
}
videosEl.addEventListener('click', (e) => {
  if (!spotlightOn()) return;
  const tile = e.target.closest('.tile');
  if (tile && videosEl.contains(tile) && tile.dataset.peer) toggleStage(tile.dataset.peer);
});

// ---- verified-claims banderole on a tile (Community) ----
// Clicking a NAME BADGE unfolds a banderole over the tile listing that person's verified
// claims — the same data as the verified-claims card, anchored at the person. Uses the
// last status (values only exist after the mutual reveal). Registered in the CAPTURE
// phase so the click doesn't also toggle the Pro spotlight.
function banderoleDataFor(key) {
  const msg = lastStatusMsg;
  if (!msg || !msg.revealed) return null;
  if (key === 'self') return { claims: msg.self.claims, attrs: selfAttrs(msg), empty: 'Du teilst nichts (anonym).', shared: msg.self.sharedCredentials };
  const peer = (msg.peers || []).find((p) => p.peerId === key);
  return peer ? { claims: peer.claims, attrs: attrsForPeer(msg, peer), empty: 'bleibt anonym.', creds: peer.credentials } : null;
}
function toggleBanderole(tile) {
  const open = tile.querySelector('.banderole');
  if (open) { open.remove(); return; }
  const data = banderoleDataFor(tile.dataset.peer);
  if (!data) return;
  const band = document.createElement('div');
  band.className = 'banderole';
  renderResultInto(band, data.claims, data.attrs, data.empty);
  // In-call catalog credentials (Pro): what the peer presented to me / what I shared.
  appendCredentialRows(band, data.creds);
  appendSharedCredentialRows(band, data.shared);
  // QES identity binding (public/qes/ §6): signature ↔ PID result at the person.
  const peerEntry = peers.get(tile.dataset.peer);
  if (peerEntry && peerEntry.qesBinding) {
    const b = peerEntry.qesBinding;
    const div = document.createElement('div'); div.className = 'result-row';
    const lab = document.createElement('span'); lab.className = 'r-label'; lab.textContent = '✍️ ' + t('Signatur');
    const val = document.createElement('span');
    val.className = b.status === 'match' ? 'r-badge' : 'r-value';
    val.textContent = b.status === 'match' ? '✓ ' + t('stimmt mit Ausweis überein')
      : b.status === 'mismatch' ? '⚠ ' + t('weicht vom Ausweis ab') + ' (' + b.certName + ')'
      : t('kein Ausweis-Abgleich möglich');
    div.append(lab, val); band.appendChild(div);
  }
  tile.appendChild(band);
}
videosEl.addEventListener('click', (e) => {
  const nameEl = e.target.closest('.tile .name, .tile .cred-badge');
  if (!nameEl || !lastStatusMsg || !lastStatusMsg.revealed) return;
  e.stopPropagation(); // don't also spotlight the tile
  toggleBanderole(nameEl.closest('.tile'));
}, true);

// ---- in-call credential requests (Pro, server-enforced `in-call-credentials`) ----
// The HOST asks a participant for a further catalog credential (e.g. Wohnraum-ID) DURING
// the call. The target consents (sees the exact field list first), presents via wallet;
// the values appear ONLY for the host — as a badge on the person's tile (banderole) and
// in the "Geprüfte Angaben" card. See src/credential-requests.ts.
const credreqBtn = $('credreq-btn');
const credreqPanel = $('credreq-panel');
const credModal = $('cred-modal');
const credTitle = $('cred-title');
const credHint = $('cred-hint');
const credClaimsEl = $('cred-claims');
const credAuthArea = $('cred-auth-area');
const credAuthLink = $('cred-auth-link');
const credQr = $('cred-qrcode');
const credActions = $('cred-actions');
const credAccept = $('cred-accept');
const credDecline = $('cred-decline');

let credCatalog = [];                    // /credential-catalog (empty in Community)
let activeCredRequest = null;            // target side: the request the modal shows
const pendingCredRequests = new Map();   // host side: requestId -> { to, credentialId, label }

async function refreshCredCatalog() {
  if (!capOn('in-call-credentials')) { credCatalog = []; updateCredReqButton(); return; }
  try {
    const r = await fetch(apiUrl('credential-catalog'), { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); credCatalog = Array.isArray(j.credentials) ? j.credentials : []; }
  } catch { /* keep the current catalog */ }
  updateCredReqButton();
}

function updateCredReqButton() {
  const on = isHost() && callStarted && !ended && capOn('in-call-credentials') && credCatalog.length > 0 && peers.size > 0;
  credreqBtn.hidden = !on;
  if (!on) credreqPanel.hidden = true;
}

// One row per credential × peer (1:1 hides the redundant name).
function buildCredReqPanel() {
  credreqPanel.innerHTML = '';
  const peerList = [...peers.entries()];
  for (const c of credCatalog) {
    for (const [peerId, p] of peerList) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'credreq-item';
      const who = p.name ? titleCase(p.name) : t('Gegenüber');
      btn.textContent = peerList.length > 1
        ? t('{label} von {name} anfordern', { label: c.label, name: who })
        : t('{label} anfordern', { label: c.label });
      const pending = [...pendingCredRequests.values()].some((r) => r.to === peerId && r.credentialId === c.id);
      if (pending) { btn.disabled = true; btn.textContent += ' …'; }
      btn.addEventListener('click', () => {
        wsSend({ type: 'credential-request', to: peerId, credentialId: c.id });
        credreqPanel.hidden = true;
      });
      credreqPanel.appendChild(btn);
    }
  }
}
credreqBtn.addEventListener('click', () => {
  if (credreqPanel.hidden) buildCredReqPanel();
  credreqPanel.hidden = !credreqPanel.hidden;
});
document.addEventListener('click', (e) => {
  if (!credreqPanel.hidden && !credreqPanel.contains(e.target) && e.target !== credreqBtn && !credreqBtn.contains(e.target)) credreqPanel.hidden = true;
});

// Target side: consent prompt — requester, credential, EXACT field list; nothing goes
// near the wallet before "Teilen".
function showCredPrompt(msg) {
  activeCredRequest = { requestId: msg.requestId, label: msg.credential.label };
  credTitle.textContent = msg.credential.label;
  const who = msg.fromName ? titleCase(msg.fromName) : t('Gastgeber:in');
  credHint.textContent = t('{name} bittet dich, diesen Nachweis aus deiner Wallet zu teilen:', { name: who });
  credClaimsEl.innerHTML = '';
  for (const c of (msg.credential.claims || [])) {
    const li = document.createElement('li');
    li.textContent = c.name + (c.mandatory ? '' : ' · ' + t('optional'));
    credClaimsEl.appendChild(li);
  }
  credAuthArea.hidden = true;
  credActions.hidden = false;
  credAccept.disabled = false; credDecline.disabled = false;
  credModal.hidden = false;
}
function showCredAuth(msg) {
  if (!activeCredRequest || activeCredRequest.requestId !== msg.requestId) return;
  credActions.hidden = true;
  credQr.innerHTML = '';
  // eslint-disable-next-line no-undef
  new QRCode(credQr, { text: msg.crossDeviceUri || msg.uri, width: 232, height: 232, correctLevel: QRCode.CorrectLevel.M });
  credAuthLink.href = msg.uri || msg.crossDeviceUri;
  credAuthArea.hidden = false;
}
function closeCredModal() { credModal.hidden = true; activeCredRequest = null; }
credAccept.addEventListener('click', () => {
  if (activeCredRequest) wsSend({ type: 'credential-accept', requestId: activeCredRequest.requestId });
  credAccept.disabled = true; credDecline.disabled = true;
});
credDecline.addEventListener('click', () => {
  if (activeCredRequest) wsSend({ type: 'credential-decline', requestId: activeCredRequest.requestId });
  closeCredModal();
});

// A terminal outcome for a request I sent or received: clean up UI state.
function credRequestOver(msg, chatText) {
  pendingCredRequests.delete(msg.requestId);
  if (activeCredRequest && activeCredRequest.requestId === msg.requestId) closeCredModal();
  if (chatText) addChat('System', '🪪 ' + chatText);
}

// Badges live on the tiles and re-render from every status (resume-safe): the host sees
// what each peer presented TO THEM; everyone sees on their own tile what they shared.
function credBadgeFor(tile, labels) {
  let badge = tile.querySelector('.cred-badge');
  if (!labels.length) { if (badge) badge.remove(); return; }
  if (!badge) { badge = document.createElement('div'); badge.className = 'cred-badge'; tile.appendChild(badge); }
  badge.textContent = '🪪 ' + labels.join(', ') + ' ✓';
  badge.title = t('Nachweis anzeigen');
}
function updateCredBadges(msg) {
  for (const peer of (msg.peers || [])) {
    const p = peers.get(peer.peerId);
    if (p) p.credentials = peer.credentials || [];
    const tile = tileFor(peer.peerId);
    if (tile) credBadgeFor(tile, (peer.credentials || []).map((c) => c.label));
  }
  const selfTile = tileFor('self');
  if (selfTile) credBadgeFor(selfTile, ((msg.self && msg.self.sharedCredentials) || []).map((c) => c.label));
  updateCredReqButton();
}

// Rows for presented catalog credentials (host view: names + values).
function appendCredentialRows(container, creds) {
  for (const c of (creds || [])) {
    const head = document.createElement('div'); head.className = 'peer-block-head'; head.textContent = '🪪 ' + c.label;
    container.appendChild(head);
    for (const row of (c.claims || [])) {
      const div = document.createElement('div'); div.className = 'result-row';
      const lab = document.createElement('span'); lab.className = 'r-label'; lab.textContent = row.name;
      const val = document.createElement('span'); val.className = 'r-value'; val.textContent = String(row.value);
      div.append(lab, val); container.appendChild(div);
    }
  }
}
// Rows for credentials I shared myself (labels only — I know my own values).
function appendSharedCredentialRows(container, shared) {
  for (const c of (shared || [])) {
    const div = document.createElement('div'); div.className = 'result-row';
    const lab = document.createElement('span'); lab.className = 'r-label'; lab.textContent = '🪪 ' + c.label;
    const b = document.createElement('span'); b.className = 'r-badge'; b.textContent = '✓ ' + t('geteilt');
    div.append(lab, b); container.appendChild(div);
  }
}

// ---- SAS (short authentication string) ----
// MITM detection for the DTLS key exchange: both sides derive the same short code from
// BOTH DTLS certificate fingerprints (order-independent) and compare it verbally. A
// signaling-server MITM terminates two different DTLS sessions → the codes differ.
// v1: shown only for EXACTLY ONE peer (a group SAS is a separate design — see MESH.md).
// 36 bits (6 symbols × 64) — see SECURITY_CHECKLIST for the residual-risk discussion.
const SAS_EMOJI = ['🦊','🐼','🐧','🦁','🐸','🐙','🦋','🐢','🦉','🐝','🐬','🦄','🌊','🌵','🌙','⭐','🌈','🍀','🌻','🍄','🍎','🍋','🍇','🍓','🥕','🍞','🧀','🍩','☕','🍯','🥨','🔑','🔔','🎈','🎁','🎲','🎯','🎸','🎨','📌','✂️','🧭','⏰','🔒','📎','🪁','🚗','🚲','✈️','🚀','⛵','🚦','⚓','🗼','🏠','⛺','🌋','🏔️','☂️','❄️','🔥','💧','⚡','🧊'];
const sasCard = $('sas-card');
const sasCode = $('sas-code');
function sdpFingerprint(desc) {
  const m = desc && desc.sdp && desc.sdp.match(/a=fingerprint:\S+\s+([0-9A-Fa-f:]+)/);
  return m ? m[1].toUpperCase() : null;
}
async function updateSas() {
  if (peers.size !== 1) { sasCard.hidden = true; stopSasOverlay(); return; } // 1:1 only in v1
  const p = peers.values().next().value;
  if (!p.pc.localDescription || !p.pc.remoteDescription) return;
  const a = sdpFingerprint(p.pc.localDescription);
  const b = sdpFingerprint(p.pc.remoteDescription);
  if (!a || !b) return;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode([a, b].sort().join('|'))));
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(digest[i]); // 40 bits, we use the top 36
  const syms = [];
  for (let i = 0; i < 6; i++) syms.push(SAS_EMOJI[Number((bits >> BigInt(40 - 6 * (i + 1))) & 63n)]);
  sasCode.textContent = syms.join(' ');
  sasCard.hidden = false;
  startSasOverlay(); // no-op if unsupported (audio/chat mode, no camera) or already running
}

// ---- SAS burn-in overlay (Community): embed the code directly into the outgoing
// video pixels so your counterpart can visually compare it against their own — the
// SAME security check as reading it aloud, but through a channel (the actual video
// frames, DTLS-SRTP-protected like everything else) a MITM cannot forge without
// literally deepfaking your live video in real time.
//
// Deliberately NOT sent via the DataChannel or as a DOM-only overlay on your own tile:
// either would ride the very transport SAS exists to authenticate — a MITM terminating
// that transport could just relay/fake the value and defeat the whole check silently.
// Compositing it into the actual camera frames (canvas → captureStream → replaceTrack,
// same mechanism as screen-share) is the only path outside that trust boundary short
// of speaking it aloud.
let sasOverlayActive = false;
let sasOverlayCanvas = null, sasOverlayCtx = null, sasOverlaySourceVideo = null;
let sasOverlayTrack = null, sasOverlayFrameHandle = null, sasOverlayFrameIsRAF = false;
let sasOverlayClock = null, sasOverlayClockUrl = null;
let sasOverlayResumeAfterScreenShare = false;

function sasOverlaySupported() {
  return mode === 'video' && peers.size === 1 && !screenStream
    && !!(localStream && localStream.getVideoTracks && localStream.getVideoTracks().length);
}
// Keeping the picture alive while the tab is in the background.
// The composited canvas is the OUTGOING track, so whatever stops drawing it freezes the
// picture for the other side — that was the bug: switch to another tab and your
// counterpart (and your own tile, which shows the same stream) saw a still image.
// requestAnimationFrame does not run at all in a hidden tab, and a main-thread setTimeout
// is throttled there to 1 Hz unless the page happens to be audible — which it is not when
// the other side has their microphone muted. A dedicated worker's timer is exempt from
// that throttling, so it is what drives the frames while you are away.
// Measured over 12 s hidden (Chrome 152): rAF 0 fps, setTimeout 1 fps (22 fps if audible),
// worker 24 fps either way.
const SAS_OVERLAY_HIDDEN_MS = 42; // ~24 fps — enough to stay a live picture, not a slideshow
const SAS_OVERLAY_CLOCK_SRC =
  'let i = null; onmessage = (e) => { clearInterval(i); i = null;' +
  ' if (e.data && e.data.ms) i = setInterval(() => postMessage(0), e.data.ms); };';
function startSasOverlayClock() {
  if (sasOverlayClock) return;
  try {
    sasOverlayClockUrl = URL.createObjectURL(new Blob([SAS_OVERLAY_CLOCK_SRC], { type: 'text/javascript' }));
    sasOverlayClock = new Worker(sasOverlayClockUrl);
    sasOverlayClock.onmessage = () => { if (sasOverlayActive && document.hidden) drawSasOverlayFrame(); };
  } catch (e) {
    // A deployment may forbid blob: workers via CSP. Then the hidden tab falls back to the
    // throttled timer below: a slow picture, but never a frozen one.
    console.warn('SAS-Overlay-Taktgeber nicht verfügbar:', e && e.message);
    stopSasOverlayClock();
  }
}
function stopSasOverlayClock() {
  if (sasOverlayClock) { try { sasOverlayClock.terminate(); } catch {} sasOverlayClock = null; }
  if (sasOverlayClockUrl) { try { URL.revokeObjectURL(sasOverlayClockUrl); } catch {} sasOverlayClockUrl = null; }
}
// Let the worker tick only while it is actually needed.
function syncSasOverlayClock() {
  if (!sasOverlayClock) return;
  sasOverlayClock.postMessage({ ms: sasOverlayActive && document.hidden ? SAS_OVERLAY_HIDDEN_MS : 0 });
}
function scheduleSasOverlayFrame() {
  cancelSasOverlayFrame();
  if (!sasOverlayActive) return;
  if (!document.hidden) {
    sasOverlayFrameIsRAF = true;
    sasOverlayFrameHandle = requestAnimationFrame(drawSasOverlayFrame);
    return;
  }
  if (sasOverlayClock) return; // hidden: the worker calls drawSasOverlayFrame() instead
  sasOverlayFrameIsRAF = false;
  sasOverlayFrameHandle = setTimeout(drawSasOverlayFrame, SAS_OVERLAY_HIDDEN_MS);
}
function cancelSasOverlayFrame() {
  if (sasOverlayFrameHandle === null) return;
  if (sasOverlayFrameIsRAF) cancelAnimationFrame(sasOverlayFrameHandle); else clearTimeout(sasOverlayFrameHandle);
  sasOverlayFrameHandle = null;
}
function drawSasOverlayFrame() {
  if (!sasOverlayActive) return;
  // Some browsers pause a <video> while its tab is in the background. Drawing from a
  // paused element would repeat one stale frame, which is the freeze we are avoiding.
  if (sasOverlaySourceVideo && sasOverlaySourceVideo.paused) sasOverlaySourceVideo.play().catch(() => {});
  const w = sasOverlayCanvas.width, h = sasOverlayCanvas.height;
  try { sasOverlayCtx.drawImage(sasOverlaySourceVideo, 0, 0, w, h); } catch { /* frame not ready yet */ }
  const text = sasCode.textContent;
  if (text) {
    const fontSize = Math.max(14, Math.round(h * 0.055));
    sasOverlayCtx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
    const metrics = sasOverlayCtx.measureText(text);
    const padX = fontSize * 0.55, padY = fontSize * 0.4, r = 10;
    const boxW = metrics.width + padX * 2, boxH = fontSize + padY * 2;
    const x = fontSize * 0.4, y = h - boxH - fontSize * 0.4;
    sasOverlayCtx.fillStyle = 'rgba(7, 11, 22, 0.72)';
    sasOverlayCtx.beginPath();
    sasOverlayCtx.moveTo(x + r, y);
    sasOverlayCtx.arcTo(x + boxW, y, x + boxW, y + boxH, r);
    sasOverlayCtx.arcTo(x + boxW, y + boxH, x, y + boxH, r);
    sasOverlayCtx.arcTo(x, y + boxH, x, y, r);
    sasOverlayCtx.arcTo(x, y, x + boxW, y, r);
    sasOverlayCtx.closePath();
    sasOverlayCtx.fill();
    sasOverlayCtx.fillStyle = '#fff';
    sasOverlayCtx.textBaseline = 'middle';
    sasOverlayCtx.fillText(text, x + padX, y + boxH / 2 + 1);
  }
  scheduleSasOverlayFrame();
}
function cleanupSasOverlayDom() {
  if (sasOverlaySourceVideo) { try { sasOverlaySourceVideo.remove(); } catch {} sasOverlaySourceVideo = null; }
  sasOverlayCanvas = null; sasOverlayCtx = null;
}
async function startSasOverlay() {
  if (sasOverlayActive || !sasOverlaySupported()) return;
  const camTrack = localStream.getVideoTracks()[0];
  const settings = camTrack.getSettings ? camTrack.getSettings() : {};
  const w = settings.width || 640, h = settings.height || 480;
  // Hidden source <video>: drawImage needs a playing video element, but the VISIBLE
  // local tile is about to show the composited canvas stream instead (WYSIWYG) — so
  // the raw camera feed needs a separate, off-screen element to draw from.
  sasOverlaySourceVideo = document.createElement('video');
  sasOverlaySourceVideo.muted = true; sasOverlaySourceVideo.playsInline = true;
  sasOverlaySourceVideo.style.cssText = 'position:fixed; width:1px; height:1px; opacity:0; pointer-events:none;';
  sasOverlaySourceVideo.srcObject = localStream;
  document.body.appendChild(sasOverlaySourceVideo);
  try { await sasOverlaySourceVideo.play(); } catch { /* autoplay restrictions shouldn't apply (muted) */ }
  sasOverlayCanvas = document.createElement('canvas');
  sasOverlayCanvas.width = w; sasOverlayCanvas.height = h;
  sasOverlayCtx = sasOverlayCanvas.getContext('2d');
  let stream;
  try { stream = sasOverlayCanvas.captureStream(30); } catch (e) { console.warn('SAS-Video-Overlay nicht unterstützt:', e && e.message); cleanupSasOverlayDom(); return; }
  sasOverlayTrack = stream.getVideoTracks()[0];
  if (!sasOverlayTrack) { cleanupSasOverlayDom(); return; }
  sasOverlayActive = true;
  startSasOverlayClock();
  syncSasOverlayClock();
  drawSasOverlayFrame();
  for (const s of localVideoSenders()) { try { await s.replaceTrack(sasOverlayTrack); } catch {} }
  enforceLocalMuteState();
  localVideo.srcObject = stream; // your own tile shows exactly what's actually being sent
}
async function stopSasOverlay() {
  if (!sasOverlayActive) return;
  sasOverlayActive = false;
  cancelSasOverlayFrame();
  stopSasOverlayClock();
  if (sasOverlayTrack) { try { sasOverlayTrack.stop(); } catch {} sasOverlayTrack = null; }
  cleanupSasOverlayDom();
  if (localStream && !screenStream) { // screen-share (if active) owns the senders instead
    const camTrack = localStream.getVideoTracks()[0];
    if (camTrack) for (const s of localVideoSenders()) { try { await s.replaceTrack(camTrack); } catch {} }
    enforceLocalMuteState();
    localVideo.srcObject = localStream;
  }
}

// ---- coming back from another tab ----
// Two things go stale while the tab is in the background, and neither repairs itself:
// the overlay's frame loop (a pending requestAnimationFrame never fires once the page is
// hidden, so the chain would end there), and the video tiles themselves — several
// browsers pause a <video> in a background tab and leave it on its last frame even though
// the track kept running. Re-arm the loop for whichever schedule now applies, and nudge
// every call tile back into playback.
function resumeCallVideos() {
  const tiles = videosEl ? Array.from(videosEl.querySelectorAll('video')) : [];
  if (sasOverlaySourceVideo) tiles.push(sasOverlaySourceVideo);
  for (const v of tiles) { if (v.paused && v.srcObject) v.play().catch(() => {}); }
}
document.addEventListener('visibilitychange', () => {
  syncSasOverlayClock();
  scheduleSasOverlayFrame(); // both no-ops unless the overlay is running
  if (!document.hidden) resumeCallVideos();
});

function anyConnected() {
  for (const p of peers.values()) if (p.pc.connectionState === 'connected') return true;
  return false;
}
function revealCall() {
  if (ended) return;
  callControls.hidden = false;
  updateStepper(2);
  if (anyConnected()) callConnectedOnce = true;
  if (!embedConnectedSent) { embedConnectedSent = true; postToParent('connected', { mode }); }
  screenBtn.hidden = !screenShareSupported();
  handBtn.hidden = !capOn('hand-raise');
  // Screen-share available in principle, but this browser lacks getDisplayMedia
  // (iOS Safari) → explain instead of silently omitting the button.
  const canGetDisplay = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  const screenUnsupported = capOn('screen-share') && mode === 'video' && !canGetDisplay;
  if (compatNote) {
    compatNote.hidden = !screenUnsupported;
    if (screenUnsupported) compatNote.textContent = t('Bildschirm teilen wird auf diesem Gerät nicht unterstützt.');
  }
  showMediaControls();
  updateCredReqButton();
  updateDocBtn();
  chatBox.hidden = false;
  // The explainer paragraph has done its job once the call is actually live — drop it
  // so the header stays compact (logo/title only) instead of permanently taking up
  // space next to video/chat.
  if (headerSub) headerSub.hidden = true;
  benefitsBox.hidden = true; reviewBox.hidden = true; setupBox.hidden = true; authBox.hidden = true;
  // In an open room keep the invite link visible during the call so more guests can join.
  shareBox.hidden = !isOpenRoom;
  if (anyConnected()) setStatus('Verbunden ✓ – sichere P2P-Verbindung steht.');
  if (mode === 'video') { peersBox.hidden = false; callBanner.hidden = true; applyStage(); }
  else {
    peersBox.hidden = true; callBanner.hidden = false;
    const only = peers.size === 1 ? peers.values().next().value : null;
    const suffix = only && only.name ? ` · ${titleCase(only.name)}` : '';
    bannerText.textContent = (mode === 'audio' ? t('Audio-Verbindung steht') : t('Chat-Verbindung steht')) + suffix;
  }
}

// A peer left (grace expired) or hung up: drop just that connection/tile.
function onPeerGone(from) {
  if (ended || !from) return;
  removePeer(from);
  if (qesShare) qesShare.peerGone(from);
  screenSharers.delete(from);
  handsUp.delete(from);
  peerMicMuted.delete(from);
  peerCamOff.delete(from);
  if (stagePeer === from) { stagePeer = null; stageAuto = false; }
  updateSas();
  if (peers.size === 0) { ended = true; teardownCall(); showEnded('Alle anderen haben den Anruf verlassen.'); }
  else { setStatus('Ein Teilnehmer hat den Anruf verlassen.'); revealCall(); }
}

// ---- hang up ----
function teardownCall() {
  earlyIce.clear();
  if (qesShare) qesShare.teardown(true); // drop any document ceremony (no abort message — call is over)
  handsUp.clear(); handRaised = false;
  stopSasOverlay();
  for (const id of [...peers.keys()]) removePeer(id);
  for (const p of loopbackPeers) { try { p.close(); } catch {} }
  loopbackPeers = [];
  if (screenStream && screenStream.getTracks) screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null; cameraTrack = null;
  if (localStream && localStream.getTracks) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  if (localVideo.srcObject) localVideo.srcObject = null;
  chatInput.disabled = true; chatSend.disabled = true;
}
function showEnded(message) {
  setStatus(message);
  updateDocBtn();
  credreqPanel.hidden = true; credModal.hidden = true; credreqBtn.hidden = true; activeCredRequest = null;
  peersBox.hidden = true; chatBox.hidden = true; callBanner.hidden = true; callControls.hidden = true; reviewBox.hidden = true; resultBox.hidden = true; sasCard.hidden = true; startBar.hidden = true;
  // The PREPARATORY surfaces too. Overlooking them only became apparent with a refused sign-in:
  // there the message "not authorised" sat above a still-visible QR code — an invitation to a
  // second attempt with a dead offer. The same applies to a taken-over session, where the old
  // setup stayed on screen.
  authBox.hidden = true; setupBox.hidden = true; shareBox.hidden = true;
  restartLabel.textContent = t('Neuen Anruf starten');
  restartBtn.hidden = false;
  postToParent('ended', {});
}
function hangUp() { if (ended) return; ended = true; wsSend({ type: 'hangup' }); teardownCall(); showEnded('Du hast aufgelegt.'); }

/**
 * An invitation to a scheduled call was refused (or was already unreadable here).
 *
 * Deliberately without "start a new call": someone arriving too early or with an expired link
 * wants THIS appointment — a fresh room would be the wrong invitation to the wrong person. The
 * exception is the expired link, where starting over is the only sensible option.
 */
/**
 * The appointment is not open yet: wait instead of refusing.
 *
 * Previously the client ended here for good and asked the person to open the invitation again
 * later — at opening time nothing happened by itself. Anyone who opens the window early and waits
 * (the normal case for a scheduled call) sat in front of a dead screen. Now it counts down and
 * joins by itself at opening time.
 */
let inviteWaitTimer = null;
let inviteTickTimer = null;
let inviteOpensAt = null;

function clearInviteWait() {
  clearTimeout(inviteWaitTimer); inviteWaitTimer = null;
  clearInterval(inviteTickTimer); inviteTickTimer = null;
  inviteOpensAt = null;
  if (inviteWait) inviteWait.hidden = true;
}

function enterWhenOpen() {
  if (inviteOpensAt === null) return;
  clearInviteWait();
  ended = false;       // die Ablehnung war der Grund für den Stopp — er ist weg
  // The server did NOT close the connection after `invite-invalid`, so it is still up.
  // `reconnectNow()` would therefore do nothing (it considers an open socket healthy) — the
  // countdown ran out and nothing happened until you reloaded. On an open socket a fresh `join`
  // is enough.
  if (ws && ws.readyState === WebSocket.OPEN) sendJoin();
  else reconnectNow();
}

function startInviteWait(opensAt) {
  clearInviteWait();
  inviteOpensAt = opensAt;
  if (inviteWait) inviteWait.hidden = false;
  const tick = () => {
    const left = Math.max(0, Math.round(opensAt - Date.now() / 1000));
    if (inviteCountdown) {
      const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
      const pad = (n) => String(n).padStart(2, '0');
      inviteCountdown.textContent = t('noch {time}', { time: h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}` });
    }
    if (left <= 0) enterWhenOpen();
  };
  tick();
  inviteTickTimer = setInterval(tick, 1000);
  // A single dedicated timer rather than the reconnect loop: that one would run into the same
  // refusal every second. Two seconds of slack against clock skew relative to the server.
  inviteWaitTimer = setTimeout(enterWhenOpen, Math.max(0, opensAt * 1000 - Date.now()) + 2000);
}

// Browsers throttle and defer long timers in background tabs — without this check the appointment
// would come to nothing if the window was not in the foreground in the meantime.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && inviteOpensAt !== null && Date.now() / 1000 >= inviteOpensAt) enterWhenOpen();
});
if (inviteRetryBtn) inviteRetryBtn.addEventListener('click', enterWhenOpen);

/**
 * "Renew the code" — an offer is spent after one attempt, and the refusal goes to the wallet, not
 * to us. Anyone scanning the same code again lands in a dead end that looks like a fault in their
 * wallet.
 */
if (authRenewBtn) authRenewBtn.addEventListener('click', () => {
  authRenewBtn.disabled = true;
  setStatus('Neuer Code wird erstellt …');
  wsSend({ type: 'renew-auth' });
  // The server answers with a fresh `auth`; if nothing arrives, the button does not stay dead
  // forever.
  setTimeout(() => { authRenewBtn.disabled = false; }, 4000);
});

function showInviteProblem(reason, opensAt, startsAt) {
  ended = true; // keine Reconnect-Schleife auf eine Ablehnung
  clearInviteWait();
  setupBox.hidden = true; shareBox.hidden = true; authBox.hidden = true;
  reviewBox.hidden = true; resultBox.hidden = true; startBar.hidden = true;
  restartBtn.hidden = true;
  if (reason === 'too-early' && opensAt) {
    const fmt = (s) => new Date(s * 1000).toLocaleString(i18nLocale, { dateStyle: 'full', timeStyle: 'short' });
    const opens = new Date(opensAt * 1000).toLocaleTimeString(i18nLocale, { hour: '2-digit', minute: '2-digit' });
    setStatus(startsAt
      ? t('Dieser Termin beginnt am {when}. Die Einladung öffnet sich um {opens} — dann geht es hier von allein weiter.', { when: fmt(startsAt), opens })
      : t('Diese Einladung öffnet sich am {when} — dann geht es hier von allein weiter.', { when: fmt(opensAt) }));
    startInviteWait(opensAt);
    return;
  }
  if (reason === 'expired') {
    setStatus('Dieser Termin-Link ist abgelaufen. Bitte lass dir eine neue Einladung schicken.');
    restartLabel.textContent = t('Neuen Anruf starten');
    restartBtn.hidden = false;
    return;
  }
  if (reason === 'unconfigured') {
    setStatus('Dieser Server kann geplante Einladungen nicht prüfen. Bitte wende dich an den Betreiber.');
    return;
  }
  if (reason === 'policy') {
    setStatus('Die Einladung fragt Daten ab, die dieser Server nicht mehr erlaubt. Bitte lass dir eine neue Einladung schicken.');
    return;
  }
  setStatus('Diese Einladung ist ungültig. Bitte prüfe den Link — oder lass dir eine neue schicken.');
}

/**
 * "Start a new call" — a NEW room, not a rejoin.
 *
 * Previously this path reloaded the page with location.reload(), i.e. the same URL with
 * ?room=<old>. The server does NOT remove a participant on `hangup` (it only relays, so that a
 * reconnect after switching wallets can still resume), so the old room still has both sides at
 * verified+confirmed. The reload therefore resumed into exactly that room, received `ready` again
 * and built a connection to a far end whose PeerConnection had long been torn down -> "connecting
 * …" forever, with the names of the old call on screen.
 *
 * Drop `room`, add `new=1`, then reload: the roomId derivation above creates a fresh room (and
 * removes `new` again via replaceState), and the full reload clears every remnant of call state.
 *
 * Why `new=1` rather than simply emptying the query: at `/` the server serves the LANDING PAGE,
 * and the app only when `room`, `new`, `solo` or `embed` is set (see src/server.ts,
 * `app.get('/')`). Without the flag you end up on the start page instead of in a new call —
 * exactly what the previous `location.pathname` did on the web.
 *
 * Everything else has to survive — `embed`/`tok` (otherwise an embedded widget suddenly renders
 * the standalone app), `solo`, `lang` and especially the hash, which carries the configuration in
 * embed mode. Hence NOT location.pathname.
 * `replace` rather than `href`: the dead room should not sit in the back stack.
 */
function startFreshCall() {
  const u = new URL(location.href);
  u.searchParams.delete('room');
  u.searchParams.set('new', '1');
  location.replace(u.toString());
}

// ---- internal Solo-Demo loopback (?solo=1) ----
let loopbackStarted = false;
let soloDc = null;
async function startLoopback(name) {
  if (loopbackStarted) return; loopbackStarted = true; callStarted = true; document.body.classList.add('in-call');
  setStatus('Solo-Demo: Loopback-Verbindung …'); authBox.hidden = true; shareBox.hidden = true; setupBox.hidden = true;
  const cfg = { iceServers };
  const a = new RTCPeerConnection(cfg); const b = new RTCPeerConnection(cfg); loopbackPeers = [a, b];
  a.onicecandidate = (e) => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); };
  b.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
  // own dynamic remote tile for the loopback stream
  const tile = document.createElement('div'); tile.className = 'tile';
  const rv = document.createElement('video'); rv.autoplay = true; rv.playsInline = true; rv.muted = true;
  const nameEl = document.createElement('div'); nameEl.className = 'name verified'; nameEl.textContent = titleCase(name) || t('Gegenüber');
  tile.append(rv, nameEl); videosEl.appendChild(tile);
  b.ontrack = (e) => { rv.srcObject = e.streams[0]; revealCall(); };
  mode = 'video';
  const stream = await ensureMedia();
  if (stream) for (const tr of stream.getTracks()) a.addTrack(tr, stream);
  soloDc = a.createDataChannel('chat'); wireChat(soloDc, null);
  b.ondatachannel = (e) => { e.channel.binaryType = 'arraybuffer'; e.channel.onmessage = (ev) => handleChatData(null, ev.data); };
  const offer = await a.createOffer(); await a.setLocalDescription(offer); await b.setRemoteDescription(offer);
  const answer = await b.createAnswer(); await b.setLocalDescription(answer); await a.setRemoteDescription(answer);
  setLocalLabel(name);
  setStatus('Solo-Demo aktiv ✓ – Loopback.');
}

// ---- chat (one DataChannel per peer; sending broadcasts to all) ----
let chatOpenedShown = false;
function peerName(peerId) { const p = peers.get(peerId); return p && p.name ? titleCase(p.name) : t('Gegenüber'); }
function wireChat(channel, peerId) {
  channel.binaryType = 'arraybuffer'; // receive file chunks as ArrayBuffer
  channel.onopen = () => {
    chatInput.disabled = false; chatSend.disabled = false;
    emojiBtn.disabled = !capOn('emoji'); fileBtn.disabled = !capOn('file-transfer');
    revealCall();
    if (!chatOpenedShown) { chatOpenedShown = true; addChat('System', soloMode ? 'Loopback-Kanal offen.' : 'Sichere Verbindung steht – Chat ist aktiv.'); }
  };
  channel.onmessage = (e) => handleChatData(peerId, e.data);
  channel.onclose = () => { if (![...peers.values()].some((p) => p.dc && p.dc.readyState === 'open')) { chatInput.disabled = true; chatSend.disabled = true; emojiBtn.disabled = true; fileBtn.disabled = true; } };
}
// Envelope router: binary → file chunk; string → JSON control (msg/file/end) or legacy text.
function handleChatData(peerId, data) {
  if (typeof data !== 'string') { onFileChunk(peerId, data); return; }
  let m; try { m = JSON.parse(data); } catch { addChat(peerId ? peerName(peerId) : t('Gegenüber'), data); return; }
  const who = peerId ? peerName(peerId) : t('Gegenüber');
  if (m && m.k === 'msg') addChat(who, m.text);
  else if (m && m.k === 'file') onFileMeta(peerId, who, m);
  else if (m && m.k === 'end') onFileEnd(peerId, m);
  else if (m && m.k === 'screen') onPeerScreen(peerId, !!m.on);
  else if (m && m.k === 'hand') onPeerHand(peerId, !!m.on);
  else if (m && m.k === 'mic') onPeerMic(peerId, !!m.on);
  else if (m && m.k === 'cam') onPeerCam(peerId, !!m.on);
  else if (m && m.k === 'file-del') removeSharedFile(m.id, false);
  else addChat(who, data);
}
function addChat(who, text) {
  const div = document.createElement('div'); div.className = 'msg' + (who === 'System' ? ' system' : '');
  const w = document.createElement('span'); w.className = 'who'; w.textContent = who + ': ';
  const tx = document.createElement('span'); tx.textContent = text;
  div.append(w, tx); chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight;
}
// Open, ready-to-send DataChannels across all peers (+ the solo-demo loopback channel).
function openChannels() {
  const cs = [];
  for (const p of peers.values()) if (p.dc && p.dc.readyState === 'open') cs.push(p.dc);
  if (soloDc && soloDc.readyState === 'open') cs.push(soloDc);
  return cs;
}
function broadcast(obj) { const s = JSON.stringify(obj); for (const dc of openChannels()) { try { dc.send(s); } catch {} } }
function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !openChannels().length) return;
  broadcast({ k: 'msg', text });
  addChat(localNameTag.textContent || t('Du'), text); chatInput.value = '';
  emojiPalette.hidden = true;
}
// ---- meeting controls: mute / camera ----
// Toggling the LOCAL track's .enabled mutes/pauses it across every peer connection at
// once (all pcs share the same localStream tracks — no renegotiation needed).
function setToggle(btn, labelEl, on, onText, offText) {
  btn.setAttribute('aria-pressed', on ? 'false' : 'true'); // pressed = the "off" state
  btn.classList.toggle('ctrl-off', !on);
  if (labelEl) labelEl.textContent = on ? onText : offText;
}
let micMuted = false;
let camOff = false;
const peerMicMuted = new Set(); // peerIds currently muted (self-reported)
const peerCamOff = new Set();   // peerIds currently camera-off (self-reported)
function toggleAudio() {
  const tr = localStream && localStream.getAudioTracks ? localStream.getAudioTracks() : [];
  if (!tr.length) return;
  const on = !tr[0].enabled; tr.forEach((t) => (t.enabled = on));
  setToggle(micBtn, micLabel, on, t('Mikrofon'), t('Stumm'));
  micMuted = !on;
  enforceLocalMuteState(); // maßgeblich ist der Sender, nicht die Quelle
  broadcast({ k: 'mic', on });
  refreshAllBadges();
}
function toggleVideo() {
  const tr = localStream && localStream.getVideoTracks ? localStream.getVideoTracks() : [];
  if (!tr.length) return;
  const on = !tr[0].enabled; tr.forEach((t) => (t.enabled = on));
  setToggle(camBtn, camLabel, on, t('Kamera'), t('Kamera aus'));
  localVideo.style.opacity = on ? '' : '0.35';
  camOff = !on;
  enforceLocalMuteState();
  broadcast({ k: 'cam', on });
  refreshAllBadges();
}
function onPeerMic(peerId, on) {
  if (!peerId) return;
  if (on) peerMicMuted.delete(peerId); else peerMicMuted.add(peerId);
  refreshAllBadges();
}
function onPeerCam(peerId, on) {
  if (!peerId) return;
  if (on) peerCamOff.delete(peerId); else peerCamOff.add(peerId);
  refreshAllBadges();
}
function showMediaControls() {
  // Community; also depends on localStream and the mode — before a call there is nothing to
  // toggle, regardless of the edition.
  const on = capOn('meeting-controls');
  const hasAudio = localStream && localStream.getAudioTracks && localStream.getAudioTracks().length;
  const hasVideo = localStream && localStream.getVideoTracks && localStream.getVideoTracks().length;
  micBtn.hidden = !(on && hasAudio);
  camBtn.hidden = !(on && hasVideo && mode === 'video');
}
micBtn.addEventListener('click', toggleAudio);
camBtn.addEventListener('click', toggleVideo);

// ---- raise hand: signaled over the chat DataChannel ({ k:'hand', on }) ----
// Indicator lives on the person's tile (✋ badge) AND on the participant chips, so it
// also works in chat/audio mode where there are no tiles.
let handRaised = false;
const handsUp = new Set(); // peerIds with a raised hand
function updateHandBadges() {
  refreshAllBadges(); // tile badge (video mode)
  if (lastStatusMsg) updateChips(lastStatusMsg); // chips carry the ✋ in chat/audio mode
}
function toggleHand() {
  handRaised = !handRaised;
  handBtn.setAttribute('aria-pressed', handRaised ? 'true' : 'false');
  handLabel.textContent = handRaised ? t('Hand senken') : t('Hand heben');
  broadcast({ k: 'hand', on: handRaised });
  updateHandBadges();
}
function onPeerHand(peerId, on) {
  if (!peerId) return;
  if (on) handsUp.add(peerId); else handsUp.delete(peerId);
  addChat('System', '✋ ' + peerName(peerId) + ' ' + t(on ? 'hat die Hand gehoben.' : 'hat die Hand gesenkt.'));
  updateHandBadges();
}
handBtn.addEventListener('click', toggleHand);

// ---- file transfer over the chat DataChannel ----
const FILE_CHUNK = 16 * 1024;          // 16 KB chunks
const FILE_BUFFER_MAX = 4 * 1024 * 1024; // pause sending when a channel is backlogged
const incoming = new Map();            // peerId -> { name, size, mime, chunks, received, ui }
// Completed file rows by transfer id — lets the SENDER retract a shared file: a
// {k:'file-del', id} broadcast replaces the row everywhere and revokes the blob URL.
// Honest limit: a copy the receiver already saved to disk stays on their device.
const fileRows = new Map();            // id -> { div, url? }
let fileBusy = false;

function removeSharedFile(id, mine) {
  const row = fileRows.get(id);
  if (!row) return;
  fileRows.delete(id);
  if (row.url) { try { URL.revokeObjectURL(row.url); } catch {} }
  row.div.className = 'msg system';
  row.div.textContent = '🗑 ' + t(mine ? 'Du hast die geteilte Datei entfernt.' : 'Der Absender hat die geteilte Datei entfernt.');
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
// Render a file row in the chat log; returns handles to update it.
function addFileRow(dir, name, size) {
  const div = document.createElement('div'); div.className = 'msg file';
  const label = document.createElement('div'); label.className = 'file-label';
  label.textContent = (dir === 'out' ? '↑ ' : '↓ ') + name + ' · ' + fmtBytes(size);
  const bar = document.createElement('div'); bar.className = 'file-bar';
  const fill = document.createElement('span'); bar.appendChild(fill);
  div.append(label, bar); chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight;
  return { div, label, fill, bar };
}
function setFileProgress(ui, frac) { ui.fill.style.width = Math.round(frac * 100) + '%'; }

async function sendFile(file) {
  const channels = openChannels();
  if (!file || !channels.length || fileBusy) return;
  fileBusy = true; fileBtn.disabled = true;
  try {
    const id = Math.random().toString(36).slice(2);
    broadcast({ k: 'file', id, name: file.name, size: file.size, mime: file.type });
    const ui = addFileRow('out', file.name, file.size);
    const buf = new Uint8Array(await file.arrayBuffer());
    let off = 0;
    while (off < buf.byteLength) {
      // backpressure: wait if any channel is backlogged
      if (Math.max(0, ...channels.map((dc) => dc.bufferedAmount)) > FILE_BUFFER_MAX) {
        await new Promise((r) => setTimeout(r, 40)); continue;
      }
      const end = Math.min(off + FILE_CHUNK, buf.byteLength);
      const chunk = buf.subarray(off, end);
      for (const dc of channels) { if (dc.readyState === 'open') { try { dc.send(chunk); } catch {} } }
      off = end;
      setFileProgress(ui, off / buf.byteLength);
    }
    broadcast({ k: 'end', id });
    setFileProgress(ui, 1);
    ui.label.textContent = '↑ ' + file.name + ' · ' + fmtBytes(file.size) + ' ✓';
    ui.bar.classList.add('done');
    // Sender may retract the file: removes the row on ALL sides (already-saved copies
    // on a receiver's disk are out of reach — that's disclosed in the docs).
    fileRows.set(id, { div: ui.div });
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'file-del';
    del.textContent = t('Löschen');
    del.addEventListener('click', () => { broadcast({ k: 'file-del', id }); removeSharedFile(id, true); });
    ui.div.appendChild(del);
  } finally { fileBusy = false; fileBtn.disabled = false; }
}
function onFileMeta(peerId, who, m) {
  const key = peerId || '__solo__';
  const ui = addFileRow('in', m.name, m.size);
  incoming.set(key, { id: m.id, name: m.name, size: m.size, mime: m.mime, chunks: [], received: 0, ui, who });
}
function onFileChunk(peerId, data) {
  const key = peerId || '__solo__';
  const rec = incoming.get(key); if (!rec) return;
  const buf = data instanceof ArrayBuffer ? data : (data.buffer || data);
  rec.chunks.push(buf); rec.received += buf.byteLength;
  setFileProgress(rec.ui, rec.size ? rec.received / rec.size : 0);
}
function onFileEnd(peerId) {
  const key = peerId || '__solo__';
  const rec = incoming.get(key); if (!rec) return;
  incoming.delete(key);
  const blob = new Blob(rec.chunks, { type: rec.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  rec.ui.label.textContent = '';
  const a = document.createElement('a');
  a.href = url; a.download = rec.name; a.textContent = '↓ ' + rec.name + ' · ' + fmtBytes(rec.size) + ' — ' + t('herunterladen');
  a.className = 'file-dl';
  rec.ui.label.appendChild(a);
  setFileProgress(rec.ui, 1); rec.ui.bar.classList.add('done');
  if (rec.id) fileRows.set(rec.id, { div: rec.ui.div, url }); // enable sender-initiated retraction
}
fileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { const f = fileInput.files && fileInput.files[0]; if (f) sendFile(f); fileInput.value = ''; });

// ---- QES im Call: Dokument teilen & gemeinsam durchgehen (Community, `qes-in-call`) ----
// Phase 1 of public/qes/: P2P document transfer over a dedicated 'qes'
// DataChannel with hash verification + resume, rendered with self-hosted pdf.js.
// Everything lives in the lazy-loaded module public/qes/doc-share.js — app.js only
// routes the channel (getPeer) and provides this thin glue. v1 is 1:1.
const docBtn = $('doc-btn');
const docInput = $('doc-input');
const qesBox = $('qes-box');
let qesShare = null;         // resolved module instance (created on first use)
let qesLoading = null;
// Doc-share module toggles qes-box's [hidden] directly (no callback into app.js for
// every step) — observe it so the tile "document active" badge stays in sync without
// threading a new hook through the module.
new MutationObserver(refreshAllBadges).observe(qesBox, { attributes: true, attributeFilter: ['hidden'] });
function qesCtx() {
  return {
    // v1: exactly one peer (the button is hidden otherwise); mesh order comes later.
    getPeer: () => {
      const [entry] = [...peers.entries()];
      return entry ? { peerId: entry[0], pc: entry[1].pc, name: entry[1].name ? titleCase(entry[1].name) : '' } : null;
    },
    // Own verified PID names (post-reveal) — subject of the DEMO signing certificate,
    // so the identity-binding demo (Phase 4) can match cert ↔ PID end-to-end.
    getSelfIdentity: () => {
      const c = (lastStatusMsg && lastStatusMsg.revealed && lastStatusMsg.self.claims) || {};
      return { givenName: c.given_name ? titleCase(c.given_name) : '', familyName: c.family_name ? titleCase(c.family_name) : '' };
    },
    // The PEER's verified PID names — the reference the signer's certificate is
    // matched against ("Unterzeichner = verifizierter Gesprächspartner").
    getPeerIdentity: (peerId) => {
      const peer = ((lastStatusMsg && lastStatusMsg.revealed && lastStatusMsg.peers) || []).find((p) => p.peerId === peerId);
      const c = (peer && peer.claims) || {};
      return { givenName: c.given_name ? titleCase(c.given_name) : '', familyName: c.family_name ? titleCase(c.family_name) : '' };
    },
    // Identity-binding result for a signer → shown on that person's tile banderole.
    onBinding: (peerId, binding) => {
      const p = peers.get(peerId);
      if (p) p.qesBinding = binding;
    },
    addChat,
    onIdle: updateDocBtn,
  };
}
function qes() {
  if (qesShare) return Promise.resolve(qesShare);
  if (!qesLoading) {
    qesLoading = import('./qes/doc-share.js')
      .then((m) => { qesShare = m.createDocShare(qesCtx()); return qesShare; })
      .catch((e) => { qesLoading = null; console.warn('qes module failed to load:', e && e.message); throw e; });
  }
  return qesLoading;
}
// Incoming 'qes' channel (routed by label in getPeer) — loads the module on demand.
function qesAdoptChannel(peerId, channel) {
  if (!capOn('qes-in-call')) { try { channel.close(); } catch {} return; }
  qes().then((q) => q.adoptChannel(peerId, channel)).catch(() => {});
}
function updateDocBtn() {
  docBtn.hidden = !(capOn('qes-in-call') && callStarted && !ended && peers.size === 1);
}
docBtn.addEventListener('click', () => docInput.click());
docInput.addEventListener('change', () => {
  const f = docInput.files && docInput.files[0];
  if (f) qes().then((q) => q.share(f)).catch(() => setStatus('Dokument-Modul konnte nicht geladen werden.'));
  docInput.value = '';
});

// ---- emoji picker ----
const EMOJIS = ['😀','😂','😉','😍','😎','🤔','👍','👏','🙏','🎉','❤️','🔥','✅','⭐','👋','🤝','💡','📎','📅','🚀','😅','🙌','👀','💬'];
let emojiBuilt = false;
function buildEmojiPalette() {
  if (emojiBuilt) return; emojiBuilt = true;
  for (const em of EMOJIS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'emoji'; b.textContent = em;
    b.addEventListener('click', () => insertEmoji(em));
    emojiPalette.appendChild(b);
  }
}
function insertEmoji(em) {
  const i = chatInput;
  const s = i.selectionStart ?? i.value.length, e = i.selectionEnd ?? i.value.length;
  i.value = i.value.slice(0, s) + em + i.value.slice(e);
  const pos = s + em.length; i.focus(); try { i.setSelectionRange(pos, pos); } catch {}
}
emojiBtn.addEventListener('click', () => { buildEmojiPalette(); emojiPalette.hidden = !emojiPalette.hidden; });
document.addEventListener('click', (e) => { if (!emojiPalette.hidden && !emojiPalette.contains(e.target) && e.target !== emojiBtn && !emojiBtn.contains(e.target)) emojiPalette.hidden = true; });

chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
hangupBtn.addEventListener('click', hangUp);
screenBtn.addEventListener('click', toggleScreenShare);
// Both cases — room full OR call ended — want the same thing: a new room.
restartBtn.addEventListener('click', startFreshCall);

// An unreadable ?inv=… : do not even connect (there is no room we could enter) — otherwise the
// roomId derivation above would silently create a FRESH ad-hoc room, and the invitee would stand
// there as host in an empty call.
if (inviteToken && !inviteCfg) showInviteProblem('malformed');
else connect();
// Warm up the ICE configuration and then check ONCE whether this network can carry a call at all.
// The check gets exactly these iceServers — if it kept its own, it would be testing something
// other than the later call.
refreshIce().then(runNetworkCheck); // refreshed again before each peer connection
refreshCaps(); // UI an /capabilities ausrichten
postToParent('ready', { room: roomId }); // tell the embedding page the widget loaded

// ---- version badge (footer) ----
// Reads the committed public/version.json so the current build/version is always
// visible in the UI. Fails silently if the file is missing.
(function showVersion() {
  const el = $('app-version');
  if (!el) return;
  fetch('version.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((v) => {
      if (!v || !v.version) { el.hidden = true; return; }
      el.textContent = `v${v.version}`;
      el.title = `Version ${v.version} · ${v.commit || 'dev'} · ${v.date || ''}`.trim();
    })
    .catch(() => { el.hidden = true; });
})();

// ---- native app shell: bottom tab bar (Anruf / Einstellungen) --------------
// Only in the Capacitor app (isNativeApp()); the website keeps its footer pills.
(function initAppShell() {
  if (!isNativeApp()) return;
  document.documentElement.classList.add('native-app'); // safety net for the head script
  const tabbar = $('app-tabbar'), settingsBox = $('app-settings');
  if (!tabbar || !settingsBox) return;
  // move the footer meta controls into the settings rows (element move, wiring intact;
  // lang-switch visibility stays owned by i18n.js — it unhides only with >1 locale)
  const move = (id, slotId, show) => { const el = $(id), slot = $(slotId); if (el && slot) { slot.appendChild(el); if (show) el.hidden = false; } };
  move('lang-switch', 'settings-lang-slot', false);
  move('theme-toggle', 'settings-theme-slot', true);
  move('app-version', 'settings-version-slot', true);
  const setTab = (tab) => {
    document.body.dataset.tab = tab;
    settingsBox.hidden = tab !== 'settings';
    tabbar.querySelectorAll('.tab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
  };
  tabbar.addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.tab); });
  tabbar.hidden = false;
  setTab('call');

  // "New call" (settings tab): load a fresh room URL — index.html without ?room= creates a new
  // room at boot. A reset, rather than having to restart the app.
  if (newCallBtn) newCallBtn.addEventListener('click', startFreshCall);

  // ---- universal links: a tapped https://…/?room=… opens the APP (associated
  // domains, see App.entitlements + server EUDI_IOS_APP_ID). Route the room into
  // the local bundle — cold start (launch url) and while running (appUrlOpen).
  const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp) {
    const openRoomUrl = (url) => {
      try {
        const target = new URL(url).searchParams.get('room');
        if (target && target !== roomId) location.href = `index.html?room=${encodeURIComponent(target)}`;
      } catch { /* not a room link — ignore */ }
    };
    CapApp.addListener('appUrlOpen', (e) => { if (e && e.url) openRoomUrl(e.url); });
    CapApp.getLaunchUrl().then((r) => { if (r && r.url) openRoomUrl(r.url); }).catch(() => {});
  }

  // ---- in-call trust bar: shield + names + SAS code, expandable ------------
  // Data is mirrored from the existing UI (chips + #sas-code) via observers, so
  // there is no second source of truth; chip prefixes/checkmarks are stripped.
  const trustBar = $('trust-bar'), trustNames = $('trust-names'), trustSas = $('trust-sas');
  if (trustBar && trustNames && trustSas) {
    const junk = () => new Set([t('bestätigt'), t('verifiziert'), t('Du'), t('Gast'), t('Gastgeber:in')]);
    const stripChip = (s) => s.replace(/✓/g, '').replace(/^[^:]*:\s*/, '').trim();
    const refreshTrust = () => {
      const inCall = document.body.classList.contains('in-call');
      trustBar.hidden = !inCall;
      if (!inCall) return;
      const drop = junk();
      const names = [stripChip(selfLabel.textContent || '')];
      document.querySelectorAll('#peer-chips .id-chip span:last-of-type').forEach((el) => names.push(stripChip(el.textContent || '')));
      const clean = names.filter((n) => n && !drop.has(n));
      trustNames.textContent = clean.length ? clean.join(' ↔ ') : t('Verifizierter Anruf');
      trustSas.textContent = (sasCode.textContent || '').trim();
    };
    trustBar.addEventListener('click', () => {
      const open = document.body.classList.toggle('trust-open');
      trustBar.setAttribute('aria-expanded', String(open));
    });
    const obs = new MutationObserver(refreshTrust);
    const idsBox = $('identities');
    if (idsBox) obs.observe(idsBox, { subtree: true, childList: true, characterData: true });
    obs.observe(sasCode, { subtree: true, childList: true, characterData: true });
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    refreshTrust();
  }
})();

// ---- setup wizard (mobile/app): 4 steps ------------------------------------
// 1 Verbindungsart · 2 Ich teile · 3 Gast teilt · 4 Einladen. Presentation only:
// body.wizard + data-wkind drive CSS visibility; app logic's [hidden] flags keep
// authority (a hidden #auth stays hidden on step 4). The mode deactivates itself
// whenever #setup is hidden (guest view, call started) — those flows are linear
// already and must not lose their boxes to wizard CSS.
(function initSetupWizard() {
  const setup = $('setup'), nav = $('wiz-nav'), back = $('wiz-back'), next = $('wiz-next'), dots = $('wiz-dots');
  if (!setup || !nav) return;
  if (isEmbedded) return;
  const small = () => window.matchMedia('(max-width: 640px)').matches;
  if (!isNativeApp() && !small()) return;

  // Step kinds: mode · you · guest · invite · (auth, only when the host has to identify
  // themselves). The identification step shows the invite box collapsed beneath it.
  const shareEl = $('share'), authEl = $('auth');
  let idx = 0;
  const steps = () => {
    const s = ['mode', 'you', 'guest', 'invite'];
    if (authEl && !authEl.hidden) s.push('auth');
    return s;
  };
  const render = () => {
    const st = steps();
    if (idx >= st.length) idx = st.length - 1;
    if (idx < 0) idx = 0;
    const kind = st[idx];
    document.body.dataset.wkind = kind;
    dots.innerHTML = '';
    st.forEach((_, i) => { const d = document.createElement('span'); d.className = 'dot' + (i === idx ? ' active' : i < idx ? ' done' : ''); dots.appendChild(d); });
    back.disabled = idx === 0;
    next.hidden = idx === st.length - 1;
    if (shareEl) shareEl.classList.toggle('wiz-collapsed', kind === 'auth');
  };
  const go = (delta) => { const st = steps(); idx = Math.min(Math.max(idx + delta, 0), st.length - 1); render(); setup.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  back.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  // Fold the invite box on the identification step open or shut
  if (shareEl) { const h = shareEl.querySelector('h2'); if (h) h.addEventListener('click', () => { if (document.body.dataset.wkind === 'auth') shareEl.classList.toggle('wiz-collapsed'); }); }

  const syncActive = () => {
    const on = !setup.hidden;
    document.body.classList.toggle('wizard', on);
    if (on) render();
  };
  new MutationObserver(syncActive).observe(setup, { attributes: true, attributeFilter: ['hidden'] });
  // The visibility of #auth changes the step count -> re-render on change
  if (authEl) new MutationObserver(() => { if (!setup.hidden) render(); }).observe(authEl, { attributes: true, attributeFilter: ['hidden'] });
  syncActive();
})();
