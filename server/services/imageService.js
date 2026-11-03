// Muse Image client: one-off generation via the OpenAI-compatible
// POST /v1/images/generations endpoint (see Meta Muse Image docs).
// Flat $0.01 per returned image; failures and safety blocks are not billed.
const axios = require('axios');
const logger = require('../utils/logger');

const IMAGE_BASE_URL = process.env.MODEL_API_BASE_URL || process.env.META_API_BASE_URL || 'https://api.meta.ai';
const IMAGE_API_KEY = process.env.MODEL_API_KEY || process.env.META_API_KEY || '';
const IMAGE_MODEL_ID = process.env.MODEL_IMAGE_ID || 'muse-image-1.0';
// Diagrams take longer than text; one attempt plus one retry on 503.
const TIMEOUT_MS = 90000;
const MAX_PROMPT_CHARS = 800;

// Landscape suits housing/paddock diagrams and prints well.
const DEFAULT_SIZE = '1536x1024';
const DEFAULT_FORMAT = 'png';

// Pure: build the exact request body so tests can check it without network.
function buildImageRequest(prompt, { size = DEFAULT_SIZE, outputFormat = DEFAULT_FORMAT } = {}) {
  const p = String(prompt || '').trim();
  if (!p) throw new Error('imageService: prompt must be a non-empty string');
  return {
    model: IMAGE_MODEL_ID,
    prompt: p.length > MAX_PROMPT_CHARS ? p.slice(0, MAX_PROMPT_CHARS) : p,
    n: 1,
    size,
    response_format: 'b64_json',
    output_format: outputFormat,
    reasoning_strength: 'high',
  };
}

function imageError(message, status = 502) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function describeApiError(err) {
  const data = err && err.response && err.response.data;
  const info = data && data.error;
  if (info && info.message) return `${info.message} (param: ${info.param || 'none'}, code: ${info.code || info.type || 'unknown'})`;
  return err.message;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { b64, format, usage }. Throws on failure; callers decide whether
// a missing image blocks their response (it should not block a text plan).
async function generateImage(prompt, opts = {}) {
  if (!IMAGE_API_KEY) throw imageError('imageService: MODEL_API_KEY not configured', 500);
  const body = buildImageRequest(prompt, opts);
  const url = `${IMAGE_BASE_URL}/v1/images/generations`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.post(url, body, {
        timeout: TIMEOUT_MS,
        headers: { Authorization: `Bearer ${IMAGE_API_KEY}` },
      });
      const entry = res.data && res.data.data && res.data.data[0];
      if (!entry || !entry.b64_json) throw new Error('missing b64_json in response');
      logger.info('image', 'generated', { bytes: entry.b64_json.length, format: res.data.output_format });
      return { b64: entry.b64_json, format: res.data.output_format || body.output_format, usage: res.data.usage || null };
    } catch (err) {
      const status = err && err.response && err.response.status;
      const code = err && err.response && err.response.data && err.response.data.error && err.response.data.error.code;
      // Retryable backend failure per docs: 503 → back off once and retry.
      if (status === 503 && attempt === 1) {
        logger.warn('image', 'transient 503, retrying once', {});
        await sleep(2000);
        continue;
      }
      if (code === 'content_policy_violation') {
        throw imageError(`imageService: prompt blocked by content policy (${describeApiError(err)})`, 422);
      }
      throw imageError(`imageService: generation failed (${describeApiError(err)})`);
    }
  }
  throw imageError('imageService: generation failed after retry');
}

module.exports = { generateImage, buildImageRequest, IMAGE_MODEL_ID, MAX_PROMPT_CHARS };
