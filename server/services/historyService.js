// Recent observed rainfall via the Open-Meteo forecast API with past_days.
// AgriRigo (itself an Open-Meteo relay) exposes no history endpoint, so the
// live path asks the underlying provider directly for the last 7 days only.
// The archive API is NOT used here: it lags ~5 days and cannot see last week.
// Free, no API key (non-commercial). Labelled open-meteo:past-7d in sources.
const axios = require('axios');
const { TTLCache, buildKey } = require('../utils/cache');
const logger = require('../utils/logger');

const TIMEOUT_MS = 5000; // tight: leaves budget for the one Meta API call
const TTL_MS = 6 * 3600 * 1000; // observed past barely changes intraday

const cache = new TTLCache();

async function getRecentRain(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('historyService: lat and lon must be valid numbers');
  }
  const key = buildKey('recent-rain', { lat, lon });
  const fresh = cache.get(key);
  if (fresh !== undefined) {
    logger.info('history', 'cache hit', { key });
    return { daily: fresh, stale: false, cached: true, sources_used: ['open-meteo:past-7d'] };
  }
  try {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: lat,
        longitude: lon,
        daily: 'precipitation_sum',
        past_days: 7,
        forecast_days: 1,
        timezone: 'Africa/Lusaka',
      },
      timeout: TIMEOUT_MS,
    });
    const d = res.data && res.data.daily;
    if (!d || !Array.isArray(d.time) || !Array.isArray(d.precipitation_sum)
      || d.time.length !== d.precipitation_sum.length || d.time.length === 0) {
      throw new Error('historyService: unexpected daily shape');
    }
    // Last entry is today (still accumulating) — drop it, keep complete days.
    const daily = { time: d.time.slice(0, -1), precipitation_sum: d.precipitation_sum.slice(0, -1) };
    cache.set(key, daily, TTL_MS);
    logger.info('history', 'fetched', { key });
    return { daily, stale: false, cached: false, sources_used: ['open-meteo:past-7d'] };
  } catch (err) {
    logger.warn('history', 'upstream failure, trying stale cache', { key, error: err.message });
    const fallback = cache.getStale(key);
    if (fallback !== undefined) {
      return { daily: fallback.value, stale: true, cached: true, sources_used: ['open-meteo:past-7d'] };
    }
    throw new Error(`historyService: recent rain unavailable and no cached copy (${err.message})`);
  }
}

module.exports = { getRecentRain };
