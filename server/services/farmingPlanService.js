// Multi-agent farming-plan pipeline (AGENTS.md): Agronomist → Risk Assessor →
// Content Editor. Transport-agnostic: returns a structured plan object; each
// surface renders it. Single model call per agent, one more for translation.
const { getDailyForecast } = require('./forecastService');
const { getSoils } = require('./agriRigoService');
const { resolveDistrict } = require('./telegramService');
const { runStructured } = require('./aiService');
const logger = require('../utils/logger');

const STAGES = ['field_preparation', 'planting', 'weeding', 'fertiliser', 'harvest'];

const AGENT_A_SCHEMA = {
  type: 'object',
  properties: {
    seed_variety: { type: 'string' },
    seed_reason: { type: 'string' },
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
  required: ['seed_variety', 'seed_reason', 'stages'],
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

// Fixed six sections per AGENTS.md output schema.
const AGENT_C_SCHEMA = {
  type: 'object',
  properties: {
    field_prep: { type: 'array', items: { type: 'string' } },
    planting: { type: 'array', items: { type: 'string' } },
    weeding: { type: 'array', items: { type: 'string' } },
    fertiliser: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    harvest: { type: 'array', items: { type: 'string' } },
  },
  required: ['field_prep', 'planting', 'weeding', 'fertiliser', 'risks', 'harvest'],
};

const AGENT_A_SYSTEM = `You are Agent A, Agrisense agronomist. Given crop, location, soils, season position, field size, and water source, produce a season timeline.
RULES: cover all five stages; suggest seed variety from season position (early: medium or early maturity; normal: early-medium; late: early maturity only; off-season: plan for next season starting at first rains); rain-fed advice must hinge on rainfall windows; never invent soil or weather figures outside the context; reply under the given JSON schema.
STYLE: short actionable steps, plain words.`;

const AGENT_B_SYSTEM = `You are Agent B, Agrisense risk assessor. Given context and Agent A's timeline, attach warnings per stage plus critical risks.
RULES: late planting combined with late-maturity seed must be flagged with a switch to early maturity; inject drought and excess-rain windows using last-season data labelled historical; every warning needs a mitigation; reply under the given JSON schema.`;

const AGENT_C_SYSTEM = `You are Agent C, Agrisense editor. Convert the risk-adjusted plan into the six fixed sections.
RULES: every bullet short and actionable; fold stage warnings into their section and the critical risks into the risks section; professional yet plain tone for smallholder farmers; reply under the given JSON schema.`;

function planError(message, status = 500) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Zambia season runs roughly Nov–Apr.
function seasonPosition(now = new Date()) {
  const m = now.getMonth() + 1;
  if (m === 10 || m === 11) return 'early';
  if (m === 12) return 'normal';
  if (m === 1 || m === 2) return 'late';
  return 'off-season';
}

function summarizeSoils(body) {
  let d = (body && body.data) || body || {};
  if (Array.isArray(d)) d = d[0] || {};
  const parts = [];
  const soils = d.dominantSoils || d.dominant_soils;
  if (Array.isArray(soils)) parts.push(soils.join(', '));
  const ph = d.phRange || d.ph_range;
  if (Array.isArray(ph)) parts.push(`pH ${ph.join('-')}`);
  if (d.texture) parts.push(String(d.texture));
  return parts.join('; ');
}

function assertPlanC(p) {
  for (const k of Object.keys(AGENT_C_SCHEMA.properties)) {
    if (!p || !Array.isArray(p[k]) || p[k].length === 0) {
      throw planError(`Plan editor returned an unusable section: ${k}`);
    }
  }
  return p;
}

async function buildPlan({ crop, district, hectares, water, language }) {
  const cropName = String(crop || '').trim().toLowerCase();
  if (!cropName) throw planError('Crop is required.', 400);
  const dist = resolveDistrict(String(district || ''));
  if (!dist.matched) throw planError(`Unknown district "${district}". Try a nearby major town.`, 400);
  const ha = Number(hectares);
  const fieldHa = Number.isFinite(ha) && ha > 0 ? ha : 1;
  const waterSource = water === 'irrigated' ? 'irrigated' : 'rainfed';

  const forecast = await getDailyForecast(dist.lat, dist.lon).catch((err) => {
    throw planError(`Live weather unavailable, cannot ground the plan (${err.message})`);
  });
  const rain5 = forecast.daily.precipitation_sum.slice(0, 5).reduce((a, b) => a + b, 0);
  const soils = await getSoils(dist.province).catch(() => null);

  const ctx = {
    crop: cropName,
    district: dist.name,
    province: dist.province,
    hectares: fieldHa,
    water: waterSource,
    seasonPosition: seasonPosition(),
    today: new Date().toISOString().slice(0, 10),
    soil: summarizeSoils(soils && soils.data) || 'unknown',
    lastSeasonDrought: dist.drought_severity_2023_24
      ? `${dist.drought_severity_2023_24} (historical, 2023/24)`
      : 'unknown',
    currentRainNext5dMm: Math.round(rain5 * 10) / 10,
    forecastThrough: forecast.daily.time[forecast.daily.time.length - 1],
  };

  logger.info('plan', 'agent A drafting', { crop: cropName, district: dist.name });
  const planA = await runStructured(AGENT_A_SYSTEM, JSON.stringify(ctx), AGENT_A_SCHEMA);
  logger.info('plan', 'agent B assessing risk', {});
  const planB = await runStructured(AGENT_B_SYSTEM, JSON.stringify({ context: ctx, timelineA: planA }), AGENT_B_SCHEMA);
  logger.info('plan', 'agent C editing', {});
  const planC = await runStructured(AGENT_C_SYSTEM, JSON.stringify({ context: ctx, timelineB: planB }), AGENT_C_SCHEMA);
  assertPlanC(planC);

  const meta = { crop: cropName, district: dist.name, province: dist.province, hectares: fieldHa, water: waterSource };
  if (language && language !== 'english') {
    return { plan: await translatePlan(planC, meta, language), planEn: planC, meta };
  }
  return { plan: planC, planEn: planC, meta };
}

const LANGUAGE_NAMES = { bemba: 'Bemba (Chibemba)', nyanja: 'Nyanja (Chinyanja)', tonga: 'Tonga (Chitonga)' };

async function translatePlan(planEn, meta, language) {
  if (!language || language === 'english') return planEn;
  if (!LANGUAGE_NAMES[language]) throw planError(`Unsupported language "${language}".`, 400);
  const system = `Translate this Zambian farming plan into ${LANGUAGE_NAMES[language]}. RULES: preserve every number, date, place, and crop name exactly; keep the same six keys with the same bullet counts; plain farmer-friendly ${LANGUAGE_NAMES[language]}; reply under the given JSON schema.`;
  const out = await runStructured(system, JSON.stringify({ meta, plan: planEn }), AGENT_C_SCHEMA, undefined, 4096);
  return assertPlanC(out);
}

module.exports = { buildPlan, translatePlan, seasonPosition };
