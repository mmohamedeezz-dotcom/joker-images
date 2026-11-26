// Joker motion v3 — timeline runtime (runs inside the HyperFrames composition). P is injected before this file.
(function () {
  var tl = gsap.timeline({ paused: true }), D = P.D, W = P.W, H = P.H, EV = [];
  // a beat whose layer does not exist in this design is skipped, not an error
  ['set', 'to', 'fromTo'].forEach(function (m) { var f = tl[m].bind(tl); tl[m] = function (t) {
    if (t === null || t === undefined || t === '' || (typeof t === 'string' && !document.querySelector(t))) return tl; return f.apply(null, arguments); }; });
  var ev = function (type, t, x) { EV.push(Object.assign({ type: type, t: +(+t).toFixed(3) }, x || {})); };
  var q = function (id) { return document.getElementById(id); };
  var bez = function (pts, e) { var a = pts[0], b = pts[1], c = pts[2]; return [(1 - e) * (1 - e) * a[0] + 2 * (1 - e) * e * b[0] + e * e * c[0], (1 - e) * (1 - e) * a[1] + 2 * (1 - e) * e * b[1] + e * e * c[1]]; };
  var setMask = function (id, m, t) { tl.set('#' + id, { webkitMaskImage: m, maskImage: m }, t); };
  var OFF = 'linear-gradient(#000,#000)';

  // ---------- open ----------
  tl.fromTo('#dark', { opacity: 0.5 }, { opacity: 0, duration: 0.45, ease: 'power2.out' }, 0);
  tl.fromTo('#vig', { opacity: 1 }, { opacity: 0, duration: 1.4, ease: 'sine.inOut', immediateRender: false }, Math.min(4.2, D - 1.6));

  // ---------- camera ----------
  var cam = P.cam;
  if (cam) {
    tl.set('#cam', { scale: cam.s, x: cam.x, y: cam.y }, 0);
    tl.to('#cam', { scale: 1, x: 0, y: 0, duration: cam.p1 - cam.p0, ease: 'power2.inOut' }, cam.p0);
  }

  // ---------- solid layers: enter / eject / idle ----------
  P.solids.forEach(function (s) {
    var g = '#g' + s.k, en = s.enter, land = 0;
    if (en && en.type && en.type !== 'none') {
      var t = en.t, d = en.dur, ax = (s.axis || 0) * Math.PI / 180, far = H * 0.72;
      var from = { rise: { x: -Math.tan(ax) * far, y: far }, drop: { x: 0, y: -((s.bbox ? s.bbox[3] : H) + 80) }, slide_left: { x: -((s.bbox ? s.bbox[2] : W) + 80), y: 0 }, slide_right: { x: W - (s.bbox ? s.bbox[0] : 0) + 80, y: 0 } }[en.type];
      if (from) {
        tl.set(g, { x: from.x, y: from.y, filter: en.type === 'rise' || en.type === 'drop' ? 'url(#vb10)' : 'url(#hb10)' }, 0);
        tl.to(g, { x: 0, y: 0, duration: d, ease: 'expo.out' }, t);
        tl.set(g, { filter: en.type === 'rise' || en.type === 'drop' ? 'url(#vb4)' : 'url(#hb4)' }, t + d * 0.26); tl.set(g, { filter: 'none' }, t + d * 0.45);
        ev('whoosh_in', t, { land: t + d * 0.55 }); ev('land', t + d * 0.55);
      } else if (en.type === 'scale_in') {
        tl.fromTo(g, { scale: 0.6, opacity: 0, transformOrigin: s.c[0] + 'px ' + s.c[1] + 'px' }, { scale: 1, opacity: 1, duration: d, ease: 'back.out(1.4)', immediateRender: true }, t);
        ev('pop_in', t + d * 0.3);
      } else {
        tl.fromTo(g, { opacity: 0 }, { opacity: 1, duration: d, ease: 'power2.out', immediateRender: true }, t);
      }
      land = t + d * 0.55;
      tl.fromTo('#rim' + s.k, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'power1.out', immediateRender: true }, land);
    }
    if (s.eject) {
      var E = s.eject, seat = E.seat, rot = E.rot, sx0 = seat[0] - s.c[0], sy0 = seat[1] - s.c[1];
      // seated copy (behind the hero glass), anticipation wobble, then the real layer flies to its place
      tl.set('#seat' + s.k, { x: sx0, y: sy0, rotation: rot, transformOrigin: s.c[0] + 'px ' + s.c[1] + 'px', opacity: 1 }, 0);
      for (var n = 0; n < 10; n++) { var amp = 1 + 3 * n / 9; tl.to('#seat' + s.k, { rotation: rot + (n % 2 ? -amp : amp), y: sy0 - 2 * n / 9, duration: 0.033, ease: 'sine.inOut' }, E.t - 0.34 + n * 0.033); }
      tl.set('#seat' + s.k, { opacity: 0 }, E.t);
      tl.set(g, { opacity: 0 }, 0); tl.set(g, { opacity: 1 }, E.t);
      tl.set(g, { x: sx0, y: sy0 - 2, rotation: rot, transformOrigin: s.c[0] + 'px ' + s.c[1] + 'px' }, 0);
      tl.to(g, { x: 14, y: -26, rotation: rot + 300, duration: 0.35, ease: 'power3.out' }, E.t);
      tl.to(g, { x: 0, y: 0, rotation: 360, duration: 0.25, ease: 'sine.out' }, E.t + 0.35);
      [['url(#mbA)', 0], ['url(#mbB)', 1], ['url(#mbC)', 2], ['url(#mbD)', 3], ['none', 5]].forEach(function (k) { tl.set(g, { filter: k[0] }, E.t + k[1] / 30); });
      tl.fromTo('#rim' + s.k, { opacity: 0.3 }, { opacity: 1, duration: 0.6, ease: 'power1.in', immediateRender: false }, E.t + 0.1);
      tl.to(g, { keyframes: [{ y: -6, x: 2, rotation: 363, duration: 1.4, ease: 'sine.inOut' }, { y: 2, x: -1, rotation: 358.5, duration: 1.4, ease: 'sine.inOut' }, { y: -4, x: 1, rotation: 362, duration: 1.3, ease: 'sine.inOut' }, { y: 0, x: 0, rotation: 360, duration: Math.max(0.3, D - E.t - 0.6 - 4.1 - 0.15), ease: 'sine.inOut' }] }, E.t + 0.6);
      ev('anticipation', E.t);
    }
    if (s.idle && s.idle.type && s.idle.type !== 'none' && !s.eject) {
      var st = Math.max(land, 0.3) + 0.2, amp2 = Math.min(s.idle.amp || 6, 14), rem = D - 0.25 - st;
      if (rem > 1) {
        var kf = s.idle.type === 'sway' ? [{ rotation: amp2 * 0.15, duration: rem / 3 }, { rotation: -amp2 * 0.12, duration: rem / 3 }, { rotation: 0, duration: rem / 3 }]
          : [{ y: -amp2, duration: rem / 3 }, { y: amp2 * 0.4, duration: rem / 3 }, { y: 0, duration: rem / 3 }];
        kf.forEach(function (k) { k.ease = 'sine.inOut'; });
        tl.to('#gi' + s.k, { keyframes: kf, transformOrigin: '50% 100%' }, st);
      }
    }
  });

  // ---------- the moment (pop / impact / burst) ----------
  var M = P.moment;
  if (M) {
    tl.set('#popflash', { left: M.at[0] - 150, top: M.at[1] - 170, opacity: 0 }, 0);
    tl.fromTo('#popflash', { opacity: 0, scale: 0.3 }, { opacity: 0.6 * P.flashK, scale: 1, duration: 0.07, ease: 'power2.out', immediateRender: false }, M.t);
    tl.to('#popflash', { opacity: 0, scale: 1.5, duration: 0.5, ease: 'power2.out' }, M.t + 0.07);
    tl.fromTo('#kick', { opacity: 0 }, { opacity: 0.22 * P.flashK, duration: 0.06, immediateRender: false }, M.t); tl.to('#kick', { opacity: 0, duration: 0.7, ease: 'power2.out' }, M.t + 0.06);
    [[0, 1.012, 3], [1, 1.008, -2.5], [2, 1.005, 2], [3, 1.003, -1.2], [4, 1.001, 0.6], [5, 1, 0]].forEach(function (k) { tl.set('#st', { scale: k[1], x: k[2], y: -k[2] * 0.6 }, M.t + k[0] / 30); });
    P.burst.forEach(function (b, i) {
      tl.fromTo('#s' + i, { x: 0, y: 0, opacity: 1 }, { x: Math.cos(b.a) * b.v, y: Math.sin(b.a) * b.v + 140 * b.d * b.d, opacity: 0, duration: b.d, ease: 'power2.out', immediateRender: false }, M.t + 0.01);
    });
    tl.set('.spark', { opacity: 0 }, 0);
    ev('moment', M.t, { kind: M.type, fizz: !!M.fizz });
  }

  // ---------- glow layers ----------
  P.glows.forEach(function (gl) {
    var id = 'L_' + gl.name, r = gl.reveal || { type: 'fade', t: 0.6, dur: 0.8 };
    if (r.type === 'grow_from') {
      var el = q(id), f = r.from;
      el.style.webkitMaskImage = el.style.maskImage = 'radial-gradient(circle at ' + f[0] + 'px ' + f[1] + 'px, #000 calc(var(--r,1600)*1px - 90px), transparent calc(var(--r,1600)*1px))';
      tl.set('#' + id, { '--r': 0 }, 0); tl.to('#' + id, { '--r': gl.reach + 120, duration: r.dur, ease: 'power1.inOut' }, r.t);
      ev('grow', r.t, { dur: r.dur });
    } else if (r.type === 'burst') {
      tl.fromTo('#' + id, { opacity: 0, scale: 0.15, transformOrigin: r.from[0] + 'px ' + r.from[1] + 'px' }, { opacity: 1, scale: 1, duration: 0.5, ease: 'power3.out', immediateRender: true }, r.t);
    } else if (r.type === 'bloom') {
      tl.fromTo('#' + id, { opacity: 0, scale: 0.9, filter: 'brightness(1.7)', transformOrigin: gl.c[0] + 'px ' + gl.c[1] + 'px' }, { opacity: 1, scale: 1, filter: 'brightness(1)', duration: 0.8, ease: 'expo.out', immediateRender: true }, r.t);
      tl.set('#glow_' + gl.name, { left: gl.c[0] - gl.rad, top: gl.c[1] - gl.rad, width: gl.rad * 2, height: gl.rad * 2 }, 0);
      tl.fromTo('#glow_' + gl.name, { opacity: 0 }, { opacity: 0.45, duration: 0.25, ease: 'power2.out', immediateRender: true }, r.t + 0.05);
      tl.to('#glow_' + gl.name, { opacity: 0, duration: 1.3, ease: 'power2.inOut' }, r.t + 0.3);
      ev('bloom', r.t);
    } else if (r.type !== 'none') {
      tl.fromTo('#' + id, { opacity: 0 }, { opacity: 1, duration: r.dur || 0.8, ease: 'power2.out', immediateRender: true }, r.t);
    }
  });

  // ---------- texts ----------
  P.texts.forEach(function (T) {
    var id = 'L_text' + T.i, el = q(id), t = T.t, anim = T.anim || 'wipe_words';
    if (anim === 'wipe_words') {
      var ws = T.words.length ? T.words : [[T.bbox[0], T.bbox[2]]];
      // one copy per word (clip-path), each revealed right-to-left with a soft mask edge
      ws.forEach(function (w, j) {
        var wid = id + '_w' + j, we = q(wid), tw = t + j * 0.3, d = 0.6;
        we.style.webkitMaskImage = we.style.maskImage = 'linear-gradient(to left,#000 calc(var(--p,130)*1% - 30%),transparent calc(var(--p,130)*1%))';
        we.style.webkitMaskSize = we.style.maskSize = (w[1] - w[0]) + 'px 100%'; we.style.webkitMaskPosition = we.style.maskPosition = w[0] + 'px 0'; we.style.webkitMaskRepeat = we.style.maskRepeat = 'no-repeat';
        tl.set('#' + wid, { '--p': 0, y: 10, filter: 'blur(4px)' }, 0);
        tl.to('#' + wid, { '--p': 130, duration: d, ease: 'power2.out' }, tw);
        tl.to('#' + wid, { y: 0, filter: 'blur(0px)', duration: d + 0.15, ease: 'expo.out' }, tw);
        ev('word', tw, { j: j });
      });
    } else if (anim === 'stamp') {
      tl.fromTo('#' + id, { opacity: 0, scale: 1.5, filter: 'blur(6px)', transformOrigin: T.c[0] + 'px ' + T.c[1] + 'px' }, { opacity: 1, scale: 1, filter: 'blur(0px)', duration: 0.35, ease: 'power4.in', immediateRender: true }, t);
      ev('stamp', t + 0.33);
    } else if (anim === 'pop') {
      tl.fromTo('#' + id, { opacity: 0, scale: 0.6, transformOrigin: T.c[0] + 'px ' + T.c[1] + 'px' }, { opacity: 1, scale: 1, duration: 0.5, ease: 'back.out(2)', immediateRender: true }, t);
      ev('pop_in', t + 0.1);
    } else {
      tl.fromTo('#' + id, { opacity: 0, y: 24, filter: 'blur(8px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.8, ease: 'expo.out', immediateRender: true }, t);
      ev('soft_in', t);
    }
    if (q('L_halo' + T.i)) tl.fromTo('#L_halo' + T.i, { opacity: 0 }, { opacity: 1, duration: 0.9, ease: 'power2.out', immediateRender: true }, t + 0.15);
  });
  if (P.rule) {
    ['#L_rule', '#L_ruleglow'].forEach(function (s) { if (document.querySelector(s)) tl.fromTo(s, { clipPath: 'inset(0 50% 0 50%)' }, { clipPath: 'inset(0 0% 0 0%)', duration: 0.6, ease: 'power3.out', immediateRender: true }, P.rule.t); });
    ev('rule', P.rule.t);
  }

  // ---------- light: glints and sweeps (a narrow band, per-frame mask) ----------
  function band(id, x0, x1, t, d, rtl, pad, bw, lin) {
    var el = q(id); if (!el) return;
    var mk = function (g) { return 'linear-gradient(100deg,transparent ' + (g - bw).toFixed(1) + 'px,#000 ' + g.toFixed(1) + 'px,transparent ' + (g + bw).toFixed(1) + 'px)'; };
    var off = mk(-600); el.style.webkitMaskImage = el.style.maskImage = off; setMask(id, off, 0);
    var a0 = rtl ? x1 + pad : x0 - pad, a1 = rtl ? x0 - pad : x1 + pad, n = Math.round(d * 30);
    for (var f = 0; f <= n; f++) { var u = f / n, e = lin ? u : 0.5 - 0.5 * Math.cos(Math.PI * u); setMask(id, mk(a0 + (a1 - a0) * e), t + f / 30); }
    setMask(id, off, t + d + 0.04);
  }
  P.texts.forEach(function (T) { if (T.glint) { band('G_text' + T.i, T.p0, T.p1, T.glint, 1.0, true, 120, 80); ev('glint', T.glint + 0.5); } });
  P.solids.forEach(function (s) { if (s.sweep) { band('S_' + s.k, s.p0, s.p1, s.sweep.t, 0.55, false, 40, 32); ev('sweep', s.sweep.t + 0.3); } });

  // ---------- life: flow along the path, a light packet, sparks on the hero, accent twinkle ----------
  P.flow.forEach(function (f, i) {
    var kf = []; for (var k = 1; k < f.pts.length; k++) kf.push({ x: f.pts[k][0], y: f.pts[k][1], duration: f.d / (f.pts.length - 1), ease: 'none' });
    tl.set('#f' + i, { x: f.pts[0][0], y: f.pts[0][1], opacity: 0 }, 0);
    tl.to('#f' + i, { keyframes: kf }, f.t);
    tl.fromTo('#f' + i, { opacity: 0 }, { opacity: 0.85, duration: 0.25, immediateRender: false }, f.t);
    tl.to('#f' + i, { opacity: 0, duration: 0.5 }, f.t + f.d - 0.5);
  });
  if (P.pulse) {
    var pu = P.pulse, el = q('pulse');
    var off = 'radial-gradient(circle at -500px -500px,#000 0,transparent 10px)'; el.style.webkitMaskImage = el.style.maskImage = off; setMask('pulse', off, 0);
    var n = Math.round(pu.dur * 30);
    for (var f = 0; f <= n; f++) { var u = f / n, e = u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2, p = bez(pu.path, e);
      setMask('pulse', 'radial-gradient(circle at ' + p[0].toFixed(1) + 'px ' + p[1].toFixed(1) + 'px,#000 0,rgba(0,0,0,.55) 35px,transparent 110px)', pu.t + f / 30); }
    setMask('pulse', off, pu.t + pu.dur + 0.04);
    ev('pulse', pu.t, { dur: pu.dur });
    if (P.accent) { tl.fromTo('#L_' + P.accent.name, { filter: 'brightness(1)' }, { filter: 'brightness(1.35)', duration: 0.2, immediateRender: false }, pu.t + pu.dur - 0.1); tl.to('#L_' + P.accent.name, { filter: 'brightness(1)', duration: 0.5 }, pu.t + pu.dur + 0.1); }
  }
  P.sparks.forEach(function (d, i) {
    tl.fromTo('#dr' + i, { opacity: 0, scale: 0.2, rotation: 0 }, { opacity: 0.95, scale: 1, rotation: 30, duration: 0.16, ease: 'power2.out', immediateRender: false }, d.t);
    tl.to('#dr' + i, { opacity: 0, scale: 0.3, rotation: 50, duration: 0.4, ease: 'power2.in' }, d.t + 0.16);
  });
  if (P.sparks.length) { tl.set('.glint', { opacity: 0 }, 0); ev('sparks', P.sparks[0].t); }
  if (P.accent && P.twinkle) {
    var tw = P.twinkle.t, gid = '#glow_' + P.accent.name;
    tl.fromTo('#L_' + P.accent.name, { filter: 'brightness(1)' }, { filter: 'brightness(1.9)', duration: 0.25, ease: 'power2.out', immediateRender: false }, tw);
    tl.to('#L_' + P.accent.name, { filter: 'brightness(1)', duration: 0.7, ease: 'power2.inOut' }, tw + 0.25);
    if (q('glow_' + P.accent.name)) { tl.fromTo(gid, { opacity: 0 }, { opacity: 0.5, duration: 0.25, immediateRender: false }, tw); tl.to(gid, { opacity: 0, duration: 0.6 }, tw + 0.25); }
    ev('twinkle', tw);
  }

  // ---------- depth: parallax of the plate, drifting haze ----------
  if (P.parallax) {
    var p0 = P.parallax[0], pm = (P.parallax[0] + P.parallax[1]) / 2, p1 = P.parallax[1];
    tl.to('#L_bg', { x: -10, y: -3, scale: 1.022, transformOrigin: '50% 40%', duration: pm - p0, ease: 'sine.inOut' }, p0);
    tl.to('#L_bg', { x: 0, y: 0, scale: 1, duration: p1 - pm, ease: 'sine.inOut' }, pm);
  }
  if (P.haze) {
    tl.fromTo('#hz1', { opacity: 0, x: -40 }, { opacity: 0.12, x: 120, duration: 2.2, ease: 'sine.inOut', immediateRender: false }, P.haze[0]); tl.to('#hz1', { opacity: 0, x: 220, duration: 1.8, ease: 'sine.in' }, P.haze[0] + 2.2);
    tl.fromTo('#hz2', { opacity: 0, x: 60 }, { opacity: 0.1, x: -80, duration: 2.2, ease: 'sine.inOut', immediateRender: false }, P.haze[0] + 0.9); tl.to('#hz2', { opacity: 0, x: -160, duration: 1.6, ease: 'sine.in' }, P.haze[0] + 3.1);
    tl.set('.haze', { opacity: 0 }, 0);
  }
  // last frames: the design itself, pixel for pixel
  tl.fromTo('#final', { opacity: 0 }, { opacity: 1, duration: 0.25, ease: 'none', immediateRender: false }, D - 0.45);
  window.__EV = EV;
  window.__timelines['ad'] = tl;
})();
