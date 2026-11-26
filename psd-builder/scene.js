// Scene ownership: the image model REDRAWS every element it is asked to isolate (other pose, other contents, other
// place), so its cutouts cannot be the layers. They are only a guide. Here every pixel of the design is given to the
// element that really shows there, and each layer is built from the design's own pixels; the model's redraw is kept
// only for the parts hidden behind another element.
const { components } = require('./split');

const d3 = (a, b, d) => Math.abs(a[d] - b[d]) + Math.abs(a[d + 1] - b[d + 1]) + Math.abs(a[d + 2] - b[d + 2]);
const lum = (a, d) => 0.299 * a[d] + 0.587 * a[d + 1] + 0.114 * a[d + 2];

// darker than the empty plate with the same hue = a shadow, not an object
function shadowLike(orig, plate, d) {
  const lo = lum(orig, d), lp = lum(plate, d);
  if (lp < 18 || lo / lp > 0.93) return false;
  const dot = orig[d] * plate[d] + orig[d + 1] * plate[d + 1] + orig[d + 2] * plate[d + 2];
  const na = Math.hypot(orig[d], orig[d + 1], orig[d + 2]) || 1, nb = Math.hypot(plate[d], plate[d + 1], plate[d + 2]) || 1;
  return dot / (na * nb) >= 0.965;
}

// owner[p] = index of the element visible at p, or -1 (background / nothing)
function ownScene(orig, plate, elems, W, H, boxBlur) {
  const N = W * H;
  const bg = new Float32Array(N);
  for (let p = 0; p < N; p++) bg[p] = d3(orig, plate, p * 4);
  const bgE = boxBlur(bg, W, H, 2), bgW = boxBlur(bg, W, H, 9);
  const errB = elems.map((e) => {
    if (e.soft) return null;
    const f = new Float32Array(N);
    for (let p = 0; p < N; p++) f[p] = e.data[p * 4 + 3] >= 128 ? e.err[p] : 200;
    return boxBlur(f, W, H, 2);
  });
  const errW = errB.map((f) => (f ? boxBlur(f, W, H, 4) : null));
  let owner = new Int16Array(N).fill(-1);
  const cand = new Int16Array(N).fill(-1);
  for (let p = 0; p < N; p++) {
    let best = -1, bv = Infinity;
    for (let i = 0; i < elems.length; i++) if (errB[i] && elems[i].data[p * 4 + 3] >= 128 && errB[i][p] < bv) { bv = errB[i][p]; best = i; }
    if (best < 0) continue;
    cand[p] = best;
    // the redraw covers this spot but the design shows the empty background there: the element is not there
    // (judged up close and from further back: fur on a ground of the same colour must not fall out of the cat)
    if (bv > 45 && bgE[p] + 14 < bv && bgW[p] + 10 < errW[best][p]) continue;
    owner[p] = best;
  }
  // majority smoothing: no salt-and-pepper ownership
  {
    const sm = elems.map((e, i) => { if (!errB[i]) return null; const m = new Float32Array(N); for (let p = 0; p < N; p++) if (owner[p] === i) m[p] = 1; return boxBlur(m, W, H, 2); });
    const next = new Int16Array(N).fill(-1);
    for (let p = 0; p < N; p++) {
      let best = -1, bv = 0, tot = 0;
      for (let i = 0; i < elems.length; i++) { if (!sm[i]) continue; const v = sm[i][p]; tot += v; if (elems[i].data[p * 4 + 3] >= 128 && v > bv) { bv = v; best = i; } }
      if (best >= 0 && bv >= (1 - tot) * 0.9) next[p] = best;
    }
    owner = next;
  }
  // small "background" holes inside an element (a highlight, a slice of garnish the redraw lacks) belong to it
  {
    const cnt = new Int32Array(elems.length);
    for (let p = 0; p < N; p++) if (owner[p] >= 0) cnt[owner[p]]++;
    const cc = components(W, H, (p) => owner[p] === -1 && cand[p] >= 0);
    for (let p = 0; p < N; p++) {
      if (owner[p] !== -1 || cand[p] < 0) continue;
      const st = cc.stats[cc.lab[p]];
      if (st && st.area < Math.max(400, cnt[cand[p]] * 0.06)) owner[p] = cand[p];
    }
  }
  return { owner, bgE };
}

// parts of an element the redraw missed (other pose): design pixels that are neither background nor shadow nor text
// and touch the element join it
function growOwners(owner, orig, plate, bgE, elems, blocked, W, H, steps) {
  const N = W * H;
  const free = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    if (owner[p] !== -1 || blocked[p] || bgE[p] < 60) continue;
    let cov = false;
    for (const e of elems) if (e.data[p * 4 + 3] >= 128) { cov = true; break; }
    if (cov || shadowLike(orig, plate, p * 4)) continue;
    free[p] = 1;
  }
  let front = [];
  for (let p = 0; p < N; p++) if (owner[p] >= 0) front.push(p);
  for (let s = 0; s < steps && front.length; s++) {
    const nx = [];
    for (const p of front) {
      const x = p % W, o = owner[p];
      if (x > 0 && free[p - 1]) { free[p - 1] = 0; owner[p - 1] = o; nx.push(p - 1); }
      if (x < W - 1 && free[p + 1]) { free[p + 1] = 0; owner[p + 1] = o; nx.push(p + 1); }
      if (p >= W && free[p - W]) { free[p - W] = 0; owner[p - W] = o; nx.push(p - W); }
      if (p < N - W && free[p + W]) { free[p + W] = 0; owner[p + W] = o; nx.push(p + W); }
    }
    front = nx;
  }
}

// A thing that goes round another (fingers round a glass) is behind it AND in front of it. One layer cannot do both,
// so the part that shows over the other element becomes its own "front part" layer above it; both stay whole.
function splitFronts(owner, elems, W, H, boxBlur) {
  const N = W * H, n = elems.length;
  const own = new Int32Array(n), under = elems.map(() => new Int32Array(n));
  for (let p = 0; p < N; p++) {
    const o = owner[p]; if (o < 0) continue;
    own[o]++;
    for (let i = 0; i < n; i++) if (i !== o && !elems[i].soft && elems[i].data[p * 4 + 3] >= 128) under[i][o]++;
  }
  const added = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (elems[i].soft || elems[j].soft) continue;
    const a = under[i][j], b = under[j][i];                    // b: i shows where j's body also lies
    if (a < 40 || b < 300 || Math.min(a, b) <= Math.max(a, b) * 0.2) continue;
    if (b > own[j] * 0.3 || b > own[i] * 0.6) continue;
    const m = new Float32Array(N);
    for (let p = 0; p < N; p++) if (owner[p] === i && elems[j].data[p * 4 + 3] >= 128) m[p] = 1;
    const core = boxBlur(m, W, H, 5);
    let thick = 0; for (let p = 0; p < N; p++) if (core[p] > 0.95) thick++;
    if (thick < 300 || thick < b * 0.15) continue;             // a thin rim is the redraw being a size off, not a part in front
    const k = n + added.length;
    for (let p = 0; p < N; p++) if (m[p]) owner[p] = k;
    added.push({ name: elems[i].name + ' (front part)', data: new Uint8ClampedArray(N * 4), err: null, solid: b, soft: false, split: false, shadow: false });
  }
  return added;
}

// Layers from ownership. Returns the elements bottom to top, each { ...e, data, own } (elements the design does not show are dropped).
function buildLayers(owner, orig, elems, W, H, report) {
  const N = W * H, n = elems.length;
  const under = elems.map(() => new Int32Array(n));
  const out = [];
  elems.forEach((e, i) => {
    if (e.soft) { out.push({ e, i, data: e.data, own: e.solid }); return; }
    const data = new Uint8ClampedArray(N * 4);
    let own = 0, hid = 0;
    for (let p = 0; p < N; p++) {
      const d = p * 4, o = owner[p];
      if (o === i) { data[d] = orig[d]; data[d + 1] = orig[d + 1]; data[d + 2] = orig[d + 2]; data[d + 3] = 255; own++; }
      else if (o >= 0 && e.data[d + 3] >= 128) { data[d] = e.data[d]; data[d + 1] = e.data[d + 1]; data[d + 2] = e.data[d + 2]; data[d + 3] = e.data[d + 3]; hid++; under[i][o]++; }
    }
    if (own < 60) { report.push({ name: e.name, status: 'not visible in the design' }); return; }
    // a "hidden part" much bigger than what shows is the model's invention, not the element
    let keptHidden = true;
    if (hid > own * 1.5 + 500) { keptHidden = false; for (let p = 0; p < N; p++) if (owner[p] !== i) data[p * 4 + 3] = 0; under[i].fill(0); }
    report.push({ name: e.name + ' from design', status: 'ok', ownPct: Math.round((own * 1000) / N) / 10, hiddenPct: keptHidden ? Math.round((hid * 1000) / N) / 10 : 0 });
    out.push({ e, i, data, own });
  });
  // stacking: whoever shows where another one also lies is in front of it
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = under[i][j], b = under[j][i];
    if (a + b < 40) continue;
    let jTop = a > b;
    // each lies "under" the other (fingers round a glass, garnish in a glass, a redraw that invented a part):
    // the pixels cannot say, so the scene order the art director listed (back to front) decides
    if (Math.min(a, b) > Math.max(a, b) * 0.2) jTop = true;
    if (jTop) { score[j]++; score[i]--; } else { score[i]++; score[j]--; }
  }
  out.sort((x, y) => (x.e.soft ? 1 : 0) - (y.e.soft ? 1 : 0) || score[x.i] - score[y.i] || x.i - y.i);
  // nothing may paint over a pixel that shows something stacked below it: the layers put together are the design again
  const rank = new Int16Array(n).fill(-1);
  out.forEach((o, k) => { rank[o.i] = k; });
  out.forEach((o, k) => {
    if (o.e.soft) return;
    for (let p = 0; p < N; p++) { const w = owner[p]; if (w !== o.i && o.data[p * 4 + 3] && (w < 0 || rank[w] < k)) o.data[p * 4 + 3] = 0; }
  });
  return out.map((o) => ({ ...o.e, data: o.data, own: o.own, idx: o.i }));
}

// The lettering as the design has it: unowned pixels inside the text area, in a text colour, that the empty plate lacks.
// Lines are told apart by colour first (a big orange word and the small cream line under it touch in height), then by row.
// Returns { groups: [{ strict, texts }], T, count } or null when the design's ink is not found this way.
function designInk(orig, plate, owner, texts, W, H, nElems, boxBlur) {
  const N = W * H;
  const hex = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
  const lines = (texts || []).filter((t) => String(t.text || '').trim() && Number(t.w) > 4 && Number(t.h) > 4).map((t) => ({ t, c: hex(t.color) || [255, 255, 255] }));
  if (!lines.length) return null;
  const groups = [];
  for (const l of lines) {
    const g = groups.find((q) => Math.abs(q.c[0] - l.c[0]) + Math.abs(q.c[1] - l.c[1]) + Math.abs(q.c[2] - l.c[2]) < 110);
    if (g) g.lines.push(l); else groups.push({ c: l.c, lines: [l] });
  }
  const zone = new Uint8Array(N);
  for (const l of lines) {
    const x = Number(l.t.x), y = Number(l.t.y), w = Number(l.t.w), h = Number(l.t.h), pad = Math.round(90 + h * 0.4);
    for (let yy = Math.max(0, Math.round(y - pad)); yy < Math.min(H, Math.round(y + h + pad)); yy++) zone.fill(1, yy * W + Math.max(0, Math.round(x - pad)), yy * W + Math.min(W, Math.round(x + w + pad)));
  }
  // a line written ON an element (a sign, a label plate): that element is its carrier, and its ink is looked for on it
  const carrierOf = new Map();
  for (const l of lines) {
    const x0 = Math.max(0, Math.round(Number(l.t.x))), y0 = Math.max(0, Math.round(Number(l.t.y))), x1 = Math.min(W, Math.round(Number(l.t.x) + Number(l.t.w))), y1 = Math.min(H, Math.round(Number(l.t.y) + Number(l.t.h)));
    const cnt = new Int32Array((nElems || 0) + 1); let tot = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { tot++; const o = owner[y * W + x]; if (o >= 0 && o < nElems) cnt[o]++; }
    let b = -1; for (let i = 0; i < nElems; i++) if (cnt[i] > tot * 0.5 && (b < 0 || cnt[i] > cnt[b])) b = i;
    l.carrier = b;
    if (b >= 0) carrierOf.set(b, true);
  }
  for (const g of groups) g.carriers = new Set(g.lines.map((l) => l.carrier).filter((c) => c >= 0));
  // the carrier's rim, frame line and screws sit at its edge; lettering does not
  const inner = new Uint8Array(N);
  for (const c of carrierOf.keys()) { const m = new Float32Array(N); let ar = 0; for (let p = 0; p < N; p++) if (owner[p] === c) { m[p] = 1; ar++; } const b = boxBlur(m, W, H, Math.round(Math.max(11, Math.min(40, Math.sqrt(ar) * 0.08)))); for (let p = 0; p < N; p++) if (b[p] > 0.985) inner[p] = 1; }
  const T = new Float32Array(N), cls = new Uint8Array(N), onCarrier = new Uint8Array(N);
  for (let p = 0; p < N; p++) {
    const o = owner[p];
    if (o >= 0 ? !carrierOf.has(o) : !zone[p]) continue;
    const d = p * 4, t = d3(orig, plate, d);
    if (o < 0) { T[p] = t; if (t <= 55) continue; }
    let k = -1, bd = 150;
    groups.forEach((g, i) => { if (o >= 0 ? !g.carriers.has(o) : g.carriers.size > 0) return; const v = Math.abs(orig[d] - g.c[0]) + Math.abs(orig[d + 1] - g.c[1]) + Math.abs(orig[d + 2] - g.c[2]); if (v < bd) { bd = v; k = i; } });
    if (k < 0) continue;
    cls[p] = k + 1;
    if (o >= 0) { onCarrier[p] = 1; T[p] = 40 + ((150 - bd) * 50) / 70; }
  }
  let total = 0;
  const out = [];
  groups.forEach((g, gi) => {
    const strict = new Uint8Array(N);
    const cc = components(W, H, (p) => cls[p] === gi + 1);
    // (a rim or frame line of the carrier in the text colour is not a letter)
    const edge = new Int32Array(cc.stats.length);
    for (let p = 0; p < N; p++) if (cc.lab[p] && onCarrier[p] && !inner[p]) edge[cc.lab[p]]++;
    const thin = (s) => edge[s.id] > s.area * 0.6 || (() => { const w = s.x1 - s.x0 + 1, h = s.y1 - s.y0 + 1; return Math.min(w, h) <= 7 && Math.max(w, h) >= 70; })();
    const comps = cc.stats.filter((s) => s && s.area >= 6 && !thin(s) && !((s.x1 - s.x0 > 160 || s.y1 - s.y0 > 160) && s.area < (s.x1 - s.x0 + 1) * (s.y1 - s.y0 + 1) * 0.1)).sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0));
    if (!comps.length) return;
    const maxH = comps[0].y1 - comps[0].y0 + 1;
    const rows = [];
    for (const c of comps) {
      const h = c.y1 - c.y0 + 1;
      let best = null, bo = 0;
      for (const r of rows) { const o = Math.min(r.y1, c.y1) - Math.max(r.y0, c.y0) + 1; if (o > bo) { bo = o; best = r; } }
      if (best && bo >= Math.min(h, best.y1 - best.y0 + 1) * 0.35) { best.items.push(c); best.area += c.area; if (h > (best.y1 - best.y0 + 1) * 0.5) { best.y0 = Math.min(best.y0, c.y0); best.y1 = Math.max(best.y1, c.y1); } continue; }
      if (h >= maxH * 0.15 && c.area >= 40) rows.push({ y0: c.y0, y1: c.y1, items: [c], area: c.area });
      else c.loose = true;
    }
    // as many rows as this colour has lines: most ink wins, rows near where the copy was seen count more
    for (const r of rows) {
      const cy = (r.y0 + r.y1) / 2, cx = r.items.reduce((a, c) => a + c.cx * c.area, 0) / r.area;
      const near = g.lines.some((l) => { const pad = Number(l.t.h) * 0.5 + 40; return cy > Number(l.t.y) - pad && cy < Number(l.t.y) + Number(l.t.h) + pad && cx > Number(l.t.x) - pad && cx < Number(l.t.x) + Number(l.t.w) + pad; });
      r.score = r.area * (near ? 1 : 0.25);
    }
    const keepRows = rows.slice().sort((a, b) => b.score - a.score).slice(0, g.lines.length);
    const keep = new Set();
    for (const r of keepRows) {
      const rh = r.y1 - r.y0 + 1;
      const it = r.items.slice().sort((a, b) => a.x0 - b.x0);
      let bi = 0; it.forEach((c, i) => { if (c.area > it[bi].area) bi = i; });
      let lo = bi, hi = bi, x0 = it[bi].x0, x1 = it[bi].x1;
      for (let ch = true; ch;) {
        ch = false;
        if (lo > 0 && x0 - it[lo - 1].x1 < rh * 1.3) { lo--; x0 = Math.min(x0, it[lo].x0); x1 = Math.max(x1, it[lo].x1); ch = true; }
        if (hi < it.length - 1 && it[hi + 1].x0 - x1 < rh * 1.3) { hi++; x1 = Math.max(x1, it[hi].x1); x0 = Math.min(x0, it[hi].x0); ch = true; }
      }
      for (let i = lo; i <= hi; i++) keep.add(it[i].id);
      r.x0 = x0; r.x1 = x1;
    }
    for (const c of comps) {
      if (!c.loose) continue;
      for (const r of keepRows) { const rh = r.y1 - r.y0 + 1, dy = Math.max(r.y0 - c.cy, 0, c.cy - r.y1); if (dy < rh * 0.45 && c.cx > r.x0 - rh * 0.3 && c.cx < r.x1 + rh * 0.3) { keep.add(c.id); break; } }
    }
    let n = 0;
    for (let p = 0; p < N; p++) if (cls[p] === gi + 1 && keep.has(cc.lab[p])) { strict[p] = 1; n++; }
    if (n < 80) return;
    total += n;
    out.push({ strict, texts: g.lines.map((l) => l.t) });
  });
  if (total < 400 || out.reduce((a, g) => a + g.texts.length, 0) < lines.length) return null;
  return { groups: out, T, count: total, onCarrier };
}

module.exports = { ownScene, growOwners, splitFronts, buildLayers, designInk, shadowLike };
