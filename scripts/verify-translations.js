// Live verification: real planting advisory + translation into all 4 languages.
// Run: node scripts/verify-translations.js (needs MODEL_API_KEY in .env).
// Never prints the key. Exits 1 if the fallback was used, if verdict/
// confidence change, or if any number goes missing in translation.
require('dotenv').config();
const { computeFeatures } = require('../server/services/featureService');
const { getPlantingDecision, translateDecision } = require('../server/services/aiService');

const daily = {
  time: ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'],
  precipitation_sum: [0, 0, 18, 2, 5, 0, 1],
  precipitation_probability_max: [10, 20, 80, 40, 50, 10, 15],
  temperature_2m_max: [32, 33, 29, 30, 31, 32, 33],
};

const numbersOf = (s) => String(s).match(/\d+(?:\.\d+)?/g) || [];

(async () => {
  if (!process.env.MODEL_API_KEY && !process.env.META_API_KEY) {
    console.error('MODEL_API_KEY (or META_API_KEY) missing from .env');
    process.exit(1);
  }
  const features = computeFeatures(daily, 'maize');
  const t0 = Date.now();
  const decision = await getPlantingDecision({
    action: 'plant',
    features,
    cropKnowledge: '',
    soilData: 'Acrisols, Ferralsols; pH 4.3-5.6',
    droughtNote: 'Last season drought: moderate (historical, 2023/24)',
    sources_used: ['verify:script'],
  });
  console.log(`advisory ${Date.now() - t0}ms: ${decision.recommendation} (${decision.confidence})`);
  if (/rule-based/i.test(decision.context_notes.join(' '))) {
    console.error('FALLBACK USED - no live model verdict to verify');
    process.exit(1);
  }
  const origNums = [...new Set([
    ...numbersOf(decision.reason_plain),
    ...numbersOf(decision.timing),
    ...decision.risk_flags.flatMap(numbersOf),
  ])];
  let fail = 0;
  for (const lang of ['bemba', 'nyanja', 'tonga', 'english']) {
    const s = Date.now();
    const t = await translateDecision(decision, { district: 'kasama', crop: 'maize', action: 'plant' }, lang);
    const ms = Date.now() - s;
    const okVerdict = t.recommendation === decision.recommendation && t.confidence === decision.confidence;
    const text = [t.reason_plain, t.timing, ...t.risk_flags, ...t.context_notes].join(' ');
    const missing = origNums.filter((n) => !text.includes(n));
    console.log(`--- ${lang} ${ms}ms verdict:${okVerdict ? 'OK' : 'FAIL'} numbers:${missing.length ? `MISSING ${missing.join(',')}` : 'OK'}`);
    console.log(`explanation: ${t.reason_plain}`);
    console.log(`timing: ${t.timing}`);
    console.log(`cautions: ${t.risk_flags.join(' | ')}`);
    console.log(`notes: ${t.context_notes.join(' | ')}`);
    if (!okVerdict || missing.length) fail = 1;
  }
  process.exit(fail);
})().catch((e) => {
  console.error(`ERROR ${e.message}`);
  process.exit(1);
});
