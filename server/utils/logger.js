// Structured console logger. Every line carries a stage tag so logs can be
// filtered per pipeline stage (telegram, weather, features, ai, etc).
function log(stage, level, message, extra) {
  const line = { ts: new Date().toISOString(), stage, level, message };
  if (extra !== undefined) line.extra = extra;
  console.log(JSON.stringify(line));
}

module.exports = {
  info: (stage, message, extra) => log(stage, 'info', message, extra),
  warn: (stage, message, extra) => log(stage, 'warn', message, extra),
  error: (stage, message, extra) => log(stage, 'error', message, extra),
};
