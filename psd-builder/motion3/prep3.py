# Joker motion v3 — layer separation (CPU, runs in the GitHub Action).
# Splits the flat design into the layers the director named, so each can be choreographed:
#   bg        clean plate toned to the design (outside object zones it IS the design)
#   solid     director layers of kind "solid" (SAM with the director's points, checked against the plate difference
#             and the PSD step's own cutouts)
#   glow      director layers of kind "glow" (light trails, sparkles, crescents, sprays): the light the design adds
#             over the plate, un-premultiplied, inside the layer's box
#   text      one layer per text line (lettering registered onto the real text, nearest-line ownership)
#   halo/rule soft glow around each text line; thin rule lines near the text become their own layer
#   rim       the light around each solid layer (fades in after it lands, so it never ghosts while moving)
#   ambient   any light left over (stays still)
# Every residual layer's colour is solved against the stack below it, so the final frame equals the design.
# usage: python prep3.py <work>   (work: design.png plate.png [fill.png] [lettering.png] [elem*.png] plan.json)
import sys, os, json
import numpy as np, cv2, onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.environ.get('JM_MODELS', os.path.join(HERE, '..', 'motion2', 'models'))
work = sys.argv[1]; out = os.path.join(work, 'scene3'); os.makedirs(out, exist_ok=True)
log = lambda *a: print(*a, file=sys.stderr)
rd = lambda f, flag=cv2.IMREAD_COLOR: cv2.imread(os.path.join(work, f), flag) if os.path.exists(os.path.join(work, f)) else None
D8 = rd('design.png'); H, W = D8.shape[:2]; D = D8.astype(np.float32)
plate = rd('plate.png'); plate = (cv2.resize(plate, (W, H)) if plate is not None else D8).astype(np.float32)
let = rd('lettering.png', cv2.IMREAD_UNCHANGED)
let_a = np.zeros((H, W), np.uint8)
if let is not None and let.ndim == 3 and let.shape[2] == 4:
    let = cv2.resize(let, (W, H)); let_a = let[:, :, 3]
else:
    let = None
plan = json.load(open(os.path.join(work, 'plan.json')))
clampbox = lambda b: [max(0, int(b[0])), max(0, int(b[1])), min(W, int(b[2])), min(H, int(b[3]))]
bl = lambda x, s=1.2: cv2.GaussianBlur(x.astype(np.float32), (0, 0), s)
lum = lambda x: x[:, :, 0] * .11 + x[:, :, 1] * .59 + x[:, :, 2] * .3
def boxmask(b, pad=0):
    m = np.zeros((H, W), bool); b = clampbox([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]); m[b[1]:b[3], b[0]:b[2]] = True; return m
def save(name, col, a):
    cv2.imwrite(os.path.join(out, name), np.dstack([np.clip(col, 0, 255), np.clip(a, 0, 1) * 255]).astype(np.uint8))

# ---------- SAM ----------
cpu = ['CPUExecutionProvider']
_enc = ort.InferenceSession(os.path.join(MODELS, 'sam_encoder.onnx'), providers=cpu)
_dec = ort.InferenceSession(os.path.join(MODELS, 'sam_decoder.onnx'), providers=cpu)
_x = cv2.resize(cv2.cvtColor(D8, cv2.COLOR_BGR2RGB), (1024, 1024)).astype(np.float32) / 255
_x = ((_x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]).transpose(2, 0, 1)[None].astype(np.float32)
EMB = _enc.run(None, {'pixel_values': _x})
def sam_all(box, pos=(), neg=()):
    sx, sy = 1024 / W, 1024 / H
    pts = [(p[0] * sx, p[1] * sy, 1) for p in pos] + [(p[0] * sx, p[1] * sy, 0) for p in neg]
    if not pts: pts = [(0, 0, -1)]
    feed = {'input_points': np.array([[[[p[0], p[1]] for p in pts]]], np.float32),
            'input_labels': np.array([[[p[2] for p in pts]]], np.int64),
            'input_boxes': np.array([[[box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy]]], np.float32),
            'image_embeddings.0': EMB[0], 'image_embeddings.1': EMB[1], 'image_embeddings.2': EMB[2]}
    iou, m, _ = _dec.run(None, feed)
    return [(cv2.resize(m[0, 0, i], (W, H)), float(iou[0, 0, i])) for i in range(m.shape[2])]

# ---------- lettering registration (the AI lettering raster can come out scaled/shifted) ----------
texts_plan = plan.get('texts', [])
if let is not None and let_a.any():
    tmask = np.zeros((H, W), bool)
    for t in texts_plan:
        b = t.get('box')
        if b and len(b) == 4:
            ph = int(0.35 * (b[3] - b[1])) + 10; tmask |= boxmask(b, ph)
    real = (np.abs(bl(D) - bl(plate)).sum(2) > 70) & tmask
    real = cv2.morphologyEx(real.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
    lb = let_a > 128
    if real.sum() > 500 and lb.sum() > 500:
        ry, rx = np.where(real); ly, lx = np.where(lb); q = lambda v: np.percentile(v, [1, 99])
        (rx0, rx1), (ry0, ry1), (lx0, lx1), (ly0, ly1) = q(rx), q(ry), q(lx), q(ly)
        sx, sy = (rx1 - rx0) / max(1, lx1 - lx0), (ry1 - ry0) / max(1, ly1 - ly0)
        M = np.float32([[sx, 0, rx0 - lx0 * sx], [0, sy, ry0 - ly0 * sy]])
        score = lambda mat: ((cv2.warpAffine(let_a, mat, (W, H)) > 128) & real).sum() / (((cv2.warpAffine(let_a, mat, (W, H)) > 128) | real).sum() + 1)
        s0, s1 = score(np.float32([[1, 0, 0], [0, 1, 0]])), score(M)
        if s1 > s0 + 0.05 and 0.6 < sx < 1.6 and 0.6 < sy < 1.6:
            let = cv2.warpAffine(let, M, (W, H), borderValue=(0, 0, 0, 0)); let_a = let[:, :, 3]; log('lettering registered %.2f -> %.2f' % (s0, s1))

# ---------- clean plates (text-free plate, hero-free fill), toned to the design where they agree ----------
fill = rd('fill.png'); fill = cv2.resize(fill, (W, H)).astype(np.float32) if fill is not None else None
def toned(src):
    # the tone difference design-plate, measured where they agree, continued smoothly under the objects (at 1/8 scale)
    dz = cv2.dilate((bl(np.abs(D - src).max(2), 1.5) > 14).astype(np.uint8), np.ones((41, 41), np.uint8))
    if dz.mean() > 0.85: return src
    s8 = (W // 8, H // 8)
    dl = cv2.resize(np.clip(D - src + 128, 0, 255).astype(np.uint8), s8, interpolation=cv2.INTER_AREA)
    dz8 = cv2.resize(dz, s8, interpolation=cv2.INTER_NEAREST)
    dl = cv2.inpaint(dl, dz8, 6, cv2.INPAINT_TELEA).astype(np.float32)
    dl = cv2.GaussianBlur(dl, (0, 0), 2.5)
    return np.clip(src + cv2.resize(dl, (W, H), interpolation=cv2.INTER_CUBIC) - 128, 0, 255)
def inpainted(m):
    # smooth push-pull fill of a hole from the design around it (walls, skies, gradients)
    w0 = (~m).astype(np.float32); img = D * w0[:, :, None]; pyr = [(img, w0)]
    while min(pyr[-1][1].shape) > 8:
        im, w = pyr[-1]; pyr.append((cv2.pyrDown(im), cv2.pyrDown(w)))
    im, w = pyr[-1]; cur = im / np.maximum(w[:, :, None], 1e-4)
    for im, w in reversed(pyr[:-1]):
        up = cv2.resize(cur, (w.shape[1], w.shape[0]), interpolation=cv2.INTER_LINEAR)
        ww = np.clip(w * 4, 0, 1)[:, :, None]
        cur = (im / np.maximum(w[:, :, None], 1e-4)) * ww + up * (1 - ww)
    return cur
plate_c = toned(plate); fill_c = toned(fill) if fill is not None else None
diff_plate = np.abs(D - plate).max(2)

# ---------- solid layers ----------
elems = []
for f in sorted(os.listdir(work)):
    if f.startswith('elem') and f.endswith('.png'):
        e = cv2.imread(os.path.join(work, f), cv2.IMREAD_UNCHANGED)
        if e is not None and e.ndim == 3 and e.shape[2] == 4: elems.append(cv2.resize(e[:, :, 3], (W, H)).astype(np.float32) / 255)
sig = lambda x: 1 / (1 + np.exp(-x))
layers_plan = plan.get('layers', [])
solid = {}
for k, L in enumerate(layers_plan):
    if L.get('kind', 'solid') != 'solid' or not L.get('box'): continue
    b = clampbox(L['box']); inb = boxmask(b)
    pos = [tuple(p) for p in L.get('points', [])] or [((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)]
    neg = [tuple(p) for p in L.get('neg', [])]
    ref_src = fill if (fill is not None and L.get('hero')) else plate
    dm = (bl(np.abs(D - ref_src).max(2), 1.5) > 30) & boxmask(b, 10)
    best, bscore = None, -1
    for lg, iou in sam_all(b, pos, neg):
        m = lg > 0
        if m.sum() < 50: continue
        agree = (m & dm).sum() / ((m | dm).sum() + 1)
        out_box = (m & ~boxmask(b, 25)).sum() / (m.sum() + 1)
        s = 0.55 * iou + 0.45 * agree - 1.5 * out_box
        if s > bscore: bscore, best = s, lg
    if best is None: continue
    a = sig(best * 1.2)
    a = cv2.GaussianBlur(cv2.erode(a, np.ones((3, 3), np.uint8)), (0, 0), 0.7)
    # keep the main body + big parts; drop specks
    n_, lab_, st_, _ = cv2.connectedComponentsWithStats((a > 0.5).astype(np.uint8), 8)
    if n_ > 2:
        big = 1 + int(np.argmax(st_[1:, cv2.CC_STAT_AREA]))
        keep = np.isin(lab_, [i for i in range(1, n_) if i == big or st_[i, cv2.CC_STAT_AREA] > 0.1 * st_[big, cv2.CC_STAT_AREA]])
        a *= cv2.GaussianBlur(cv2.dilate(keep.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(np.float32), (0, 0), 1)
    # the PSD step's own cutout wins when it is clearly the same object in the same place (cleaner edges)
    best_e, best_j = None, 0
    for e in elems:
        j = max(((e > 0.5) & (a > 0.5)).sum() / (((e > 0.5) | (a > 0.5)).sum() + 1), ((e > 0.5) & dm).sum() / (((e > 0.5) | dm).sum() + 1))
        if j > best_j: best_j, best_e = j, e
    if best_e is not None and best_j > 0.62:
        a = cv2.GaussianBlur(best_e, (0, 0), 0.6); log('layer', L.get('name'), 'uses PSD cutout', round(best_j, 2))
        near = cv2.dilate((best_e > 0.5).astype(np.uint8), np.ones((31, 31), np.uint8)) > 0
        for e in elems:     # what the hero holds is often its own cutout (a can in the hand)
            if e is best_e: continue
            es = (e > 0.5).sum()
            if es and ((e > 0.5) & near).sum() > 0.6 * es and es < 0.5 * (best_e > 0.5).sum() and ((e > 0.5) & dm).sum() > 0.5 * es:
                a = np.maximum(a, cv2.GaussianBlur(e, (0, 0), 0.6)); log('layer', L.get('name'), '+ attached cutout')
    solid[k] = a
    log('layer', L.get('name'), 'solid', round(float((a > 0.5).mean()) * 100, 2), '% score', round(bscore, 2))
# front layers own their pixels
order = [k for k in range(len(layers_plan)) if k in solid]
for i, k in enumerate(order):
    for k2 in order[i + 1:]:
        solid[k] = solid[k] * (1 - solid[k2])

# ---------- text lines ----------
tl = texts_plan
masks = []
for t in tl:
    b = t.get('box')
    if not b or len(b) != 4: masks.append(None); continue
    pad = max(6, int(0.12 * (b[3] - b[1])))
    px = max(pad, int(0.6 * (b[3] - b[1]))) if t.get('pill') else pad
    bb = clampbox([b[0] - px, b[1] - pad, b[2] + px, b[3] + pad])
    lg = max(sam_all(bb), key=lambda o: o[1])[0]
    m = (lg > 0) & boxmask(bb)
    masks.append(cv2.dilate(m.astype(np.uint8), np.ones((19, 19), np.uint8)) > 0)
idx = [i for i in range(len(tl)) if masks[i] is not None]
let_own = np.full((H, W), -1, np.int32)
if idx:
    dist = np.stack([cv2.distanceTransform((~masks[i]).astype(np.uint8), cv2.DIST_L2, 3) for i in idx])
    let_own = np.where((let_a > 10) & (dist.min(0) < 70), np.array(idx)[np.argmin(dist, 0)], -1)
pdv = np.abs(bl(D) - bl(plate)).sum(2)
plate_diff = pdv > 70; plate_soft = np.clip((pdv - 18) / 50, 0, 1)
solid_any = np.zeros((H, W), np.float32)
for a in solid.values(): solid_any = np.maximum(solid_any, a)
claimed = np.zeros((H, W), bool); text_alpha = {}
for i in sorted(idx, key=lambda i: masks[i].sum()):
    m = masks[i].copy(); m |= let_own == i; m &= ~((let_own >= 0) & (let_own != i)); m &= ~claimed
    a = np.where(m, let_a, 0).astype(np.float32)
    # trust the lettering raster for this line only if it sits on the real letters
    tb0 = tl[i]['box']; real_l = (pdv > 90) & boxmask(tb0, 8)
    la_l = (a > 128) & boxmask(tb0, 30)
    fit = (la_l & cv2.dilate(real_l.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)).sum() / (la_l.sum() + 1)
    if la_l.sum() > 100 and fit < 0.6:
        log('text', i, 'lettering raster off the real text (fit %.2f) - using the plate difference' % fit); a[:] = 0
    near_l = cv2.dilate(((a > 10) | (m if tl[i].get('pill') else np.zeros_like(m))).astype(np.uint8), np.ones((25, 25), np.uint8)) > 0
    a = np.maximum(a, cv2.GaussianBlur(np.where(m & near_l & plate_diff, 255, 0).astype(np.uint8), (0, 0), 0.8))
    # letters the lettering raster missed: strong difference from the text-free plate inside the line's own box
    tb = tl[i]['box']; th_ = tb[3] - tb[1]
    inbox = boxmask([tb[0] - 0.15 * th_, tb[1] - 0.2 * th_, tb[2] + 0.15 * th_, tb[3] + 0.2 * th_])
    strong = (pdv > 90) & inbox & ~((let_own >= 0) & (let_own != i)) & ~claimed
    hexc = str(tl[i].get('color') or '').lstrip('#')
    if len(hexc) == 6:   # only pixels near the line's own colour (the AI plate can differ from the design elsewhere)
        rgb = np.array([int(hexc[4:6], 16), int(hexc[2:4], 16), int(hexc[0:2], 16)], np.float32)
        strong &= np.abs(D - rgb).sum(2) < 170
    strong = cv2.morphologyEx(strong.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8)) > 0
    if strong.any():
        a = np.maximum(a, cv2.GaussianBlur(np.where(strong, 255, 0).astype(np.uint8), (0, 0), 0.7).astype(np.float32))
        near_s = cv2.dilate(strong.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
        a = np.maximum(a, cv2.GaussianBlur(((near_s & inbox) * plate_soft).astype(np.float32), (0, 0), 1.2) * 255)
    a = np.maximum(a, cv2.GaussianBlur(((m & near_l) * plate_soft).astype(np.float32), (0, 0), 1.5) * 255)
    if tl[i].get('pill') or (a > 10).sum() < 0.03 * m.sum(): a = np.maximum(a, np.where(m, 255, 0))   # a pill/ribbon: SAM's own shape
    a = a / 255 * (1 - (solid_any > 0.5))       # never steal the hero's pixels
    if (a > 0.04).sum() < 30: continue
    claimed |= a > 0.04; text_alpha[i] = a
# thin horizontal rules hugging a text line (a gold divider) leave the text layer and become their own layer
rule = np.zeros((H, W), np.float32)
for i, a in text_alpha.items():
    n_, lab_, st_, _ = cv2.connectedComponentsWithStats((a > 0.15).astype(np.uint8), 8)
    for c in range(1, n_):
        x, y, w, h, ar = st_[c]
        if w > 120 and h < 16 and w > 8 * h:
            cm = cv2.dilate((lab_ == c).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
            rule = np.maximum(rule, a * cm); text_alpha[i] = a * ~cm; log('rule line split from text', i, (x, y, w, h))

# ---------- background = the design itself; only where something moves is it replaced by the clean plate ----------
hole = np.zeros((H, W), np.float32); src = np.zeros((H, W, 3), np.float32)
def punch(m, s_):
    global hole, src
    w_ = np.clip(cv2.GaussianBlur(m.astype(np.float32), (0, 0), 3) * 1.4, 0, 1)
    src = src * (1 - w_[:, :, None]) + s_ * w_[:, :, None]; hole = np.maximum(hole, w_)
# solids first (their zone includes their glow and floor reflection), then light and text on top
for k, a in solid.items():
    s_ = fill_c if (fill_c is not None and layers_plan[k].get('hero')) else plate_c
    z = cv2.dilate((a > 0.3).astype(np.uint8), np.ones((41, 41), np.uint8)) > 0
    if fill_c is not None and layers_plan[k].get('hero'):   # everything the hero-free plate removed near the hero goes too
        z |= (bl(np.abs(D - fill_c).max(2), 1.5) > 28) & (cv2.dilate((a > 0.3).astype(np.uint8), np.ones((151, 151), np.uint8)) > 0)
    ys_, xs_ = np.where(a > 0.4)
    if len(ys_) and layers_plan[k].get('hero'): z |= boxmask([xs_.min() - 40, ys_.max() - 25, xs_.max() + 40, H]) & (bl(np.abs(D - s_).max(2), 2) > 10)
    punch(z, s_)
for k, L in enumerate(layers_plan):
    if L.get('kind') == 'glow' and L.get('box') and (L.get('reveal') or {}).get('type', 'fade') != 'none':
        g_ = (bl(diff_plate, 1.5) > 14) & boxmask(L['box'], 4)
        punch(cv2.dilate(g_.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0, plate_c)
_rz = []
if rule.any():
    ys_, xs_ = np.where(rule > 0.2); _rz = [boxmask([xs_.min() - 50, ys_.min() - 16, xs_.max() + 50, ys_.max() + 16]).astype(np.float32)]
for a in list(text_alpha.values()) + _rz:
    hm = cv2.dilate((a > 0.05).astype(np.uint8), np.ones((31, 31), np.uint8)) > 0
    far = (cv2.dilate(hm.astype(np.uint8), np.ones((81, 81), np.uint8)) > 0) & ~(cv2.dilate(hm.astype(np.uint8), np.ones((41, 41), np.uint8)) > 0)
    hp = lambda x: np.abs(x - bl(x, 3)).mean(2)
    calm = float(hp(D)[far].mean()) if far.any() else 99
    if calm < 8:   # smooth background: the whole glow zone of the line goes, so nothing of it shows before it animates
        hm = cv2.dilate((a > 0.05).astype(np.uint8), np.ones((61, 61), np.uint8)) > 0
    ghost = float(hp(plate_c)[hm].mean()) if hm.any() else 0
    tone = float(np.abs(bl(D, 6) - bl(plate_c, 6)).max(2)[far].mean()) if far.any() else 0
    use_fill = calm < 8 and (ghost > 1.8 * calm + 2 or tone > 14)
    log('text hole: plate ghost %.1f vs surround %.1f, tone %.1f -> %s' % (ghost, calm, tone, 'smooth fill' if use_fill else 'plate'))
    punch(hm, inpainted(hm) if use_fill else plate_c)
hole3 = hole[:, :, None]
# designs whose clean plate agrees with them away from the objects (photo / glow looks): the whole object zone comes
# from the toned plate with a wide soft blend (no rectangles, nothing left behind). Painted art: the local holes above.
oz = cv2.dilate((bl(diff_plate, 1.5) > 14).astype(np.uint8), np.ones((41, 41), np.uint8))
log('object zone %.0f%% of the frame' % (oz.mean() * 100))
if oz.mean() < 0.75:
    wz = np.clip(cv2.GaussianBlur(oz.astype(np.float32), (0, 0), 12) * 1.5, 0, 1)
    src = plate_c * wz[:, :, None]; hole3 = wz[:, :, None]
BG = D * (1 - hole3) + src     # src is already weighted by each hole's feathered mask
cv2.imwrite(os.path.join(out, 'bg.png'), np.clip(BG, 0, 255).astype(np.uint8))
diff = np.abs(D - BG).max(2)

# ---------- residual light: glow layers, rims, halos, rule glow, ambient ----------
used = solid_any.copy()
for a in text_alpha.values(): used = np.maximum(used, a)
used = np.maximum(used, rule)
res = cv2.GaussianBlur(np.clip((diff - 6) / 40, 0, 1) * (1 - used), (0, 0), 0.6)
yy, xx = np.mgrid[0:H, 0:W]
owner = {}
def take(name, w):
    global res
    owner[name] = res * w; res = res * (1 - w)
soft = lambda m, s: np.clip(cv2.GaussianBlur(m.astype(np.float32), (0, 0), s), 0, 1)
# rule glow (the lens-flare along a divider), then each text line's own glow
if rule.any():
    ys_, xs_ = np.where(rule > 0.2)
    take('ruleglow', soft(boxmask([xs_.min() - 40, ys_.min() - 14, xs_.max() + 40, ys_.max() + 14]), 3))
for i, a in text_alpha.items():
    take('halo%d' % i, soft(cv2.dilate((a > 0.08).astype(np.uint8), np.ones((61, 61), np.uint8)) > 0, 8))
# glow layers the director named, most specific (smallest box) first
gl = [(k, L) for k, L in enumerate(layers_plan) if L.get('kind') == 'glow' and L.get('box')]
for k, L in sorted(gl, key=lambda kl: (kl[1]['box'][2] - kl[1]['box'][0]) * (kl[1]['box'][3] - kl[1]['box'][1])):
    take('glow%d' % k, soft(boxmask(L['box'], 6), 4))
# each solid layer's light: the glow around it and its reflection on the floor below it
for k, a in solid.items():
    zone = cv2.dilate((a > 0.3).astype(np.uint8), np.ones((41, 41), np.uint8)) > 0
    if fill_c is not None and layers_plan[k].get('hero'):   # same zone the background lost: it travels with the hero
        zone |= (bl(np.abs(D - fill_c).max(2), 1.5) > 28) & (cv2.dilate((a > 0.3).astype(np.uint8), np.ones((151, 151), np.uint8)) > 0)
    ys_, xs_ = np.where(a > 0.4)
    if len(ys_) and layers_plan[k].get('hero'):
        zone |= boxmask([xs_.min() - 40, ys_.max() - 25, xs_.max() + 40, H])
    take('rim%d' % k, soft(zone, 5))
take('ambient', np.ones((H, W), np.float32))
# colours solved against the stack below each layer
stack = []   # compositing order, back to front
stack.append(('ambient', 'glow', None))
for k, L in enumerate(layers_plan):
    if ('glow%d' % k) in owner: stack.append(('glow%d' % k, 'glow', k))
for i in text_alpha:
    stack.append(('halo%d' % i, 'halo', i))
if 'ruleglow' in owner: stack.append(('ruleglow', 'halo', None))
for k in order:
    stack.append(('rim%d' % k, 'rim', k)); stack.append(('solid%d' % k, 'solid', k))
if rule.any(): stack.append(('rule', 'rule', None))
for i in sorted(text_alpha): stack.append(('text%d' % i, 'text', i))
under = BG.copy(); files = []; col_of = {}
for name, kind, ref in stack:
    if kind == 'solid': a, col = solid[ref], D
    elif kind == 'text': a, col = text_alpha[ref], D
    elif kind == 'rule': a, col = rule, D
    else:
        a = owner.get(name)
        if a is None or a.max() < 0.05: continue
        col = np.where(a[:, :, None] > 0.02, (D - under * (1 - a[:, :, None])) / np.maximum(a[:, :, None], 0.02), D)
    if a.max() < 0.05: continue
    col = np.clip(col, 0, 255); under = under * (1 - a[:, :, None]) + col * a[:, :, None]
    save(name + '.png', col, a); files.append((name, kind, ref, a)); col_of[name] = col
err = np.abs(under - D).max(2); log('rest frame vs design: mean %.2f p99 %.1f' % (err.mean(), np.percentile(err, 99)))

# ---------- geometry for the choreography ----------
def geom(a):
    m = a > 0.4
    if m.sum() < 20: return None
    ys_, xs_ = np.where(m)
    c = np.cov(np.vstack([xs_, ys_])); w_, v_ = np.linalg.eigh(c); vx, vy = v_[:, 1]
    if vy > 0: vx, vy = -vx, -vy
    top = int(ys_.min()); tx = float(xs_[ys_ < top + 8].mean())
    return dict(bbox=[int(xs_.min()), int(ys_.min()), int(xs_.max()), int(ys_.max())], c=[float(xs_.mean()), float(ys_.mean())],
                axis=float(np.degrees(np.arctan2(vx, -vy))), top=[tx, top], area=float(m.mean()))
# word columns of each text line (right-to-left reveal per word)
def words(a):
    cols = (a > 0.15).sum(0); nz = np.where(cols > 0)[0]
    if not len(nz): return []
    x0, x1 = nz.min(), nz.max(); h = (a > 0.15).sum(1); hh = np.where(h > 0)[0]; th = hh.max() - hh.min() + 1
    gap = max(5, int(th * 0.05)); cuts = []; run = 0
    for x in range(x0, x1 + 1):
        if cols[x] == 0: run += 1
        else:
            if run >= gap: cuts.append(x - run // 2 - 1)
            run = 0
    edges = [int(x0)] + cuts + [int(x1) + 1]
    ws = [[edges[j], edges[j + 1]] for j in range(len(edges) - 1)]
    return sorted(ws, key=lambda w: -w[0])      # right to left
scene = dict(W=W, H=H, layers=[], lum=float(lum(D).mean()))
for name, kind, ref, a in files:
    g = geom(a) or {}
    ent = dict(name=name, file=name + '.png', kind=kind, ref=ref, **g)
    if kind == 'text': ent['words'] = words(a)
    if kind == 'solid':
        # highlights for droplet glints and the beauty sweep key
        L_ = lum(D); inner = cv2.erode((a > 0.5).astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
        g2 = cv2.GaussianBlur(L_, (0, 0), 1)
        loc = (g2 == cv2.dilate(g2, np.ones((9, 9), np.uint8))) & (g2 > 95) & inner
        py, px = np.where(loc); rng = np.random.default_rng(3); sel = rng.permutation(len(px))[:16]
        ent['sparks'] = [[int(px[s]), int(py[s])] for s in sel]
        key = np.clip((L_ - 55) / 90, 0, 1) ** 1.3 * cv2.GaussianBlur(inner.astype(np.float32), (0, 0), 1.5)
        save('sweep_%s.png' % name, np.clip(D * 1.6 + np.array([70, 110, 140]), 0, 255), key); ent['sweep'] = 'sweep_%s.png' % name
    if kind == 'text':
        warm = D[:, :, 2] - D[:, :, 0]; L_ = lum(D)
        gk = np.clip((L_ - 60) / 70, 0, 1) * np.maximum(np.clip((warm - 15) / 40, 0, 1), 0.35) * a
        save('glint_%s.png' % name, np.clip(D * 1.45 + 30, 0, 255), gk); ent['glint'] = 'glint_%s.png' % name
    if kind == 'glow' and ref is not None and (layers_plan[ref].get('reveal') or {}).get('type') == 'grow_from':
        gold = np.array([90, 200, 255], np.float32)
        pc = np.clip(gold * (0.6 + 0.6 * (col_of[name].mean(2, keepdims=True) / 255)), 0, 255) * np.ones((1, 1, 3), np.float32)
        save('pulse_%s.png' % name, pc, np.clip(cv2.GaussianBlur(a, (0, 0), 2.5) * 1.6, 0, 1)); ent['pulse'] = 'pulse_%s.png' % name
    scene['layers'].append(ent)
json.dump(scene, open(os.path.join(out, 'scene.json'), 'w'), indent=1)
log('layers:', ', '.join(f[0] for f in files))
