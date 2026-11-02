require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const logger = require('./utils/logger');
const { getDailyForecast } = require('./services/forecastService');
const { getSoils, getDistricts } = require('./services/agriRigoService');
const { computeFeatures, computeFertiliserFeatures, computeTillageFeatures } = require('./services/featureService');
const { getPlantingDecision } = require('./services/aiService');
const { getState, updateState, resetState } = require('./services/conversationService');
const {
  resolveDistrict, extractCrop, parseAction, formatReply, normalize,
  WELCOME, ACTION_KEYBOARD, CROP_KEYBOARD, DISTRICT_OFFER_KEYBOARD,
} = require('./services/telegramService');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'agrisense' });
});

// Validate district map ONCE at startup via API. Log-only, never blocks boot.
(async () => {
  try {
    const res = await getDistricts('Lusaka');
    logger.info('startup', 'district map validation call ok', { sources: res.sources_used });
  } catch (err) {
    logger.warn('startup', 'district validation skipped', { error: err.message });
  }
})();

function summarizeSoils(body) {
  let d = (body && body.data) || body || {};
  if (Array.isArray(d)) d = d[0] || {};
  const parts = [];
  const soils = d.dominantSoils || d.dominant_soils || d.dominant_group || d.wrb;
  if (Array.isArray(soils)) parts.push(soils.join(', '));
  else if (soils) parts.push(String(soils));
  const ph = d.phRange || d.ph_range || d.ph;
  if (Array.isArray(ph)) parts.push(`pH ${ph.join('-')}`);
  else if (ph) parts.push(`pH ${ph}`);
  if (d.texture) parts.push(String(d.texture));
  if (Array.isArray(d.constraints) && d.constraints.length) parts.push(d.constraints.slice(0, 2).join('; '));
  else if (d.constraints) parts.push(String(d.constraints));
  if (parts.length === 0) {
    try {
      return JSON.stringify(d).slice(0, 200);
    } catch {
      return '';
    }
  }
  return parts.join('; ');
}

function computeFeaturesFor(action, daily, crop) {
  if (action === 'fertiliser') return computeFertiliserFeatures(daily);
  if (action === 'till') return computeTillageFeatures(daily);
  return computeFeatures(daily, crop);
}

async function buildAdvisory(state) {
  const { district, crop, action } = state;
  const sources = [];

  let forecast;
  try {
    forecast = await getDailyForecast(district.lat, district.lon);
  } catch (err) {
    logger.warn('telegram', 'weather unavailable, honest partial reply', { error: err.message });
    return `Weather data is unavailable right now, so I cannot advise safely for ${district.name} ${crop}. Please try again shortly.`;
  }
  sources.push(...forecast.sources_used);
  const features = computeFeaturesFor(action, forecast.daily, crop);

  let soilData = '';
  try {
    const soils = await getSoils(district.province);
    sources.push(...soils.sources_used);
    soilData = summarizeSoils(soils.data);
    if (soils.stale) soilData += ' (stale cache)';
  } catch (err) {
    logger.warn('telegram', 'soils unavailable, continuing without', { error: err.message });
    soilData = 'soil data unavailable';
  }

  const droughtNote = district.drought_severity_2023_24
    ? `Last season drought: ${district.drought_severity_2023_24} (historical, 2023/24)`
    : '';

  const decision = await getPlantingDecision({ action, features, cropKnowledge: '', soilData, droughtNote, sources_used: sources });
  return formatReply(decision, { district, crop, action, stale: forecast.stale });
}

async function runIfReady(chatId, foundAny, lastText) {
  const s = getState(chatId);
  if (!s.action) return { text: 'What do you want to do?', options: { reply_markup: ACTION_KEYBOARD } };
  if (!s.crop) return { text: 'Which crop?', options: { reply_markup: CROP_KEYBOARD } };
  if (!s.district) {
    if (!foundAny && s.action && s.crop) {
      updateState(chatId, { awaitingDistrictConfirm: true });
      return {
        text: `I couldn't find "${lastText}". Use Lusaka instead, or type another district?`,
        options: { reply_markup: DISTRICT_OFFER_KEYBOARD },
      };
    }
    return { text: 'Which district? Type the name, e.g. Chipata.', options: {} };
  }
  if (!foundAny) {
    return { text: 'Anything else? Tap an action or send a new district and crop.', options: { reply_markup: ACTION_KEYBOARD } };
  }
  return { text: await buildAdvisory(s), options: { parse_mode: 'Markdown' } };
}

async function handleText(chatId, text) {
  if (getState(chatId).awaitingDistrictConfirm) {
    updateState(chatId, { awaitingDistrictConfirm: false });
    if (/^(use lusaka|yes|ok|lusaka)$/.test(normalize(text))) {
      updateState(chatId, { district: resolveDistrict('') });
      return runIfReady(chatId, true, text);
    }
  }
  const action = parseAction(text);
  if (action) updateState(chatId, { action });
  const cropM = extractCrop(text);
  if (cropM.matched) updateState(chatId, { crop: cropM.crop });
  const distM = resolveDistrict(text);
  if (distM.matched) updateState(chatId, { district: distM });
  return runIfReady(chatId, Boolean(action || cropM.matched || distM.matched), text);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  logger.warn('telegram', 'no TELEGRAM_BOT_TOKEN set, polling disabled');
} else {
  const bot = new TelegramBot(token, { polling: true });
  bot.on('polling_error', (err) => logger.warn('telegram', 'polling_error', { error: err.message }));
  bot.onText(/\/start/, (msg) => {
    resetState(msg.chat.id);
    bot.sendMessage(msg.chat.id, WELCOME, { reply_markup: ACTION_KEYBOARD });
  });
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/start')) return;
    logger.info('telegram', 'message received', { chat: msg.chat.id });
    try {
      const reply = await handleText(msg.chat.id, msg.text);
      await bot.sendMessage(msg.chat.id, reply.text, reply.options);
    } catch (err) {
      logger.error('telegram', 'reply failed', { error: err.message });
      await bot.sendMessage(msg.chat.id, 'Sorry, I could not build advice right now. Please try again with your district and crop.');
    }
  });
}

app.listen(PORT, () => {
  logger.info('http', `agrisense listening on ${PORT}`);
});

module.exports = { app, handleText, buildAdvisory };
