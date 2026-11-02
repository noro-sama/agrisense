// Zero-dependency checks: `npm test`. Covers featureService pure functions
// and the TTL cache (incl. stale-serving for graceful degradation).
const assert = require('node:assert/strict');
const { computeFeatures, computeFertiliserFeatures, computeTillageFeatures, NO_WINDOW } = require('../server/services/featureService');
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

check('supported actions are plant + crop-health', () => {
  assert.deepEqual(SUPPORTED_ACTIONS, ['plant', 'crop-health']);
});

check('pickPhotoId: largest size wins, null when empty', () => {
  assert.equal(pickPhotoId({ photo: [{ file_id: 'small' }, { file_id: 'big' }] }), 'big');
  assert.equal(pickPhotoId({}), null);
  assert.equal(pickPhotoId({ photo: [] }), null);
});

console.log(`\n${passed} checks passed`);
