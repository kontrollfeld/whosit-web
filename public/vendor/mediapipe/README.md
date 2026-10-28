# Vendored: MediaPipe Tasks Vision (@mediapipe/tasks-vision 0.10.35)

Self-hosted person segmentation for the background effects (blur / replace) in
`public/background.mjs`, lazy-loaded only when someone picks an effect — never on the call path.
Everything runs on the device; no CDN, no external request.

- Source: https://www.npmjs.com/package/@mediapipe/tasks-vision (Google, Apache-2.0 — see LICENSE)
- Model: `selfie_segmenter.tflite` (float16, Apache-2.0), from
  https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
  — sha256 `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`
- Files: `vision_bundle.mjs` + `wasm/vision_wasm_internal.{js,wasm}` (the SIMD build only —
  without WebAssembly SIMD the effect is simply not offered).

**Do not update to 1.x without checking:** from 1.0 on the package sends usage metrics to
Google (`odml.pa.googleapis.com/v1/log`) and asks the app to obtain consent for it. 0.10.35
contains no such call. Before any update, `grep -c odml.pa vision_bundle.mjs` must print 0.

Update: `npm pack @mediapipe/tasks-vision@<version> && tar xzf mediapipe-tasks-vision-*.tgz` →
copy `package/vision_bundle.mjs` and `package/wasm/vision_wasm_internal.{js,wasm}` here and bump
the version in this file.
