# Vendored: pdf-lib 1.17.1 + @signpdf 3.3.0 (single-file ESM bundle, Buffer-shimmed)

Self-hosted PAdES tooling for the in-call signing ceremony (`public/qes/pades.js`):
signature placeholder insertion (incremental update via `plainAddPlaceholder`,
`pdflibAddPlaceholder` as first-signature fallback for PDFs the plain parser can't
handle) and ByteRange/Contents embedding (`SignPdf`). Lazy-loaded only when a signing
ceremony starts. Self-hosting keeps the CSP free of external script sources.

- Sources: https://www.npmjs.com/package/pdf-lib (MIT, LICENSE-pdf-lib.md),
  https://www.npmjs.com/package/@signpdf/signpdf and siblings (MIT, LICENSE-signpdf),
  https://www.npmjs.com/package/buffer (MIT, bundled shim)
- File: `signpdf.bundle.mjs` — exports `{ PDFDocument, pdflibAddPlaceholder,
  plainAddPlaceholder, SignPdf, Signer, removeTrailingNewLine, findByteRange, Buffer }`
- NOTE: always wrap byte input with the BUNDLE's exported `Buffer`
  (`Buffer.from(bytes)`) — the shim's `Buffer.isBuffer` does not recognize foreign
  Buffer implementations.
- Rebuild:
  ```
  npm i pdf-lib @signpdf/placeholder-pdf-lib @signpdf/placeholder-plain \
        @signpdf/signpdf @signpdf/utils buffer esbuild
  # buffer-inject.mjs:  import { Buffer as B } from 'buffer'; export { B as Buffer };
  # entry.mjs: re-export the names listed above
  npx esbuild entry.mjs --bundle --format=esm --minify \
    --inject:./buffer-inject.mjs --define:global=globalThis \
    --outfile=signpdf.bundle.mjs
  ```
  Copy bundle + licenses here and bump the versions in this file.
