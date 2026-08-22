# Vendored: PKI.js 3.4.0 + asn1js 3.0.10 (single-file ESM bundle)

Self-hosted X.509/CMS toolkit for the in-call signing ceremony (`public/qes/`):
mock-certificate generation (Phase 2), CMS/CAdES parsing and the certificate ↔ PID
identity match (Phases 3–5). Lazy-loaded only when a signing step starts. Self-hosting
keeps the CSP free of external script sources (kein externes Script, keine CDN-Abhängigkeit).

- Sources: https://www.npmjs.com/package/pkijs (BSD-3-Clause, see LICENSE),
  https://www.npmjs.com/package/asn1js (BSD-3-Clause)
- File: `pkijs.bundle.mjs` — exports `{ pkijs, asn1js }` namespaces
- Rebuild:
  ```
  npm i pkijs asn1js esbuild
  printf 'export * as pkijs from "pkijs";\nexport * as asn1js from "asn1js";\n' > entry.mjs
  npx esbuild entry.mjs --bundle --format=esm --minify --outfile=pkijs.bundle.mjs
  ```
  Copy the bundle + pkijs LICENSE here and bump the versions in this file.
