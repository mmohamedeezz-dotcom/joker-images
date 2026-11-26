// Builds a designer-style layered PSD from a Joker job file.
// usage: node build.js <job.json> <out.psd>
// A job holds: the original design, an empty background plate, one clean transparent cutout per element,
// the lettering as a transparent raster, and the text lines (for live, editable type layers).
const fs = require('fs');
const { PNG } = require('pngjs');
const { writePsdBuffer } = require('ag-psd');
const { splitPieces, extractShadows, splitWords } = require('./split');
const { ownScene, growOwners, splitFronts, buildLayers, designInk } = require('./scene');

const FONTS = {
  'bold-modern': 'Alexandria-Black', 'kufi-wide': 'Kufam-Black', blocky: 'BadeenDisplay-Regular',
  'poster-round': 'Lalezar-Regular', playful: 'Marhey-Bold', handwritten: 'PlaypenSansArabic-ExtraBold',
  ruqaa: 'Rakkas-Regular', brush: 'Alkalami-Regular', elegant: 'ElMessiri-Bold', classic: 'Amiri-Bold',
  stretched: 'ReemKufi-Bold', corporate: 'IBMPlexSansArabic-Bold', tech: 'Changa-ExtraBold',
  sans: 'thmanyahsans-Black', 'serif-display': 'thmanyahserifdisplay-Black', 'serif-text': 'thmanyahseriftext-Bold',
  combo: 'thmanyahserifdisplay-Black',
};
const SECONDARY_FONTS = { combo: 'thmanyahsans-Medium', sans: 'thmanyahsans-Medium' };

// Library fonts: the image tool names the file "...__lib-<feel>-n<execution id>.png" and picks
// feels[feel][execution id % length] as the headline font, so the same arithmetic here finds the font the design used.
const LIB = (() => { try { return JSON.parse(fs.readFileSync(require('path').join(__dirname, 'libfonts.json'), 'utf8')); } catch (e) { return null; } })();
function libFontOf(key) {
  const m = /^lib-([a-z-]+?)-n(\d+)$/.exec(String(key || ''));
  if (!m || !LIB || !LIB.feels[m[1]]) return null;
  const ids = LIB.feels[m[1]];
  const n = ids[Number(m[2]) % ids.length];
  const f = LIB.fonts[String(n)];
  return f ? { id: 'f' + String(n).padStart(4, '0'), ...f } : null;
}

const decode = (b64) => {
  const png = PNG.sync.read(Buffer.from(b64, 'base64'));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) };
};

// model outputs come back a few pixels larger (sizes must divide by 16): the whole picture is scaled, not padded,
// so resample it back to the design size (bilinear, premultiplied so transparent edges stay clean)
function fit(img, W, H) {
  if (!img) return null;
  if (img.width === W && img.height === H) return img;
  if (Math.abs(img.width - W) > 64 || Math.abs(img.height - H) > 64) return null;
  const sw = img.width, sh = img.height, src = img.data, out = new Uint8ClampedArray(W * H * 4);
  const sx = sw / W, sy = sh / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
      const p = [(y0 * sw + x0) * 4, (y0 * sw + x1) * 4, (y1 * sw + x0) * 4, (y1 * sw + x1) * 4], w = [(1 - wx) * (1 - wy), wx * (1 - wy), (1 - wx) * wy, wx * wy];
      let a = 0, r = 0, g = 0, b = 0;
      for (let k = 0; k < 4; k++) { const al = src[p[k] + 3] * w[k]; a += al; r += src[p[k]] * al; g += src[p[k] + 1] * al; b += src[p[k] + 2] * al; }
      const o = (y * W + x) * 4;
      if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
      out[o + 3] = a;
    }
  }
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

// The model sometimes redraws an element bigger/smaller or well away from where it sits in the design.
// Find the scale (about the cutout's centre) and shift that make it agree with the design, coarse to fine.
function refit(px, orig, W, H, wide) {
  const N = W * H, pts = [];
  let cx = 0, cy = 0, n = 0;
  for (let p = 0; p < N; p++) if (px[p * 4 + 3] === 255) { cx += p % W; cy += (p / W) | 0; n++; }
  if (n < 400) return null;
  cx /= n; cy /= n;
  const step = Math.max(1, Math.floor(n / (wide ? 2500 : 5000)));
  let k = 0;
  for (let p = 0; p < N; p++) if (px[p * 4 + 3] === 255 && k++ % step === 0) pts.push(p);
  const score = (s, dx, dy) => {
    let sum = 0, m = 0;
    for (const p of pts) {
      const x = Math.round(cx + ((p % W) - cx) * s + dx), y = Math.round(cy + (((p / W) | 0) - cy) * s + dy);
      if (x < 0 || y < 0 || x >= W || y >= H) { sum += 200; m++; continue; }
      const d = p * 4, o = (y * W + x) * 4;
      sum += Math.abs(px[d] - orig[o]) + Math.abs(px[d + 1] - orig[o + 1]) + Math.abs(px[d + 2] - orig[o + 2]); m++;
    }
    return sum / m;
  };
  const base = score(1, 0, 0);
  let best = { s: 1, dx: 0, dy: 0, score: base };
  const G = wide ? 4 : 8;
  for (const s of [1, 0.95, 0.9, 0.8, 0.7, 0.6, 0.54, 0.48, 0.42, 1.06, 1.12, 1.25]) {
    const R = wide ? 240 : s === 1 ? 60 : 160;
    for (let dy = -R; dy <= R; dy += G) for (let dx = -R; dx <= R; dx += G) {
      const v = score(s, dx, dy) * (s === 1 ? 1 : s >= 0.85 && s <= 1.15 ? 1.04 : 1.12);   // a rescale has to earn it
      if (v < best.score) best = { s, dx, dy, score: v };
    }
  }
  const c = { ...best };
  for (const s of [c.s - 0.04, c.s - 0.02, c.s, c.s + 0.02, c.s + 0.04]) {
    if (c.s === 1 && s !== 1) continue;
    for (let dy = c.dy - 7; dy <= c.dy + 7; dy++) for (let dx = c.dx - 7; dx <= c.dx + 7; dx++) {
      const v = score(s, dx, dy) * (s === 1 ? 1 : 1.12);
      if (v < best.score) best = { s, dx, dy, score: v };
    }
  }
  return { ...best, base, cx, cy };
}
function transform(px, W, H, f) {
  const out = new Uint8ClampedArray(px.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.round(f.cx + (x - f.dx - f.cx) / f.s), sy = Math.round(f.cy + (y - f.dy - f.cy) / f.s);
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
    const s = (sy * W + sx) * 4, d = (y * W + x) * 4;
    out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
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
    let al = align(cut.data, orig.data, W, H);
    let moved = al.score < al.base * 0.9 && (al.dx || al.dy);
    let px = moved ? shift(cut.data, W, H, al.dx, al.dy) : cut.data;
    let rescaled = null;
    let op = 0, any = 0; for (let p = 0; p < N; p++) { const q = cut.data[p * 4 + 3]; if (q) any++; if (q === 255) op++; }
    const rf = op > any * 0.6 ? refit(cut.data, orig.data, W, H) : null;
    if (rf && (rf.s !== 1 || Math.abs(rf.dx) > 26 || Math.abs(rf.dy) > 26) && rf.score < Math.min(rf.base, al.score) * 0.78) {
      // accept only when the element clearly did not match where it was and clearly matches after (flat or
      // translucent things such as a white sign or mist "match" anywhere, so they never qualify)
      const frac = (a) => { let ok = 0, n = 0; for (let p = 0; p < N; p += 3) { if (a[p * 4 + 3] !== 255) continue; n++; if (dist(a, orig.data, p * 4) < 60) ok++; } return n ? ok / n : 0; };
      const cand = transform(cut.data, W, H, rf), before = frac(px), after = frac(cand);
      const mild = rf.s >= 0.85 && rf.s <= 1.15;
      if (mild ? after >= before + 0.1 : before < 0.45 && after >= 0.5 && after >= before + 0.25) {
        px = cand; moved = true; rescaled = rf.s;
        al = { dx: rf.dx, dy: rf.dy, score: rf.score, base: rf.base };
      }
    }
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
    elems.push({ name: e.name, data: px, err, solid, matchPct, soft: !(op > any * 0.6), split: !!e.split, shadow: e.shadow !== false });
    report.push({ name: e.name, status: 'ok', coverPct: Math.round((solid * 1000) / N) / 10, matchesDesignPct: matchPct, moved: moved ? [al.dx, al.dy] : [0, 0], scale: rescaled || 1, fit: Math.round(al.score) });
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
  let ordered = elems.map((e, i) => ({ e, s: score[i], i })).sort((a, b) => a.s - b.s || a.i - b.i).map((o) => o.e);

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

  // ---- who shows where: every design pixel goes to the element really visible there; layers take the design's pixels ----
  let owner = null, worded = null, inkPath = false, textMask = null, liftMask = null;
  if (plate && elems.length) {
    try {
      const sc = ownScene(orig.data, plate.data, elems, W, H, boxBlur);
      owner = sc.owner;
      const blocked = new Uint8Array(N);
      for (const e of elems) if (e.soft) for (let p = 0; p < N; p++) if (e.data[p * 4 + 3] > 40) blocked[p] = 1;
      // the lettering straight from the design (the model's own copy of the letters is restyled and misplaced)
      if ((job.texts || []).length) {
        try {
          const extra = [];
          if (lettering) {
            const hist = new Map();
            for (let p = 0; p < N; p += 3) { const d = p * 4; if (lettering.data[d + 3] !== 255) continue; const k = ((lettering.data[d] >> 4) << 8) | ((lettering.data[d + 1] >> 4) << 4) | (lettering.data[d + 2] >> 4); hist.set(k, (hist.get(k) || 0) + 1); }
            for (const [k] of [...hist.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)) extra.push([((k >> 8) & 15) * 16 + 8, ((k >> 4) & 15) * 16 + 8, (k & 15) * 16 + 8]);
          }
          const ink = designInk(orig.data, plate.data, owner, job.texts, W, H, elems.length, boxBlur);
          if (ink) {
            let w = { lines: [], plates: [] };
            const hexc = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); const v = m ? parseInt(m[1], 16) : 0xffffff; return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
            const gcol = ink.groups.map((g) => hexc(g.texts[0].color));
            for (const [gi, g] of ink.groups.entries()) {
              const ras = new Uint8ClampedArray(N * 4);
              let ya = H, yb = 0;
              for (let p = 0; p < N; p++) if (g.strict[p]) { const d = p * 4; ras[d] = orig.data[d]; ras[d + 1] = orig.data[d + 1]; ras[d + 2] = orig.data[d + 2]; ras[d + 3] = 255; }
              const part = splitWords(ras, g.texts, W, H, null);
              if (!part || !part.lines.length) { w = null; break; }
              for (const ln of part.lines) { let top = H; for (const l of ln.layers) for (let p = 0; p < N; p++) if (l.data[p * 4 + 3]) { top = (p / W) | 0; break; } ln.top = top; for (const l of ln.layers) l.g = gi; w.lines.push(ln); }
            }
            if (w) w.lines.sort((x, y) => x.top - y.top);
            if (w && w.lines.length) {
              // letter bodies decided; now each word gets its soft edge and glow from the design
              const all = []; for (const ln of w.lines) for (const l of ln.layers) all.push(l);
              const zones = all.map((l) => { const m = new Float32Array(N); for (let p = 0; p < N; p++) m[p] = l.data[p * 4 + 3]; return boxBlur(m, W, H, 6); });
              const outs = all.map(() => new Uint8ClampedArray(N * 4));
              textMask = new Uint8Array(N);
              let lifted = false;
              for (let p = 0; p < N; p++) {
                if ((owner[p] >= 0 && !ink.onCarrier[p]) || ink.T[p] <= 26) continue;
                const d = p * 4;
                // a glow belongs to the line of its own colour, not to whichever word is nearest
                let pg = 0, pd = Infinity;
                for (let i = 0; i < gcol.length; i++) { const v = Math.abs(orig.data[d] - gcol[i][0]) + Math.abs(orig.data[d + 1] - gcol[i][1]) + Math.abs(orig.data[d + 2] - gcol[i][2]); if (v < pd) { pd = v; pg = i; } }
                let k = -1, bv = 8;
                for (let i = 0; i < zones.length; i++) if (all[i].g === pg && zones[i][p] > bv) { bv = zones[i][p]; k = i; }
                if (k < 0) continue;
                const o = outs[k];
                const a = all[k].data[d + 3] ? Math.max(150, Math.min(255, Math.round(((ink.T[p] - 40) * 255) / 50))) : Math.min(255, Math.round(((ink.T[p] - 20) * 255) / 60));
                o[d] = orig.data[d]; o[d + 1] = orig.data[d + 1]; o[d + 2] = orig.data[d + 2]; o[d + 3] = a;
                textMask[p] = 1; blocked[p] = 1; if (owner[p] >= 0) lifted = true;
              }
              all.forEach((l, i) => { l.data = outs[i]; });
              w.plates = [];
              worded = w; inkPath = true; liftMask = lifted ? textMask : null;
              const merged = new Uint8ClampedArray(N * 4);
              for (const l of all) for (let p = 0; p < N; p++) { const d = p * 4; if (l.data[d + 3] > merged[d + 3]) { merged[d] = l.data[d]; merged[d + 1] = l.data[d + 1]; merged[d + 2] = l.data[d + 2]; merged[d + 3] = l.data[d + 3]; } }
              lettering = { width: W, height: H, data: merged };
              report.push({ name: 'lettering from design', status: 'ok', lines: w.lines.length, inkPx: ink.count });
            }
          }
        } catch (err) { report.push({ name: 'lettering from design', status: 'failed', error: String(err && err.message) }); }
      }
      growOwners(owner, orig.data, plate.data, sc.bgE, elems, blocked, W, H, 40);
      const all2 = elems.concat(splitFronts(owner, elems, W, H, boxBlur));
      ordered = buildLayers(owner, orig.data, all2, W, H, report);
      for (const e of ordered) e.solid = e.own || e.solid;
      // letters lifted off a sign: the sign keeps its own colour where they were
      if (liftMask) {
        const hz = boxBlur(Float32Array.from(liftMask), W, H, 2);
        for (const e of ordered) {
          if (e.soft) continue;
          let on = 0; for (let p = 0; p < N; p++) if (liftMask[p] && owner[p] === e.idx) on++;
          if (on < 60) continue;
          const acc = [0, 1, 2].map((c) => { const f = new Float32Array(N); for (let p = 0; p < N; p++) if (owner[p] === e.idx && hz[p] === 0) f[p] = e.data[p * 4 + c]; return boxBlur(boxBlur(f, W, H, 14), W, H, 14); });
          const wgt = (() => { const f = new Float32Array(N); for (let p = 0; p < N; p++) if (owner[p] === e.idx && hz[p] === 0) f[p] = 1; return boxBlur(boxBlur(f, W, H, 14), W, H, 14); })();
          for (let p = 0; p < N; p++) if (hz[p] > 0 && owner[p] === e.idx && wgt[p] > 0.002) { const d = p * 4; e.data[d] = acc[0][p] / wgt[p]; e.data[d + 1] = acc[1][p] / wgt[p]; e.data[d + 2] = acc[2][p] / wgt[p]; }
          report.push({ name: e.name, status: 'text lifted off' });
        }
      }
      // smoke, mist, glows: the redraw only says where; colour and strength come from the design against the clean plate
      for (const e of ordered) {
        if (!e.soft) continue;
        const reach = (() => { const f = new Float32Array(N); for (let p = 0; p < N; p++) f[p] = e.data[p * 4 + 3] > 20 ? 1 : 0; return boxBlur(f, W, H, 8); })();
        const out = new Uint8ClampedArray(N * 4);
        let n = 0;
        for (let p = 0; p < N; p++) {
          if (reach[p] < 0.15 || owner[p] >= 0 || (textMask && textMask[p])) continue;
          const d = p * 4, t = dist(orig.data, plate.data, d);
          if (t < 14) continue;
          const a = Math.min(0.95, Math.max(e.data[d + 3] / 255, t / 160));
          for (let c = 0; c < 3; c++) out[d + c] = Math.max(0, Math.min(255, (orig.data[d + c] - (1 - a) * plate.data[d + c]) / a));
          out[d + 3] = Math.round(a * 255); n++;
        }
        if (n > 200) e.data = out;
      }
    } catch (err) { owner = null; report.push({ name: 'scene', status: 'failed', error: String(err && err.message) }); }
  }

  // ---- one shadow layer per element (needs the empty plate) ----
  let shadows = ordered.map(() => null);
  if (plate && ordered.length) {
    try {
      const covered = new Uint8ClampedArray(N);
      for (const e of ordered) for (let p = 0; p < N; p++) if (e.data[p * 4 + 3] > covered[p]) covered[p] = e.data[p * 4 + 3];
      if (lettering) for (let p = 0; p < N; p++) if (lettering.data[p * 4 + 3] > covered[p]) covered[p] = lettering.data[p * 4 + 3];
      shadows = extractShadows(orig.data, plate.data, ordered, covered, W, H, boxBlur);
      ordered.forEach((e, i) => { if (shadows[i]) report.push({ name: e.name + ' shadow', status: 'ok', coverPct: Math.round((shadows[i].n * 1000) / N) / 10 }); });
    } catch (err) { shadows = ordered.map(() => null); report.push({ name: 'shadows', status: 'failed', error: String(err && err.message) }); }
  }

  // ---- lettering split into words, put back where the design has it, drawn with the design's own pixels ----
  if (!inkPath && lettering && (job.texts || []).length) {
    try { const ec = new Uint8ClampedArray(N); for (const e of ordered) for (let p = 0; p < N; p++) if (e.data[p * 4 + 3] > ec[p]) ec[p] = e.data[p * 4 + 3]; worded = splitWords(lettering.data, job.texts, W, H, ec); } catch (err) { worded = null; }
  }
  if (!inkPath && worded && worded.lines.length) {
    // letters extracted alone come back bigger or shifted: put every line back where it sits in the design
    for (const ln of worded.lines) {
      try {
        const all = new Uint8ClampedArray(N * 4);
        for (const w of ln.layers) for (let p = 0; p < N; p++) { const d = p * 4; if (w.data[d + 3] > all[d + 3]) { all[d] = w.data[d]; all[d + 1] = w.data[d + 1]; all[d + 2] = w.data[d + 2]; all[d + 3] = w.data[d + 3]; } }
        const rf = refit(all, orig.data, W, H, true);
        if (!rf) continue;
        const frac = (a) => { let ok = 0, n = 0; for (let p = 0; p < N; p++) { if (a[p * 4 + 3] !== 255) continue; n++; if (dist(a, orig.data, p * 4) < 90) ok++; } return n ? ok / n : 0; };
        const before = frac(all), after = frac(transform(all, W, H, rf));
        report.push({ name: 'line ' + ln.name, status: 'ok', scale: rf.s, moved: [rf.dx, rf.dy], matchBefore: Math.round(before * 100), matchAfter: Math.round(after * 100) });
        if ((rf.s !== 1 || rf.dx || rf.dy) && after >= 0.5 && after >= before + 0.15) { for (const w of ln.layers) w.data = transform(w.data, W, H, rf); ln.fit = { s: rf.s, tx: rf.cx * (1 - rf.s) + rf.dx, ty: rf.cy * (1 - rf.s) + rf.dy }; }
        else if (before < 0.5) ln.unfit = true;
      } catch (err) { report.push({ name: 'line ' + ln.name, status: 'refit failed' }); }
    }
    // the model rescales the whole lettering as one picture: a line that could not be matched on its own
    // follows the lines that could
    {
      const fits = worded.lines.filter((l) => l.fit).map((l) => l.fit);
      if (fits.length && Math.max(...fits.map((f) => f.s)) - Math.min(...fits.map((f) => f.s)) < 0.07) {
        const avg = (k) => fits.reduce((a, f) => a + f[k], 0) / fits.length;
        const g = { s: avg('s'), cx: 0, cy: 0, dx: avg('tx'), dy: avg('ty') };
        for (const ln of worded.lines) if (ln.unfit) { for (const w of ln.layers) w.data = transform(w.data, W, H, g); ln.placed = true; report.push({ name: 'line ' + ln.name, status: 'placed with the other lines', scale: g.s }); }
      }
    }
    // The model restyles letters when it extracts them (outline, depth, size). The real letters are in the design:
    // wherever the design differs from "everything except the text" in the line's ink colour, that is the ink.
    if (plate) {
      try {
        const base = new Uint8ClampedArray(plate.data);
        const lay = (src) => { for (let p = 0; p < N; p++) { const d = p * 4, al = src[d + 3]; if (!al) continue; const ia = 255 - al; base[d] = (src[d] * al + base[d] * ia) / 255; base[d + 1] = (src[d + 1] * al + base[d + 1] * ia) / 255; base[d + 2] = (src[d + 2] * al + base[d + 2] * ia) / 255; } };
        for (const sh of shadows) if (sh) lay(sh.data);
        for (const e of ordered) lay(e.data);
        const T = new Float32Array(N);
        for (let p = 0; p < N; p++) T[p] = dist(orig.data, base, p * 4);
        for (const ln of worded.lines) {
          // the line's ink colour: the most common colour of its extracted letters
          const hist = new Map();
          for (const w of ln.layers) for (let p = 0; p < N; p += 2) { const d = p * 4; if (w.data[d + 3] !== 255) continue; const k = ((w.data[d] >> 4) << 8) | ((w.data[d + 1] >> 4) << 4) | (w.data[d + 2] >> 4); hist.set(k, (hist.get(k) || 0) + 1); }
          if (!hist.size) continue;
          const top = [...hist.entries()].sort((x, y) => y[1] - x[1])[0][0];
          const c = [((top >> 8) & 15) * 16 + 8, ((top >> 4) & 15) * 16 + 8, (top & 15) * 16 + 8];
          const near = (arr, d) => Math.abs(arr[d] - c[0]) + Math.abs(arr[d + 1] - c[1]) + Math.abs(arr[d + 2] - c[2]) < 150;
          const ink = new Uint8Array(N);
          for (let p = 0; p < N; p++) if (T[p] > 55 && near(orig.data, p * 4)) ink[p] = 1;
          // settle the line on its ink by shape (colour alone is ambiguous: red letters also "match" a red sign)
          const pts = [];
          for (const w of ln.layers) for (let p = 0; p < N; p += 2) if (w.data[p * 4 + 3] === 255 && near(w.data, p * 4)) pts.push(p);
          if (pts.length < 40) continue;
          const R = ln.fit ? 12 : 90;
          let bx = 0, by = 0, bs = -1;
          for (let dy = -R; dy <= R; dy += 2) for (let dx = -R; dx <= R; dx += 2) {
            let hit = 0;
            for (let k = 0; k < pts.length; k += 2) { const p = pts[k], x = (p % W) + dx, y = ((p / W) | 0) + dy; if (x >= 0 && y >= 0 && x < W && y < H && ink[y * W + x]) hit++; }
            if (hit > bs) { bs = hit; bx = dx; by = dy; }
          }
          const cover = bs / (pts.length / 2);
          if (cover < 0.28) {
            // the letters are not "missing" from the other layers: an element (a sign) still carries them.
            // Take the real letters from the design under the placed shapes, and blank the sign beneath them.
            const zs = ln.layers.map((w) => { const m = new Float32Array(N); for (let p = 0; p < N; p++) m[p] = w.data[p * 4 + 3]; return boxBlur(m, W, H, 6); });
            const os = ln.layers.map(() => new Uint8ClampedArray(N * 4));
            const hole = new Uint8Array(N);
            let got = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
            for (let p = 0; p < N; p++) {
              let k = -1, bv = 12;
              for (let i = 0; i < zs.length; i++) if (zs[i][p] > bv) { bv = zs[i][p]; k = i; }
              if (k < 0) continue;
              const d = p * 4, cdist = Math.abs(orig.data[d] - c[0]) + Math.abs(orig.data[d + 1] - c[1]) + Math.abs(orig.data[d + 2] - c[2]);
              if (cdist >= 150) continue;
              const o = os[k];
              o[d] = orig.data[d]; o[d + 1] = orig.data[d + 1]; o[d + 2] = orig.data[d + 2]; o[d + 3] = Math.max(0, Math.min(255, Math.round(((150 - cdist) * 255) / 70)));
              hole[p] = 1; got++;
              const x = p % W, y = (p / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
            if (got < pts.length * 0.5) { report.push({ name: 'line ' + ln.name + ' ink', status: 'not found in the design', cover: Math.round(cover * 100) }); continue; }
            ln.layers.forEach((w, i) => { w.data = os[i]; });
            // blank the carrier under the letters with its own colour around them
            const hz = boxBlur(Float32Array.from(hole), W, H, 3);
            for (const e of ordered) {
              let on = 0; for (let p = 0; p < N; p += 3) if (hole[p] && e.data[p * 4 + 3] === 255) on += 3;
              if (on < got * 0.5) continue;
              const samp = [];
              for (let y = Math.max(0, y0 - 16); y <= Math.min(H - 1, y1 + 16); y += 2) for (let x = Math.max(0, x0 - 16); x <= Math.min(W - 1, x1 + 16); x += 2) { const p = y * W + x; if (e.data[p * 4 + 3] === 255 && hz[p] === 0) samp.push(p * 4); }
              if (samp.length < 30) continue;
              const med = (ch) => samp.map((d) => e.data[d + ch]).sort((u, v) => u - v)[samp.length >> 1];
              const fill = [med(0), med(1), med(2)];
              for (let p = 0; p < N; p++) if (hz[p] > 0 && e.data[p * 4 + 3]) { const d = p * 4; e.data[d] = fill[0]; e.data[d + 1] = fill[1]; e.data[d + 2] = fill[2]; }
              report.push({ name: e.name, status: 'text lifted off', line: ln.name });
            }
            report.push({ name: 'line ' + ln.name + ' ink', status: 'ok', from: 'carrier element' });
            continue;
          }
          if (bx || by) for (const w of ln.layers) w.data = shift(w.data, W, H, bx, by);
          // every ink pixel goes to the word whose placed shape is nearest
          const zones = ln.layers.map((w) => { const m = new Float32Array(N); for (let p = 0; p < N; p++) m[p] = w.data[p * 4 + 3]; return boxBlur(m, W, H, 7); });
          const outs = ln.layers.map(() => new Uint8ClampedArray(N * 4));
          for (let p = 0; p < N; p++) {
            if (!ink[p]) continue;
            let k = -1, bv = 10;
            for (let i = 0; i < zones.length; i++) if (zones[i][p] > bv) { bv = zones[i][p]; k = i; }
            if (k < 0) continue;
            const d = p * 4, o = outs[k];
            o[d] = orig.data[d]; o[d + 1] = orig.data[d + 1]; o[d + 2] = orig.data[d + 2]; o[d + 3] = Math.max(0, Math.min(255, Math.round(((T[p] - 40) * 255) / 50)));
          }
          ln.layers.forEach((w, i) => { w.data = outs[i]; });
          report.push({ name: 'line ' + ln.name + ' ink', status: 'ok', cover: Math.round(cover * 100), nudge: [bx, by] });
        }
      } catch (err) { report.push({ name: 'ink', status: 'failed', error: String(err && err.message) }); }
    }
    // what the other layers see as "the lettering" from here on is the placed words
    const merged = new Uint8ClampedArray(N * 4);
    for (const ln of worded.lines) for (const w of ln.layers) for (let p = 0; p < N; p++) { const d = p * 4; if (w.data[d + 3] > merged[d + 3]) { merged[d] = w.data[d]; merged[d + 1] = w.data[d + 1]; merged[d + 2] = w.data[d + 2]; merged[d + 3] = w.data[d + 3]; } }
    lettering.data = merged;
  }

  // ---- the background keeps the design's own pixels wherever nothing else is; the redrawn plate only fills behind things ----
  if (plate && owner) {
    const taken = new Uint8Array(N);
    for (const e of ordered) for (let p = 0; p < N; p++) if (e.data[p * 4 + 3]) taken[p] = 1;
    for (const sh of shadows) if (sh) for (let p = 0; p < N; p++) if (sh.data[p * 4 + 3]) taken[p] = 1;
    if (lettering) for (let p = 0; p < N; p++) if (lettering.data[p * 4 + 3]) taken[p] = 1;
    // a glow fades out past the letters: keep the clean plate there, or a ghost of the title stays in the background
    if (textMask) { const halo = boxBlur(Float32Array.from(textMask), W, H, 14); for (let p = 0; p < N; p++) if (halo[p] > 0.004) taken[p] = 1; }
    for (let p = 0; p < N; p++) { if (taken[p]) continue; const d = p * 4; plate.data[d] = orig.data[d]; plate.data[d + 1] = orig.data[d + 1]; plate.data[d + 2] = orig.data[d + 2]; }
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
    for (const sh of shadows) if (sh) over(sh.data);
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
  // every element: its own layer; with a shadow or loose pieces it becomes a group (shadow at the bottom of the group)
  const full = (data) => ({ width: W, height: H, data });
  const elemLayers = [];
  ordered.forEach((e, i) => {
    const inner = [];
    if (shadows[i]) { const l = pixelLayer(e.name + ' shadow', full(shadows[i].data)); if (l) inner.push(l); }
    let pieces = [];
    if (e.split) { try { pieces = splitPieces(e.data, W, H); } catch (err) { pieces = []; } }
    if (pieces.length >= 2) {
      pieces.forEach((d, k) => { const l = pixelLayer(e.name + ' ' + (k + 1), full(d)); if (l) inner.push(l); });
      report.push({ name: e.name + ' pieces', status: 'ok', count: pieces.length });
    } else { const l = pixelLayer(e.name, full(e.data)); if (l) inner.push(l); }
    if (inner.length > 1) elemLayers.push({ name: e.name, opened: false, children: inner });
    else if (inner.length) elemLayers.push(inner[0]);
  });
  if (elemLayers.length) children.push({ name: 'Elements', opened: true, children: elemLayers });
  if (rest) { const l = pixelLayer('Graphics and details', rest); if (l) children.push(l); }

  const fontKey = String(job.font || 'combo');
  const libFont = libFontOf(fontKey);
  const headFont = (libFont && libFont.ps) || FONTS[fontKey] || FONTS.combo;
  const bodyFont = libFont ? headFont : SECONDARY_FONTS[fontKey] || headFont;
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
  // the lettering exactly as designed, one layer per word, one group per line
  const textGroup = [];
  if (worded && worded.lines.length) {
    for (const pl of worded.plates) { const l = pixelLayer(pl.name, full(pl.data)); if (l) textGroup.push(l); }
    for (const ln of worded.lines.slice().reverse()) {
      const ls = ln.layers.map((w) => pixelLayer(w.name, full(w.data))).filter(Boolean);
      if (ls.length > 1) textGroup.push({ name: ln.name, opened: false, children: ls });
      else if (ls.length) textGroup.push(ls[0]);
    }
    report.push({ name: 'words', status: 'ok', count: worded.lines.reduce((n, l) => n + l.layers.length, 0) });
  } else if (lettering) { const l = pixelLayer('Lettering (as designed)', lettering); if (l) textGroup.push(l); }
  if (job.live_text && liveText.length) textGroup.unshift({ name: 'Editable text', hidden: true, opened: false, children: liveText.reverse() });
  if (textGroup.length) children.push({ name: 'Text', opened: true, children: textGroup });
  if (!plate) children[0].hidden = false;

  const psd = { width: W, height: H, children, imageData: orig };
  const buffer = writePsdBuffer(psd, { invalidateTextLayers: true, generateThumbnail: false, noBackground: true });
  const parts = { W, H, orig, plate, elems: ordered.map((e) => ({ name: e.name, data: e.data, solid: e.solid })), lettering, rest, texts: job.texts || [], font: fontKey };
  report.push({ name: 'font', status: 'ok', key: fontKey, ps: headFont, family: libFont ? libFont.family : null, file: libFont ? libFont.file : null });
  return { buffer, report, width: W, height: H, parts, tree: children, layers: children.map((c) => c.name + (c.children ? ' [' + c.children.length + ']' : '')) };
}

if (require.main === module) {
  const [, , jobPath, outPath] = process.argv;
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  const r = build(job);
  fs.writeFileSync(outPath, r.buffer);
  console.log(JSON.stringify({ bytes: r.buffer.length, width: r.width, height: r.height, layers: r.layers, report: r.report }, null, 1));
}
module.exports = { build, trim, libFontOf };
