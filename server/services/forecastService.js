// Thin weather wrapper: returns daily arrays shaped for featureService.
// Knows the /weather/live envelope ({ data: { daily } }); nothing else.
const { getWeatherLive } = require('./agriRigoService');

async function getDailyForecast(lat, lon) {
  const res = await getWeatherLive(lat, lon);
  const daily = res.data && res.data.data && res.data.data.daily;
  if (!daily || !Array.isArray(daily.time)) {
    throw new Error('forecastService: /weather/live response missing daily arrays');
  }
  return { daily, stale: res.stale, cached: res.cached, sources_used: res.sources_used };
}

module.exports = { getDailyForecast };
