// Joker motion v2 — compositor. Plays the director's plan over the prepared scene:
// 2.5D background video + exact subject with its own action + code effects + the design's own text lines
// animated + a sound mix from the library. Renders MP4 (HyperFrames) and an After Effects package.
// usage: node compose.js <work_dir> <out.mp4> <out-ae.zip>
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const [, , WORK, OUT, OUTZIP] = process.argv;
const HERE = __dirname, SC = path.join(WORK, 'scene');
const scene = JSON.parse(fs.readFileSync(path.join(SC, 'scene.json'), 'utf8'));
const plan = JSON.parse(fs.readFileSync(path.join(WORK, 'plan.json'), 'utf8'));
const W = scene.W, H = scene.H, D = scene.dur, FPS = scene.fps, cam = scene.camera;
const LIB = path.join(HERE, '..', 'sfxlib'), work = path.join(WORK, 'hf');
fs.rmSync(work, { recursive: true, force: true });
for (const d of ['assets', 'compositions', 'vendor']) fs.mkdirSync(path.join(work, d), { recursive: true });
fs.copyFileSync(path.join(SC, 'bg.mp4'), path.join(work, 'assets/bg.mp4'));
if (scene.subject) fs.copyFileSync(path.join(SC, 'subject.png'), path.join(work, 'assets/subject.png'));
for (const t of scene.texts) fs.copyFileSync(path.join(SC, t.file), path.join(work, 'assets', t.file));
fs.copyFileSync(path.join(HERE, '..', 'motion-vendor/gsap.min.js'), path.join(work, 'vendor/gsap.min.js'));
fs.copyFileSync(path.join(HERE, '..', 'motion-vendor/hyperframes.json'), path.join(work, 'hyperframes.json'));

// ---------- plan with safe defaults ----------
const num = (v, d, lo, hi) => { v = Number(v); if (!isFinite(v)) v = d; return Math.max(lo, Math.min(hi, v)); };
const act = Object.assign({ type: 'none' }, (plan.subject || {}).action || {});
const textPlan = scene.texts.map((t) => {
  const p = (plan.texts || [])[t.i] || {};
  if (t.covers_subject) return { ...t, anim: 'settle', t: 0, glow: p.glow };   // in front of the hero: visible from frame 0
  return { ...t, anim: p.anim || 'rise', t: num(p.t, 0.6 + t.i * 0.45, 0.15, D - 1.5), glow: p.glow };
});
const fxs = (plan.fx || []).slice(0, 4);
const grain = num(plan.grain, 0.08, 0, 0.35), vig = num(plan.vignette, 0.3, 0, 0.7);
const shakes = (plan.shake || []).filter((s) => Array.isArray(s)).map((s) => [num(s[0], 1, 0, D), num(s[1], 6, 0, 14)]).slice(0, 3);
const flashes = (plan.flash || []).filter((s) => Array.isArray(s)).map((s) => [num(s[0], 1, 0, D), num(s[1], 0.6, 0, 1)]).slice(0, 3);

// ---------- effects (seeded, identical every render) ----------
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const parts = [];
for (const f of fxs) {
  const n = Math.round(num(f.amount, 1, 0.2, 2) * 100);
  const at = Array.isArray(f.at) ? f.at : [W / 2, H / 2];
  if (f.type === 'rain') for (let i = 0; i < n * 2.5; i++) parts.push({ k: 'rain', x: rnd() * (W + 200) - 100, len: 25 + rnd() * 45, sp: 0.35 + rnd() * 0.35, d0: rnd(), op: 0.15 + rnd() * 0.3, w: rnd() < 0.15 ? 2.2 : 1.2, front: rnd() < 0.3 });
  if (f.type === 'snow') for (let i = 0; i < n; i++) parts.push({ k: 'snow', x: rnd() * W, sz: 3 + rnd() * 7, sp: 3 + rnd() * 4, d0: rnd() * 6, drift: (rnd() - 0.5) * 80, front: rnd() < 0.4 });
  if (f.type === 'dust' || f.type === 'smoke' || f.type === 'steam') for (let i = 0; i < n * 0.5; i++) {
    const life = f.type === 'dust' ? 0.9 + rnd() * 1.1 : 1.8 + rnd() * 1.6;
    parts.push({ k: 'puff', x: at[0] + (rnd() - 0.5) * 80, y: at[1] + (rnd() - 0.5) * 30, vx: f.type === 'dust' ? -(60 + rnd() * 160) * (f.dir === 'right' ? -1 : 1) : (rnd() - 0.5) * 60, vy: f.type === 'dust' ? -(20 + rnd() * 90) : -(120 + rnd() * 160), sz: (f.type === 'dust' ? 12 : 40) + rnd() * 46, life, d0: rnd() * life, color: f.color || (f.type === 'dust' ? '#e9d9b8' : '#ffffff'), op: f.type === 'steam' ? 0.35 : 0.8, front: true });
  }
  if (f.type === 'sparks' || f.type === 'confetti') for (let i = 0; i < n * 0.6; i++) {
    const a = rnd() * Math.PI * 2, v = 200 + rnd() * 500, life = 0.6 + rnd() * 0.9;
    parts.push({ k: f.type, x: at[0], y: at[1], vx: Math.cos(a) * v, vy: Math.sin(a) * v - 200, life, t0: num(f.t, 1, 0, D - 1) + rnd() * 0.25, sz: f.type === 'sparks' ? 3 + rnd() * 3 : 8 + rnd() * 10, color: f.type === 'sparks' ? (f.color || '#ffd36a') : ['#ff4d6d', '#ffd23f', '#3ec1d3', '#7bd389', '#ffffff'][i % 5], rot: rnd() * 720, front: true });
  }
  if (f.type === 'bokeh') for (let i = 0; i < n * 0.25; i++) parts.push({ k: 'bokeh', x: rnd() * W, y: rnd() * H, sz: 30 + rnd() * 90, color: f.color || 'rgba(255,220,150,0.5)', d0: rnd() * 6, sp: 4 + rnd() * 4, front: false });
  if (f.type === 'flare') parts.push({ k: 'flare', x: at[0], y: at[1], r: num(f.size, 150, 40, 400), color: f.color || 'rgba(255,200,90,0.85)', sub: true });
  if (f.type === 'light_sweep') parts.push({ k: 'sweep', t0: num(f.t, 2.2, 0, D - 1), sub: true });
}
const pHtml = (p, i) => {
  if (p.k === 'rain') return `<div class="fx" id="p${i}" style="left:${p.x.toFixed(1)}px;top:-80px;width:${p.w}px;height:${p.len.toFixed(0)}px;background:linear-gradient(to bottom,rgba(220,235,255,0),rgba(220,235,255,${p.op.toFixed(2)}));transform:rotate(10deg)"></div>`;
  if (p.k === 'snow') return `<div class="fx" id="p${i}" style="left:${p.x.toFixed(0)}px;top:-20px;width:${p.sz.toFixed(1)}px;height:${p.sz.toFixed(1)}px;border-radius:50%;background:rgba(255,255,255,.85);filter:blur(1px)"></div>`;
  if (p.k === 'puff') return `<div class="fx" id="p${i}" style="left:${p.x.toFixed(0)}px;top:${p.y.toFixed(0)}px;width:${p.sz.toFixed(0)}px;height:${p.sz.toFixed(0)}px;border-radius:50%;background:radial-gradient(circle,${p.color} 0%,rgba(255,255,255,0) 70%);opacity:0"></div>`;
  if (p.k === 'sparks') return `<div class="fx" id="p${i}" style="left:${p.x}px;top:${p.y}px;width:${p.sz}px;height:${p.sz}px;border-radius:50%;background:${p.color};box-shadow:0 0 8px ${p.color};opacity:0;mix-blend-mode:screen"></div>`;
  if (p.k === 'confetti') return `<div class="fx" id="p${i}" style="left:${p.x}px;top:${p.y}px;width:${p.sz}px;height:${(p.sz * 0.5).toFixed(1)}px;background:${p.color};opacity:0"></div>`;
  if (p.k === 'bokeh') return `<div class="fx" id="p${i}" style="left:${p.x.toFixed(0)}px;top:${p.y.toFixed(0)}px;width:${p.sz.toFixed(0)}px;height:${p.sz.toFixed(0)}px;border-radius:50%;background:radial-gradient(circle,${p.color} 0%,rgba(255,255,255,0) 68%);mix-blend-mode:screen;opacity:0"></div>`;
  if (p.k === 'flare') return `<div class="fx" id="p${i}" style="left:${p.x - p.r}px;top:${p.y - p.r}px;width:${p.r * 2}px;height:${p.r * 2}px;border-radius:50%;background:radial-gradient(circle,${p.color} 0%,rgba(255,180,60,0.25) 35%,rgba(255,160,40,0) 70%);mix-blend-mode:screen"></div>`;
  if (p.k === 'sweep') return `<div class="fx" id="p${i}" style="left:0;top:0;width:${W}px;height:${H}px;mix-blend-mode:screen;opacity:0.9;background:linear-gradient(105deg,rgba(255,255,255,0) 40%,rgba(255,255,255,.55) 50%,rgba(255,255,255,0) 60%);background-size:300% 100%;background-position:120% 0;-webkit-mask-image:url(assets/subject.png);mask-image:url(assets/subject.png);-webkit-mask-size:${W}px ${H}px;mask-size:${W}px ${H}px"></div>`;
};
const back = parts.map((p, i) => [p, i]).filter(([p]) => !p.front && !p.sub).map(([p, i]) => pHtml(p, i)).join('\n');
const front = parts.map((p, i) => [p, i]).filter(([p]) => p.front).map(([p, i]) => pHtml(p, i)).join('\n');
const onSubj = parts.map((p, i) => [p, i]).filter(([p]) => p.sub).map(([p, i]) => pHtml(p, i)).join('\n');
const kSub = scene.subject ? (cam.base + (1 - cam.base) * scene.subject.depth) : 0;

fs.writeFileSync(path.join(work, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=${W}, height=${H}"><script src="vendor/gsap.min.js"></script>
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000}#root{position:relative;width:100%;height:100%}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-fps="${FPS}" data-width="${W}" data-height="${H}">
<video id="bg" class="clip" src="assets/bg.mp4" muted data-start="0" data-duration="${D}" data-track-index="0" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px"></video>
<div id="ad" data-composition-id="ad" data-composition-src="compositions/ad.html" data-start="0" data-duration="${D}" data-track-index="1" data-track-kind="graphics" data-width="${W}" data-height="${H}"></div>
</div><script>window.__timelines=window.__timelines||{};window.__timelines["main"]=gsap.timeline({paused:true});</script></body></html>`);

const textsHtml = scene.texts.map((t) => `<img class="ty" id="${t.file.replace('.png', '')}" src="assets/${t.file}" style="left:${t.left}px;top:${t.top}px" />`).join('\n');
const P = { D, W, H, FPS, parts, kSub, cam, act, textPlan, shakes, flashes, sub: !!scene.subject };
fs.writeFileSync(path.join(work, 'compositions/ad.html'), `<template><style>
#st{position:absolute;inset:0;overflow:hidden} .fx{position:absolute;pointer-events:none}
#subj{position:absolute;left:0;top:0;width:${W}px;height:${H}px;transform-origin:${W / 2}px ${H / 2}px}
#subj img{position:absolute;left:0;top:0;width:${W}px;height:${H}px}
.ty{position:absolute;transform-origin:50% 50%;opacity:0}
#grain{position:absolute;inset:-20px;opacity:${grain};mix-blend-mode:overlay;background-image:repeating-radial-gradient(circle at 17% 32%,rgba(255,255,255,.35) 0 1px,transparent 1px 3px),repeating-radial-gradient(circle at 71% 63%,rgba(0,0,0,.35) 0 1px,transparent 1px 4px)}
#vig{position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(0,0,0,0) 55%,rgba(0,0,0,${vig}) 100%)}
#flash{position:absolute;inset:0;background:#fff;opacity:0}
</style>
<div id="st" data-composition-id="ad" data-width="${W}" data-height="${H}">
  ${back}
  ${scene.subject_front ? textsHtml : ''}
  ${scene.subject ? `<div id="subj"><img id="simg" src="assets/subject.png" />${onSubj}</div>` : ''}
  ${front}
  <div id="vig"></div><div id="grain"></div>
  ${scene.subject_front ? '' : textsHtml}
  <div id="flash"></div>
</div>
<script>(function(){ var tl=gsap.timeline({paused:true}), P=${JSON.stringify(P)}, D=P.D;
var smooth=function(t){return t*t*(3-2*t);};
if(P.sub){
 var k=P.kSub, s0=1+(P.cam.zoom[0]-1)*k, s1=1+(P.cam.zoom[1]-1)*k;
 tl.fromTo('#subj',{scale:s0,x:P.cam.x[0]*k,y:P.cam.y[0]*k},{scale:s1,x:P.cam.x[1]*k,y:P.cam.y[1]*k,duration:D,ease:smooth},0);
 var a=P.act, im='#simg', amp=Math.min(a.amp||5,8);
 if(a.type==='bounce'){ for(var t=0;t<D;t+=1/30){ var b=Math.abs(Math.sin(t*Math.PI*(a.speed||2.4))); tl.set(im,{y:(-b*amp).toFixed(2),rotation:(Math.sin(t*Math.PI*(a.speed||2.4)*0.5)*0.35).toFixed(2),transformOrigin:'50% 100%'},t);} }
 else if(a.type==='float'){ tl.to(im,{y:-amp,duration:1.5,ease:'sine.inOut',yoyo:true,repeat:Math.ceil(D/1.5)},0); }
 else if(a.type==='sway'){ tl.set(im,{transformOrigin:'50% 100%'},0); tl.to(im,{rotation:Math.min(amp*0.3,1.6),duration:1.4,ease:'sine.inOut',yoyo:true,repeat:Math.ceil(D/1.4)},0); }
 else if(a.type==='pulse'){ tl.to(im,{scale:1.02,duration:0.9,ease:'sine.inOut',yoyo:true,repeat:Math.ceil(D/0.9),transformOrigin:'50% 60%'},0); }
 else if(a.type==='approach'){ tl.fromTo(im,{scale:1},{scale:1.04,duration:D,ease:'none',transformOrigin:'50% 80%'},0); for(var t2=0;t2<D;t2+=1/30){ tl.set(im,{x:(Math.sin(t2*61)*0.5).toFixed(2),y:(Math.cos(t2*47)*0.5).toFixed(2)},t2);} }
 else if(a.type==='rumble'){ for(var t3=0;t3<D;t3+=1/30){ tl.set(im,{x:(Math.sin(t3*71)*1.1).toFixed(2),y:(Math.cos(t3*53)*1.1).toFixed(2)},t3);} }
 else if(a.type==='pop_in'){ tl.fromTo(im,{scale:0.9,transformOrigin:'50% 60%'},{scale:1,duration:0.7,ease:'back.out(2.4)'},a.t||0.2); }
}
P.parts.forEach(function(p,i){ var el=document.getElementById('p'+i); if(!el) return;
 if(p.k==='rain'){ for(var j=0;;j++){ var st=j*p.sp-p.d0*p.sp; if(st>D) break; tl.fromTo(el,{y:0,x:0},{y:P.H+160,x:-(P.H+160)*0.18,duration:p.sp,ease:'none',immediateRender:false},Math.max(0,st)); } }
 if(p.k==='snow'){ for(var j2=0;;j2++){ var s2=j2*p.sp-p.d0; if(s2>D) break; tl.fromTo(el,{y:0,x:0},{y:P.H+40,x:p.drift,duration:p.sp,ease:'none',immediateRender:false},Math.max(0,s2)); } }
 if(p.k==='puff'){ for(var q=0;;q++){ var s=q*p.life-p.d0; if(s>D) break; tl.fromTo(el,{x:0,y:0,opacity:p.op,scale:0.3},{x:p.vx,y:p.vy,opacity:0,scale:1.8,duration:p.life,ease:'power1.out',immediateRender:false},Math.max(0,s)); } }
 if(p.k==='sparks'||p.k==='confetti'){ tl.fromTo(el,{x:0,y:0,opacity:1,rotation:0},{x:p.vx*p.life,y:p.vy*p.life+400*p.life*p.life,opacity:p.k==='sparks'?0:1,rotation:p.rot||0,duration:p.life,ease:'power1.out',immediateRender:false},p.t0); if(p.k==='confetti') tl.to(el,{opacity:0,duration:0.4,immediateRender:false},p.t0+p.life); }
 if(p.k==='bokeh'){ tl.fromTo(el,{opacity:0,y:0},{opacity:0.8,y:-40,duration:p.sp/2,ease:'sine.inOut',yoyo:true,repeat:3,immediateRender:false},p.d0%2); }
 if(p.k==='flare'){ for(var f=0;f<D;f+=2/30){ tl.set(el,{opacity:(0.75+0.25*Math.sin(f*7)+0.1*Math.sin(f*31)).toFixed(2),scale:(1+0.06*Math.sin(f*5)).toFixed(3)},f);} }
 if(p.k==='sweep'){ tl.fromTo(el,{backgroundPosition:'120% 0'},{backgroundPosition:'-20% 0',duration:0.9,ease:'power2.inOut',immediateRender:false},p.t0); }
});
for(var g=0;g<D;g+=2/30){ tl.set('#grain',{x:((g*997)%17-8).toFixed(0),y:((g*577)%13-6).toFixed(0)},g); }
// text: whole glyphs only, right-to-left soft reveals, colours untouched
P.textPlan.forEach(function(l){ var el=document.getElementById(l.file.replace('.png','')), t=l.t;
 el.style.webkitMaskImage=el.style.maskImage='linear-gradient(to left, #000 calc(var(--p, 118) * 1% - 18%), transparent calc(var(--p, 118) * 1%))';
 var wipe=function(d){ tl.set(el,{opacity:1,'--p':0},0); tl.to(el,{'--p':118,duration:d,ease:'power2.inOut'},t); };
 if(l.anim==='stamp'){ tl.set(el,{opacity:0,scale:1.7,rotation:-5,filter:'blur(8px)'},0); tl.to(el,{opacity:1,scale:0.96,rotation:0.6,filter:'blur(0px)',duration:0.2,ease:'power4.in'},t); tl.to(el,{scale:1,rotation:0,duration:0.4,ease:'back.out(2.6)'},t+0.2); }
 else if(l.anim==='reveal'){ wipe(0.7); }
 else if(l.anim==='banner'){ wipe(0.55); tl.fromTo(el,{x:24},{x:0,duration:0.7,ease:'power3.out',immediateRender:false},t); }
 else if(l.anim==='slide'){ tl.set(el,{opacity:0,x:60},0); tl.to(el,{opacity:1,x:0,duration:0.7,ease:'expo.out'},t); }
 else if(l.anim==='neon'){ tl.set(el,{opacity:0},0); [[0,0.85],[0.05,0.08],[0.11,1],[0.18,0.2],[0.24,1],[0.46,0.55],[0.5,1]].forEach(function(s){ tl.set(el,{opacity:s[1]},t+s[0]); }); tl.fromTo(el,{filter:'drop-shadow(0 0 16px '+(l.glow||'rgba(255,180,40,0.8)')+')'},{filter:'drop-shadow(0 0 0px rgba(0,0,0,0))',duration:1.4,ease:'power2.out',immediateRender:false},t+0.5); }
 else if(l.anim==='pop'){ tl.set(el,{opacity:0,scale:0.6},0); tl.to(el,{opacity:1,scale:1,duration:0.5,ease:'back.out(2.2)'},t); }
 else if(l.anim==='drop'){ tl.set(el,{opacity:0,y:-120},0); tl.to(el,{opacity:1,y:0,duration:0.65,ease:'bounce.out'},t); }
 else if(l.anim==='zoom'){ tl.set(el,{opacity:0,scale:1.25,filter:'blur(10px)'},0); tl.to(el,{opacity:1,scale:1,filter:'blur(0px)',duration:0.8,ease:'expo.out'},t); }
 else if(l.anim==='settle'){ tl.set(el,{opacity:1,scale:1.035},0); tl.to(el,{scale:1,duration:1.6,ease:'power2.out'},0); tl.fromTo(el,{filter:'brightness(1.25)'},{filter:'brightness(1)',duration:1.2,ease:'power2.out',immediateRender:false},0.75); }
 else { tl.set(el,{opacity:0,y:34,filter:'blur(14px)'},0); tl.to(el,{opacity:1,y:0,filter:'blur(0px)',duration:0.85,ease:'power3.out'},t); }
});
P.shakes.forEach(function(h){ for(var q=0;q<10;q++){ var d=Math.exp(-q*0.45)*h[1]; tl.set('#st',{x:(q%2?d:-d).toFixed(1),y:(q%3?-d:d*0.6).toFixed(1)},h[0]+q/30); } tl.set('#st',{x:0,y:0},h[0]+10/30); });
P.flashes.forEach(function(x){ tl.set('#flash',{opacity:x[1]},x[0]); tl.to('#flash',{opacity:0,duration:0.14,ease:'power2.out'},x[0]+1/30); });
window.__timelines["ad"]=tl; })();</script></template>`);

const r = spawnSync('npx', ['--yes', 'hyperframes@0.8.225', 'render', '--output', path.join(work, 'silent.mp4')], { cwd: work, stdio: 'inherit', env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: '1' } });
if (r.status !== 0) throw new Error('render failed');

// ---------- sound: ambience bed + music + hits, from the library ----------
const lib = fs.readdirSync(LIB).filter((f) => f.endsWith('.wav')).map((f) => f.replace('.wav', ''));
const snd = plan.sound || {};
const cues = [];
const pick = (id) => (id && lib.includes(id) ? id : null);
if (pick(snd.ambience)) cues.push([snd.ambience, 0, num(snd.ambience_vol, 0.6, 0, 1)]);
if (pick(snd.ambience2)) cues.push([snd.ambience2, 0, num(snd.ambience2_vol, 0.45, 0, 1)]);
if (pick(snd.music)) cues.push([snd.music, 0, num(snd.music_vol, 0.7, 0, 1)]);
for (const h of (snd.hits || []).slice(0, 8)) if (pick(h.id)) cues.push([h.id, num(h.t, 0, 0, D - 0.1), num(h.vol, 0.8, 0, 1)]);
if (!cues.length) cues.push(['hit_whoosh', 0.4, 0.6]);
const args = ['-v', 'error', '-y', '-i', path.join(work, 'silent.mp4')], ch = [];
cues.forEach(([id, t, v], i) => { args.push('-i', path.join(LIB, id + '.wav')); const ms = Math.round(t * 1000); ch.push(`[${i + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${ms}|${ms},volume=${v}[a${i}]`); });
ch.push(cues.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${cues.length}:normalize=0,apad,atrim=0:${D},afade=t=out:st=${D - 0.5}:d=0.5,alimiter=limit=0.9,loudnorm=I=-14:TP=-1[out]`);
args.push('-filter_complex', ch.join(';'), '-map', '0:v', '-map', '[out]', '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', OUT);
if (spawnSync('ffmpeg', args, { stdio: 'inherit' }).status !== 0) throw new Error('mux failed');
spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', OUT, '-vn', '-c:a', 'pcm_s16le', path.join(WORK, 'mix.wav')]);

// ---------- After Effects package ----------
if (OUTZIP) {
  const ae = path.join(WORK, 'ae'); fs.rmSync(ae, { recursive: true, force: true }); fs.mkdirSync(path.join(ae, 'footage'), { recursive: true });
  fs.copyFileSync(path.join(SC, 'bg.mp4'), path.join(ae, 'footage/background.mp4'));
  if (scene.subject) fs.copyFileSync(path.join(SC, 'subject.png'), path.join(ae, 'footage/subject.png'));
  for (const t of scene.texts) fs.copyFileSync(path.join(SC, t.file), path.join(ae, 'footage', t.file));
  fs.copyFileSync(path.join(WORK, 'mix.wav'), path.join(ae, 'footage/sound.wav'));
  fs.copyFileSync(OUT, path.join(ae, 'reference.mp4'));
  fs.writeFileSync(path.join(ae, 'build.jsx'), aeScript());
  fs.writeFileSync(path.join(ae, 'README.txt'), 'After Effects: unzip, then File > Scripts > Run Script File > build.jsx.\nIt builds the comp "Design motion": the moving background, the subject with its action, every text line animated, rain/dust/snow as AE effects, camera shake, flashes and the sound. reference.mp4 is the finished video for comparison.\n');
  fs.rmSync(OUTZIP, { force: true });
  if (spawnSync('zip', ['-qr', OUTZIP, '.'], { cwd: ae }).status !== 0) throw new Error('zip failed');
}

function aeScript() {
  const A = { W, H, D, FPS, cam, kSub, act, sub: !!scene.subject, front: !!scene.subject_front, texts: textPlan, fx: fxs.map((f) => f.type), shakes, flashes };
  return `// Joker motion v2 — After Effects build script (generated). Run with File > Scripts > Run Script File.
(function () {
  var A = ${JSON.stringify(A)};
  var ROOT = File($.fileName).parent;
  app.beginUndoGroup("Joker design motion");
  var proj = app.project || app.newProject();
  var folder = proj.items.addFolder("Design motion footage");
  function imp(rel) { var it = proj.importFile(new ImportOptions(new File(ROOT.fsName + "/footage/" + rel))); it.parentFolder = folder; return it; }
  var comp = proj.items.addComp("Design motion", A.W, A.H, 1, A.D, A.FPS); comp.bgColor = [0, 0, 0]; comp.motionBlur = true;
  var bg = comp.layers.add(imp("background.mp4")); bg.name = "BACKGROUND (2.5D move)";
  function ease(p) { for (var i = 1; i <= p.numKeys; i++) { var n = (p.value instanceof Array) ? p.value.length : 1; if (p.propertyValueType === PropertyValueType.TwoD_SPATIAL) n = 1; var e = []; for (var j = 0; j < n; j++) e.push(new KeyframeEase(0, 75)); try { p.setTemporalEaseAtKey(i, e, e); } catch (x) {} } }
  if (A.sub) {
    var s = comp.layers.add(imp("subject.png")); s.name = "SUBJECT"; s.motionBlur = true;
    var k = A.kSub, sc = s.property("Scale"), po = s.property("Position");
    sc.setValueAtTime(0, [100 * (1 + (A.cam.zoom[0] - 1) * k), 100 * (1 + (A.cam.zoom[0] - 1) * k)]);
    sc.setValueAtTime(A.D, [100 * (1 + (A.cam.zoom[1] - 1) * k), 100 * (1 + (A.cam.zoom[1] - 1) * k)]);
    po.setValueAtTime(0, [A.W / 2 + A.cam.x[0] * k, A.H / 2 + A.cam.y[0] * k]);
    po.setValueAtTime(A.D, [A.W / 2 + A.cam.x[1] * k, A.H / 2 + A.cam.y[1] * k]);
    ease(sc); ease(po);
    var amp = Math.min(A.act.amp || 5, 8), sp = A.act.speed || 2.4;
    if (A.act.type === "bounce") po.expression = "value - [0, " + amp + " * Math.abs(Math.sin(time * Math.PI * " + sp + "))]";
    if (A.act.type === "float") po.expression = "value - [0, " + amp + " * Math.sin(time * Math.PI / 1.5)]";
    if (A.act.type === "rumble" || A.act.type === "approach") po.expression = "value + [Math.sin(time * 71) * 1, Math.cos(time * 53) * 1]";
    if (A.act.type === "sway") s.property("Rotation").expression = Math.min(amp * 0.3, 1.6) + " * Math.sin(time * Math.PI / 1.4)";
    if (A.act.type === "pulse") sc.expression = "value * (1 + 0.02 * Math.sin(time * Math.PI / 0.9))";
  }
  for (var f = 0; f < A.fx.length; f++) {
    var sol = comp.layers.addSolid([0, 0, 0], "FX · " + A.fx[f], A.W, A.H, 1, A.D); sol.blendingMode = BlendingMode.SCREEN;
    try {
      if (A.fx[f] === "rain") sol.property("ADBE Effect Parade").addProperty("CC Rainfall");
      else if (A.fx[f] === "snow") sol.property("ADBE Effect Parade").addProperty("CC Snowfall");
      else if (A.fx[f] === "dust" || A.fx[f] === "smoke" || A.fx[f] === "steam" || A.fx[f] === "sparks" || A.fx[f] === "confetti") sol.property("ADBE Effect Parade").addProperty("CC Particle World");
      else sol.remove();
    } catch (e) {}
  }
  for (var i = 0; i < A.texts.length; i++) {
    var t = A.texts[i], L = comp.layers.add(imp(t.file)); L.name = "TEXT " + (i + 1) + " · " + t.anim;
    var p0 = [t.left + t.w / 2, t.top + t.h / 2]; L.property("Position").setValue(p0);
    var op = L.property("Opacity"), sc2 = L.property("Scale"), pos = L.property("Position");
    op.setValueAtTime(0, 0); op.setValueAtTime(t.t, 0);
    if (t.anim === "stamp") { op.setValueAtTime(t.t + 0.05, 100); sc2.setValueAtTime(t.t, [170, 170]); sc2.setValueAtTime(t.t + 0.2, [96, 96]); sc2.setValueAtTime(t.t + 0.6, [100, 100]); ease(sc2); }
    else if (t.anim === "reveal" || t.anim === "banner") { op.setValueAtTime(t.t + 0.01, 100); var w = L.property("ADBE Effect Parade").addProperty("ADBE Linear Wipe"); w.property("Wipe Angle").setValue(90); w.property("Feather").setValue(40); var tc = w.property("Transition Completion"); tc.setValueAtTime(t.t, 100); tc.setValueAtTime(t.t + 0.7, 0); ease(tc); }
    else if (t.anim === "slide") { op.setValueAtTime(t.t + 0.4, 100); pos.setValueAtTime(t.t, [p0[0] + 60, p0[1]]); pos.setValueAtTime(t.t + 0.7, p0); ease(pos); }
    else if (t.anim === "drop") { op.setValueAtTime(t.t + 0.2, 100); pos.setValueAtTime(t.t, [p0[0], p0[1] - 120]); pos.setValueAtTime(t.t + 0.65, p0); ease(pos); }
    else if (t.anim === "pop" || t.anim === "zoom") { op.setValueAtTime(t.t + 0.25, 100); sc2.setValueAtTime(t.t, t.anim === "pop" ? [60, 60] : [125, 125]); sc2.setValueAtTime(t.t + 0.6, [100, 100]); ease(sc2); }
    else if (t.anim === "neon") { var fl = [[0, 85], [0.05, 8], [0.11, 100], [0.18, 20], [0.24, 100], [0.46, 55], [0.5, 100]]; for (var q = 0; q < fl.length; q++) op.setValueAtTime(t.t + fl[q][0], fl[q][1]); }
    else if (t.anim === "settle") { op.setValueAtTime(0, 100); sc2.setValueAtTime(0, [103.5, 103.5]); sc2.setValueAtTime(1.6, [100, 100]); ease(sc2); }
    else { op.setValueAtTime(t.t + 0.85, 100); pos.setValueAtTime(t.t, [p0[0], p0[1] + 34]); pos.setValueAtTime(t.t + 0.85, p0); ease(pos); ease(op); }
  }
  if (A.sub && A.front) { for (var li = 1; li <= comp.numLayers; li++) if (comp.layer(li).name === "SUBJECT") { comp.layer(li).moveToBeginning(); break; } }
  var cam = comp.layers.addSolid([0, 0, 0], "SHAKE", A.W, A.H, 1, A.D); cam.adjustmentLayer = true;
  var tr = cam.property("ADBE Effect Parade").addProperty("ADBE Geometry2"), tp = tr.property("Position"); tp.setValueAtTime(0, [A.W / 2, A.H / 2]);
  for (var h = 0; h < A.shakes.length; h++) for (var q2 = 0; q2 < 10; q2++) { var d = Math.exp(-q2 * 0.45) * A.shakes[h][1]; tp.setValueAtTime(A.shakes[h][0] + q2 / 30, [A.W / 2 + (q2 % 2 ? d : -d), A.H / 2 + (q2 % 3 ? -d : d * 0.6)]); }
  var fs = comp.layers.addSolid([1, 1, 1], "FLASH", A.W, A.H, 1, A.D), fo = fs.property("Opacity"); fo.setValueAtTime(0, 0);
  for (var x = 0; x < A.flashes.length; x++) { fo.setValueAtTime(A.flashes[x][0] - 0.02, 0); fo.setValueAtTime(A.flashes[x][0], A.flashes[x][1] * 100); fo.setValueAtTime(A.flashes[x][0] + 0.15, 0); }
  var au = comp.layers.add(imp("sound.wav")); au.name = "SOUND";
  comp.openInViewer();
  app.endUndoGroup();
})();
`;
}
console.log('done', OUT);
