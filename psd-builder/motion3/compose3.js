// Joker motion v3 — compositor: scene3 layers + the director's choreography -> MP4 (HyperFrames) with an
// automatic sound design (every visual event gets its sound, placed by each sound's measured onset/peak).
// usage: node compose3.js <work> <out.mp4> [out-ae.zip]
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const [, , WORK, OUT, OUTZIP] = process.argv;
const HERE = __dirname, SC = path.join(WORK, 'scene3'), HF = path.join(WORK, 'hf3');
const scene = JSON.parse(fs.readFileSync(path.join(SC, 'scene.json'), 'utf8'));
const plan = JSON.parse(fs.readFileSync(path.join(WORK, 'plan.json'), 'utf8'));
const LIB = process.env.JM_SFX || path.join(HERE, '..', 'sfxlib');
const META = JSON.parse(fs.readFileSync(path.join(LIB, 'meta.json'), 'utf8'));
const W = scene.W, H = scene.H, FPS = 30;
const D = Math.max(5, Math.min(9, +plan.duration || 7));
const num = (v, d, lo, hi) => { v = Number(v); if (!isFinite(v)) v = d; return Math.max(lo, Math.min(hi, v)); };
let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const PL = plan.layers || [];
const byName = (n) => scene.layers.find((l) => l.name === n);
const pband = (x, y) => x * 0.985 + y * 0.174;            // position along a 100deg gradient

// ---------- solids ----------
const heroK = Math.max(0, PL.findIndex((l) => l.hero));
const solids = scene.layers.filter((l) => l.kind === 'solid').map((l) => {
  const L = PL[l.ref] || {}, s = { k: l.ref, name: l.name, c: l.c, top: l.top, axis: l.axis || 0, bbox: l.bbox };
  if (L.enter) s.enter = { type: L.enter.type || 'rise', t: num(L.enter.t, 0.1, 0, D - 2), dur: num(L.enter.dur, 0.85, 0.3, 1.6) };
  if (L.idle) s.idle = L.idle;
  if (L.eject && L.eject.anchor) {
    const hero = scene.layers.find((x) => x.kind === 'solid' && x.ref === heroK) || {};
    const ax = (hero.axis || 0) * Math.PI / 180, a = L.eject.anchor;
    s.eject = { t: num(L.eject.t, 1.3, 0.5, D - 2), seat: [a[0] + Math.sin(ax) * 22, a[1] - Math.cos(ax) * 22], rot: (hero.axis || 0) - (l.axis || 0) };
    s.seatIn = heroK;
  }
  if (L.sweep) { s.sweep = { t: num(L.sweep.t, 5.3, 1, D - 1) }; s.p0 = pband(l.bbox[0], l.bbox[1]); s.p1 = pband(l.bbox[2], l.bbox[3]); }
  s.sparksSrc = l.sparks || []; s.sweepFile = l.sweep;
  return s;
});
// ---------- glows ----------
const glows = scene.layers.filter((l) => l.kind === 'glow' && l.ref !== null && l.ref !== undefined).map((l) => {
  const L = PL[l.ref] || {}, r = Object.assign({}, L.reveal || {});
  if (r.t !== undefined) r.t = num(r.t, 1, 0, D - 1);
  const g = { name: l.name, c: l.c || [W / 2, H / 2], reveal: r, accent: !!L.accent, pulse: l.pulse };
  if (l.bbox) {
    g.rad = Math.round(Math.max(l.bbox[2] - l.bbox[0], l.bbox[3] - l.bbox[1]) * 0.8);
    if (r.from) g.reach = Math.max(...[[0, 1], [2, 1], [0, 3], [2, 3]].map(([i, j]) => Math.hypot(l.bbox[i] - r.from[0], l.bbox[j] - r.from[1])));
  }
  if (r.type === 'grow_from' && !r.dur) r.dur = 1.0;
  return g;
});
const accent = glows.find((g) => g.accent) || null;
// ---------- texts ----------
const texts = scene.layers.filter((l) => l.kind === 'text').map((l) => {
  const tp = (plan.texts || []).find((x) => +x.index === l.ref) || (plan.texts || [])[l.ref] || {};
  const T = { i: l.ref, bbox: l.bbox, c: l.c, words: l.words || [], t: num(tp.t, 2.6 + 0.6 * l.ref, 0.2, D - 2), anim: tp.anim || 'wipe_words' };
  if (tp.glint) { T.glint = num(tp.glint, 4.2, 1, D - 1.2); T.p0 = pband(l.bbox[0], (l.bbox[1] + l.bbox[3]) / 2); T.p1 = pband(l.bbox[2], (l.bbox[1] + l.bbox[3]) / 2); }
  return T;
});
const lastText = texts.length ? Math.max(...texts.map((t) => t.t)) : 2.5;
const rule = (byName('rule') || byName('ruleglow')) ? { t: num((plan.rule || {}).t, Math.min(...texts.map((t) => t.t)) + 0.7, 0.5, D - 1.5) } : null;
// ---------- moment ----------
const moment = plan.moment && plan.moment.at ? { type: plan.moment.type || 'pop', t: num(plan.moment.t, 1.3, 0.4, D - 2), at: plan.moment.at, fizz: !!plan.moment.fizz } : null;
const flowPath = plan.flow && plan.flow.path && plan.flow.path.length === 3 ? plan.flow.path : null;
const burst = [];
if (moment) {
  const dir = flowPath ? Math.atan2(flowPath[1][1] - flowPath[0][1], flowPath[1][0] - flowPath[0][0]) : -Math.PI / 2;
  for (let i = 0; i < 22; i++) burst.push({ a: +(dir + (rnd() - 0.5) * 1.4).toFixed(2), v: Math.round(160 + rnd() * 220), s: +(2.5 + rnd() * 2.5).toFixed(1), d: +(0.45 + rnd() * 0.35).toFixed(2) });
}
// ---------- flow particles + pulse ----------
const flow = [];
if (flowPath) {
  let t0 = num(plan.flow.t, moment ? moment.t + 0.15 : 1.5, 0, D - 2);
  const bez = (u, a, b, c) => [(1 - u) ** 2 * a[0] + 2 * (1 - u) * u * b[0] + u * u * c[0], (1 - u) ** 2 * a[1] + 2 * (1 - u) * u * b[1] + u * u * c[1]];
  while (t0 < D - 0.4) {
    const dur = 1.5 + rnd() * 0.8, jx = (rnd() - 0.5) * 52, jy = (rnd() - 0.5) * 44;
    const pts = [0, 1, 2, 3, 4, 5, 6].map((k) => { const p = bez(k / 6, ...flowPath); return [+(p[0] + jx * Math.sin(k)).toFixed(1), +(p[1] + jy * Math.sin(k * 0.8)).toFixed(1)]; });
    if (t0 + dur < D + 0.4) flow.push({ t: +t0.toFixed(2), d: +dur.toFixed(2), s: +(3 + rnd() * 3.5).toFixed(1), pts });
    t0 += t0 < 3.5 ? 0.07 + rnd() * 0.06 : 0.22 + rnd() * 0.12;
  }
}
const pulseGlow = glows.find((g) => g.pulse);
const pulse = flowPath && pulseGlow && plan.pulse ? { t: num(plan.pulse.t, 4.6, 1, D - 1.5), dur: num(plan.pulse.dur, 0.9, 0.5, 1.5), path: flowPath, file: pulseGlow.pulse } : null;
// ---------- sparks on the hero after its sweep ----------
const hero = solids.find((s) => s.k === heroK);
if (hero && !hero.sweep) { const hl = scene.layers.find((l) => l.kind === 'solid' && l.ref === heroK); hero.sweep = { t: +(D - 2.6).toFixed(2) }; hero.p0 = pband(hl.bbox[0], hl.bbox[1]); hero.p1 = pband(hl.bbox[2], hl.bbox[3]); }
const sparks = hero && hero.sweep ? hero.sparksSrc.slice(0, 14).map((p, i) => ({ x: p[0], y: p[1], t: +(hero.sweep.t + 0.25 + i * 0.075 + rnd() * 0.1).toFixed(2) })) : [];
// ---------- camera ----------
let cam = null;
const cp = plan.camera || {};
if (cp.start === 'hero' && hero) {
  const f = moment ? moment.at : hero.top, s = 1.32, lim = (s - 1) * W / 2;
  const cl = (v) => Math.max(-lim, Math.min(lim, v));
  const pull = cp.pull || [moment ? moment.t + 0.25 : 1.2, (moment ? moment.t + 0.25 : 1.2) + 1.15];
  cam = { s, x: Math.round(cl(-(f[0] - W / 2) * s * 0.55)), y: Math.round(cl(-(f[1] - H / 2) * s * 0.25)), p0: num(pull[0], 1.5, 0.3, D - 3), p1: num(pull[1], 2.7, 0.8, D - 2) };
}
const dLum = scene.lum || 80;      // bright / flat art: a soft flash only (no blown-out hero)
const flashK = dLum > 140 ? 0.25 : dLum > 100 ? 0.5 : 1;
const P = { flashK,
  D, W, H, cam, solids: solids.map(({ sparksSrc, ...s }) => s), glows, accent, texts, rule, moment, burst, flow, pulse, sparks,
  twinkle: plan.twinkle ? { t: num(plan.twinkle.t, D - 0.95, 1, D - 0.6) } : null,
  parallax: plan.parallax === false ? null : [cam ? cam.p1 : 1.0, D - 0.3], haze: plan.haze ? [cam ? cam.p1 - 0.2 : 1.5] : null,
};

// ---------- HTML ----------
fs.rmSync(HF, { recursive: true, force: true });
for (const d of ['assets', 'compositions', 'vendor']) fs.mkdirSync(path.join(HF, d), { recursive: true });
for (const f of fs.readdirSync(SC)) if (f.endsWith('.png')) fs.copyFileSync(path.join(SC, f), path.join(HF, 'assets', f));
const VEND = path.join(HERE, '..', 'motion-vendor');
fs.copyFileSync(path.join(VEND, 'gsap.min.js'), path.join(HF, 'vendor/gsap.min.js'));
fs.copyFileSync(path.join(VEND, 'hyperframes.json'), path.join(HF, 'hyperframes.json'));
const img = (id, f, extra = '') => `<img class="L" id="${id}" src="assets/${f}" ${extra}/>`;
const body = [];
body.push(img('L_bg', 'bg.png'));
fs.copyFileSync(path.join(WORK, 'design.png'), path.join(HF, 'assets', 'final.png'));
for (const l of scene.layers) {
  if (l.kind === 'rim') continue;                                // rims live inside their solid's group
  if (l.kind === 'solid') {
    const s = solids.find((x) => x.k === l.ref), rim = byName('rim' + l.ref);
    const seats = solids.filter((x) => x.eject && x.seatIn === l.ref).map((x) => img('seat' + x.k, 'solid' + x.k + '.png', 'style="opacity:0"')).join('');
    body.push(`<div class="G" id="g${l.ref}"><div class="G" id="gi${l.ref}">${seats}${rim ? img('rim' + l.ref, rim.file) : ''}${img('L_' + l.name, l.file)}${s && s.sweep && l.sweep ? img('S_' + l.ref, l.sweep, 'style="mix-blend-mode:lighten"') : ''}</div></div>`);
    if (s && s.k === heroK) body.push(sparks.map((d, i) => `<div class="glint" id="dr${i}" style="left:${d.x - 14}px;top:${d.y - 14}px;width:28px;height:28px"></div>`).join(''));
    continue;
  }
  if (l.kind === 'text') {
    const T = texts.find((t) => t.i === l.ref);
    if (T && T.anim === 'wipe_words') (T.words.length ? T.words : [[T.bbox[0], T.bbox[2]]]).forEach((w, j) => body.push(img('L_text' + l.ref + '_w' + j, l.file)));
    else body.push(img('L_text' + l.ref, l.file));
    if (T && T.glint && l.glint) body.push(img('G_text' + l.ref, l.glint));
    continue;
  }
  body.push(img('L_' + l.name, l.file));
  const g = glows.find((x) => x.name === l.name);
  if (g && (g.reveal.type === 'bloom' || g.accent)) body.push(`<div class="bloom" id="glow_${g.name}"></div>`);
  if (pulse && g && g.pulse === pulse.file) body.push(img('pulse', pulse.file, 'style="mix-blend-mode:screen"'));
}
const flHtml = flow.map((f, i) => `<div class="fl" id="f${i}" style="left:${-f.s / 2}px;top:${-f.s / 2}px;width:${f.s}px;height:${f.s}px"></div>`).join('');
const bsHtml = moment ? burst.map((b, i) => `<div class="spark" id="s${i}" style="left:${moment.at[0]}px;top:${moment.at[1]}px;width:${b.s}px;height:${b.s}px"></div>`).join('') : '';
fs.writeFileSync(path.join(HF, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=${W}, height=${H}"><script src="vendor/gsap.min.js"></script>
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000}#root{position:relative;width:100%;height:100%}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-fps="${FPS}" data-width="${W}" data-height="${H}">
<div id="ad" data-composition-id="ad" data-composition-src="compositions/ad.html" data-start="0" data-duration="${D}" data-track-index="1" data-track-kind="graphics" data-width="${W}" data-height="${H}"></div>
</div><script>window.__timelines=window.__timelines||{};window.__timelines["main"]=gsap.timeline({paused:true});</script></body></html>`);
fs.writeFileSync(path.join(HF, 'compositions/ad.html'), `<template><style>
#st{position:absolute;inset:0;overflow:hidden;background:#05060f}
#cam{position:absolute;inset:0;transform-origin:50% 50%}
.L,.G{position:absolute;left:0;top:0;width:${W}px;height:${H}px}
.glint{position:absolute;opacity:0;mix-blend-mode:screen;background:radial-gradient(circle,rgba(255,248,225,.95) 0 5%,rgba(255,214,130,.35) 13%,rgba(255,190,80,0) 34%),linear-gradient(90deg,rgba(255,230,160,0) 0 47%,rgba(255,236,190,.55) 50%,rgba(255,230,160,0) 53%),linear-gradient(0deg,rgba(255,230,160,0) 0 47%,rgba(255,236,190,.55) 50%,rgba(255,230,160,0) 53%);-webkit-mask-image:radial-gradient(circle,#000 0 30%,transparent 50%);mask-image:radial-gradient(circle,#000 0 30%,transparent 50%)}
.fl{position:absolute;border-radius:50%;opacity:0;mix-blend-mode:screen;background:radial-gradient(circle,rgba(255,244,210,1) 0 25%,rgba(255,196,90,.6) 50%,rgba(255,170,60,0) 75%)}
.spark{position:absolute;border-radius:50%;opacity:0;background:#ffe7b0;box-shadow:0 0 8px 2px rgba(255,190,70,.8);mix-blend-mode:screen}
.bloom{position:absolute;border-radius:50%;opacity:0;mix-blend-mode:screen;background:radial-gradient(circle,rgba(255,232,170,.75) 0 10%,rgba(255,200,100,.3) 32%,rgba(255,180,70,0) 68%)}
#popflash{position:absolute;width:300px;height:300px;border-radius:50%;opacity:0;mix-blend-mode:screen;background:radial-gradient(circle,rgba(255,246,220,.9) 0 7%,rgba(255,206,120,.55) 22%,rgba(255,170,60,.15) 45%,rgba(255,150,40,0) 70%)}
#kick{position:absolute;inset:0;opacity:0;mix-blend-mode:screen;background:radial-gradient(ellipse at ${moment ? Math.round(moment.at[0] / W * 100) : 50}% ${moment ? Math.round(moment.at[1] / H * 100) : 40}%,rgba(255,210,140,.5) 0,rgba(255,190,100,0) 60%)}
.haze{position:absolute;width:900px;height:520px;border-radius:50%;opacity:0;mix-blend-mode:screen;background:radial-gradient(ellipse,rgba(150,170,230,.55) 0,rgba(120,140,210,0) 70%);filter:blur(30px)}
#hz1{left:-200px;top:${Math.round(H * 0.48)}px} #hz2{left:420px;top:${Math.round(H * 0.57)}px}
#dark{position:absolute;inset:0;background:#000}
#vig{position:absolute;inset:0;background:radial-gradient(ellipse at 40% 55%,rgba(0,0,0,0) 50%,rgba(0,0,0,.35) 100%)}
</style>
<svg width="0" height="0" style="position:absolute"><filter id="vb10"><feGaussianBlur stdDeviation="0 10"/></filter><filter id="vb4"><feGaussianBlur stdDeviation="0 4"/></filter><filter id="hb10"><feGaussianBlur stdDeviation="10 0"/></filter><filter id="hb4"><feGaussianBlur stdDeviation="4 0"/></filter><filter id="mbA"><feGaussianBlur stdDeviation="6 22"/></filter><filter id="mbB"><feGaussianBlur stdDeviation="4 14"/></filter><filter id="mbC"><feGaussianBlur stdDeviation="2 7"/></filter><filter id="mbD"><feGaussianBlur stdDeviation="1 3"/></filter></svg>
<div id="st" data-composition-id="ad" data-width="${W}" data-height="${H}">
 <div id="cam">
  ${body.join('\n  ')}
  ${flHtml}
  ${bsHtml}
  <div id="popflash"></div><div id="kick"></div>
  <div class="haze" id="hz1"></div><div class="haze" id="hz2"></div>
 </div>
 <div id="vig"></div><img class="L" id="final" src="assets/final.png" style="opacity:0"/><div id="dark"></div>
</div>
<script>var P=${JSON.stringify(P)};
${fs.readFileSync(path.join(HERE, 'runtime3.js'), 'utf8')}</script></template>`);
const r = spawnSync('npx', ['--yes', 'hyperframes@0.8.225', 'render', '--output', path.join(HF, 'silent.mp4')], { cwd: HF, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1' } });
if (r.status !== 0) throw new Error('render failed');

// ---------- sound design: the event list (same timing as the runtime) -> cues ----------
const EV = [];
for (const s of solids) {
  if (s.enter && ['rise', 'drop', 'slide_left', 'slide_right'].includes(s.enter.type)) { EV.push({ type: 'whoosh_in', t: s.enter.t, land: s.enter.t + s.enter.dur * 0.55 }); EV.push({ type: 'land', t: s.enter.t + s.enter.dur * 0.55 }); }
  else if (s.enter && s.enter.type === 'scale_in') EV.push({ type: 'pop_in', t: s.enter.t + s.enter.dur * 0.3 });
  if (s.sweep) EV.push({ type: 'sweep', t: s.sweep.t + 0.3 });
}
if (moment) EV.push({ type: 'moment', t: moment.t, kind: moment.type, fizz: moment.fizz });
for (const g of glows) { const r = g.reveal; if (r.type === 'grow_from') EV.push({ type: 'grow', t: r.t, dur: r.dur }); if (r.type === 'bloom') EV.push({ type: 'bloom', t: r.t }); }
for (const T of texts) {
  if (T.anim === 'wipe_words') (T.words.length ? T.words : [0]).forEach((w, j) => EV.push({ type: 'word', t: T.t + j * 0.3, j }));
  else EV.push({ type: T.anim === 'stamp' ? 'stamp' : T.anim === 'pop' ? 'pop_in' : 'soft_in', t: T.anim === 'stamp' ? T.t + 0.33 : T.t });
  if (T.glint) EV.push({ type: 'glint', t: T.glint + 0.5 });
}
if (rule) EV.push({ type: 'rule', t: rule.t });
if (pulse) EV.push({ type: 'pulse', t: pulse.t, dur: pulse.dur });
if (sparks.length) EV.push({ type: 'sparks', t: sparks[0].t });
if (P.twinkle && accent) EV.push({ type: 'twinkle', t: P.twinkle.t });
const has = (id) => !!META[id];
const cues = [];   // {id, at (video time of the align point), align:'onset'|'peak', vol, fx, trimEnd}
const cue = (id, at, vol, o = {}) => { if (has(id)) cues.push(Object.assign({ id, at, vol: Math.max(vol, id.startsWith('hit_') ? 0.3 : vol), align: id.startsWith('amb_') ? 'onset' : 'peak' }, o)); };
let wordN = 0;
for (const e of EV) {
  if (e.type === 'whoosh_in') cue('hit_whoosh', e.land - 0.05, 0.3, { align: 'peak', fadeOut: 0.2 });
  if (e.type === 'land') cue('hit_boom', e.t, 0.22, { fx: 'lowpass=f=220', len: 1.3 });
  if (e.type === 'moment') {
    cue('hit_riser', e.t - 0.04, 0.35, { align: 'peak', len: 1.0, fadeOut: 0.08 });
    if (e.kind === 'pop') { cue('hit_cork_pop', e.t, 1.15); cue('hit_pop_crack', e.t, 1.0); cue('hit_boom', e.t - 0.01, 0.85, { fx: 'lowpass=f=160', len: 0.7 }); }
    else if (e.kind === 'splash') { cue('hit_pour_ice', e.t, 0.9); cue('hit_boom', e.t, 0.5, { fx: 'lowpass=f=160', len: 0.7 }); }
    else if (e.kind === 'spark') { cue('hit_sparkle', e.t, 0.8, { align: 'peak' }); cue('hit_boom', e.t, 0.4, { fx: 'lowpass=f=200', len: 0.7 }); }
    else { cue('hit_boom', e.t, 0.95); cue('hit_pop_crack', e.t, 0.8); }
    if (e.fizz) cue('hit_can_fizz', e.t + 0.06, 0.2);
  }
  if (e.type === 'grow') cue('amb_light_whoosh', e.t, 0.32, { len: Math.min(1.1, e.dur + 0.1), fadeIn: 0.2, fadeOut: 0.3 });
  if (e.type === 'bloom') { cue('hit_sparkle', e.t, 0.5, { align: 'peak' }); cue('hit_ding', e.t, 0.26); }
  if (e.type === 'word') { cue('hit_ding', e.t, wordN % 2 ? 0.15 : 0.18); wordN++; }
  if (e.type === 'stamp') cue('hit_stamp', e.t, 0.7);
  if (e.type === 'pop_in') cue('hit_cartoon_pop', e.t, 0.5);
  if (e.type === 'soft_in') cue('hit_whoosh', e.t + 0.3, 0.18, { align: 'peak' });
  if (e.type === 'rule') cue('hit_sparkle', e.t + 0.45, 0.16, { align: 'peak', fadeIn: 0.2 });
  if (e.type === 'glint' || e.type === 'sweep') cue('hit_glass_shing', e.t, e.type === 'sweep' ? 1.2 : 0.7);
  if (e.type === 'pulse') cue('amb_light_whoosh', e.t, 0.42, { len: e.dur + 0.1, fadeIn: 0.25, fadeOut: 0.3 });
  if (e.type === 'sparks') cue('hit_sparkle', e.t + 0.45, 0.22, { align: 'peak', fadeIn: 0.1 });
  if (e.type === 'twinkle') cue('hit_ding', e.t, 0.38, { fx: 'aecho=0.8:0.75:140|280|420:0.45|0.3|0.18' });
}
// music bed by mood, aligned so its own ending lands at the end of the video; ducked under the moment
const beds = { luxury: 'bed_luxury', energy: 'bed_energy', ramadan: 'bed_ramadan', fun: 'bed_fun', tech: 'bed_tech', shaabi: 'bed_shaabi', calm: 'bed_calm', epic: 'bed_epic', food: 'bed_food', corporate: 'bed_corporate' };
let bed = plan.music && has(plan.music) ? plan.music : beds[plan.mood] || 'bed_luxury';
if (!has(bed)) bed = 'bed_luxury';
const bm = META[bed];
let bedOff = Math.max(bm.onset, bm.end - D + 0.2), tempo = 1;
if (bm.end - bedOff < D - 0.15) { tempo = Math.max(0.82, (bm.end - bedOff) / (D - 0.15)); }
const args = ['-v', 'error', '-y', '-i', path.join(HF, 'silent.mp4')], ch = [];
const duck = moment ? `volume='if(between(t,${(moment.t - 0.08).toFixed(2)},${(moment.t + 0.3).toFixed(2)}),0.55,1)':eval=frame,` : '';
args.push('-i', path.join(LIB, bed + '.wav'));
const loop = tempo < 1 ? `atempo=${tempo.toFixed(3)},` : '';
ch.push(`[1:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=start=${bedOff.toFixed(3)},asetpts=PTS-STARTPTS,${loop}afade=t=in:d=0.15,volume=0.5,${duck}anull[b0]`);
cues.forEach((c, i) => {
  const m = META[c.id], ap = c.align === 'peak' ? m.peak : m.onset;
  let start = c.at - ap, trim = 0; if (start < 0) { trim = -start; start = 0; }
  const len = c.len ? `,atrim=0:${c.len}` : '';
  const fi = c.fadeIn ? `,afade=t=in:d=${c.fadeIn}` : '';
  const fo = c.fadeOut && c.len ? `,afade=t=out:st=${Math.max(0, c.len - c.fadeOut).toFixed(2)}:d=${c.fadeOut}` : '';
  const fx = c.fx ? ',' + c.fx : '';
  args.push('-i', path.join(LIB, c.id + '.wav'));
  ch.push(`[${i + 2}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=start=${trim.toFixed(3)},asetpts=PTS-STARTPTS${len}${fi}${fo}${fx},adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)},volume=${c.vol}[c${i}]`);
});
const ins = ['[b0]'].concat(cues.map((_, i) => `[c${i}]`)).join('');
ch.push(`${ins}amix=inputs=${cues.length + 1}:normalize=0,volume=1.5,apad,atrim=0:${D},afade=t=out:st=${D - 0.25}:d=0.25,alimiter=limit=0.85,loudnorm=I=-14:TP=-2,aresample=48000[out]`);
args.push('-filter_complex', ch.join(';'), '-map', '0:v', '-map', '[out]', '-c:v', 'libx264', '-crf', '15', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', OUT);
if (spawnSync('ffmpeg', args, { stdio: 'inherit' }).status !== 0) throw new Error('mux failed');
fs.writeFileSync(path.join(WORK, 'cues.json'), JSON.stringify({ bed, bedOff, events: EV, cues }, null, 1));

// ---------- After Effects package: every layer as its own file + the timing sheet + sound ----------
if (OUTZIP) {
  const ae = path.join(WORK, 'ae3'); fs.rmSync(ae, { recursive: true, force: true }); fs.mkdirSync(path.join(ae, 'layers'), { recursive: true });
  fs.copyFileSync(path.join(SC, 'bg.png'), path.join(ae, 'layers', '00_bg.png'));
  scene.layers.forEach((l, i) => fs.copyFileSync(path.join(SC, l.file), path.join(ae, 'layers', String(i + 1).padStart(2, '0') + '_' + l.name + '.png')));
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', OUT, '-vn', '-c:a', 'pcm_s16le', path.join(ae, 'sound.wav')]);
  fs.copyFileSync(OUT, path.join(ae, 'reference.mp4'));
  const files = ['00_bg.png'].concat(scene.layers.map((l, i) => String(i + 1).padStart(2, '0') + '_' + l.name + '.png'));
  fs.writeFileSync(path.join(ae, 'build.jsx'), `// Joker motion v3 — imports every layer in order (bottom to top), the sound, and marks every beat.
(function(){ var R=File($.fileName).parent; app.beginUndoGroup("Joker motion v3");
var proj=app.project||app.newProject(), fol=proj.items.addFolder("Joker layers");
var comp=proj.items.addComp("Design motion",${W},${H},1,${D},${FPS});
var F=${JSON.stringify(files)};
for(var i=0;i<F.length;i++){ var it=proj.importFile(new ImportOptions(new File(R.fsName+"/layers/"+F[i]))); it.parentFolder=fol; var L=comp.layers.add(it); L.name=F[i].replace(".png",""); }
var s=proj.importFile(new ImportOptions(new File(R.fsName+"/sound.wav"))); s.parentFolder=fol; comp.layers.add(s);
var E=${JSON.stringify(EV.map((e) => [e.t, e.type]))};
for(var j=0;j<E.length;j++){ var m=new MarkerValue(E[j][1]); comp.markerProperty.setValueAtTime(E[j][0],m); }
comp.openInViewer(); app.endUndoGroup(); })();`);
  fs.writeFileSync(path.join(ae, 'README.txt'), 'After Effects: File > Scripts > Run Script File > build.jsx. It stacks every layer of the design in order (bottom to top) with the sound, and puts a marker on every beat of the animation (name = what happens). reference.mp4 is the finished animation to match.\n');
  fs.rmSync(OUTZIP, { force: true });
  if (spawnSync('zip', ['-qr', OUTZIP, '.'], { cwd: ae }).status !== 0) throw new Error('zip failed');
}
console.log('done', OUT, 'events', EV.length, 'cues', cues.length, 'bed', bed);
