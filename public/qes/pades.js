// SPDX-FileCopyrightText: 2026 Kontrollfeld GmbH
// SPDX-License-Identifier: AGPL-3.0-or-later
/* PAdES handling for the in-call signing ceremony (public/qes/ §3/§4).
 *
 * Adds one signature to a PDF as an INCREMENTAL UPDATE: a signature placeholder
 * (/Type /Sig, SubFilter ETSI.CAdES.detached, /ByteRange + /Contents gap) is appended,
 * the ByteRange payload is handed to the SignatureProvider, and the returned CMS
 * container is embedded into the gap. Because every signature is an append-only
 * update, all EARLIER signatures stay byte-identical — `isPrefixOf` makes that
 * property checkable by the receiving side.
 *
 * Placeholder strategy: `plainAddPlaceholder` (pure byte-level, true incremental
 * update) is always tried first. Some PDFs (exotic xref forms) defeat its parser —
 * for the FIRST signature we may then fall back to a pdf-lib rewrite
 * (`pdflibAddPlaceholder`), which re-serializes the document conventionally. That is
 * only legal while NO signature exists yet; for later signers a plain failure aborts
 * the ceremony instead (a rewrite would break the existing signatures).
 *
 * Everything is lazy: the ~550 KB vendor bundle loads on first ceremony start.
 */

let mod = null;
async function loadBundle() {
  if (!mod) mod = await import(new URL('../vendor/signpdf/signpdf.bundle.mjs', import.meta.url).href);
  return mod;
}

const PLACEHOLDER_BYTES = 16384; // hex /Contents capacity — roomy for CMS + future timestamp

/**
 * Add ONE signature to `bytes`.
 * provider.sign(data) receives the ByteRange payload and must resolve to
 * { cms: ArrayBuffer|Uint8Array, subject: string }.
 * Returns { bytes: Uint8Array, subject } of the newly signed document.
 */
export async function addSignature(bytes, { provider, signerName, reason, firstSignature }) {
  const { plainAddPlaceholder, pdflibAddPlaceholder, PDFDocument, SignPdf, Signer, Buffer } = await loadBundle();

  const input = Buffer.from(bytes);
  let withPlaceholder;
  try {
    withPlaceholder = plainAddPlaceholder({
      pdfBuffer: input,
      reason: reason || 'EUDI Verified Call',
      name: signerName || '',
      signatureLength: PLACEHOLDER_BYTES,
      subFilter: 'ETSI.CAdES.detached',
    });
  } catch (e) {
    if (!firstSignature) {
      // A rewrite would invalidate the existing signatures — hard stop.
      throw new Error('incremental placeholder failed on signed document: ' + (e && e.message));
    }
    // First signature on a PDF the plain parser can't handle: normalize via pdf-lib.
    // useObjectStreams:false serializes a classic xref table, which also makes the
    // SECOND signer's plainAddPlaceholder reliable.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    pdflibAddPlaceholder({
      pdfDoc: doc,
      reason: reason || 'EUDI Verified Call',
      name: signerName || '',
      signatureLength: PLACEHOLDER_BYTES,
      subFilter: 'ETSI.CAdES.detached',
    });
    withPlaceholder = Buffer.from(await doc.save({ useObjectStreams: false }));
  }

  let subject = signerName || '';
  class ProviderSigner extends Signer {
    async sign(byteRangePayload) {
      const result = await provider.sign(byteRangePayload);
      subject = result.subject || subject;
      return Buffer.from(result.cms);
    }
  }
  const signed = await new SignPdf().sign(withPlaceholder, new ProviderSigner());
  return { bytes: new Uint8Array(signed), subject };
}

function toU8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

/**
 * True when `next` is `prev` plus appended data — the incremental-update invariant
 * that guarantees earlier signatures were not touched. Compared in raw bytes.
 */
export function isPrefixOf(prev, next) {
  if (!prev || !next) return false;
  const a = toU8(prev), b = toU8(next);
  if (b.byteLength <= a.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Number of embedded signature dictionaries (quick display heuristic, not validation). */
export function countSignatures(bytes) {
  // latin1 decode is byte-faithful; /Type /Sig may have flexible whitespace.
  const u = toU8(bytes);
  let s = '';
  for (let i = 0; i < u.byteLength; i += 65536) s += String.fromCharCode(...u.subarray(i, Math.min(i + 65536, u.byteLength)));
  return (s.match(/\/Type\s*\/Sig\b/g) || []).length;
}
