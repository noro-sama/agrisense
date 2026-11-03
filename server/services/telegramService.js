// Telegram helpers: keyword district/crop extraction (no LLM) + reply format.
// District resolution: exact -> alias -> substring over data/districts.json.
// Only entries with valid coords (lat<0, lon>0) can match; otherwise the
// caller MUST tell the user a default location was used.
const DISTRICTS = require('../../data/districts.json');

const CROPS = [
  { crop: 'maize', keywords: ['maize', 'corn'] },
  { crop: 'beans', keywords: ['beans', 'bean'] },
  { crop: 'groundnuts', keywords: ['groundnuts', 'groundnut', 'peanuts', 'peanut'] },
  { crop: 'soybean', keywords: ['soybeans', 'soybean', 'soya'] },
];

const WELCOME = [
  'Welcome to Agrisense!',
  'Tap Plant for planting advice, 📷 Crop health to check a sick plant, or Farming plan for a full-season guide.',
  'You make the final call — I just advise.',
].join('\n');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b(town|township|district|city|boma)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasCoords(entry) {
  return (
    entry &&
    typeof entry.lat === 'number' &&
    typeof entry.lon === 'number' &&
    entry.lat < 0 &&
    entry.lon > 0
  );
}

function resolveDistrict(text) {
  const norm = normalize(text);
  const entries = DISTRICTS.districts;

  if (entries[norm] && hasCoords(entries[norm])) {
    return { name: norm, ...entries[norm], matched: true };
  }
  const alias = DISTRICTS.aliases[norm];
  if (alias && entries[alias] && hasCoords(entries[alias])) {
    return { name: alias, ...entries[alias], matched: true };
  }
  for (const name of Object.keys(entries)) {
    if (norm.includes(name) && hasCoords(entries[name])) {
      return { name, ...entries[name], matched: true };
    }
  }
  return { name: 'lusaka', ...DISTRICTS.default, matched: false };
}

function extractCrop(text) {
  const norm = normalize(text);
  for (const { crop, keywords } of CROPS) {
    if (keywords.some((k) => norm.includes(k))) return { crop, matched: true };
  }
  return { crop: 'maize', matched: false };
}

const ACTIONS = [
  { action: 'farming-plan', keywords: ['farming plan', 'season plan'] },
  { action: 'plant', keywords: ['plant', 'planting', 'sow'] },
  { action: 'fertiliser', keywords: ['fertilis', 'fertiliz', 'top dress', 'urea', 'dap', 'manure'] },
  { action: 'till', keywords: ['till', 'tillage', 'plough', 'plow', 'ridge'] },
  { action: 'crop-health', keywords: ['crop health', 'crop doctor', 'photo', 'picture', 'disease', 'sick'] },
];

const ACTION_KEYBOARD = {
  keyboard: [[{ text: 'Plant' }, { text: '📷 Crop health' }], [{ text: 'Farming plan' }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};
const CROP_KEYBOARD = {
  keyboard: [[{ text: 'Maize' }, { text: 'Beans' }], [{ text: 'Groundnuts' }, { text: 'Soybean' }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};
const DISTRICT_OFFER_KEYBOARD = {
  keyboard: [[{ text: 'Use Lusaka' }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};
const ACTION_NOUNS = { plant: 'planting', fertiliser: 'fertiliser', till: 'tillage', 'crop-health': 'crop health' };
const SUPPORTED_ACTIONS = ['plant', 'crop-health', 'farming-plan'];

const CROP_HEALTH_INTRO = [
  '📷 *Crop health check*',
  'Send a clear photo of the affected plant. Close-ups of leaves work best.',
  'I will look for signs of disease or pests and advise what to do.',
].join('\n');

const FARMING_PLAN_INTRO = [
  '📋 *Season farming plan*',
  'A full-season guide for your field — land prep to harvest, tuned to your district, soils, and last season\'s drought. Built for printing, in English, Bemba, Nyanja, or Tonga.',
  '[Build my plan](https://agrisense-f5ky.onrender.com/plan.html)',
].join('\n');

const LANGUAGES = { bemba: 'Bemba', nyanja: 'Nyanja', tonga: 'Tonga', english: 'English' };
const LANGUAGE_KEYBOARD = {
  keyboard: [[{ text: 'Bemba' }, { text: 'Nyanja' }], [{ text: 'Tonga' }, { text: 'English' }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

function parseLanguage(text) {
  const norm = normalize(text);
  for (const lang of Object.keys(LANGUAGES)) {
    if (new RegExp(`\\b${lang}\\b`).test(norm)) return lang;
  }
  return null;
}

// Word-boundary match so "still waiting" does not parse as tillage.
function parseAction(text) {
  const norm = normalize(text);
  for (const { action, keywords } of ACTIONS) {
    if (keywords.some((k) => new RegExp(`\\b${k}`).test(norm))) return action;
  }
  return null;
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Markdown with line breaks, capped at 600 chars. Dynamic text is escaped so
// user/model content can never break Telegram parsing.
function escapeMd(s) {
  return String(s).replace(/([_*`[])/g, '\\$1');
}

function formatReply(decision, { district, crop, action, stale }) {
  const lines = [];
  const noun = ACTION_NOUNS[action] || action;
  if (district && crop) {
    lines.push(`📍 *${escapeMd(cap(district.name))}, ${escapeMd(district.province)} - ${escapeMd(crop)} (${noun})*`);
  } else if (district) {
    lines.push(`📍 *${escapeMd(cap(district.name))}, ${escapeMd(district.province)} (${noun})*`);
  } else if (crop) {
    lines.push(`📷 *${escapeMd(crop)} (${noun})*`);
  } else {
    lines.push('📷 *Crop health check*');
  }
  if (district && !district.matched) lines.push('_Default location used (Lusaka). Reply with your district._');
  lines.push(`${/^(WAIT|SUSPECT)$/.test(decision.recommendation) ? '⏳' : '✅'} *${decision.recommendation}* (${decision.confidence} confidence)`);
  lines.push(`🌧️ ${escapeMd(decision.reason_plain)}`);
  lines.push(`📅 *Timing:* ${escapeMd(decision.timing)}`);
  if (decision.recheck_hint) lines.push(`🔁 *Re-check:* ${escapeMd(decision.recheck_hint)}`);
  if (decision.risk_flags && decision.risk_flags.length) {
    lines.push('⚠️ *Risks:*');
    for (const r of decision.risk_flags) lines.push(`• ${escapeMd(r)}`);
  }
  if (decision.context_notes && decision.context_notes.length) {
    lines.push('📝 *Notes:*');
    for (const n of decision.context_notes) lines.push(`• ${escapeMd(n)}`);
  }
  if (stale) lines.push('_Forecast from stale cache._');
  let text = lines.join('\n');
  if (text.length > 600) {
    text = `${lines.join('\n').replace(/[*_]/g, '').slice(0, 597)}...`;
  }
  return text;
}

module.exports = {
  resolveDistrict, extractCrop, parseAction, parseLanguage, formatReply, normalize, WELCOME, CROP_HEALTH_INTRO, FARMING_PLAN_INTRO,
  ACTION_KEYBOARD, CROP_KEYBOARD, DISTRICT_OFFER_KEYBOARD, LANGUAGE_KEYBOARD,
  SUPPORTED_ACTIONS, LANGUAGES,
};
