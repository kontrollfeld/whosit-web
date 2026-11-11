// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/* QES in the call: share a document, page through it together and co-sign it.
 *
 * Runs entirely P2P over a dedicated 'qes' DataChannel (in-band, no renegotiation —
 * app.js routes incoming channels by label). Control messages are JSON envelopes
 * ({ q: '…' }), document bytes travel as binary frames of [4-byte BE chunk index +
 * ≤16 KB payload]. The server never sees the document, its hash, or any metadata.
 *
 * Transfer is manifest-based and resumable: the offer carries total size + SHA-256 +
 * chunk count; the receiver acknowledges with a bitmap of chunks it already has, so
 * after a DataChannel reconnect (app switch, network blip) only missing chunks are
 * re-sent. Both sides verify the SHA-256 locally before anything is displayed —
 * "verified" means both render byte-identical bytes.
 *
 * SIGNING CEREMONY: PAdES with multiple signers means SEQUENTIAL
 * incremental updates — the ceremony starter signs first, the grown PDF travels to
 * the other side (as a normal chunked transfer with docId "<cid>:<step>", auto-
 * accepted — consent was given at ceremony start), that side verifies the hash AND
 * the prefix invariant (an incremental update never rewrites earlier bytes, so
 * signature 1 stays byte-identical), then adds its own signature and sends the final
 * document back. Each participant signs with their OWN SignatureProvider
 * (providers.js; Community = mock/demo, explicitly not legally binding). PAdES
 * mechanics live in pades.js. Per-step timeouts and q:cer-abort keep both sides
 * consistent; the state machine is N-ready but v1 fixes the order to [starter, peer].
 *
 * Lazy-loaded: app.js imports this module (and this module imports the self-hosted
 * pdf.js / PKI.js / pdf-lib+signpdf vendor bundles) only when a share or ceremony
 * actually starts, so the call path stays lean. v1 is 1:1 (exactly one peer).
 */

const CHUNK_SIZE = 16 * 1024;            // proven size for cross-browser DataChannels
const MAX_DOC_BYTES = 20 * 1024 * 1024;  // v1 client limit; operator-configurable later
const BUF_HIGH = 8 * 1024 * 1024;        // pause sending above this bufferedAmount
const BUF_LOW = 1 * 1024 * 1024;         // resume at bufferedamountlow below this
const PROPOSE_TTL = 120_000;             // ceremony consent window
const STEP_TTL = 240_000;                // per signing step (sign + transfer + verify)

const $ = (id) => document.getElementById(id);
// i18n: t() is a global from i18n.js (classic script) — visible to modules.
const tr = (s, v) => (typeof t === 'function' ? t(s, v) : s);

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function hex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function sha256(bytes) { return hex(await crypto.subtle.digest('SHA-256', bytes)); }
/** 64 hex chars → 8 groups of 8, so two people can compare it verbally per group. */
function groupHash(h) { return String(h).replace(/(.{8})(?=.)/g, '$1 '); }

// Chunk bitmap (which chunks the receiver already has): bit i set = chunk i present.
function bitmapEncode(haveArr) {
  const bytes = new Uint8Array(Math.ceil(haveArr.length / 8));
  haveArr.forEach((has, i) => { if (has) bytes[i >> 3] |= 1 << (i & 7); });
  return btoa(String.fromCharCode(...bytes));
}
function bitmapHas(b64, i) {
  if (!b64) return false;
  const byte = atob(b64).charCodeAt(i >> 3);
  return Number.isNaN(byte) ? false : !!(byte & (1 << (i & 7)));
}

/**
 * Factory wired up by app.js. ctx:
 *   getPeer(): { peerId, pc, name } | null  — the single call peer (v1: 1:1)
 *   getSelfIdentity(): { givenName, familyName } — own verified PID names (demo-cert subject)
 *   addChat(who, text)                      — system notes into the chat log
 *   onIdle()                                — ceremony ended → app re-evaluates buttons
 */
export function createDocShare(ctx) {
  // ---- DOM ----
  const box = $('qes-box');
  const statusEl = $('qes-status');
  const closeBtn = $('qes-close');
  const offerBox = $('qes-offer');
  const offerText = $('qes-offer-text');
  const acceptBtn = $('qes-accept');
  const declineBtn = $('qes-decline');
  const progBox = $('qes-progress');
  const progLabel = $('qes-progress-label');
  const progFill = $('qes-progress-fill');
  const progBar = progFill.parentElement;
  const verifyBox = $('qes-verify');
  const hashEl = $('qes-hash');
  const hashStatus = $('qes-hash-status');
  const viewerBox = $('qes-viewer');
  const prevBtn = $('qes-prev');
  const nextBtn = $('qes-next');
  const pageInfo = $('qes-page-info');
  const followCb = $('qes-follow');
  const dlLink = $('qes-download');
  const canvas = $('qes-canvas');
  const signBox = $('qes-sign');
  const providerSel = $('qes-provider');
  const signBtn = $('qes-sign-btn');
  const signList = $('qes-signatures');

  const cerConfirm = $('qes-cer-confirm');
  const cerConfirmText = $('qes-cer-confirm-text');
  const cerAcceptBtn = $('qes-cer-accept');
  const cerDeclineBtn = $('qes-cer-decline');
  const mismatchBox = $('qes-mismatch');
  const mismatchText = $('qes-mismatch-text');
  const mismatchProceedBtn = $('qes-mismatch-proceed');
  const mismatchAbortBtn = $('qes-mismatch-abort');
  const protocolLink = $('qes-protocol');
  const validateBox = $('qes-validate');
  const validateBtn = $('qes-validate-btn');
  const validateList = $('qes-validate-list');
  const validateHint = $('qes-validate-hint');

  // ---- state ----
  let dc = null;          // the 'qes' DataChannel (created here or adopted from app.js)
  let out = null;         // outgoing: { docId, name, size, buf, sha256, chunks, sending, offered }
  let inc = null;         // incoming: { docId, name, size, sha256, chunks[], got, blobUrl }
  let baseDoc = null;     // the mutually verified document: { docId, name, bytes, sha256 }
  let pdfjs = null;       // lazy pdf.js module
  let pdfDoc = null;      // rendered document
  let pageNo = 1;
  let rendering = false;
  let providers = null;   // SignatureProviders from ./providers.js (lazy, once per session)
  let viewerBytes = null; // the bytes currently rendered — input for the validation view
  // Signing ceremony: sequential incremental signatures, starter first.
  // { cid, starter, state: proposed|confirm|signing|peer-signing|done, step,
  //   versions:[Uint8Array…], expected:{step,sha256,subject}, timer }
  let cer = null;

  function setStatus(msg, vars) { statusEl.textContent = msg ? tr(msg, vars) : ''; }
  function note(text) { ctx.addChat('System', '📄 ' + text); }
  function peerName() { const p = ctx.getPeer(); return p && p.name ? p.name : tr('Gegenüber'); }

  // ---- channel plumbing ----
  function wire(channel) {
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (e) => onData(e.data);
    // Reconnect resume: the SENDER drives — re-offer anything unfinished; the receiver
    // answers with its have-bitmap and only the missing chunks travel again. A ceremony
    // proposal that may have been lost mid-reconnect is re-sent the same way.
    channel.onopen = () => {
      if (out && !out.done) sendOffer();
      if (cer && cer.starter && cer.state === 'proposed') sendCeremonyStart();
    };
    channel.onclose = () => {
      if ((out && !out.done) || (inc && !inc.done)) setStatus('Verbindung unterbrochen — Übertragung wird nach dem Neuaufbau fortgesetzt …');
      // Sender drives the resume: try to re-open a channel while a transfer is pending
      // (the receiver only ever answers offers). No-op once the transfer finished.
      if (out && !out.done) setTimeout(() => { if (out && !out.done && (!dc || dc.readyState !== 'open')) ensureChannel().catch(() => {}); }, 2000);
    };
    if (channel.readyState === 'open') channel.onopen();
  }
  /** app.js hands over an incoming channel labelled 'qes'. */
  function adoptChannel(_peerId, channel) {
    if (!dc || dc.readyState !== 'open') dc = channel;
    wire(channel);
  }
  function ensureChannel() {
    if (dc && dc.readyState === 'open') return Promise.resolve(dc);
    const p = ctx.getPeer();
    if (!p) return Promise.reject(new Error('no peer'));
    if (!dc || (dc.readyState !== 'connecting' && dc.readyState !== 'open')) {
      dc = p.pc.createDataChannel('qes'); // in-band, no renegotiation needed
      wire(dc);
    }
    return new Promise((resolve, reject) => {
      const t0 = setTimeout(() => reject(new Error('qes channel timeout')), 15000);
      const check = () => { if (dc.readyState === 'open') { clearTimeout(t0); resolve(dc); } else setTimeout(check, 100); };
      check();
    });
  }
  function send(obj) { if (dc && dc.readyState === 'open') { try { dc.send(JSON.stringify(obj)); } catch {} } }

  /**
   * Nothing in flight: no transfer half-way, no ceremony still running. A FINISHED document
   * session (both see the document, or a completed ceremony) does not block the next share —
   * the new document replaces it on both sides, so whoever RECEIVED a document can share one
   * back without closing the view first.
   */
  function settled() {
    return (!cer || cer.state === 'done') && (!out || out.done) && (!inc || inc.done);
  }

  // ---- outgoing: share a PDF ----
  async function share(file) {
    if (!settled()) { setStatus('Es läuft bereits eine Übertragung oder Signatur — bitte warten oder die Ansicht schließen.'); show(); return; }
    if (out || inc || pdfDoc) teardown(/*silent*/ true); // the peer replaces its view on our offer
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { show(); setStatus('Nur PDF-Dateien werden unterstützt.'); return; }
    if (file.size > MAX_DOC_BYTES) { show(); setStatus('Datei zu groß (max. {mb} MB).', { mb: MAX_DOC_BYTES / 1024 / 1024 }); return; }
    show();
    setStatus('Dokument wird vorbereitet …');
    const buf = new Uint8Array(await file.arrayBuffer());
    const hash = await beginOutgoing(buf, file.name, null);
    showHash(hash, null);
    setStatus('Warte auf Annahme durch {name} …', { name: peerName() });
    try { await ensureChannel(); } catch { setStatus('Kanal konnte nicht aufgebaut werden — bitte erneut versuchen.'); out = null; return; }
    sendOffer();
  }
  /** Set up `out` for a transfer (original share or ceremony version). Returns the hash. */
  async function beginOutgoing(buf, name, docId) {
    const hash = await sha256(buf);
    out = {
      docId: docId || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)),
      name, size: buf.byteLength, buf, sha256: hash,
      chunks: Math.ceil(buf.byteLength / CHUNK_SIZE),
      sending: false, done: false,
    };
    return hash;
  }
  function sendOffer() {
    send({ q: 'doc-offer', docId: out.docId, name: out.name, size: out.size, sha256: out.sha256, chunkSize: CHUNK_SIZE, chunks: out.chunks });
  }

  async function sendChunks(haveB64) {
    if (!out || out.sending || !dc || dc.readyState !== 'open') return;
    out.sending = true;
    progressUI('out', out.name, out.size);
    dc.bufferedAmountLowThreshold = BUF_LOW;
    let sent = 0, planned = 0;
    for (let i = 0; i < out.chunks; i++) if (!bitmapHas(haveB64, i)) planned++;
    setStatus(planned < out.chunks ? 'Übertragung wird fortgesetzt …' : 'Dokument wird übertragen …');
    try {
      for (let i = 0; i < out.chunks; i++) {
        if (bitmapHas(haveB64, i)) continue;
        if (dc.readyState !== 'open') return; // resume via re-offer on next open
        if (dc.bufferedAmount > BUF_HIGH) {
          await new Promise((r) => { dc.addEventListener('bufferedamountlow', r, { once: true }); });
          if (dc.readyState !== 'open') return;
        }
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, out.size);
        const frame = new Uint8Array(4 + (end - start));
        new DataView(frame.buffer).setUint32(0, i);
        frame.set(out.buf.subarray(start, end), 4);
        dc.send(frame.buffer);
        sent++;
        setProgress(sent / (planned || 1));
      }
      setStatus('Übertragen — {name} prüft die Prüfsumme …', { name: peerName() });
    } finally { out.sending = false; }
  }

  // ---- incoming ----
  /** Ceremony-version docIds look like "<cid>:<step>". */
  function versionStep(docId) {
    if (!cer || typeof docId !== 'string' || !docId.startsWith(cer.cid + ':')) return 0;
    const n = Number(docId.slice(cer.cid.length + 1));
    return Number.isInteger(n) && n > 0 ? n : 0;
  }
  function onOffer(m) {
    if (inc && inc.docId === m.docId) {  // re-offer after reconnect → answer idempotently
      if (inc.done) send({ q: 'doc-verified', docId: inc.docId, sha256: inc.sha256 });
      else if (inc.accepted) send({ q: 'doc-accept', docId: inc.docId, have: bitmapEncode(inc.chunks.map((c) => !!c)) });
      return;
    }
    const step = versionStep(m.docId);
    // Busy check: ceremony versions may REPLACE a finished transfer slot; a new document may
    // replace a finished session (see settled()); anything in flight must finish first.
    if (!step && !settled()) { send({ q: 'doc-error', docId: m.docId, reason: 'busy' }); return; }
    if (!step && (out || inc || pdfDoc)) teardown(/*silent*/ true);
    if (step && inc && !inc.done) { send({ q: 'doc-error', docId: m.docId, reason: 'busy' }); return; }
    if (!Number.isFinite(m.size) || m.size <= 0 || m.size > MAX_DOC_BYTES || m.chunkSize !== CHUNK_SIZE
        || !Number.isFinite(m.chunks) || m.chunks !== Math.ceil(m.size / m.chunkSize)) {
      send({ q: 'doc-error', docId: m.docId, reason: 'invalid-offer' }); return;
    }
    inc = {
      docId: m.docId, name: String(m.name || 'dokument.pdf'), size: m.size, sha256: String(m.sha256),
      chunkSize: m.chunkSize, chunks: new Array(m.chunks).fill(null), got: 0, accepted: false, done: false,
      step,
    };
    if (step) {
      // A version flows without asking only inside a ceremony this side agreed to and is now
      // waiting on: the joiner accepted it, the starter started it. Before that, a peer could
      // send a "version" and have this client sign it in its owner's name without anyone
      // clicking (security audit 2026-11-11).
      if (!cer || cer.state !== 'peer-signing') { send({ q: 'doc-error', docId: m.docId, reason: 'not-agreed' }); inc = null; return; }
      // Consent for the ceremony was given at ceremony start — versions flow directly.
      inc.accepted = true;
      progressUI('in', inc.name, inc.size);
      send({ q: 'doc-accept', docId: inc.docId, have: bitmapEncode(inc.chunks.map((c) => !!c)) });
      return;
    }
    show();
    offerText.textContent = tr('{name} möchte dieses Dokument mit dir durchgehen:', { name: peerName() }) + ' ' + inc.name + ' · ' + fmtBytes(inc.size);
    offerBox.hidden = false;
    setStatus('');
  }
  function accept() {
    if (!inc) return;
    inc.accepted = true;
    offerBox.hidden = true;
    progressUI('in', inc.name, inc.size);
    setStatus('Dokument wird übertragen …');
    send({ q: 'doc-accept', docId: inc.docId, have: bitmapEncode(inc.chunks.map((c) => !!c)) });
  }
  function decline() {
    if (!inc) return;
    send({ q: 'doc-decline', docId: inc.docId });
    note(tr('Du hast das Dokument abgelehnt.'));
    inc = null;
    reset();
  }

  async function onChunk(buf) {
    // Nothing is taken before the receiver accepted the offer: no bytes held, nothing parsed or
    // shown, no receipt sent (security audit 2026-11-11).
    if (!inc || inc.done || !inc.accepted) return;
    if (buf.byteLength < 4) return;
    const view = new DataView(buf);
    const i = view.getUint32(0);
    if (i >= inc.chunks.length || inc.chunks[i]) return;
    // Every chunk but the last is exactly chunkSize; the last carries the rest.
    const want = i === inc.chunks.length - 1 ? inc.size - i * inc.chunkSize : inc.chunkSize;
    if (buf.byteLength - 4 !== want) { send({ q: 'doc-error', docId: inc.docId, reason: 'invalid-chunk' }); return; }
    inc.chunks[i] = new Uint8Array(buf, 4);
    inc.got++;
    setProgress(inc.got / inc.chunks.length);
    if (inc.got === inc.chunks.length) await finishIncoming();
  }
  async function finishIncoming() {
    inc.done = true;
    const bytes = new Uint8Array(inc.size);
    let off = 0;
    for (const c of inc.chunks) { bytes.set(c, off); off += c.byteLength; }
    inc.chunks = null; // free the chunk list, keep the assembled bytes
    const hash = await sha256(bytes);
    if (hash !== inc.sha256) {
      send({ q: 'doc-error', docId: inc.docId, reason: 'hash-mismatch' });
      showHash(hash, false);
      setStatus('Prüfsumme stimmt NICHT überein — Übertragung verworfen.');
      note(tr('Prüfsumme stimmt NICHT überein — Übertragung verworfen.'));
      inc = null;
      return;
    }
    inc.bytes = bytes;
    send({ q: 'doc-verified', docId: inc.docId, sha256: hash });
    progBar.classList.add('done'); setProgress(1);
    showHash(hash, true);
    if (inc.step) { await onVersionReceived(inc.step, bytes); return; }
    baseDoc = { docId: inc.docId, name: inc.name, bytes, sha256: hash };
    note(tr('Dokument empfangen und Prüfsumme bestätigt ✓:') + ' ' + inc.name);
    // Receiver keeps a download of the verified bytes (it's their copy of the doc).
    setDownload(bytes, inc.name);
    await openViewer(bytes);
    setStatus('Beide sehen jetzt dasselbe Dokument.');
    showSigning();
  }
  /** (Re-)point the download link at the given bytes. */
  function setDownload(bytes, name) {
    if (dlLink.dataset.url) { try { URL.revokeObjectURL(dlLink.dataset.url); } catch {} }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    dlLink.dataset.url = url;
    dlLink.href = url; dlLink.download = name;
    dlLink.textContent = '↓ ' + tr('herunterladen');
    dlLink.hidden = false;
  }

  // ---- messages ----
  function onData(data) {
    if (typeof data !== 'string') { onChunk(data instanceof ArrayBuffer ? data : data.buffer); return; }
    let m; try { m = JSON.parse(data); } catch { return; }
    switch (m.q) {
      case 'doc-offer': onOffer(m); break;
      case 'doc-accept': if (out && m.docId === out.docId) sendChunks(m.have); break;
      case 'doc-decline':
        if (out && m.docId === out.docId) { note(tr('{name} hat das Dokument abgelehnt.', { name: peerName() })); out = null; reset(); }
        break;
      case 'doc-verified':
        if (out && m.docId === out.docId && m.sha256 === out.sha256) {
          out.done = true;
          progBar.classList.add('done'); setProgress(1);
          if (versionStep(m.docId)) { onVersionDelivered(versionStep(m.docId)); break; }
          showHash(out.sha256, true);
          baseDoc = { docId: out.docId, name: out.name, bytes: out.buf, sha256: out.sha256 };
          note(tr('Prüfsumme beidseitig bestätigt ✓:') + ' ' + out.name);
          openViewer(out.buf).then(() => { setStatus('Beide sehen jetzt dasselbe Dokument.'); showSigning(); });
        }
        break;
      case 'ceremony-start': onCeremonyStart(m); break;
      case 'ceremony-accept':
        if (cer && cer.starter && m.cid === cer.cid && cer.state === 'proposed') mySignStep(1);
        break;
      case 'ceremony-decline':
        if (cer && m.cid === cer.cid) {
          note(tr('{name} hat die Signatur-Zeremonie abgelehnt.', { name: peerName() }));
          endCeremony(/*failed*/ true, 'declined');
        }
        break;
      case 'progress':
        if (cer && m.cid === cer.cid && cer.state !== 'done') {
          setStatus('{name} signiert gerade … (Schritt {n} von 2)', { name: peerName(), n: m.step });
        }
        break;
      case 'signed':
        // Announcement of the peer's completed signing step; the signed PDF follows as
        // a version transfer on the ordered channel. Remember what to expect.
        if (cer && m.cid === cer.cid && cer.state === 'peer-signing') {
          cer.expected = { step: Number(m.step), sha256: String(m.sha256), subject: String(m.subject || '?'), qualified: !!m.qualified };
        }
        break;
      case 'cer-abort':
        if (cer && m.cid === cer.cid) {
          note(tr('Signatur-Zeremonie abgebrochen ({reason}).', { reason: String(m.reason || '?') }));
          endCeremony(true, m.reason);
        }
        break;
      case 'doc-error':
        if (out && m.docId === out.docId) {
          setStatus(m.reason === 'hash-mismatch' ? 'Prüfsumme stimmt NICHT überein — Übertragung verworfen.' : 'Übertragung nicht möglich ({reason}).', { reason: m.reason });
          if (m.reason === 'hash-mismatch') { showHash(out.sha256, false); note(tr('Prüfsumme stimmt NICHT überein — Übertragung verworfen.')); }
          out = null;
        }
        break;
      case 'page':
        if (pdfDoc && followCb.checked && Number.isFinite(m.page)) gotoPage(m.page, /*fromPeer*/ true);
        break;
      case 'abort':
        note(tr('{name} hat die Dokumentansicht beendet.', { name: peerName() }));
        teardown(/*silent*/ true);
        break;
    }
  }

  // ---- UI helpers ----
  function show() { box.hidden = false; closeBtn.hidden = false; box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  function progressUI(dir, name, size) {
    progLabel.textContent = (dir === 'out' ? '↑ ' : '↓ ') + name + ' · ' + fmtBytes(size);
    progBar.classList.remove('done');
    setProgress(0);
    progBox.hidden = false;
  }
  function setProgress(frac) { progFill.style.width = Math.round(Math.min(1, frac) * 100) + '%'; }
  function showHash(h, ok) {
    verifyBox.hidden = false;
    hashEl.textContent = groupHash(h);
    hashEl.classList.toggle('ok', ok === true);
    hashEl.classList.toggle('bad', ok === false);
    hashStatus.textContent = ok === true ? tr('Prüfsumme beidseitig bestätigt ✓ — ihr seht byte-identisch dasselbe Dokument.')
      : ok === false ? tr('Achtung: Die Prüfsummen unterscheiden sich!')
      : tr('Wird nach der Übertragung auf beiden Seiten verglichen.');
  }

  // ---- signing (providers + demo signature) ----
  // Every UI surface a demo signature touches carries the permanent "not legally
  // binding" banner: `qualified:false` comes from the provider, never from config.
  async function showSigning() {
    try {
      if (!providers) {
        const mod = await import(new URL('./providers.js', import.meta.url).href);
        providers = await mod.loadSignatureProviders(ctx.getSelfIdentity, ctx);
      }
    } catch (e) { console.warn('signature providers unavailable:', e && e.message); return; }
    if (!providers.length) return; // no providers configured → no signing UI
    providerSel.innerHTML = '';
    for (const p of providers) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label + (p.qualified ? '' : ' — ' + tr('Demo'));
      providerSel.appendChild(opt);
    }
    providerSel.hidden = providers.length < 2;
    updateSignUi();
    signBox.hidden = false;
  }
  function selectedProvider() {
    return providers.find((p) => p.id === providerSel.value) || providers[0];
  }
  // A provider may explain what it needs (e.g. the phone signature: where to get the app). Its
  // own module renders that — this file only offers the place, under the provider choice.
  let providerHint = null;
  function updateSignUi() {
    const p = selectedProvider();
    if (!providerHint) {
      providerHint = document.createElement('div');
      providerHint.style.cssText = 'margin:8px 0;';
      // Below the row holding the choice and the sign button, not inside it: in that flex row it
      // would squeeze the choice to nothing.
      (providerSel.closest('.row') || providerSel).insertAdjacentElement('afterend', providerHint);
    }
    providerHint.innerHTML = '';
    if (p && typeof p.renderHint === 'function') { try { p.renderHint(providerHint); } catch { /* a hint must not break signing */ } }
    providerHint.hidden = !providerHint.firstChild;
    // The banner is permanent and non-dismissable while a non-qualified provider is
    // selected, so the "not legally binding yet" notice cannot be missed.
    $('qes-demo-banner').hidden = !!(p && p.qualified);
  }
  function addSignatureRow(who, subject) {
    const row = document.createElement('div');
    row.className = 'qes-sig-row';
    const label = document.createElement('span');
    label.textContent = '✍️ ' + who + ': ' + subject;
    const badge = document.createElement('span');
    badge.className = 'qes-sig-demo';
    badge.textContent = tr('Demo — nicht rechtsgültig');
    row.append(label, badge);
    signList.appendChild(row);
    return row;
  }
  /** Attach the identity-binding verdict to a signature row. */
  function setRowBinding(row, binding) {
    const el = document.createElement('span');
    el.className = 'qes-bind qes-bind-' + binding.status;
    el.textContent = binding.status === 'match' ? '✓ ' + tr('stimmt mit Ausweis überein')
      : binding.status === 'mismatch' ? '⚠ ' + tr('weicht vom Ausweis ab')
      : binding.status === 'invalid' ? '⚠ ' + tr('Signatur nicht prüfbar')
      : '○ ' + tr('kein Ausweis-Abgleich möglich');
    if (binding.status === 'mismatch') el.title = tr('Zertifikat: {cert} — Ausweis: {pid}', { cert: binding.certName || '?', pid: binding.pidName || '—' });
    row.insertBefore(el, row.lastChild);
  }
  providerSel.addEventListener('change', updateSignUi);

  // ---- signing ceremony ----
  // Sequential incremental updates: starter signs step 1, the other side step 2.
  // Every state has a timeout; q:cer-abort ends the ceremony on both sides but keeps
  // the shared document view intact.
  function myName() {
    const id = ctx.getSelfIdentity();
    return [id.givenName, id.familyName].filter(Boolean).join(' ');
  }
  // Client-only ceremony protocol: every step, hash, binding verdict and
  // mismatch decision — exportable as JSON, never sent to the server.
  function logEvent(type, data) {
    if (cer && cer.protocol) cer.protocol.events.push(Object.assign({ type, at: new Date().toISOString() }, data || {}));
  }
  function newProtocol(cid) {
    return { ceremonyId: cid, document: { name: baseDoc.name, sha256: baseDoc.sha256 }, note: 'Demo-Signaturen — nicht rechtsgültig / demo signatures — not legally binding', events: [] };
  }
  /** Analyze the newest signature of `bytes` and match it against the signer's PID names. */
  async function bindingFor(bytes, pid) {
    const identity = await import(new URL('./identity.js', import.meta.url).href);
    const info = await identity.analyzeNewestSignature(bytes);
    if (!info) return { status: 'invalid', certName: '', pidName: '', verified: false };
    const m = identity.matchIdentity(info.subject, pid);
    // A cryptographically broken CMS is its own failure class — never a green match.
    return { status: info.verified ? m.status : 'invalid', certName: m.certName, pidName: m.pidName, verified: info.verified };
  }
  function armTimer(ms, reason) {
    clearTimer();
    if (cer) cer.timer = setTimeout(() => abortCeremony(reason), ms);
  }
  function clearTimer() { if (cer && cer.timer) { clearTimeout(cer.timer); cer.timer = null; } }
  function currentBytes() { return cer && cer.versions.length ? cer.versions[cer.versions.length - 1] : baseDoc && baseDoc.bytes; }

  function startCeremony() {
    if (!baseDoc || cer) return;
    cer = { cid: baseDoc.docId + '~cer', starter: true, state: 'proposed', step: 0, versions: [], expected: null, timer: null, protocol: null };
    cer.protocol = newProtocol(cer.cid);
    logEvent('ceremony-start', { role: 'starter', order: ['self', 'peer'] });
    signBtn.disabled = true;
    setStatus('Warte auf Zustimmung von {name} zur Signatur-Zeremonie …', { name: peerName() });
    sendCeremonyStart();
    armTimer(PROPOSE_TTL, 'timeout');
  }
  function sendCeremonyStart() {
    send({ q: 'ceremony-start', cid: cer.cid, docId: baseDoc.docId, providerId: (selectedProvider() || {}).id, level: 'B-B', signers: 2 });
  }
  function onCeremonyStart(m) {
    if (!baseDoc || m.docId !== baseDoc.docId) return;
    if (cer && cer.cid === m.cid) return; // duplicate after reconnect
    if (cer) { send({ q: 'cer-abort', cid: m.cid, reason: 'busy' }); return; }
    cer = { cid: String(m.cid), starter: false, state: 'confirm', step: 0, versions: [], expected: null, timer: null, protocol: null };
    cer.protocol = newProtocol(cer.cid);
    logEvent('ceremony-start', { role: 'joiner', order: ['peer', 'self'] });
    signBtn.disabled = true;
    cerConfirmText.textContent = tr('{name} möchte dieses Dokument mit dir gemeinsam signieren. Reihenfolge: erst {name}, dann du. Beide signieren mit einer Demo-Signatur — nicht rechtsgültig.', { name: peerName() });
    cerConfirm.hidden = false;
    setStatus('');
    armTimer(PROPOSE_TTL, 'timeout');
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function acceptCeremony() {
    if (!cer || cer.state !== 'confirm') return;
    cerConfirm.hidden = true;
    cer.state = 'peer-signing';
    logEvent('ceremony-accepted');
    send({ q: 'ceremony-accept', cid: cer.cid });
    setStatus('{name} signiert gerade … (Schritt 1 von 2)', { name: peerName() });
    armTimer(STEP_TTL, 'timeout');
  }
  function declineCeremony() {
    if (!cer) return;
    send({ q: 'ceremony-decline', cid: cer.cid });
    note(tr('Du hast die Signatur-Zeremonie abgelehnt.'));
    endCeremony(true, 'declined');
  }

  /** Perform MY signing step (1 = starter, 2 = second signer) and ship the result. */
  async function mySignStep(step) {
    if (!cer) return;
    cer.state = 'signing';
    clearTimer();
    setStatus('Du signierst … (Schritt {n} von 2)', { n: step });
    send({ q: 'progress', cid: cer.cid, step });
    try {
      const provider = selectedProvider();
      await provider.authorize({});
      const pades = await import(new URL('./pades.js', import.meta.url).href);
      const src = currentBytes();
      const opts = { provider, signerName: myName(), reason: 'whosit', firstSignature: step === 1, name: baseDoc && baseDoc.name };
      // A provider that signs on another device (paired phone) takes the WHOLE document: the
      // phone shows it, adds the signature itself and returns the grown PDF — so it signs what
      // it displayed, not a hash it has to take on trust. Otherwise PAdES runs here.
      const { bytes, subject } = provider.signDocument
        ? await provider.signDocument(src, opts)
        : await pades.addSignature(src, opts);
      // Whatever signed it, the result must be an incremental update of what we sent.
      if (!pades.isPrefixOf(src, bytes)) throw new Error('signed document does not extend the original');
      if (!cer) return; // aborted while signing
      cer.versions.push(bytes);
      cer.step = step;
      const hash = await sha256(bytes);
      send({ q: 'signed', cid: cer.cid, step, subject, sha256: hash, qualified: !!provider.qualified });
      const row = addSignatureRow(tr('Du'), subject);
      // Self-check of the own step — same analysis the peer runs on their side.
      const binding = await bindingFor(bytes, ctx.getSelfIdentity());
      setRowBinding(row, binding);
      logEvent('signed', { by: 'self', step, subject, sha256: hash, qualified: !!provider.qualified, cmsVerified: binding.verified, binding: binding.status });
      note(tr('Du hast signiert als „{subject}" — Demo, nicht rechtsgültig.', { subject }));
      await openViewer(bytes);
      showHash(hash, true);
      // Ship the grown PDF as a version transfer; the peer's doc-verified drives the
      // next transition (onVersionDelivered).
      await beginOutgoing(bytes, versionName(), cer.cid + ':' + step);
      setStatus('Signiert ✓ — Dokument wird an {name} übertragen …', { name: peerName() });
      sendOffer();
      armTimer(STEP_TTL, 'timeout');
    } catch (e) {
      console.warn('signing step failed:', e && e.message);
      abortCeremony('sign-failed');
    }
  }
  function versionName() {
    return (baseDoc.name || 'dokument.pdf').replace(/\.pdf$/i, '') + '-signiert.pdf';
  }

  /** The peer confirmed receipt (hash ok) of MY signed version. */
  function onVersionDelivered(step) {
    if (!cer) return;
    if (cer.starter && step === 1) {
      cer.state = 'peer-signing';
      setStatus('{name} signiert gerade … (Schritt 2 von 2)', { name: peerName() });
      armTimer(STEP_TTL, 'timeout');
    } else {
      finishCeremony(); // my step 2 arrived — ceremony complete on both sides
    }
  }

  /** A signed version from the peer finished transferring (hash already verified). */
  async function onVersionReceived(step, bytes) {
    if (!cer) return;
    if (cer.state !== 'peer-signing') { abortCeremony('unexpected-version'); return; }
    const exp = cer.expected;
    if (!exp || exp.step !== step || exp.sha256 !== inc.sha256) { abortCeremony('unexpected-version'); return; }
    // Incremental-update invariant: everything already signed must remain byte-
    // identical. Signature 1 may legitimately rewrite the ORIGINAL (placeholder
    // fallback normalizes exotic PDFs), so the check starts at version 2.
    const prev = cer.versions.length ? cer.versions[cer.versions.length - 1] : null;
    if (prev) {
      const pades = await import(new URL('./pades.js', import.meta.url).href);
      if (!pades.isPrefixOf(prev, bytes)) {
        note(tr('Warnung: Die empfangene Version verändert bereits signierte Bytes — Zeremonie abgebrochen.'));
        abortCeremony('prefix-violation');
        return;
      }
    }
    cer.versions.push(bytes);
    cer.expected = null;
    // Identity binding: the signer's certificate is read out of the RECEIVED
    // DOCUMENT (not out of any message) and matched against the PID this person
    // presented in the call. The row subject shows what the certificate says.
    const peer = ctx.getPeer();
    const binding = await bindingFor(bytes, peer ? ctx.getPeerIdentity(peer.peerId) : {});
    const row = addSignatureRow(peerName(), binding.certName || exp.subject);
    setRowBinding(row, binding);
    if (peer) ctx.onBinding(peer.peerId, binding);
    logEvent('signed', { by: 'peer', step, subject: binding.certName || exp.subject, sha256: inc.sha256, qualified: !!exp.qualified, cmsVerified: binding.verified, binding: binding.status });
    note(tr('{name} hat signiert als „{subject}" — Demo, nicht rechtsgültig.', { name: peerName(), subject: binding.certName || exp.subject }));
    if (binding.status === 'match') note(tr('Identitätsbindung ✓ — die Signatur stimmt mit dem verifizierten Gesprächspartner überein.'));
    await openViewer(bytes);

    const proceed = () => (!cer ? undefined : (!cer.starter && step === 1) ? mySignStep(2) : finishCeremony());
    if (binding.status === 'mismatch' || binding.status === 'invalid') {
      // Warn with both names and let the USER decide — continue or abort. The
      // decision lands in the ceremony protocol either way.
      showMismatch(binding, proceed);
      return;
    }
    await proceed();
  }

  /** ⚠ interstitial: certificate ≠ PID (or unverifiable CMS). User decides. */
  function showMismatch(binding, proceed) {
    clearTimer(); // the human decision must not race the step timeout
    mismatchText.textContent = binding.status === 'invalid'
      ? tr('Die Signatur konnte kryptographisch nicht geprüft werden.')
      : tr('Der Name im Signatur-Zertifikat („{cert}") stimmt NICHT mit den im Call verifizierten Ausweisdaten („{pid}") überein.', { cert: binding.certName || '?', pid: binding.pidName || '—' });
    mismatchBox.hidden = false;
    setStatus('');
    mismatchProceedBtn.onclick = () => {
      mismatchBox.hidden = true;
      logEvent('mismatch-decision', { decision: 'proceed' });
      note(tr('Trotz abweichender Identität fortgesetzt (im Protokoll vermerkt).'));
      armTimer(STEP_TTL, 'timeout');
      proceed();
    };
    mismatchAbortBtn.onclick = () => {
      mismatchBox.hidden = true;
      logEvent('mismatch-decision', { decision: 'abort' });
      abortCeremony('identity-mismatch');
    };
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function finishCeremony() {
    if (!cer || cer.state === 'done') return;
    cer.state = 'done';
    clearTimer();
    const finalBytes = currentBytes();
    setDownload(finalBytes, versionName());
    setStatus('Beide haben signiert ✓ — Demo-Signaturen, nicht rechtsgültig.');
    signBtn.querySelector('span').textContent = tr('Signiert ✓ (Demo)');
    signBtn.disabled = true;
    logEvent('ceremony-done');
    offerProtocol();
    note(tr('Signatur-Zeremonie abgeschlossen ✓ — das signierte PDF steht beidseitig zum Download bereit (Demo, nicht rechtsgültig).'));
  }
  /** Client-only protocol download — steps, hashes, binding verdicts, decisions. */
  function offerProtocol() {
    if (!cer || !cer.protocol) return;
    if (protocolLink.dataset.url) { try { URL.revokeObjectURL(protocolLink.dataset.url); } catch {} }
    const url = URL.createObjectURL(new Blob([JSON.stringify(cer.protocol, null, 2)], { type: 'application/json' }));
    protocolLink.dataset.url = url;
    protocolLink.href = url;
    protocolLink.download = 'signatur-protokoll.json';
    protocolLink.textContent = '↓ ' + tr('Zeremonie-Protokoll (JSON)');
    protocolLink.hidden = false;
  }

  function abortCeremony(reason) {
    if (!cer) return;
    send({ q: 'cer-abort', cid: cer.cid, reason });
    note(tr('Signatur-Zeremonie abgebrochen ({reason}).', { reason: tr(reason === 'timeout' ? 'Zeitüberschreitung' : reason) }));
    endCeremony(true, reason);
  }
  /** Clear ceremony state; keep the shared document view usable. */
  function endCeremony(failed, reason) {
    if (failed && cer) { logEvent('ceremony-aborted', { reason: reason || '?' }); offerProtocol(); }
    clearTimer();
    cerConfirm.hidden = true;
    mismatchBox.hidden = true;
    cer = null;
    if (failed) {
      signBtn.disabled = false;
      setStatus('Beide sehen dasselbe Dokument.');
    }
  }

  signBtn.addEventListener('click', startCeremony);
  cerAcceptBtn.addEventListener('click', acceptCeremony);
  cerDeclineBtn.addEventListener('click', declineCeremony);

  // ---- viewer (pdf.js, lazy) ----
  async function loadPdfjs() {
    if (!pdfjs) {
      pdfjs = await import(new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url).href);
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    }
    return pdfjs;
  }
  async function openViewer(bytes) {
    try {
      const lib = await loadPdfjs();
      // pdf.js transfers the buffer to its worker (detaches it) — hand over a copy.
      pdfDoc = await lib.getDocument({ data: bytes.slice() }).promise;
      pageNo = 1;
      viewerBox.hidden = false;
      viewerBytes = bytes;
      await renderPage();
      updateValidateUi();
    } catch (e) {
      console.warn('pdf render failed:', e && e.message);
      setStatus('PDF konnte nicht angezeigt werden.');
    }
  }

  // ---- validation view: every signature in the current document ----
  async function updateValidateUi() {
    validateList.innerHTML = '';
    validateHint.hidden = true;
    try {
      const identity = await import(new URL('./identity.js', import.meta.url).href);
      const n = identity.extractSignatureRanges(viewerBytes).length;
      validateBox.hidden = n === 0;
      if (n) validateBtn.querySelector('span').textContent = tr('Signaturen prüfen ({n})', { n });
    } catch { validateBox.hidden = true; }
  }
  async function runValidation() {
    if (!viewerBytes) return;
    validateBtn.disabled = true;
    try {
      const verify = await import(new URL('./verify.js', import.meta.url).href);
      const peer = ctx.getPeer();
      const identities = [
        { label: tr('Du'), pid: ctx.getSelfIdentity() },
        { label: peerName(), pid: peer ? ctx.getPeerIdentity(peer.peerId) : {} },
      ];
      const results = await verify.analyzeAllSignatures(viewerBytes, identities);
      renderValidation(results, viewerBytes.byteLength);
      validateHint.hidden = false;
    } catch (e) {
      console.warn('validation failed:', e && e.message);
      setStatus('Prüfung fehlgeschlagen.');
    } finally { validateBtn.disabled = false; }
  }
  function fmtDateTime(d) {
    try { return new Date(d).toLocaleString(typeof i18nLocale === 'string' ? i18nLocale : 'de', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch { return String(d); }
  }
  function renderValidation(results, total) {
    validateList.innerHTML = '';
    for (const r of results) {
      const card = document.createElement('div');
      card.className = 'qes-val-card';
      const head = document.createElement('div');
      head.className = 'qes-val-head';
      const title = document.createElement('strong');
      title.textContent = tr('Signatur {n}', { n: r.index }) + (r.details ? ': ' + (r.details.subject.cn || '?') : '');
      const cms = document.createElement('span');
      cms.className = 'qes-bind ' + (r.verified ? 'qes-bind-match' : 'qes-bind-mismatch');
      cms.textContent = r.verified ? '✓ ' + tr('kryptographisch gültig') : '✗ ' + tr('ungültig');
      head.append(title, cms);
      if (r.binding.status === 'match') {
        const b = document.createElement('span');
        b.className = 'qes-bind qes-bind-match';
        b.textContent = '✓ ' + tr('Ausweis: {name}', { name: r.binding.label });
        head.appendChild(b);
      } else if (r.binding.status === 'none') {
        const b = document.createElement('span');
        b.className = 'qes-bind qes-bind-mismatch';
        b.textContent = '⚠ ' + tr('stimmt mit keinem verifizierten Teilnehmer überein');
        head.appendChild(b);
      } else {
        const b = document.createElement('span');
        b.className = 'qes-bind qes-bind-unknown';
        b.textContent = '○ ' + tr('kein Ausweis-Abgleich möglich');
        head.appendChild(b);
      }
      card.appendChild(head);
      const lines = [];
      if (r.details) {
        lines.push(tr('Zertifikat:') + ' ' + (r.details.selfSigned ? tr('selbstsigniert — Demo, keine Vertrauenskette') : r.details.issuer || '?') + ' · ' + tr('Seriennr.') + ' ' + r.details.serial.slice(0, 16));
        lines.push(tr('Gültig:') + ' ' + fmtDateTime(r.details.notBefore) + ' – ' + fmtDateTime(r.details.notAfter));
      }
      if (r.signingTime) lines.push(tr('Signiert am:') + ' ' + fmtDateTime(r.signingTime));
      lines.push(tr('Abdeckung:') + ' ' + (r.coverage.wholeFile
        ? tr('gesamtes Dokument ({kb} KB)', { kb: Math.round(total / 1024) })
        : tr('Bytes 0–{to} (frühere Version; durch spätere Signaturen unverändert eingeschlossen)', { to: r.coverage.to }))
        + (r.coverage.complete ? '' : ' ⚠ ' + tr('unvollständig')));
      for (const text of lines) {
        const p = document.createElement('div');
        p.className = 'qes-val-line';
        p.textContent = text;
        card.appendChild(p);
      }
      validateList.appendChild(card);
    }
  }
  validateBtn.addEventListener('click', runValidation);
  async function renderPage() {
    if (!pdfDoc || rendering) return; // a finishing render re-runs if pageNo moved on
    rendering = true;
    const target = pageNo;
    try {
      const page = await pdfDoc.getPage(target);
      const wrap = canvas.parentElement;
      const cssWidth = Math.max(280, wrap.clientWidth - 2);
      const base = page.getViewport({ scale: 1 });
      const scale = cssWidth / base.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * dpr });
      canvas.width = viewport.width; canvas.height = viewport.height;
      // Pin BOTH CSS dimensions to the true aspect ratio — with only the width set, a
      // flex/height constraint on the wrapper could squash the rendered page.
      canvas.style.width = cssWidth + 'px';
      canvas.style.height = Math.round(viewport.height / dpr) + 'px';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      pageInfo.textContent = tr('Seite {n} von {m}', { n: target, m: pdfDoc.numPages });
      prevBtn.disabled = target <= 1;
      nextBtn.disabled = target >= pdfDoc.numPages;
    } finally {
      rendering = false;
      if (pdfDoc && pageNo !== target) renderPage(); // page flipped while rendering
    }
  }
  function gotoPage(n, fromPeer) {
    if (!pdfDoc) return;
    const target = Math.min(Math.max(1, n), pdfDoc.numPages);
    if (target === pageNo) return;
    pageNo = target;
    renderPage();
    // Follow-me: broadcast my page turns (unless this turn itself came from the peer).
    if (!fromPeer && followCb.checked) send({ q: 'page', docId: (out || inc || {}).docId, page: pageNo });
  }

  // ---- reset / teardown ----
  function reset() {
    offerBox.hidden = true; progBox.hidden = true; verifyBox.hidden = true; viewerBox.hidden = true;
    dlLink.hidden = true; protocolLink.hidden = true;
    validateBox.hidden = true; validateList.innerHTML = ''; validateHint.hidden = true; viewerBytes = null;
    signBox.hidden = true; signList.innerHTML = ''; cerConfirm.hidden = true; mismatchBox.hidden = true;
    signBtn.disabled = false; signBtn.querySelector('span').textContent = tr('Gemeinsam signieren (Demo)');
    setStatus('');
    if (!out && !inc) { box.hidden = true; ctx.onIdle(); }
  }
  /** End the whole document session (local click or peer abort). Keeps the channel. */
  function teardown(silent) {
    if (!silent && (out || inc || pdfDoc)) send({ q: 'abort', docId: (out || inc || {}).docId, reason: 'closed' });
    if (cer) { clearTimer(); cer = null; }
    if (dlLink.dataset.url) { try { URL.revokeObjectURL(dlLink.dataset.url); } catch {} delete dlLink.dataset.url; }
    if (protocolLink.dataset.url) { try { URL.revokeObjectURL(protocolLink.dataset.url); } catch {} delete protocolLink.dataset.url; }
    if (pdfDoc) { try { pdfDoc.destroy(); } catch {} pdfDoc = null; }
    out = null; inc = null; baseDoc = null;
    reset();
  }
  /** The peer left the call entirely (from app.js). */
  function peerGone() { dc = null; if (out || inc || pdfDoc) { note(tr('Dokumentansicht beendet.')); teardown(/*silent*/ true); } }

  // ---- static listeners ----
  acceptBtn.addEventListener('click', accept);
  declineBtn.addEventListener('click', decline);
  closeBtn.addEventListener('click', () => teardown(false));
  prevBtn.addEventListener('click', () => gotoPage(pageNo - 1));
  nextBtn.addEventListener('click', () => gotoPage(pageNo + 1));
  let resizeT = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (pdfDoc && !viewerBox.hidden) renderPage(); }, 150); });

  return { share, adoptChannel, peerGone, teardown, busy: () => !!(out || inc) };
}
