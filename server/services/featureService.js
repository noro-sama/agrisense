// Pure agronomic feature computation. Input: AgriRigo daily arrays.
// No network, no Date.now(), no side effects — unit-testable.
// Thresholds are documented starting values; tune from field feedback.
const CROP_PROFILES = {
  maize: { minEffectiveRainMm: 15, cumulative3dMm: 20, waterloggingSensitive: false },
  beans: { minEffectiveRainMm: 10, cumulative3dMm: 15, waterloggingSensitive: true }, // lost a crop to heavy rain: flag flood risk
  groundnuts: { minEffectiveRainMm: 10, cumulative3dMm: 15, waterloggingSensitive: false },
  soybean: { minEffectiveRainMm: 12, cumulative3dMm: 17, waterloggingSensitive: false },
};

const NO_WINDOW = 'none_within_forecast_window';
const HEAVY_RAIN_MM = 25;
const HEAT_STRESS_C = 35;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function assertDaily(daily) {
  if (!daily || typeof daily !== 'object') throw new Error('featureService: daily payload must be an object');
  for (const k of ['time', 'precipitation_sum', 'temperature_2m_max']) {
    if (!Array.isArray(daily[k])) throw new Error(`featureService: daily.${k} must be an array`);
  }
  const n = daily.time.length;
  if (n === 0) throw new Error('featureService: daily arrays must not be empty');
  if (daily.precipitation_sum.length !== n || daily.temperature_2m_max.length !== n) {
    throw new Error('featureService: daily arrays must all be the same length');
  }
  if (daily.precipitation_probability_max !== undefined) {
    if (!Array.isArray(daily.precipitation_probability_max) || daily.precipitation_probability_max.length !== n) {
      throw new Error('featureService: daily.precipitation_probability_max must match daily length');
    }
  }
  return n;
}

// daily: { time[], precipitation_sum[], temperature_2m_max[], precipitation_probability_max?[] }
// crop: 'maize' | 'beans' | 'groundnuts' | 'soybean' (case-insensitive)
// observed: computeObservedFeatures() output, or null when history is unknown.
// Plantable when any trigger fires: one big day (≥ minEffectiveRainMm), a wet
// 3-day spell (sum ≥ cumulative3dMm, dated at its heaviest day), or moist soil
// plus enough follow-up rain in the next 5 days (dated at the first rainy day).
function computeFeatures(daily, crop, observed = null) {
  const n = assertDaily(daily);
  const key = String(crop || '').toLowerCase().trim();
  const profile = CROP_PROFILES[key];
  if (!profile) throw new Error(`featureService: unknown crop '${crop}'`);

  const rain = daily.precipitation_sum;
  const tmax = daily.temperature_2m_max;
  const prob = daily.precipitation_probability_max;

  let rainNext5 = 0;
  for (let i = 0; i < Math.min(5, n); i++) rainNext5 += rain[i];

  let firstIdx = -1;
  for (let i = 0; i < n; i++) {
    if (rain[i] >= profile.minEffectiveRainMm) { firstIdx = i; break; }
  }

  let cumIdx = -1;
  for (let i = 0; i + 2 < n; i++) {
    if (round1(rain[i] + rain[i + 1] + rain[i + 2]) >= profile.cumulative3dMm) {
      cumIdx = i;
      if (rain[i + 1] > rain[cumIdx]) cumIdx = i + 1;
      if (rain[i + 2] > rain[cumIdx]) cumIdx = i + 2;
      break;
    }
  }

  let moistIdx = -1;
  if (observed && observed.recently_wet && round1(rainNext5) >= profile.minEffectiveRainMm) {
    for (let i = 0; i < Math.min(5, n); i++) {
      if (rain[i] > 0) { moistIdx = i; break; }
    }
  }

  const triggers = [firstIdx, cumIdx, moistIdx].filter((i) => i !== -1);
  const best = triggers.length === 0 ? -1 : Math.min(...triggers);

  let heavy = 0;
  for (let i = 0; i < n; i++) if (rain[i] >= HEAVY_RAIN_MM) heavy++;

  let heat = 0;
  for (let i = 0; i < n; i++) if (tmax[i] >= HEAT_STRESS_C) heat++;

  let dryStreak = 0;
  for (let i = 0; i < n; i++) {
    if (rain[i] === 0) dryStreak++;
    else break;
  }

  return {
    crop: key,
    min_effective_rain_mm: profile.minEffectiveRainMm,
    waterlogging_sensitive: profile.waterloggingSensitive,
    rain_next_5d_mm: round1(rainNext5),
    has_effective_rain_in_window: best !== -1,
    first_effective_rain_date: best === -1 ? NO_WINDOW : daily.time[best],
    best_confidence_for_first_effective_rain: best === -1 || !prob ? null : prob[best],
    heavy_rain_risk_days: heavy,
    heat_stress_days: heat,
    dry_streak_days: dryStreak,
    window_through: daily.time[n - 1],
  };
}

// Fertiliser window: wants rain soon, but no heavy downpour (runoff) and no
// bone-dry soil (root burn). Crop-independent.
function computeFertiliserFeatures(daily) {
  const n = assertDaily(daily);
  const rain = daily.precipitation_sum;
  const prob = daily.precipitation_probability_max;

  let rain3 = 0;
  for (let i = 0; i < Math.min(3, n); i++) rain3 += rain[i];

  let heavy3 = false;
  for (let i = 0; i < Math.min(3, n); i++) {
    if (rain[i] >= HEAVY_RAIN_MM) { heavy3 = true; break; }
  }

  let dryStreak = 0;
  for (let i = 0; i < n; i++) {
    if (rain[i] === 0) dryStreak++;
    else break;
  }

  let usefulIdx = -1;
  for (let i = 0; i < n; i++) {
    if (rain[i] >= 1 && rain[i] < HEAVY_RAIN_MM) { usefulIdx = i; break; }
  }

  return {
    rain_next_3d_mm: round1(rain3),
    heavy_rain_in_3d: heavy3,
    dry_streak_days: dryStreak,
    bone_dry: dryStreak >= 5 && rain3 < 2,
    first_useful_rain_date: usefulIdx === -1 ? NO_WINDOW : daily.time[usefulIdx],
    best_confidence_for_first_useful_rain: usefulIdx === -1 || !prob ? null : prob[usefulIdx],
    window_through: daily.time[n - 1],
  };
}

// Tillage window: wants dry workable days; heavy rain means mud.
function computeTillageFeatures(daily) {
  const n = assertDaily(daily);
  const rain = daily.precipitation_sum;

  let rain5 = 0;
  for (let i = 0; i < Math.min(5, n); i++) rain5 += rain[i];

  let heavy = 0;
  let dryDays = 0;
  for (let i = 0; i < n; i++) {
    if (rain[i] >= HEAVY_RAIN_MM) heavy++;
    if (rain[i] === 0) dryDays++;
  }

  return {
    rain_next_5d_mm: round1(rain5),
    heavy_rain_risk_days: heavy,
    dry_days_in_window: dryDays,
    window_through: daily.time[n - 1],
  };
}

// Livestock window: heat kills poultry and cuts milk, heavy rain floods
// housing (foot rot, coccidiosis), long dry spells stress water points.
function computeLivestockFeatures(daily) {
  const n = assertDaily(daily);
  const rain = daily.precipitation_sum;
  const tmax = daily.temperature_2m_max;

  let rainTotal = 0;
  for (let i = 0; i < n; i++) rainTotal += rain[i];

  let heavy = 0;
  let heat = 0;
  let dryDays = 0;
  for (let i = 0; i < n; i++) {
    if (rain[i] >= HEAVY_RAIN_MM) heavy++;
    if (tmax[i] >= HEAT_STRESS_C) heat++;
    if (rain[i] === 0) dryDays++;
  }

  return {
    rain_window_total_mm: round1(rainTotal),
    heavy_rain_days: heavy,
    heat_stress_days: heat,
    dry_days_in_window: dryDays,
    window_through: daily.time[n - 1],
  };
}

// Observed-rain proxy for topsoil moisture. past: { time[], precipitation_sum[] }
// with the most recent complete day last (historyService drops partial today).
// Uses the last 5 days; "recently wet" means a good soaking fell and it rained
// within the last 3 days. Observed rain is certain and already in the ground,
// so its bar sits below the forecast single-day bar. Starting values.
const RECENT_WET_DAYS = 3;
const OBSERVED_WINDOW = 5;
const OBSERVED_WET_MM = 10;

function computeObservedFeatures(past, crop) {
  if (!past || typeof past !== 'object') throw new Error('featureService: past payload must be an object');
  for (const k of ['time', 'precipitation_sum']) {
    if (!Array.isArray(past[k])) throw new Error(`featureService: past.${k} must be an array`);
  }
  const n = past.time.length;
  if (n === 0) throw new Error('featureService: past arrays must not be empty');
  if (past.precipitation_sum.length !== n) {
    throw new Error('featureService: past arrays must all be the same length');
  }
  const key = String(crop || '').toLowerCase().trim();
  const profile = CROP_PROFILES[key];
  if (!profile) throw new Error(`featureService: unknown crop '${crop}'`);

  const rain = past.precipitation_sum.slice(-OBSERVED_WINDOW);
  let total = 0;
  let days = 0;
  for (const mm of rain) {
    total += mm;
    if (mm > 0) days++;
  }
  let since = null;
  for (let i = rain.length - 1; i >= 0; i--) {
    if (rain[i] > 0) { since = rain.length - 1 - i; break; }
  }

  return {
    observed_rain_last_5d_mm: round1(total),
    observed_rain_days: days,
    days_since_rain: since,
    recently_wet: round1(total) >= OBSERVED_WET_MM && since !== null && since <= RECENT_WET_DAYS,
    observed_days: rain.length,
  };
}

module.exports = { computeFeatures, computeFertiliserFeatures, computeTillageFeatures, computeLivestockFeatures, computeObservedFeatures, CROP_PROFILES, NO_WINDOW };
