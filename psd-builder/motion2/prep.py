# Joker motion v2 — scene prep (runs in the GitHub Action, CPU only).
# From the flat design it makes: exact text-line layers, the exact subject layer (SAM), and a background
# video that moves in 2.5D by per-pixel depth (Depth Anything V2) — the design's own pixels everywhere.
# usage: python prep.py <work_dir>
#   work_dir/design.png   the design (W x H)
#   work_dir/plate.png    text-free (and element-free) background plate from the PSD job
#   work_dir/fill.png     optional: the design with only the subject removed
#   work_dir/lettering.png optional: transparent lettering raster (full canvas)
#   work_dir/plan.json    the director's plan (see director.md)
# writes work_dir/scene/: bg.mp4, subject.png, text*.png, scene.json
import sys, os, json, subprocess
import numpy as np, cv2, onnxruntime as ort

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.environ.get('JM_MODELS', os.path.join(HERE, 'models'))
work = sys.argv[1]; out = os.path.join(work, 'scene'); os.makedirs(out, exist_ok=True)
rd = lambda f, flag=cv2.IMREAD_COLOR: cv2.imread(os.path.join(work, f), flag) if os.path.exists(os.path.join(work, f)) else None
D = rd('design.png'); H, W = D.shape[:2]
plate = rd('plate.png'); plate = cv2.resize(plate, (W, H)) if plate is not None else D.copy()
fill = rd('fill.png'); has_fill = fill is not None; fill = cv2.resize(fill, (W, H)) if has_fill else plate
let = rd('lettering.png', cv2.IMREAD_UNCHANGED)
let_a = np.zeros((H, W), np.uint8)
if let is not None and let.shape[2] == 4:
    let = cv2.resize(let, (W, H)); let_a = let[:, :, 3]
plan = json.load(open(os.path.join(work, 'plan.json')))
FPS, DUR = 30, float(plan.get('duration', 6))

# ---------- the lettering raster is AI-made and can come out scaled/shifted: register it onto the real text ----------
if let is not None and let.shape[2] == 4 and let_a.any():
    _b = lambda x: cv2.GaussianBlur(x.astype(np.float32), (0, 0), 1.2)
    tmask = np.zeros((H, W), bool)
    for t in plan.get('texts', []):
        b = t.get('box')
        if b and len(b) == 4:
            ph = int(0.35 * (b[3] - b[1])) + 10
            tmask[max(0, int(b[1]) - ph):min(H, int(b[3]) + ph), max(0, int(b[0]) - ph):min(W, int(b[2]) + ph)] = True
    real = (np.abs(_b(D) - _b(plate)).sum(2) > 70) & tmask
    real = cv2.morphologyEx(real.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
    lb = let_a > 128
    if real.sum() > 500 and lb.sum() > 500:
        ry, rx = np.where(real); ly, lx = np.where(lb)
        q = lambda v: np.percentile(v, [1, 99])
        (rx0, rx1), (ry0, ry1), (lx0, lx1), (ly0, ly1) = q(rx), q(ry), q(lx), q(ly)
        sx, sy = (rx1 - rx0) / max(1, lx1 - lx0), (ry1 - ry0) / max(1, ly1 - ly0)
        M = np.float32([[sx, 0, rx0 - lx0 * sx], [0, sy, ry0 - ly0 * sy]])
        off = abs(sx - 1) + abs(sy - 1) + (abs(M[0, 2]) + abs(M[1, 2])) / W
        def score(mat):
            a2 = cv2.warpAffine(let_a, mat, (W, H)) > 128
            return (a2 & real).sum() / ((a2 | real).sum() + 1)
        s0, s1 = score(np.float32([[1, 0, 0], [0, 1, 0]])), score(M)
        if s1 > s0 + 0.05 and 0.6 < sx < 1.6 and 0.6 < sy < 1.6:
            try:   # refine with ECC on the alpha
                _, M2 = cv2.findTransformECC(real.astype(np.float32), let_a.astype(np.float32) / 255, M.copy(), cv2.MOTION_AFFINE,
                                             (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-5), None, 5)
                if score(M2) > s1: M, s1 = M2, score(M2)
            except cv2.error: pass
            let = cv2.warpAffine(let, M, (W, H), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0, 0)); let_a = let[:, :, 3]
            print('lettering registered: IoU %.2f -> %.2f' % (s0, s1), file=sys.stderr)
cpu = ['CPUExecutionProvider']

# ---------- models ----------
def depth_map(img):
    s = ort.InferenceSession(os.path.join(MODELS, 'depth.onnx'), providers=cpu)
    x = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), (518, 518), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255
    x = ((x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]).transpose(2, 0, 1)[None].astype(np.float32)
    d = s.run(None, {s.get_inputs()[0].name: x})[0][0]
    d = cv2.resize(d, (W, H), interpolation=cv2.INTER_CUBIC)
    return (d - d.min()) / (d.max() - d.min() + 1e-6)
_enc = ort.InferenceSession(os.path.join(MODELS, 'sam_encoder.onnx'), providers=cpu)
_dec = ort.InferenceSession(os.path.join(MODELS, 'sam_decoder.onnx'), providers=cpu)
x = cv2.resize(cv2.cvtColor(D, cv2.COLOR_BGR2RGB), (1024, 1024)).astype(np.float32) / 255
x = ((x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]).transpose(2, 0, 1)[None].astype(np.float32)
EMB = _enc.run(None, {'pixel_values': x})
def sam(box, pos=()):
    sx, sy = 1024 / W, 1024 / H
    pts = [(p[0] * sx, p[1] * sy, 1) for p in pos] or [(0, 0, -1)]
    feed = {'input_points': np.array([[[[p[0], p[1]] for p in pts]]], np.float32),
            'input_labels': np.array([[[p[2] for p in pts]]], np.int64),
            'input_boxes': np.array([[[box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy]]], np.float32),
            'image_embeddings.0': EMB[0], 'image_embeddings.1': EMB[1], 'image_embeddings.2': EMB[2]}
    iou, m, _ = _dec.run(None, feed)
    i = int(np.argmax(iou[0, 0]))
    return cv2.resize(m[0, 0, i], (W, H)) > 0, float(iou[0, 0, i])
clampbox = lambda b: [max(0, int(b[0])), max(0, int(b[1])), min(W, int(b[2])), min(H, int(b[3]))]

# ---------- subject (raw SAM mask, before texts) ----------
sub = plan.get('subject') or {}
subj_raw = np.zeros((H, W), bool); iou = 0.0
if sub.get('box'):
    subj_raw, iou = sam(clampbox(sub['box']), [tuple(p) for p in sub.get('points', [])])
# the clean background (design with the hero removed) tells exactly where the hero is: design vs fill difference.
# SAM sometimes grabs the sky around the hero; when the two disagree, the difference wins.
diff_mode = False
if sub.get('box') and has_fill:
    bl = lambda x: cv2.GaussianBlur(x.astype(np.float32), (0, 0), 2.5)
    df = np.abs(bl(D) - bl(fill)).sum(2)
    nolet = ~(cv2.dilate((let_a > 30).astype(np.uint8), np.ones((15, 15), np.uint8)) > 0)
    b = clampbox(sub['box']); r0 = [max(0, b[0] - 60), max(0, b[1] - 60), min(W, b[2] + 60), min(H, b[3] + 60)]
    # the director's box is often a bit tight (feet, a hand, speed lines cut off): grow every side the hero touches
    for _ in range(8):
        roi = np.zeros((H, W), bool); roi[r0[1]:r0[3], r0[0]:r0[2]] = True
        dm = ((df > 55) & roi & nolet).astype(np.uint8)
        dm = cv2.morphologyEx(dm, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        dm = cv2.morphologyEx(dm, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
        n_, lab_, st_, _ = cv2.connectedComponentsWithStats(dm, 8)
        if n_ < 2: break
        # the solid body (thin lines like speed streaks or redrawn background detail removed) decides the growth
        sol = cv2.morphologyEx((lab_ == 1 + int(np.argmax(st_[1:, cv2.CC_STAT_AREA]))).astype(np.uint8), cv2.MORPH_OPEN, np.ones((23, 23), np.uint8))
        ns, ls, ss, _ = cv2.connectedComponentsWithStats(sol, 8)
        mc = (ls == 1 + int(np.argmax(ss[1:, cv2.CC_STAT_AREA]))) if ns > 1 else sol > 0
        grow = [r0[0] > 0 and mc[:, r0[0]].sum() > 25, r0[1] > 0 and mc[r0[1], :].sum() > 25,
                r0[2] < W and mc[:, r0[2] - 1].sum() > 25, r0[3] < H and mc[r0[3] - 1, :].sum() > 25]
        if not any(grow): break
        r0 = [max(0, r0[0] - 120 * grow[0]), max(0, r0[1] - 120 * grow[1]), min(W, r0[2] + 120 * grow[2]), min(H, r0[3] + 120 * grow[3])]
    if n_ > 1:
        near = cv2.dilate(mc.astype(np.uint8), np.ones((41, 41), np.uint8)) > 0
        dm = (dm.astype(bool) & near).astype(np.uint8)
        n_, lab_, st_, _ = cv2.connectedComponentsWithStats(dm, 8)
    if n_ > 1:
        big = 1 + int(np.argmax(st_[1:, cv2.CC_STAT_AREA])); k_ = np.zeros((H, W), bool)
        for i in range(1, n_):
            if i == big or st_[i, cv2.CC_STAT_AREA] > 0.03 * st_[big, cv2.CC_STAT_AREA]: k_[lab_ == i] = True
        inv = (~k_).astype(np.uint8); n2, lab2, st2, _ = cv2.connectedComponentsWithStats(inv, 4)
        for i in range(1, n2):
            if st2[i, cv2.CC_STAT_AREA] < 0.01 * k_.sum(): k_[lab2 == i] = True
        # chunky islands hanging on by a thin streak (a piece of rail, a car corner) are not the hero
        ko = cv2.morphologyEx(k_.astype(np.uint8), cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
        n3, l3, s3, _ = cv2.connectedComponentsWithStats(ko, 8)
        if n3 > 2:
            b3 = 1 + int(np.argmax(s3[1:, cv2.CC_STAT_AREA]))
            drop = np.isin(l3, [i for i in range(1, n3) if i != b3 and s3[i, cv2.CC_STAT_AREA] < 0.03 * s3[b3, cv2.CC_STAT_AREA]])
            k_ &= ~(cv2.dilate(drop.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0)
        agree = (k_ & subj_raw).sum() / ((k_ | subj_raw).sum() + 1)
        outside = float(((df > 55) & ~roi).mean())
        print('subject: sam vs fill-diff IoU %.2f, diff outside box %.3f' % (agree, outside), file=sys.stderr)
        if agree < 0.6 and 0.003 < k_.mean() < 0.6:
            subj_raw = k_; diff_mode = True
# best of all: the PSD step's own cutout of the hero (exact edges, nothing attached). Take the element that matches
# the hero we found; it wins whenever it clearly is the same object.
if sub.get('box') and subj_raw.any():
    best_e, best_i = None, 0.0
    for f in sorted(os.listdir(work)):
        if not (f.startswith('elem') and f.endswith('.png')): continue
        e = cv2.imread(os.path.join(work, f), cv2.IMREAD_UNCHANGED)
        if e is None or e.ndim < 3 or e.shape[2] != 4: continue
        ea = cv2.resize(e[:, :, 3], (W, H)) > 128
        if not ea.any(): continue
        j = (ea & subj_raw).sum() / ((ea | subj_raw).sum() + 1)
        # also against the director's box (a dark hero on a dark background fools both SAM and the plate difference)
        ys_, xs_ = np.where(ea); bx = clampbox(sub['box'])
        ix = max(0, min(xs_.max(), bx[2]) - max(xs_.min(), bx[0])) * max(0, min(ys_.max(), bx[3]) - max(ys_.min(), bx[1]))
        ua = (xs_.max() - xs_.min()) * (ys_.max() - ys_.min()) + (bx[2] - bx[0]) * (bx[3] - bx[1]) - ix
        j = max(j, 0.9 * ix / (ua + 1))
        if j > best_i: best_i, best_e = j, ea
    print('subject: best element cutout IoU %.2f' % best_i, file=sys.stderr)
    if best_e is not None and best_i > 0.45 and 0.003 < best_e.mean() < 0.6:
        # what the hero holds or wears is often its own element (a can in the hand): take elements that sit on him
        near = cv2.dilate(best_e.astype(np.uint8), np.ones((31, 31), np.uint8)) > 0
        for f in sorted(os.listdir(work)):
            if not (f.startswith('elem') and f.endswith('.png')): continue
            e = cv2.imread(os.path.join(work, f), cv2.IMREAD_UNCHANGED)
            if e is None or e.ndim < 3 or e.shape[2] != 4: continue
            ea = cv2.resize(e[:, :, 3], (W, H)) > 128
            if ea.sum() and (ea & near).sum() > 0.6 * ea.sum() and ea.sum() < 0.5 * best_e.sum():
                best_e = best_e | ea; print('subject: + attached element', f, file=sys.stderr)
        subj_raw = best_e; diff_mode = has_fill

# ---------- text lines: lettering ∩ SAM(line box); smallest first so lines never share pixels ----------
texts = []
claimed = np.zeros((H, W), bool)
tl = plan.get('texts', [])
masks = []
for t in tl:
    b = t.get('box')
    if not b: masks.append(None); continue
    pad = max(6, int(0.12 * (b[3] - b[1])))
    px = max(pad, int(0.6 * (b[3] - b[1]))) if t.get('pill') else pad   # a ribbon often runs past the text's own box
    b = clampbox([b[0] - px, b[1] - pad, b[2] + px, b[3] + pad])
    m, _ = sam(b)
    m &= np.pad(np.ones((b[3] - b[1], b[2] - b[0]), bool), ((b[1], H - b[3]), (b[0], W - b[2])))
    masks.append(cv2.dilate(m.astype(np.uint8), np.ones((19, 19), np.uint8)) > 0)   # wide enough to take the line's own shadow/extrusion
_bl = lambda x: cv2.GaussianBlur(x.astype(np.float32), (0, 0), 1.2)
# each lettering pixel belongs to the nearest line (shapes can touch: a headline extrusion running into a pill)
let_bin = let_a > 10
_idx = [i for i in range(len(tl)) if masks[i] is not None]
let_own = np.full((H, W), -1, np.int32)
if _idx:
    _dist = np.stack([cv2.distanceTransform((~masks[i]).astype(np.uint8), cv2.DIST_L2, 3) for i in _idx])
    _near = np.argmin(_dist, 0); _dmin = _dist.min(0)
    let_own = np.where(let_bin & (_dmin < 70), np.array(_idx)[_near], -1)
_pdv = np.abs(_bl(D) - _bl(plate)).sum(2)
plate_diff = _pdv > 70   # what the text adds to the picture: letters, extrusion, pill border
plate_soft = np.clip((_pdv - 18) / 50, 0, 1)   # soft: also the glow / drop shadow around the letters
for i in sorted([i for i in range(len(tl)) if masks[i] is not None], key=lambda i: masks[i].sum()):
    m = masks[i].copy()
    # the analysis box is often tighter than the lettering (a slanted extrusion, a drop shadow): take every lettering
    # shape that mostly belongs to this line, whole
    m |= let_own == i
    m &= ~((let_own >= 0) & (let_own != i))
    m &= ~claimed
    a = np.where(m, let_a, 0).astype(np.uint8)
    # a pill/ribbon behind the line, or lettering the raster missed: take SAM's own shape
    if tl[i].get('pill') or (a > 10).sum() < 0.05 * m.sum():
        a = np.maximum(a, np.where(m, 255, 0).astype(np.uint8))
    near_l = cv2.dilate(((a > 10) | (m if tl[i].get('pill') else np.zeros_like(m))).astype(np.uint8), np.ones((25, 25), np.uint8)) > 0
    pd = m & near_l & plate_diff
    a = np.maximum(a, cv2.GaussianBlur(np.where(pd, 255, 0).astype(np.uint8), (0, 0), 0.8))
    sh = (m & near_l) * plate_soft   # the line's own soft shadow/glow, faded in by how much it darkens/lightens the plate
    a = np.maximum(a, (cv2.GaussianBlur(sh.astype(np.float32), (0, 0), 1.5) * 255).astype(np.uint8))
    own = a > 10
    claimed |= own
    ys, xs = np.where(own)
    if not len(xs): continue
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    f = 'text%d.png' % i
    cv2.imwrite(os.path.join(out, f), np.dstack([D, a])[y0:y1, x0:x1])
    texts.append({'i': i, 'file': f, 'left': int(x0), 'top': int(y0), 'w': int(x1 - x0), 'h': int(y1 - y0)})
# who is in front where subject and lettering overlap, decided per pixel from the design itself
subject_front = False
ov = subj_raw & claimed
textpix = np.zeros((H, W), bool)
if ov.sum() > 200 and let is not None and let.shape[2] == 4:
    diff = np.full((H, W), 999, np.int32)
    diff[ov] = np.abs(D[ov].astype(np.int32) - let[ov][:, :3].astype(np.int32)).sum(1)
    textpix = cv2.morphologyEx((ov & (let_a > 128) & (diff < 70)).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
    subjpix = ov & (let_a > 128) & ~textpix
    subject_front = subjpix.sum() > textpix.sum()
    subj_vis = subj_raw & ~textpix
    # complete AI cutout of the subject (from the PSD job) for the parts the letters hide
    cut = None; best = 0
    for f in sorted(os.listdir(work)):
        if not f.startswith('elem') or not f.endswith('.png'): continue
        e = cv2.imread(os.path.join(work, f), cv2.IMREAD_UNCHANGED)
        if e is None or e.shape[2] != 4: continue
        e = cv2.resize(e, (W, H)); ea = e[:, :, 3] > 128
        inter = (ea & subj_vis).sum(); uni = (ea | subj_vis).sum() + 1
        if inter / uni > best: best, cut = inter / uni, e
    for t in texts:
        im = cv2.imread(os.path.join(out, t['file']), cv2.IMREAD_UNCHANGED)
        sl = (slice(t['top'], t['top'] + t['h']), slice(t['left'], t['left'] + t['w']))
        im[subj_vis[sl], 3] = 0
        if subject_front:   # letters hidden behind the subject come from the complete lettering raster
            hid = subj_vis[sl] & (let_a[sl] > 128)
            im[hid, :3] = let[sl][hid][:, :3]; im[hid, 3] = let_a[sl][hid]
        cv2.imwrite(os.path.join(out, t['file']), im)
    claimed &= ~subj_vis
    hidden_fill = None
    if not subject_front and textpix.any():
        if cut is not None and best > 0.5:
            hidden_fill = (cut, (cut[:, :, 3] > 128) & textpix)
    # without a clean cutout: thin overlaps (letters over hair, an edge) are rebuilt from the subject around them,
    # only a line that hides a big part of the subject stays on screen from the start
    if hidden_fill is None and textpix.any():
        small = np.zeros((H, W), bool); big_lim = max(9000, 0.04 * subj_raw.sum())
        for t in texts:
            m_i = masks[t['i']]
            if m_i is None: continue
            hid_i = m_i & textpix; a_i = int(hid_i.sum())
            if a_i <= 200: continue
            if a_i > big_lim: t['covers_subject'] = True
            else: small |= hid_i
            print('line', t['i'], 'hides', a_i, 'px of subject', 'limit', int(big_lim), file=sys.stderr)
        if small.any():
            hidden_fill = (None, cv2.dilate(small.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0)
    subj_raw = subj_vis | (hidden_fill[1] if hidden_fill is not None else False)
else:
    hidden_fill = None
text_m = cv2.dilate((claimed | ((let_a > 30) & ~(subj_raw if subject_front else np.zeros_like(claimed)))).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0

# ---------- subject: SAM on the director's box; keep the solid object ----------
dep = depth_map(D)
subj = subj_raw.copy()
if sub.get('box'):
    if not subject_front: subj &= ~(text_m & ~(hidden_fill[1] if hidden_fill is not None else np.zeros_like(text_m)))
    sm = subj.astype(np.uint8) if diff_mode else cv2.morphologyEx(subj.astype(np.uint8), cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    n_, lab_, st_, _ = cv2.connectedComponentsWithStats(sm, 8)
    keep = np.zeros_like(sm)
    if n_ > 1:
        main = 1 + int(np.argmax(st_[1:, cv2.CC_STAT_AREA]))
        for i in range(1, n_):
            if i == main or st_[i, cv2.CC_STAT_AREA] > 0.15 * st_[main, cv2.CC_STAT_AREA]: keep[lab_ == i] = 1
        inv = (1 - keep).astype(np.uint8)
        n2, lab2, st2, _ = cv2.connectedComponentsWithStats(inv, 4)
        for i in range(1, n2):
            x, y, w, h, a = st2[i]
            if a < 0.02 * keep.sum() and x > 0 and y > 0 and x + w < W and y + h < H: keep[lab2 == i] = 1
    subj = keep.astype(bool)
    if diff_mode and subj.any():   # ink outline just outside the cutout: it is the hero's if the clean plate does not have it
        fd = np.abs(_bl(D) - _bl(fill)).sum(2) > 60
        subj |= (cv2.dilate(subj.astype(np.uint8), np.ones((11, 11), np.uint8)) > 0) & fd & ~text_m
    if subj.mean() > 0.7 or subj.mean() < 0.003: subj[:] = False    # nonsense mask: no separate subject
has_subj = bool(subj.any())
if has_subj:
    sa = np.clip(cv2.GaussianBlur(cv2.dilate(subj.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(np.float32), (0, 0), 1.0) * 1.2, 0, 1)
    simg = D.copy()
    if hidden_fill is not None and hidden_fill[0] is not None: simg[hidden_fill[1]] = hidden_fill[0][hidden_fill[1]][:, :3]
    elif hidden_fill is not None: simg = cv2.inpaint(simg, hidden_fill[1].astype(np.uint8), 7, cv2.INPAINT_TELEA)
    cv2.imwrite(os.path.join(out, 'subject.png'), np.dstack([simg, (sa * 255).astype(np.uint8)]))
ys, xs = np.where(subj)
bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if has_subj else [0, 0, 0, 0]

# ---------- background: the real design; under the subject the revealed band continues the design ----------
bg = D.copy()
if has_subj:
    hole = cv2.dilate(subj.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    if diff_mode:   # the fill is a clean plate of this design: use it over the whole hole, feathered
        wf = np.clip(cv2.GaussianBlur((cv2.dilate(subj.astype(np.uint8), np.ones((35, 35), np.uint8)) > 0).astype(np.float32), (0, 0), 5) * 1.6, 0, 1)[:, :, None]
        bg = (bg * (1 - wf) + fill * wf).astype(np.uint8)
    else:
        inner = cv2.erode(hole.astype(np.uint8), np.ones((41, 41), np.uint8)) > 0
        bg[inner] = fill[inner]
        bg = cv2.inpaint(bg, (hole & ~inner).astype(np.uint8), 9, cv2.INPAINT_TELEA)
ht = text_m & ~(subj if has_subj else np.zeros_like(text_m))
# how textured is the background around the text? (halftone/comic = textured, night sky / studio = smooth)
_ring = (cv2.dilate(ht.astype(np.uint8), np.ones((61, 61), np.uint8)) > 0) & ~(cv2.dilate(ht.astype(np.uint8), np.ones((21, 21), np.uint8)) > 0)
_g = cv2.cvtColor(D, cv2.COLOR_BGR2GRAY).astype(np.float32)
_tex = float(np.abs(_g - cv2.GaussianBlur(_g, (0, 0), 2))[_ring].mean()) if _ring.any() else 99
print('background texture around text %.1f' % _tex, file=sys.stderr)
if _tex < 4.0:
    # smooth background: the AI plate's tone drifts; carry the design's own tone into it and swap with a wide soft seam,
    # keeping real design elements near the text (a rule line, sparkles)
    _htd = cv2.dilate(ht.astype(np.uint8), np.ones((25, 25), np.uint8)).astype(np.float32)
    if has_subj: _htd *= ~cv2.dilate(subj.astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)
    _keep = cv2.dilate(((_pdv > 70) & ~cv2.dilate(ht.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(np.float32)
    _keep = cv2.GaussianBlur(_keep, (0, 0), 1.5)
    wt = np.clip(np.maximum(cv2.GaussianBlur(_htd, (0, 0), 9) * 1.6 * (1 - _keep), cv2.GaussianBlur(ht.astype(np.float32), (0, 0), 2)), 0, 1)[:, :, None]
    _hole = cv2.dilate(ht.astype(np.uint8), np.ones((75, 75), np.uint8))
    _delta = np.clip(D.astype(np.float32) - plate.astype(np.float32) + 128, 0, 255).astype(np.uint8)
    _delta = cv2.inpaint(_delta, _hole, 15, cv2.INPAINT_TELEA).astype(np.float32) - 128
    plate_c = np.clip(plate.astype(np.float32) + cv2.GaussianBlur(_delta, (0, 0), 12), 0, 255)
else:   # textured background: the plate keeps the pattern exactly; a tight seam
    wt = cv2.GaussianBlur(ht.astype(np.float32), (0, 0), 2)[:, :, None]
    plate_c = plate
bg = (bg * (1 - wt) + plate_c * wt).astype(np.uint8)
cv2.imwrite(os.path.join(out, 'bg_still.png'), bg)

# depth for the background move: around the subject continue the surroundings, then smooth hard
dbg = dep.copy()
if has_subj:
    hole = cv2.dilate(subj.astype(np.uint8), np.ones((15, 15), np.uint8))
    dbg = cv2.inpaint((dbg * 255).astype(np.uint8), hole, 15, cv2.INPAINT_TELEA).astype(np.float32) / 255
dbg = cv2.GaussianBlur(dbg, (0, 0), 28)

cam = plan.get('camera') or {}
z0, z1 = (cam.get('zoom') or [1.0, 1.07])[:2]
xA, xB = (cam.get('x') or [0, 0])[:2]
yA, yB = (cam.get('y') or [0, 0])[:2]
base = float(cam.get('base', 0.2))
def ease(t): return t * t * (3 - 2 * t)
pad = 80
bgp = cv2.copyMakeBorder(bg, pad, pad, pad, pad, cv2.BORDER_REFLECT)
gx, gy = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
k = base + (1 - base) * dbg
N = int(DUR * FPS)
ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', '%dx%d' % (W, H), '-r', str(FPS), '-i', '-',
                       '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuv420p', os.path.join(out, 'bg.mp4')], stdin=subprocess.PIPE)
for f in range(N):
    t = ease(f / (N - 1))
    z = z0 + (z1 - z0) * t; dx = xA + (xB - xA) * t; dy = yA + (yB - yA) * t
    s = 1 + (z - 1) * k
    mx = (gx - W / 2) / s + W / 2 - dx * k + pad
    my = (gy - H / 2) / s + H / 2 - dy * k + pad
    ff.stdin.write(cv2.remap(bgp, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT).tobytes())
ff.stdin.close(); ff.wait()
sd = float(dep[subj].mean()) if has_subj else 0.5
json.dump({'W': W, 'H': H, 'dur': DUR, 'fps': FPS,
           'subject': {'file': 'subject.png', 'bbox': bbox, 'depth': sd, 'iou': iou, 'cover': round(float(subj.mean()) * 100, 1)} if has_subj else None,
           'texts': texts, 'subject_front': bool(subject_front), 'camera': {'zoom': [z0, z1], 'x': [xA, xB], 'y': [yA, yB], 'base': base}},
          open(os.path.join(out, 'scene.json'), 'w'), indent=1)
print(json.dumps({'front': bool(subject_front), 'subject': has_subj, 'cover': round(float(subj.mean()) * 100, 1), 'iou': round(iou, 3), 'texts': len(texts)}))
