// Monocular depth in the browser: Depth Anything V2 Small (Apache-2.0), int8, run with ONNX Runtime Web (WASM).
// Returns relative inverse depth (disparity: bigger = nearer) at the requested size.
let session = null, ortMod = null;
const MODEL = 'assets/models/depth-anything-v2-small-q8.onnx', S = 518;

async function load(progress) {
  if (session) return session;
  ortMod ||= await import('../vendor/onnxruntime-web/ort.webgpu.min.mjs');
  const ort = ortMod.default || ortMod;
  ort.env.wasm.wasmPaths = new URL('../vendor/onnxruntime-web/', import.meta.url).href;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  progress?.('Downloading the depth model (35 MB, once)…');
  const res = await fetch(new URL(`../${MODEL}`, import.meta.url));
  if (!res.ok) throw new Error(`depth model: HTTP ${res.status}`);
  const total = +res.headers.get('content-length') || 35.3e6, reader = res.body.getReader(), chunks = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; progress?.(`Downloading the depth model… ${Math.min(100, Math.round((got / total) * 100))}%`); }
  const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  progress?.('Starting the depth model…');
  session = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return session;
}

// canvas → raw 518×518 disparity (resample with resampleDepth)
export async function estimateDepth(canvas, progress) {
  const s = await load(progress), ort = ortMod.default || ortMod;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, S, S);
  const px = g.getImageData(0, 0, S, S).data, x = new Float32Array(3 * S * S);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < S * S; i++) for (let k = 0; k < 3; k++) x[k * S * S + i] = (px[i * 4 + k] / 255 - mean[k]) / std[k];
  progress?.('Estimating depth…');
  await new Promise((r) => setTimeout(r, 30));
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, S, S]) });
  return { raw: Float32Array.from(out[s.outputNames[0]].data), size: S };
}

// square model output → w × h (bilinear)
export function resampleDepth({ raw: d, size: S }, w, h) {
  const disp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    const fx = ((xx + 0.5) / w) * S - 0.5, fy = ((y + 0.5) / h) * S - 0.5;
    const x0 = Math.max(0, Math.min(S - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(S - 1, Math.floor(fy))), x1 = Math.min(S - 1, x0 + 1), y1 = Math.min(S - 1, y0 + 1);
    const tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
    disp[y * w + xx] = (d[y0 * S + x0] * (1 - tx) + d[y0 * S + x1] * tx) * (1 - ty) + (d[y1 * S + x0] * (1 - tx) + d[y1 * S + x1] * tx) * ty;
  }
  return disp;
}
