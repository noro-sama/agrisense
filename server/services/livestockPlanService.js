// Multi-agent livestock-plan pipeline (livestock-farming-plan-agents.md):
// Livestock Specialist → Risk Assessor → Content Editor (+ Muse Image visual).
// Mirrors farmingPlanService.js: same assembly line, livestock prompts and
// schemas. The text plan is complete on its own; the image is an optional aid
// and its failure never blocks the plan.
const { getDailyForecast } = require('./forecastService');
const { resolveDistrict } = require('./telegramService');
const { runStructured } = require('./aiService');
const { generateImage } = require('./imageService');
const { computeLivestockFeatures } = require('./featureService');
const logger = require('../utils/logger');

const STAGES = ['housing', 'feeding', 'health', 'breeding', 'market'];
const SPECIES = ['cattle', 'goats', 'chickens'];

const AGENT_A_SCHEMA = {
  type: 'object',
  properties: {
    breed: { type: 'string' },
    breed_reason: { type: 'string' },
    stages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: STAGES },
          timing: { type: 'string' },
          actions: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'timing', 'actions'],
      },
    },
  },
  required: ['breed', 'breed_reason', 'stages'],
};

const AGENT_B_SCHEMA = {
  type: 'object',
  properties: {
    stages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: STAGES },
          timing: { type: 'string' },
          actions: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'timing', 'actions', 'warnings'],
      },
    },
    critical_risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { risk: { type: 'string' }, mitigation: { type: 'string' } },
        required: ['risk', 'mitigation'],
      },
    },
  },
  required: ['stages', 'critical_risks'],
};

// Six fixed sections plus one grounded illustration brief for Muse Image.
const AGENT_C_SCHEMA = {
  type: 'object',
  properties: {
    housing: { type: 'array', items: { type: 'string' } },
    feeding: { type: 'array', items: { type: 'string' } },
    health: { type: 'array', items: { type: 'string' } },
    breeding: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    market: { type: 'array', items: { type: 'string' } },
    image_prompt: { type: 'string' },
    image_caption: { type: 'string' },
  },
  required: ['housing', 'feeding', 'health', 'breeding', 'risks', 'market', 'image_prompt', 'image_caption'],
};

const SECTION_KEYS = ['housing', 'feeding', 'health', 'breeding', 'risks', 'market'];

const AGENT_A_SYSTEM = `You are Agent A, Agrisense livestock specialist. Given species, breed, herd size, housing, feed, water, purpose, location, and season, produce a management timeline.
RULES: cover all five stages; scale advice to herd size (a few village chickens need different housing than 200 broilers); ground feed and water advice in the season and water source; never prescribe drug dosages, direct dosing questions to a vet or extension officer; never invent weather, district, or outbreak figures outside the context; reply under the given JSON schema.
STYLE: short actionable steps, plain words.`;

const AGENT_B_SYSTEM = `You are Agent B, Agrisense livestock risk assessor. Given context and Agent A's timeline, attach warnings per stage plus critical risks.
RULES: entering dry season on rain-fed-only feed must be flagged with stored-fodder banking; births landing in peak dry months must be flagged for water and feed stress on mothers; every vaccination window needs a timing plus a see-your-vet note, never a dosage; inject heat, flood, and water-point warnings from the forecast features; every warning needs a mitigation; reply under the given JSON schema.`;

const AGENT_C_SYSTEM = `You are Agent C, Agrisense editor. Convert the risk-adjusted livestock plan into the six fixed sections plus one illustration brief.
RULES: every bullet short and actionable; fold stage warnings into their section and the critical risks into the risks section; professional yet plain tone for smallholder farmers; image_prompt must describe ONE simple instructional diagram (housing, kraal, or feed/water setup) using only species, materials, and season already in the plan, naming no disease, drug, or dosage; image_caption is one plain sentence tying the diagram to the housing or feeding section; reply under the given JSON schema.`;

function planError(message, status = 500) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Zambia: rainy roughly Nov–Apr, dry May–Oct. Livestock pressure flips with it.
function livestockSeason(now = new Date()) {
  const m = now.getMonth() + 1;
  if (m >= 11 || m <= 4) return 'rainy';
  return 'dry';
}

function assertPlanC(p) {
  for (const k of SECTION_KEYS) {
    if (!p || !Array.isArray(p[k]) || p[k].length === 0) {
      throw planError(`Livestock editor returned an unusable section: ${k}`);
    }
  }
  if (typeof (p && p.image_prompt) !== 'string' || !p.image_prompt.trim()) {
    throw planError('Livestock editor returned no image prompt.');
  }
  if (typeof p.image_caption !== 'string' || !p.image_caption.trim()) {
    throw planError('Livestock editor returned no image caption.');
  }
  return p;
}

// Validate the model's illustration brief before spending $0.01 on it: it may
// only depict housing or feed/water setups, never diagnosis or dosing.
const BLOCKED_VISUAL = /(diseas|diagnos|symptom|lesion|dosage|dose\b|mg\/kg|ml\/kg|tablet|syrup|inject)/i;

function buildVisualPrompt(imagePrompt, meta) {
  const raw = String(imagePrompt || '').trim();
  if (!raw) return { ok: false, reason: 'empty image prompt from editor' };
  if (BLOCKED_VISUAL.test(raw)) return { ok: false, reason: 'image prompt mentions diagnosis or medication, skipped' };
  const head = `Simple instructional diagram for Zambian smallholder farmers, ${meta.species} (${meta.breed}), ${meta.season} season: `;
  return { ok: true, prompt: head + raw };
}

async function buildLivestockPlan({ species, breed, herdSize, housing, feed, water, purpose, district, language, includeImage = true }) {
  const speciesName = String(species || '').trim().toLowerCase();
  if (!SPECIES.includes(speciesName)) {
    throw planError(`Species must be one of: ${SPECIES.join(', ')}.`, 400);
  }
  const dist = resolveDistrict(String(district || ''));
  if (!dist.matched) throw planError(`Unknown district "${district}". Try a nearby major town.`, 400);
  const head = Number(herdSize);
  const herd = Number.isFinite(head) && head > 0 ? Math.floor(head) : 1;

  const forecast = await getDailyForecast(dist.lat, dist.lon).catch((err) => {
    throw planError(`Live weather unavailable, cannot ground the plan (${err.message})`);
  });
  const window = computeLivestockFeatures(forecast.daily);

  const ctx = {
    species: speciesName,
    breed: String(breed || 'local').trim() || 'local',
    herdSize: herd,
    housing: String(housing || 'none yet').trim(),
    feed: String(feed || 'grazing').trim(),
    water: String(water || 'unknown').trim(),
    purpose: String(purpose || 'mixed').trim(),
    district: dist.name,
    province: dist.province,
    season: livestockSeason(),
    today: new Date().toISOString().slice(0, 10),
    forecastWindow: window,
    lastSeasonDrought: dist.drought_severity_2023_24
      ? `${dist.drought_severity_2023_24} (historical, 2023/24)`
      : 'unknown',
  };

  logger.info('livestock-plan', 'agent A drafting', { species: speciesName, district: dist.name });
  const planA = await runStructured(AGENT_A_SYSTEM, JSON.stringify(ctx), AGENT_A_SCHEMA);
  logger.info('livestock-plan', 'agent B assessing risk', {});
  const planB = await runStructured(AGENT_B_SYSTEM, JSON.stringify({ context: ctx, timelineA: planA }), AGENT_B_SCHEMA);
  logger.info('livestock-plan', 'agent C editing', {});
  const planC = await runStructured(AGENT_C_SYSTEM, JSON.stringify({ context: ctx, timelineB: planB }), AGENT_C_SCHEMA);
  assertPlanC(planC);

  const meta = {
    species: speciesName,
    breed: ctx.breed,
    herdSize: herd,
    district: dist.name,
    province: dist.province,
    season: ctx.season,
  };

  let image = null;
  let imageNote = 'Visual guide not requested.';
  if (includeImage) {
    const visual = buildVisualPrompt(planC.image_prompt, { species: speciesName, breed: ctx.breed, season: ctx.season });
    if (!visual.ok) {
      imageNote = visual.reason;
    } else {
      try {
        logger.info('livestock-plan', 'generating visual guide', {});
        const out = await generateImage(visual.prompt);
        image = { dataUrl: `data:image/${out.format};base64,${out.b64}`, caption: planC.image_caption };
        imageNote = '';
      } catch (err) {
        logger.warn('livestock-plan', 'visual guide failed, shipping text plan', { error: err.message });
        imageNote = 'Visual guide unavailable right now — the text plan below is complete.';
      }
    }
  }

  if (language && language !== 'english') {
    const { plan, planEn } = await translateLivestockPlan(planC, meta, language);
    return { plan, planEn, meta, image, imageNote };
  }
  return { plan: planC, planEn: planC, meta, image, imageNote };
}

const LANGUAGE_NAMES = { bemba: 'Bemba (Chibemba)', nyanja: 'Nyanja (Chinyanja)', tonga: 'Tonga (Chitonga)' };

// image_prompt stays in English verbatim: it feeds the image model, and the
// plan reuses the already-generated image without re-rendering per language.
const TRANSLATE_SCHEMA = {
  type: 'object',
  properties: {
    housing: { type: 'array', items: { type: 'string' } },
    feeding: { type: 'array', items: { type: 'string' } },
    health: { type: 'array', items: { type: 'string' } },
    breeding: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    market: { type: 'array', items: { type: 'string' } },
    image_caption: { type: 'string' },
  },
  required: ['housing', 'feeding', 'health', 'breeding', 'risks', 'market', 'image_caption'],
};

async function translateLivestockPlan(planEn, meta, language) {
  if (!language || language === 'english') return { plan: planEn, planEn };
  if (!LANGUAGE_NAMES[language]) throw planError(`Unsupported language "${language}".`, 400);
  const system = `Translate this Zambian livestock plan into ${LANGUAGE_NAMES[language]}. RULES: preserve every number, date, place, species, and breed name exactly; keep the same six keys with the same bullet counts plus the translated image caption; plain farmer-friendly ${LANGUAGE_NAMES[language]}; reply under the given JSON schema.`;
  const { image_prompt, ...rest } = planEn;
  const out = await runStructured(system, JSON.stringify({ meta, plan: rest }), TRANSLATE_SCHEMA, undefined, 4096);
  for (const k of [...SECTION_KEYS, 'image_caption']) {
    const v = out && out[k];
    if (!v || v.length === 0) throw planError(`Livestock translation returned an unusable field: ${k}`);
  }
  return { plan: { ...out, image_prompt }, planEn };
}

module.exports = { buildLivestockPlan, translateLivestockPlan, livestockSeason, buildVisualPrompt, assertPlanC, SPECIES };
