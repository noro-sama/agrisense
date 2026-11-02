// Telegram photo intake for crop-health checks. Downloads the largest photo
// size and returns base64 + mime for the vision call.
const axios = require('axios');
const logger = require('../utils/logger');

function pickPhotoId(msg) {
  const photos = msg.photo || [];
  if (!photos.length) return null;
  return photos[photos.length - 1].file_id; // sizes ascending, last is largest
}

async function fetchPhotoBase64(bot, fileId) {
  const file = await bot.getFile(fileId);
  if (!file.file_path) throw new Error('cropHealth: Telegram returned no file path');
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000, maxContentLength: 8 * 1024 * 1024 });
  const buf = Buffer.from(res.data);
  const mime = String(res.headers['content-type'] || '').startsWith('image/') ? res.headers['content-type'] : 'image/jpeg';
  logger.info('crophealth', 'photo downloaded', { bytes: buf.length, mime });
  return { base64: buf.toString('base64'), mimeType: mime };
}

module.exports = { pickPhotoId, fetchPhotoBase64 };
