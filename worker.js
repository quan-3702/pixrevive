// ---------- PixRevive AI worker: upscaling (Swin2SR) and object removal (MI-GAN) ----------
// Models are downloaded once from Hugging Face and kept in the browser cache, then everything runs offline.
const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.all.min.mjs';
const MODELS = {
  up: { url: 'https://huggingface.co/Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr/resolve/main/onnx/model.onnx', mb: 53 },
  erase: { url: 'https://huggingface.co/andraniksargsyan/migan/resolve/main/migan_pipeline_v2.onnx', mb: 28 },
};
const CACHE = 'pixrevive-models-v1';
let ort = null;
const sessions = {};
const post = (m, t) => self.postMessage(m, t || []);

async function fetchModel(key, id) {
  const { url, mb } = MODELS[key];
  let cache = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch (_) {}
  const res = await fetch(url);
  if (!res.ok) throw new Error('The AI model could not be downloaded (' + res.status + ').');
  const total = Number(res.headers.get('content-length')) || mb * 1e6;
  const reader = res.body.getReader(), parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    post({ type: 'progress', id, stage: 'download', pct: Math.min(99, got / total * 100), mb });
  }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  try { if (cache) await cache.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } })); } catch (_) {}
  return buf;
}
async function session(key, id) {
  if (sessions[key]) return sessions[key];
  if (!ort) { ort = await import(ORT); ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2); }
  const bytes = await fetchModel(key, id);
  post({ type: 'progress', id, stage: 'start', pct: 100 });
  let s = null, device = 'wasm';
  if (key === 'up' && 'gpu' in navigator) {
    try { s = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] }); device = 'webgpu'; } catch (_) { s = null; }
  }
  if (!s) s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  sessions[key] = { s, device };
  return sessions[key];
}

// ---- upscaling, tile by tile so big photos fit in memory ----
async function upscale(id, { width: W, height: H, data }, tile) {
  const { s, device } = await session('up', id);
  const S = 4, T = tile || (device === 'webgpu' ? 192 : 96), PAD = 12;
  const OW = W * S, OH = H * S;
  const acc = new Float32Array(OW * OH * 3), wsum = new Float32Array(OW * OH);
  const xs = [], ys = [];
  for (let x = 0; x < W; x += T) xs.push(x);
  for (let y = 0; y < H; y += T) ys.push(y);
  const total = xs.length * ys.length; let done = 0;
  for (const ty of ys) for (const tx of xs) {
    // tile with a margin around it, padded to a multiple of 8 (the model works in 8×8 windows)
    const x0 = Math.max(0, tx - PAD), y0 = Math.max(0, ty - PAD), x1 = Math.min(W, tx + T + PAD), y1 = Math.min(H, ty + T + PAD);
    const tw = x1 - x0, th = y1 - y0, pw = Math.ceil(tw / 8) * 8, ph = Math.ceil(th / 8) * 8;
    const inp = new Float32Array(3 * pw * ph);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const sx = x0 + Math.min(x, tw - 1), sy = y0 + Math.min(y, th - 1), i = (sy * W + sx) * 4, o = y * pw + x; // edge pixels repeated into the padding
      inp[o] = data[i] / 255; inp[pw * ph + o] = data[i + 1] / 255; inp[2 * pw * ph + o] = data[i + 2] / 255;
    }
    const feeds = {}; feeds[s.inputNames[0]] = new ort.Tensor('float32', inp, [1, 3, ph, pw]);
    const out = (await s.run(feeds))[s.outputNames[0]];
    const od = out.data, opw = out.dims[3], oph = out.dims[2];
    // keep the centre of the tile, fade the margins into the neighbours
    const cx0 = (tx - x0) * S, cy0 = (ty - y0) * S, cw = Math.min(T, W - tx) * S, ch = Math.min(T, H - ty) * S, fade = PAD * S;
    for (let y = Math.max(0, cy0 - fade); y < Math.min(th * S, cy0 + ch + fade); y++) {
      const gy = y0 * S + y; if (gy >= OH) continue;
      const wy = y < cy0 ? (y - (cy0 - fade)) / fade : y >= cy0 + ch ? (cy0 + ch + fade - y) / fade : 1;
      for (let x = Math.max(0, cx0 - fade); x < Math.min(tw * S, cx0 + cw + fade); x++) {
        const gx = x0 * S + x; if (gx >= OW) continue;
        const wx = x < cx0 ? (x - (cx0 - fade)) / fade : x >= cx0 + cw ? (cx0 + cw + fade - x) / fade : 1;
        const w = Math.max(0.001, Math.min(wx, wy)), gi = gy * OW + gx, oi = y * opw + x;
        acc[gi * 3] += od[oi] * w; acc[gi * 3 + 1] += od[oph * opw + oi] * w; acc[gi * 3 + 2] += od[2 * oph * opw + oi] * w; wsum[gi] += w;
      }
    }
    done++;
    post({ type: 'progress', id, stage: 'work', pct: done / total * 100 });
  }
  const res = new Uint8ClampedArray(OW * OH * 4);
  for (let i = 0; i < OW * OH; i++) {
    const w = wsum[i] || 1;
    res[i * 4] = acc[i * 3] / w * 255; res[i * 4 + 1] = acc[i * 3 + 1] / w * 255; res[i * 4 + 2] = acc[i * 3 + 2] / w * 255; res[i * 4 + 3] = 255;
  }
  return { width: OW, height: OH, data: res, device };
}

// ---- object removal: MI-GAN pipeline (crops around the mask by itself) ----
async function erase(id, { width: W, height: H, data }, mask, known) {
  const { s } = await session('erase', id);
  const img = new Uint8Array(3 * W * H), m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    img[i] = data[i * 4]; img[W * H + i] = data[i * 4 + 1]; img[2 * W * H + i] = data[i * 4 + 2];
    m[i] = mask[i] ? (known ? 0 : 255) : (known ? 255 : 0);
  }
  const feeds = {};
  feeds[s.inputNames[0]] = new ort.Tensor('uint8', img, [1, 3, H, W]);
  feeds[s.inputNames[1]] = new ort.Tensor('uint8', m, [1, 1, H, W]);
  const out = (await s.run(feeds))[s.outputNames[0]];
  const od = out.data, res = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { res[i * 4] = od[i]; res[i * 4 + 1] = od[W * H + i]; res[i * 4 + 2] = od[2 * W * H + i]; res[i * 4 + 3] = 255; }
  return { width: W, height: H, data: res, names: [s.inputNames, s.outputNames] };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'upscale') { const r = await upscale(m.id, m.image, m.tile); post({ type: 'done', id: m.id, image: r }, [r.data.buffer]); }
    else if (m.type === 'erase') { const r = await erase(m.id, m.image, m.mask, m.known !== false); post({ type: 'done', id: m.id, image: r }); }
    else if (m.type === 'info') { const r = await session(m.key, m.id); post({ type: 'done', id: m.id, info: { inputs: r.s.inputNames, outputs: r.s.outputNames, device: r.device } }); }
  } catch (err) { post({ type: 'error', id: m.id, message: String((err && err.message) || err) }); }
};
