// Finer layers for the PSD: one layer per loose piece (ice cubes, leaves), one shadow layer per element,
// and one layer per word of the lettering. Everything works on full-canvas RGBA arrays (W*H*4).

// 8-connected components of the pixels where keep(p) is true. Returns labels (0 = none) and per-label stats.
function components(W, H, keep) {
  const N = W * H, lab = new Int32Array(N), stack = new Int32Array(N), stats = [null];
  let n = 0;
  for (let s = 0; s < N; s++) {
    if (lab[s] || !keep(s)) continue;
    n++;
    let top = 0, area = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, sx = 0, sy = 0;
    stack[top++] = s; lab[s] = n;
    while (top) {
      const p = stack[--top], x = p % W, y = (p / W) | 0;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (!lab[q] && keep(q)) { lab[q] = n; stack[top++] = q; }
        }
      }
    }
    stats.push({ id: n, area, x0, y0, x1, y1, cx: sx / area, cy: sy / area });
  }
  return { lab, stats };
}

// soft edge pixels (alpha below the cut used for labelling) join the nearest labelled pixel
function growLabels(lab, W, H, alpha, passes) {
  for (let it = 0; it < passes; it++) {
    let changed = 0;
    const next = new Int32Array(lab);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (lab[p] || !alpha(p)) continue;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= W * H) continue;
        if (lab[q]) { next[p] = lab[q]; changed++; break; }
      }
    }
    lab.set(next);
    if (!changed) break;
  }
}

const layerFrom = (src, lab, ids, W, H) => {
  const set = new Set(ids), out = new Uint8ClampedArray(W * H * 4);
  let n = 0;
  for (let p = 0; p < W * H; p++) {
    if (!set.has(lab[p])) continue;
    const d = p * 4;
    out[d] = src[d]; out[d + 1] = src[d + 1]; out[d + 2] = src[d + 2]; out[d + 3] = src[d + 3]; n++;
  }
  return n ? out : null;
};

// one layer per separate piece of a cluster element (ice cubes, mint leaves, lemon slices...)
function splitPieces(px, W, H) {
  const N = W * H;
  const { lab, stats } = components(W, H, (p) => px[p * 4 + 3] > 90);
  const real = stats.filter(Boolean);
  if (!real.length) return [];
  const biggest = Math.max(...real.map((s) => s.area));
  const minArea = Math.max(120, biggest * 0.04, N * 0.00008);
  const keep = real.filter((s) => s.area >= minArea);
  if (keep.length < 2) return [];
  // crumbs (specks, drops of the same piece) go to the nearest kept piece
  const remap = new Int32Array(stats.length);
  for (const s of keep) remap[s.id] = s.id;
  for (const s of real) {
    if (remap[s.id]) continue;
    let best = keep[0], bd = Infinity;
    for (const k of keep) { const d = (k.cx - s.cx) ** 2 + (k.cy - s.cy) ** 2; if (d < bd) { bd = d; best = k; } }
    remap[s.id] = best.id;
  }
  for (let p = 0; p < N; p++) if (lab[p]) lab[p] = remap[lab[p]];
  growLabels(lab, W, H, (p) => px[p * 4 + 3] > 0, 6);
  // reading order: top to bottom, then right to left
  keep.sort((a, b) => (Math.abs(a.cy - b.cy) > 40 ? a.cy - b.cy : b.cx - a.cx));
  return keep.slice(0, 40).map((s) => layerFrom(px, lab, [s.id], W, H)).filter(Boolean);
}

// Shadows: the empty plate has no shadows, the design has them. Where the design is darker than the plate
// (same hue), next to an element and not covered by any layer, that darkening is the element's shadow.
// The layer stores colour + alpha so that layer-over-plate reproduces the design exactly.
function extractShadows(orig, plate, elems, covered, W, H, boxBlur) {
  const N = W * H, lum = (a, d) => 0.299 * a[d] + 0.587 * a[d + 1] + 0.114 * a[d + 2];
  const dark = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    if (covered[p] > 40) continue;
    const d = p * 4, lo = lum(orig, d), lp = lum(plate, d);
    if (lp < 18) continue;
    const r = lo / lp;
    if (r > 0.93) continue;
    // a shadow keeps the hue: compare the colour directions
    const a = [orig[d], orig[d + 1], orig[d + 2]], b = [plate[d], plate[d + 1], plate[d + 2]];
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2], na = Math.hypot(...a) || 1, nb = Math.hypot(...b) || 1;
    if (dot / (na * nb) < 0.965) continue;
    dark[p] = 1 - r;
  }
  const soft = boxBlur(dark, W, H, 2);
  // which element owns a dark pixel: the one whose (blurred) silhouette reaches it most
  const reach = elems.map((e) => {
    const a = new Float32Array(N);
    for (let p = 0; p < N; p++) a[p] = e.data[p * 4 + 3] / 255;
    const R = Math.max(10, Math.min(120, Math.round(Math.sqrt(e.solid) * 0.35)));
    return boxBlur(boxBlur(a, W, H, R), W, H, R);
  });
  const owner = new Int16Array(N).fill(-1);
  for (let p = 0; p < N; p++) {
    if (soft[p] < 0.05 || dark[p] === 0) continue;
    let best = -1, bv = 0.004;
    for (let i = 0; i < elems.length; i++) if (elems[i].shadow !== false && reach[i][p] > bv) { bv = reach[i][p]; best = i; }
    owner[p] = best;
  }
  return elems.map((e, i) => {
    const out = new Uint8ClampedArray(N * 4);
    let n = 0;
    for (let p = 0; p < N; p++) {
      if (owner[p] !== i) continue;
      const d = p * 4, a = Math.min(0.92, Math.max(dark[p], soft[p] * 0.8));
      if (a < 0.04) continue;
      for (let c = 0; c < 3; c++) out[d + c] = Math.max(0, Math.min(255, (orig[d + c] - (1 - a) * plate[d + c]) / a));
      out[d + 3] = Math.round(a * 255); n++;
    }
    if (n < Math.max(250, e.solid * 0.03)) return null;
    // the plate is a redraw, so tiny texture differences look like specks of shadow: keep only real patches
    const cc = components(W, H, (p) => out[p * 4 + 3] > 0);
    const big = Math.max(...cc.stats.filter(Boolean).map((s) => s.area));
    const drop = new Set(cc.stats.filter((s) => s && s.area < Math.max(350, big * 0.04)).map((s) => s.id));
    let kept = 0;
    for (let p = 0; p < N; p++) { if (!out[p * 4 + 3]) continue; if (drop.has(cc.lab[p])) out[p * 4 + 3] = 0; else kept++; }
    return kept > Math.max(250, e.solid * 0.03) ? { data: out, n: kept } : null;
  });
}

// Where to cut a row into the words the text says it has. Tight type has letter gaps as wide as word spaces, so gap
// width alone is not enough: pick the cuts whose word widths best match the expected widths (by letters), with a
// preference for real empty gaps. Candidates are valleys of the column ink profile, left to right; words read right to left.
function bestCuts(cands, x0, x1, words, rh) {
  const wide = 'سشصضطظمهةثتبكفقغعخحجي', narrow = 'ال!.،:ـ1|إأآ';
  const wOf = (w) => [...w].reduce((n, ch) => n + (/[ً-ْٰ]/.test(ch) ? 0 : narrow.includes(ch) ? 0.45 : wide.includes(ch) ? 1.25 : 0.8), 0) || 1;
  const exp = words.map(wOf).reverse();
  const tot = exp.reduce((a, b) => a + b, 0), span = Math.max(1, x1 - x0), k = words.length;
  if (cands.length > 24) cands = cands.slice().sort((a, b) => b.g - a.g).slice(0, 24).sort((a, b) => a.x - b.x);
  let best = null, bc = Infinity;
  const pick = (start, chosen) => {
    if (chosen.length === k - 1) {
      let cost = 0, left = x0;
      for (let i = 0; i < k; i++) {
        const right = i < k - 1 ? cands[chosen[i]].x : x1;
        cost += ((right - left) / span - exp[i] / tot) ** 2;
        if (i < k - 1) { const c = cands[chosen[i]]; cost -= 0.02 * Math.min(1, c.g / (rh * 0.3)); cost += 0.01 * Math.min(1, c.min / (rh * 0.16)); left = right; }
      }
      if (cost < bc) { bc = cost; best = chosen.map((i) => cands[i].x); }
      return;
    }
    for (let i = start; i < cands.length; i++) { chosen.push(i); pick(i + 1, chosen); chosen.pop(); }
  };
  pick(0, []);
  return best || [];
}

// Lettering split into words, without trusting pixel boxes from the vision step (they are often 50-100px off).
// 1) Each connected blob of the lettering raster is either a plate with letters on it (sign, pill, ribbon: it fills
//    its bounding box) or bare glyphs. On a plate, ink = pixels far from the plate colour and close to a letter colour.
// 2) Ink pieces are grouped into rows (lines) by vertical bands, then into words by the widest horizontal gaps;
//    the number of words per line and their names come from the text the vision step read (that part is reliable).
function splitWords(lettering, lines, W, H, elemCover) {
  const N = W * H, px = lettering;
  const hex = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); const n = m ? parseInt(m[1], 16) : 0xffffff; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const want = (lines || []).map((ln) => ({ text: String(ln.text || '').trim(), y: Number(ln.y) || 0, color: hex(ln.color), words: String(ln.text || '').trim().split(/\s+/).filter(Boolean) })).filter((l) => l.words.length);
  if (!want.length) return null;
  const cd = (d, c) => Math.abs(px[d] - c[0]) + Math.abs(px[d + 1] - c[1]) + Math.abs(px[d + 2] - c[2]);
  // the lettering raster holds bare letters (plates and pills behind text are separate element layers)
  const blobs = { lab: new Int32Array(N), stats: [null] };
  const ink = new Uint8Array(N);
  const plates = [];
  for (let p = 0; p < N; p++) if (px[p * 4 + 3] > 50) ink[p] = 1;
  {
    // a plate that slipped through (one piece filling a big box) cannot be split into words: give up, keep one layer
    const cc = components(W, H, (p) => ink[p] === 1);
    for (const s of cc.stats) if (s && s.area > 12000 && s.area > (s.x1 - s.x0 + 1) * (s.y1 - s.y0 + 1) * 0.72) return null;
  }
  // ink pieces; drop plate rims and specks
  const pieces = components(W, H, (p) => ink[p] === 1);
  growLabels(pieces.lab, W, H, (p) => px[p * 4 + 3] > 0, 5);
  const maxH = Math.max(1, ...pieces.stats.filter(Boolean).map((s) => s.y1 - s.y0 + 1));
  let comps = pieces.stats.filter((s) => {
    if (!s || s.area < 12) return false;
    const pl = plates.find((P) => blobs.lab[Math.round(s.cy) * W + Math.round(s.cx)] === P.s.id || (s.x0 >= P.s.x0 && s.x1 <= P.s.x1 && s.y0 >= P.s.y0 && s.y1 <= P.s.y1));
    if (pl) {
      const bw = pl.s.x1 - pl.s.x0 + 1, bh = pl.s.y1 - pl.s.y0 + 1, w = s.x1 - s.x0 + 1, h = s.y1 - s.y0 + 1;
      if (w > bw * 0.9 || h > bh * 0.9) return false;                       // the rim of the plate
      if (w > bw * 0.6 && s.area < w * h * 0.12) return false;              // a border line
    }
    return true;
  });
  if (!comps.length) return null;
  // rows: bodies first (tall pieces), then marks (dots, hamzas) join the row whose band they touch or sit closest to
  comps.sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0));
  const rows = [];
  for (const c of comps) {
    const h = c.y1 - c.y0 + 1;
    let best = null, bo = 0;
    for (const r of rows) { const o = Math.min(r.y1, c.y1) - Math.max(r.y0, c.y0) + 1; if (o > bo) { bo = o; best = r; } }
    if (best && bo >= Math.min(h, best.y1 - best.y0 + 1) * 0.35) { best.items.push(c); if (h > (best.y1 - best.y0 + 1) * 0.5) { best.y0 = Math.min(best.y0, c.y0); best.y1 = Math.max(best.y1, c.y1); } continue; }
    if (h >= maxH * 0.22 && c.area >= 60) { rows.push({ y0: c.y0, y1: c.y1, items: [c] }); continue; }
    c.loose = true;
  }
  for (const c of comps.filter((x) => x.loose)) {
    let best = null, bd = Infinity;
    for (const r of rows) {
      const rh = r.y1 - r.y0 + 1, dy = Math.max(r.y0 - c.cy, 0, c.cy - r.y1);
      const rx0 = Math.min(...r.items.map((i) => i.x0)), rx1 = Math.max(...r.items.map((i) => i.x1));
      if (dy > rh * 0.6 || c.cx < rx0 - rh * 0.3 || c.cx > rx1 + rh * 0.3) continue;
      if (dy < bd) { bd = dy; best = r; }
    }
    if (best) best.items.push(c);
  }
  rows.sort((a, b) => a.y0 - b.y0);
  const named = rows.length === want.length ? want.slice().sort((a, b) => a.y - b.y) : null;
  const out = [];
  const usedIds = new Set();
  const wordLab = new Int32Array(N);
  let wid = 0;
  rows.forEach((r, ri) => {
    const rh = r.y1 - r.y0 + 1, ids = new Set(r.items.map((c) => c.id));
    const x0 = Math.min(...r.items.map((c) => c.x0)), x1 = Math.max(...r.items.map((c) => c.x1));
    const ya = Math.min(...r.items.map((c) => c.y0)), yb = Math.max(...r.items.map((c) => c.y1));
    // ink per column: word spaces are empty columns, touching words still leave a valley
    const prof = new Float32Array(x1 - x0 + 1);
    for (let y = ya; y <= yb; y++) for (let x = x0; x <= x1; x++) if (ids.has(pieces.lab[y * W + x])) prof[x - x0]++;
    const thr = rh * 0.16, cands = [];
    for (let i = 1; i < prof.length - 1; i++) {
      if (prof[i] > thr) continue;
      let j = i, zero = 0, mn = Infinity;
      while (j < prof.length - 1 && prof[j] <= thr) { if (prof[j] === 0) zero++; if (prof[j] < mn) mn = prof[j]; j++; }
      cands.push({ x: x0 + (i + j - 1) / 2, g: zero, min: mn });
      i = j;
    }
    const k = named ? named[ri].words.length : 0;
    let cuts;
    if (k > 1 && cands.length >= k - 1) cuts = bestCuts(cands, x0, x1, named[ri].words, rh);
    else if (k === 1) cuts = [];
    else cuts = cands.filter((c) => c.g > rh * 0.3).map((c) => c.x);
    cuts.sort((p, q) => p - q);
    const nW = cuts.length + 1, base = wid; wid += nW;
    const idxOf = (x) => { let n = 0; for (const c of cuts) if (x > c) n++; return n; };
    for (const c of r.items) {
      usedIds.add(c.id);
      const straddles = cuts.some((cx) => c.x0 < cx - rh * 0.2 && c.x1 > cx + rh * 0.2);
      const whole = straddles ? -1 : idxOf(c.cx);
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) { const p = y * W + x; if (pieces.lab[p] === c.id) wordLab[p] = base + 1 + (whole >= 0 ? whole : idxOf(x)); }
    }
    const layers = [];
    for (let wi = 0; wi < nW; wi++) {                                       // wi = 0 is the leftmost word
      const d = layerFrom(px, wordLab, [base + 1 + wi], W, H);
      const name = named && named[ri].words.length === nW ? named[ri].words[nW - 1 - wi] : 'word ' + (nW - wi);
      if (d) layers.push({ name, data: d });
    }
    if (layers.length) out.push({ name: named ? named[ri].text.slice(0, 40) : 'line ' + (ri + 1), layers });
  });
  // plates: kept in the text group only when no element layer already holds that plate
  const extra = [];
  for (const P of plates) {
    const s = P.s; let cov = 0;
    if (elemCover) for (let y = s.y0; y <= s.y1; y += 2) for (let x = s.x0; x <= s.x1; x += 2) { const p = y * W + x; if (blobs.lab[p] === s.id && elemCover[p] > 128) cov += 4; }
    if (cov > s.area * 0.6) continue;
    const d = new Uint8ClampedArray(N * 4);
    for (let y = s.y0; y <= s.y1; y++) for (let x = s.x0; x <= s.x1; x++) {
      const p = y * W + x; if (blobs.lab[p] !== s.id) continue;
      const q = p * 4;
      if (usedIds.has(pieces.lab[p])) { d[q] = P.pc[0]; d[q + 1] = P.pc[1]; d[q + 2] = P.pc[2]; d[q + 3] = 255; }
      else { d[q] = px[q]; d[q + 1] = px[q + 1]; d[q + 2] = px[q + 2]; d[q + 3] = px[q + 3]; }
    }
    extra.push({ name: 'text plate', data: d, y: s.y0 });
  }
  return { lines: out, plates: extra };
}

module.exports = { components, splitPieces, extractShadows, splitWords };
