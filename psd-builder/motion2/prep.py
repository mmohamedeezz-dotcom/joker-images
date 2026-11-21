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
fill = rd('fill.png'); fill = cv2.resize(fill, (W, H)) if fill is not None else plate
let = rd('lettering.png', cv2.IMREAD_UNCHANGED)
let_a = np.zeros((H, W), np.uint8)
if let is not None and let.shape[2] == 4:
    let = cv2.resize(let, (W, H)); let_a = let[:, :, 3]
plan = json.load(open(os.path.join(work, 'plan.json')))
FPS, DUR = 30, float(plan.get('duration', 6))
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

# ---------- text lines: lettering ∩ SAM(line box); smallest first so lines never share pixels ----------
texts = []
claimed = np.zeros((H, W), bool)
tl = plan.get('texts', [])
masks = []
for t in tl:
    b = t.get('box')
    if not b: masks.append(None); continue
    pad = max(6, int(0.12 * (b[3] - b[1])))
    b = clampbox([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad])
    m, _ = sam(b)
    m &= np.pad(np.ones((b[3] - b[1], b[2] - b[0]), bool), ((b[1], H - b[3]), (b[0], W - b[2])))
    masks.append(cv2.dilate(m.astype(np.uint8), np.ones((19, 19), np.uint8)) > 0)   # wide enough to take the line's own shadow/extrusion
for i in sorted([i for i in range(len(tl)) if masks[i] is not None], key=lambda i: masks[i].sum()):
    m = masks[i] & ~claimed
    a = np.where(m, let_a, 0).astype(np.uint8)
    # a pill/ribbon behind the line, or lettering the raster missed: take SAM's own shape
    if tl[i].get('pill') or (a > 10).sum() < 0.05 * m.sum():
        a = np.maximum(a, np.where(m, 255, 0).astype(np.uint8))
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
    # without a clean cutout the hidden part is unknown: lines in front of the subject stay on screen from the start
    if hidden_fill is None and textpix.any():
        for t in texts:
            m_i = masks[t['i']]
            if m_i is not None and (m_i & textpix).sum() > 200: t['covers_subject'] = True
    subj_raw = subj_vis | (hidden_fill[1] if hidden_fill is not None else False)
else:
    hidden_fill = None
text_m = cv2.dilate((claimed | ((let_a > 30) & ~(subj_raw if subject_front else np.zeros_like(claimed)))).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0

# ---------- subject: SAM on the director's box; keep the solid object ----------
dep = depth_map(D)
subj = subj_raw.copy()
if sub.get('box'):
    if not subject_front: subj &= ~(text_m & ~(hidden_fill[1] if hidden_fill is not None else np.zeros_like(text_m)))
    sm = cv2.morphologyEx(subj.astype(np.uint8), cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
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
    if subj.mean() > 0.7 or subj.mean() < 0.003: subj[:] = False    # nonsense mask: no separate subject
has_subj = bool(subj.any())
if has_subj:
    sa = np.clip(cv2.GaussianBlur(cv2.dilate(subj.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(np.float32), (0, 0), 1.0) * 1.2, 0, 1)
    simg = D.copy()
    if hidden_fill is not None: simg[hidden_fill[1]] = hidden_fill[0][hidden_fill[1]][:, :3]
    cv2.imwrite(os.path.join(out, 'subject.png'), np.dstack([simg, (sa * 255).astype(np.uint8)]))
ys, xs = np.where(subj)
bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if has_subj else [0, 0, 0, 0]

# ---------- background: the real design; under the subject the revealed band continues the design ----------
bg = D.copy()
if has_subj:
    hole = cv2.dilate(subj.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    inner = cv2.erode(hole.astype(np.uint8), np.ones((41, 41), np.uint8)) > 0
    bg[inner] = fill[inner]
    bg = cv2.inpaint(bg, (hole & ~inner).astype(np.uint8), 9, cv2.INPAINT_TELEA)
ht = text_m & ~(subj if has_subj else np.zeros_like(text_m))
wt = cv2.GaussianBlur(ht.astype(np.float32), (0, 0), 2)[:, :, None]
bg = (bg * (1 - wt) + plate * wt).astype(np.uint8)
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
