// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/* whosit — browser client (signaling + WebRTC).
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
// server: window.EUDI_APP_CONFIG.apiBase (injected by the native app's build)
// overrides the base for API calls, the WebSocket, and invite links. In the
// browser it is undefined and everything stays relative (same-origin).
const APP_CONFIG = window.EUDI_APP_CONFIG || null;
// The address the page was opened with — boot adds ?room= for a new call, so read this, not location.
const LAUNCH_QUERY = new URLSearchParams(location.search);
const API_BASE = (APP_CONFIG && APP_CONFIG.apiBase) ? APP_CONFIG.apiBase.replace(/\/+$/, '') : '';
function apiUrl(path) { return API_BASE ? `${API_BASE}/${path}` : path; }
function wsUrl() {
  if (API_BASE) return API_BASE.replace(/^http/, 'ws');
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}
function isNativeApp() { return !!(APP_CONFIG && APP_CONFIG.native) || !!window.Capacitor; }
// Haptics, app only: the native plugin rather than navigator.vibrate — iOS WebKit has none, and a
// web page buzzing the phone would surprise more than help. An app build without the plugin gets
// nothing. iOS honours the system's "System Haptics" switch on its own.
function haptic(kind) {
  const h = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
  if (!h) return;
  try {
    const p = kind === 'success' || kind === 'error' ? h.notification({ type: kind.toUpperCase() })
      : h.impact({ style: kind === 'medium' ? 'MEDIUM' : 'LIGHT' });
    Promise.resolve(p).catch(() => {});
  } catch { /* not there after all */ }
}
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
let actionsOffered = false; // /capabilities `actions`: a module offers actions in a call (see below)
/** EUDI_VERIFIER=none on the server: nobody is verified, both sides stay anonymous. */
let verifierOff = false;
/** A tenant instance with a host gate: setup is preceded by a sign-in. */
let hostLoginRequired = false;
/**
 * Who the wallet will name as asking, when the page carries someone else's name (see
 * src/relying-party.ts). Default: disclose nothing — an unbranded instance has nothing to
 * disclose, and a failed /capabilities fetch must not invent an accusation.
 */
let rpDisclosure = { name: null, onBehalfOf: null, disclose: false };
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
// The operator's choices for the setup (src/operator-ui.ts): preselection, quick picks, wording.
let operatorUi = null;
function allowedAttrKeys() {
  if (wrpPolicy && Array.isArray(wrpPolicy.allowedAttributes)) {
    return ATTRIBUTES.map((a) => a.key).filter((k) => wrpPolicy.allowedAttributes.includes(k));
  }
  return ATTRIBUTES.filter((a) => !a.policyOnly).map((a) => a.key);
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
      operatorUi = j.ui && typeof j.ui === 'object' ? j.ui : null;
      hostLoginRequired = j.hostLogin === true;
      verifierOff = j.verifier === 'none';
      if (j.relyingParty && typeof j.relyingParty === 'object') rpDisclosure = j.relyingParty;
      actionsOffered = j.actions === true;
    }
  } catch { /* keep defaults (all off, local whitelist mirror) */ }
  applyCapabilities();
  renderBgPickers();
  applyVerifierMode();
  applyPolicyTexts();
  applyRelyingPartyDisclosure();
  applyOperatorUi();
  refreshCredCatalog(); // credential catalog — no-op when none is configured
}
/**
 * The operator's wording, quick picks and preselection, once /capabilities has answered. A setup
 * already on screen is rebuilt from it — unless someone has touched it, or its content is fixed by
 * an invitation or an embedder.
 */
function applyOperatorUi() {
  i18nReady.then(() => {
    setI18nOverrides(operatorUi && operatorUi.texte);
    renderPresets();
    if (!setupBuilt) return;
    if (!setupLocked && !setupTouched && !inviteCfg && !embedCfg) rebuildChecklists();
    else { const c = currentAttrs(); updatePreview(c.requestedAttrs, c.disclosedAttrs); }
  });
}
/**
 * State who is actually asking, before the wallet opens.
 *
 * Two wordings, and the difference matters. When the operator has named the certificate holder
 * we can say WHO asks and on whose behalf — which is the sentence that makes the arrangement
 * understandable. When they have not (EUDI_RP_NAME unset), we can only say who it is NOT. That
 * is less useful to the reader and less flattering to the operator, deliberately: the fix is one
 * variable, and the incentive should point at setting it rather than at leaving it out.
 *
 * There is no third wording in which nothing is said. Whether the sentence appears is decided by
 * the server (`relyingParty.disclose`), and the server decides it from the tenant, not from a
 * switch an operator can flip.
 */
function applyRelyingPartyDisclosure() {
  const el = document.getElementById('rp-disclosure');
  if (!el) return;
  const show = rpDisclosure && rpDisclosure.disclose === true && rpDisclosure.onBehalfOf;
  el.hidden = !show;
  if (!show) { el.textContent = ''; return; }
  el.textContent = rpDisclosure.name
    ? t('Die Ausweisabfrage stellt {rp} im Auftrag von {brand}.', { rp: rpDisclosure.name, brand: rpDisclosure.onBehalfOf })
    : t('Die Ausweisabfrage stellt nicht {brand}, sondern der Betreiber dieser Instanz.', { brand: rpDisclosure.onBehalfOf });
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
// The muted hint and the background picker float just above the call controls (style.css,
// --cc-h). The bar's height is not fixed — one row on a phone, two when the host also has the
// Pro actions — so it is measured rather than assumed. A hidden bar (0) keeps the last value.
if (window.ResizeObserver) {
  new ResizeObserver(() => {
    const h = callControls.offsetHeight;
    if (h) document.documentElement.style.setProperty('--cc-h', h + 'px');
  }).observe(callControls);
}
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
const mediaNotice = $('media-notice');
const mediaNoticeText = $('media-notice-text');
const mediaRetryBtn = $('media-retry-btn');
const reviewReady = $('review-ready');
const inviteLockNote = $('invite-lock-note');
const emojiBtn = $('emoji-btn');
const emojiPalette = $('emoji-palette');
const fileBtn = $('file-btn');
const fileInput = $('file-input');

// setStatus translates centrally (t() falls back to the German source), so every call
// site keeps its readable German literal. The raw source is kept so the bar can be
// re-translated once the async dictionary arrives (first messages fire before load).
function statusState(msg) {
  const x = String(msg);
  if (/Fehler|fehlgeschlagen|nicht geklappt|verloren|voll|abgelehnt|nicht unterst/i.test(x)) return 'error';
  if (/Weise dich|weise dich|Bitte Kamera|Prüfe, was/i.test(x)) return 'prompt';
  if (/wartet|warte|ausstehend|wird aufgebaut|betreten|neu verbinden/i.test(x)) return 'wait';
  if (/✓|zugestimmt|geschafft|steht\.|Verbunden/i.test(x)) return 'ok';
  return 'info';
}
const statusText = $('status-text'), statusKicker = $('status-kicker');
function setStatus(msg, state) { statusBar.dataset.raw = msg; statusBar.dataset.state = state || statusState(msg); statusText.textContent = t(msg); }
i18nReady.then(() => { if (statusBar.dataset.raw) setStatus(statusBar.dataset.raw); });
function setLocalLabel(name) { localNameTag.textContent = name ? name + ' · ' + t('Du') : t('Du'); }

// ---- attributes / formatting ----
// Requestable attributes = the WRP whitelist (server: src/wrp-policy.ts). This list is a
// MIRROR for labels/icons, not the authority: the server narrows or refuses anything
// outside its own whitelist, and /capabilities publishes the authoritative set, which
// allowedAttrKeys() below reconciles against this list.
const ATTRIBUTES = [
  { key: 'family_name', label: 'Nachname' },
  { key: 'given_name', label: 'Vorname' },
  // Only where the instance's policy lists them (a purpose such as tenant screening): never part of
  // the local default before /capabilities has answered, so an instance on the narrow standard
  // policy does not offer them for a moment and then take them back.
  { key: 'birth_date', label: 'Geburtsdatum', policyOnly: true },
  { key: 'nationality', label: 'Staatsangehörigkeit', policyOnly: true },
  { key: 'address', label: 'Anschrift', policyOnly: true },
  { key: 'age_over_18', label: 'Über 18 Jahre', note: 'ohne Geburtsdatum' },
  // Derived server-side (HMAC, per room, gone with the process) — not a wallet claim.
  // Only meaningful IN ADDITION to a real attribute; on its own it is not verification.
  { key: 'pseudonym_id', label: 'Pseudonym', note: 'einmalige Kennung — nur zusammen mit einer weiteren Angabe' },
];
// The quick picks above the list: only an operator's own (/capabilities `ui.schnellwahl`,
// src/operator-ui.ts), named after their purpose. There used to be three built-in ones, but on
// the standard policy's four rows they only ticked the same boxes a second time. See renderPresets().
let presets = [];
const labelFor = (k) => (ATTRIBUTES.find((a) => a.key === k) || {}).label || k;
const modeLabel = (m) => (m === 'audio' ? 'Audio' : m === 'chat' ? 'Chat' : 'Video');

// per-attribute Lucide-style icons (inner SVG markup), shown in checklists + data rows
const ATTR_ICONS = {
  family_name: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  given_name: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  age_over_18: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
  pseudonym_id: '<path d="M2 12h4l3-9 4 18 3-9h6"/>',
  birth_date: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  nationality: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  address: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
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
    case 'birth_date': return claims.birth_date != null ? { label: 'Geburtsdatum', value: formatBirthDate(claims.birth_date) } : null;
    case 'nationality': return claims.nationality != null ? { label: 'Staatsangehörigkeit', value: [].concat(claims.nationality).join(', ') } : null;
    case 'address': { const a = formatAddress(claims.address); return a ? { label: 'Anschrift', value: a } : null; }
    // Not a wallet claim: derived by the server per room, gone when the process restarts.
    case 'pseudonym_id': return claims.pseudonym_id != null ? { label: 'Pseudonym', value: String(claims.pseudonym_id) } : null;
    default: return null;
  }
}
// ISO date from the wallet (YYYY-MM-DD) in the reader's own format; anything else as it came.
function formatBirthDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  if (!m) return String(v);
  try { return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString(i18nLocale, { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return String(v); }
}
// The address in the shape the server delivers for both formats (src/credential-profiles.ts,
// RECONSTRUCT.address): street, postcode and town, country — one line, as text.
function formatAddress(v) {
  if (v == null) return '';
  if (typeof v !== 'object') return String(v);
  if (typeof v.formatted === 'string' && v.formatted.trim()) return v.formatted.trim();
  const ort = [v.postal_code, v.locality].filter((x) => x != null && x !== '').join(' ');
  return [v.street_address, ort, v.country].filter((x) => x != null && x !== '').map(String).join(', ');
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
    // A lock and words instead of "•••", which read like something still loading.
    const val = document.createElement('span'); val.className = 'r-value masked';
    val.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
    const vt = document.createElement('span'); vt.textContent = t('nach Zustimmung'); val.appendChild(vt);
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
  // What the server derives itself (the pseudonym) is folded away under "Weitere Angaben": it is
  // the row nobody understands at first sight and is only useful next to a real attribute. Open
  // from the start when it is already chosen (invitation, embed, operator preselection).
  const derived = derivedKeys();
  let more = null;
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
    if (derived.includes(a.key)) {
      if (!more) {
        more = document.createElement('details'); more.className = 'attr-more';
        const sum = document.createElement('summary'); sum.textContent = t('Weitere Angaben');
        more.appendChild(sum); container.appendChild(more);
      }
      if (cb.checked) more.open = true;
      more.appendChild(row);
    } else container.appendChild(row);
  }
}
// Ticked when the setup opens: the operator's preselection, else the family name.
function ownDefault(side) {
  const v = operatorUi && operatorUi.vorauswahl;
  return sanitizeKeys(v && v[side], ['family_name']);
}
let setupTouched = false;
/**
 * The two lists again, from the policy and the operator's preselection that /capabilities has
 * brought since the setup was first drawn — and the result sent, so the room holds what is shown.
 */
function rebuildChecklists() {
  requestListEl.innerHTML = '';
  discloseListEl.innerHTML = '';
  buildChecklist(requestListEl, 'request', ownDefault('anfragen'));
  buildChecklist(discloseListEl, 'disclose', ownDefault('teilen'));
  onConfigChange();
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
  // Embed config seeds the initial requested/disclosed attributes.
  // Scheduled call: the agreed scope comes from the invitation. Without this, setup would show the
  // local defaults, i.e. something other than what the server actually holds.
  const reqDefault = inviteCfg ? sanitizeKeys(inviteCfg.request, [])
    : embedCfg ? sanitizeKeys(embedCfg.request, requestMode === 'anon' ? [] : ['family_name']) : ownDefault('anfragen');
  const discDefault = inviteCfg ? sanitizeKeys(inviteCfg.disclose, [])
    : embedCfg ? sanitizeKeys(embedCfg.disclose, []) : ownDefault('teilen');
  buildChecklist(requestListEl, 'request', reqDefault);
  buildChecklist(discloseListEl, 'disclose', discDefault);
  // Delegated: renderPresets() replaces the buttons when the policy or the operator's picks arrive.
  presetsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset]');
    if (btn && !btn.disabled) applyPreset(btn.dataset.preset);
  });
  // Someone choosing is what stops a late /capabilities from rebuilding the lists under them.
  setupBox.addEventListener('change', (e) => { if (e.isTrusted) setupTouched = true; }, true);
  setupBox.addEventListener('click', (e) => { if (e.isTrusted && e.target.closest('button')) setupTouched = true; }, true);
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
  // Screen readers hear which option of a segmented control is chosen — `.active` alone is only
  // visible. Mirrored from the class, which stays the one source the rest of the code sets.
  for (const seg of document.querySelectorAll('.seg')) {
    const sync = () => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.classList.contains('active'))));
    sync();
    new MutationObserver(sync).observe(seg, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  // "Allow more guests later" — only meaningful with the multi-party capability.
  openroomRow.hidden = !capOn('multi-party');
  openroomToggle.addEventListener('change', onConfigChange);
  const c = currentAttrs();
  updatePreview(c.requestedAttrs, c.disclosedAttrs);
  syncPresetChips();
  if (embedCfg) {
    onConfigChange(); // push the embed-seeded config to the server
    if (embedCfg.lock) lockSetup(); // embedder pinned the config → read-only
  } else if (!inviteCfg && operatorUi && operatorUi.vorauswahl) {
    onConfigChange(); // the operator's preselection differs from the room's default → send it
  }
  // Scheduled call: pinned. No set-config — the server refuses it for this room anyway (the
  // agreed scope is in the invitation, which the guest consented to).
  if (inviteCfg) lockSetup();
  applyVerifierMode(); // /capabilities may have answered before the setup existed

}
/**
 * An instance without a verifier (EUDI_VERIFIER=none): both directions fixed to anonymous, the
 * "share data" choices locked with the reason next to them, and the test-mode banner on the page
 * for host AND guest. Presentation only — the server refuses any attribute on such an instance
 * (set-config, src/server.ts) and empties the room's defaults itself.
 */
function applyVerifierMode() {
  const banner = document.getElementById('testmode-banner');
  if (banner) banner.hidden = !verifierOff;
  // Texts that claim a wallet check swap for their test-mode counterpart (index.html).
  document.querySelectorAll('[data-verified-only]').forEach((el) => { el.hidden = verifierOff; });
  document.querySelectorAll('[data-testmode-only]').forEach((el) => { el.hidden = !verifierOff; });
  const hint = document.getElementById('noverifier-hint');
  if (hint) hint.hidden = !verifierOff || !setupBuilt;
  if (!verifierOff || !setupBuilt) return;
  for (const btn of [discloseSeg.querySelector('[data-disclose="data"]'), requestSeg.querySelector('[data-request="data"]')]) {
    if (!btn) continue;
    btn.setAttribute('data-locked', '');
    btn.setAttribute('aria-disabled', 'true');
    btn.title = t('Ohne Ausweisprüfung auf dieser Instanz nicht verfügbar');
  }
  presetsEl.querySelectorAll('[data-preset]').forEach((b) => { b.disabled = true; });
  if (discloseMode !== 'anon' || requestMode !== 'anon') {
    discloseMode = 'anon'; requestMode = 'anon';
    discloseSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.disclose === 'anon'));
    requestSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.request === 'anon'));
    discloseListEl.hidden = true;
    requestExtra.hidden = true;
    onConfigChange();
  }
}
function setDiscloseMode(m) {
  if (verifierOff && m !== 'anon') return; // locked: see applyVerifierMode
  discloseMode = m;
  discloseSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.disclose === m));
  discloseListEl.hidden = m === 'anon';
  if (m === 'data' && attrsChecked('disclose').length === 0) { const cb = document.getElementById('disclose-family_name'); if (cb) cb.checked = true; }
  onConfigChange();
}
function setRequestMode(m) {
  if (verifierOff && m !== 'anon') return;
  requestMode = m;
  requestSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.request === m));
  requestExtra.hidden = m === 'anon';
  if (m === 'data' && attrsChecked('request').length === 0) { const cb = document.getElementById('request-family_name'); if (cb) cb.checked = true; }
  onConfigChange();
}
function attrsChecked(prefix) { return ATTRIBUTES.map((a) => a.key).filter((k) => { const cb = document.getElementById(prefix + '-' + k); return cb && cb.checked; }); }
/**
 * The quick-pick buttons: the operator's (`ui.schnellwahl`), none otherwise. A pick reduced to
 * nothing by the policy is not shown.
 */
function renderPresets() {
  const allowed = allowedAttrKeys();
  const own = operatorUi && Array.isArray(operatorUi.schnellwahl) ? operatorUi.schnellwahl : [];
  presets = own.map((p, i) => ({ id: 'own-' + i, label: (p.name && (p.name[i18nLocale] || p.name.de)) || '', keys: (p.angaben || []).filter((k) => allowed.includes(k)) }))
    .filter((p) => p.label && p.keys.length);
  presetsEl.querySelectorAll('[data-preset]').forEach((b) => b.remove());
  for (const p of presets) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip-btn'; b.dataset.preset = p.id; b.textContent = p.label;
    b.disabled = verifierOff || setupLocked;
    presetsEl.appendChild(b);
  }
  presetsEl.hidden = presets.length === 0;
  syncPresetChips();
}
function applyPreset(name) {
  if (verifierOff) return;
  const keys = (presets.find((p) => p.id === name) || {}).keys || [];
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
    for (const a of ATTRIBUTES) {
      const cb = document.getElementById(prefix + '-' + a.key); if (!cb) continue;
      cb.checked = keys.includes(a.key);
      const more = cb.closest('details'); if (more && cb.checked) more.open = true; // never a hidden tick
    }
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
const previewMode = $('preview-mode');
// Whether the guest is asked for anything — only then do invitations say to set up the wallet.
let guestNeedsWallet = true;
function updatePreview(req, disc) {
  guestNeedsWallet = !!(req && req.length);
  const inviteWalletNote = $('invite-wallet-note');
  if (inviteWalletNote) inviteWalletNote.hidden = !guestNeedsWallet;
  if (previewMode) previewMode.textContent = mode === 'audio' ? t('Audio') : mode === 'chat' ? t('Chat') : t('Video');
  previewDisclose.textContent = disc && disc.length ? disc.map((k) => t(labelFor(k))).join(', ') : t('nichts (anonym)');
  previewRequest.textContent = req && req.length ? req.map((k) => t(labelFor(k))).join(', ') : t('nichts (anonym)');
}
// Presets are shortcuts, not state: highlight one only while the checked set matches it.
function syncPresetChips() {
  const key = (requestMode === 'anon' ? [] : attrsChecked('request')).sort().join(',');
  presetsEl.querySelectorAll('[data-preset]').forEach((btn) => {
    const set = [...((presets.find((p) => p.id === btn.dataset.preset) || {}).keys || [])].sort().join(',');
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
  refreshPlannedInvite(); // scheduled call: the invitation carries the agreement → reissue it
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
 * Why not per tab: a tab is not a person. Someone who opens the appointment link in the
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
  catch { store = sessionStorage; } // e.g. Safari in private mode
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

// ---- phone paired to sign for a browser participant (Pro, qes-device) -------------
// `?pair=<token>` comes from the QR code a browser shows under "Mit dem Smartphone signieren".
// This page then is not a call at all: no room, no join — the qes-device module takes over the screen
// (see startPairedSigner below and the module's client/paired-signer.js).
const pairToken = params.get('pair');

// Back from the wallet — see backFromWallet below. Read here so that no fresh room is made up for it.
// In the app the bundle has no /zurueck path; openRoomUrl hands it over as ?zurueck=1&r=… instead.
const backFromWallet = location.pathname === '/zurueck' || params.get('zurueck') === '1';
let roomId = inviteCfg ? inviteCfg.room : (params.get('room') || (backFromWallet ? params.get('r') : null));
// Whether THIS browser opened the room (see roomArrival): kept for the session even where storage fails.
let createdHere = false;
if (!roomId && !inviteToken && !pairToken && !backFromWallet) {
  roomId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
  createdHere = true;
  try { localStorage.setItem('eudi_host_' + roomId, '1'); } catch { /* private mode: createdHere still holds */ }
  params.delete('new'); // entry flag from a start page's CTA — not part of the room URL
  params.set('room', roomId);
  // Keep the hash: in embed mode it carries the #cfg config (parsed further below) —
  // dropping it here would silently discard the embedder's configuration.
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
  try { store = localStorage; localStorage.getItem(key); } catch { /* private mode */ }
  const ausUrl = params.get('staff');
  if (ausUrl) {
    try { if (store) store.setItem(key, ausUrl); } catch {}
    params.delete('staff');
    history.replaceState(null, '', `${location.pathname}${params.toString() ? '?' + params.toString() : ''}${location.hash || ''}`);
    return ausUrl;
  }
  try { return (store && store.getItem(key)) || null; } catch { return null; }
})();

/**
 * Back from the wallet: the verifier sends the wallet's browser to /zurueck?r=… after a
 * presentation, or to /?room=…&zurueck=1 when the offer was made for the app (walletReturnUrl in
 * src/server.ts).
 *
 * WHY NOT STRAIGHT INTO THE ROOM, as it was until 2026-10-27: on a phone the wallet opened
 * `/?room=…`, and with the whosit app installed that is a universal link — the app opened and
 * joined the room as a NEW participant. Someone who had scanned the code on their computer found
 * their phone sitting in their own call as the guest, asked to identify again.
 *
 * So: this browser already holds a seat in the room (the call runs here, same device) → back into
 * it, exactly as before. It does not (the call runs on another device or in the app) → say that it
 * worked and where to continue, and do not join. The app itself, when a link brings it to the
 * front, only stays in its call or shows the same message (openRoomUrl) — it never joins for it.
 */
//
// The parameter is `r`, not `room`, on purpose: Android opens the app for EVERY link on the
// domain, and an app whose bundle predates this would otherwise read `room` and join as a guest.
const hasSeatHere = backFromWallet && !!roomId && (() => {
  const key = 'eudi_clientId_' + roomId;
  try { if (localStorage.getItem(key)) return true; } catch {}
  try { return !!sessionStorage.getItem(key); } catch { return false; }
})();
const walletDoneElsewhere = backFromWallet && !hasSeatHere;
if (hasSeatHere) history.replaceState(null, '', `/?room=${encodeURIComponent(roomId)}`);

// Only NOW, because the identifier is tied to the room (see stableClientId). Not created at all
// on the "done, go back" page: a stored id would make a reload of it join the room after all.
const clientId = walletDoneElsewhere ? null : stableClientId(roomId);

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
  // In embeds, no explicit disclose config → anonymous host
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
// Without the capability (no EUDI_INVITE_SECRET on the server) the invitation is a bare room link
// that only carries as long as this tab is open.
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
// Used when the title field is left empty. Follows the brand for the same reason the field's
// default does (see branding.js): the value ends up in a guest's calendar.
const CAL_TITLE_FALLBACK = (window.EUDI_BRANDING && window.EUDI_BRANDING.name) || 'whosit – EUDI Verified Contact';
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
    t('Beide Seiten können sich vor dem Gespräch mit ihrer EUDI-Wallet ausweisen. Was geteilt wird, seht ihr vorher — und entscheidet selbst. Der Anruf läuft im Browser, Ende-zu-Ende verschlüsselt und direkt zwischen euren Geräten.'),
  ];
  // Right below the link: setting up the wallet takes minutes and the ID card PIN, so the guest
  // has to read it before the appointment, not at its start.
  if (guestNeedsWallet) {
    lines.splice(5, 0,
      t('Vorher einmalig einrichten (dauert ein paar Minuten): Du brauchst die App „d-you Wallet“ auf deinem Smartphone, mit deinem Ausweis darin (Online-Ausweisfunktion und PIN). Download und Anleitung:'),
      walletInfoUrl(),
      '');
  }
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
  const uid = `${inv ? inv.room : roomId}@whosit-web`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//whosit//DE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
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

// Apple Wallet appointment pass (`wallet-pass`, server-side signed .pkpass). A plain
// navigation download: Safari/iOS offer "Add to Wallet" natively.
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
    await ensurePlannedInvite(); // the GUEST link is shared (it is then in shareInput)
    const range = scheduledRange();
    let text = t('Verifizierter Anruf per EUDI-Wallet — hier beitreten:');
    if (range) {
      const when = range.start.toLocaleString(i18nLocale, { dateStyle: 'full', timeStyle: 'short' });
      text = t('{title} — {when} Uhr.', { title: calTitleValue(), when }) + '\n' + t('Verifizierter Anruf per EUDI-Wallet, hier beitreten:');
    }
    if (guestNeedsWallet) text = t('Vorher bitte die App „d-you Wallet“ einrichten: {url}', { url: walletInfoUrl() }) + '\n\n' + text;
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

// Server messages a lazily loaded module listens to (e.g. the pairing of the phone signature,
// the qes-device module's client/paired-phone.js), so this switch does not have to know every one of them.
const serverListeners = new Map(); // type → Set<fn>
function onServer(type, fn) {
  if (!serverListeners.has(type)) serverListeners.set(type, new Set());
  serverListeners.get(type).add(fn);
  return () => serverListeners.get(type).delete(fn);
}

// ---- channel binding ----
// The DTLS fingerprint has to be fixed BEFORE the wallet request, otherwise it cannot be signed
// along with it. Normally it only comes into being with the SDP offer — so we bring the
// certificate forward: created once, held here, handed to the real connection later. See
// src/channel-binding.ts.
let localCert = null;          // RTCCertificate, reused across reconnects
let localFingerprint = null;   // 'AB:CD:…' (SHA-256, uppercase)

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

/** Reads `a=fingerprint:sha-256` and nothing else: only what is unambiguously SHA-256 may feed
 *  into a security guarantee — otherwise the binding could be defeated through a weaker
 *  algorithm. */
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
  if (!p || !info || !info.channelBound || !info.dtlsFingerprint) return true; // nothing asserted
  // Every fingerprint line counts and each must be the bound SHA-256 one; none at all fails too.
  const sdp = (p.pc.remoteDescription && p.pc.remoteDescription.sdp) || '';
  const lines = [...sdp.matchAll(/^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/gim)];
  const bound = String(info.dtlsFingerprint).toUpperCase();
  if (!lines.length || !lines.every((m) => m[1].toLowerCase() === 'sha-256' && m[2].toUpperCase() === bound)) {
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
 * For a scheduled call, waiting is the normal case: someone who enters the room at 14:00 and waits
 * until 14:15 has a device that goes to sleep in between. With a fixed attempt budget, on waking the
 * budget would long be spent, the window would show a frozen picture from earlier — and because the
 * preview never arrives, the host could not consent, even though everything is ready server-side.
 * As long as the page is open we therefore never give up.
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
// after the next interval.
window.addEventListener('online', reconnectNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconnectNow(); });

/**
 * The display is the more important part: a frozen window that does not say it is frozen looks
 * like a working one — both sides wait for the other while one is only looking at an old picture.
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
/**
 * Opened the room here, or came by its link? The server makes a link holder a guest even in an
 * empty room: someone who opened the link while the host was away (longer than the grace period)
 * used to become the host and found the setup form, and the real host came back as a guest.
 * Scheduled calls take the role from the invitation, embeds keep the old first-come rule.
 */
function roomArrival() {
  if (inviteCfg || isEmbedded) return undefined;
  if (createdHere) return 'creator';
  try { if (localStorage.getItem('eudi_host_' + roomId)) return 'creator'; } catch { /* unknown → link */ }
  return 'invited';
}
async function sendJoin() {
  await ensureLocalCertificate();
  wsSend({ type: 'join', roomId, clientId, wantAuth: soloMode, dtlsFingerprint: localFingerprint || undefined, inv: inviteToken || undefined, arrival: roomArrival() });
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

/** A server error as something a person can act on. The server speaks English for logs and tools;
 *  shown raw it read "Fehler: invalid roomId". The original goes to the console for support. */
const SERVER_ERRORS = [
  [/roomId/, 'Dieser Link ist unvollständig – öffne bitte den ganzen Link aus der Einladung.'],
  [/EUDIPLO|offer failed/i, 'Die Ausweisprüfung ist gerade nicht erreichbar. Versuch es in einem Moment noch einmal.'],
  [/too many new rooms/i, 'Von diesem Anschluss wurden gerade sehr viele Anrufe gestartet. Versuch es in ein paar Minuten noch einmal.'],
  [/without a verifier/i, 'Auf dieser Instanz ist keine Ausweisprüfung eingerichtet – Anrufe bleiben anonym.'],
  [/channel binding/i, 'Die Verbindung ließ sich nicht sicher zuordnen. Lade die Seite neu und versuch es noch einmal.'],
];
function errorText(raw) {
  if (raw) console.warn('[server]', raw);
  const hit = SERVER_ERRORS.find(([re]) => re.test(String(raw || '')));
  return hit ? hit[1] : 'Etwas ist schiefgelaufen. Lade die Seite neu und versuch es noch einmal.'; // setStatus translates
}

function handle(msg) {
  const listeners = serverListeners.get(msg.type);
  if (listeners) for (const fn of [...listeners]) { try { fn(msg); } catch (e) { console.warn('listener failed:', e && e.message); } }
  switch (msg.type) {
    case 'joined':
      myRole = msg.role;
      myPeerId = msg.peerId || myPeerId;
      if (myRole === 'callee') { setupBox.hidden = true; shareBox.hidden = true; }
      postToParent('joined', { role: msg.role });
      break;
    case 'room-full':
      // Followed a link into someone else's 1:1 call (a forwarded invitation): say why, not just "full".
      setStatus(roomArrival() === 'invited' ? 'Dieser Anruf ist privat und bereits besetzt.' : 'Dieser Raum ist bereits voll.');
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
      restartBtn.hidden = true; // a new room would not help — the block applies to the whole instance
      break;
    case 'invite-invalid': showInviteProblem(msg.reason, msg.opensAt, msg.startsAt); break;
    case 'auth': showAuth(msg); break;
    case 'auth-failed':
      setStatus('Das Ausweisen hat nicht geklappt – bitte erneut scannen.');
      haptic('error');
      if (walletModalCtx === 'auth') setWalletModalState('error');
      break;
    case 'auth-progress': if (walletModalCtx === 'auth' && msg.state === 'fetched') setWalletModalState('loading'); break;
    case 'status': renderStatus(msg); break;
    case 'ready': startCall(msg); break;
    case 'declined': onDeclined(); break;
    case 'offer': onRemoteOffer(msg.from, msg.data); break;
    case 'answer': onRemoteAnswer(msg.from, msg.data); break;
    case 'ice': onRemoteIce(msg.from, msg.data); break;
    case 'peer-left': onPeerGone(msg.from); break;
    case 'hangup': onPeerGone(msg.from); break;
    // in-call credential requests — see the section further below
    case 'credential-pending':
      pendingCredRequests.set(msg.requestId, { to: msg.to, credentialId: msg.credentialId, label: msg.label });
      addChat('System', '🪪 ' + t('Nachweis angefordert:') + ' ' + msg.label + ' …');
      break;
    case 'credential-requested': showCredPrompt(msg); break;
    // actions in a call — see "Actions in a call" further below
    case 'actions': showActionPanel(msg.items || []); break;
    case 'action-pending': addChat('System', '📋 ' + t('Gesendet an {name}:', { name: peerName(msg.to) }) + ' ' + msg.title + ' …'); break;
    case 'action-accepted': addChat('System', '📋 ' + t('{name} hat geöffnet:', { name: peerName(msg.from) }) + ' ' + msg.title); break;
    case 'action-declined': addChat('System', '📋 ' + t('{name} hat abgelehnt:', { name: peerName(msg.from) }) + ' ' + msg.title); break;
    case 'action-aborted': addChat('System', '📋 ' + t('Nicht abgeschlossen:') + ' ' + msg.title); break;
    case 'action-done':
      if (isHost()) addChat('System', '📋 ' + t('Erledigt:') + ' ' + msg.title + (msg.summary ? ' — ' + msg.summary : '') + ' ✓');
      // The guest's panel stays open: it shows the module's confirmation (an entry number, a
      // receipt) — closing it is theirs, and the header says the call is still there.
      else { actionDone(); addChat('System', '📋 ' + t('Erledigt:') + ' ' + msg.title + ' ✓'); }
      break;
    case 'action-requested': showActionPrompt(msg); break;
    case 'action-open': openActionWindow(msg); break;
    case 'action-cancelled': closeActionPrompt(); closeActionWindow(); addChat('System', '📋 ' + t('Zurückgezogen:') + ' ' + msg.title); break;
    case 'action-error': addChat('System', '📋 ' + t('Aktion nicht möglich.')); break;
    case 'device-cert': settleDeviceCert(msg, true); break;
    case 'device-cert-error': settleDeviceCert(msg, false); break;
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
      setStatus(errorText(msg.message), 'error');
      break;
  }
}

function showAuth(msg) {
  // The server only sends 'auth' when this participant must present something, so
  // always render it (don't gate on a possibly-stale selfVerified flag).
  if (callStarted) return;
  // Re-render rather than rely on the one call at startup: the card is shown again on renew and
  // for a second participant, and the locale may have changed in between.
  applyRelyingPartyDisclosure();
  // A freshly arrived offer makes the renew button usable again.
  if (authRenewBtn) authRenewBtn.disabled = false;
  // Kept, not drawn: the QR code appears only in the wallet modal, after the person pressed the
  // button (Touchpoint Design Guide: never start the wallet flow on their behalf). A new offer
  // while the modal is open — renewed, or after a failure — replaces the old code in place.
  authOffer = { uri: msg.uri, crossDeviceUri: msg.crossDeviceUri };
  if (walletModalCtx === 'auth') {
    renderWalletOffer(authOffer);
    setWalletModalState('default');
    wsSend({ type: 'auth-watch' });
  }
}

// ---- wallet modal (Touchpoint Design Guide, d-you Wallet) ----
// bmi.usercontent.opencode.de/eudi-wallet/developer-guide/rp/guide/touchpoint_design
// One modal for both wallet requests: the identification before the call ('auth') and a
// credential asked for during it ('cred'). Texts are the guide's; the error state is ours, because
// the guide leaves failures to the Relying Party ("own the process").
const walletModal = $('wallet-modal');
const wmTitle = $('wm-title');
const wmLive = $('wm-live');
const wmDefault = $('wm-default');
const wmStatus = $('wm-status');
const wmStatusText = $('wm-status-text');
const wmIcon = $('wm-icon');
const wmRetry = $('wm-retry');
const wmHint = $('wm-hint');
const wmCopy = $('wm-copy');
const dyouOpen = $('dyou-open');
const walletAlt = $('wallet-alt');
let authOffer = null;          // the latest identification offer { uri, crossDeviceUri }
let credOffer = null;          // the latest in-call credential offer
let walletModalCtx = null;     // null (closed) | 'auth' | 'cred'
let walletModalOpener = null;  // focus returns here on close
let walletModalCloseTimer = null;

// The button's language follows the page; the asset exists in German and English only.
const dyouLocale = () => (typeof i18nLocale === 'string' && i18nLocale === 'de' ? 'de' : 'en');
function walletInfoUrl() { return `https://eudi-wallet.gov.de/${dyouLocale()}`; }
function applyWalletButtons() {
  for (const img of document.querySelectorAll('img.dyou-img')) {
    img.src = `vendor/d-you/d-you-wallet_button_verify_${dyouLocale()}.svg`;
    img.alt = dyouLocale() === 'de' ? 'Verifizieren mit d-you Wallet' : 'Verify with d-you Wallet';
  }
  for (const a of document.querySelectorAll('a[data-wallet-info]')) a.href = `https://eudi-wallet.gov.de/${dyouLocale()}`;
}

// qrcodejs writes the encoded text into the container's `title`: hovering the code showed the whole
// wallet URL as a tooltip on top of it, and the phone's camera could no longer read the code. Patched
// on the prototype, so the modules that draw codes with window.QRCode (qes pairing) get it too.
if (window.QRCode && QRCode.prototype && QRCode.prototype.makeCode) {
  const makeCode = QRCode.prototype.makeCode;
  QRCode.prototype.makeCode = function (text) {
    makeCode.call(this, text);
    if (this._el && this._el.removeAttribute) this._el.removeAttribute('title');
  };
}

function renderWalletOffer(offer) {
  qrContainer.innerHTML = '';
  if (!offer) return;
  const qrData = offer.crossDeviceUri || offer.uri;
  // eslint-disable-next-line no-undef
  new QRCode(qrContainer, { text: qrData, width: 232, height: 232, correctLevel: QRCode.CorrectLevel.M });
  authLink.href = offer.uri || qrData;
}

const WALLET_STATES = {
  default: { title: 'Jetzt verifizieren' },
  loading: { title: 'Weiter in der d-you Wallet', text: 'Folge dort den angezeigten Schritten.', icon: 'wait' },
  success: { title: 'Verifizierung erfolgreich!', text: 'Du wirst automatisch zurückgeleitet.', icon: 'ok' },
  error: { title: 'Das hat nicht geklappt', text: 'Die Wallet hat die Anfrage nicht abgeschlossen. Mit einem neuen Code kannst du es noch einmal versuchen.', icon: 'err' },
};
// The wallet fetched the request and then nothing: it declined on the phone without telling the
// verifier (d-you does so when it has no usable PID left — "Du benötigst einen gültigen
// Nachweis"), and the spinner would turn forever. After a while, say what may have happened and
// offer a fresh code; the spinner stays, a late answer is still taken.
const WALLET_STUCK_MS = 45_000;
let walletStuckTimer = null;
function setWalletModalState(state) {
  clearTimeout(walletStuckTimer);
  wmHint.hidden = true;
  if (state === 'loading') walletStuckTimer = setTimeout(walletModalStuck, WALLET_STUCK_MS);
  const st = WALLET_STATES[state] || WALLET_STATES.default;
  walletModal.dataset.state = state;
  wmTitle.textContent = t(st.title);
  wmDefault.hidden = state !== 'default';
  wmStatus.hidden = state === 'default';
  wmStatusText.textContent = st.text ? t(st.text) : '';
  wmIcon.className = `wm-icon ${st.icon || ''}`;
  wmRetry.hidden = state !== 'error' || walletModalCtx !== 'auth';
  // Announced, not just shown: someone who scanned with a screen reader running learns here that
  // the next step is on the phone.
  wmLive.textContent = state === 'default' ? '' : `${t(st.title)} ${st.text ? t(st.text) : ''}`;
}

function walletModalStuck() {
  if (walletModal.dataset.state !== 'loading' || !walletModalCtx) return;
  wmHint.hidden = false;
  wmRetry.hidden = walletModalCtx !== 'auth';
  wmLive.textContent = wmHint.textContent;
}

function openWalletModal(ctx, opener) {
  const offer = ctx === 'cred' ? credOffer : authOffer;
  if (!offer) return;
  clearTimeout(walletModalCloseTimer);
  walletModalCtx = ctx;
  walletModalOpener = opener || document.activeElement;
  applyWalletButtons();
  renderWalletOffer(offer);
  // Renewing exists for the identification only; a credential request is answered or declined.
  if (authRenewBtn) authRenewBtn.hidden = ctx !== 'auth';
  setWalletModalState('default');
  walletModal.hidden = false;
  document.body.classList.add('wm-open');
  wmTitle.focus();
  if (ctx === 'auth') wsSend({ type: 'auth-watch' });
}

function closeWalletModal() {
  if (!walletModalCtx) return;
  clearTimeout(walletModalCloseTimer);
  clearTimeout(walletStuckTimer);
  walletModal.hidden = true;
  document.body.classList.remove('wm-open');
  walletModalCtx = null;
  const back = walletModalOpener;
  walletModalOpener = null;
  if (back && document.contains(back) && !back.closest('[hidden]')) back.focus();
}

/** The wallet confirmed: say so, then return to the page by itself — as the guide's text promises. */
function walletModalSucceeded(ctx) {
  if (walletModalCtx !== ctx) return;
  setWalletModalState('success');
  walletModalCloseTimer = setTimeout(closeWalletModal, 1800);
}

if (dyouOpen) dyouOpen.addEventListener('click', () => openWalletModal('auth', dyouOpen));
// Looked up here rather than through credDyouOpen, which is declared further down (in-call section).
const credDyouBtn = $('cred-dyou-open');
if (credDyouBtn) credDyouBtn.addEventListener('click', () => openWalletModal('cred', credDyouBtn));
$('wm-close').addEventListener('click', closeWalletModal);
walletModal.addEventListener('click', (e) => { if (e.target === walletModal) closeWalletModal(); });
wmRetry.addEventListener('click', () => {
  wmRetry.disabled = true;
  wsSend({ type: 'renew-auth' });
  setTimeout(() => { wmRetry.disabled = false; }, 4000);
});
wmCopy.addEventListener('click', async () => {
  const offer = walletModalCtx === 'cred' ? credOffer : authOffer;
  const link = offer && (offer.crossDeviceUri || offer.uri);
  if (!link) return;
  try { await navigator.clipboard.writeText(link); wmCopy.textContent = t('Link kopiert'); } catch { wmCopy.textContent = t('Kopieren nicht möglich'); }
  setTimeout(() => { wmCopy.textContent = t('Link zum QR-Code kopieren'); }, 2500);
});
// Escape closes; Tab stays inside the dialog while it is open (Touchpoint Design Guide, accessibility).
document.addEventListener('keydown', (e) => {
  if (!walletModalCtx) return;
  if (e.key === 'Escape') { e.preventDefault(); closeWalletModal(); return; }
  if (e.key !== 'Tab') return;
  const focusable = [...walletModal.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => !el.closest('[hidden]') && !el.disabled);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === wmTitle)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
if (typeof i18nReady !== 'undefined') i18nReady.then(applyWalletButtons); else applyWalletButtons();

function renderAuthCard(role, attrs, opts) {
  // No wallet, no call — so the guest learns the way out before starting (Touchpoint Design
  // Guide: offer another way). Only the inviting host can lift the requirement, hence guests only.
  if (walletAlt) walletAlt.hidden = role !== 'callee' || !!(opts && opts.login);
  // Guests get the "Das brauchst du" box instead of the one-line wallet note (same statement,
  // still before the button); hosts know the wallet already.
  const needBox = $('need-box'), walletNeed = $('wallet-need');
  const guestBox = role === 'callee' && !(opts && opts.login);
  if (needBox) {
    needBox.hidden = !guestBox;
    const media = $('need-media');
    media.hidden = mode === 'chat';
    media.classList.toggle('is-audio', mode === 'audio');
    $('need-media-text').textContent = t(mode === 'audio' ? 'Ein Mikrofon an diesem Gerät.' : 'Kamera und Mikrofon an diesem Gerät.');
  }
  if (walletNeed) walletNeed.hidden = guestBox;
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
    authHint.innerHTML = t('Diese Angaben teilst du aus deiner <strong>Wallet</strong>:');
  } else {
    authTitle.textContent = t('Mit Wallet ausweisen');
    authHint.innerHTML = t('Du gibst <strong>nur diese Angaben</strong> aus deinem Ausweis frei — sonst nichts:');
  }
  renderConsent(attrs);
}

/** Guest's identification card: what the host shows in return, and whether they are identified. */
function renderAuthPeer(msg) {
  const el = $('auth-peer');
  if (!el) return;
  const host = (msg.peers || []).find((p) => p.role === 'caller');
  const gives = (msg.disclosedAttrs || []).map((k) => t(labelFor(k))).join(', ');
  el.hidden = !host;
  if (!host) return;
  el.textContent = !gives ? t('Die einladende Person bleibt anonym.')
    : host.verified ? t('Die einladende Person ist bereits ausgewiesen ✓ und zeigt dir im Gegenzug: {list}.', { list: gives })
    : t('Im Gegenzug zeigt dir die einladende Person: {list}.', { list: gives });
}

function roleLabelFor(role) { return role === 'caller' ? t('Gastgeber:in') : t('Gast'); }
/** Did a wallet actually vouch for this participant? `verified` alone also holds for someone who had
 *  nothing to present (anonymous, no verifier) — a tick on that claims a check that never happened.
 *  A server without the field (older Pro build) leaves the old reading. */
function presentedOf(x) { return !!x && (x.presented !== undefined ? !!x.presented : !!x.verified); }
/** The tick on a tile follows the status — a credential presented in-call can still add one. */
function syncTileTicks(msg) {
  for (const x of msg.peers || []) {
    const el = x.peerId && videosEl.querySelector(`.tile[data-peer="${CSS.escape(x.peerId)}"] .name`);
    if (el) el.classList.toggle('verified', presentedOf(x));
  }
}
function peerPresented(peerId) {
  const m = lastStatusMsg;
  return !!m && (m.peers || []).some((x) => x.peerId === peerId && presentedOf(x));
}

// ---- progress stepper (role-aware; hidden in solo/embed) ----
// Host flow: set up & invite → everyone identifies & confirms → connected.
// Guest flow: identify → confirm → connected. Rendered from renderStatus/revealCall.
const stepperEl = $('stepper');
const STEPS_HOST = ['Einrichten & einladen', 'Ausweisen & zustimmen', 'Verbunden'];
const STEPS_GUEST = ['Ausweisen', 'Zustimmen', 'Verbunden'];
function updateStepper(active) {
  updateRing(active);
  if (!stepperEl || soloMode || isEmbedded) return;
  const labels = myRole === 'callee' ? STEPS_GUEST : STEPS_HOST;
  stepperEl.innerHTML = '';
  labels.forEach((label, i) => {
    const li = document.createElement('li');
    li.className = i < active ? 'done' : i === active ? 'active' : '';
    // The last step is a destination, not a stop along the way: whoever is there has arrived.
    // Hence a tick there too instead of the number — otherwise "3 Connected" reads like an open
    // item even though the connection has long been up.
    // …but only once the connection is actually up. Ticked from the moment both had confirmed,
    // it said "Verbunden ✓" right above "Verbindung wird aufgebaut …".
    const done = i < active || (i === active && i === labels.length - 1 && anyConnected());
    const no = document.createElement('span'); no.className = 'step-dot'; no.textContent = done ? '✓' : String(i + 1);
    const tx = document.createElement('span'); tx.textContent = t(label);
    li.append(no, tx);
    stepperEl.appendChild(li);
  });
  stepperEl.hidden = false;
  if (statusKicker) statusKicker.textContent = labels[active] ? t(labels[active]) : '';
  callHead().step(active, labels.length, labels[active] ? t(labels[active]) : '');
}
function hideStepper() {
  if (stepperEl) stepperEl.hidden = true;
  if (statusKicker) statusKicker.textContent = '';
}
// App: one header row — logo left, the stepper as dots on the right (style.css). Moved, not
// duplicated, so updateStepper keeps a single element to fill.
if (isNativeApp() && stepperEl) {
  const hdr = document.querySelector('header');
  if (hdr) hdr.appendChild(stepperEl);
}

/**
 * Readiness per participant: identified → confirmed → connected.
 *
 * The steps show where a call is stuck, without adding another line of prose.
 *
 * THREE steps, always. No fourth step for media readiness: chat calls do not have it, so the row
 * would lose a dot when you pick Chat and no longer match the three-step stepper at the top of
 * the page. Media state is carried by the standing notice instead (see ensureMedia), which is the
 * part that actually tells you what to do.
 */
function stepFlags(verified, confirmed, connected) {
  return [['ausgewiesen', verified], ['zugestimmt', confirmed], ['verbunden', connected]];
}

function renderSteps(chip, flags) {
  const old = chip.querySelector('.steps');
  if (old) old.remove();
  const done = flags.filter(([, on]) => on).length;
  const w = document.createElement('span');
  w.className = 'steps';
  // One label for screen readers instead of four unlabelled dots; the per-dot title serves
  // the mouse. Both go through t() — the dots are the only non-textual state here.
  w.setAttribute('role', 'img');
  w.setAttribute('aria-label', t('{n} von {m} Schritten erledigt', { n: done, m: flags.length }));
  for (const [label, on] of flags) {
    const pip = document.createElement('i');
    if (on) pip.className = 'on';
    pip.title = t(label);
    w.appendChild(pip);
  }
  chip.appendChild(w);
}

/**
 * What a chip says.
 *
 * `verified` means "identified with the wallet", `confirmed` means "consented to the
 * disclosure". The two must read differently: otherwise someone who has only just identified
 * looks exactly like someone who has already agreed.
 *
 * Both words stay. Identifying is what this product is for, but consent is the step the whole
 * review screen exists for; collapsing the two into „ausgewiesen" would erase it.
 *
 * `identified` also drives the colour: only from that point on is a chip filled in its role
 * colour. A guest who has just arrived must not look as finished as one who has signed.
 */
function chipState(name, verified, confirmed, presented = verified) {
  if (name) return { text: `${titleCase(name)} ✓`, identified: true };
  // Nothing to present (anonymous, or no verifier at all): "verified" only means "nothing to
  // present" — "ausgewiesen ✓" or a bare "zugestimmt ✓" would read as an ID check that never happened.
  if (verified && (!presented || verifierOff)) return { text: t(confirmed ? 'anonym — zugestimmt' : 'anonym — ungeprüft'), identified: true };
  if (confirmed) return { text: t('zugestimmt ✓'), identified: true };
  if (verified) return { text: t('ausgewiesen ✓'), identified: true };
  return { text: t('noch nicht ausgewiesen'), identified: false };
}

/**
 * Colour follows the POINT OF VIEW, not the role: "Du" neutral, the other side violet — on every
 * screen the same question ("mine or theirs?"). By role, host blue and guest green, a guest saw
 * their own chip green but their own data column blue, and both colours already meant something
 * else (blue: tap here, green: verified). The role stays in the words („Gastgeber:in: …").
 */
const SELF_CHIP = 'who-self', PEER_CHIP = 'who-peer';

/** The other side's mark: initials once a name may be shown, else a person. Never a name before
 *  consent — callers pass `name` only where values are already revealed (renderResult). */
const PERSON_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const first = (w) => [...w][0].toUpperCase();
  return words.length === 1 ? first(words[0]) : first(words[0]) + first(words[words.length - 1]);
}
function fillPeerMark(el, name) {
  const ini = initialsOf(name);
  el.classList.toggle('has-initials', !!ini);
  if (ini) el.textContent = ini; else el.innerHTML = PERSON_GLYPH;
}
function peerMark(name) {
  const el = document.createElement('span'); el.className = 'who peer'; el.setAttribute('aria-hidden', 'true');
  fillPeerMark(el, name);
  return el;
}

function updateChips(msg) {
  const hostDiscloses = isHost() && msg.disclosedAttrs && msg.disclosedAttrs.length;
  // Anonymous host: „Gastgeber:in" is the whole truth here — there is nothing to do, so no
  // state is shown and the chip stays calm.
  const anonymousHost = isHost() && !hostDiscloses;
  const self = anonymousHost
    ? { text: t('Gastgeber:in'), identified: true }
    : chipState(msg.self.name, msg.self.verified, msg.self.confirmed, presentedOf(msg.self));
  // `pending` makes the chip pulse (see style.css): "it's your turn" should not only be readable
  // but visible. Only an open identification pulses — a finished participant has nothing to do.
  selfChip.className = `id-chip ${SELF_CHIP}${self.identified ? ' is-identified' : ' pending'}`;
  selfLabel.textContent = `${t('Du')}: ${self.text}`;
  if (handRaised) selfLabel.textContent += ' ✋';
  renderSteps(selfChip, stepFlags(!!msg.self.verified, !!msg.self.confirmed, anyConnected()));

  // one chip per peer (rebuilt each status)
  const list = msg.peers || [];
  peerChipsEl.innerHTML = '';
  if (!list.length) {
    // Nobody there yet. „wartet …" claimed a presence that does not exist — before the link is
    // even shared there is no one to wait.
    const otherRole = myRole === 'caller' ? 'callee' : 'caller';
    const chip = document.createElement('div'); chip.className = `id-chip ${PEER_CHIP}`;
    chip.innerHTML = '<span class="dot"></span>';
    const s = document.createElement('span'); s.className = 'chip-label';
    s.textContent = `${roleLabelFor(otherRole)}: ${t('noch nicht beigetreten')}`;
    chip.appendChild(s); peerChipsEl.appendChild(chip);
    return;
  }
  for (const peer of list) {
    const st = chipState(peer.name, peer.verified, peer.confirmed, presentedOf(peer));
    const chip = document.createElement('div');
    chip.className = `id-chip ${PEER_CHIP}${st.identified ? ' is-identified' : ''}`;
    chip.innerHTML = '<span class="dot"></span>';
    // `.chip-label` and not "the last span": the trust bar reads the name back out of here, and
    // since the step dots are a span too, `span:last-of-type` started picking those up instead.
    const s = document.createElement('span'); s.className = 'chip-label';
    s.textContent = `${roleLabelFor(peer.role)}: ${st.text}`;
    if (peer.peerId && handsUp.has(peer.peerId)) s.textContent += ' ✋';
    chip.appendChild(s);
    const lp = peer.peerId ? peers.get(peer.peerId) : null;
    renderSteps(chip, stepFlags(
      !!peer.verified, !!peer.confirmed, !!(lp && lp.pc.connectionState === 'connected')));
    peerChipsEl.appendChild(chip);
  }
}

function selfAttrs(msg) { return myRole === 'caller' ? msg.disclosedAttrs : msg.requestedAttrs; }
function peerAttrsOf(msg) { return myRole === 'caller' ? msg.requestedAttrs : msg.disclosedAttrs; }

// What a given peer shares depends on their role (host discloses, guests present requested).
function attrsForPeer(msg, peer) { return peer.role === 'caller' ? msg.disclosedAttrs : msg.requestedAttrs; }

// Pre-confirm: field names only (no values available yet).
/**
 * The other side by its role, the same words as on the chips: "Dein Gast", "Gastgeber:in".
 * "Dein Gegenüber" was a third name for the same person.
 */
function otherSideLabels(peers) {
  if (isHost()) return peers.length > 1
    ? { shares: t('Deine Gäste teilen'), anon: t('Dein Gast bleibt anonym.') }
    : { shares: t('Dein Gast teilt'), anon: t('Dein Gast bleibt anonym.') };
  return { shares: t('Gastgeber:in teilt'), anon: t('Gastgeber:in bleibt anonym.') };
}
function setOtherSideHeading(box, label, name) {
  const el = box && box.querySelector('.review-col.guest > .field-label .col-title');
  if (el) el.textContent = label;
  const mark = box && box.querySelector('.review-col.guest > .field-label .who.peer');
  if (mark) fillPeerMark(mark, name);
}

function renderReview(msg) {
  renderFieldList(reviewSelf, selfAttrs(msg), 'Du teilst nichts (anonym).');
  const peers = msg.peers || [];
  const other = otherSideLabels(peers);
  setOtherSideHeading(reviewBox, other.shares);
  if (peers.length <= 1) {
    renderFieldList(reviewPeer, peers[0] ? attrsForPeer(msg, peers[0]) : [], other.anon);
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
  const other = otherSideLabels(peers);
  // Initials only here, after consent, and only for one peer — with several, each block has its own.
  setOtherSideHeading(resultBox, other.shares, peers.length === 1 && peers[0].name ? titleCase(peers[0].name) : '');
  if (peers.length <= 1) {
    renderResultInto(resultPeer, peers[0] && peers[0].claims, peers[0] ? attrsForPeer(msg, peers[0]) : [], other.anon);
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
// name in the heading, whatever the server happens to send. The server gate (see showValues in
// src/server.ts) is the primary control; this makes the review screen incapable of showing a
// value even if that gate ever leaks.
function renderPeerBlocks(container, peers, renderInto, withNames) {
  container.innerHTML = '';
  for (const peer of peers) {
    const head = document.createElement('div'); head.className = 'peer-block-head';
    const name = withNames && peer.name ? titleCase(peer.name) : '';
    head.append(peerMark(name), document.createTextNode(name || roleLabelFor(peer.role)));
    const inner = document.createElement('div');
    container.append(head, inner);
    renderInto(inner, peer);
  }
}

function renderStatus(msg) {
  const hadStatus = !!lastStatusMsg; // a resumed seat arrives verified — nothing happened just now
  lastStatusMsg = msg;
  syncBanderoleTriggers();
  const wasVerified = selfVerified;
  selfVerified = msg.self.verified;
  if (selfVerified && !wasVerified) { walletModalSucceeded('auth'); if (hadStatus) haptic('success'); }
  if (msg.self.name) myName = msg.self.name;
  myRole = msg.self.role || myRole;
  mode = msg.mode || mode;
  noticeArrivals(msg);
  syncMediaCheck();

  // --- internal Solo-Demo (?solo=1) ---
  if (soloMode) {
    selfChip.classList.toggle('verified', msg.self.verified);
    selfLabel.textContent = msg.self.verified ? `${t('Du')}: ${titleCase(msg.self.name) || t('verifiziert')} ✓` : t('Du: nicht verifiziert');
    if (msg.self.verified) { authBox.hidden = true; setLocalLabel(titleCase(msg.self.name)); startLoopback(titleCase(msg.self.name)); }
    else setStatus('Solo-Demo: bitte mit der Wallet ausweisen.');
    return;
  }

  // The server withdrew this side's agreement in a running call: someone new took the other seat
  // (an invitation reopened elsewhere), or this side's channel binding lapsed. The people on the
  // other end are not the ones agreed to — drop the connections and go back to the review; a new
  // 'ready' starts them again (security audit 2026-11-11).
  if (callStarted && !ended && !msg.openRoom && !msg.self.confirmed) {
    for (const id of [...peers.keys()]) removePeer(id);
    screenSharers.clear(); handsUp.clear(); stagePeer = null;
    if (qesShare) qesShare.teardown(true);
    callStarted = false;
    document.body.classList.remove('in-call');
    resultBox.hidden = true;
    setStatus('Am anderen Platz ist jemand Neues. Bitte prüfe und stimme erneut zu.');
  }
  if (callStarted) { updateChips(msg); updateStepper(2); if (msg.revealed) { renderResult(msg); resultBox.hidden = false; } updateCredBadges(msg); syncTileTicks(msg); return; }

  const peerList = msg.peers || [];
  const peerPresent = peerList.length > 0;
  isOpenRoom = !!msg.openRoom;
  // Gate on EVERYONE present: all verified / all confirmed (self + all peers).
  const allVerified = msg.self.verified && peerPresent && peerList.every((p) => p.verified);
  const allConfirmed = msg.self.confirmed && peerPresent && peerList.every((p) => p.confirmed);
  // Multi-party: the review only opens once the host started (server sets reviewOpen).
  const reviewOpen = msg.reviewOpen !== false; // 1:1 (undefined) → always open
  updateChips(msg);
  // "Warum whosit?" only at the start (see .app-strengths in style.css).
  document.body.classList.toggle('pre-start', isHost() ? !peerPresent : !msg.self.verified);
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
      setStatus(presentedOf(msg.self) ? 'Ausgewiesen ✓ – warte, bis der Gastgeber den Anruf startet …' : 'Warte, bis der Gastgeber den Anruf startet …');
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
    // people join over time. Hiding it here would leave the host with no way to invite anyone else
    // the moment they had verified themselves, and the link is not recoverable from the review
    // screen. Same rule as the waiting branch a few lines below.
    shareBox.hidden = !(isOpenRoom && isHost());
    renderReview(msg);
    reviewBox.hidden = false;
    reviewWait.hidden = true; setConfirmWaiting(false);
    // Directive instead of descriptive, and it separates the two cases that would otherwise both
    // read as „warten": the others are still busy — or they are done and only you are missing.
    const others = msg.peers || [];
    const othersReady = others.length > 0 && others.every((x) => x.confirmed);
    setReviewUrgency(othersReady);
    setStatus(othersReady
      ? (isHost() ? 'Du bist dran: Dein Gast hat zugestimmt — prüfe und stimme zu, um zu verbinden.' : 'Du bist dran: Gastgeber:in hat zugestimmt — prüfe und stimme zu, um zu verbinden.')
      : 'Prüfe, was geteilt wird, und stimme zu, um zu verbinden.', 'prompt');
    return;
  }
  reviewBox.hidden = true;
  setReviewUrgency(false);

  // Open room: confirmed but fewer than 2 present → wait (host keeps the invite link visible).
  if (isOpenRoom && msg.self.confirmed && !msg.revealed) {
    setupBox.hidden = true; authBox.hidden = true; startBar.hidden = true;
    shareBox.hidden = !isHost();
    setStatus('Zugestimmt ✓ – warte auf weitere Teilnehmer …');
    return;
  }
  // Non-open: confirmed, waiting for the others to confirm.
  if (!isOpenRoom && reviewOpen && allVerified && msg.self.confirmed && !allConfirmed) {
    setupBox.hidden = true; shareBox.hidden = true; authBox.hidden = true; startBar.hidden = true;
    renderReview(msg); reviewBox.hidden = false;
    reviewWait.hidden = true; setConfirmWaiting(true);
    setStatus('Du hast zugestimmt — warte auf die anderen …');
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
    const locked = peerPresent || !!msg.configPinned;
    if (locked) lockSetup();
    // The invite card sits below the setup and gets missed — but it must NOT simply move up:
    // the guest joining freezes the setup, so inviting first and being outrun nails the call to
    // the defaults. Name the consequence while it can still be avoided, and mark the card as
    // the step that is now due. Once it IS locked the note is only rubbing it in.
    if (inviteLockNote) inviteLockNote.hidden = locked;
    // …unless the host's own identification is due first: that card is the active one then, and two
    // highlighted cards left it unclear which comes next.
    shareBox.classList.toggle('is-next', !locked && !(!msg.self.verified && msg.disclosedAttrs.length > 0));
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
    // Guest there: the link has done its job and the settings are locked, so both cards fold
    // away. Left standing, "Link kopieren" stayed the biggest button on screen while the actual
    // next thing happened elsewhere. An open room keeps the link — people join over time.
    if (peerPresent && !isOpenRoom) { shareBox.hidden = true; setupBox.hidden = true; }
    // host disclosure scan?
    const hostMustScan = !msg.self.verified && msg.disclosedAttrs.length > 0;
    if (hostMustScan) { renderAuthCard('caller', msg.disclosedAttrs); authBox.hidden = false; }
    else authBox.hidden = true;

    // What is the host's next task? Identifying comes before inviting; if everyone is present and
    // you are done yourself, there is nothing to press -> highlight no card.
    setActiveCard(hostMustScan ? authBox : (!peerPresent && !shareBox.hidden) ? shareBox : null);

    // The status says where the host is, not what comes three steps later: "Weise dich aus"
    // greeted a host who had not chosen anything yet (and an anonymous host, who has nothing to
    // identify at all).
    if (!peerPresent && msg.configPinned) setStatus('Geplanter Anruf — warte auf deinen Gast …');
    else if (!peerPresent && hostMustScan) setStatus('Richte den Anruf ein und schick den Link an deinen Gast. Ausweisen kannst du dich gleich oder später, wenn der Anruf beginnt.');
    else if (!peerPresent && msg.self.verified) setStatus(presentedOf(msg.self) ? 'Du bist ausgewiesen ✓ – schick jetzt den Link an deinen Gast.' : 'Du bleibst anonym – schick jetzt den Link an deinen Gast.', 'ok');
    else if (!peerPresent) setStatus('Richte den Anruf ein und schick den Link an deinen Gast.');
    else if (hostMustScan) setStatus('Dein Gast ist da – weise dich jetzt aus.', 'prompt');
    else if (someoneUnverified) setStatus(peerList.length > 1 ? 'Deine Gäste sind da und weisen sich gerade aus …' : 'Dein Gast ist da und weist sich gerade aus …', 'wait');
    else setStatus('Gleich geschafft …');
  } else {
    setupBox.hidden = true; shareBox.hidden = true;
    if (!msg.self.verified && msg.requestedAttrs.length) { renderAuthCard('callee', msg.requestedAttrs); authBox.hidden = false; }
    else authBox.hidden = true;
    // For the guest the identification card is the only one — highlight it, but dim nothing.
    setActiveCard(authBox.hidden ? null : authBox);

    renderAuthPeer(msg);
    // Say what kind of call this is: "Du wurdest eingeladen" alone left a first-time guest
    // guessing whether a camera was about to switch on.
    if (!msg.self.verified) {
      setStatus(msg.mode === 'audio' ? 'Du bist zu einem Audioanruf eingeladen – weise dich mit deiner Wallet aus.'
        : msg.mode === 'chat' ? 'Du bist zu einem Chat eingeladen – weise dich mit deiner Wallet aus.'
        : 'Du bist zu einem Videoanruf eingeladen – weise dich mit deiner Wallet aus.', 'prompt');
    }
    // A guest can be first in the room now (the host stepped away, see roomArrival) — say so
    // rather than "warte auf die anderen", which sounds like someone is already busy.
    else if (!peerPresent) setStatus('Gastgeber:in ist noch nicht da – es geht automatisch weiter.', 'wait');
    else if (!allVerified) setStatus(presentedOf(msg.self) ? 'Du bist ausgewiesen ✓ – warte auf die anderen …' : 'Du bleibst anonym – warte auf die anderen …');
    else setStatus('Gleich geschafft …');
  }
}

/**
 * Desktop: exactly ONE card is the one you are on right now.
 *
 * The stepper at the top promises an order ("set up & invite -> identify & confirm -> connected"),
 * but on desktop the body shows all three cards as equals — setting up, inviting and identifying
 * at once. Without guidance the eye falls on the largest box (setup) instead of on the open task
 * (scan the QR code).
 *
 * This is the DEFAULT on desktop, not the only option: the space is there, and the invitation
 * link is not a station but a reference the host wants to keep in view — so leave everything
 * visible and only steer attention. The guided mode is a choice rather than a screen width (see
 * initSetupWizard), so a desktop host can switch to the step wizard instead; the CSS
 * rules here hang off `body:not(.wizard)`, so the two exclude each other by construction.
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
const CONFIRM_LABEL = 'Verbinden ✓', CONFIRM_WAIT = 'Warte auf Zustimmung …';
function setConfirmWaiting(w) {
  confirmBtn.classList.toggle('waiting', w);
  confirmBtn.disabled = w; declineBtn.disabled = w;
  confirmBtn.textContent = t(w ? CONFIRM_WAIT : CONFIRM_LABEL);
}

/**
 * Everyone else is done and only you are missing — say so, and make the button look like it.
 *
 * Without this the two states that matter most both read as „warten": waiting because the
 * others are not ready, and waiting because YOU are the one holding things up. On a phone the
 * second case is invisible — the button sits below the fold — which is exactly how a call
 * appears to have stalled while it is only waiting for a tap.
 */
function setReviewUrgency(on) {
  confirmBtn.classList.toggle('urgent', !!on);
  reviewReady.hidden = !on;
  if (on) reviewReady.textContent = t('Alle anderen sind bereit — es fehlt nur noch deine Zustimmung.');
}
startBtn.addEventListener('click', () => { startBtn.disabled = true; wsSend({ type: 'start-call' }); });
confirmBtn.addEventListener('click', () => { wsSend({ type: 'confirm' }); reviewWait.hidden = true; setConfirmWaiting(true); });
declineBtn.addEventListener('click', () => { wsSend({ type: 'decline' }); ended = true; teardownCall(); markRoomEnded(); showEnded('Du hast abgelehnt. Es wird keine Verbindung aufgebaut.'); });
function onDeclined() { if (ended) return; ended = true; teardownCall(); markRoomEnded(); showEnded(isHost() ? 'Dein Gast hat abgelehnt. Es wird keine Verbindung aufgebaut.' : 'Gastgeber:in hat abgelehnt. Es wird keine Verbindung aufgebaut.'); }

// ---- WebRTC (full mesh: one RTCPeerConnection per peer) ----
// peerId -> { pc, dc, pendingIce, remoteDescSet, initiator, name, role, video, tile }
const peers = new Map();
// ICE candidates that arrive BEFORE their peer's RTCPeerConnection exists (peerId → []).
// This happens when the offerer gathers+sends candidates while the answerer is still in
// its getUserMedia permission prompt (peer not yet created). Without buffering, those
// candidates are lost and ICE fails until a later iceRestart re-sends them — in open rooms,
// video/chat would only connect once a 3rd person joins. Drained in getPeer.
const earlyIce = new Map();
let localStream = null;
let callConnectedOnce = false; // set once ≥1 peer is connected → later peers are late-joiners

// Screen sharing (video mode): swap the outgoing camera track for a display track via
// sender.replaceTrack across ALL peer connections — same m-line, no renegotiation.
let screenStream = null;
let cameraTrack = null;

/**
 * Media permission as a STATE, not as silence.
 *
 * A bare try/catch that set `localStream = false` and carried on would end a refused
 * permission in „Verbunden ✓ – sichere P2P-Verbindung steht." — connected, but without
 * picture or sound, without a reason, and with no way back except reloading.
 *
 * The browser does say WHY it failed, and the cases need different sentences because the
 * remedy differs: a blocked permission is undone in the address bar, a missing microphone is
 * not. `err.name` is the diagnosis; `err.message` is browser-specific prose and never shown.
 *
 * The hint lives IN here rather than at the call sites: both `startCall()` and
 * `onRemoteOffer()` trigger the browser prompt, and inside the function both paths are covered
 * by construction.
 */
let mediaState = 'idle'; // idle | pending | ok | denied | nodevice | busy | error | skipped

/* Only states with an entry produce a notice — `ok`, `skipped` and `idle` stay silent.
   `{geraete}` because audio calls never ask for a camera, and a hint naming one is wrong.
   Phrased to avoid grammatical agreement with the inserted noun. */
const MEDIA_MSG = {
  pending: 'Bitte {geraete} freigeben — der Anruf wartet so lange.',
  denied: 'Zugriff auf {geraete} ist blockiert. Erlaube {geraete} über das Symbol links neben der Adresse (Schloss oder Regler) und versuche es erneut.',
  nodevice: 'Zugriff auf {geraete} nicht möglich — kein Gerät gefunden. Ihr könnt den Anruf als Chat führen.',
  busy: 'Zugriff auf {geraete} nicht möglich — eine andere Anwendung belegt sie gerade. Schließe sie und versuche es erneut.',
  error: 'Zugriff auf {geraete} ist fehlgeschlagen.',
};

/* Where a refused permission is undone depends on the device, and a hint that names the wrong
   place is no hint at all: iOS browsers have no padlock — there, and in the app, the switch sits
   in the system settings. Changing it there restarts the browser, hence "reload". */
const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/.test(UA);
function deniedMsg() {
  if (isNativeApp()) {
    return IS_ANDROID
      ? 'Zugriff auf {geraete} ist blockiert. Öffne Einstellungen → Apps → whosit → Berechtigungen und erlaube dort {geraete}.'
      : 'Zugriff auf {geraete} ist blockiert. Öffne Einstellungen → whosit und erlaube dort {geraete}.';
  }
  if (IS_IOS) {
    const browser = /CriOS/.test(UA) ? 'Chrome' : /FxiOS/.test(UA) ? 'Firefox' : /EdgiOS/.test(UA) ? 'Edge' : 'Safari';
    return { key: 'Zugriff auf {geraete} ist blockiert. Öffne Einstellungen → {browser}, erlaube dort {geraete} und lade diese Seite danach neu.', browser };
  }
  return MEDIA_MSG.denied;
}

function mediaDevicesLabel() { return mode === 'audio' ? t('das Mikrofon') : t('Kamera und Mikrofon'); }

function renderMediaNotice() {
  let key = mediaState === 'denied' ? deniedMsg() : MEDIA_MSG[mediaState];
  if (!key) { mediaNotice.hidden = true; return; }
  let browser = '';
  if (typeof key === 'object') ({ key, browser } = key);
  mediaNotice.hidden = false;
  mediaNotice.dataset.state = mediaState === 'pending' ? 'wait' : 'error';
  mediaNoticeText.textContent = t(key, { geraete: mediaDevicesLabel(), browser });
  // While the browser dialog is open there is nothing to retry — the answer is still pending.
  mediaRetryBtn.hidden = mediaState === 'pending';
}

function setMediaState(s) {
  mediaState = s;
  renderMediaNotice();
}

function mediaErrorState(e) {
  const n = (e && e.name) || '';
  return n === 'NotAllowedError' || n === 'SecurityError' ? 'denied'
    : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'nodevice'
      : n === 'NotReadableError' || n === 'AbortError' ? 'busy'
        : 'error';
}

async function ensureMedia() {
  if (localStream !== null) return localStream;
  if (mode === 'chat') { stopPreview(); setMediaState('skipped'); localStream = false; return false; }
  // A running device check hands its stream over: no second prompt, no flicker, and exactly the
  // devices that were just tested.
  if (previewStream && previewStreamMode === mode) {
    localStream = previewStream;
    stopPreview(true);
  } else {
    stopPreview();
    setMediaState('pending');
    try {
      localStream = await navigator.mediaDevices.getUserMedia(mediaConstraints());
      // A chosen background is in place before the picture is shown or sent. If it takes too
      // long (first download on a slow line), the call goes on and the effect follows.
      if (mode === 'video' && devPref.bg && devPref.bg !== 'none') {
        await Promise.race([queueBackground(localStream), new Promise((r) => setTimeout(r, 10000))]);
      }
    } catch (e) {
      setMediaState(mediaErrorState(e));
      console.warn('getUserMedia failed:', e && e.name, e && e.message);
      localStream = false;
      return localStream;
    }
  }
  if (mode === 'video') localVideo.srcObject = localStream;
  setMediaState('ok');
  applyStartPrefs();
  return localStream;
}

/**
 * Retry after a refusal.
 *
 * Before any connection exists this is trivial: `getPeer()` attaches the tracks when it creates
 * the peer. Afterwards they have to be added to the RUNNING connections and renegotiated —
 * tracks are attached exactly once (see getPeer), so without a fresh offer the button would
 * promise a picture it never delivers.
 *
 * The certificate is unchanged, so the DTLS fingerprint stays the same and the channel binding
 * survives the renegotiation (the server checks every offer against the bound fingerprint).
 */
async function retryMedia() {
  if (mediaState === 'pending') return;
  // Before the call the retry belongs to the device check — it shows what it got.
  if (!callStarted) { startPreview(); return; }
  mediaRetryBtn.disabled = true;
  localStream = null;
  const stream = await ensureMedia();
  mediaRetryBtn.disabled = false;
  if (!stream) return;
  for (const [peerId, p] of peers) {
    if (p.pc.connectionState === 'closed') continue;
    try {
      const sent = new Set(p.pc.getSenders().map((s) => s.track).filter(Boolean));
      let added = false;
      for (const tr of localTracks()) if (!sent.has(tr)) { p.pc.addTrack(tr, stream); added = true; }
      if (!added) continue;
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer); p.offered = true;
      wsSend({ type: 'offer', to: peerId, data: offer });
    } catch (e) { console.warn('renegotiate after media retry:', e && e.message); }
  }
  enforceLocalMuteState(); // a retry must not undercut a mute set before it
}
mediaRetryBtn.addEventListener('click', () => { retryMedia(); });
function localTracks() { return localStream && localStream.getTracks ? localStream.getTracks() : []; }
/**
 * The offer must ask for sound (and picture) even when this side has none to send: an offer
 * without a media section gets an answer without one, and the other side's camera and microphone
 * went nowhere — one missing device left BOTH sides without sound and picture. A later addTrack
 * (retryMedia) takes over these transceivers rather than adding new ones.
 */
function ensureReceiving(pc) {
  if (mode === 'chat' || typeof pc.addTransceiver !== 'function') return;
  const kinds = new Set(pc.getTransceivers().map((tr) => tr.receiver && tr.receiver.track && tr.receiver.track.kind).filter(Boolean));
  for (const kind of mode === 'video' ? ['audio', 'video'] : ['audio']) {
    if (!kinds.has(kind)) { try { pc.addTransceiver(kind, { direction: 'recvonly' }); } catch { /* old browser */ } }
  }
}

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
    // Mid-call trouble. "disconnected" often heals by itself (a Wi-Fi hiccup, a handover to
    // mobile data); "failed" does not without a new ICE round — the offerer starts one, twice at
    // most, before saying it did not work. Meanwhile the trust bar must not stay green as if all
    // were well (body.link-shaky).
    const st = pc.connectionState;
    document.body.classList.toggle('link-shaky', callConnectedOnce && [...peers.values()].some((x) => x.pc.connectionState === 'disconnected' || x.pc.connectionState === 'failed'));
    if (callConnectedOnce && (st === 'disconnected' || st === 'failed')) {
      const cur = peers.get(peerId);
      if (st === 'failed' && cur && cur.initiator && (cur.iceRestarts || 0) < 2) {
        cur.iceRestarts = (cur.iceRestarts || 0) + 1;
        setStatus('Verbindung gestört – wird wiederhergestellt …', 'wait');
        pc.createOffer({ iceRestart: true })
          .then((offer) => pc.setLocalDescription(offer).then(() => wsSend({ type: 'offer', to: peerId, data: offer })))
          .catch((e) => console.warn('ice restart:', e && e.message));
        if (lastStatusMsg) updateChips(lastStatusMsg);
        return;
      }
      if (st === 'disconnected') { setStatus('Verbindung gestört – wird wiederhergestellt …', 'wait'); if (lastStatusMsg) updateChips(lastStatusMsg); return; }
    }
    if (pc.connectionState === 'connected') {
      const cur = peers.get(peerId); if (cur) cur.iceRestarts = 0;
      revealCall();
      // Connected, but the other side sends no picture (no camera, or none allowed): a tile all
      // the same, with name and badges — without one the host only saw themselves, with no hint
      // that anyone was there.
      if (mode === 'video' && !peers.get(peerId)?.tile) attachRemote(peerId, new MediaStream());
    }
    else if (pc.connectionState === 'failed') setStatus('Die Verbindung kam nicht zustande. Oft liegt es am Netzwerk – versuch es mit einem anderen WLAN oder mit mobilen Daten.', 'error');
    if (lastStatusMsg) updateChips(lastStatusMsg); // last chip step = connected
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
 * Switching off `localStream.getAudioTracks()` alone only works as long as every connection
 * sends exactly that track object — if a sender holds a different one for any reason
 * (replacement, clone, a connection built later), the audio stays on while the button reads
 * "muted".
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
  if (!p) { revealCall(); return; }
  // An audio call has no tiles, but its sound still needs an element to play from: a remote
  // track that is attached nowhere stays silent.
  if (mode !== 'video') {
    if (mode === 'audio') {
      if (!p.audio) { p.audio = document.createElement('audio'); p.audio.autoplay = true; p.audio.hidden = true; document.body.appendChild(p.audio); applySink(p.audio); }
      p.audio.srcObject = stream;
      p.audio.play().catch(() => {});
    }
    revealCall(); return;
  }
  if (!p.tile) {
    const tile = document.createElement('div'); tile.className = 'tile'; tile.dataset.peer = peerId;
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; applySink(video);
    const nameEl = document.createElement('div'); nameEl.className = peerPresented(peerId) ? 'name verified' : 'name'; nameEl.textContent = p.name ? titleCase(p.name) : (p.role ? roleLabelFor(p.role) : t('Gegenüber'));
    tile.append(video, nameEl); videosEl.appendChild(tile);
    p.tile = tile; p.video = video;
    syncBanderoleTriggers();
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
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
  peers.delete(peerId);
  if (p.tile) applyStage(); // back from picture-in-picture when the other tile is gone
}

// 'ready' (may repeat on resume): open/refresh a connection to every listed peer.
// Of each pair, the side with the lower peerId is the offerer (server sets `initiator`).
async function startCall(msg) {
  if (ended) return;
  if (msg.mode) mode = msg.mode;

  if (!callStarted) {
    callStarted = true;
    syncMediaCheck();
    document.body.classList.add('in-call');
    reviewBox.hidden = true; authBox.hidden = true; shareBox.hidden = true; setupBox.hidden = true; startBar.hidden = true;
    setLocalLabel(titleCase(myName) || '');
    // No permission hint here: it comes from ensureMedia() as a standing notice, and therefore
    // on the answering path too.
    setStatus('Verbindung wird aufgebaut …', 'wait');
    await ensureMedia();
    await refreshIce();
  }

  for (const info of (msg.peers || [])) {
    const p = getPeer(info.peerId, info);
    if (p.tile && info.name) p.tile.querySelector('.name').textContent = titleCase(info.name);
    if (info.initiator && p.pc.connectionState !== 'connected') {
      if (!p.dc) { p.dc = p.pc.createDataChannel('chat'); wireChat(p.dc, info.peerId); }
      ensureReceiving(p.pc);
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
  // Second line behind the server's gate: no answer (and so no addresses) before 'ready'.
  if (ended || !from || !callStarted) return;
  await ensureMedia();
  await refreshIce();
  const p = getPeer(from); // pc.ondatachannel (label-routed) is set in getPeer
  await p.pc.setRemoteDescription(offer);
  if (!verifyPeerBinding(from)) return;
  p.remoteDescSet = true; flushIce(from);
  const answer = await p.pc.createAnswer();
  await p.pc.setLocalDescription(answer);
  wsSend({ type: 'answer', to: from, data: answer });
}
async function onRemoteAnswer(from, answer) {
  const p = from && peers.get(from);
  if (ended || !p || p.pc.signalingState !== 'have-local-offer') return;
  await p.pc.setRemoteDescription(answer);
  if (!verifyPeerBinding(from)) return;
  p.remoteDescSet = true; flushIce(from);
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
  // the viewport (fluid). Only during a video call with the spotlight capability.
  peersBox.classList.toggle('fluid', on);
  // A manually staged peer that has since left → fall back to the grid.
  if (stagePeer && stagePeer !== 'self' && !tileFor(stagePeer) && !stageAuto) { stagePeer = null; }
  const staged = on ? stagePeer : null;
  videosEl.classList.toggle('stage-mode', !!staged && !!tileFor(staged));
  // One-to-one: the other person large, your own picture small in the corner — as in every phone
  // call app. Side by side (or, on a phone, your own picture on top) gave yourself the most room.
  videosEl.classList.toggle('duo', !videosEl.classList.contains('stage-mode') && videosEl.querySelectorAll('.tile').length === 2);
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
// phase so the click doesn't also toggle the spotlight.
function banderoleDataFor(key) {
  const msg = lastStatusMsg;
  if (!msg || !msg.revealed) return null;
  if (key === 'self') return { claims: msg.self.claims, attrs: selfAttrs(msg), empty: 'Du teilst nichts (anonym).', shared: msg.self.sharedCredentials };
  const peer = (msg.peers || []).find((p) => p.peerId === key);
  return peer ? { claims: peer.claims, attrs: attrsForPeer(msg, peer), empty: 'bleibt anonym.', creds: peer.credentials } : null;
}
// The name badge and the credential badge open the banderole, but only once there are values
// (after the mutual reveal). Until then they are plain labels; from then on they announce
// themselves as buttons to VoiceOver/TalkBack and take the keyboard. They stay <div>s on purpose:
// the global button styles (accent fill, 44px, hover lift) would have to be undone one by one.
function syncBanderoleTriggers() {
  const live = !!(lastStatusMsg && lastStatusMsg.revealed);
  for (const el of videosEl.querySelectorAll('.tile .name, .tile .cred-badge')) {
    if (live) {
      el.setAttribute('role', 'button'); el.tabIndex = 0;
      el.setAttribute('aria-expanded', String(!!el.closest('.tile').querySelector('.banderole')));
    } else {
      el.removeAttribute('role'); el.removeAttribute('tabindex'); el.removeAttribute('aria-expanded');
    }
  }
}
function toggleBanderole(tile) {
  const open = tile.querySelector('.banderole');
  if (open) { open.remove(); syncBanderoleTriggers(); return; }
  const data = banderoleDataFor(tile.dataset.peer);
  if (!data) return;
  const band = document.createElement('div');
  band.className = 'banderole';
  renderResultInto(band, data.claims, data.attrs, data.empty);
  // In-call catalog credentials: what the peer presented to me / what I shared.
  appendCredentialRows(band, data.creds);
  appendSharedCredentialRows(band, data.shared);
  // QES identity binding: signature ↔ PID result at the person.
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
  syncBanderoleTriggers();
}
videosEl.addEventListener('click', (e) => {
  const nameEl = e.target.closest('.tile .name, .tile .cred-badge');
  if (!nameEl || !lastStatusMsg || !lastStatusMsg.revealed) return;
  e.stopPropagation(); // don't also spotlight the tile
  toggleBanderole(nameEl.closest('.tile'));
}, true);
videosEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const nameEl = e.target.closest('.tile .name[role="button"], .tile .cred-badge[role="button"]');
  if (!nameEl) return;
  e.preventDefault(); // Space would scroll the page
  toggleBanderole(nameEl.closest('.tile'));
});

// ---- in-call credential requests (server-enforced `in-call-credentials`) ----
// The HOST asks a participant for a further catalog credential DURING
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
const credDyouOpen = $('cred-dyou-open');
const credActions = $('cred-actions');
const credAccept = $('cred-accept');
const credDecline = $('cred-decline');

let credCatalog = [];                    // /credential-catalog (empty when none is configured)
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
  // Since 2026-11-02 a host requests credentials through "Aktionen" (the module that brings
  // them offers the action); the separate button only remains for a module that does not.
  const on = isHost() && callStarted && !ended && capOn('in-call-credentials') && credCatalog.length > 0 && peers.size > 0 && !actionsOffered;
  credreqBtn.hidden = !on;
  if (!on) credreqPanel.hidden = true;
  updateActionButton();
}

// One row per credential × peer (1:1 hides the redundant name).
function buildCredReqPanel() {
  credreqPanel.innerHTML = '';
  const peerList = [...peers.entries()];
  for (const c of credCatalog) {
    for (const [peerId, p] of peerList) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'credreq-item';
      const who = p.name ? titleCase(p.name) : (p.role ? roleLabelFor(p.role) : t('Gegenüber'));
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

// ---- Actions in a call (src/call-actions.ts) ------------------------------------------------
// A module's form or signature, run WITH a guest while the call goes on. The host picks it from
// "Aktionen"; the guest sees who asks, for what and WHICH verified data from this call the
// module will receive, and agrees; the module's page then opens in a panel over the call (audio
// and video keep running) and closes by itself when the module reports it done.
const aktionBtn = $('aktion-btn');
const aktionPanel = $('aktion-panel');
const aktionModal = $('aktion-modal');
const aktionFenster = $('aktion-fenster');
const aktionFrame = $('aktion-frame');
let activeActionPrompt = null;
let activeActionRun = null;
const ACTION_ATTR_LABEL = { given_name: 'Vorname', family_name: 'Nachname', birth_date: 'Geburtsdatum', address: 'Anschrift', nationality: 'Staatsangehörigkeit', age_over_18: 'Über 18 Jahre', issuing_country: 'Ausstellungsstaat' };

function updateActionButton() {
  const on = isHost() && callStarted && !ended && actionsOffered && peers.size > 0;
  aktionBtn.hidden = !on;
  if (!on) aktionPanel.hidden = true;
}
aktionBtn.addEventListener('click', () => {
  if (!aktionPanel.hidden) { aktionPanel.hidden = true; return; }
  aktionPanel.innerHTML = '';
  const wait = document.createElement('p'); wait.className = 'hint'; wait.textContent = t('Wird geladen …');
  aktionPanel.appendChild(wait);
  aktionPanel.hidden = false;
  wsSend({ type: 'actions-list' });
});
document.addEventListener('click', (e) => {
  if (!aktionPanel.hidden && !aktionPanel.contains(e.target) && e.target !== aktionBtn && !aktionBtn.contains(e.target)) aktionPanel.hidden = true;
});
// One row per action × choice × peer (1:1 hides the redundant name).
function showActionPanel(items) {
  if (aktionPanel.hidden) return;
  aktionPanel.innerHTML = '';
  const peerList = [...peers.entries()];
  for (const it of items) {
    const head = document.createElement('p'); head.className = 'aktion-gruppe'; head.textContent = it.label;
    aktionPanel.appendChild(head);
    for (const c of it.choices) {
      for (const [peerId, p] of peerList) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'credreq-item';
        const who = p.name ? titleCase(p.name) : (p.role ? roleLabelFor(p.role) : t('Gegenüber'));
        btn.textContent = peerList.length > 1 ? t('{title} an {name}', { title: c.label, name: who }) : c.label;
        btn.addEventListener('click', () => {
          wsSend({ type: 'action-start', to: peerId, module: it.module, action: it.action, choice: c.id });
          aktionPanel.hidden = true;
        });
        aktionPanel.appendChild(btn);
      }
    }
  }
  if (!items.length) {
    const none = document.createElement('p'); none.className = 'hint';
    none.textContent = t('Gerade keine Aktionen verfügbar (zum Beispiel noch kein Formular freigegeben).');
    aktionPanel.appendChild(none);
  }
}
// Guest side: who asks, for what, and exactly which verified data the module will receive.
function showActionPrompt(msg) {
  activeActionPrompt = msg;
  $('aktion-titel').textContent = msg.title;
  const who = msg.fromName ? titleCase(msg.fromName) : t('Gastgeber:in');
  $('aktion-hint').textContent = t('{name} bittet dich: {label}', { name: who, label: msg.label });
  const list = $('aktion-daten');
  list.innerHTML = '';
  if (msg.attrs && msg.attrs.length) {
    $('aktion-daten-hint').textContent = t('Übernommen werden deine in diesem Gespräch geprüften Angaben:');
    for (const a of msg.attrs) { const li = document.createElement('li'); li.textContent = t(ACTION_ATTR_LABEL[a] || a); list.appendChild(li); }
  } else {
    $('aktion-daten-hint').textContent = t('Aus diesem Gespräch werden keine Angaben übernommen.');
  }
  aktionModal.hidden = false;
  $('aktion-ok').focus();
}
function closeActionPrompt() { aktionModal.hidden = true; activeActionPrompt = null; }
$('aktion-ok').addEventListener('click', () => { if (activeActionPrompt) wsSend({ type: 'action-accept', runId: activeActionPrompt.runId }); closeActionPrompt(); });
$('aktion-nein').addEventListener('click', () => { if (activeActionPrompt) wsSend({ type: 'action-decline', runId: activeActionPrompt.runId }); closeActionPrompt(); });
function openActionWindow(msg) {
  activeActionRun = msg.runId;
  $('aktion-fenster-titel').textContent = msg.title;
  // apiUrl: in the app the page lives on the instance, not in the local bundle.
  aktionFrame.src = apiUrl(String(msg.path).replace(/^\/+/, ''));
  aktionFenster.querySelector('.aktion-laeuft span:last-child').textContent = t('Das Gespräch läuft weiter');
  aktionFenster.hidden = false;
  document.body.classList.add('aktion-offen');
}
function actionDone() {
  activeActionRun = null;
  if (aktionFenster.hidden) return;
  aktionFenster.querySelector('.aktion-laeuft span:last-child').textContent = t('Erledigt — du kannst das Fenster schließen. Das Gespräch läuft weiter.');
}
function closeActionWindow() {
  if (aktionFenster.hidden) return;
  aktionFenster.hidden = true;
  aktionFrame.src = 'about:blank';
  activeActionRun = null;
  document.body.classList.remove('aktion-offen');
}
$('aktion-zu').addEventListener('click', () => {
  if (activeActionRun) wsSend({ type: 'action-close', runId: activeActionRun });
  closeActionWindow();
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
  credOffer = { uri: msg.uri, crossDeviceUri: msg.crossDeviceUri };
  credAuthArea.hidden = false;
  // The person already chose "Teilen" — that was the button press, so the wallet modal follows.
  openWalletModal('cred', credDyouOpen);
}
function closeCredModal() {
  credModal.hidden = true; activeCredRequest = null; credOffer = null;
  if (walletModalCtx === 'cred') closeWalletModal();
}
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
  syncBanderoleTriggers();
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

// ---- coming back from another tab ----
// Several browsers pause a <video> in a background tab and leave it on its last frame even
// though the track kept running, and it does not repair itself: nudge every call tile back
// into playback.
function resumeCallVideos() {
  const tiles = videosEl ? Array.from(videosEl.querySelectorAll('video')) : [];
  for (const v of tiles) { if (v.paused && v.srcObject) v.play().catch(() => {}); }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) resumeCallVideos();
});

function anyConnected() {
  for (const p of peers.values()) if (p.pc.connectionState === 'connected') return true;
  return false;
}
function revealCall() {
  if (ended) return;
  callControls.hidden = false;
  acquireWakeLock();
  syncMutedWatch();
  updateStepper(2);
  if (anyConnected()) callConnectedOnce = true;
  if (!soundMarkPlayed && !ended && anyConnected()) { soundMarkPlayed = true; showLogoMoment(); }
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
  reviewBox.hidden = true; setupBox.hidden = true; authBox.hidden = true;
  // In an open room keep the invite link visible during the call so more guests can join.
  shareBox.hidden = !isOpenRoom;
  if (anyConnected()) setStatus('Verbunden ✓ – Ende-zu-Ende verschlüsselt.');
  updateStepper(2);
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
  // Read the name before the peer is gone: "Erika Mustermann hat aufgelegt." tells the one left
  // behind what happened; "Alle anderen haben den Anruf verlassen." made them count heads.
  const gone = peers.get(from);
  const goneName = gone && gone.name ? titleCase(gone.name) : '';
  const goneAnon = gone && gone.role === 'caller' ? 'Gastgeber:in hat aufgelegt.' : isHost() ? 'Dein Gast hat aufgelegt.' : 'Ein Gast hat aufgelegt.';
  removePeer(from);
  if (qesShare) qesShare.peerGone(from);
  screenSharers.delete(from);
  handsUp.delete(from);
  peerMicMuted.delete(from);
  peerCamOff.delete(from);
  if (stagePeer === from) { stagePeer = null; stageAuto = false; }
  if (peers.size === 0) { ended = true; teardownCall(); markRoomEnded(); showEnded(goneName ? t('{name} hat aufgelegt.', { name: goneName }) : goneAnon); }
  else { setStatus(goneName ? t('{name} hat den Anruf verlassen.', { name: goneName }) : 'Ein Teilnehmer hat den Anruf verlassen.'); revealCall(); }
}

// ---- hang up ----
function teardownCall() {
  earlyIce.clear();
  // NOT reset here: the sound mark and the logo moment belong to the moment two people connect,
  // once per call. A torn-down call that briefly reports "connected" again (the app on iOS did,
  // 2026-11-02) must not play it a second time at the end; a new call is a new page.
  releaseWakeLock();
  stopMutedWatch();
  stopPreview();
  if (qesShare) qesShare.teardown(true); // drop any document ceremony (no abort message — call is over)
  handsUp.clear(); handRaised = false;
  for (const id of [...peers.keys()]) removePeer(id);
  for (const p of loopbackPeers) { try { p.close(); } catch {} }
  loopbackPeers = [];
  if (screenStream && screenStream.getTracks) screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null; cameraTrack = null;
  if (localStream && localStream.getTracks) stopMediaStream(localStream);
  localStream = null;
  if (localVideo.srcObject) localVideo.srcObject = null;
  chatInput.disabled = true; chatSend.disabled = true;
  renderBgPickers();
}
function showEnded(message) {
  setStatus(message);
  // The call is over, so its layout goes too: the trust bar would otherwise stay on top of an
  // ended page and keep the participant chips hidden, and the stepper would still say
  // "Verbunden". The chips stay — greyed — as the record of whom you spoke with.
  document.body.classList.remove('in-call', 'trust-open', 'pre-start');
  document.body.classList.add('call-ended');
  hideStepper();
  restRing();
  updateDocBtn();
  credreqPanel.hidden = true; credModal.hidden = true; credreqBtn.hidden = true; activeCredRequest = null;
  peersBox.hidden = true; chatBox.hidden = true; callBanner.hidden = true; callControls.hidden = true; reviewBox.hidden = true; resultBox.hidden = true; startBar.hidden = true;
  // The PREPARATORY surfaces too. Otherwise a refused sign-in shows "not authorised" above a
  // still-visible QR code — an invitation to a second attempt with a dead offer — and a
  // taken-over session leaves the old setup on screen.
  authBox.hidden = true; setupBox.hidden = true; shareBox.hidden = true;
  restartLabel.textContent = t('Neuen Anruf starten');
  restartBtn.hidden = false;
  // A guest on the website came for this one call — "Neuen Anruf starten" would make them the host
  // of an empty room. Say they are done instead. (In the app it stays: starting calls is what it is for.)
  const wasGuest = myRole ? myRole === 'callee' : roomArrival() === 'invited';
  if (wasGuest && !isNativeApp() && !isEmbedded) {
    restartBtn.hidden = true;
    // Only if the message does not say it already ("… dieses Fenster kannst du schließen."):
    // otherwise the sentence stood there twice.
    setStatus(/Fenster kannst du schließen/.test(message) ? t(message) : t(message) + ' ' + t('Du kannst dieses Fenster jetzt schließen.'));
  }
  syncMediaCheck();
  postToParent('ended', {});
}
/** The wallet came back to a browser that is not in the call — see backFromWallet. */
function showWalletDone() {
  ended = true;
  showEnded('Du bist ausgewiesen. Mach beim Anruf weiter: auf dem anderen Gerät oder in der whosit-App. Dieses Fenster kannst du schließen.');
  // A new call is not what this person came for.
  restartBtn.hidden = true;
  hideStepper();
  // Nobody is "in" anything here — no participant chips either.
  const ids = selfChip && selfChip.closest('section, .card');
  if (ids) ids.hidden = true;
  // The call runs in the whosit app on this phone (app=1, set by the server for app clients), but
  // iOS handed the return link to the browser: the association file is not on the phone yet, or
  // "open in browser" was chosen once. The app's own scheme always reaches it; the app reads
  // whosit://open/zurueck?r= like the https link (openRoomUrl) and stays in its call.
  const backBtn = $('back-to-app');
  if (backBtn && params.get('app') === '1' && !isNativeApp() && roomId) {
    const appUrl = `whosit://open/zurueck?r=${encodeURIComponent(roomId)}`;
    backBtn.hidden = false;
    backBtn.addEventListener('click', () => { location.href = appUrl; });
    // Try once by itself — "Du wirst automatisch zurückgeleitet" (touchpoint guide). Browsers may
    // ask first or refuse without a tap; the button stays for that.
    setTimeout(() => { location.href = appUrl; }, 400);
  }
}
function hangUp() { if (ended) return; ended = true; haptic('medium'); wsSend({ type: 'hangup' }); teardownCall(); markRoomEnded(); showEnded('Du hast aufgelegt.'); }
/**
 * An ad-hoc call that ended stays ended in this browser: reloaded, the page used to enter the empty
 * room again and wait forever ("warte auf die anderen …"). Scheduled calls are left alone — their
 * link is meant to lead back in. See the boot dispatch at the end of this file.
 */
const ENDED_KEY = () => 'eudi_ended_' + roomId;
function markRoomEnded() { if (roomId && !inviteCfg) { try { localStorage.setItem(ENDED_KEY(), String(Date.now())); } catch {} } }
function roomEndedHere() { try { return !!(roomId && !inviteCfg && !createdHere && localStorage.getItem(ENDED_KEY())); } catch { return false; } }

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
 * Anyone who opens the window early and waits (the normal case for a scheduled call) must not
 * sit in front of a dead screen, so the client counts down and joins by itself at opening time.
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
  ended = false;       // the refusal was the reason for stopping — it no longer applies
  // The server did NOT close the connection after `invite-invalid`, so it is still up.
  // `reconnectNow()` would therefore do nothing (it considers an open socket healthy) — the
  // countdown would run out and nothing would happen until a reload. On an open socket a fresh
  // `join` is enough.
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
  ended = true; // no reconnect loop on a refusal
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
 * Not location.reload(), i.e. the same URL with ?room=<old>: the server does NOT remove a
 * participant on `hangup` (it only relays, so that a reconnect after switching wallets can still
 * resume), so the old room still has both sides at verified+confirmed. A reload would resume into
 * exactly that room, receive `ready` again and build a connection to a far end whose
 * PeerConnection had long been torn down -> "connecting …" forever, with the names of the old
 * call on screen.
 *
 * Drop `room`, add `new=1`, then reload: the roomId derivation above creates a fresh room (and
 * removes `new` again via replaceState), and the full reload clears every remnant of call state.
 *
 * Why `new=1` rather than simply emptying the query: at `/` the server serves the LANDING PAGE,
 * and the app only when `room`, `new`, `solo` or `embed` is set (see src/server.ts,
 * `app.get('/')`). Without the flag you end up on the start page instead of in a new call.
 *
 * Everything else has to survive — `embed`/`tok` (otherwise an embedded widget suddenly renders
 * the standalone app), `solo`, `lang` and especially the hash, which carries the configuration in
 * embed mode. Hence NOT location.pathname.
 * `replace` rather than `href`: the dead room should not sit in the back stack.
 */
function startFreshCall() {
  const u = new URL(location.href);
  // Everything that names the OLD room goes, not just `room`: back from the wallet the address
  // is /zurueck?r=… (in the app index.html?zurueck=1&r=…), and an expired appointment carries
  // ?inv=… — kept, they led straight back into the full room or the dead invitation.
  for (const k of ['room', 'r', 'zurueck', 'app', 'response_code', 'inv', 'pair', 'fresh']) u.searchParams.delete(k);
  if (u.pathname === '/zurueck') u.pathname = '/';
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
// Without a name, the role ("Gast", "Gastgeber:in") — the same words as the chips; "Gegenüber"
// only when not even that is known.
function peerName(peerId) { const p = peers.get(peerId); return p && p.name ? titleCase(p.name) : p && p.role ? roleLabelFor(p.role) : t('Gegenüber'); }
function wireChat(channel, peerId) {
  channel.binaryType = 'arraybuffer'; // receive file chunks as ArrayBuffer
  channel.onopen = () => {
    chatInput.disabled = false; chatSend.disabled = false;
    emojiBtn.disabled = !capOn('emoji'); fileBtn.disabled = !capOn('file-transfer');
    revealCall();
    // Whoever connects later (or meets someone who started muted) must see the state as it is,
    // not only the changes that follow.
    try { if (micMuted) channel.send(JSON.stringify({ k: 'mic', on: false })); if (camOff) channel.send(JSON.stringify({ k: 'cam', on: false })); } catch {}
    // No device at all (none there, or not allowed) — the other side would otherwise wait for a
    // picture or a voice that never comes. `none` lets them say why.
    try {
      const has = (kind) => localTracks().some((tr) => tr.kind === kind);
      if (mode !== 'chat' && !has('audio')) channel.send(JSON.stringify({ k: 'mic', on: false, none: true }));
      if (mode === 'video' && !has('video')) channel.send(JSON.stringify({ k: 'cam', on: false, none: true }));
    } catch {}
    if (!chatOpenedShown) { chatOpenedShown = true; addChat('System', soloMode ? 'Loopback-Kanal offen.' : 'Sichere Verbindung steht – Chat ist aktiv.', true); }
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
  else if (m && m.k === 'mic') { onPeerMic(peerId, !!m.on); if (m.none) noteNoDevice(peerId, 'mic'); }
  else if (m && m.k === 'cam') { onPeerCam(peerId, !!m.on); if (m.none) noteNoDevice(peerId, 'cam'); }
  else if (m && m.k === 'file-del') removeSharedFile(m.id, false);
  else addChat(who, data);
}
/** `quiet`: a line that is no news to anyone (your own message, "chat is open") — everything else
 *  is also shown for a moment in the call's head, so it is seen while the chat is out of view. */
function addChat(who, text, quiet = false) {
  const div = document.createElement('div'); div.className = 'msg' + (who === 'System' ? ' system' : '');
  const w = document.createElement('span'); w.className = 'who'; w.textContent = who + ': ';
  const tx = document.createElement('span'); tx.textContent = text;
  div.append(w, tx); chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight;
  if (!quiet) callHead().notice(who === 'System' ? text : who + ': ' + text);
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
  addChat(localNameTag.textContent || t('Du'), text, true); chatInput.value = '';
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
  haptic('light');
  enforceLocalMuteState(); // the sender is authoritative, not the source
  broadcast({ k: 'mic', on });
  syncMutedWatch();
  refreshAllBadges();
}
function toggleVideo() {
  const tr = localStream && localStream.getVideoTracks ? localStream.getVideoTracks() : [];
  if (!tr.length) return;
  const on = !tr[0].enabled; tr.forEach((t) => (t.enabled = on));
  setToggle(camBtn, camLabel, on, t('Kamera'), t('Kamera aus'));
  localVideo.style.opacity = on ? '' : '0.35';
  camOff = !on;
  haptic('light');
  enforceLocalMuteState();
  broadcast({ k: 'cam', on });
  refreshAllBadges();
}
/** Once per peer and device, in the chat: who joined without a microphone or camera. */
const noDeviceNoted = new Set();
function noteNoDevice(peerId, kind) {
  const key = peerId + ':' + kind;
  if (noDeviceNoted.has(key)) return;
  noDeviceNoted.add(key);
  addChat('System', `${peerName(peerId)}: ${t(kind === 'mic' ? 'ohne Mikrofon – hört dich, spricht aber nicht.' : 'ohne Kamera – du siehst kein Bild.')}`);
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
  renderBgPickers();
}
micBtn.addEventListener('click', toggleAudio);
camBtn.addEventListener('click', toggleVideo);


// ---- comfort: device check, arrival notice, "you are muted", screen stays on ----

/* One AudioContext for the chime and the level meters. Browsers keep it suspended until the
   page has seen a gesture, so it is created (and resumed) on the first one; without a gesture the
   chime simply stays silent — the tab title and the system notification still say it. */
let audioCtx = null;
function getAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) { try { audioCtx = new AC(); } catch { return null; } }
  // iOS also reports 'interrupted' (e.g. after the microphone took over the audio session).
  if (audioCtx.state !== 'running' && audioCtx.state !== 'closed') audioCtx.resume().catch(() => {});
  return audioCtx;
}
// Safari counts a touch as a user gesture only on touchend/click, not on pointerdown.
for (const ev of ['pointerdown', 'touchend', 'click', 'keydown']) document.addEventListener(ev, () => { getAudioCtx(); loadSoundMarks(); loadLogoMoment(); playPendingRingQ(); }, { passive: true, capture: true });

/* "Töne" switch (footer on the website, a row in the app's settings, and next to the logo in the
   call's head while its ring follows the steps of a call — the same setting in all places): off silences the
   chime and the sound mark, nothing else — the device check's test tone is asked for explicitly,
   the tab title and the system notification still say who arrived. Remembered per browser
   (`eudi_sounds`, like `eudi_theme`: a choice the visitor made, nothing leaves the device). */
const SOUND_KEY = 'eudi_sounds';
function soundsOn() { try { return localStorage.getItem(SOUND_KEY) !== '0'; } catch { return true; } }
(function initSoundToggle() {
  const btns = ['sound-toggle', 'ring-sound'].map($).filter(Boolean);
  if (!btns.length) return;
  const ICON = {
    on: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.4 18.4a9 9 0 0 0 0-12.8"/></svg>',
    off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>',
  };
  const render = () => {
    const on = soundsOn(), label = t(on ? 'Töne: an' : 'Töne: aus');
    for (const btn of btns) {
      btn.innerHTML = ICON[on ? 'on' : 'off'];
      btn.setAttribute('aria-pressed', String(on));
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
  };
  for (const btn of btns) btn.addEventListener('click', async () => {
    const on = !soundsOn();
    try { if (on) localStorage.removeItem(SOUND_KEY); else localStorage.setItem(SOUND_KEY, '0'); } catch {}
    render();
    if (on) { await loadSoundMarks(); playChime(); } // what "on" sounds like
  });
  render();
  i18nReady.then(render);
})();

/* The whosit sound mark: QRZ in Morse ("who is calling me?", public/sounds/README.md), heard letter
   by letter with the logo's ring along the steps of a call (updateRing, showLogoMoment), and its Q
   when the "Töne" switch is turned on. Only without operator branding: an operator's call should not carry our mark, there
   the neutral chime stays. Decoded once, after the first gesture (before it, nothing may sound).
   "Branded" means an operator NAME, exactly like the `branded` class (src/branding.ts): a logo
   alone is no operator brand — www.whosit.eu sets EUDI_BRAND_LOGO to our own mark. */
const OPERATOR_BRANDED = !!(window.EUDI_BRANDING && window.EUDI_BRANDING.name);
const SOUND_MARK = { connected: 'sounds/whosit-klangzeichen.mp3' };
const soundMarkBufs = {};
let soundMarkLoad = null, soundMarkPlayed = false;
function loadSoundMarks() {
  if (OPERATOR_BRANDED || soundMarkLoad) return soundMarkLoad;
  const ctx = getAudioCtx();
  if (!ctx) return null;
  soundMarkLoad = Promise.all(Object.entries(SOUND_MARK).map(async ([kind, url]) => {
    try { soundMarkBufs[kind] = await ctx.decodeAudioData(await (await fetch(url)).arrayBuffer()); } catch {}
  }));
  return soundMarkLoad;
}
/* The logo animation (public/logo-animation.js, the one approved animation of the logo) along
   the steps of a call (brand owner, 2026-11-14): the ring's three letters are the three steps.
   Q lights when this side is in a call being set up, R when everyone has identified and only
   "Verbinden" is left (it stays faint in a call where nobody presented anything: the gap says that
   nobody was checked), Z when the call connects; star and tick flash after the Z of a verified call. Each letter lights with
   its own tones of the sound mark, very quietly (RING_GAIN): a hint, not a signal. A letter not
   reached yet is faint; outside a call, and after it, the logo is the file again.
   Where: the call's head (initCallHead; light ground in both themes — the animation uses the
   colour file) and, when the call connects, a light card in the middle of the screen that lets
   taps through and is gone after about 3 s. Only on unbranded instances (it is our
   logo); with "reduce motion" the letters change without moving and there is no card. The tones
   follow the "Töne" switch. The logo file is fetched with the sound mark (first gesture), so the
   picture does not lag behind the sound. */
const RING_GAIN = 0.025; // 26 dB under the sound mark's 0.5
let logoMomentShown = false, logoMomentSvg = null;
function loadLogoMoment() {
  if (OPERATOR_BRANDED || logoMomentSvg || !window.whositLogoAnimation) return logoMomentSvg;
  logoMomentSvg = whositLogoAnimation.load('logo/logo-horizontal-colour.svg').catch(() => null);
  return logoMomentSvg;
}
const reducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const ring = { ctl: null, ready: null, state: { Q: false, R: false, Z: false }, active: 0, pendingQ: false };
function ringAllowed() { return !OPERATOR_BRANDED && !soloMode && !isEmbedded && !!window.whositLogoAnimation; }
/** Puts a built copy of the colour file into the call's head (#call-head), once. The header's
 *  <img> stays the file for the page outside a call. */
function loadHeaderRing() {
  if (ring.ready || !ringAllowed()) return ring.ready;
  const slot = $('ch-logo-btn');
  if (!slot) return null;
  ring.ready = whositLogoAnimation.load('logo/logo-horizontal-colour.svg').then((svg) => {
    slot.appendChild(svg);
    ring.ctl = whositLogoAnimation.steps(svg);
    if (ring.state.Q) ring.ctl.set(ring.state); // the call got ahead of the file
    return ring.ctl;
  }).catch(() => null);
  return ring.ready;
}
/** Everyone present has done what the call asks of them, so the review is open and "Verbinden"
 *  is all that is left — or the call is already past that point. */
function everyoneIdentified(active) {
  const m = lastStatusMsg;
  if (active >= 2 || callStarted) return true;
  const peersNow = (m && m.peers) || [];
  return !!(m && m.self && m.self.verified && peersNow.length > 0 && peersNow.every((p) => p.verified));
}
/** Anyone in the call presented something — the same test as the trust bar's. */
function callVerified() {
  const m = lastStatusMsg;
  return !!(m && (presentedOf(m.self) || (m.peers || []).some(presentedOf)));
}
/** Lights one letter of `ctl` with its tones; the picture follows the sound's clock. Without
 *  sound (switched off, nothing decoded yet, no gesture yet) it lights on its own time, and a Q
 *  keeps its tones for the next tap. */
async function lightLetter(ctl, letter, { flash = false, clock } = {}) {
  if (clock === undefined) {
    if (soundMarkLoad) await soundMarkLoad;
    clock = playSoundMark('connected', RING_GAIN, whositLogoAnimation.letters[letter]) || null;
    if (!clock && letter === 'Q') ring.pendingQ = true;
  }
  const before = { ...ring.state, [letter]: false };
  ctl.set(before);
  if (reducedMotion()) { ctl.set({ ...before, [letter]: true }); return clock; }
  await ctl.light(letter, { clock, flash });
  return clock;
}
/** The header ring follows the stepper. Lighting is animated with tones; going back (agreement
 *  withdrawn, call torn down) happens silently. Z is the logo moment's (showLogoMoment), here it
 *  is only kept in step afterwards — on again after a renewed agreement, off when the call drops. */
function updateRing(active) {
  ring.active = active;
  if (!ringAllowed() || !roomId) return;
  if (!ring.ctl) { const p = loadHeaderRing(); if (p) p.then((c) => { if (c) updateRing(ring.active); }); return; }
  const sw = $('ring-sound');
  if (sw && !ended) sw.hidden = false; // with the ring, not before (no ring if the file failed to load)
  if (!ended) callHead().show(true);
  if (ended) return restRing();
  const want = {
    Q: true,
    R: everyoneIdentified(active) && callVerified(),
    Z: logoMomentShown && callStarted && (ring.state.Z || anyConnected()),
  };
  const prev = ring.state;
  if (want.Q === prev.Q && want.R === prev.R && want.Z === prev.Z) return;
  ring.state = want;
  if (want.R) ring.pendingQ = false;
  const lit = ['Q', 'R'].filter((l) => want[l] && !prev[l]);
  // Going back, keeping Z in step, or a page loaded in the middle of the flow: without motion.
  if (!lit.length || (!prev.Q && want.R)) { ring.ctl.set(want); return; }
  lightLetter(ring.ctl, lit[0]);
}
/** After the call: the logo is the file again. */
function restRing() {
  if (ring.ctl) ring.ctl.rest();
  ring.state = { Q: false, R: false, Z: false };
  ring.pendingQ = false;
  const sw = $('ring-sound');
  if (sw) sw.hidden = true;
  callHead().show(false);
}
/* ---- the call's head (index.html #call-head; since 2026-11-14) ----
   Sticky at the top from the first step of a call to its end: the logo whose ring is the
   progress, where the call stands, and the ONE thing to do next. That action is the page's own
   button, pressed through a copy (it keeps its place, its checks and its label; the copy follows
   it): "Verbinden ✓" first, then "Anruf starten", the wallet, the invitation link. In the call:
   who is on the other side (the trust bar's names — a tap opens what was verified), how long, and
   what just happened (every chat line except your own, shown for a moment; a count while the chat
   is out of view). Only where the ring is (ringAllowed): branded, embedded and solo instances
   keep their page as it was. Built on first use (callHead()), so calls made while the script is
   still loading find it. */
function callHead() {
  if (callHead.api) return callHead.api;
  // Not built where it never shows (branded, embedded, solo) — asked again later, as solo mode and
  // the branding are only known after the start.
  if (!ringAllowed()) return { show() {}, step() {}, notice() {}, refresh() {} };
  return (callHead.api = initCallHead());
}
function initCallHead() {
  const box = $('call-head');
  const none = { show() {}, step() {}, notice() {}, refresh() {} };
  if (!box) return none;
  const title = $('ch-title'), sub = $('ch-sub'), status = $('ch-status'), act = $('ch-action'), logoBtn = $('ch-logo-btn');
  const noticeBox = $('ch-notice'), noticeText = $('ch-notice-text'), noticeBtn = $('ch-notice-btn');
  let step = { i: 0, n: 3, label: '' }, t0 = 0, unread = 0, noticeTimer = 0, chatInView = false, source = null, queued = false;
  const inCall = () => document.body.classList.contains('in-call');
  const shown = (el) => !!el && !el.disabled && el.getClientRects().length > 0;
  const m = () => lastStatusMsg || {};
  // The one next thing, in this order. `when` narrows it further.
  const ACTIONS = [
    { id: 'confirm-btn', cls: 'ch-go', label: (el) => el.textContent.trim() },
    { id: 'start-btn', cls: 'ch-go', label: () => ($('start-btn-label') || {}).textContent || t('Anruf starten') },
    { id: 'dyou-open', cls: '', label: () => t('Mit Wallet ausweisen'), when: () => !(m().self && m().self.verified) },
    { id: 'copy-btn', cls: 'ch-soft', label: () => (copyLabel && copyLabel.textContent) || t('Link kopieren'), when: () => !(m().peers || []).length },
  ];
  const chip = (text, ok) => { const s = document.createElement('span'); s.className = 'ch-chip' + (ok ? ' ok' : ''); s.textContent = text; return s; };
  const clock = () => { const s = Math.max(0, Math.floor((Date.now() - t0) / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const toChat = () => {
    const c = $('chat');
    if (c) c.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    unread = 0; noticeBox.hidden = true; refresh();
  };

  function refresh() {
    queued = false;
    if (box.hidden) return;
    const call = inCall();
    title.textContent = ''; sub.textContent = '';
    status.disabled = !call; logoBtn.disabled = !call;
    if (call) {
      if (!t0) t0 = Date.now();
      const tb = $('trust-bar'), names = $('trust-names');
      const verified = !!tb && !tb.classList.contains('unverified');
      title.classList.toggle('unverified', !verified);
      if (!verified) { const b = document.createElement('span'); b.className = 'ch-warn'; b.setAttribute('aria-hidden', 'true'); title.appendChild(b); }
      if (verified) { const b = document.createElement('span'); b.className = 'ch-ok'; b.setAttribute('aria-hidden', 'true'); title.appendChild(b); }
      const n = document.createElement('span'); n.className = 'ch-name'; n.textContent = names ? names.textContent : '';
      title.appendChild(n);
      const tm = document.createElement('span'); tm.className = 'ch-time'; tm.textContent = clock();
      const lk = document.createElement('span'); lk.className = 'ch-lock';
      lk.textContent = document.body.classList.contains('link-shaky') ? t('Verbindung stockt …') : t('Ende-zu-Ende verschlüsselt');
      sub.append(tm, lk);
      const open = document.body.classList.contains('trust-open');
      status.setAttribute('aria-expanded', String(open));
      logoBtn.setAttribute('aria-expanded', String(open));
    } else {
      t0 = 0;
      title.classList.remove('unverified');
      status.removeAttribute('aria-expanded'); logoBtn.removeAttribute('aria-expanded');
      title.textContent = step.label;
      sub.appendChild(chip(t('Schritt {n} von {m}', { n: Math.min(step.i + 1, step.n), m: step.n })));
      const s = m().self, peersNow = m().peers || [];
      if (s && s.verified) sub.appendChild(chip(t('Du') + ' ✓', true));
      peersNow.filter((p) => p.verified).forEach((p) => sub.appendChild(chip((p.name ? titleCase(p.name) : p.role ? roleLabelFor(p.role) : t('Gegenüber')) + ' ✓', true)));
    }
    // the action
    source = null;
    if (call) {
      act.hidden = !(unread > 0 && !chatInView);
      act.className = 'ch-soft';
      act.textContent = t('{n} neu im Chat', { n: unread });
    } else {
      const a = ACTIONS.find((x) => shown($(x.id)) && (!x.when || x.when()));
      act.hidden = !a;
      if (a) { source = $(a.id); act.className = a.cls; act.textContent = a.label(source); }
    }
  }
  const later = () => { if (!queued) { queued = true; requestAnimationFrame(refresh); } };

  act.addEventListener('click', () => {
    if (inCall()) return toChat();
    if (!source || !shown(source)) return later();
    // "Verbinden" is the consent: it is given with what will be shared in view. Out of view, the
    // first press brings the review up; the next one, with the review there, connects.
    const review = $('review');
    if (source.id === 'confirm-btn' && review) {
      const r = review.getBoundingClientRect(), bottom = window.innerHeight || document.documentElement.clientHeight;
      if (r.bottom < box.getBoundingClientRect().bottom + 40 || r.top > bottom - 40) {
        review.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
        return;
      }
    }
    source.click();
    later();
  });
  const toggleTrust = () => { const tb = $('trust-bar'); if (tb && inCall()) tb.click(); later(); };
  status.addEventListener('click', toggleTrust);
  logoBtn.addEventListener('click', toggleTrust);
  noticeBtn.addEventListener('click', toChat);
  // What the action copies changes outside this code: watch it instead of hooking every place.
  const obs = new MutationObserver(later);
  obs.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-wkind'] });
  for (const id of ['review', 'review-actions', 'review-wait', 'confirm-btn', 'start-bar', 'auth', 'share', 'setup', 'trust-names', 'trust-bar', 'copy-label']) {
    const el = $(id);
    if (el) obs.observe(el, { attributes: true, attributeFilter: ['hidden', 'disabled', 'class'], childList: true, characterData: true, subtree: ['copy-label', 'trust-names', 'start-bar', 'auth'].includes(id) });
  }
  // Web: the logo shrinks to its smallest width (160 px) once the page has moved.
  // The setup wizard moves between its steps by classes inside its cards: a click is when that happens.
  document.addEventListener('click', later, true);
  const onScroll = () => box.classList.toggle('ch-compact', window.scrollY > 24);
  window.addEventListener('scroll', onScroll, { passive: true });
  if ('IntersectionObserver' in window && chatLog) {
    new IntersectionObserver((es) => {
      chatInView = es[es.length - 1].isIntersecting;
      if (chatInView) { unread = 0; noticeBtn.hidden = true; }
      later();
    }, { threshold: 0.2 }).observe(chatLog);
  }
  setInterval(() => {
    if (box.hidden || !inCall() || !t0) return;
    const tm = sub.querySelector('.ch-time');
    if (tm) tm.textContent = clock();
  }, 1000);

  return {
    show(on) {
      if (box.hidden === !on) return;
      box.hidden = !on;
      document.body.classList.toggle('has-head', on);
      if (!on) { t0 = 0; unread = 0; noticeBox.hidden = true; clearTimeout(noticeTimer); }
      onScroll(); refresh();
    },
    step(i, n, label) { step = { i, n, label }; later(); },
    notice(text) {
      if (box.hidden || !inCall() || !text) return;
      noticeText.textContent = text;
      noticeBtn.hidden = chatInView || !$('chat') || $('chat').hidden;
      noticeBox.hidden = false;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => { noticeBox.hidden = true; }, 4000);
      if (!chatInView) unread++;
      later();
    },
    refresh: later,
  };
}
/** A Q that came before any gesture is heard at the first tap — as long as R has not come yet. */
function playPendingRingQ() {
  if (!ring.pendingQ || ring.state.R || ended) return;
  Promise.resolve(loadSoundMarks()).then(() => {
    if (!ring.pendingQ || ring.state.R || ended) return;
    if (playSoundMark('connected', RING_GAIN, whositLogoAnimation.letters.Q)) ring.pendingQ = false;
  });
}
/** The call connected: the Z, in the header and on the card, once per page. */
async function showLogoMoment() {
  if (logoMomentShown || OPERATOR_BRANDED || !window.whositLogoAnimation) return;
  logoMomentShown = true;
  ring.pendingQ = false;
  const verified = callVerified();
  if (soundMarkLoad) await soundMarkLoad;
  const clock = playSoundMark('connected', RING_GAIN, whositLogoAnimation.letters.Z) || null;
  ring.state = { Q: true, R: verified, Z: true };
  if (ring.ctl && ringAllowed() && !ended) {
    ring.ctl.set({ Q: true, R: verified, Z: false });
    lightLetter(ring.ctl, 'Z', { flash: verified, clock });
  }
  const box = $('logo-moment');
  if (!box || reducedMotion()) return;
  const svg = await loadLogoMoment();
  if (!svg || ended) return;
  if (!box.firstChild) { const card = document.createElement('div'); card.className = 'logo-moment-card'; card.appendChild(svg); box.appendChild(card); }
  const card = whositLogoAnimation.steps(svg);
  card.set({ Q: true, R: verified, Z: false });
  box.hidden = false; box.classList.remove('out');
  await card.light('Z', { clock, flash: verified });
  await new Promise((r) => setTimeout(r, verified ? 700 : 400)); // the flash takes 0.7 s
  box.classList.add('out');
  setTimeout(() => { box.hidden = true; box.classList.remove('out'); }, 450);
}

/** `span`: only this part of the mark ({ from, to } in seconds — one letter of QRZ), faded out at
 *  its end so the cut does not click. */
function playSoundMark(kind, gain = 0.5, span = null) {
  const ctx = getAudioCtx(), buf = soundMarkBufs[kind];
  if (!soundsOn() || OPERATOR_BRANDED || !ctx || ctx.state !== 'running' || !buf) return false;
  const src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = buf;
  const at = ctx.currentTime, from = span ? span.from : 0;
  const dur = span ? Math.min(span.to, buf.duration) - from : buf.duration;
  g.gain.setValueAtTime(gain, at);
  if (span) { g.gain.setValueAtTime(gain, at + Math.max(0, dur - 0.03)); g.gain.linearRampToValueAtTime(0.0001, at + dur); }
  src.connect(g).connect(ctx.destination); src.start(at, from, dur);
  // The clock of this sound for the logo animation: seconds of the mark audible now, the output
  // latency (Bluetooth, CarPlay: a lot) taken off.
  return () => from + ctx.currentTime - at - (ctx.outputLatency || ctx.baseLatency || 0);
}

/* Level of a microphone track. A disabled (muted) track reads as silence, so that one is measured
   on a CLONE; an enabled one directly (iOS has been unreliable with cloned microphone tracks).
   The analyser feeds a silent gain into the output: WebKit does not render a graph that never
   reaches the destination, and the meter would sit at zero. */
function levelMeter(track) {
  const ctx = getAudioCtx();
  if (!ctx || !track) return null;
  const own = track.enabled ? null : track.clone();
  if (own) own.enabled = true;
  const src = ctx.createMediaStreamSource(new MediaStream([own || track]));
  const an = ctx.createAnalyser(); an.fftSize = 1024;
  const sink = ctx.createGain(); sink.gain.value = 0;
  src.connect(an); an.connect(sink); sink.connect(ctx.destination);
  const buf = new Float32Array(an.fftSize);
  return {
    level() {
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      an.getFloatTimeDomainData(buf); let sum = 0; for (const v of buf) sum += v * v; return Math.sqrt(sum / buf.length);
    },
    stop() { try { src.disconnect(); an.disconnect(); sink.disconnect(); } catch {} if (own) own.stop(); },
  };
}

// -- device check --
const mcCard = $('media-check'), mcTitle = $('mc-title'), mcStart = $('mc-start'), mcLive = $('mc-live');
const mcVideo = $('mc-video'), mcLevel = $('mc-level'), mcStop = $('mc-stop'), mcTone = $('mc-tone');
const mcCam = $('mc-cam'), mcMic = $('mc-mic'), mcSpk = $('mc-spk');
const mcCamRow = $('mc-cam-row'), mcSpkRow = $('mc-spk-row'), mcCamOffRow = $('mc-camoff-row');
const mcStartMuted = $('mc-start-muted'), mcStartCamOff = $('mc-start-camoff');
/* The chosen devices are remembered per browser (a convenience — nothing leaves the device); the
   "join muted" choices are not: a mute nobody remembers setting is worse than none. */
const DEV_KEY = 'eudi_devices';
const devPref = (() => { try { return JSON.parse(localStorage.getItem(DEV_KEY)) || {}; } catch { return {}; } })();
function saveDevPref() { try { localStorage.setItem(DEV_KEY, JSON.stringify(devPref)); } catch {} }
const sinkSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
let previewStream = null, previewStreamMode = null, previewMeter = null, previewTimer = null;

function mediaConstraints() {
  const audio = devPref.mic ? { deviceId: { ideal: devPref.mic } } : true;
  if (mode === 'audio') return { audio, video: false };
  // Without a chosen camera the front one: phones (and the app) otherwise may open the back camera.
  return { audio, video: devPref.cam ? { deviceId: { ideal: devPref.cam } } : { facingMode: 'user' } };
}
function applySink(el) {
  if (sinkSupported && devPref.spk && el && el.setSinkId) el.setSinkId(devPref.spk).catch(() => {});
}

function syncMediaCheck() {
  if (!mcCard) return;
  const can = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const show = can && !callStarted && !ended && !soloMode && !isEmbedded && !!myRole && mode !== 'chat';
  mcCard.hidden = !show;
  // A different call type needs a different stream (audio only vs. with camera); the call itself
  // takes the stream over, so only stop it while there is no call to hand it to.
  if (previewStream && ((!callStarted && (!show || previewStreamMode !== mode)) || ended)) stopPreview();
  if (mcTitle) mcTitle.textContent = t(mode === 'audio' ? 'Mikrofon prüfen' : 'Kamera und Mikrofon prüfen');
  if (mcCamOffRow) mcCamOffRow.hidden = mode !== 'video';
  renderBgPickers();
}

async function startPreview() {
  getAudioCtx(); // still inside the tap: unlocks the meter's AudioContext on iOS
  stopPreview();
  if (mcStart) mcStart.disabled = true;
  setMediaState('pending');
  try {
    const s = await navigator.mediaDevices.getUserMedia(mediaConstraints());
    if (callStarted || ended) { s.getTracks().forEach((tr) => tr.stop()); return; }
    previewStream = s; previewStreamMode = mode;
    setMediaState('idle');
    mcVideo.hidden = mode !== 'video';
    mcVideo.srcObject = mode === 'video' ? s : null;
    if (mode === 'video') queueBackground(s);
    previewMeter = levelMeter(s.getAudioTracks()[0]);
    const meterEl = mcLevel.parentElement;
    previewTimer = setInterval(() => {
      const pct = previewMeter ? Math.min(100, Math.round(Math.sqrt(previewMeter.level()) * 180)) : 0;
      mcLevel.style.width = pct + '%';
      meterEl.setAttribute('aria-valuenow', String(pct));
    }, 100);
    mcLive.hidden = false; mcStart.hidden = true;
    await fillDeviceLists();
  } catch (e) {
    setMediaState(mediaErrorState(e));
  } finally {
    if (mcStart) mcStart.disabled = false;
  }
}

/** `handover`: the call took the stream — keep its tracks running. */
function stopPreview(handover) {
  clearInterval(previewTimer); previewTimer = null;
  if (previewMeter) { previewMeter.stop(); previewMeter = null; }
  if (previewStream && !handover) stopMediaStream(previewStream);
  previewStream = null; previewStreamMode = null;
  if (mcVideo) mcVideo.srcObject = null;
  if (mcLevel) mcLevel.style.width = '0';
  if (mcLive) mcLive.hidden = true;
  if (mcStart) mcStart.hidden = false;
}

async function fillDeviceLists() {
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const inUse = (kind) => {
    const tr = previewStream && (kind === 'audioinput' ? previewStream.getAudioTracks()[0] : previewStream.getVideoTracks()[0]);
    return tr && tr.getSettings ? tr.getSettings().deviceId : '';
  };
  const fill = (sel, kind, selected, fallback) => {
    const list = devs.filter((d) => d.kind === kind && d.deviceId);
    sel.textContent = '';
    list.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `${fallback} ${i + 1}`;
      sel.appendChild(o);
    });
    if (selected && list.some((d) => d.deviceId === selected)) sel.value = selected;
    return list.length;
  };
  const nCam = fill(mcCam, 'videoinput', inUse('videoinput'), t('Kamera'));
  fill(mcMic, 'audioinput', inUse('audioinput'), t('Mikrofon'));
  mcCamRow.hidden = mode !== 'video' || nCam < 1;
  const nSpk = sinkSupported ? fill(mcSpk, 'audiooutput', devPref.spk, t('Lautsprecher')) : 0;
  mcSpkRow.hidden = nSpk < 1;
}

/* A short two-note tone as a WAV, played through an <audio> element — unlike Web Audio, that
   element can be routed to the chosen speaker. */
let toneUrl = null;
function testToneUrl() {
  if (toneUrl) return toneUrl;
  const rate = 22050, secs = 0.9, n = Math.floor(rate * secs);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const tt = i / rate, f = tt < secs / 2 ? 660 : 880, local = tt % (secs / 2);
    const env = Math.min(1, local * 40) * Math.max(0, 1 - local / (secs / 2));
    v.setInt16(44 + i * 2, Math.sin(2 * Math.PI * f * tt) * env * 0.35 * 32767, true);
  }
  toneUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return toneUrl;
}

if (mcCard) {
  mcStart.addEventListener('click', startPreview);
  mcStop.addEventListener('click', () => { stopPreview(); setMediaState('idle'); });
  mcCam.addEventListener('change', () => { devPref.cam = mcCam.value; saveDevPref(); startPreview(); });
  mcMic.addEventListener('change', () => { devPref.mic = mcMic.value; saveDevPref(); startPreview(); });
  mcSpk.addEventListener('change', () => {
    devPref.spk = mcSpk.value; saveDevPref();
    for (const el of document.querySelectorAll('video:not(#local-video):not(#mc-video), audio')) applySink(el);
  });
  mcTone.addEventListener('click', () => {
    // The whosit sound mark (an operator's instance: the neutral tone), routed to the chosen speaker.
    const a = new Audio(OPERATOR_BRANDED ? testToneUrl() : SOUND_MARK.connected);
    applySink(a);
    a.play().catch(() => {});
  });
}

/** "Join muted" / "join with camera off", applied once the call's own stream exists. */
function applyStartPrefs() {
  if (!localStream || !localStream.getTracks) return;
  if (mcStartMuted && mcStartMuted.checked && !micMuted && localStream.getAudioTracks().length) {
    localStream.getAudioTracks().forEach((tr) => (tr.enabled = false));
    micMuted = true;
    setToggle(micBtn, micLabel, false, t('Mikrofon'), t('Stumm'));
  }
  if (mcStartCamOff && mcStartCamOff.checked && mode === 'video' && !camOff && localStream.getVideoTracks().length) {
    localStream.getVideoTracks().forEach((tr) => (tr.enabled = false));
    camOff = true;
    setToggle(camBtn, camLabel, false, t('Kamera'), t('Kamera aus'));
    localVideo.style.opacity = '0.35';
  }
  enforceLocalMuteState();
}

// -- background: blur it or replace it (Community `background-effects`) --
/* The effect wraps the camera track of whichever stream is current (device check or call):
   background.mjs turns the real camera track into a composited canvas track, and that one takes
   the camera's place in the stream and in every sender. The choice is remembered per browser
   like the devices; a custom image stays in this browser (localStorage) and is never uploaded —
   only the composited picture is sent, as the camera picture would be. */
const BG_CUSTOM_KEY = 'eudi_bg_custom';
/* The whosit background shows the approved logo FILE (public/logo, unchanged), and only on
   unbranded instances: an operator's call should not carry our mark behind their customers. */
const BG_BRANDED = OPERATOR_BRANDED;
const BG_CHOICES = [
  ['none', 'Kein Effekt'], ['blur', 'Weichzeichnen'], ...(BG_BRANDED ? [] : [['whosit', 'whosit']]),
  ['custom', 'Eigenes Bild'],
];
// A choice that is no longer offered (the drawn backgrounds p1–p4 until 2026-10-29, or whosit on a
// branded instance) falls back to no effect instead of silently drawing nothing.
if (devPref.bg && !BG_CHOICES.some(([id]) => id === devPref.bg)) { devPref.bg = 'none'; saveDevPref(); }
const bgLogo = BG_BRANDED ? null : new Image();
if (bgLogo) {
  bgLogo.onload = () => {
    // Drawn before the logo had loaded: draw again, and refresh the thumbnails.
    for (const k of [...bgPresetCache.keys()]) if (k.startsWith('whosit:')) bgPresetCache.delete(k);
    for (const b of document.querySelectorAll('.bg-tile[data-bg="whosit"]')) b.style.backgroundImage = `url(${bgPresetCanvas('whosit', 160, 90).toDataURL()})`;
    if (bgProc && devPref.bg === 'whosit') bgProc.setEffect({ image: bgPresetCanvas('whosit') });
  };
  bgLogo.src = 'logo/logo-horizontal-white.svg';
}
const bgFile = $('bg-file'), bgBtn = $('bg-btn'), bgPop = $('bg-pop'), mcBgRow = $('mc-bg-row');
let bgMod = null, bgProc = null, bgRaw = null, bgStream = null;
let bgBusy = false, bgFailed = false, bgNote = '', bgCustomImg = null, bgChain = Promise.resolve();
const bgPresetCache = new Map();

/* Only the SIMD WebAssembly build is shipped; without SIMD (or canvas capture) there is no
   effect at all rather than a slow one. */
const BG_CAPABLE = (() => {
  try {
    if (typeof WebAssembly !== 'object' || !('captureStream' in HTMLCanvasElement.prototype)) return false;
    // (module (func (result v128) i32.const 0 i8x16.splat i8x16.popcnt)) — as in wasm-feature-detect
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch { return false; }
})();
function bgSupported() { return BG_CAPABLE && !bgFailed && capOn('background-effects') && mode === 'video'; }

/* The whosit background is drawn around the logo file: nothing else to ship or license. */
function drawBgPreset(id, ctx, w, h) {
  const lin = (stops) => { const g = ctx.createLinearGradient(0, 0, w, h); stops.forEach(([o, c]) => g.addColorStop(o, c)); return g; };
  const glow = (x, y, r, c) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  };
  if (id === 'whosit') { // night blue, the white logo file repeated as a quiet pattern
    ctx.fillStyle = lin([[0, '#0b1530'], [1, '#17305c']]); ctx.fillRect(0, 0, w, h);
    glow(w * 0.15, h * 0.9, w * 0.6, 'rgba(74, 163, 232, 0.14)');
    if (bgLogo && bgLogo.complete && bgLogo.naturalWidth) {
      // Many small logos instead of one: the picture is cropped (a phone held upright shows only a
      // narrow middle strip of this 16:9 canvas) and the person covers the middle, so a single
      // logo was never in view (2026-10-29). Brick rows, sized by the height so the crop keeps
      // them readable; the unchanged white file (dark ground), drawn faint so it stays a backdrop.
      const lw = h * 0.2, lh = lw * (bgLogo.naturalHeight / bgLogo.naturalWidth);
      const dx = lw * 1.7, dy = lh * 2.4;
      ctx.save();
      ctx.globalAlpha = 0.3;
      for (let r = 0, y = dy * 0.35; y < h; r++, y += dy) {
        for (let x = (r % 2 ? dx / 2 : 0) - dx / 2 + (w / 2 % dx); x < w; x += dx) ctx.drawImage(bgLogo, x, y, lw, lh);
      }
      ctx.restore();
    }
  }
}
function bgPresetCanvas(id, w = 1280, h = 720) {
  const key = `${id}:${w}`;
  if (!bgPresetCache.has(key)) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    drawBgPreset(id, c.getContext('2d'), w, h);
    bgPresetCache.set(key, c);
  }
  return bgPresetCache.get(key);
}

function loadBgImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img); img.onerror = reject;
    img.src = src;
  });
}
/* Scaled down once to at most 1280 px: enough for a background, small enough for localStorage. */
function bgToCanvas(img) {
  const s = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
async function bgCustom() {
  if (bgCustomImg) return bgCustomImg;
  let src = null;
  try { src = localStorage.getItem(BG_CUSTOM_KEY); } catch {}
  if (!src) return null;
  try { bgCustomImg = bgToCanvas(await loadBgImage(src)); } catch { bgCustomImg = null; }
  return bgCustomImg;
}

function currentBgStream() { return localStream || previewStream || null; }

/* Put `to` where `from` was: in the stream, in every sender, in the screen-share memory, and in
   every <video> showing that stream (an element does not always notice a swapped track). */
function swapVideoTrack(stream, from, to) {
  stream.removeTrack(from); stream.addTrack(to);
  for (const p of peers.values()) {
    if (!p.pc || typeof p.pc.getSenders !== 'function') continue;
    for (const s of p.pc.getSenders()) if (s.track === from) s.replaceTrack(to).catch(() => {});
  }
  if (cameraTrack === from) cameraTrack = to;
  for (const v of document.querySelectorAll('video')) {
    if (v.srcObject === stream) { v.srcObject = null; v.srcObject = stream; v.play().catch(() => {}); }
  }
  enforceLocalMuteState();
}

function unwrapBackground() {
  if (!bgProc) return;
  const stream = bgStream, raw = bgRaw, proc = bgProc;
  bgProc = bgRaw = bgStream = null;
  raw.enabled = proc.track.enabled;
  if (stream && raw.readyState !== 'ended') swapVideoTrack(stream, proc.track, raw);
  proc.stop();
}

/** Stop a stream for good — including the real camera behind an effect, which the stream no
 *  longer holds itself (the camera light would stay on). */
function stopMediaStream(stream) {
  if (!stream) return;
  if (bgProc && bgStream === stream) {
    const raw = bgRaw;
    bgProc.stop(); raw.stop();
    bgProc = bgRaw = bgStream = null;
  }
  stream.getTracks().forEach((tr) => tr.stop());
}

async function applyBackground(stream) {
  if (bgProc && bgStream !== stream) unwrapBackground(); // the effect belongs to an older stream
  const want = stream && bgSupported() ? (devPref.bg || 'none') : 'none';
  if (want === 'none') { unwrapBackground(); return; }
  let effect = 'blur';
  if (want === 'custom') {
    const img = await bgCustom();
    if (!img) { devPref.bg = 'none'; saveDevPref(); unwrapBackground(); return; }
    effect = { image: img };
  } else if (want !== 'blur') {
    effect = { image: bgPresetCanvas(want) };
  }
  if (bgProc) { bgProc.setEffect(effect); return; }
  const raw = stream.getVideoTracks()[0];
  if (!raw || raw.readyState === 'ended') return;
  bgBusy = true; renderBgPickers();
  try {
    bgMod = bgMod || await import('./background.mjs');
    const proc = await bgMod.createProcessor(raw, effect);
    // Meanwhile the stream may have been replaced (other camera) or ended.
    if (stream.getVideoTracks()[0] !== raw || raw.readyState === 'ended' || currentBgStream() !== stream) { proc.stop(); return; }
    bgProc = proc; bgRaw = raw; bgStream = stream;
    proc.track.enabled = raw.enabled;
    swapVideoTrack(stream, raw, proc.track);
  } catch (e) {
    console.warn('Hintergrund-Effekt nicht verfügbar:', e && e.message);
    bgFailed = true;
  } finally {
    bgBusy = false; renderBgPickers();
  }
}
/** Serialised: quick taps on several tiles must not build several processors. */
function queueBackground(stream = currentBgStream()) {
  bgChain = bgChain.then(() => applyBackground(stream)).catch(() => {}).then(renderBgPickers);
  return bgChain;
}
function setBackground(id) {
  devPref.bg = id; saveDevPref(); bgNote = '';
  renderBgPickers();
  if (currentBgStream()) queueBackground();
}

function renderBgPicker(el) {
  if (!el.dataset.built) {
    el.dataset.built = '1';
    const list = document.createElement('div'); list.className = 'bg-tiles';
    for (const [id, label] of BG_CHOICES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'bg-tile'; b.dataset.bg = id; b.dataset.label = label;
      if (/^p\d$/.test(id) || id === 'whosit') b.style.backgroundImage = `url(${bgPresetCanvas(id, 160, 90).toDataURL()})`;
      else b.innerHTML = id === 'none'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>'
        : id === 'blur'
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="9" r="3.2"/><path d="M6 20c.8-3.5 3.2-5.5 6-5.5s5.2 2 6 5.5"/><circle cx="3.5" cy="5" r=".6"/><circle cx="20.5" cy="5" r=".6"/><circle cx="3.5" cy="12" r=".6"/><circle cx="20.5" cy="12" r=".6"/><circle cx="3.5" cy="19" r=".6"/><circle cx="20.5" cy="19" r=".6"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>';
      b.addEventListener('click', () => {
        if (id !== 'custom') { setBackground(id); return; }
        // The custom tile chooses a picture the first time and whenever it is already selected.
        if (bgCustomImg && devPref.bg !== 'custom') setBackground('custom');
        else if (bgFile) bgFile.click();
      });
      list.appendChild(b);
    }
    const status = document.createElement('p'); status.className = 'hint bg-status'; status.hidden = true;
    el.append(list, status);
  }
  const cur = devPref.bg || 'none';
  for (const b of el.querySelectorAll('.bg-tile')) {
    const id = b.dataset.bg, on = id === cur;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    const label = id === 'custom' && bgCustomImg ? (on ? t('Anderes Bild wählen') : t('Eigenes Bild')) : t(b.dataset.label);
    b.setAttribute('aria-label', label); b.title = label;
    if (id === 'custom' && bgCustomImg && !b.dataset.thumb) {
      b.dataset.thumb = '1'; b.innerHTML = '';
      b.style.backgroundImage = `url(${bgCustomImg.toDataURL('image/jpeg', 0.6)})`;
    }
    b.classList.toggle('is-busy', on && bgBusy);
  }
  const status = el.querySelector('.bg-status');
  const msg = bgBusy ? t('Hintergrund wird vorbereitet …') : bgFailed ? t('Hintergrund-Effekte sind auf diesem Gerät nicht verfügbar.') : bgNote ? t(bgNote) : '';
  status.hidden = !msg; status.textContent = msg;
}
function renderBgPickers() {
  // A background with writing on it (the logo, possibly an own picture) would read backwards in
  // the mirrored self-view; while one is on, you see yourself as the other side sees you.
  document.body.classList.toggle('bg-unmirror', !!bgProc && (devPref.bg === 'whosit' || devPref.bg === 'custom'));
  const show = bgSupported() || (bgFailed && capOn('background-effects') && mode === 'video' && BG_CAPABLE);
  if (mcBgRow) mcBgRow.hidden = !show;
  const inCall = callStarted && !ended && localStream && localStream.getVideoTracks && localStream.getVideoTracks().length > 0;
  if (bgBtn) bgBtn.hidden = !(show && inCall);
  if (bgPop && (!show || !inCall)) bgPop.hidden = true;
  if (bgBtn) bgBtn.setAttribute('aria-expanded', bgPop && !bgPop.hidden ? 'true' : 'false');
  for (const el of document.querySelectorAll('[data-bg-picker]')) renderBgPicker(el);
}

if (bgFile) {
  bgFile.addEventListener('change', async () => {
    const f = bgFile.files && bgFile.files[0];
    bgFile.value = '';
    if (!f) return;
    const url = URL.createObjectURL(f);
    try {
      bgCustomImg = bgToCanvas(await loadBgImage(url));
      for (const b of document.querySelectorAll('.bg-tile[data-bg="custom"]')) delete b.dataset.thumb;
      try { localStorage.setItem(BG_CUSTOM_KEY, bgCustomImg.toDataURL('image/jpeg', 0.85)); } catch {}
      if (bgProc && devPref.bg === 'custom') bgProc.setEffect({ image: bgCustomImg });
      setBackground('custom');
    } catch {
      bgNote = 'Das Bild konnte nicht geladen werden.'; renderBgPickers();
    } finally {
      URL.revokeObjectURL(url);
    }
  });
}
if (bgBtn && bgPop) {
  bgBtn.addEventListener('click', () => { bgPop.hidden = !bgPop.hidden; renderBgPickers(); });
  document.addEventListener('pointerdown', (e) => {
    if (!bgPop.hidden && !bgPop.contains(e.target) && !bgBtn.contains(e.target)) { bgPop.hidden = true; renderBgPickers(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !bgPop.hidden) { bgPop.hidden = true; renderBgPickers(); bgBtn.focus(); } });
}
i18nReady.then(renderBgPickers);

// -- arrival notice: whoever waits learns that the other side is there --
const notifyBtn = $('notify-btn'), notifyLabel = $('notify-label');
const canNotify = () => typeof Notification !== 'undefined' && !isNativeApp() && !isEmbedded;
let knownPeers = null; // null until the first status: whoever is already there when you arrive is no news
let knownVerified = null;
let titleBefore = null;

function syncNotifyBtn() {
  if (!notifyBtn) return;
  const perm = canNotify() ? Notification.permission : 'denied';
  notifyBtn.hidden = !isHost() || perm === 'denied';
  notifyBtn.disabled = perm === 'granted';
  if (notifyLabel) notifyLabel.textContent = t(perm === 'granted' ? 'Du wirst benachrichtigt, wenn dein Gast da ist ✓' : 'Benachrichtigen, wenn mein Gast da ist');
}
if (notifyBtn) {
  notifyBtn.addEventListener('click', async () => {
    try { await Notification.requestPermission(); } catch {}
    syncNotifyBtn();
  });
  i18nReady.then(syncNotifyBtn);
}

function playChime() {
  if (!soundsOn()) return;
  // What "on" sounds like: the Q of the ring, at the ring's level — the switch promises no more.
  const q = window.whositLogoAnimation && whositLogoAnimation.letters.Q;
  if (q && playSoundMark('connected', RING_GAIN, q)) return;
  const ctx = getAudioCtx();
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  [[660, 0], [990, 0.16]].forEach(([f, at]) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now + at);
    g.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.45);
    o.connect(g).connect(ctx.destination);
    o.start(now + at); o.stop(now + at + 0.5);
  });
}

/* Away = the tab is hidden OR the window is not in front (another app over a visible browser
   window counts as visible for the Page Visibility API). */
const awayFromCall = () => document.hidden || !document.hasFocus();
function notifyAway(text, tag) {
  if (!awayFromCall()) return;
  if (titleBefore === null) titleBefore = document.title;
  document.title = '● ' + text;
  if (canNotify() && Notification.permission === 'granted') {
    try {
      const n = new Notification(text, { body: t('Zum Anruf wechseln'), tag });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {}
  }
}

function noticeArrivals(msg) {
  syncNotifyBtn();
  const now = new Map((msg.peers || []).filter((x) => x.peerId).map((x) => [x.peerId, x]));
  const before = knownPeers, verifiedBefore = knownVerified;
  knownPeers = new Set(now.keys());
  knownVerified = new Set([...now.values()].filter((x) => x.verified).map((x) => x.peerId));
  if (!before || soloMode || ended) return;
  const fresh = [...now.values()].filter((x) => !before.has(x.peerId));
  // Identified since the last status — the host's cue to identify too (or that the call can start).
  const nowVerified = [...now.values()].filter((x) => x.verified && !verifiedBefore.has(x.peerId));
  // Felt rather than heard: the moment the other side is who they claim to be.
  if (nowVerified.length && !callStarted) haptic('success');
  // In the call, a newcomer already shows up in chat and tiles — only worth a sound when away.
  if (callStarted && !awayFromCall()) return;
  if (fresh.length) {
    const text = fresh.some((x) => x.role === 'caller') && !isHost() ? t('Gastgeber:in ist da')
      : before.size === 0 ? t('Dein Gast ist da') : t('Ein weiterer Gast ist da');
    // No sound: whosit sounds once per call, when the two connect (Jakob, 2026-11-02). The tab
    // title and the system notification still say it.
    notifyAway(text, 'whosit-arrival');
  }
  if (nowVerified.length && !callStarted) {
    const text = nowVerified.some((x) => x.role === 'caller') && !isHost() ? t('Gastgeber:in hat sich ausgewiesen')
      : t('Dein Gast hat sich ausgewiesen');
    notifyAway(text, 'whosit-verified');
  }
}
const restoreTitle = () => { if (!awayFromCall() && titleBefore !== null) { document.title = titleBefore; titleBefore = null; } };
document.addEventListener('visibilitychange', restoreTitle);
window.addEventListener('focus', restoreTitle);

// -- "you are muted": speaking into a muted microphone --
const mutedHint = $('muted-hint'), mutedHintBtn = $('muted-hint-btn');
const MUTED_SPEECH_RMS = 0.015; // after the browser's noise suppression: above room noise, below quiet speech
let mutedWatch = null, mutedHintTimer = null;
function syncMutedWatch() {
  const hasMic = localStream && localStream.getAudioTracks && localStream.getAudioTracks().length;
  const want = callStarted && !ended && micMuted && !!hasMic;
  if (want && !mutedWatch) startMutedWatch();
  else if (!want) stopMutedWatch();
}
function startMutedWatch() {
  const meter = levelMeter(localStream.getAudioTracks()[0]);
  if (!meter) return;
  const hist = [];
  let quietUntil = 0;
  const timer = setInterval(() => {
    hist.push(meter.level() > MUTED_SPEECH_RMS);
    if (hist.length > 10) hist.shift();
    if (Date.now() < quietUntil || document.hidden) return;
    // ~1.2 s of speech within 2 s: a cough or a door is not enough.
    if (hist.filter(Boolean).length >= 6) { showMutedHint(); quietUntil = Date.now() + 30_000; hist.length = 0; }
  }, 200);
  mutedWatch = { stop() { clearInterval(timer); meter.stop(); } };
}
function stopMutedWatch() {
  if (mutedWatch) { mutedWatch.stop(); mutedWatch = null; }
  if (mutedHint) mutedHint.hidden = true;
  clearTimeout(mutedHintTimer);
}
function showMutedHint() {
  if (!mutedHint) return;
  mutedHint.hidden = false;
  clearTimeout(mutedHintTimer);
  mutedHintTimer = setTimeout(() => { mutedHint.hidden = true; }, 6000);
}
if (mutedHintBtn) mutedHintBtn.addEventListener('click', () => { mutedHint.hidden = true; if (micMuted) toggleAudio(); });

// -- the screen stays on during a call (phones would dim and lock mid-sentence) --
let wakeLock = null, wakeLockPending = false;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || wakeLockPending || ended || !callStarted || document.hidden) return;
  wakeLockPending = true;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    if (ended) releaseWakeLock();
  } catch { wakeLock = null; } finally { wakeLockPending = false; }
}
function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
// The lock is dropped whenever the page is hidden; take it again on return.
document.addEventListener('visibilitychange', () => { if (!document.hidden) acquireWakeLock(); });

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
// What a peer may push into this tab. The sender is the other side of the call, so its
// announcement is checked here too: the operator's switch for file transfer, and a size bound so
// a peer cannot fill this tab's memory (security audit 2026-11-11).
const MAX_INCOMING_FILE_BYTES = 200 * 1024 * 1024;
function onFileMeta(peerId, who, m) {
  const key = peerId || '__solo__';
  if (!capOn('file-transfer')) return;
  const size = Number(m.size);
  if (!Number.isFinite(size) || size < 0 || size > MAX_INCOMING_FILE_BYTES) return;
  const ui = addFileRow('in', m.name, m.size);
  callHead().notice(t('{name} schickt eine Datei:', { name: who || t('Gegenüber') }) + ' ' + m.name);
  incoming.set(key, { id: m.id, name: m.name, size, mime: m.mime, chunks: [], received: 0, ui, who });
}
function onFileChunk(peerId, data) {
  const key = peerId || '__solo__';
  const rec = incoming.get(key); if (!rec) return;
  const buf = data instanceof ArrayBuffer ? data : (data.buffer || data);
  if (rec.received + buf.byteLength > rec.size) { incoming.delete(key); rec.ui.div.remove(); return; } // more than announced
  rec.chunks.push(buf); rec.received += buf.byteLength;
  setFileProgress(rec.ui, rec.size ? rec.received / rec.size : 0);
}
function onFileEnd(peerId) {
  const key = peerId || '__solo__';
  const rec = incoming.get(key); if (!rec) return;
  incoming.delete(key);
  // Always octet-stream, never the type the peer named: this blob: URL lives in the app's own
  // origin, and an HTML or SVG file opened from it (middle click, "open in new tab") would render
  // there with the peer's content (security audit 2026-11-11). The file keeps its name and is
  // downloaded; the operating system opens it by its extension.
  const blob = new Blob(rec.chunks, { type: 'application/octet-stream' });
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

// ---- QES in the call: share a document & go through it together (Community, `qes-in-call`) ----
// P2P document transfer over a dedicated 'qes'
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
// Certificate requests of the device signature provider (Pro, qes-device): the CSR goes over
// the signalling connection, because that is what ties it to the participant the server verified
// in this call. reqId → { resolve, reject, timer }.
const deviceCertPending = new Map();
function requestDeviceCertificate(csrB64) {
  return new Promise((resolve, reject) => {
    const reqId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
    const timer = setTimeout(() => { deviceCertPending.delete(reqId); reject(new Error('certificate request timed out')); }, 20000);
    deviceCertPending.set(reqId, { resolve, reject, timer });
    wsSend({ type: 'device-cert-request', reqId, csr: csrB64 });
  });
}
function settleDeviceCert(msg, ok) {
  const p = deviceCertPending.get(msg.reqId);
  if (!p) return;
  deviceCertPending.delete(msg.reqId);
  clearTimeout(p.timer);
  if (ok && Array.isArray(msg.chain) && msg.chain.length) p.resolve(msg.chain);
  else p.reject(new Error('certificate refused: ' + (msg.message || 'unknown')));
}

function qesCtx() {
  return {
    requestDeviceCertificate,
    // For the phone-signature provider: pair over this connection, then WebRTC with the phone.
    server: { send: wsSend, on: onServer },
    getIceServers: async () => { await refreshIce(); return iceServers; },
    // v1: exactly one peer (the button is hidden otherwise).
    getPeer: () => {
      const [entry] = [...peers.entries()];
      return entry ? { peerId: entry[0], pc: entry[1].pc, name: entry[1].name ? titleCase(entry[1].name) : '' } : null;
    },
    // Own verified PID names (post-reveal) — subject of the DEMO signing certificate,
    // so the identity-binding demo can match cert ↔ PID end-to-end.
    getSelfIdentity: () => {
      const c = (lastStatusMsg && lastStatusMsg.revealed && lastStatusMsg.self.claims) || {};
      return { givenName: c.given_name ? titleCase(c.given_name) : '', familyName: c.family_name ? titleCase(c.family_name) : '' };
    },
    // The PEER's verified PID names — the reference the signer's certificate is
    // matched against ("signer = verified call partner").
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
if (pairToken) startPairedSigner(pairToken);
else if (walletDoneElsewhere) showWalletDone();
else if (inviteToken && !inviteCfg) showInviteProblem('malformed');
else if (roomEndedHere()) { ended = true; showEnded('Dieser Anruf ist beendet.'); }
else connect();

// Website, during a call: closing or reloading the tab by mistake ends it for both sides and costs
// both the wallet check — the browser asks first. Not in the app (no tab to close) or an embed.
window.addEventListener('beforeunload', (e) => {
  if (callStarted && !ended && !isNativeApp() && !isEmbedded) { e.preventDefault(); e.returnValue = ''; }
});
// Warm up the ICE configuration and then check ONCE whether this network can carry a call at all.
// The check gets exactly these iceServers — if it kept its own, it would be testing something
// other than the later call.
refreshIce().then(runNetworkCheck); // refreshed again before each peer connection
refreshCaps(); // align the UI with /capabilities
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

// ---- phone signature: this device signs for a browser participant (Pro, qes-device) ----
// Loaded from the server (the qes-device module's client/paired-signer.js), like every module's browser code; what it
// needs from this bundle is handed over, because a relative import from there would reach the
// server rather than this bundle. Without that module (or offline) the page says so plainly.
function startPairedSigner(token) {
  // The token is a bearer credential for one signing step: out of the address bar, history and
  // any screenshot as soon as it has been read.
  history.replaceState(null, '', location.pathname);
  document.body.classList.add('pair-mode');
  const native = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.DeviceSigner) || null;
  import(new URL(apiUrl('pro-client/paired-signer.js'), location.href).href)
    .then((m) => m.start({
      token, native, apiUrl, wsUrl: wsUrl(), t,
      getIceServers: async () => { await refreshIce(); return iceServers; },
      loadPades: () => import('./qes/pades.js'),
      loadProviders: () => import('./qes/providers.js'),
      loadPdfjs: async () => {
        const lib = await import('./vendor/pdfjs/pdf.min.mjs');
        lib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
        return lib;
      },
    }))
    .catch((e) => {
      console.warn('phone signature unavailable:', e && e.message);
      setStatus('Signieren mit dem Smartphone ist auf diesem Server nicht verfügbar.');
    });
}

/* App start: a page of its own once per launch (index.html #app-intro, style.css "App intro") —
   the logo animation with the sound mark played as quietly as the ring in a call (a −32 dB
   copy, see public/sounds/README.md; −12 dB until 2026-11-14) on a sky whose colours move with the sound, then the app fades in
   underneath. A tap skips it. Not when the app opens on an invitation or comes back from the
   wallet (then the person wants the call, not a greeting), not on branded instances, not with
   "reduce motion"; silent when "Töne" is off. The head script shows the page from the first paint
   on the same conditions (it cannot know the branding, so this takes the page away again). The
   app shell allows sound without a tap (Capacitor turns off the user-gesture requirement on both
   platforms). Once per launch: sessionStorage survives the reloads inside the app ("new call")
   but not a fresh start. */
function playAppIntro() {
  const root = $('app-intro'), html = document.documentElement, q = LAUNCH_QUERY;
  if (!root || !html.classList.contains('ai-on')) return;
  if (OPERATOR_BRANDED || reducedMotion() || q.has('room') || q.has('zurueck') || !window.whositLogoAnimation) {
    html.classList.remove('ai-on');
    return;
  }
  try { sessionStorage.setItem('whosit_intro', '1'); } catch {}
  let done = false, clock = null;
  const finish = () => {
    if (done) return;
    done = true;
    root.classList.add('ai-out');
    html.classList.add('ai-reveal');
    setTimeout(() => { html.classList.remove('ai-on', 'ai-reveal'); root.remove(); }, 1000);
  };
  root.addEventListener('click', () => { if (clock && clock.audio) clock.audio.pause(); finish(); }, { once: true });
  setTimeout(finish, 8000); // whatever happens, the app is never held behind it
  (async () => {
    // Its own copy of the logo, not the call's (loadLogoMoment): one svg cannot be in two places.
    const svg = await whositLogoAnimation.load('logo/logo-horizontal-colour.svg').catch(() => null);
    if (done) return;
    if (!svg) return finish();
    const box = $('app-intro-logo');
    box.appendChild(svg);
    clock = await startIntroSound().catch(() => null);
    if (done) return;
    // Logo visible (ai-run) and animation started (la-play, set inside play()) in the SAME task:
    // until 2026-11-05 a frame passed between the two, and in it the finished logo flashed up
    // before the animation began (Jakob: "am Anfang flackert es kurz").
    root.classList.add('ai-run');
    const logo = whositLogoAnimation.play(box, { clock: typeof clock === 'function' ? clock : null });
    // The sky follows the sound's clock like the logo does.
    await new Promise((r) => requestAnimationFrame(r));
    const sky = root.querySelector('.ai-sky');
    const skyAnims = sky && sky.getAnimations ? sky.getAnimations({ subtree: true }) : [];
    const sync = () => {
      const t = typeof clock === 'function' ? clock() : NaN;
      if (isFinite(t)) skyAnims.forEach((a) => { try { a.currentTime = t * 1000; } catch { /* finished */ } });
    };
    sync();
    setTimeout(sync, 300);
    await logo;
    if (!done) setTimeout(finish, 350); // the logo rests as the file for a moment, then the app
  })();
}
/* The quiet sound mark through a media element, started before the picture: loaded first, then
   played, and its clock handed to the animation only once it really runs (until 2026-10-29 the
   picture started at once and the sound came noticeably later on the phone). */
async function startIntroSound() {
  if (!soundsOn()) return null;
  const a = new Audio('sounds/whosit-klangzeichen-hauch.mp3');
  a.preload = 'auto';
  await new Promise((r) => { a.addEventListener('canplaythrough', r, { once: true }); a.addEventListener('error', r, { once: true }); setTimeout(r, 1500); a.load(); });
  try { await a.play(); } catch { return null; }
  const t0 = performance.now();
  while (a.currentTime === 0 && !a.paused && performance.now() - t0 < 1000) await new Promise((r) => requestAnimationFrame(r));
  const clock = () => a.currentTime;
  clock.audio = a; // for a tap that skips the intro
  return clock;
}

// ---- Dynamic Type (iOS app): the text follows the system text size ----------------------
// WebKit resolves `-apple-system-body` to the size set under Settings → Display → Text Size
// (17px at the default). The root size scales by that ratio, so the default stays at 16px and every
// rem-sized text follows. Capped: from the accessibility sizes on, the call screen would no longer
// fit — the system still enlarges further with its own zoom. Android does the same natively
// (textZoom, see the app's MainActivity).
function applyDynamicType() {
  // A touch screen only: the iPhone app run on a Mac would read the Mac's 13px and shrink.
  if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches)) return;
  const probe = document.createElement('span');
  probe.style.font = '-apple-system-body';
  if (!probe.style.font) return; // not WebKit on Apple
  probe.style.position = 'absolute'; probe.style.visibility = 'hidden';
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  if (!px) return;
  const scale = Math.min(Math.max(px / 17, 0.82), 1.35);
  document.documentElement.style.fontSize = Math.abs(scale - 1) < 0.01 ? '' : `${(16 * scale).toFixed(2)}px`;
  // From "XL" on: the few places that need more room to wrap (style.css, .dt-large).
  document.documentElement.classList.toggle('dt-large', scale > 1.1);
}

// ---- native app shell: bottom tab bar (call / settings) --------------
// Only in the Capacitor app (isNativeApp()); the website keeps its footer pills.
(function initAppShell() {
  if (!isNativeApp()) return;
  document.documentElement.classList.add('native-app'); // safety net for the head script
  // The backdrop behind the status bar (style.css) only once the page has moved: at the top it
  // sat as a solid strip on the page's glow, a visible edge with nothing to cover.
  const onScroll = () => document.documentElement.classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  // The setting is changed in the Settings app, so it is read again whenever the app is back.
  applyDynamicType();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) applyDynamicType(); });
  const tabbar = $('app-tabbar'), settingsBox = $('app-settings');
  if (!tabbar || !settingsBox) return;
  // move the footer meta controls into the settings rows (element move, wiring intact;
  // lang-switch visibility stays owned by i18n.js — it unhides only with >1 locale)
  const move = (id, slotId, show) => { const el = $(id), slot = $(slotId); if (el && slot) { slot.appendChild(el); if (show) el.hidden = false; } };
  move('lang-switch', 'settings-lang-slot', false);
  move('theme-toggle', 'settings-theme-slot', true);
  move('sound-toggle', 'settings-sound-slot', true);
  // The two toggles are bare icon buttons: in a settings list you could not tell what is set. Their
  // state is in the aria-label ("Design: automatisch …", "Töne: an") — shown next to them as well.
  for (const [btnId, slotId] of [['theme-toggle', 'settings-theme-slot'], ['sound-toggle', 'settings-sound-slot']]) {
    const btn = $(btnId), slot = $(slotId);
    if (!btn || !slot) continue;
    const state = document.createElement('span');
    state.className = 'settings-state'; state.setAttribute('aria-hidden', 'true');
    slot.prepend(state);
    const sync = () => { const l = btn.getAttribute('aria-label') || ''; state.textContent = l.includes(':') ? l.slice(l.indexOf(':') + 1).trim() : ''; };
    sync();
    new MutationObserver(sync).observe(btn, { attributes: true, attributeFilter: ['aria-label'] });
  }
  playAppIntro();
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
  // domains, see the native app's entitlements + server EUDI_IOS_APP_ID). Route the room into
  // the local bundle — cold start (launch url) and while running (appUrlOpen).
  const CapApp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (CapApp) {
    const openRoomUrl = (url) => {
      try {
        // A pairing QR code scanned with the camera: sign for the browser that shows it. Arrives as
        // https://…/?pair= (universal link) or whosit://open?pair= (the page's fallback button,
        // when the universal link opened Safari instead) — same parameter either way.
        const pair = new URL(url).searchParams.get('pair');
        if (pair) { if (pair !== pairToken) location.href = `index.html?pair=${encodeURIComponent(pair)}`; return; }
        // Back from the wallet (/zurueck?r=…, see backFromWallet). In this room already: nothing
        // to do — the app is in front again, which is the whole point. Anywhere else, and not in
        // a call: say "done" rather than leave a fresh room on screen. Never join.
        // The app's own offers return as /?room=…&zurueck=1 (see walletReturnUrl) — same handling.
        const u = new URL(url);
        if (u.pathname === '/zurueck' || u.searchParams.get('zurueck') === '1') {
          const r = u.searchParams.get('r') || u.searchParams.get('room');
          if (r && r !== roomId && !callStarted) location.href = `index.html?zurueck=1&r=${encodeURIComponent(r)}`;
          return;
        }
        const target = new URL(url).searchParams.get('room');
        if (target && target !== roomId) location.href = `index.html?room=${encodeURIComponent(target)}`;
      } catch { /* not a room link — ignore */ }
    };
    // getLaunchUrl is not "the link that started the app" but the LAST link the app was opened
    // with, for as long as it runs. Read on every page load, it took "Neuen Raum starten" after a
    // call — a reload — straight back into the old, now full room; only quitting the app helped.
    // So a link counts once: remembered in sessionStorage (kept across reloads, gone with the app).
    const LAUNCH_KEY = 'whosit_link_handled';
    const handled = (url) => { try { return sessionStorage.getItem(LAUNCH_KEY) === url; } catch { return false; } };
    const markHandled = (url) => { try { sessionStorage.setItem(LAUNCH_KEY, url); } catch { /* private mode */ } };
    CapApp.addListener('appUrlOpen', (e) => { if (e && e.url) { markHandled(e.url); openRoomUrl(e.url); } });
    CapApp.getLaunchUrl().then((r) => { if (r && r.url && !handled(r.url)) { markHandled(r.url); openRoomUrl(r.url); } }).catch(() => {});
  }
})();

// ---- in-call trust bar: shield + names, expandable ------------------------
// In the app AND on the website (since 2026-10-28): before, a phone browser stacked status,
// participant chips and verified data above the video, which then started below the fold.
// The bar keeps them one tap away.
// Data is mirrored from the existing UI (the identity chips) via an observer, so there is no
// second source of truth.
(function initTrustBar() {
  const trustBar = $('trust-bar'), trustNames = $('trust-names');
  if (!trustBar || !trustNames) return;
  const refreshTrust = () => {
    const inCall = document.body.classList.contains('in-call');
    trustBar.hidden = !inCall;
    if (!inCall) return;
    // The other side only: who you are is no news to you, and on a phone two names left room
    // for neither. Straight from the status, not read back out of the chip text: cutting
    // "Gastgeber:in: Erika M." at the first colon left every guest with "in: Erika M.".
    const m = lastStatusMsg;
    const clean = ((m && m.peers) || []).filter((p) => p.name).map((p) => titleCase(p.name));
    // Without names, say whether anyone is verified at all — "Verifizierter Anruf" over a call
    // between two anonymous people would claim exactly what the product must never fake.
    const anyVerified = !!(m && (presentedOf(m.self) || (m.peers || []).some(presentedOf)));
    trustBar.classList.toggle('unverified', !anyVerified);
    trustNames.textContent = clean.length ? clean.join(' ↔ ') : t(anyVerified ? 'Verifizierter Anruf' : 'Anruf ohne Ausweisprüfung');
  };
  trustBar.addEventListener('click', () => {
    const open = document.body.classList.toggle('trust-open');
    trustBar.setAttribute('aria-expanded', String(open));
  });
  const obs = new MutationObserver(refreshTrust);
  const idsBox = $('identities');
  if (idsBox) obs.observe(idsBox, { subtree: true, childList: true, characterData: true });
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  refreshTrust();
})();

// ---- setup wizard (mobile/app): 4 steps ------------------------------------
// 1 connection type · 2 I share · 3 guest shares · 4 invite. Presentation only:
// body.wizard + data-wkind drive CSS visibility; app logic's [hidden] flags keep
// authority (a hidden #auth stays hidden on step 4). The mode deactivates itself
// whenever #setup is hidden (guest view, call started) — those flows are linear
// already and must not lose their boxes to wizard CSS.
(function initSetupWizard() {
  const setup = $('setup'), nav = $('wiz-nav'), back = $('wiz-back'), next = $('wiz-next'), dots = $('wiz-dots');
  if (!setup || !nav) return;
  if (isEmbedded) return;

  /**
   * Who gets the guided mode — a preference, not a screen width.
   *
   * A viewport check evaluated once when the module runs would leave a desktop host without any
   * guidance through ~20 controls, make the „invite last" ordering a suggestion instead of a
   * sequence (and `lockSetup()` makes it a one-way door), and never change again — narrowing a
   * window or rotating a phone that started in landscape would do nothing.
   *
   * The CSS never needed a viewport: every rule hangs off `body.wizard[data-wkind]`, and the
   * desktop card highlighting is gated on `body:not(.wizard)`, so the two exclude each other
   * by construction.
   *
   * Guided is the DEFAULT, on every screen. Setting up a call is a rare act even for people who
   * do it often, and the two blocks „Ich teile" / „Der Gast teilt" look alike while meaning
   * opposite things — being led through that costs a practised host three clicks and saves an
   * unpractised one a wrong disclosure. Whoever knows their way around switches it off once.
   *
   * The screen does not take part in the decision at all: with guided as the default there is
   * nothing left for a breakpoint to decide, and a stored choice must not be overridden by a
   * rotation anyway.
   *
   * `localStorage`, not a cookie, and no consent dialogue: what is stored here is the execution
   * of a choice the visitor just made themselves — the same category as `eudi_theme` and
   * `eudi_lang`. Nothing is read that was not written by this
   * switch, and nothing leaves the device.
   */
  const WIZ_KEY = 'eudi_setup_wizard';
  const sw = $('wiz-switch');
  const pref = () => { try { const v = localStorage.getItem(WIZ_KEY); return v === '1' ? true : v === '0' ? false : null; } catch { return null; } };
  const guided = () => pref() !== false;

  // Step kinds: mode · you · guest · invite · (auth, only while the host still has to identify).
  // The link comes BEFORE the identification, and stays within reach after it: the usual way is to
  // prepare a call, send the link by mail or messenger and identify later, when the call begins.
  // (For a few hours on 2026-10-28 identification came first — that hid the link behind the
  // wallet, exactly when it is needed most.) The settings are complete by the invite step, so a
  // guest joining early locks nothing that is still open. Once identified, the auth step drops
  // out and the index lands back on "invite".
  const shareEl = $('share'), authEl = $('auth');
  const swLabel = $('wiz-switch-label');
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
    // In words, not dots: five dots were easy to miscount. What the step is about, its own
    // heading says (the two sides are asked as questions).
    dots.className = 'wiz-dots wiz-step';
    dots.textContent = t('Schritt {n} von {m}', { n: idx + 1, m: st.length });
    back.disabled = idx === 0;
    // From the invite step on the card is the summary of the choices — going back means changing them.
    back.textContent = t(kind === 'invite' ? 'Ändern' : 'Zurück');
    next.hidden = idx === st.length - 1;
    // On the identification step the invite card stays below it, folded to its heading: one tap
    // and the link is there to copy again.
    if (shareEl) shareEl.classList.toggle('wiz-collapsed', kind === 'auth');
  };
  const go = (delta) => { const st = steps(); idx = Math.min(Math.max(idx + delta, 0), st.length - 1); render(); setup.scrollIntoView({ block: 'start', behavior: 'smooth' }); };
  back.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  // Fold the invite card on the identification step open or shut
  if (shareEl) { const h = shareEl.querySelector('h2'); if (h) h.addEventListener('click', () => { if (document.body.dataset.wkind === 'auth') shareEl.classList.toggle('wiz-collapsed'); }); }

  const syncActive = () => {
    const want = guided();
    if (sw) sw.checked = want;
    if (swLabel) swLabel.textContent = t(want ? 'Alles auf einer Seite zeigen' : 'Schritt für Schritt einrichten');
    const on = !setup.hidden && want;
    document.body.classList.toggle('wizard', on);
    if (on) render();
  };
  if (sw) {
    sw.addEventListener('change', () => {
      try { localStorage.setItem(WIZ_KEY, sw.checked ? '1' : '0'); } catch {}
      idx = 0; // switching on mid-way would otherwise resume at a step nobody chose
      syncActive();
    });
  }
  new MutationObserver(syncActive).observe(setup, { attributes: true, attributeFilter: ['hidden'] });
  // Step title and switch label are set through t(): run again once the dictionary is there.
  i18nReady.then(syncActive);
  // The visibility of #auth changes the step count -> re-render on change
  if (authEl) new MutationObserver(() => { if (!setup.hidden) render(); }).observe(authEl, { attributes: true, attributeFilter: ['hidden'] });
  syncActive();
})();
