import { capture, generateCacheKey, getPoolStats, setPoolMax } from './screenshot.js';
import { setConfig } from './runtime-config.js';
import { getHistory, getPeak } from './pool-history.js';
import * as cache from './cache.js';
import { validateURL, rateLimitPlugin, getRateLimit, setRateLimit, getBlockPrivateIps, setBlockPrivateIps } from './security.js';
import { join } from 'path';
import { readFile } from 'fs/promises';

const startTime = Date.now();
const UI_PATH = join(process.cwd(), 'src', 'ui', 'index.html');

/**
 * Register all routes
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function registerRoutes(fastify) {
  await fastify.register(rateLimitPlugin);

  /**
   * GET / - Serve the dashboard UI
   */
  fastify.get('/', async (request, reply) => {
    try {
        const uiContent = await readFile(UI_PATH, 'utf-8');
        reply.type('text/html').send(uiContent);
    } catch (error) {
        fastify.log.error(error, 'Failed to read UI index.html');
        reply.status(500).send({ error: 'Internal Server Error', message: 'Could not load dashboard UI.' });
    }
  });

  /**
   * GET /preview - Capture and return a screenshot
   */
  fastify.get('/preview', async (request, reply) => {
    const { url, width, format } = request.query;
    
    const validation = validateURL(url);
    if (!validation.valid) {
      return reply.status(400).send({ error: 'Bad Request', message: validation.error });
    }
    
    const thumbWidth = width ? parseInt(width, 10) : 240;
    const imageFormat = format && ['webp', 'png', 'jpeg'].includes(format) ? format : 'webp';
    
    if (isNaN(thumbWidth) || thumbWidth < 100 || thumbWidth > 1920) {
      return reply.status(400).send({ error: 'Bad Request', message: 'Invalid width parameter.' });
    }
    
    const cacheKey = generateCacheKey(url, { width: thumbWidth, format: imageFormat });
    const mimeType = imageFormat === 'png'
      ? 'image/png'
      : imageFormat === 'webp'
        ? 'image/webp'
        : 'image/jpeg';
    
    if (cache.has(cacheKey)) {
      const cachedBuffer = cache.get(cacheKey);
      if (cachedBuffer) {
        reply.header('Content-Type', mimeType).header('X-Cache', 'HIT');
        // Restore detection headers from cached metadata
        const meta = cache.getMeta ? cache.getMeta(cacheKey) : null;
        if (meta?.headers) {
          for (const [k, v] of Object.entries(meta.headers)) {
            reply.header(k, v);
          }
        }
        return cachedBuffer;
      }
    }
    
    try {
      const captureStart = Date.now();
      const result = await capture(url, { thumbWidth, format: imageFormat });
      const renderTime = Date.now() - captureStart;

      // Early-abort: Don't cache blocked/login/blank pages
      const isBlocked = result.headers['X-Bot-Blocked'] === 'true';
      const isLoginWall = result.headers['X-Login-Wall'] === 'true';
      const isBlank = result.headers['X-Blank-Page'] === 'true';
      
      if (isBlocked || isLoginWall || isBlank) {
        // Blocked/login/blank: cache the "blocked" state with short TTL so the
        // next visit is instant (50ms cache hit) instead of 4s browser work.
        // Frontend sees X-Bot-Blocked etc. via cached metadata and falls back to favicon.
        const transparentPixel = Buffer.from('UklGRiYAAABXRUJQVlA4IBoAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
        const blockedMeta = { url, renderTime, headers: result.headers, blocked: true };
        cache.set(cacheKey, transparentPixel, blockedMeta);
        reply.header('Content-Type', 'image/webp').header('X-Cache', 'MISS');
        if (result.headers) {
          for (const [k, v] of Object.entries(result.headers)) {
            reply.header(k, v);
          }
        }
        return transparentPixel;
      }

      const metadata = { url, renderTime, headers: result.headers };
      cache.set(cacheKey, result.buffer, metadata);
      
      reply.header('Content-Type', mimeType).header('X-Cache', 'MISS');
      // Pass through detection headers from screenshot (X-Bot-Blocked, X-Login-Wall, X-Blank-Page)
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) {
          reply.header(k, v);
        }
      }
      return result.buffer;
      
    } catch (error) {
      fastify.log.error({ err: error, url }, 'Screenshot capture failed');
      // Cache failures as "blocked" with short TTL so we don't hammer dead endpoints.
      // Frontend treats this identically to bot-blocked: show favicon fallback.
      const transparentPixel = Buffer.from('UklGRiYAAABXRUJQVlA4IBoAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
      const errHeaders = { 'X-Bot-Blocked': 'true', 'X-Login-Wall': 'false', 'X-Blank-Page': 'false', 'X-Error': error.message === 'TIMEOUT' ? 'timeout' : 'capture-failed' };
      try { cache.set(cacheKey, transparentPixel, { url, headers: errHeaders, blocked: true, failed: true }); } catch {}
      reply.header('Content-Type', 'image/webp').header('X-Cache', 'MISS');
      for (const [k, v] of Object.entries(errHeaders)) reply.header(k, v);
      return transparentPixel;
    }
  });

  /**
   * API Routes for the UI
   */
  fastify.get('/api/stats', async (request, reply) => {
    const stats = cache.getStats();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    return {
      entries: stats.entries,
      sizeBytes: stats.sizeBytes,
      sizeMB: stats.sizeBytes / (1024 * 1024),
      hitRate: stats.hitRate,
      avgRenderTime: stats.avgRenderTime,
      uptime,
      ttlHours: cache.getCurrentTTL(),
      rateLimitPerMinute: getRateLimit(),
      blockPrivateIps: getBlockPrivateIps(),
      pool: getPoolStats(),
    };
  });

  fastify.get('/api/pool/history', async (request, reply) => {
    const samples = getHistory();
    const peak = getPeak();
    return { samples, peak, current: getPoolStats(), percentiles: cache.getRenderPercentiles() };
  });

  fastify.get('/api/cache/recent', async (request, reply) => {
    const limitRaw = request.query.limit ? parseInt(request.query.limit, 10) : 20;
    // Hard ceiling to protect the UI & server. 2000 is plenty for a dashboard
    // — anything larger invites slow sync scans without real benefit.
    const limit = Math.min(Math.max(1, limitRaw || 20), 2000);
    return cache.getRecent(limit);
  });

  // Strict hex-key pattern shared by GET/DELETE cache endpoints — prevents any
  // path-traversal tricks (../, absolute paths, etc.) since the key is later
  // used as a filename fragment inside the cache dir.
  const CACHE_KEY_PATTERN = /^[a-f0-9]{8,128}$/i;

  fastify.get('/api/cache/thumbnail/:key', async (request, reply) => {
      const { key } = request.params;
      if (!CACHE_KEY_PATTERN.test(key)) {
          return reply.status(400).send({ error: 'Invalid key' });
      }
      if (cache.has(key)) {
          const buffer = cache.get(key);
          if (buffer) {
              // Assuming webp, adjust if format is stored in meta
              return reply.type('image/webp').send(buffer);
          }
      }
      reply.status(404).send({ error: 'Not Found' });
  });

  fastify.delete('/api/cache', async (request, reply) => {
    const deletedCount = cache.clearAll();
    return { deleted: deletedCount };
  });

  fastify.delete('/api/cache/:key', async (request, reply) => {
    const { key } = request.params;
    if (!CACHE_KEY_PATTERN.test(key)) {
      return reply.status(400).send({ error: 'Invalid key' });
    }
    const removed = cache.removeEntry(key);
    if (!removed) {
      return reply.status(404).send({ error: 'Not Found', removed: false });
    }
    return { removed: true };
  });

  fastify.patch('/api/settings', async (request, reply) => {
    const body = request.body || {};
    const { ttlHours, rateLimitPerMinute, blockPrivateIps, workers } = body;

    // ── Phase 1: Validate everything BEFORE applying anything ──
    const errors = [];
    const validated = {};

    if (ttlHours !== undefined) {
      const n = parseInt(ttlHours, 10);
      if (Number.isNaN(n) || n < 1 || n > 8760) {
        errors.push({ field: 'ttlHours', error: 'must be integer between 1 and 8760' });
      } else {
        validated.ttlHours = n;
      }
    }
    if (rateLimitPerMinute !== undefined) {
      const n = parseInt(rateLimitPerMinute, 10);
      if (Number.isNaN(n) || n < 0 || n > 10000) {
        errors.push({ field: 'rateLimitPerMinute', error: 'must be integer between 0 and 10000' });
      } else {
        validated.rateLimitPerMinute = n;
      }
    }
    if (blockPrivateIps !== undefined) {
      if (typeof blockPrivateIps !== 'boolean') {
        errors.push({ field: 'blockPrivateIps', error: 'must be boolean' });
      } else {
        validated.blockPrivateIps = blockPrivateIps;
      }
    }
    if (workers !== undefined) {
      const n = parseInt(workers, 10);
      if (Number.isNaN(n) || n < 1 || n > 20) {
        errors.push({ field: 'workers', error: 'must be integer between 1 and 20' });
      } else {
        validated.workers = n;
      }
    }

    // Bail early — nothing was applied yet.
    if (errors.length > 0) {
      return reply.status(400).send({ success: false, errors });
    }

    // ── Phase 2: Apply all validated changes ──
    let persistError = null;

    if (validated.ttlHours !== undefined) cache.setTTL(validated.ttlHours);
    if (validated.rateLimitPerMinute !== undefined) setRateLimit(validated.rateLimitPerMinute);
    if (validated.blockPrivateIps !== undefined) setBlockPrivateIps(validated.blockPrivateIps);
    if (validated.workers !== undefined) {
      const applied = setPoolMax(validated.workers);
      const persistResult = setConfig({ workers: applied });
      if (!persistResult.ok) persistError = persistResult.error;
    }

    const response = {
      success: true,
      settings: {
        ttlHours: cache.getCurrentTTL(),
        rateLimitPerMinute: getRateLimit(),
        blockPrivateIps: getBlockPrivateIps(),
        workers: getPoolStats().max,
      }
    };
    if (persistError) {
      response.warning = 'settings_applied_but_not_persisted';
      response.persistError = persistError;
      reply.status(207);
    }
    return response;
  });
  
  /**
   * GET /health - Health check endpoint
   */
  fastify.get('/health', async (request, reply) => {
    const stats = cache.getStats();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    return {
      status: 'ok',
      cache: {
        entries: stats.entries,
        sizeBytes: stats.sizeBytes
      },
      uptime
    };
  });
}
