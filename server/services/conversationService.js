// Per-chat conversation state: { action, crop, district }. Retained after each
// advisory so follow-ups ("what about fertiliser?") reuse district and crop.
// /start resets.
const states = new Map();

function getState(chatId) {
  if (!states.has(chatId)) states.set(chatId, {});
  return states.get(chatId);
}

function updateState(chatId, patch) {
  Object.assign(getState(chatId), patch);
  return getState(chatId);
}

function resetState(chatId) {
  states.set(chatId, {});
  return states.get(chatId);
}

module.exports = { getState, updateState, resetState };
