import { LRUCache } from 'lru-cache';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const CACHE_DIR = './cache';
let CACHE_TTL_HOURS = parseInt(process.env.CACHE_TTL_HOURS, 10) || 24;
const MAX_CACHE_SIZE_MB = parseInt(process.env.MAX_CACHE_SIZE_MB, 10) || 500;
const MAX_CACHE_BYTES = MAX_CACHE_SIZE_MB * 1024 * 1024;

// --- Statistics ---
let hits = 0;
let misses = 0;
const renderTimes = [];
const MAX_RENDER_TIMES = 100; // Store last 100 render times for averaging

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

const memoryCache = new LRUCache({
  max: 10000,
  ttl: CACHE_TTL_HOURS * 60 * 60 * 1000,
  updateAgeOnGet: true
});

function getCachePath(key) {
  return join(CACHE_DIR, `${key}.bin`);
}

function getMetaPath(key) {
  return join(CACHE_DIR, `${key}.json`);
}

export function has(key) {
  if (memoryCache.has(key)) {
    const meta = memoryCache.get(key);
    if (meta && Date.now() - meta.timestamp < CACHE_TTL_HOURS * 60 * 60 * 1000) {
      if (existsSync(getCachePath(key))) {
        hits++;
        return true;
      }
      memoryCache.delete(key);
    }
  }
  
  const metaPath = getMetaPath(key);
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      if (Date.now() - meta.timestamp < CACHE_TTL_HOURS * 60 * 60 * 1000 && existsSync(getCachePath(key))) {
        memoryCache.set(key, meta);
        hits++;
        return true;
      } else {
        cleanupEntry(key);
      }
    } catch {
      cleanupEntry(key);
    }
  }
  
  misses++;
  return false;
}

export function get(key) {
  if (!has(key)) {
    return null;
  }
  try {
    return readFileSync(getCachePath(key));
  } catch (err) {
    memoryCache.delete(key);
    return null;
  }
}

export function getMeta(key) {
  if (memoryCache.has(key)) {
    return memoryCache.get(key);
  }
  
  const metaPath = getMetaPath(key);
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      memoryCache.set(key, meta);
      return meta;
    } catch {
      return null;
    }
  }
  return null;
}

export function set(key, buffer, metadata = {}) {
  const cachePath = getCachePath(key);
  const metaPath = getMetaPath(key);
  const timestamp = Date.now();
  const size = buffer.length;
  
  if (metadata.renderTime) {
      renderTimes.push(metadata.renderTime);
      if (renderTimes.length > MAX_RENDER_TIMES) {
          renderTimes.shift(); // Keep array size fixed
      }
  }

  const currentSize = getCacheSize();
  if (currentSize + size > MAX_CACHE_BYTES) {
    cleanupOldEntries(size);
  }
  
  try {
    const metaToWrite = { timestamp, size, ...metadata };
    writeFileSync(cachePath, buffer);
    writeFileSync(metaPath, JSON.stringify(metaToWrite));
    memoryCache.set(key, metaToWrite);
  } catch (err) {
    cleanupEntry(key);
    throw err;
  }
}

function cleanupEntry(key) {
  memoryCache.delete(key);
  try {
    const cachePath = getCachePath(key);
    const metaPath = getMetaPath(key);
    if (existsSync(cachePath)) unlinkSync(cachePath);
    if (existsSync(metaPath)) unlinkSync(metaPath);
  } catch {}
}

export function removeEntry(key) {
  // Reject non-hex keys defensively (path traversal guard)
  if (!/^[a-f0-9]{8,}$/i.test(key)) return false;
  const cachePath = getCachePath(key);
  const existed = existsSync(cachePath);
  cleanupEntry(key);
  return existed;
}

function getCacheSize() {
  let totalSize = 0;
  try {
    const files = readdirSync(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith('.bin')) {
        totalSize += statSync(join(CACHE_DIR, file)).size;
      }
    }
  } catch {}
  return totalSize;
}

function cleanupOldEntries(neededBytes) {
    try {
        const entries = readdirSync(CACHE_DIR)
            .filter(file => file.endsWith('.json'))
            .map(file => {
                try {
                    const meta = JSON.parse(readFileSync(join(CACHE_DIR, file), 'utf-8'));
                    return { key: file.replace('.json', ''), timestamp: meta.timestamp, size: meta.size };
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => a.timestamp - b.timestamp);

        let freed = 0;
        for (const entry of entries) {
            if (freed >= neededBytes) break;
            cleanupEntry(entry.key);
            freed += entry.size;
        }
    } catch {}
}

export function cleanup() {
  const now = Date.now();
  const maxAge = CACHE_TTL_HOURS * 60 * 60 * 1000;
  let cleaned = 0;
  try {
    const files = readdirSync(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const key = file.replace('.json', '');
        try {
          const meta = JSON.parse(readFileSync(join(CACHE_DIR, file), 'utf-8'));
          if (now - meta.timestamp > maxAge) {
            cleanupEntry(key);
            cleaned++;
          }
        } catch {
          cleanupEntry(key);
          cleaned++;
        }
      }
    }
  } catch {}
  return cleaned;
}

export function getStats() {
    let entries = 0;
    let sizeBytes = 0;
    try {
        const files = readdirSync(CACHE_DIR);
        for (const file of files) {
            if (file.endsWith('.bin')) {
                entries++;
                sizeBytes += statSync(join(CACHE_DIR, file)).size;
            }
        }
    } catch {}
    
    const totalRequests = hits + misses;
    const hitRate = totalRequests > 0 ? (hits / totalRequests) * 100 : 0;
    const avgRenderTime = renderTimes.length > 0 ? renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length : 0;

    return { entries, sizeBytes, hitRate, avgRenderTime };
}

export function getRenderPercentiles() {
    if (renderTimes.length === 0) return { p50: 0, p95: 0, p99: 0, count: 0 };
    const sorted = [...renderTimes].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    return {
        p50: Math.round(pct(0.5)),
        p95: Math.round(pct(0.95)),
        p99: Math.round(pct(0.99)),
        count: sorted.length,
    };
}

export function getRecent(limit = 20) {
    try {
        return readdirSync(CACHE_DIR)
            .filter(file => file.endsWith('.json'))
            .map(file => {
                try {
                    const meta = JSON.parse(readFileSync(join(CACHE_DIR, file), 'utf-8'));
                    return {
                        key: file.replace('.json', ''),
                        url: meta.url,
                        createdAt: meta.timestamp,
                        sizeBytes: meta.size,
                        blocked: !!meta.blocked,
                        failed: !!meta.failed,
                    };
                } catch {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, limit);
    } catch {
        return [];
    }
}

export function clearAll() {
    let count = 0;
    try {
        const files = readdirSync(CACHE_DIR);
        for (const file of files) {
            unlinkSync(join(CACHE_DIR, file));
            if(file.endsWith('.bin')) count++;
        }
        memoryCache.clear();
        hits = 0;
        misses = 0;
        renderTimes.length = 0;
    } catch {}
    return count;
}

export function setTTL(hours) {
    CACHE_TTL_HOURS = hours;
    memoryCache.options.ttl = hours * 60 * 60 * 1000;
    return CACHE_TTL_HOURS;
}

export function getCurrentTTL() {
    return CACHE_TTL_HOURS;
}

export function cleanupCache() {
  cleanup();
}

setInterval(cleanup, 30 * 60 * 1000);
