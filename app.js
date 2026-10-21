const $ = (id) => document.getElementById(id);
const STORE_BILLING = 'https://store.microsoft.com/billing';
const PRO_SKU = 'pixrevive_pro';
const PRO_IDS = [PRO_SKU];
let STORE_URL = 'https://apps.microsoft.com/search/publisher?name=NTQ37';
let proAvailable = false; // Pro limits apply only when the Store actually sells the add-on
let proSku = PRO_SKU;
let isPro = false;
try { isPro = localStorage.getItem('pixrevive-pro') === '1'; } catch (_) {}
const unlocked = () => isPro || !proAvailable;
const FREE_MP = 1.0; // the free version enlarges photos up to 1 megapixel
const MAX_OUT_MP = 36;

async function billing() {
  if (!('getDigitalGoodsService' in window)) return null;
  try { return await window.getDigitalGoodsService(STORE_BILLING); } catch (_) { return null; }
}
function setPro(v) {
  isPro = v;
  try { localStorage.setItem('pixrevive-pro', v ? '1' : '0'); } catch (_) {}
  const b = $('proBtn');
  b.textContent = v ? '★ Pro' : '★ Get Pro';
  b.classList.toggle('is-pro', v);
  b.hidden = !proAvailable && !v;
  document.body.classList.toggle('unlocked', unlocked());
  renderUi();
}
async function checkPro() {
  const svc = await billing();
  if (!svc) return false;
  try {
    const details = await svc.getDetails(PRO_IDS).catch(() => []);
    proAvailable = details.length > 0;
    if (details[0]) { proSku = details[0].itemId; if (!PRO_IDS.includes(proSku)) PRO_IDS.push(proSku); }
    const list = await svc.listPurchases();
    const owned = list.some((p) => PRO_IDS.includes(p.itemId));
    setPro(owned);
    return owned;
  } catch (_) { return isPro; }
}
function proMessage(text) { const m = $('proMsg'); m.hidden = !text; m.textContent = text || ''; }
async function openPro(reason) {
  proMessage(reason || '');
  const svc = await billing();
  if (!svc) { $('buyBtn').textContent = 'Get PixRevive on Microsoft Store'; $('restoreBtn').hidden = true; }
  else {
    $('restoreBtn').hidden = false;
    try {
      const [d] = await svc.getDetails([proSku]);
      const price = d && d.price ? new Intl.NumberFormat(undefined, { style: 'currency', currency: d.price.currency }).format(Number(d.price.value)) : '';
      $('buyBtn').textContent = price ? `Unlock Pro – ${price}` : 'Unlock Pro';
    } catch (_) { $('buyBtn').textContent = 'Unlock Pro'; }
  }
  if (!$('proDialog').open) $('proDialog').showModal();
}
async function buyPro() {
  const svc = await billing();
  if (!svc) { window.open(STORE_URL, '_blank'); return; }
  const methods = [{ supportedMethods: STORE_BILLING, data: { sku: proSku } }];
  try {
    let req;
    try { req = new PaymentRequest(methods); } catch (_) { req = new PaymentRequest(methods, { total: { label: 'Total', amount: { currency: 'USD', value: '0' } } }); }
    const res = await req.show();
    await res.complete('success');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    proMessage('Purchase could not be completed: ' + (e.message || e));
    return;
  }
  if (await checkPro()) { proMessage('Thank you! Pro is unlocked. ★'); setTimeout(() => $('proDialog').close(), 1500); }
}
function needsPro(reason) { if (unlocked()) return false; openPro(reason); return true; }

// ---------- state ----------
let original = null, current = null, name = 'photo';
let hist = [], fut = [];
let zoom = 1, fit = true, scale = 2, busy = false, compare = false, splitX = 0.5;
let warmBase = null;
const cv = $('cv'), mk = $('mask');
let maskDirty = false;

function toast(msg, ms) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms || 3500); }
function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function copyCanvas(src) { const c = canvasOf(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; }
const mp = (c) => (c.width * c.height) / 1e6;

function commit(next, label) {
  if (current) { hist.push(current); if (hist.length > 15) hist.shift(); }
  fut = []; current = next; warmBase = null; $('warm').value = 0;
  if (label) toast(label);
  layout(); renderUi();
}
function undo() { if (!hist.length) return; fut.push(current); current = hist.pop(); warmBase = null; $('warm').value = 0; layout(); renderUi(); }
function redo() { if (!fut.length) return; hist.push(current); current = fut.pop(); warmBase = null; $('warm').value = 0; layout(); renderUi(); }

// ---------- drawing ----------
function viewSize() { const v = $('view'); return [v.clientWidth - 40, v.clientHeight - 40]; }
function layout() {
  if (!current) return;
  const [vw, vh] = viewSize();
  if (fit) zoom = Math.min(1, vw / current.width, vh / current.height);
  if (cv.width !== current.width || cv.height !== current.height) { cv.width = current.width; cv.height = current.height; }
  if (mk.width !== current.width || mk.height !== current.height) { mk.width = current.width; mk.height = current.height; maskDirty = false; }
  const w = Math.round(current.width * zoom) + 'px', h = Math.round(current.height * zoom) + 'px';
  cv.style.width = mk.style.width = w; cv.style.height = mk.style.height = h;
  draw();
}
function draw() {
  if (!current) return;
  const x = cv.getContext('2d');
  x.clearRect(0, 0, cv.width, cv.height);
  x.drawImage(current, 0, 0);
  if (compare && original) {
    const sx = Math.round(cv.width * splitX);
    x.save(); x.beginPath(); x.rect(0, 0, sx, cv.height); x.clip();
    x.imageSmoothingQuality = 'high';
    x.drawImage(original, 0, 0, cv.width, cv.height);
    x.restore();
    x.fillStyle = '#fff'; x.fillRect(sx - Math.max(1, 1.5 / zoom), 0, Math.max(2, 3 / zoom), cv.height);
  }
  $('split').hidden = !compare;
}
function renderUi() {
  const has = !!current;
  ['saveBtn', 'upBtn', 'autoBtn', 'bwBtn', 'eraseBtn'].forEach((id) => ($(id).disabled = !has || busy));
  $('warm').disabled = !has || busy;
  $('clearMaskBtn').disabled = !maskDirty || busy;
  $('eraseBtn').disabled = !has || busy || !maskDirty;
  $('undoBtn').disabled = !hist.length || busy; $('redoBtn').disabled = !fut.length || busy;
  $('empty').hidden = has; $('canvasWrap').hidden = !has;
  $('scaleSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === scale));
  $('brushVal').textContent = $('brush').value + ' px';
  const w = Number($('warm').value); $('warmVal').textContent = w ? (w > 0 ? 'warmer +' + w : 'cooler ' + w) : '';
  if (has) {
    $('sizeLine').textContent = `${current.width} × ${current.height} px · ${Math.round(zoom * 100)}%`;
    const ow = current.width * scale, oh = current.height * scale;
    $('upInfo').textContent = `Result: ${ow} × ${oh} px` + (ow * oh / 1e6 > MAX_OUT_MP ? ' – too big, choose 2×' : '') + (!unlocked() && mp(current) > FREE_MP ? ` · free version: photos up to ${FREE_MP} megapixel` : '');
  } else { $('sizeLine').textContent = ''; $('upInfo').textContent = ''; }
}

// ---------- open & save ----------
async function openFile(f) {
  if (!f || !/^image\//.test(f.type || 'image/')) { toast('That file is not a picture'); return; }
  try {
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    const c = canvasOf(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0);
    original = c; current = copyCanvas(c); hist = []; fut = []; fit = true; compare = false; $('compare').checked = false;
    name = (f.name || 'photo').replace(/\.[^.]+$/, '');
    $('fileName').textContent = f.name || '';
    clearMask(); layout(); renderUi();
  } catch (_) { toast('That picture could not be opened'); }
}
function download(blob, fname) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); toast(`Saved ${fname} to your Downloads folder`); }
function save(jpg) {
  if (!current) return;
  current.toBlob((b) => download(b, `${name}-revived.${jpg ? 'jpg' : 'png'}`), jpg ? 'image/jpeg' : 'image/png', 0.93);
}

// ---------- AI worker ----------
let worker = null, jobId = 0;
const jobs = new Map();
function ai(msg, transfer) {
  if (!worker) {
    worker = new Worker('worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data, j = jobs.get(m.id); if (!j) return;
      if (m.type === 'progress') j.progress(m);
      else if (m.type === 'done') { jobs.delete(m.id); j.resolve(m); }
      else if (m.type === 'error') { jobs.delete(m.id); j.reject(new Error(m.message)); }
    };
  }
  const id = ++jobId;
  return new Promise((resolve, reject) => { jobs.set(id, { resolve, reject, progress: msg.onProgress || (() => {}) }); const { onProgress, ...rest } = msg; worker.postMessage({ ...rest, id }, transfer || []); });
}
function showBusy(title, text) { busy = true; $('busy').hidden = false; $('busyTitle').textContent = title; $('busyText').textContent = text || ''; $('busyBar').style.width = '0'; renderUi(); }
function hideBusy() { busy = false; $('busy').hidden = true; renderUi(); }
function progressFor(what) {
  return (m) => {
    $('busyBar').style.width = m.pct + '%';
    if (m.stage === 'download') $('busyText').textContent = `Downloading the AI (about ${m.mb} MB, only the first time)… ${Math.round(m.pct)}%`;
    else if (m.stage === 'start') $('busyText').textContent = 'Starting the AI…';
    else $('busyText').textContent = `${what}… ${Math.round(m.pct)}%`;
  };
}
const imageData = (c) => c.getContext('2d').getImageData(0, 0, c.width, c.height);
function fromData(r) { const c = canvasOf(r.width, r.height); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0); return c; }

async function enhance() {
  if (!current || busy) return;
  if (scale === 4 && needsPro('4× enlarging is part of PixRevive Pro.')) return;
  if (mp(current) > FREE_MP && needsPro(`The free version enlarges photos up to ${FREE_MP} megapixel. Unlock Pro for any size.`)) return;
  if (mp(current) * scale * scale > MAX_OUT_MP) { toast(scale === 4 ? 'This photo is too big for 4× – choose 2×.' : 'This photo is already very big – it does not need enlarging.', 5000); return; }
  showBusy('✨ Enhancing your photo', 'Getting ready…');
  try {
    const d = imageData(current);
    const r = await ai({ type: 'upscale', image: { width: d.width, height: d.height, data: d.data }, onProgress: progressFor('Adding detail') });
    let out = fromData(r.image);
    if (scale === 2) { const c = canvasOf(current.width * 2, current.height * 2), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(out, 0, 0, c.width, c.height); out = c; }
    fit = true;
    commit(out, `Done – the photo is now ${out.width} × ${out.height} px. Turn on “Compare” to see the difference.`);
  } catch (e) { toast('The photo could not be enhanced: ' + e.message, 7000); }
  hideBusy();
}

// ---------- erase brush ----------
let painting = false, last = null;
function brushR() { return Number($('brush').value) / 2 / zoom; }
function pt(e) { const r = mk.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * mk.width, (e.clientY - r.top) / r.height * mk.height]; }
function paint(a, b) {
  const x = mk.getContext('2d');
  x.strokeStyle = x.fillStyle = 'rgb(239, 68, 68)'; x.lineCap = 'round'; x.lineJoin = 'round'; x.lineWidth = brushR() * 2;
  x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke();
  maskDirty = true;
}
mk.addEventListener('pointerdown', (e) => {
  if (!current || busy) return;
  if (compare) { splitX = Math.max(0, Math.min(1, pt(e)[0] / mk.width)); draw(); return; }
  painting = true; last = pt(e); paint(last, last); mk.setPointerCapture(e.pointerId); renderUi();
});
mk.addEventListener('pointermove', (e) => {
  if (compare && current) { splitX = Math.max(0, Math.min(1, pt(e)[0] / mk.width)); draw(); return; }
  if (!painting) return;
  const p = pt(e); paint(last, p); last = p;
});
const endPaint = () => { painting = false; };
mk.addEventListener('pointerup', endPaint); mk.addEventListener('pointercancel', endPaint);
function clearMask() { mk.getContext('2d').clearRect(0, 0, mk.width, mk.height); maskDirty = false; renderUi(); }
async function eraseNow() {
  if (!current || busy || !maskDirty) return;
  showBusy('🧽 Erasing', 'Getting ready…');
  try {
    const d = imageData(current), md = mk.getContext('2d').getImageData(0, 0, mk.width, mk.height).data;
    const mask = new Uint8Array(d.width * d.height);
    for (let i = 0; i < mask.length; i++) mask[i] = md[i * 4 + 3] > 10 ? 1 : 0;
    const r = await ai({ type: 'erase', image: { width: d.width, height: d.height, data: d.data }, mask, onProgress: progressFor('Filling in') });
    const out = fromData(r.image);
    clearMask();
    commit(out, 'Erased. Paint again to remove more, or press Undo.');
  } catch (e) { toast('Erasing did not work: ' + e.message, 7000); }
  hideBusy();
}

// ---------- colour ----------
function autoColour() {
  if (!current || busy) return;
  const c = copyCanvas(current), x = c.getContext('2d'), id = x.getImageData(0, 0, c.width, c.height), d = id.data;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)], n = d.length / 4;
  const step = Math.max(1, Math.floor(n / 400000));
  let cnt = 0;
  for (let i = 0; i < d.length; i += 4 * step) { hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++; cnt++; }
  const lohi = hist.map((h) => { let a = 0, lo = 0, hi = 255; const cut = cnt * 0.006; for (let v = 0; v < 256; v++) { a += h[v]; if (a > cut) { lo = v; break; } } a = 0; for (let v = 255; v >= 0; v--) { a += h[v]; if (a > cut) { hi = v; break; } } return [lo, Math.max(lo + 20, hi)]; });
  const lut = lohi.map(([lo, hi]) => { const t = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) t[v] = (v - lo) / (hi - lo) * 255; return t; });
  for (let i = 0; i < d.length; i += 4) {
    let r = lut[0][d[i]], g = lut[1][d[i + 1]], b = lut[2][d[i + 2]];
    const l = 0.299 * r + 0.587 * g + 0.114 * b, s = 1.12; // a little more colour
    d[i] = l + (r - l) * s; d[i + 1] = l + (g - l) * s; d[i + 2] = l + (b - l) * s;
  }
  x.putImageData(id, 0, 0);
  commit(c, 'Colours fixed. Press Undo if you liked it better before.');
}
function blackWhite() {
  if (!current || busy) return;
  const c = copyCanvas(current), x = c.getContext('2d'), id = x.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = l; }
  x.putImageData(id, 0, 0);
  commit(c);
}
function warmPreview() {
  if (!current) return;
  if (!warmBase) warmBase = copyCanvas(current);
  const w = Number($('warm').value), c = copyCanvas(warmBase), x = c.getContext('2d'), id = x.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) { d[i] += w * 0.6; d[i + 2] -= w * 0.6; }
  x.putImageData(id, 0, 0);
  current = c; draw(); renderUi();
}
function warmCommit() {
  if (!warmBase) return;
  const after = current; current = warmBase; warmBase = null;
  if (Number($('warm').value)) { hist.push(current); fut = []; current = after; }
  $('warm').value = 0; layout(); renderUi();
}

// ---------- events ----------
const pick = () => { const i = $('fileIn'); i.value = ''; i.onchange = () => openFile(i.files[0]); i.click(); };
$('openBtn').onclick = $('openBig').onclick = pick;
$('saveBtn').onclick = () => save(false);
$('saveJpgBtn').onclick = () => save(true);
$('resetBtn').onclick = () => { if (original) commit(copyCanvas(original), 'Back to the original photo. Press Undo to return.'); };
$('upBtn').onclick = enhance;
$('eraseBtn').onclick = eraseNow;
$('clearMaskBtn').onclick = clearMask;
$('autoBtn').onclick = autoColour;
$('bwBtn').onclick = blackWhite;
$('warm').addEventListener('input', warmPreview);
$('warm').addEventListener('change', warmCommit);
$('brush').addEventListener('input', renderUi);
$('undoBtn').onclick = undo; $('redoBtn').onclick = redo;
$('scaleSeg').querySelectorAll('button').forEach((b) => (b.onclick = () => { scale = Number(b.dataset.v); if (scale === 4 && !unlocked()) toast('4× enlarging is part of Pro.'); renderUi(); }));
$('compare').onchange = (e) => { compare = e.target.checked; mk.style.cursor = compare ? 'ew-resize' : 'crosshair'; draw(); };
$('zoomFit').onclick = () => { fit = true; layout(); renderUi(); };
$('zoom100').onclick = () => { fit = false; zoom = 1; layout(); renderUi(); };
$('zoomIn').onclick = () => { fit = false; zoom = Math.min(8, zoom * 1.25); layout(); renderUi(); };
$('zoomOut').onclick = () => { fit = false; zoom = Math.max(0.05, zoom / 1.25); layout(); renderUi(); };
$('moreBtn').onclick = (e) => { e.stopPropagation(); $('menu').hidden = !$('menu').hidden; };
document.addEventListener('click', () => { $('menu').hidden = true; });
$('proBtn').onclick = () => { if (!isPro) openPro(); };
$('buyBtn').onclick = buyPro;
$('restoreBtn').onclick = async () => { proMessage((await checkPro()) ? 'Pro restored. ★' : 'No Pro purchase found on this Microsoft account.'); };
$('closePro').onclick = () => $('proDialog').close();
window.addEventListener('resize', () => { if (fit) { layout(); renderUi(); } });
const view = $('view');
['dragenter', 'dragover'].forEach((t) => view.addEventListener(t, (e) => { e.preventDefault(); $('empty').classList.add('drag'); }));
['dragleave', 'drop'].forEach((t) => view.addEventListener(t, () => $('empty').classList.remove('drag')));
view.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) openFile(f); });
document.addEventListener('paste', (e) => { const it = [...(e.clipboardData || {}).items || []].find((i) => i.type.startsWith('image/')); if (it) openFile(it.getAsFile()); });
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(false); }
  else if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); pick(); }
});
setPro(isPro);
renderUi();
checkPro();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
