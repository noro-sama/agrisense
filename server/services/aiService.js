// Muse Spark advisory service. The model receives ONLY pre-computed features
// (never raw payloads) and replies under a JSON-schema contract: the verdict
// stays machine-checkable while explanation prose stays free. Every output is
// validated against its input; hard overrides per action apply before return.
const axios = require('axios');
const logger = require('../utils/logger');

const META_BASE_URL = process.env.MODEL_API_BASE_URL || process.env.META_API_BASE_URL || 'https://api.meta.ai';
const META_API_KEY = process.env.MODEL_API_KEY || process.env.META_API_KEY || '';
const META_MODEL_ID = process.env.MODEL_ID || process.env.META_MODEL_ID || 'muse-spark-1.3';
// Reasoning models spend most of max_tokens thinking; without headroom the
// answer is cut off and the reply arrives with no text block at all.
const MAX_TOKENS = 2048;
// Slow real answer beats fast fallback; end-to-end budget is best-effort.
const TIMEOUT_MS = 25000;
const VISION_TIMEOUT_MS = 40000;

const NO_WINDOW = 'no planting window in current forecast';
const ACTION_LABELS = { plant: 'PLANT', fertiliser: 'APPLY', till: 'TILL' };

const MODEL_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['GO', 'WAIT'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    explanation: { type: 'string' },
    timing: { type: 'string' },
    cautions: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'confidence', 'explanation', 'timing', 'cautions'],
};

function systemPromptFor(action) {
  const common = `You are Agrisense, a Zambian smallholder-farming adviser. A human farmer makes the final call; you inform it.
RULES: reason ONLY from the supplied features; never invent rainfall figures, dates, or facts outside them. If the forecast probability behind your advice is below 50, confidence must be "low" or "medium", never "high". Reply under the given JSON schema.
STYLE: write explanation for a smallholder farmer on a small phone. One or two short plain sentences, no variable names, no jargon. Weave key numbers in naturally, e.g. "About 26mm of rain is coming in the next 5 days" instead of naming features. Timing must be a plain date phrase.`;
  if (action === 'fertiliser') {
    return `${common}
FERTILISER RULES: verdict GO only when rain is expected soon without heavy downpours. If heavy_rain_in_3d is true, verdict MUST be WAIT (runoff washes fertiliser away). If bone_dry is true, verdict MUST be WAIT (concentrated fertiliser burns roots in dry soil).`;
  }
  if (action === 'till') {
    return `${common}
TILLAGE RULES: verdict GO only for a workable dry window. If heavy_rain_risk_days > 0, verdict MUST be WAIT (wet fields turn to mud under the hoe).`;
  }
  return `${common}
PLANTING RULES: if has_effective_rain_in_window is false, verdict MUST be WAIT and timing MUST be exactly "${NO_WINDOW}". If heavy_rain_risk_days > 0 and waterlogging_sensitive is true, include an explicit flood/waterlogging caution, but do not block planting on it. If recently_wet is true, mention the recent rain in explanation and advise checking moisture at seed depth before waiting out the dry forecast.`;
}

function buildUserPrompt(action, { features, cropKnowledge, soilData, droughtNote, observedNote }) {
  return `Action: ${action}
Features (computed server-side from the forecast):
${JSON.stringify(features)}

Crop knowledge: ${cropKnowledge || 'none supplied'}
Soil: ${soilData || 'none supplied'}
${droughtNote || ''}
${observedNote || ''}`;
}

// Rule-based "wait until" trigger. WAITs name their loop-closer; GO verdicts
// and non-plant actions get none. Wet soil adds the hand-check escape hatch.
function buildRecheckHint(action, features) {
  if (action !== 'plant' || !features || features.has_effective_rain_in_window) return null;
  const crop = features.crop || 'crop';
  const need = features.min_effective_rain_mm ?? 15;
  if (features.recently_wet) {
    return `Soil may still be moist from recent rain (${features.observed_rain_last_5d_mm}mm in the last 5 days). If the soil is moist at seed depth, you can plant; otherwise re-check when the forecast shows ≥${need}mm of rain within 3 days for ${crop}.`;
  }
  return `Re-check when the forecast shows ≥${need}mm of rain within 3 days for ${crop}.`;
}

const RETRY_INSTRUCTION = 'Reply with ONLY the JSON object matching this shape: {"verdict":"GO|WAIT","confidence":"high|medium|low","explanation":"...","timing":"...","cautions":[...]}. No other text.';

function extractText(data) {
  if (data && Array.isArray(data.content)) {
    const t = data.content.map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
    if (t) return t;
  }
  if (data && typeof data.content === 'string') return data.content;
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  if (msg && typeof msg.content === 'string') return msg.content;
  return '';
}

async function callMetaModel(system, content, schema, timeoutMs = TIMEOUT_MS, maxTokens = MAX_TOKENS) {
  if (!META_API_KEY) {
    throw new Error('aiService: MODEL_API_KEY not configured');
  }
  const body = {
    model: META_MODEL_ID,
    system,
    messages: [{ role: 'user', content }],
    max_tokens: maxTokens,
  };
  body.output_config = { effort: 'low' };
  if (schema) body.output_config.format = { type: 'json_schema', schema };
  const res = await axios.post(`${META_BASE_URL}/v1/messages`, body, {
    timeout: timeoutMs,
    headers: { Authorization: `Bearer ${META_API_KEY}` },
  });
  const text = extractText(res.data).replace(/```json|```/g, '').trim();
  const meta = { stopReason: res.data && res.data.stop_reason, usage: res.data && res.data.usage };
  logger.info('ai', 'model reply received', meta);
  if (!text) logger.warn('ai', 'model returned no text block', meta);
  return { text, ...meta };
}

function parseModelJson(text) {
  const t = String(text || '').trim();
  try {
    return JSON.parse(t);
  } catch (err) {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw err;
  }
}

function isValidModelShape(o) {
  return (
    o && typeof o === 'object' &&
    (o.verdict === 'GO' || o.verdict === 'WAIT') &&
    (o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low') &&
    typeof o.explanation === 'string' && o.explanation.length > 0 &&
    typeof o.timing === 'string' && o.timing.length > 0 &&
    Array.isArray(o.cautions)
  );
}

function toDecision(parsed, action, input, sourcesUsed) {
  const context_notes = [];
  if (input.droughtNote) context_notes.push(input.droughtNote);
  if (input.observedNote) context_notes.push(input.observedNote);
  return {
    recommendation: parsed.verdict === 'GO' ? ACTION_LABELS[action] : 'WAIT',
    confidence: parsed.confidence,
    reason_plain: parsed.explanation,
    timing: parsed.timing,
    risk_flags: [...parsed.cautions],
    context_notes,
    recheck_hint: buildRecheckHint(action, input.features),
    sources_used: sourcesUsed,
  };
}

// Hard overrides: model output corrected against input features before return.
function validateAndOverride(decision, features, action) {
  const out = { ...decision, risk_flags: [...decision.risk_flags], context_notes: [...decision.context_notes] };

  if (action === 'plant' && !features.has_effective_rain_in_window) {
    if (out.recommendation !== 'WAIT' || out.timing !== NO_WINDOW) {
      logger.warn('ai', 'overriding model output: no effective rain in features');
      out.recommendation = 'WAIT';
      out.timing = NO_WINDOW;
      out.context_notes.push('Model output overridden: features show no effective rain');
    }
  }
  if (action === 'fertiliser' && features.heavy_rain_in_3d && out.recommendation !== 'WAIT') {
    out.recommendation = 'WAIT';
    out.timing = 'wait until heavy rain passes';
    out.context_notes.push('Model output overridden: heavy rain within 3 days washes fertiliser away');
  }
  if (action === 'fertiliser' && features.bone_dry && out.recommendation !== 'WAIT') {
    out.recommendation = 'WAIT';
    out.timing = 'wait for rain before applying';
    out.context_notes.push('Model output overridden: soil too dry, fertiliser would burn roots');
  }
  if (action === 'till' && features.heavy_rain_risk_days > 0 && out.recommendation !== 'WAIT') {
    out.recommendation = 'WAIT';
    out.timing = 'wait for a dry window';
    out.context_notes.push('Model output overridden: heavy rain makes fields unworkable');
  }
  const conf = features.best_confidence_for_first_effective_rain ?? features.best_confidence_for_first_useful_rain;
  if (typeof conf === 'number' && conf < 50 && out.confidence === 'high') {
    out.confidence = 'medium';
    out.context_notes.push(`Forecast confidence downgraded: rain probability ${conf}%`);
  }
  if (action === 'plant' && features.heavy_rain_risk_days > 0 && features.waterlogging_sensitive) {
    const flagged = out.risk_flags.some((f) => /flood|waterlog/i.test(f));
    if (!flagged) out.risk_flags.push(`flood/waterlogging risk for ${features.crop}`);
  }
  return out;
}

function baseNotes(input, note) {
  const notes = [];
  if (input.droughtNote) notes.push(input.droughtNote);
  if (input.observedNote) notes.push(input.observedNote);
  if (note) notes.push(note);
  return notes;
}

function ruleBasedAdvice(input, sourcesUsed, note) {
  const { action, features: f } = input;
  const context_notes = baseNotes(input, note);
  const recheck_hint = buildRecheckHint(action, f);
  if (action === 'fertiliser') {
    const risk_flags = [];
    if (f.heavy_rain_in_3d) risk_flags.push('heavy rain within 3 days would wash fertiliser away');
    if (f.bone_dry) risk_flags.push('soil too dry; fertiliser would burn roots');
    if (f.heavy_rain_in_3d || f.bone_dry) {
      return {
        recommendation: 'WAIT', confidence: 'low',
        reason_plain: f.heavy_rain_in_3d
          ? 'Heavy rain is coming within 3 days; it would wash fertiliser away.'
          : 'The soil is too dry; fertiliser now would burn the roots.',
        timing: f.heavy_rain_in_3d ? 'wait until heavy rain passes' : 'wait for rain, then apply',
        risk_flags, context_notes, recheck_hint, sources_used: sourcesUsed,
      };
    }
    return {
      recommendation: 'APPLY', confidence: 'low',
      reason_plain: `Rain expected around ${f.first_useful_rain_date}; a good window to apply fertiliser.`,
      timing: f.first_useful_rain_date,
      risk_flags, context_notes, recheck_hint, sources_used: sourcesUsed,
    };
  }
  if (action === 'till') {
    if (f.heavy_rain_risk_days > 0) {
      return {
        recommendation: 'WAIT', confidence: 'low',
        reason_plain: 'Heavy rain in the window would turn tilled fields to mud.',
        timing: 'wait for a dry window',
        risk_flags: [`heavy rain on ${f.heavy_rain_risk_days} day(s)`],
        context_notes, recheck_hint, sources_used: sourcesUsed,
      };
    }
    return {
      recommendation: 'TILL', confidence: 'low',
      reason_plain: `Dry workable window through ${f.window_through}.`,
      timing: `now through ${f.window_through}`,
      risk_flags: [], context_notes, recheck_hint, sources_used: sourcesUsed,
    };
  }
  const risk_flags = [];
  if (f.heavy_rain_risk_days > 0) risk_flags.push(`heavy rain on ${f.heavy_rain_risk_days} day(s)`);
  if (f.heat_stress_days > 0) risk_flags.push(`heat stress on ${f.heat_stress_days} day(s)`);
  if (f.heavy_rain_risk_days > 0 && f.waterlogging_sensitive) risk_flags.push(`flood/waterlogging risk for ${f.crop}`);
  if (!f.has_effective_rain_in_window) {
    return {
      recommendation: 'WAIT', confidence: 'low',
      reason_plain: `No effective rain for ${f.crop} in the current forecast; dry start of ${f.dry_streak_days} day(s).`,
      timing: NO_WINDOW,
      risk_flags, context_notes, recheck_hint, sources_used: sourcesUsed,
    };
  }
  return {
    recommendation: 'PLANT', confidence: 'low',
    reason_plain: `Effective rain for ${f.crop} expected around ${f.first_effective_rain_date}; ok to plant now ahead of the rains.`,
    timing: f.first_effective_rain_date,
    risk_flags, context_notes, recheck_hint, sources_used: sourcesUsed,
  };
}

// Input: { action, features, cropKnowledge, soilData, droughtNote, observedNote, sources_used }
async function getPlantingDecision(input) {
  const action = input.action || 'plant';
  if (!ACTION_LABELS[action]) throw new Error(`aiService: unknown action '${input.action}'`);
  const sourcesUsed = input.sources_used || [];
  const system = systemPromptFor(action);
  const user = buildUserPrompt(action, input);

  let raw;
  try {
    ({ text: raw } = await callMetaModel(system, user, MODEL_SCHEMA));
  } catch (err) {
    logger.warn('ai', 'Meta API unreachable, using rule-based fallback', { error: err.message });
    return ruleBasedAdvice({ ...input, action }, sourcesUsed, 'AI unavailable, rule-based advice (low confidence)');
  }

  let parsed;
  try {
    parsed = parseModelJson(raw);
    if (!isValidModelShape(parsed)) throw new Error('schema mismatch');
  } catch (err) {
    logger.warn('ai', 'model reply unparseable, retrying once without schema lock', { error: err.message, raw: String(raw).slice(0, 300) });
    try {
      ({ text: raw } = await callMetaModel(system, `${user}\n\n${RETRY_INSTRUCTION}`, false));
      parsed = parseModelJson(raw);
      if (!isValidModelShape(parsed)) throw new Error('schema mismatch on retry');
    } catch (err2) {
      logger.warn('ai', 'retry failed, using rule-based fallback', { error: err2.message, raw: String(raw).slice(0, 300) });
      return ruleBasedAdvice({ ...input, action }, sourcesUsed, 'AI reply invalid, rule-based advice (low confidence)');
    }
  }
  return validateAndOverride(toDecision(parsed, action, input, sourcesUsed), input.features, action);
}

const HEALTH_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['HEALTHY', 'SUSPECT'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    explanation: { type: 'string' },
    timing: { type: 'string' },
    cautions: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'confidence', 'explanation', 'timing', 'cautions'],
};

const HEALTH_RETRY_INSTRUCTION = 'Reply with ONLY the JSON object matching this shape: {"verdict":"HEALTHY|SUSPECT","confidence":"high|medium|low","explanation":"...","timing":"...","cautions":[...]}. No other text.';

function isValidHealthShape(o) {
  return (
    o && typeof o === 'object' &&
    (o.verdict === 'HEALTHY' || o.verdict === 'SUSPECT') &&
    (o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low') &&
    typeof o.explanation === 'string' && o.explanation.length > 0 &&
    typeof o.timing === 'string' && o.timing.length > 0 &&
    Array.isArray(o.cautions)
  );
}

// Crop-health verdict from a photo. Same decision envelope as advisories, so
// replies, translation, and formatting are shared. verdict HEALTHY|SUSPECT.
async function analyzeCropImage(imageBase64, mimeType, context) {
  const system = `You are Agrisense crop doctor for Zambian smallholder farmers. A human farmer makes the final call; you inform it.
RULES: describe ONLY symptoms visible in the photo; never invent diseases, pests, or details you cannot see. If the photo is too blurry, dark, or far to judge, verdict MUST be SUSPECT with low confidence and ask for a closer photo. verdict HEALTHY only when the plant looks clearly healthy. Reply under the given JSON schema.
STYLE: plain farmer-friendly sentences, one or two sentences for explanation; timing must name immediate action steps.`;
  const content = [
    { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
    { type: 'text', text: `Crop: ${(context && context.crop) || 'unknown'}. Assess this plant's health and reply under the schema.` },
  ];
  const toHealth = (parsed) => ({
    recommendation: parsed.verdict,
    confidence: parsed.confidence,
    reason_plain: parsed.explanation,
    timing: parsed.timing,
    risk_flags: [...parsed.cautions, 'Unsure? Confirm with your extension officer'],
    context_notes: [],
    sources_used: ['muse-spark:vision'],
  });
  const fallback = (note) => ({
    recommendation: 'SUSPECT',
    confidence: 'low',
    reason_plain: 'I could not analyse this photo clearly. Please send a closer, well-lit photo of the affected leaves.',
    timing: 'send a clearer close-up photo',
    risk_flags: ['Unclear photo'],
    context_notes: note ? [note] : [],
    sources_used: ['muse-spark:vision'],
  });

  let raw;
  try {
    ({ text: raw } = await callMetaModel(system, content, HEALTH_SCHEMA, VISION_TIMEOUT_MS));
  } catch (err) {
    logger.warn('ai', 'vision call failed, using fallback', { error: err.message });
    return fallback('AI unavailable');
  }
  let parsed;
  try {
    parsed = parseModelJson(raw);
    if (!isValidHealthShape(parsed)) throw new Error('schema mismatch');
  } catch (err) {
    logger.warn('ai', 'vision reply unparseable, retrying once', { error: err.message });
    try {
      ({ text: raw } = await callMetaModel(system, [...content, { type: 'text', text: HEALTH_RETRY_INSTRUCTION }], null, VISION_TIMEOUT_MS));
      parsed = parseModelJson(raw);
      if (!isValidHealthShape(parsed)) throw new Error('schema mismatch on retry');
    } catch (err2) {
      logger.warn('ai', 'vision retry failed, using fallback', { error: err2.message });
      return fallback('AI reply invalid');
    }
  }
  return toHealth(parsed);
}

// Generic schema-locked call with one plain retry. Returns parsed JSON, throws
// to the caller on failure (no silent fallback for multi-stage pipelines).
async function runStructured(system, user, schema, timeoutMs = TIMEOUT_MS, maxTokens = MAX_TOKENS) {
  let { text: raw } = await callMetaModel(system, user, schema, timeoutMs, maxTokens);
  try {
    return parseModelJson(raw);
  } catch (err) {
    logger.warn('ai', 'structured reply unparseable, retrying once', { error: err.message });
    const retryUser = typeof user === 'string'
      ? `${user}\n\nReply with ONLY the JSON object. No other text.`
      : [...user, { type: 'text', text: 'Reply with ONLY the JSON object. No other text.' }];
    ({ text: raw } = await callMetaModel(system, retryUser, null, timeoutMs, maxTokens));
    return parseModelJson(raw);
  }
}

const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string' },
    timing: { type: 'string' },
    cautions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
    recheck: { type: 'string' },
  },
  required: ['explanation', 'timing', 'cautions', 'notes', 'recheck'],
};
const LANGUAGE_NAMES = { bemba: 'Bemba (Chibemba)', nyanja: 'Nyanja (Chinyanja)', tonga: 'Tonga (Chitonga)', english: 'English' };

// Translate a finished decision. Verdict, confidence, and numbers stay
// untouched; only human-facing text is translated. Single attempt: on failure
// the original English is returned with a note.
async function translateDecision(decision, context, language) {
  if (!language || language === 'english') return decision;
  const langName = LANGUAGE_NAMES[language] || language;
  const system = `You translate Zambian farming advice into ${langName}. RULES: preserve every number, date, rainfall figure, and place or crop name exactly; plain farmer-friendly ${langName}; reply under the given JSON schema.`;
  const user = `Translate this ${context.action || 'planting'} advice for ${context.crop} in ${context.district}:\n${JSON.stringify({ explanation: decision.reason_plain, timing: decision.timing, cautions: decision.risk_flags, notes: decision.context_notes, recheck: decision.recheck_hint || '' })}`;
  try {
    const { text: raw } = await callMetaModel(system, user, TRANSLATION_SCHEMA);
    const parsed = parseModelJson(raw);
    const ok = parsed && typeof parsed.explanation === 'string' && parsed.explanation.length > 0
      && typeof parsed.timing === 'string' && parsed.timing.length > 0
      && Array.isArray(parsed.cautions) && Array.isArray(parsed.notes)
      && typeof parsed.recheck === 'string';
    if (!ok) throw new Error('schema mismatch');
    return { ...decision, reason_plain: parsed.explanation, timing: parsed.timing, risk_flags: parsed.cautions, context_notes: parsed.notes, recheck_hint: parsed.recheck || null };
  } catch (err) {
    logger.warn('ai', 'translation failed, keeping English', { error: err.message, language });
    return { ...decision, context_notes: [...decision.context_notes, 'Translation unavailable, showing English'] };
  }
}

module.exports = { getPlantingDecision, translateDecision, analyzeCropImage, runStructured, validateAndOverride, ruleBasedAdvice, buildRecheckHint, buildUserPrompt, MODEL_SCHEMA, ACTION_LABELS };
