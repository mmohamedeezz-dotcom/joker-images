// Builds a designer-style layered PSD from a Joker job file.
// usage: node build.js <job.json> <out.psd>
// A job holds: the original design, an empty background plate, one clean transparent cutout per element,
// the lettering as a transparent raster, and the text lines (for live, editable type layers).
const fs = require('fs');
const { PNG } = require('pngjs');
const { writePsdBuffer } = require('ag-psd');

const FONTS = {
  'bold-modern': 'Alexandria-Black', 'kufi-wide': 'Kufam-Black', blocky: 'BadeenDisplay-Regular',
  'poster-round': 'Lalezar-Regular', playful: 'Marhey-Bold', handwritten: 'PlaypenSansArabic-ExtraBold',
  ruqaa: 'Rakkas-Regular', brush: 'Alkalami-Regular', elegant: 'ElMessiri-Bold', classic: 'Amiri-Bold',
  stretched: 'ReemKufi-Bold', corporate: 'IBMPlexSansArabic-Bold', tech: 'Changa-ExtraBold',
  sans: 'thmanyahsans-Black', 'serif-display': 'thmanyahserifdisplay-Black', 'serif-text': 'thmanyahseriftext-Bold',
  combo: 'thmanyahserifdisplay-Black',
};
const SECONDARY_FONTS = { combo: 'thmanyahsans-Medium', sans: 'thmanyahsans-Medium' };

const decode = (b64) => {
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) };
};

// model outputs come back a few pixels larger (sizes must divide by 16): crop them back to the design size
function fit(img, W, H) {
  if (!img) return null;
  if (img.width === W && img.height === H) return img;
  if (img.width < W || img.height < H || img.width - W >= 16 || img.height - H >= 16) return null;
  const x0 = (img.width - W) >> 1, y0 = (img.height - H) >> 1;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) out.set(img.data.subarray(((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0 + W) * 4), y * W * 4);
  return { width: W, height: H, data: out };
}

const dist = (a, b, d) => Math.abs(a[d] - b[d]) + Math.abs(a[d + 1] - b[d + 1]) + Math.abs(a[d + 2] - b[d + 2]);

function boxBlur(src, W, H, R) {
  const N = W * H, tmp = new Float32Array(N), dst = new Float32Array(N), win = 2 * R + 1;
  for (let y = 0; y < H; y++) {
    let sum = 0; const row = y * W;
    for (let p = -R; p <= R; p++) sum += src[row + Math.min(W - 1, Math.max(0, p))];
    for (let x = 0; x < W; x++) { tmp[row + x] = sum / win; sum += src[row + Math.min(W - 1, x + R + 1)] - src[row + Math.max(0, x - R)]; }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let p = -R; p <= R; p++) sum += tmp[Math.min(H - 1, Math.max(0, p)) * W + x];
    for (let y = 0; y < H; y++) { dst[y * W + x] = sum / win; sum += tmp[Math.min(H - 1, y + R + 1) * W + x] - tmp[Math.max(0, y - R) * W + x]; }
  }
  return dst;
}

// the model redraws an element a few pixels off: slide the cutout to where it best matches the design
function align(px, orig, W, H) {
  const N = W * H, samples = [];
  const step = Math.max(1, Math.floor(N / 60000));
  for (let p = 0; p < N; p += step) if (px[p * 4 + 3] === 255) samples.push(p);
  if (samples.length < 200) return { dx: 0, dy: 0, score: 999, base: 999 };
  const score = (dx, dy) => {
    let sum = 0, n = 0;
    for (const p of samples) {
      const x = (p % W) + dx, y = ((p / W) | 0) + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const d = p * 4, o = (y * W + x) * 4;
      sum += Math.abs(px[d] - orig[o]) + Math.abs(px[d + 1] - orig[o + 1]) + Math.abs(px[d + 2] - orig[o + 2]); n++;
    }
    return n ? sum / n : 999;
  };
  const base = score(0, 0);
  let best = { dx: 0, dy: 0, score: base };
  for (let dy = -24; dy <= 24; dy += 3) for (let dx = -24; dx <= 24; dx += 3) { const s = score(dx, dy); if (s < best.score) best = { dx, dy, score: s }; }
  const c0 = { ...best };
  for (let dy = c0.dy - 2; dy <= c0.dy + 2; dy++) for (let dx = c0.dx - 2; dx <= c0.dx + 2; dx++) { const s = score(dx, dy); if (s < best.score) best = { dx, dy, score: s }; }
  return { ...best, base };
}
function shift(px, W, H, dx, dy) {
  if (!dx && !dy) return px;
  const out = new Uint8ClampedArray(px.length);
  for (let y = 0; y < H; y++) {
    const ny = y + dy; if (ny < 0 || ny >= H) continue;
    for (let x = 0; x < W; x++) {
      const nx = x + dx; if (nx < 0 || nx >= W) continue;
      const s = (y * W + x) * 4, d = (ny * W + nx) * 4;
      out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
    }
  }
  return out;
}

// trims a full-canvas RGBA layer to its content so Photoshop shows a tight bounding box
function trim(img) {
  const { width: W, height: H, data } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x0 + w) * 4), y * w * 4);
  return { left: x0, top: y0, imageData: { width: w, height: h, data: out } };
}

const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

function build(job) {
  const report = [];
  const orig = decode(job.original_b64);
  const W = orig.width, H = orig.height, N = W * H;
  const plate = fit(job.plate_b64 ? decode(job.plate_b64) : null, W, H);
  if (plate) for (let i = 3; i < N * 4; i += 4) plate.data[i] = 255;

  // ---- elements: clean cutouts, placed where the model kept them ----
  const elems = [];
  for (const e of job.elements || []) {
    let cut = null;
    try { cut = fit(e.cut_b64 ? decode(e.cut_b64) : null, W, H); } catch (err) { cut = null; }
    if (!cut) { report.push({ name: e.name, status: 'no cutout' }); continue; }
    for (let p = 0; p < N; p++) { const a = cut.data[p * 4 + 3]; if (a < 8) cut.data[p * 4 + 3] = 0; else if (a >= 245) cut.data[p * 4 + 3] = 255; }
    const al = align(cut.data, orig.data, W, H);
    const moved = al.score < al.base * 0.9 && (al.dx || al.dy);
    const px = moved ? shift(cut.data, W, H, al.dx, al.dy) : cut.data;
    let solid = 0, clear = 0, same = 0;
    const err = new Uint16Array(N);
    for (let p = 0; p < N; p++) {
      const d = p * 4, a = px[d + 3];
      if (a < 8) { px[d + 3] = 0; clear++; continue; }
      solid++;
      const er = dist(px, orig.data, d);
      err[p] = er;
      // fully opaque pixels that already agree with the design take the design's exact pixel
      if (a === 255 && er < 60) { px[d] = orig.data[d]; px[d + 1] = orig.data[d + 1]; px[d + 2] = orig.data[d + 2]; same++; }
    }
    const clearPct = Math.round((clear * 100) / N);
    if (clearPct < 5) { report.push({ name: e.name, status: 'cutout not transparent', transparentPct: clearPct }); continue; }
    if (solid < N * 0.0005) { report.push({ name: e.name, status: 'empty cutout' }); continue; }
    const matchPct = Math.round((same * 100) / solid);
    elems.push({ name: e.name, data: px, err, solid, matchPct });
    report.push({ name: e.name, status: 'ok', coverPct: Math.round((solid * 1000) / N) / 10, matchesDesignPct: matchPct, moved: moved ? [al.dx, al.dy] : [0, 0], fit: Math.round(al.score) });
  }

  // stacking order: where two cutouts overlap, the one that agrees with the design is in front
  const score = elems.map(() => 0);
  for (let i = 0; i < elems.length; i++) for (let j = i + 1; j < elems.length; j++) {
    let vi = 0, vj = 0;
    const A = elems[i], B = elems[j];
    for (let p = 0; p < N; p++) {
      if (A.data[p * 4 + 3] < 128 || B.data[p * 4 + 3] < 128) continue;
      if (A.err[p] + 15 < B.err[p]) vi++; else if (B.err[p] + 15 < A.err[p]) vj++;
    }
    if (vi + vj < 80) continue;
    if (vi > vj) { score[i]++; score[j]--; } else { score[j]++; score[i]--; }
  }
  const ordered = elems.map((e, i) => ({ e, s: score[i], i })).sort((a, b) => a.s - b.s || a.i - b.i).map((o) => o.e);

  // ---- lettering as designed (raster) ----
  let lettering = null;
  if (job.text_b64) {
    try {
      const t = fit(decode(job.text_b64), W, H);
      if (t) {
        let clear = 0;
        for (let p = 0; p < N; p++) { const d = p * 4, a = t.data[d + 3]; if (a < 100) { t.data[d + 3] = 0; clear++; } else t.data[d + 3] = Math.min(255, Math.round(((a - 100) * 255) / 140)); }
        const pct = Math.round((clear * 100) / N);
        if (pct >= 3 && pct < 100) lettering = t;
        report.push({ name: 'lettering', status: lettering ? 'ok' : 'not isolated', transparentPct: pct });
      }
    } catch (err) { report.push({ name: 'lettering', status: 'decode error' }); }
  }

  // ---- whatever the layers above still miss (doodles, frames, icon strips) goes to one catch-all layer ----
  let rest = null;
  if (plate) {
    const comp = new Uint8ClampedArray(plate.data);
    const over = (s) => {
      for (let p = 0; p < N; p++) {
        const d = p * 4, al = s[d + 3];
        if (!al) continue;
        const ia = 255 - al;
        comp[d] = (s[d] * al + comp[d] * ia) / 255; comp[d + 1] = (s[d + 1] * al + comp[d + 1] * ia) / 255; comp[d + 2] = (s[d + 2] * al + comp[d + 2] * ia) / 255;
      }
    };
    for (const e of ordered) over(e.data);
    if (lettering) over(lettering.data);
    const miss = new Float32Array(N);
    for (let p = 0; p < N; p++) miss[p] = dist(orig.data, comp, p * 4);
    const soft = boxBlur(miss, W, H, 2);
    const own = new Float32Array(N);
    for (const e of ordered) for (let p = 0; p < N; p++) if (e.data[p * 4 + 3] > own[p]) own[p] = e.data[p * 4 + 3];
    const ownZone = boxBlur(own, W, H, 3);
    const out = new Uint8ClampedArray(N * 4);
    let used = 0;
    for (let p = 0; p < N; p++) {
      const v = soft[p];
      if (v <= 34 || ownZone[p] > 24) continue;
      const d = p * 4;
      out[d] = orig.data[d]; out[d + 1] = orig.data[d + 1]; out[d + 2] = orig.data[d + 2];
      out[d + 3] = v >= 70 ? 255 : Math.round(((v - 34) * 255) / 36);
      used++;
    }
    // leftovers that hug the lettering are edges of the lettering itself: keep them with it, not as ghosts
    if (lettering) {
      const la = new Float32Array(N);
      for (let p = 0; p < N; p++) la[p] = lettering.data[p * 4 + 3];
      const zone = boxBlur(la, W, H, 7);
      for (let p = 0; p < N; p++) {
        const d = p * 4;
        if (!out[d + 3] || zone[p] < 6) continue;
        if (out[d + 3] > lettering.data[d + 3]) { lettering.data[d] = out[d]; lettering.data[d + 1] = out[d + 1]; lettering.data[d + 2] = out[d + 2]; lettering.data[d + 3] = out[d + 3]; }
        out[d + 3] = 0; used--;
      }
    }
    if (used > N * 0.001) { rest = { width: W, height: H, data: out }; report.push({ name: 'graphics and details', status: 'ok', coverPct: Math.round((used * 1000) / N) / 10 }); }
  }

  // ---- assemble the document, bottom to top ----
  const pixelLayer = (name, img, extra = {}) => { const t = trim(img); return t ? { name, ...t, ...extra } : null; };
  const children = [];
  children.push({ name: 'Original design (reference)', left: 0, top: 0, imageData: orig, hidden: true });
  if (plate) children.push({ name: 'Background', left: 0, top: 0, imageData: plate });
  const elemLayers = ordered.map((e) => pixelLayer(e.name, { width: W, height: H, data: e.data })).filter(Boolean);
  if (elemLayers.length) children.push({ name: 'Elements', opened: true, children: elemLayers });
  if (rest) { const l = pixelLayer('Graphics and details', rest); if (l) children.push(l); }

  const fontKey = String(job.font || 'combo');
  const headFont = FONTS[fontKey] || FONTS.combo;
  const bodyFont = SECONDARY_FONTS[fontKey] || headFont;
  const liveText = [];
  for (const t of job.texts || []) {
    const text = String(t.text || '').trim();
    const h = Number(t.h), w = Number(t.w), x = Number(t.x), y = Number(t.y);
    if (!text || !(h > 4) || !(w > 4)) continue;
    const head = /head|title|punch/i.test(String(t.role || ''));
    const size = Math.max(10, Math.round(h * 0.92));
    const align = t.align === 'center' ? 'center' : t.align === 'left' ? 'left' : 'right';
    const ax = align === 'center' ? x + w / 2 : align === 'left' ? x : x + w;
    liveText.push({
      name: text.slice(0, 40),
      text: {
        text,
        transform: [1, 0, 0, 1, Math.round(ax), Math.round(y + h * 0.8)],
        antiAlias: 'smooth',
        style: { font: { name: head ? headFont : bodyFont }, fontSize: size, fillColor: hexToRgb(t.color) },
        paragraphStyle: { justification: align },
      },
    });
  }
  const textGroup = [];
  if (liveText.length) textGroup.push({ name: 'Editable text (turn on, then hide the lettering)', hidden: true, opened: false, children: liveText.reverse() });
  if (lettering) { const l = pixelLayer('Lettering (as designed)', lettering); if (l) textGroup.push(l); }
  if (textGroup.length) children.push({ name: 'Text', opened: true, children: textGroup });
  if (!plate) children[0].hidden = false;

  const psd = { width: W, height: H, children, imageData: orig };
  const buffer = writePsdBuffer(psd, { invalidateTextLayers: true, generateThumbnail: false, noBackground: true });
  const parts = { W, H, orig, plate, elems: ordered.map((e) => ({ name: e.name, data: e.data, solid: e.solid })), lettering, rest, texts: job.texts || [], font: fontKey };
  return { buffer, report, width: W, height: H, parts, layers: children.map((c) => c.name + (c.children ? ' [' + c.children.length + ']' : '')) };
}

if (require.main === module) {
  const [, , jobPath, outPath] = process.argv;
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  const r = build(job);
  fs.writeFileSync(outPath, r.buffer);
  console.log(JSON.stringify({ bytes: r.buffer.length, width: r.width, height: r.height, layers: r.layers, report: r.report }, null, 1));
}
module.exports = { build, trim };
