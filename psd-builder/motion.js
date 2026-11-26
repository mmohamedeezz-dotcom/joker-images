// Joker design motion: turns the layers of a PSD job into a 6-second animated version of the design.
// Outputs: <id>.motion.mp4 (rendered in the browser by HyperFrames, with a sound design mix)
//          <id>.motion-ae.zip (layer PNGs + mix.wav + build.jsx that rebuilds the same animation in After Effects)
// usage: node motion.js <job.json> <outDir>
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { spawnSync } = require('child_process');
const { build, trim } = require('./build');

const FPS = 30;
const MOODS = {
  intense: ['blocky', 'brush', 'bold-modern', 'kufi-wide', 'tech', 'poster-round'],
  bouncy: ['playful', 'handwritten', 'ruqaa'],
};
const moodOf = (font) => (MOODS.intense.includes(font) ? 'intense' : MOODS.bouncy.includes(font) ? 'bouncy' : 'smooth');
const FX_NAME = /light|lightning|spark|glow|bolt|electric|energy|particle|debris|splash|splatter|smoke|flame|fire|shine|sparkle|burst|crack|droplet|برق|شرار|رذاذ|دخان|نار|لمع/i;
const LIQUID = /splash|liquid|drink|juice|water|soda|pour|رذاذ|عصير|مشروب|ماء|مية/i;

const png = (img) => PNG.sync.write({ width: img.width, height: img.height, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length) });

// seeded value noise, so the browser render and After Effects get the same shake
function noise1(seed) {
  const h = (n) => { const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
  return (t) => { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return h(i) * (1 - u) + h(i + 1) * u; };
}

// the designed lettering comes as one raster: split it into one layer per text line using the text boxes
function splitLettering(lettering, texts, W, H) {
  if (!lettering) return [];
  const boxes = (texts || []).map((t, i) => {
    const x = +t.x, y = +t.y, w = +t.w, h = +t.h;
    if (!(w > 4 && h > 4)) return null;
    const pad = Math.max(10, h * 0.3);
    return { i, head: /head|title|punch/i.test(String(t.role || '')) || i === 0, text: String(t.text || '').trim(), x0: x - pad, y0: y - pad, x1: x + w + pad, y1: y + h + pad, cx: x + w / 2, cy: y + h / 2 };
  }).filter(Boolean);
  const N = W * H, owner = new Int16Array(N).fill(-1);
  for (let p = 0; p < N; p++) {
    if (!lettering.data[p * 4 + 3]) continue;
    const x = p % W, y = (p / W) | 0;
    let best = -1, bd = Infinity;
    for (let b = 0; b < boxes.length; b++) {
      const B = boxes[b];
      if (x < B.x0 || x > B.x1 || y < B.y0 || y > B.y1) continue;
      const d = Math.abs(y - B.cy) * 3 + Math.abs(x - B.cx) * 0.2;
      if (d < bd) { bd = d; best = b; }
    }
    owner[p] = best;
  }
  const headIdx = boxes.findIndex((b) => b.head);
  const groups = new Map();
  for (let p = 0; p < N; p++) {
    if (!lettering.data[p * 4 + 3]) continue;
    let o = owner[p]; if (o < 0) o = headIdx >= 0 ? headIdx : -2;
    if (!groups.has(o)) groups.set(o, new Uint8ClampedArray(N * 4));
    groups.get(o).set(lettering.data.subarray(p * 4, p * 4 + 4), p * 4);
  }
  const out = [];
  for (const [o, data] of groups) {
    const B = o >= 0 ? boxes[o] : null;
    out.push({ role: !B || B.head ? 'head' : 'sub', name: B ? B.text.slice(0, 30) || 'text' : 'lettering', data, order: B ? B.cy : 0 });
  }
  return out.sort((a, b) => a.order - b.order);
}

// ---------- the choreography ----------
function choreograph(layers, mood, W, H) {
  const dur = 6;
  const L = (role) => layers.filter((l) => l.role === role);
  const cam = { hits: [], push: 1.06 }, flashes = [], cues = [];
  const bg = L('bg')[0], heads = L('head'), subs = L('sub'), hero = L('hero')[0], props = L('prop'), fxs = L('fx'), rest = L('rest')[0];
  const key = (l, arr) => { l.keys = arr; };

  if (mood === 'intense') {
    const T = { flash1: 0.5, head: 0.55, land: 0.78, heroIn: 1.1, heroHit: 1.4, sub: 3.55, flash2: 5.2 };
    if (bg) { key(bg, [{ t: 0, o: 0 }, { t: T.flash1 - 0.01, o: 0 }, { t: T.flash1, o: 1 }]); bg.preFlicker = true; }
    flashes.push([T.flash1, 0.95, 0.12], [T.flash2, 0.85, 0.14]);
    cam.hits.push([T.flash1, 10], [T.land - 0.05, 22], [T.flash2, 18]);
    heads.forEach((l, i) => {
      const t0 = T.head + i * 0.12, t1 = T.land + i * 0.12;
      key(l, [{ t: t0 - 0.01, o: 0 }, { t: t0, o: 1, dy: H * 0.7, s: 1.35, blur: 14 }, { t: t1, dy: -H * 0.022, s: 0.97, blur: 0, ease: 'power4.out' }, { t: t1 + 0.12, dy: H * 0.006, s: 1, ease: 'power2.inOut' }, { t: t1 + 0.24, dy: 0, ease: 'power2.out' }]);
      l.glow = true;
    });
    let hit = T.land + 0.1;
    if (hero) {
      hit = T.heroHit;
      key(hero, [{ t: T.heroIn - 0.01, o: 0 }, { t: T.heroIn, o: 1, dy: -H * 0.75, dx: W * 0.05, r: -28, blur: 10 }, { t: T.heroHit, dy: H * 0.016, dx: 0, r: 4, blur: 0, ease: 'power3.in' }, { t: T.heroHit + 0.14, dy: -H * 0.007, r: -1, ease: 'power2.out' }, { t: T.heroHit + 0.3, dy: 0, r: 0, ease: 'power2.inOut' }]);
      hero.float = { t: T.heroHit + 0.35, amp: H * 0.0065, period: 2.6 };
      cam.hits.push([T.heroHit, 34]); flashes.push([T.heroHit, 0.55, 0.1]);
    }
    fxs.forEach((l) => { key(l, [{ t: hit - 0.01, o: 0 }, { t: hit, o: 1, s: 0.55 }, { t: hit + 0.18, s: 1.04, ease: 'power3.out' }, { t: hit + 0.4, s: 1, ease: 'power2.out' }]); l.flicker = { t: hit + 0.2 }; l.blend = 'screen'; });
    props.forEach((l, i) => { const t = hit + 0.05 + i * 0.07; key(l, [{ t: t - 0.01, o: 0 }, { t, o: 1, s: 0.4, r: -12 }, { t: t + 0.3, s: 1, r: 0, ease: 'back.out(2.2)' }]); l.float = { t: t + 0.4, amp: H * 0.005, period: 2.2 + i * 0.3 }; });
    if (rest) key(rest, [{ t: hit, o: 0 }, { t: hit + 0.5, o: 1, ease: 'power2.out' }]);
    subs.forEach((l, i) => { l.wipe = [T.sub + i * 0.3, T.sub + i * 0.3 + 0.5]; });
    cues.push(['rumble', 0, 0.55], ['swell', Math.max(0, T.flash1 - 0.92), 0.8], ['crack', T.flash1, 0.9], ['rumblehit', T.flash1, 0.9], ['blast', T.head + 0.05, 0.85]);
    if (hero) cues.push(['sub', T.heroHit, 1], ['punch', T.heroHit, 0.9], ['glitch', T.heroHit + 0.02, 0.7]);
    if (layers.some((l) => LIQUID.test(l.name))) cues.push(['fizz', hit + 0.15, 0.45]);
    if (fxs.length) cues.push(['buzz', hit + 0.1, 0.22]);
    subs.forEach((l) => cues.push(['whoosh', l.wipe[0], 0.8]));
    cues.push(['zap', T.flash2, 0.9], ['crack', T.flash2, 0.55], ['crunch', T.flash2 + 0.05, 0.5]);
  } else if (mood === 'bouncy') {
    if (bg) key(bg, [{ t: 0, o: 0, s: 1.08 }, { t: 0.5, o: 1, s: 1, ease: 'power2.out' }]);
    cam.push = 1.03;
    heads.forEach((l, i) => { const t = 0.45 + i * 0.15; key(l, [{ t: t - 0.01, o: 0 }, { t, o: 1, s: 0.2, r: -8 }, { t: t + 0.55, s: 1, r: 0, ease: 'elastic.out(1, 0.45)' }]); cues.push(['pop', t, 0.9]); });
    if (hero) { key(hero, [{ t: 1.0, o: 0, dy: H * 0.35 }, { t: 1.01, o: 1 }, { t: 1.6, dy: 0, ease: 'back.out(1.8)' }]); hero.float = { t: 1.7, amp: H * 0.01, period: 2 }; cues.push(['whoosh_soft', 0.95, 0.7], ['pop2', 1.45, 0.9]); }
    props.concat(fxs).forEach((l, i) => { const t = 1.5 + i * 0.12; key(l, [{ t: t - 0.01, o: 0 }, { t, o: 1, s: 0 }, { t: t + 0.45, s: 1, ease: 'back.out(3)' }]); l.float = { t: t + 0.5, amp: H * 0.008, period: 1.8 + i * 0.25 }; cues.push(['pop', t, 0.6]); });
    if (rest) key(rest, [{ t: 1.4, o: 0 }, { t: 1.9, o: 1 }]);
    subs.forEach((l, i) => { l.wipe = [2.9 + i * 0.3, 3.4 + i * 0.3]; cues.push(['whoosh_soft', 2.9 + i * 0.3, 0.6]); });
    cues.push(['shimmer', 4.6, 0.6], ['sting', 5.1, 0.7]);
  } else {
    if (bg) key(bg, [{ t: 0, o: 0, s: 1.1 }, { t: 1.2, o: 1, s: 1, ease: 'power2.out' }]);
    cam.push = 1.04;
    if (hero) { key(hero, [{ t: 0.3, o: 0, s: 1.12, blur: 18 }, { t: 1.6, o: 1, s: 1, blur: 0, ease: 'power3.out' }]); hero.float = { t: 1.7, amp: H * 0.004, period: 3.2 }; }
    heads.forEach((l, i) => { const t = 1.0 + i * 0.2; key(l, [{ t, o: 0, dy: H * 0.035, blur: 12 }, { t: t + 0.9, o: 1, dy: 0, blur: 0, ease: 'power3.out' }]); l.sweep = { t: t + 1.0 }; });
    props.concat(fxs).forEach((l, i) => { const t = 1.6 + i * 0.12; key(l, [{ t, o: 0, dy: H * 0.02 }, { t: t + 0.7, o: 1, dy: 0, ease: 'power2.out' }]); });
    if (rest) key(rest, [{ t: 1.4, o: 0 }, { t: 2.2, o: 1 }]);
    subs.forEach((l, i) => { l.wipe = [2.6 + i * 0.3, 3.3 + i * 0.3]; });
    cues.push(['swell_soft', 0, 0.7], ['whoosh_soft', 0.9, 0.6], ['sub_soft', 1.6, 0.8], ['shimmer', 2.1, 0.55]);
    subs.forEach((l) => cues.push(['whoosh_soft', l.wipe[0], 0.5]));
    cues.push(['sting', 5.0, 0.7]);
  }
  for (const l of layers) if (!l.keys) l.keys = [{ t: 0, o: 1 }];
  return { dur, fps: FPS, W, H, mood, layers, cam, flashes, cues };
}

// ---------- precomputed per-frame values shared by the browser and After Effects ----------
function frames(plan) {
  const nx = noise1(1), ny = noise1(2), out = { cam: [], flicker: {} };
  for (let f = 0; f <= plan.dur * FPS; f++) {
    const t = f / FPS;
    let a = 0;
    for (const [t0, amp] of plan.cam.hits) { const d = t - t0; if (d > 0) a += amp * Math.exp(-d * 7); }
    out.cam.push([+(a * nx(t * 45)).toFixed(2), +(a * ny(t * 45 + 77)).toFixed(2)]);
  }
  plan.layers.forEach((l, i) => {
    if (!l.flicker) return;
    const seq = [];
    for (let f = Math.ceil(l.flicker.t * FPS); f <= plan.dur * FPS; f += 1) {
      const n = Math.sin((Math.floor(f / 1.25) + i * 17) * 12.9898) * 43758.5453;
      seq.push([+(f / FPS).toFixed(3), (n - Math.floor(n)) > 0.35 ? 1 : 0.55]);
    }
    out.flicker[l.id] = seq;
  });
  return out;
}

// ---------- browser composition (HyperFrames) ----------
function html(plan, pre) {
  const { W, H, dur } = plan;
  const root = `<!doctype html>
<html lang="ar"><head><meta charset="UTF-8" /><meta name="viewport" content="width=${W}, height=${H}" />
<script src="vendor/gsap.min.js"></script>
<style>* { margin: 0; padding: 0; box-sizing: border-box; } html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #000; } #root { position: relative; width: 100%; height: 100%; }</style>
</head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${dur}" data-fps="${FPS}" data-width="${W}" data-height="${H}">
  <div id="ad" data-composition-id="ad" data-composition-src="compositions/ad.html" data-start="0" data-duration="${dur}" data-track-index="1" data-track-kind="graphics" data-width="${W}" data-height="${H}"></div>
  <audio id="mix" class="clip" src="assets/mix.wav" data-start="0" data-duration="${dur}" data-track-index="9" data-volume="1"></audio>
</div>
<script>window.__timelines = window.__timelines || {}; window.__timelines["main"] = gsap.timeline({ paused: true });</script>
</body></html>`;
  const imgs = plan.layers.map((l) => {
    const base = `left:${l.left}px;top:${l.top}px;width:${l.w}px;height:${l.h}px;`;
    const glow = l.glow ? `<img id="g-${l.id}" class="ly" src="assets/layers/${l.file}" style="${base}filter:blur(18px) brightness(1.7);mix-blend-mode:screen;opacity:0" />` : '';
    return `<img id="l-${l.id}" class="ly" src="assets/layers/${l.file}" style="${base}${l.blend === 'screen' ? 'mix-blend-mode:screen;' : ''}" />${glow}`;
  }).join('\n      ');
  const ad = `<template>
  <style>
    #dm { position: absolute; inset: 0; overflow: hidden; background: #000; }
    #cam { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; transform-origin: 50% 50%; }
    .ly { position: absolute; display: block; }
    #flash { position: absolute; inset: 0; background: #fff; opacity: 0; }
  </style>
  <div id="dm" data-composition-id="ad" data-width="${W}" data-height="${H}">
    <div id="cam">
      ${imgs}
    </div>
    <div id="flash"></div>
  </div>
  <script>
    (function () {
      var P = ${JSON.stringify(plan)}, F = ${JSON.stringify(pre)};
      var tl = gsap.timeline({ paused: true });
      var props = function (k) { var o = {}; o.x = k.dx || 0; o.y = k.dy || 0; o.scale = k.s == null ? 1 : k.s; o.rotation = k.r || 0; if (k.o != null) o.opacity = k.o; o.filter = 'blur(' + (k.blur || 0) + 'px)'; return o; };
      P.layers.forEach(function (l) {
        var el = document.getElementById('l-' + l.id), k = l.keys, prev = Object.assign({ dx: 0, dy: 0, s: 1, r: 0, blur: 0, o: 1 }, k[0]);
        tl.set(el, props(prev), 0);
        for (var i = 1; i < k.length; i++) {
          var cur = Object.assign({}, prev, k[i]); delete cur.ease;
          var d = Math.max(0.001, k[i].t - k[i - 1].t);
          var p = props(cur); p.duration = d; p.ease = k[i].ease || 'power2.out';
          if (d <= 0.02) { delete p.duration; delete p.ease; tl.set(el, p, k[i].t); } else tl.to(el, p, k[i - 1].t);
          prev = cur;
        }
        if (l.float) tl.to(el, { y: '+=' + l.float.amp, duration: l.float.period / 2, ease: 'sine.inOut', repeat: Math.ceil((P.dur - l.float.t) / (l.float.period / 2)), yoyo: true }, l.float.t);
        if (l.wipe) { tl.set(el, { clipPath: 'inset(-10% -10% -10% 110%)' }, 0); tl.to(el, { clipPath: 'inset(-10% -10% -10% -10%)', duration: l.wipe[1] - l.wipe[0], ease: 'power3.out' }, l.wipe[0]); }
        if (F.flicker[l.id]) F.flicker[l.id].forEach(function (s) { tl.set(el, { opacity: s[1] }, s[0]); });
        if (l.preFlicker) [[0.12, 0.35], [0.17, 0], [0.30, 0.35], [0.36, 0]].forEach(function (s) { tl.set(el, { opacity: s[1] }, s[0]); });
        var g = document.getElementById('g-' + l.id);
        if (g) {
          tl.set(g, { opacity: 0 }, 0);
          var land = l.keys[l.keys.length - 1].t;
          for (var t = land; t <= P.dur; t += 2 / ${FPS}) { var v = 0.22 + 0.12 * Math.sin(t * 9); P.flashes.forEach(function (fl) { if (t >= fl[0] && t < fl[0] + 0.25) v += 0.6; }); tl.set(g, { opacity: Math.min(1, v) }, t); }
          tl.set(g, props(Object.assign({ dx: 0, dy: 0, s: 1, r: 0 }, l.keys[l.keys.length - 1])), land);
        }
        if (l.sweep) tl.fromTo(el, { filter: 'brightness(1)' }, { filter: 'brightness(1.35)', duration: 0.35, yoyo: true, repeat: 1, ease: 'sine.inOut' }, l.sweep.t);
      });
      var cam = document.getElementById('cam');
      F.cam.forEach(function (c, f) { tl.set(cam, { x: c[0], y: c[1] }, f / ${FPS}); });
      tl.fromTo(cam, { scale: 1 }, { scale: P.cam.push, duration: P.dur, ease: 'none' }, 0);
      var fl = document.getElementById('flash');
      P.flashes.forEach(function (x) { tl.set(fl, { opacity: x[1] }, x[0]); tl.to(fl, { opacity: 0, duration: x[2], ease: 'power2.out' }, x[0] + 1 / ${FPS}); });
      window.__timelines["ad"] = tl;
    })();
  </script>
</template>`;
  return { root, ad };
}

// ---------- sound ----------
function mix(plan, dir, sfxDir) {
  const synth = {
    rumble: `anoisesrc=color=brown:amplitude=0.9:duration=${plan.dur}:sample_rate=48000,lowpass=f=110,volume='if(lt(t,0.5),0.15+1.5*t,0.9)':eval=frame,afade=t=out:st=${plan.dur - 0.6}:d=0.6`,
    crack: 'anoisesrc=color=white:amplitude=1:duration=1.4:sample_rate=48000,lowpass=f=3500,volume=\'exp(-3.2*t)\':eval=frame',
    fizz: 'anoisesrc=color=white:amplitude=0.8:duration=0.7:sample_rate=48000,highpass=f=3000,volume=\'min(1,t*30)*exp(-4*t)\':eval=frame',
    buzz: `aevalsrc='0.35*sgn(sin(2*PI*100*t))*(0.6+0.4*sin(2*PI*7*t))+0.2*sin(2*PI*150*t)':s=48000:d=4.2,highpass=f=80,lowpass=f=2500,afade=t=in:d=0.3,afade=t=out:st=3.8:d=0.4`,
  };
  const args = ['-v', 'error', '-y'], chains = [];
  plan.cues.forEach(([name, t, vol], i) => {
    if (synth[name]) args.push('-f', 'lavfi', '-i', synth[name]);
    else args.push('-i', path.join(sfxDir, name + '.wav'));
    const ms = Math.round(t * 1000);
    chains.push(`[${i}]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${ms}|${ms},volume=${vol}[a${i}]`);
  });
  const ins = plan.cues.map((_, i) => `[a${i}]`).join('');
  chains.push(`${ins}amix=inputs=${plan.cues.length}:normalize=0,atrim=0:${plan.dur},afade=t=out:st=${plan.dur - 0.4}:d=0.4,alimiter=limit=0.9,loudnorm=I=-14:TP=-1:LRA=11[out]`);
  args.push('-filter_complex', chains.join(';'), '-map', '[out]', '-ar', '48000', path.join(dir, 'mix.wav'));
  const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg mix failed');
}

// ---------- After Effects ----------
function jsx(plan, pre) {
  return `// Joker design motion — After Effects build script (generated).
// Put this file next to the "layers" and "audio" folders, then File > Scripts > Run Script File…
// It builds the same ${plan.dur}s animation as the MP4: comp "Design motion", layers named by role, sound included.
(function () {
  var P = ${JSON.stringify(plan)};
  var F = ${JSON.stringify({ cam: pre.cam, flicker: pre.flicker })};
  var ROOT = File($.fileName).parent;
  app.beginUndoGroup("Joker design motion");
  var proj = app.project || app.newProject();
  var folder = proj.items.addFolder("Design motion assets");
  var comp = proj.items.addComp("Design motion", P.W, P.H, 1, P.dur, P.fps);
  comp.bgColor = [0, 0, 0]; comp.motionBlur = true;
  function imp(rel) { var f = new File(ROOT.fsName + "/" + rel); var it = proj.importFile(new ImportOptions(f)); it.parentFolder = folder; return it; }
  function easeAll(prop) { for (var k = 1; k <= prop.numKeys; k++) { var n = prop.value instanceof Array ? prop.value.length : 1; if (prop.propertyValueType === PropertyValueType.TwoD_SPATIAL) n = 1; var a = []; for (var d = 0; d < n; d++) a.push(new KeyframeEase(0, 70)); try { prop.setTemporalEaseAtKey(k, a, a); } catch (e) {} } }
  var order = P.layers.slice();
  for (var i = 0; i < order.length; i++) {
    var l = order[i];
    var lay = comp.layers.add(imp("layers/" + l.file));
    lay.name = l.role.toUpperCase() + " · " + l.name;
    lay.moveToBeginning();
    if (l.blend === "screen") lay.blendingMode = BlendingMode.SCREEN;
    lay.motionBlur = true;
    var cx = l.left + l.w / 2, cy = l.top + l.h / 2, prev = { dx: 0, dy: 0, s: 1, r: 0, o: 1 };
    var pos = lay.property("Position"), sc = lay.property("Scale"), rot = lay.property("Rotation"), op = lay.property("Opacity");
    for (var k = 0; k < l.keys.length; k++) {
      var key = l.keys[k], cur = {};
      for (var p in prev) cur[p] = prev[p];
      for (var q in key) cur[q] = key[q];
      pos.setValueAtTime(key.t, [cx + (cur.dx || 0), cy + (cur.dy || 0)]);
      sc.setValueAtTime(key.t, [cur.s * 100, cur.s * 100]);
      rot.setValueAtTime(key.t, cur.r || 0);
      op.setValueAtTime(key.t, (cur.o == null ? 1 : cur.o) * 100);
      prev = cur;
    }
    easeAll(pos); easeAll(sc); easeAll(rot);
    if (l.float) pos.expression = "var t0=" + l.float.t + "; time>t0 ? value+[0," + l.float.amp + "*Math.sin((time-t0)*2*Math.PI/" + l.float.period + ")] : value";
    if (F.flicker[l.id]) { var fl = F.flicker[l.id]; for (var j = 0; j < fl.length; j++) op.setValueAtTime(fl[j][0], fl[j][1] * 100); for (var h = 1; h <= op.numKeys; h++) if (op.keyTime(h) >= fl[0][0]) op.setInterpolationTypeAtKey(h, KeyframeInterpolationType.HOLD); }
    if (l.preFlicker) op.expression = "var f = (time>0.12&&time<0.17)||(time>0.30&&time<0.36) ? 35 : 0; Math.max(value, f)";
    if (l.glow) { var g = lay.property("ADBE Effect Parade").addProperty("ADBE Glo2"); g.property("Glow Threshold").setValue(78); g.property("Glow Radius").setValue(26); g.property("Glow Intensity").expression = "0.22+0.12*Math.sin(time*9)"; }
    if (l.wipe) { var w = lay.property("ADBE Effect Parade").addProperty("ADBE Linear Wipe"); w.property("Wipe Angle").setValue(90); w.property("Feather").setValue(60); var tc = w.property("Transition Completion"); tc.setValueAtTime(l.wipe[0], 100); tc.setValueAtTime(l.wipe[1], 0); easeAll(tc); }
  }
  var cam = comp.layers.addSolid([0, 0, 0], "CAM · shake + push", P.W, P.H, 1, P.dur);
  cam.adjustmentLayer = true; cam.moveToBeginning();
  var tr = cam.property("ADBE Effect Parade").addProperty("ADBE Geometry2");
  var tp = tr.property("Position");
  for (var f = 0; f < F.cam.length; f++) if (F.cam[f][0] || F.cam[f][1] || f === 0) tp.setValueAtTime(f / P.fps, [P.W / 2 + F.cam[f][0], P.H / 2 + F.cam[f][1]]);
  var ts = tr.property("ADBE Geometry2-0003"); ts.setValueAtTime(0, 100); ts.setValueAtTime(P.dur, P.cam.push * 100);
  var flash = comp.layers.addSolid([1, 1, 1], "FLASH", P.W, P.H, 1, P.dur); flash.moveToBeginning();
  var fo = flash.property("Opacity"); fo.setValueAtTime(0, 0);
  for (var x = 0; x < P.flashes.length; x++) { var s = P.flashes[x]; fo.setValueAtTime(s[0] - 0.02, 0); fo.setValueAtTime(s[0], s[1] * 100); fo.setValueAtTime(s[0] + s[2], 0); }
  var aud = comp.layers.add(imp("audio/mix.wav")); aud.name = "SFX · mix";
  comp.openInViewer();
  app.endUndoGroup();
})();
`;
}

// ---------- main ----------
function buildMotion(job, outDir, id, parts) {
  const P = parts || build(job).parts;
  const { W, H } = P;
  const work = path.join(outDir, id + '-motion');
  fs.rmSync(work, { recursive: true, force: true });
  for (const d of ['assets/layers', 'compositions', 'vendor', 'ae/layers', 'ae/audio']) fs.mkdirSync(path.join(work, d), { recursive: true });
  const layers = [];
  const add = (role, name, img) => {
    const t = trim(img); if (!t) return;
    const idn = 'L' + layers.length, file = idn + '-' + role + '.png';
    const buf = png(t.imageData);
    fs.writeFileSync(path.join(work, 'assets/layers', file), buf);
    fs.writeFileSync(path.join(work, 'ae/layers', file), buf);
    layers.push({ id: idn, role, name: String(name || role).slice(0, 40), file, left: t.left, top: t.top, w: t.imageData.width, h: t.imageData.height });
  };
  add('bg', 'Background', P.plate || P.orig);
  const elems = P.elems.slice();
  // the hero is the biggest element (the product, the person); pure effects only win when nothing else is there
  const solidOf = (e) => e.solid * (FX_NAME.test(e.name) && !/can|bottle|cup|box|pack|product|phone|car|person|man|woman|boy|girl|chef|علبة|زجاجة|كوب|منتج|راجل|ست|بنت|ولد/i.test(e.name) ? 0.25 : 1);
  const heroIdx = elems.length ? elems.reduce((b, e, i, a) => (b < 0 || solidOf(e) > solidOf(a[b]) ? i : b), -1) : -1;
  elems.forEach((e, i) => { const img = { width: W, height: H, data: e.data }; if (i === heroIdx) return; add(FX_NAME.test(e.name) ? 'fx' : 'prop', e.name, img); });
  if (P.rest) add('rest', 'Graphics and details', P.rest);
  const lines = splitLettering(P.lettering, P.texts, W, H);
  lines.filter((l) => l.role === 'head').forEach((l) => add('head', l.name, { width: W, height: H, data: l.data }));
  if (heroIdx >= 0) add('hero', elems[heroIdx].name, { width: W, height: H, data: elems[heroIdx].data });
  lines.filter((l) => l.role === 'sub').forEach((l) => add('sub', l.name, { width: W, height: H, data: l.data }));
  const mood = job.motion_mood || moodOf(P.font);
  const plan = choreograph(layers, mood, W, H);
  const pre = frames(plan);
  const sfxDir = path.join(__dirname, 'sfx');
  mix(plan, path.join(work, 'assets'), sfxDir);
  fs.copyFileSync(path.join(work, 'assets/mix.wav'), path.join(work, 'ae/audio/mix.wav'));
  const h = html(plan, pre);
  fs.writeFileSync(path.join(work, 'index.html'), h.root);
  fs.writeFileSync(path.join(work, 'compositions/ad.html'), h.ad);
  fs.copyFileSync(path.join(__dirname, 'motion-vendor/gsap.min.js'), path.join(work, 'vendor/gsap.min.js'));
  fs.copyFileSync(path.join(__dirname, 'motion-vendor/hyperframes.json'), path.join(work, 'hyperframes.json'));
  fs.writeFileSync(path.join(work, 'ae/build.jsx'), jsx(plan, pre));
  fs.writeFileSync(path.join(work, 'ae/README.txt'), 'After Effects: File > Scripts > Run Script File… > build.jsx (keep it next to the layers and audio folders).\nIt builds the comp "Design motion" (' + plan.dur + 's, ' + W + 'x' + H + ', ' + FPS + 'fps) with every layer animated, the camera shake, the flashes and the sound.\n');
  const mp4 = path.join(outDir, id + '.motion.mp4');
  const r = spawnSync('npx', ['--yes', 'hyperframes@0.8.225', 'render', '--output', mp4], { cwd: work, stdio: 'inherit', env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1' } });
  if (r.status !== 0) throw new Error('hyperframes render failed');
  const zip = path.join(outDir, id + '.motion-ae.zip');
  fs.rmSync(zip, { force: true });
  const z = spawnSync('zip', ['-qr', zip, '.'], { cwd: path.join(work, 'ae') });
  if (z.status !== 0) throw new Error('zip failed');
  return { mp4, zip, mood, layers: layers.map((l) => l.role + ':' + l.name) };
}

if (require.main === module) {
  const [, , jobPath, outDir] = process.argv;
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  const id = path.basename(jobPath).replace(/\.json$/, '');
  console.log(JSON.stringify(buildMotion(job, outDir || '.', id), null, 1));
}
module.exports = { buildMotion };
