// Joker motion v3 — one job: unpack images, merge the director's plan with the text boxes, run prep3.py + compose3.js
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
function writePng(file, b64) {
  // written as-is: prep resamples model outputs (a few px larger, scaled not padded) to the design size
  if (!b64) return false;
  fs.writeFileSync(file, Buffer.from(b64, 'base64')); return true;
}
function buildMotion3(job, outDir, id) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-'));
  const orig = PNG.sync.read(Buffer.from(job.original_b64, 'base64'));
  const W = orig.width, H = orig.height;
  writePng(path.join(work, 'design.png'), job.original_b64);
  writePng(path.join(work, 'plate.png'), job.plate_b64, W, H);
  writePng(path.join(work, 'fill.png'), job.fill_b64, W, H);
  writePng(path.join(work, 'lettering.png'), job.text_b64, W, H);
  (job.elements || []).forEach((e, i) => { try { writePng(path.join(work, 'elem' + i + '.png'), e.cut_b64, W, H); } catch (x) {} });
  const plan = Object.assign({ duration: 7 }, job.motion_plan || {});
  const texts = job.texts || [];
  plan.texts = texts.map((t, i) => {
    const p = (Array.isArray(plan.texts) && (plan.texts.find((x) => Number(x.index) === i) || plan.texts[i])) || {};
    const x = +t.x, y = +t.y, w = +t.w, h = +t.h;
    return { ...p, index: i, color: t.color, box: w > 4 && h > 4 ? [x, y, x + w, y + h] : null };
  });
  fs.writeFileSync(path.join(work, 'plan.json'), JSON.stringify(plan, null, 1));
  const py = process.env.JM_PYTHON || 'python3';
  const a = spawnSync(py, [path.join(__dirname, 'prep3.py'), work], { stdio: 'inherit' });
  if (a.status !== 0) throw new Error('prep3 failed');
  const mp4 = path.join(outDir, id + '.motion.mp4'), zip = path.join(outDir, id + '.motion-ae.zip');
  const b = spawnSync('node', [path.join(__dirname, 'compose3.js'), work, mp4, zip], { stdio: 'inherit' });
  if (b.status !== 0) throw new Error('compose3 failed');
  return { mp4, zip, plan };
}
module.exports = { buildMotion3 };
if (require.main === module) {
  const [, , jobPath, outDir] = process.argv;
  const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
  console.log(JSON.stringify(buildMotion3(job, outDir || '.', path.basename(jobPath, '.json')).mp4));
}
