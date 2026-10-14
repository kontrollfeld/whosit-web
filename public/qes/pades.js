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
 * Placeholder strategy: `plainAddPlaceholder` (pure byte-level, true incremental update) for
 * EVERY signature. A PDF its parser cannot read (an xref stream, as Word and LibreOffice write)
 * is rewritten once by pdf-lib into a classic xref table first — only while NO signature exists
 * yet; for later signers a failure aborts the ceremony instead (a rewrite would break the
 * existing signatures).
 *
 * Everything is lazy: the ~550 KB vendor bundle loads on first ceremony start.
 */

let mod = null;
async function loadBundle() {
  if (!mod) {
    mod = await import(new URL('../vendor/signpdf/signpdf.bundle.mjs', import.meta.url).href);
    fixLastIndexOf(mod.Buffer);
  }
  return mod;
}

/**
 * The Buffer shim in the bundle (feross/buffer) gets `lastIndexOf(value, 'utf8')` wrong.
 *
 * Node reads a string second argument as the ENCODING and searches from the end. The shim takes
 * it as the start offset 0 and searches backwards from there — so it never finds anything that
 * is not at position 0. @signpdf's findObject uses exactly that call to strip the closing `>>`
 * of the catalog and page dictionaries it rewrites; with the shim it stripped one character
 * instead, and every signed PDF carried a catalog that closes BEFORE `/AcroForm` and a page that
 * closes before `/Annots`. Lenient readers did not mind. PDFBox (Stirling PDF), Acrobat's
 * signature panel and EU DSS look up signatures through the AcroForm, and found none.
 * Until 2026-10-01, every PDF signed here had this defect.
 *
 * Patched on the bundle's own Buffer rather than rebuilt, because the bundle is vendored as a
 * whole; scripts/test-qes.mjs parses the result with pdf-lib to keep it fixed.
 */
function fixLastIndexOf(B) {
  if (!B || B.prototype.__lastIndexOfFixed) return;
  const orig = B.prototype.lastIndexOf;
  B.prototype.lastIndexOf = function (value, byteOffset, encoding) {
    if (typeof byteOffset === 'string') return orig.call(this, value, undefined, byteOffset);
    return orig.call(this, value, byteOffset, encoding);
  };
  B.prototype.__lastIndexOfFixed = true;
}

const PLACEHOLDER_BYTES = 16384; // hex /Contents capacity — roomy for CMS + future timestamp

/**
 * Add ONE signature to `bytes`.
 * provider.sign(data) receives the ByteRange payload and must resolve to
 * { cms: ArrayBuffer|Uint8Array, subject: string }.
 * Returns { bytes: Uint8Array, subject } of the newly signed document.
 */
export async function addSignature(bytes, { provider, signerName, reason, firstSignature }) {
  const { plainAddPlaceholder, PDFDocument, SignPdf, Signer, Buffer } = await loadBundle();

  const placeholder = (pdfBuffer) => plainAddPlaceholder({
    pdfBuffer,
    reason: reason || 'whosit',
    name: signerName || '',
    // Written whatever we pass: left out, every signature carried the literal "(undefined)".
    contactInfo: '',
    location: '',
    signatureLength: PLACEHOLDER_BYTES,
    subFilter: 'ETSI.CAdES.detached',
  });

  let withPlaceholder;
  try {
    withPlaceholder = placeholder(Buffer.from(bytes));
  } catch (e) {
    if (!firstSignature) {
      // A rewrite would invalidate the existing signatures — hard stop.
      throw new Error('incremental placeholder failed on signed document: ' + (e && e.message));
    }
    // First signature on a PDF the plain parser cannot read — typically an xref STREAM with
    // object streams, which is what Word and LibreOffice write. Rewrite it once with pdf-lib as
    // a classic xref table (allowed only while no signature exists), then add the placeholder
    // the same way as for every later signature.
    //
    // Until 2026-10-01 pdf-lib added this first placeholder itself. That crashed on our
    // arguments (no such PDF could be signed at all), and once fixed, its AcroForm was not one
    // the plain path recognises: the second signer's field replaced the first, and validators
    // saw only one signature. One path for every signature removes that seam.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    withPlaceholder = placeholder(Buffer.from(await doc.save({ useObjectStreams: false })));
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
