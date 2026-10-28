/* Background effects for the outgoing camera picture: blur, or replace it with an image.
 *
 * Everything runs on the device. MediaPipe's selfie segmenter (vendor/mediapipe, self-hosted,
 * 0.10.x on purpose — the 1.x line reports usage metrics to Google) tells person from
 * background per frame; a canvas composites the person over the chosen background and its
 * captureStream() track replaces the camera track. The other side only ever receives the
 * composited picture; neither the camera frames nor a chosen image leave the device otherwise.
 *
 * Lazy: app.js imports this module only when someone picks an effect, so a call without one
 * never downloads the ~11 MB of WebAssembly. */
import { ImageSegmenter } from './vendor/mediapipe/vision_bundle.mjs';

const VENDOR = new URL('./vendor/mediapipe/', import.meta.url);

/* Load once; every processor shares the segmenter (one camera at a time anyway). */
let segPromise = null;
function loadSegmenter() {
  if (!segPromise) {
    segPromise = (async () => {
      // Explicit paths instead of FilesetResolver: only the SIMD build is vendored.
      const fileset = {
        wasmLoaderPath: new URL('wasm/vision_wasm_internal.js', VENDOR).href,
        wasmBinaryPath: new URL('wasm/vision_wasm_internal.wasm', VENDOR).href,
      };
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: new URL('selfie_segmenter.tflite', VENDOR).href, delegate },
        runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
      });
      // The GPU path is much faster but not available everywhere (old GPUs, some WebViews).
      try { return await ImageSegmenter.createFromOptions(fileset, opts('GPU')); }
      catch { return ImageSegmenter.createFromOptions(fileset, opts('CPU')); }
    })();
    segPromise.catch(() => { segPromise = null; });
  }
  return segPromise;
}

/* Frames must keep flowing while the tab is in the background: the canvas IS the outgoing
   picture. requestAnimationFrame stops there and timers are throttled to 1 Hz, a dedicated
   worker's timer is not (same reasoning as the SAS overlay in app.js). */
const CLOCK_SRC = 'let i=null;onmessage=(e)=>{clearInterval(i);i=null;if(e.data&&e.data.ms)i=setInterval(()=>postMessage(0),e.data.ms)};';

/**
 * Start processing `track` (a camera track). Resolves once the first composited frame exists,
 * so the returned track never shows the unprocessed room.
 * `effect`: 'blur' | { image } (a canvas or image, drawn to cover the frame).
 */
export async function createProcessor(track, effect) {
  const seg = await loadSegmenter();
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
  video.srcObject = new MediaStream([track]);
  document.body.appendChild(video);
  await video.play().catch(() => {});

  const out = document.createElement('canvas');
  const ctx = out.getContext('2d');
  const maskCanvas = document.createElement('canvas');
  const maskCtx = maskCanvas.getContext('2d');
  const bgCanvas = document.createElement('canvas'); // the prepared background at output size
  const bgCtx = bgCanvas.getContext('2d');
  const blurCanvas = document.createElement('canvas');
  const blurCtx = blurCanvas.getContext('2d');
  const canFilter = (() => { blurCtx.filter = 'blur(2px)'; const ok = blurCtx.filter === 'blur(2px)'; blurCtx.filter = 'none'; return ok; })();
  const small = document.createElement('canvas'); // fallback blur where canvas filters are missing (older Safari)
  const smallCtx = small.getContext('2d');

  let cur = effect, bgDirty = true, W = 0, H = 0, maskImg = null, prev = null, running = true, lastTs = 0;

  function prepareBackground() {
    bgCanvas.width = W; bgCanvas.height = H;
    if (cur === 'blur') return;
    // cover, centred
    const img = cur.image, iw = img.width, ih = img.height;
    const s = Math.max(W / iw, H / ih);
    bgCtx.drawImage(img, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
    bgDirty = false;
  }

  function blurredFrame() {
    if (canFilter) {
      const bw = Math.max(1, Math.round(W / 2)), bh = Math.max(1, Math.round(H / 2));
      if (blurCanvas.width !== bw || blurCanvas.height !== bh) { blurCanvas.width = bw; blurCanvas.height = bh; }
      blurCtx.filter = `blur(${Math.max(4, Math.round(bw / 40))}px)`;
      blurCtx.drawImage(video, 0, 0, bw, bh);
      blurCtx.filter = 'none';
      return blurCanvas;
    }
    // Down to a few dozen pixels and back up in two steps: a soft, cheap blur.
    const sw = Math.max(1, Math.round(W / 16)), sh = Math.max(1, Math.round(H / 16));
    if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
    smallCtx.imageSmoothingQuality = 'high';
    smallCtx.drawImage(video, 0, 0, sw, sh);
    const mw = sw * 4, mh = sh * 4;
    if (blurCanvas.width !== mw || blurCanvas.height !== mh) { blurCanvas.width = mw; blurCanvas.height = mh; }
    blurCtx.imageSmoothingQuality = 'high';
    blurCtx.drawImage(small, 0, 0, mw, mh);
    return blurCanvas;
  }

  function onMask(result) {
    const m = result.confidenceMasks && result.confidenceMasks[0];
    if (!m) return;
    const mw = m.width, mh = m.height, data = m.getAsFloat32Array();
    if (!maskImg || maskImg.width !== mw || maskImg.height !== mh) {
      maskCanvas.width = mw; maskCanvas.height = mh;
      maskImg = maskCtx.createImageData(mw, mh); prev = new Float32Array(mw * mh);
    }
    const px = maskImg.data;
    for (let i = 0; i < data.length; i++) {
      // A little memory against flicker at the edges, then a soft threshold for a clean outline.
      const v = (prev[i] = prev[i] * 0.35 + data[i] * 0.65);
      const a = v <= 0.25 ? 0 : v >= 0.75 ? 1 : (v - 0.25) * 2;
      px[i * 4 + 3] = a * 255;
    }
    maskCtx.putImageData(maskImg, 0, 0);
    if (result.close) result.close();
  }

  function frame() {
    if (!running) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return;
    if (vw !== W || vh !== H) { W = out.width = vw; H = out.height = vh; bgDirty = true; } // phones rotate
    if (bgDirty && cur !== 'blur') prepareBackground();
    const ts = Math.max(performance.now(), lastTs + 1); lastTs = ts;
    try { seg.segmentForVideo(video, ts, onMask); } catch { /* frame not ready */ }
    if (!maskImg) { ctx.drawImage(video, 0, 0, W, H); return; } // nothing to cut out yet
    ctx.save();
    ctx.globalCompositeOperation = 'copy';
    ctx.imageSmoothingEnabled = true;
    // alpha = person; the 256 px mask, softened while scaled up so the outline does not step
    if (canFilter) ctx.filter = `blur(${Math.max(1, Math.round(W / 220))}px)`;
    ctx.drawImage(maskCanvas, 0, 0, W, H);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(video, 0, 0, W, H);                // the person only
    ctx.globalCompositeOperation = 'destination-over';
    ctx.drawImage(cur === 'blur' ? blurredFrame() : bgCanvas, 0, 0, W, H);
    ctx.restore();
  }

  // Scheduling: rAF while visible, the worker's timer while hidden.
  let raf = null, clock = null, clockUrl = null;
  try {
    clockUrl = URL.createObjectURL(new Blob([CLOCK_SRC], { type: 'text/javascript' }));
    clock = new Worker(clockUrl);
    clock.onmessage = () => { if (document.hidden) frame(); };
  } catch { clock = null; }
  let fallbackTimer = null;
  function schedule() {
    if (!running) return;
    if (!document.hidden) {
      if (clock) clock.postMessage({ ms: 0 });
      clearInterval(fallbackTimer); fallbackTimer = null;
      raf = requestAnimationFrame(() => { frame(); schedule(); });
    } else if (clock) {
      clock.postMessage({ ms: 42 });
    } else if (!fallbackTimer) {
      fallbackTimer = setInterval(frame, 42);
    }
  }
  const onVis = () => { cancelAnimationFrame(raf); schedule(); };
  document.addEventListener('visibilitychange', onVis);

  // First composited frame before handing the track out, so the other side never sees the room.
  const t0 = performance.now();
  while (!maskImg && performance.now() - t0 < 4000) { frame(); await new Promise((r) => setTimeout(r, 30)); }
  if (!W) { W = out.width = 640; H = out.height = 480; }
  const outStream = out.captureStream(30);
  const outTrack = outStream.getVideoTracks()[0];
  schedule();

  return {
    track: outTrack,
    setEffect(e) { cur = e; bgDirty = true; },
    stop() {
      running = false;
      cancelAnimationFrame(raf); clearInterval(fallbackTimer);
      document.removeEventListener('visibilitychange', onVis);
      if (clock) { clock.terminate(); clock = null; }
      if (clockUrl) URL.revokeObjectURL(clockUrl);
      try { outTrack.stop(); } catch {}
      video.srcObject = null; video.remove();
    },
  };
}
