// AgriRigo API client: fetch + cache for the 4 allowed endpoints only.
// TTLs follow cache_ttl_hours in data/agririggo_endpoints.json exactly.
// On upstream failure, serves stale cache with stale:true (graceful
// degradation) instead of throwing, when a stale entry exists.
const axios = require('axios');
const { TTLCache, buildKey } = require('../utils/cache');
const logger = require('../utils/logger');

const BASE_URL = process.env.AGRIRIGO_BASE_URL || 'https://rigo.agririgo.com/api/v1';
const TIMEOUT_MS = 5000; // tight: leaves budget for the one Meta API call

const TTL_MS = {
  'weather-live': 0.25 * 3600 * 1000, // 15 min
  soils: 2160 * 3600 * 1000, // 90 days
  districts: 2160 * 3600 * 1000, // 90 days; fetched ONCE at startup
  'drought-2024': 720 * 3600 * 1000, // 30 days; historical context only
};

const cache = new TTLCache();

function assertLatLon(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('agriRigoService: lat and lon must be valid numbers');
  }
}

function assertProvince(province) {
  if (typeof province !== 'string' || province.trim() === '') {
    throw new Error('agriRigoService: province must be a non-empty string');
  }
}

async function fetchCached(key, ttlMs, url, params, sourceTag) {
  const fresh = cache.get(key);
  if (fresh !== undefined) {
    logger.info('agririgo', 'cache hit', { key });
    return { data: fresh, stale: false, cached: true, sources_used: [sourceTag] };
  }
  try {
    const res = await axios.get(url, { params, timeout: TIMEOUT_MS });
    cache.set(key, res.data, ttlMs);
    logger.info('agririgo', 'fetched', { key });
    return { data: res.data, stale: false, cached: false, sources_used: [sourceTag] };
  } catch (err) {
    logger.warn('agririgo', 'upstream failure, trying stale cache', { key, error: err.message });
    const fallback = cache.getStale(key);
    if (fallback !== undefined) {
      return { data: fallback.value, stale: true, cached: true, sources_used: [sourceTag] };
    }
    throw new Error(`agriRigoService: ${sourceTag} unavailable and no cached copy (${err.message})`);
  }
}

async function getWeatherLive(lat, lon) {
  assertLatLon(lat, lon);
  return fetchCached(
    buildKey('weather-live', { lat, lon }),
    TTL_MS['weather-live'],
    `${BASE_URL}/weather/live`,
    { lat, lon },
    'agririgo:weather-live'
  );
}

async function getSoils(province) {
  assertProvince(province);
  return fetchCached(
    buildKey('soils', { province }),
    TTL_MS.soils,
    `${BASE_URL}/soils`,
    { province },
    'agririgo:soils'
  );
}

async function getDistricts(province) {
  assertProvince(province);
  return fetchCached(
    buildKey('districts', { province }),
    TTL_MS.districts,
    `${BASE_URL}/districts`,
    { province },
    'agririgo:districts'
  );
}

async function getDrought2024(province) {
  assertProvince(province);
  return fetchCached(
    buildKey('drought-2024', { province }),
    TTL_MS['drought-2024'],
    `${BASE_URL}/drought/2024`,
    { province },
    'agririgo:drought-2024-historical'
  );
}

module.exports = { getWeatherLive, getSoils, getDistricts, getDrought2024, TTL_MS };
