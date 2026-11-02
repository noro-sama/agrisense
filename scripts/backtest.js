// Backtest: decision-rule robustness over Oct 2024 – Mar 2025 actuals.
//
// HONEST SCOPE: the Open-Meteo archive holds observed rainfall, not the
// forecasts our bot would have seen. So this is NOT a forecast-skill score.
// Instead it answers: "if forecasts err plausibly, how do our PLANT/WAIT
// decisions degrade?" Pseudo-forecasts perturb actuals with seeded noise
// (documented below); metrics compare rule output on pseudo vs actual weeks.
// Rule-based only — the LLM is not involved.
//
// Usage: npm run backtest. Output: data/backtest_results.json
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { computeFeatures } = require('../server/services/featureService');
const DISTRICTS = require('../data/districts.json');

const LOCATIONS = [
  { district: 'lusaka', province: 'Lusaka' },
  { district: 'choma', province: 'Southern' },
  { district: 'chipata', province: 'Eastern' },
  { district: 'kasama', province: 'Northern' },
];
const START = '2024-10-01';
const END = '2025-03-31';
const WEEK = 7;

// Seeded PRNG (mulberry32) for reproducible pseudo-forecasts.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Plausible-error model (documented assumption): multiplicative amount noise
// sigma=0.35, 10% chance a rainy day is missed, 5% chance a dry day gains 2mm.
function pseudoWeek(actual, rand) {
  const precipitation_sum = actual.precipitation_sum.map((mm) => {
    if (mm > 0 && rand() < 0.1) return 0;
    if (mm === 0 && rand() < 0.05) return 2;
    if (mm === 0) return 0;
    const noisy = mm * (1 + (rand() + rand() + rand() - 1.5) * 0.7);
    return Math.round(Math.max(0, noisy) * 10) / 10;
  });
  return { time: [...actual.time], precipitation_sum, temperature_2m_max: [...actual.temperature_2m_max] };
}

async function fetchDaily(lat, lon) {
  const res = await axios.get('https://archive-api.open-meteo.com/v1/archive', {
    params: {
      latitude: lat,
      longitude: lon,
      start_date: START,
      end_date: END,
      daily: 'precipitation_sum,temperature_2m_max',
      timezone: 'Africa/Lusaka',
    },
    timeout: 30000,
  });
  return res.data.daily;
}

function weeksOf(daily) {
  const out = [];
  for (let i = 0; i + WEEK <= daily.time.length; i += WEEK) {
    out.push({
      time: daily.time.slice(i, i + WEEK),
      precipitation_sum: daily.precipitation_sum.slice(i, i + WEEK),
      temperature_2m_max: daily.temperature_2m_max.slice(i, i + WEEK),
    });
  }
  return out;
}

const sum = (a) => a.reduce((x, y) => x + y, 0);

async function main() {
  const rand = rng(20260315);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let absTotal = 0;
  let absTiming = 0;
  let timingN = 0;
  let weeks = 0;
  const perLocation = {};

  for (const loc of LOCATIONS) {
    const entry = DISTRICTS.districts[loc.district];
    const daily = await fetchDaily(entry.lat, entry.lon);
    const wks = weeksOf(daily);
    let ltp = 0;
    let lfp = 0;
    let lfn = 0;
    for (const actual of wks) {
      const pseudo = pseudoWeek(actual, rand);
      const fa = computeFeatures(actual, 'maize');
      const ff = computeFeatures(pseudo, 'maize');
      if (ff.has_effective_rain_in_window && fa.has_effective_rain_in_window) { tp++; ltp++; }
      else if (ff.has_effective_rain_in_window) { fp++; lfp++; }
      else if (fa.has_effective_rain_in_window) { fn++; lfn++; }
      else tn++;
      absTotal += Math.abs(sum(pseudo.precipitation_sum) - sum(actual.precipitation_sum));
      const ia = actual.time.indexOf(fa.first_effective_rain_date);
      const ip = pseudo.time.indexOf(ff.first_effective_rain_date);
      if (ia !== -1 && ip !== -1) {
        absTiming += Math.abs(ip - ia);
        timingN++;
      }
      weeks++;
    }
    perLocation[loc.district] = {
      weeks: wks.length,
      precision: ltp + lfp === 0 ? null : Math.round((ltp / (ltp + lfp)) * 1000) / 1000,
      falseWaitRate: ltp + lfn === 0 ? null : Math.round((lfn / (ltp + lfn)) * 1000) / 1000,
    };
  }

  const result = {
    generated_at: new Date().toISOString(),
    method: {
      scope: 'decision-rule robustness under simulated forecast error; NOT true forecast skill (archive holds actuals, not past forecasts)',
      locations: LOCATIONS,
      period: `${START} to ${END}`,
      crop: 'maize (15mm effective threshold)',
      pseudoForecast: 'seeded multiplicative amount noise sigma~0.35, 10% missed rainy days, 5% false 2mm days; temperature unperturbed',
      seed: 20260315,
      llmInvolved: false,
    },
    weeks,
    metrics: {
      effectiveRainPrecision: tp + fp === 0 ? null : Math.round((tp / (tp + fp)) * 1000) / 1000,
      falseWaitRate: tp + fn === 0 ? null : Math.round((fn / (tp + fn)) * 1000) / 1000,
      maeWeeklyTotalMm: Math.round((absTotal / weeks) * 100) / 100,
      maeTimingDays: timingN === 0 ? null : Math.round((absTiming / timingN) * 100) / 100,
      timingCoverageWeeks: timingN,
    },
    perLocation,
  };

  const outPath = path.join(__dirname, '..', 'data', 'backtest_results.json');
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`weeks=${weeks} precision=${result.metrics.effectiveRainPrecision} falseWait=${result.metrics.falseWaitRate} maeTotal=${result.metrics.maeWeeklyTotalMm}mm maeTiming=${result.metrics.maeTimingDays}d`);
  console.log(`wrote ${outPath}`);
}

main().catch((err) => {
  console.error(`backtest failed: ${err.message}`);
  process.exit(1);
});
