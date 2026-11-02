require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const logger = require('./utils/logger');
const { getDailyForecast } = require('./services/forecastService');
const { getSoils, getDistricts } = require('./services/agriRigoService');
const { computeFeatures, computeFertiliserFeatures, computeTillageFeatures } = require('./services/featureService');
const { getPlantingDecision, translateDecision, analyzeCropImage } = require('./services/aiService');
const { pickPhotoId, fetchPhotoBase64 } = require('./services/cropHealthService');
const { getState, updateState, resetState } = require('./services/conversationService');
const { buildPlan, translatePlan } = require('./services/farmingPlanService');
const {
  resolveDistrict, extractCrop, parseAction, parseLanguage, formatReply, normalize,
  WELCOME, CROP_HEALTH_INTRO, ACTION_KEYBOARD, CROP_KEYBOARD, DISTRICT_OFFER_KEYBOARD, LANGUAGE_KEYBOARD,
  SUPPORTED_ACTIONS, LANGUAGES,
} = require('./services/telegramService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(require('path').join(__dirname, '..', 'public')));
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'agrisense' });
});

app.post('/api/plan', async (req, res) => {
  try {
    res.json({ ok: true, ...(await buildPlan(req.body || {})) });
  } catch (err) {
    logger.warn('web', 'plan failed', { error: err.message });
    res.status(err.status || 502).json({ ok: false, error: err.message });
  }
});

app.post('/api/plan/translate', async (req, res) => {
  try {
    const { planEn, meta, language } = req.body || {};
    if (!planEn || !meta) throw Object.assign(new Error('planEn and meta are required.'), { status: 400 });
    res.json({ ok: true, plan: await translatePlan(planEn, meta, language) });
  } catch (err) {
    logger.warn('web', 'plan translation failed', { error: err.message });
    res.status(err.status || 502).json({ ok: false, error: err.message });
  }
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
    return {
      text: `Weather data is unavailable right now, so I cannot advise safely for ${district.name} ${crop}. Please try again shortly.`,
      decision: null,
      stale: false,
    };
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
  const shown = await translateDecision(decision, { district: district.name, crop, action }, state.language);
  return {
    text: formatReply(shown, { district, crop, action, stale: forecast.stale }),
    decision,
    stale: forecast.stale,
  };
}

function ackPrefix(chatId) {
  const s = getState(chatId);
  if (s.langAck) {
    updateState(chatId, { langAck: false });
    return `Noted — I'll answer in ${LANGUAGES[s.language] || s.language}.\n\n`;
  }
  return '';
}

async function runIfReady(chatId, foundAny, lastText) {
  let s = getState(chatId);
  if (!s.action) {
    updateState(chatId, { action: 'plant' });
    s = getState(chatId);
  }
  if (!s.crop) {
    return { text: `${ackPrefix(chatId)}Which crop?`, options: { reply_markup: CROP_KEYBOARD } };
  }
  if (!s.district) {
    if (!foundAny) {
      updateState(chatId, { awaitingDistrictConfirm: true });
      return {
        text: `${ackPrefix(chatId)}I couldn't find "${lastText}". Use Lusaka instead, or type another district?`,
        options: { reply_markup: DISTRICT_OFFER_KEYBOARD },
      };
    }
    return { text: `${ackPrefix(chatId)}Which district? Type the name, e.g. Chipata.`, options: {} };
  }
  if (!foundAny) {
    return { text: 'Anything else? Send a new district and crop, or tap a language.', options: { reply_markup: LANGUAGE_KEYBOARD } };
  }
  const { text, decision, stale } = await buildAdvisory(s);
  if (decision) updateState(chatId, { last: { decision, stale, district: s.district, crop: s.crop, action: s.action } });
  return { text, options: { parse_mode: 'Markdown', reply_markup: LANGUAGE_KEYBOARD } };
}

async function handleText(chatId, text) {
  if (getState(chatId).awaitingDistrictConfirm) {
    updateState(chatId, { awaitingDistrictConfirm: false });
    if (/^(use lusaka|yes|ok|lusaka)$/.test(normalize(text))) {
      updateState(chatId, { district: resolveDistrict('') });
      return runIfReady(chatId, true, text);
    }
  }
  const lang = parseLanguage(text);
  if (lang) updateState(chatId, { language: lang });
  const action = parseAction(text);
  if (action && !SUPPORTED_ACTIONS.includes(action)) {
    return { text: 'For now I advise on planting and crop health. Tap Plant or 📷 Crop health.', options: { reply_markup: ACTION_KEYBOARD } };
  }
  if (action === 'crop-health') {
    updateState(chatId, { action });
    return { text: CROP_HEALTH_INTRO, options: { parse_mode: 'Markdown' } };
  }
  if (action) updateState(chatId, { action });
  const cropM = extractCrop(text);
  if (cropM.matched) updateState(chatId, { crop: cropM.crop });
  const distM = resolveDistrict(text);
  if (distM.matched) updateState(chatId, { district: distM });

  const s = getState(chatId);
  const otherFound = Boolean(action || cropM.matched || distM.matched);
  // Language-only follow-up: re-render the stored reply, no refetch.
  if (lang && !otherFound && s.last) {
    const shown = await translateDecision(
      s.last.decision,
      { district: (s.last.district && s.last.district.name) || 'your area', crop: s.last.crop || 'crop', action: s.last.action },
      lang
    );
    return {
      text: formatReply(shown, { district: s.last.district, crop: s.last.crop, action: s.last.action, stale: s.last.stale }),
      options: { parse_mode: 'Markdown', reply_markup: LANGUAGE_KEYBOARD },
    };
  }
  if (s.action === 'crop-health') {
    return { text: 'Please send a photo of the affected plant. Close-ups of leaves work best.', options: {} };
  }
  if (lang && !otherFound) updateState(chatId, { langAck: true });
  return runIfReady(chatId, Boolean(otherFound || lang), text);
}

async function handlePhoto(chatId, msg, bot) {
  const s = getState(chatId);
  const fileId = pickPhotoId(msg);
  if (!fileId) return { text: 'I could not read that photo. Please try again.', options: {} };
  try {
    const { base64, mimeType } = await fetchPhotoBase64(bot, fileId);
    const decision = await analyzeCropImage(base64, mimeType, { crop: s.crop });
    const shown = await translateDecision(
      decision,
      { district: (s.district && s.district.name) || 'your area', crop: s.crop || 'crop', action: 'crop-health' },
      s.language
    );
    updateState(chatId, {
      action: null,
      last: { decision, stale: false, district: s.district || null, crop: s.crop || null, action: 'crop-health' },
    });
    return {
      text: formatReply(shown, { district: s.district || null, crop: s.crop || null, action: 'crop-health', stale: false }),
      options: { parse_mode: 'Markdown', reply_markup: LANGUAGE_KEYBOARD },
    };
  } catch (err) {
    logger.warn('crophealth', 'photo analysis failed', { error: err.message });
    return { text: 'Sorry, I could not analyse that photo. Please send a clearer close-up of the affected leaves.', options: {} };
  }
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
    if (msg.text && msg.text.startsWith('/start')) return;
    logger.info('telegram', 'message received', { chat: msg.chat.id, hasPhoto: Boolean(msg.photo && msg.photo.length) });
    try {
      if (msg.photo && msg.photo.length) {
        await bot.sendMessage(msg.chat.id, '🔍 Looking at your photo...');
        const reply = await handlePhoto(msg.chat.id, msg, bot);
        await bot.sendMessage(msg.chat.id, reply.text, reply.options);
      } else if (msg.text) {
        const reply = await handleText(msg.chat.id, msg.text);
        await bot.sendMessage(msg.chat.id, reply.text, reply.options);
      } else {
        await bot.sendMessage(msg.chat.id, 'Please send text or a photo.');
      }
    } catch (err) {
      logger.error('telegram', 'reply failed', { error: err.message });
      await bot.sendMessage(msg.chat.id, 'Sorry, something went wrong. Please try again.');
    }
  });
}

app.listen(PORT, () => {
  logger.info('http', `agrisense listening on ${PORT}`);
});

module.exports = { app, handleText, handlePhoto, buildAdvisory };
