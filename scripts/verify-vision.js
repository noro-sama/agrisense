// Live vision verification: HEALTHY / SUSPECT / blurry verdicts + translations.
// Run: node scripts/verify-vision.js (needs MODEL_API_KEY in .env).
// Never prints the key. Exits 1 on wrong verdict, fallback use, or drift.
require('dotenv').config();
const fs = require('fs');
const { analyzeCropImage, translateDecision } = require('../server/services/aiService');
const { formatReply } = require('../server/services/telegramService');

const cases = [
  { file: 'generated_images/call_01a19c98f64f73059dee63f35c84391d.jpg', expect: 'HEALTHY' },
  { file: 'generated_images/call_01a19c8ecaf677a59e3a3c0b9503a1a5.jpg', expect: 'SUSPECT' },
  { file: 'generated_images/call_01a19c8ecca9739eaa9262ded1cdd099.jpg', expect: 'SUSPECT', expectLow: true },
];

(async () => {
  if (!process.env.MODEL_API_KEY && !process.env.META_API_KEY) {
    console.error('MODEL_API_KEY (or META_API_KEY) missing from .env');
    process.exit(1);
  }
  let fail = 0;
  let suspect = null;
  for (const c of cases) {
    const base64 = fs.readFileSync(c.file).toString('base64');
    const t0 = Date.now();
    const d = await analyzeCropImage(base64, 'image/jpeg', { crop: 'maize' });
    console.log(`--- ${c.file.split('/').pop()} ${Date.now() - t0}ms`);
    console.log(`verdict: ${d.recommendation} (${d.confidence})`);
    console.log(`explanation: ${d.reason_plain}`);
    console.log(`timing: ${d.timing}`);
    console.log(`cautions: ${d.risk_flags.join(' | ')}`);
    const usedFallback = d.context_notes.some((n) => /AI unavailable|AI reply invalid/i.test(n));
    if (usedFallback) {
      console.log('FAIL: fallback used');
      fail = 1;
    }
    if (d.recommendation !== c.expect) {
      console.log(`FAIL: expected ${c.expect}`);
      fail = 1;
    }
    if (c.expectLow && d.confidence !== 'low') {
      console.log('FAIL: blurry photo should be low confidence');
      fail = 1;
    }
    if (c.expect === 'SUSPECT' && !c.expectLow) suspect = d;
  }
  if (suspect) {
    for (const lang of ['bemba', 'nyanja', 'tonga']) {
      const t0 = Date.now();
      const t = await translateDecision(suspect, { district: 'kasama', crop: 'maize', action: 'crop-health' }, lang);
      const ok = t.recommendation === suspect.recommendation && t.confidence === suspect.confidence;
      console.log(`--- translate ${lang} ${Date.now() - t0}ms verdict:${ok ? 'OK' : 'FAIL'}`);
      console.log(`explanation: ${t.reason_plain}`);
      if (!ok) fail = 1;
      if (lang === 'bemba') {
        console.log('--- formatted reply ---');
        console.log(formatReply(t, { district: null, crop: 'maize', action: 'crop-health', stale: false }));
      }
    }
  }
  process.exit(fail);
})().catch((e) => {
  console.error(`ERROR ${e.message}`);
  process.exit(1);
});
