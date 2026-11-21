// Runs inside the GitHub Action: builds a PSD for every job file in ../jobs and writes it to ../out.
// Jobs with "motion": true also get <id>.motion.mp4 and <id>.motion-ae.zip (see motion.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build } = require('./build');
const { buildMotion } = require('./motion');
const { buildMotion2 } = require('./motion2/run');

(async () => {
  const jobsDir = path.join(__dirname, '..', 'jobs');
  const outDir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).filter((f) => f.endsWith('.json')) : [];
  let failed = 0;
  for (const f of files) {
    const id = f.replace(/\.json$/, '').replace(/[^A-Za-z0-9_-]/g, '');
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf8'));
      if (!job.original_b64) {
        if (!/^https:\/\/raw\.githubusercontent\.com\//.test(String(job.image_url || ''))) throw new Error('job has no original image');
        const res = await fetch(job.image_url);
        if (!res.ok) throw new Error('original download failed: ' + res.status);
        job.original_b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
      }
      const r = build(job);
      fs.writeFileSync(path.join(outDir, id + '.psd'), r.buffer);
      const rep = { ok: true, bytes: r.buffer.length, width: r.width, height: r.height, layers: r.layers, report: r.report };
      if (job.motion) {
        try {
          const work = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-'));
          const m = job.motion_plan ? buildMotion2(job, work, id) : buildMotion(job, work, id, r.parts);
          fs.copyFileSync(m.mp4, path.join(outDir, id + '.motion.mp4'));
          fs.copyFileSync(m.zip, path.join(outDir, id + '.motion-ae.zip'));
          rep.motion = { ok: true, engine: job.motion_plan ? 'v2' : 'v1', mood: m.mood, layers: m.layers, plan: m.plan };
          console.log('motion', id, m.mood || 'v2', (m.layers || []).join(' | '));
        } catch (e) {
          rep.motion = { ok: false, error: String(e && e.message ? e.message : e) };
          console.log('MOTION FAILED', id, e);
        }
      }
      fs.writeFileSync(path.join(outDir, id + '.report.json'), JSON.stringify(rep, null, 1));
      console.log('built', id, r.buffer.length, JSON.stringify(r.report));
    } catch (e) {
      failed++;
      fs.writeFileSync(path.join(outDir, id + '.report.json'), JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }, null, 1));
      console.log('FAILED', id, e);
    }
  }
  console.log('jobs:', files.length, 'failed:', failed);
})();
