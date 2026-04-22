// runtime-config.js — persistent runtime configuration
// Stores mutable settings (workers, rate-limits, etc.) in a JSON file
// so they survive container restarts.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { dirname } from 'path';

const CONFIG_PATH = process.env.RUNTIME_CONFIG_PATH || './cache/runtime-config.json';

// Allow-list of config keys + validators. Anything not in this map is ignored on load.
const SCHEMA = {
  workers: {
    type: 'int',
    min: 1,
    max: 20,
    default: parseInt(process.env.CONCURRENCY, 10) || 6,
  },
};

function coerceInt(value, { min, max, fallback }) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function validate(raw) {
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    if (spec.type === 'int') {
      out[key] = coerceInt(raw?.[key], { min: spec.min, max: spec.max, fallback: spec.default });
    }
  }
  return out;
}

let current = validate({});

// Ensure dir exists
try {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
} catch {}

// Load from disk if present — always normalized through the schema.
if (existsSync(CONFIG_PATH)) {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    current = validate(raw && typeof raw === 'object' ? raw : {});
  } catch {
    // Corrupt file → keep defaults, but don't overwrite the bad file
    // until the caller explicitly sets something (preserves user's data
    // for forensic purposes if the parse failure is transient).
  }
}

export function getConfig() {
  return { ...current };
}

/**
 * Atomically persist new config. Validates via schema so bad values can
 * never be written to disk. Returns { ok, config } so callers can decide
 * how to report persistence failures to users.
 */
export function setConfig(patch) {
  const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  const next = validate(merged);
  current = next;

  // Atomic write: write to .tmp, then rename. Avoids torn files on crash.
  const tmp = CONFIG_PATH + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, CONFIG_PATH);
    return { ok: true, config: { ...next } };
  } catch (err) {
    // Cleanup partial tmp file so we don't leave debris behind.
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    return { ok: false, error: err?.message || 'persist_failed', config: { ...next } };
  }
}
