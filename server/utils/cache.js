// Generic TTL cache. Callers build keys via buildKey() and pass TTLs.
// Expired entries are retained so callers can serve stale data with a flag
// (graceful degradation) instead of failing. No dependencies.
class TTLCache {
  constructor() {
    this.store = new Map();
  }

  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  // Fresh value, or undefined when missing/expired.
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) return undefined;
    return entry.value;
  }

  // { value, stale } for fresh AND expired entries; undefined when missing.
  // Use on upstream failure: return entry.value and flag stale_data.
  getStale(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    return { value: entry.value, stale: Date.now() > entry.expiresAt };
  }

  delete(key) {
    this.store.delete(key);
  }

  purgeExpired() {
    const now = Date.now();
    for (const [k, e] of this.store) {
      if (now > e.expiresAt) this.store.delete(k);
    }
  }
}

// Stable key: same resource+params always map to the same string,
// regardless of param key order.
function buildKey(resource, params) {
  const p = params === undefined || params === null ? '' : JSON.stringify(params, Object.keys(params).sort());
  return `${resource}:${p}`;
}

module.exports = { TTLCache, buildKey };
