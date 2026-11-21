// Joker motion v2 — one job: unpack the images, merge the director's plan with the text boxes,
// run prep.py (depth + SAM + 2.5D background) and compose.js (render + sound + After Effects package).
// usage (module): buildMotion2(job, outDir, id)  ->  { mp4, zip }
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

function writePng(file, b64, W, H) {
  if (!b64) return false;
  const img = PNG.sync.read(Buffer.from(b64, 'base64'));
  if (W && H && (img.width !== W || img.height !== H)) {
    // centre-crop (model outputs come a few px larger) or let prep.py resize
    if (img.width >= W && img.height >= H && img.width - W < 32 && img.height - H < 32) {
      const out = new PNG({ width: W, height: H }), x0 = (img.width - W) >> 1, y0 = (img.height - H) >> 1;
      for (let y = 0; y < H; y++) img.data.copy(out.data, y * W * 4, ((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0 + W) * 4);
      fs.writeFileSync(file, PNG.sync.write(out)); return true;
    }
  }
  fs.writeFileSync(file, PNG.sync.write(img)); return true;
}

function buildMotion2(job, outDir, id) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-'));
  const orig = PNG.sync.read(Buffer.from(job.original_b64, 'base64'));
  const W = orig.width, H = orig.height;
  writePng(path.join(work, 'design.png'), job.original_b64);
  writePng(path.join(work, 'plate.png'), job.plate_b64, W, H);
  writePng(path.join(work, 'fill.png'), job.fill_b64, W, H);
  writePng(path.join(work, 'lettering.png'), job.text_b64, W, H);
  (job.elements || []).forEach((e, i) => { try { writePng(path.join(work, 'elem' + i + '.png'), e.cut_b64, W, H); } catch (x) {} });
  const plan = Object.assign({ duration: 6 }, job.motion_plan || {});
  const texts = job.texts || [];
  plan.texts = texts.map((t, i) => {
    const p = (Array.isArray(plan.texts) && (plan.texts.find((x) => Number(x.index) === i) || plan.texts[i])) || {};
    const x = +t.x, y = +t.y, w = +t.w, h = +t.h;
    return { ...p, box: w > 4 && h > 4 ? [x, y, x + w, y + h] : null };
  });
  fs.writeFileSync(path.join(work, 'plan.json'), JSON.stringify(plan, null, 1));
  const py = process.env.JM_PYTHON || 'python3';
  const a = spawnSync(py, [path.join(__dirname, 'prep.py'), work], { stdio: 'inherit' });
  if (a.status !== 0) throw new Error('prep failed');
  const mp4 = path.join(outDir, id + '.motion.mp4'), zip = path.join(outDir, id + '.motion-ae.zip');
  const b = spawnSync('node', [path.join(__dirname, 'compose.js'), work, mp4, zip], { stdio: 'inherit' });
  if (b.status !== 0) throw new Error('compose failed');
  return { mp4, zip, plan };
}
module.exports = { buildMotion2 };
if (require.main === module) {
  const [, , jobPath, outDir] = process.argv;
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  console.log(JSON.stringify(buildMotion2(job, outDir || '.', path.basename(jobPath, '.json')).mp4));
}
