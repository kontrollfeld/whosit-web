# Vendored: pdf.js (pdfjs-dist 6.1.200)

Self-hosted PDF renderer for the in-call document ceremony (`public/qes/`), lazy-loaded
only when a document share starts — never on the call path. Self-hosting keeps the CSP
free of external script sources (kein externes Script, keine CDN-Abhängigkeit).

- Source: https://www.npmjs.com/package/pdfjs-dist (Mozilla, Apache-2.0 — see LICENSE)
- Files: `pdf.min.mjs` (API) + `pdf.worker.min.mjs` (worker)
- Update: `npm pack pdfjs-dist && tar xzf pdfjs-dist-*.tgz` → copy
  `package/build/pdf.min.mjs`, `package/build/pdf.worker.min.mjs`, `package/LICENSE`
  here and bump the version in this file.
