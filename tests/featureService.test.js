// Zero-dependency checks: `npm test`. Covers featureService pure functions
// and the TTL cache (incl. stale-serving for graceful degradation).
const assert = require('node:assert/strict');
const { computeFeatures, computeFertiliserFeatures, computeTillageFeatures, computeLivestockFeatures, computeObservedFeatures, NO_WINDOW } = require('../server/services/featureService');
const { buildRecheckHint, ruleBasedAdvice, buildUserPrompt } = require('../server/services/aiService');
const { formatReply, FARMING_PLAN_INTRO } = require('../server/services/telegramService');
const { buildImageRequest, IMAGE_MODEL_ID, MAX_PROMPT_CHARS } = require('../server/services/imageService');
const { livestockSeason, buildVisualPrompt, assertPlanC, SPECIES } = require('../server/services/livestockPlanService');
const { parseAction, parseLanguage, SUPPORTED_ACTIONS } = require('../server/services/telegramService');
const { pickPhotoId } = require('../server/services/cropHealthService');
const { TTLCache, buildKey } = require('../server/utils/cache');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

const dryWeek = {
  time: ['2025-11-03', '2025-11-04', '2025-11-05', '2025-11-06', '2025-11-07', '2025-11-08', '2025-11-09'],
  precipitation_sum: [0, 0, 0, 0, 0, 0, 0],
  precipitation_probability_max: [5, 5, 10, 10, 5, 5, 5],
  temperature_2m_max: [30, 31, 32, 31, 30, 29, 30],
};

const rainyWeek = {
  time: ['2025-11-03', '2025-11-04', '2025-11-05', '2025-11-06', '2025-11-07', '2025-11-08', '2025-11-09'],
  precipitation_sum: [0, 0, 18, 2, 30, 0, 1],
  precipitation_probability_max: [10, 20, 80, 40, 90, 10, 15],
  temperature_2m_max: [32, 33, 29, 30, 28, 36, 35],
};

check('dry week: no window, full dry streak', () => {
  const f = computeFeatures(dryWeek, 'maize');
  assert.equal(f.has_effective_rain_in_window, false);
  assert.equal(f.first_effective_rain_date, NO_WINDOW);
  assert.equal(f.best_confidence_for_first_effective_rain, null);
  assert.equal(f.dry_streak_days, 7);
  assert.equal(f.rain_next_5d_mm, 0);
  assert.equal(f.heavy_rain_risk_days, 0);
  assert.equal(f.heat_stress_days, 0);
  assert.equal(f.window_through, '2025-11-09');
});

check('rainy week maize: first effective date + confidence', () => {
  const f = computeFeatures(rainyWeek, 'Maize');
  assert.equal(f.has_effective_rain_in_window, true);
  assert.equal(f.first_effective_rain_date, '2025-11-05');
  assert.equal(f.best_confidence_for_first_effective_rain, 80);
  assert.equal(f.rain_next_5d_mm, 50);
  assert.equal(f.heavy_rain_risk_days, 1);
  assert.equal(f.heat_stress_days, 2);
  assert.equal(f.dry_streak_days, 2);
});

check('thresholds differ per crop: 12mm suits beans, not maize', () => {
  const d = {
    time: ['2025-11-03', '2025-11-04'],
    precipitation_sum: [12, 0],
    temperature_2m_max: [30, 30],
  };
  assert.equal(computeFeatures(d, 'beans').has_effective_rain_in_window, true);
  assert.equal(computeFeatures(d, 'maize').has_effective_rain_in_window, false);
});

check('beans flagged waterlogging-sensitive, maize not', () => {
  assert.equal(computeFeatures(dryWeek, 'beans').waterlogging_sensitive, true);
  assert.equal(computeFeatures(dryWeek, 'maize').waterlogging_sensitive, false);
});

check('missing probability array: confidence null, no crash', () => {
  const d = {
    time: ['2025-11-03'],
    precipitation_sum: [20],
    temperature_2m_max: [30],
  };
  const f = computeFeatures(d, 'maize');
  assert.equal(f.first_effective_rain_date, '2025-11-03');
  assert.equal(f.best_confidence_for_first_effective_rain, null);
});

check('invalid inputs throw, never guess', () => {
  assert.throws(() => computeFeatures(dryWeek, 'wheat'), /unknown crop/);
  assert.throws(() => computeFeatures({ time: [], precipitation_sum: [], temperature_2m_max: [] }, 'maize'), /must not be empty/);
  assert.throws(() => computeFeatures({ time: ['a', 'b'], precipitation_sum: [1], temperature_2m_max: [1, 2] }, 'maize'), /same length/);
  assert.throws(() => computeFeatures(null, 'maize'), /must be an object/);
});

check('cache: fresh hit, miss, stale serving', () => {
  const c = new TTLCache();
  assert.equal(c.get('nope'), undefined);
  assert.equal(c.getStale('nope'), undefined);
  c.set('fresh', { a: 1 }, 60_000);
  assert.deepEqual(c.get('fresh'), { a: 1 });
  assert.deepEqual(c.getStale('fresh'), { value: { a: 1 }, stale: false });
  c.set('old', { b: 2 }, -1); // already expired
  assert.equal(c.get('old'), undefined);
  assert.deepEqual(c.getStale('old'), { value: { b: 2 }, stale: true });
});

check('cache keys stable regardless of param order', () => {
  assert.equal(buildKey('w', { lat: -15, lon: 28 }), buildKey('w', { lon: 28, lat: -15 }));
  assert.notEqual(buildKey('w', { lat: -15 }), buildKey('w', { lat: -14 }));
});

check('fertiliser: useful rain date + confidence, no heavy in 3d', () => {
  const f = computeFertiliserFeatures(rainyWeek);
  assert.equal(f.rain_next_3d_mm, 18);
  assert.equal(f.heavy_rain_in_3d, false);
  assert.equal(f.first_useful_rain_date, '2025-11-05');
  assert.equal(f.best_confidence_for_first_useful_rain, 80);
  assert.equal(f.bone_dry, false);
});

check('fertiliser: heavy rain tomorrow flags runoff risk', () => {
  const f = computeFertiliserFeatures({
    time: ['2025-11-03', '2025-11-04', '2025-11-05'],
    precipitation_sum: [0, 30, 0],
    temperature_2m_max: [30, 29, 30],
  });
  assert.equal(f.heavy_rain_in_3d, true);
  assert.equal(f.bone_dry, false);
});

check('fertiliser: week-long dry means bone dry, no useful date', () => {
  const f = computeFertiliserFeatures(dryWeek);
  assert.equal(f.bone_dry, true);
  assert.equal(f.first_useful_rain_date, NO_WINDOW);
  assert.equal(f.best_confidence_for_first_useful_rain, null);
});

check('tillage: counts heavy days and dry days', () => {
  const f = computeTillageFeatures(rainyWeek);
  assert.equal(f.rain_next_5d_mm, 50);
  assert.equal(f.heavy_rain_risk_days, 1);
  assert.equal(f.dry_days_in_window, 3);
  const d = computeTillageFeatures(dryWeek);
  assert.equal(d.heavy_rain_risk_days, 0);
  assert.equal(d.dry_days_in_window, 7);
});

check('parseAction: plant/fertiliser/till, no false positives', () => {
  assert.equal(parseAction('Plant'), 'plant');
  assert.equal(parseAction('Apply fertiliser'), 'fertiliser');
  assert.equal(parseAction('I need DAP'), 'fertiliser');
  assert.equal(parseAction('Till fields'), 'till');
  assert.equal(parseAction('📷 Crop health'), 'crop-health');
  assert.equal(parseAction('Farming plan'), 'farming-plan');
  assert.equal(parseAction('still waiting'), null);
  assert.equal(parseAction('hello'), null);
});

check('parseLanguage: four languages, null otherwise', () => {
  assert.equal(parseLanguage('Bemba'), 'bemba');
  assert.equal(parseLanguage('Answer in Nyanja'), 'nyanja');
  assert.equal(parseLanguage('tonga'), 'tonga');
  assert.equal(parseLanguage('English please'), 'english');
  assert.equal(parseLanguage('hello'), null);
});

check('supported actions are plant + crop-health + farming-plan', () => {
  assert.deepEqual(SUPPORTED_ACTIONS, ['plant', 'crop-health', 'farming-plan']);
});

check('pickPhotoId: largest size wins, null when empty', () => {
  assert.equal(pickPhotoId({ photo: [{ file_id: 'small' }, { file_id: 'big' }] }), 'big');
  assert.equal(pickPhotoId({}), null);
  assert.equal(pickPhotoId({ photo: [] }), null);
});

check('livestock: rainy week counts heat, heavy rain, dry days', () => {
  const f = computeLivestockFeatures(rainyWeek);
  assert.equal(f.rain_window_total_mm, 51);
  assert.equal(f.heavy_rain_days, 1);
  assert.equal(f.heat_stress_days, 2);
  assert.equal(f.dry_days_in_window, 3);
  assert.equal(f.window_through, '2025-11-09');
});

check('livestock: dry week is all dry days, no heat', () => {
  const f = computeLivestockFeatures(dryWeek);
  assert.equal(f.rain_window_total_mm, 0);
  assert.equal(f.heavy_rain_days, 0);
  assert.equal(f.heat_stress_days, 0);
  assert.equal(f.dry_days_in_window, 7);
});

check('livestock season: Nov–Apr rainy, May–Oct dry', () => {
  assert.equal(livestockSeason(new Date(2026, 10, 15)), 'rainy');
  assert.equal(livestockSeason(new Date(2026, 1, 15)), 'rainy');
  assert.equal(livestockSeason(new Date(2026, 5, 15)), 'dry');
  assert.equal(livestockSeason(new Date(2026, 7, 15)), 'dry');
});

check('supported livestock species are cattle, goats, chickens', () => {
  assert.deepEqual(SPECIES, ['cattle', 'goats', 'chickens']);
});

check('image request: one-shot generations shape per docs', () => {
  assert.equal(IMAGE_MODEL_ID, 'muse-image-1.0');
  const b = buildImageRequest('a raised goat shelter');
  assert.equal(b.model, 'muse-image-1.0');
  assert.equal(b.n, 1);
  assert.equal(b.size, '1536x1024');
  assert.equal(b.response_format, 'b64_json');
  assert.equal(b.output_format, 'png');
  assert.equal(b.reasoning_strength, 'high');
  assert.equal(b.prompt, 'a raised goat shelter');
});

check('image request: long prompts truncated, empty rejected', () => {
  const b = buildImageRequest('x'.repeat(MAX_PROMPT_CHARS + 50));
  assert.equal(b.prompt.length, MAX_PROMPT_CHARS);
  assert.throws(() => buildImageRequest('   '), /non-empty/);
});

check('visual prompt: grounded prefix, blocks diagnosis and dosage', () => {
  const ok = buildVisualPrompt('raised shelter from poles and thatch', { species: 'goats', breed: 'local', season: 'dry' });
  assert.equal(ok.ok, true);
  assert.match(ok.prompt, /goats.*local.*dry season/);
  assert.match(ok.prompt, /raised shelter/);
  assert.equal(buildVisualPrompt('', { species: 'goats', breed: 'local', season: 'dry' }).ok, false);
  assert.equal(buildVisualPrompt('diagram of foot-rot symptoms', { species: 'goats', breed: 'local', season: 'dry' }).ok, false);
  assert.equal(buildVisualPrompt('deworming dosage chart in mg/kg', { species: 'goats', breed: 'local', season: 'dry' }).ok, false);
});

const goodLivestockPlan = {
  housing: ['Build a raised shelter.'],
  feeding: ['Graze morning and evening.'],
  health: ['Vaccinate before the rains.'],
  breeding: ['Breed in January.'],
  risks: ['Dry-season feed gap.'],
  market: ['Sell at 12 months.'],
  image_prompt: 'raised goat shelter from poles and thatch',
  image_caption: 'A raised shelter keeps goats dry.',
};

check('livestock plan validation: complete passes, gaps throw', () => {
  assert.deepEqual(assertPlanC({ ...goodLivestockPlan }), goodLivestockPlan);
  assert.throws(() => assertPlanC({ ...goodLivestockPlan, feeding: [] }), /feeding/);
  assert.throws(() => assertPlanC({ ...goodLivestockPlan, image_prompt: '  ' }), /image prompt/);
  assert.throws(() => assertPlanC({ ...goodLivestockPlan, image_caption: '' }), /image caption/);
});

const wetPast = {
  time: ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'],
  precipitation_sum: [0, 0, 5, 22, 3, 0, 1],
};

const dryPast = {
  time: ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'],
  precipitation_sum: [0, 0, 0, 0, 0, 0, 0],
};

check('observed: wet last-5d flags recently wet for maize', () => {
  const o = computeObservedFeatures(wetPast, 'maize');
  assert.equal(o.observed_rain_last_5d_mm, 31);
  assert.equal(o.observed_rain_days, 4);
  assert.equal(o.days_since_rain, 0);
  assert.equal(o.recently_wet, true);
  assert.equal(o.observed_days, 5);
});

check('observed: dry past is not wet, days-since unknown', () => {
  const o = computeObservedFeatures(dryPast, 'maize');
  assert.equal(o.observed_rain_last_5d_mm, 0);
  assert.equal(o.observed_rain_days, 0);
  assert.equal(o.days_since_rain, null);
  assert.equal(o.recently_wet, false);
});

check('observed: short history uses what exists, validates shape', () => {
  const o = computeObservedFeatures({ time: ['2026-11-01', '2026-11-02'], precipitation_sum: [4, 0] }, 'maize');
  assert.equal(o.observed_rain_last_5d_mm, 4);
  assert.equal(o.days_since_rain, 1);
  assert.equal(o.recently_wet, false);
  assert.throws(() => computeObservedFeatures({ time: ['a'], precipitation_sum: [1, 2] }, 'maize'), /same length/);
  assert.throws(() => computeObservedFeatures(dryPast, 'wheat'), /unknown crop/);
});

const dryFeatures = () => ({ ...computeFeatures(dryWeek, 'maize'), ...computeObservedFeatures(dryPast, 'maize') });
const wetSoilFeatures = () => ({ ...computeFeatures(dryWeek, 'maize'), ...computeObservedFeatures(wetPast, 'maize') });

check('recheck hint: dry WAIT names the trigger with crop threshold', () => {
  const h = buildRecheckHint('plant', dryFeatures());
  assert.match(h, /Re-check/);
  assert.match(h, /15mm/);
  assert.match(h, /3 days/);
});

check('recheck hint: wet soil mentions moisture and the hand check', () => {
  const h = buildRecheckHint('plant', wetSoilFeatures());
  assert.match(h, /moist/);
  assert.match(h, /31mm/);
  assert.match(h, /seed depth/);
});

check('recheck hint: only for planting WAITs, never GO', () => {
  assert.equal(buildRecheckHint('plant', { ...computeFeatures(rainyWeek, 'maize') }), null);
  assert.equal(buildRecheckHint('fertiliser', dryFeatures()), null);
  assert.equal(buildRecheckHint('till', dryFeatures()), null);
});

check('fallback advice carries the recheck hint on WAIT', () => {
  const d = ruleBasedAdvice({ action: 'plant', features: dryFeatures() }, ['t'], null);
  assert.equal(d.recommendation, 'WAIT');
  assert.match(d.recheck_hint, /Re-check/);
});

check('soils hidden from reply but kept in model prompt', () => {
  const d = ruleBasedAdvice(
    { action: 'plant', features: dryFeatures(), soilData: 'Acrisols; pH 4.3-5.6' },
    ['t'], null
  );
  assert.doesNotMatch(d.context_notes.join(' | '), /Acrisols/);
  const prompt = buildUserPrompt('plant', { features: dryFeatures(), soilData: 'Acrisols; pH 4.3-5.6' });
  assert.match(prompt, /Acrisols/);
});

check('farming plan intro links the live site', () => {
  assert.match(FARMING_PLAN_INTRO, /agrisense-f5ky\.onrender\.com\/plan\.html/);
});

check('telegram reply renders the recheck line only when present', () => {
  const base = { recommendation: 'WAIT', confidence: 'low', reason_plain: 'dry', timing: 'none', risk_flags: [], context_notes: [] };
  const ctx = { district: { name: 'lusaka', province: 'Lusaka', matched: true }, crop: 'maize', action: 'plant', stale: false };
  assert.match(formatReply({ ...base, recheck_hint: 'Re-check when it rains.' }, ctx), /Re-check/);
  assert.doesNotMatch(formatReply(base, ctx), /Re-check/);
});

console.log(`\n${passed} checks passed`);
