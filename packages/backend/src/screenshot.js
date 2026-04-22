import { chromium } from 'playwright';
import sharp from 'sharp';
import { createHash } from 'crypto';
import { getConfig } from './runtime-config.js';

const DEFAULT_TIMEOUT = parseInt(process.env.SCREENSHOT_TIMEOUT, 10) || 15000;
const DEFAULT_VIEWPORT_WIDTH = parseInt(process.env.DEFAULT_VIEWPORT_WIDTH, 10) || 1280;
const DEFAULT_VIEWPORT_HEIGHT = parseInt(process.env.DEFAULT_VIEWPORT_HEIGHT, 10) || 960;
const DEFAULT_THUMB_WIDTH = parseInt(process.env.DEFAULT_THUMB_WIDTH, 10) || 240;
const INITIAL_WORKERS = getConfig().workers || parseInt(process.env.CONCURRENCY, 10) || 6;

/** @type {import('playwright').Browser | null} */
let browser = null;

// ============ SEMAPHORE / WORKER POOL ============
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }
  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
  stats() {
    return { active: this.active, queued: this.queue.length, max: this.max };
  }
  setMax(newMax) {
    const clamped = Math.max(1, Math.min(20, parseInt(newMax, 10) || 1));
    this.max = clamped;
    // If raising cap, wake up queued workers up to newly available slots.
    // (acquire() increments this.active after its promise resolves, so we
    //  release at most (max - active) now — the released workers will
    //  increment active asynchronously.)
    const slots = this.max - this.active;
    for (let i = 0; i < slots && this.queue.length > 0; i++) {
      const next = this.queue.shift();
      if (next) next();
    }
    return this.max;
  }
}

const pool = new Semaphore(INITIAL_WORKERS);

export function setPoolMax(n) {
  return pool.setMax(n);
}

export function getPoolStats() {
  return pool.stats();
}

/**
 * Get or create the shared browser instance
 * @returns {Promise<import('playwright').Browser>}
 */
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1280,960'
      ]
    });
  }
  return browser;
}

/**
 * Resize image buffer using sharp (way faster than opening a second browser context)
 */
async function resizeImage(buffer, targetWidth, format) {
  const pipeline = sharp(buffer).resize({ width: targetWidth, withoutEnlargement: true });
  if (format === 'webp') return pipeline.webp({ quality: 80 }).toBuffer();
  if (format === 'png') return pipeline.png({ compressionLevel: 6 }).toBuffer();
  return pipeline.jpeg({ quality: 82 }).toBuffer();
}

/**
 * Capture a screenshot of a webpage (wrapped in worker pool)
 */
export async function capture(url, options = {}) {
  await pool.acquire();
  try {
    return await captureInternal(url, options);
  } finally {
    pool.release();
  }
}

async function captureInternal(url, options = {}) {
  const {
    width = DEFAULT_VIEWPORT_WIDTH,
    height = DEFAULT_VIEWPORT_HEIGHT,
    thumbWidth = DEFAULT_THUMB_WIDTH,
    format = 'webp',
    timeout = DEFAULT_TIMEOUT
  } = options;

  const T0 = Date.now();
  const timings = [];
  const mark = (label) => {
    timings.push(`${label}=${Date.now() - T0}`);
  };

  const br = await getBrowser();
  const context = await br.newContext({
    viewport: { width, height },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  const headers = {
    'X-Login-Wall': 'false',
    'X-Blank-Page': 'false',
    'X-Bot-Blocked': 'false'
  };

  // === RESOURCE BLOCKING — the BIGGEST perf win ===
  // Block tracking, ads, videos, heavy media. Keeps fonts/stylesheets/images
  // for correct visual rendering. Drops 50-70% of network traffic on shop sites.
  const BLOCKED_DOMAINS = [
    'google-analytics.com', 'googletagmanager.com', 'googlesyndication.com',
    'googleadservices.com', 'doubleclick.net', 'googletagservices.com',
    'facebook.net', 'facebook.com/tr', 'connect.facebook.net',
    'hotjar.com', 'optimizely.com', 'segment.com', 'segment.io',
    'mixpanel.com', 'amplitude.com', 'intercom.io', 'intercomcdn.com',
    'criteo.com', 'criteo.net', 'outbrain.com', 'taboola.com',
    'adnxs.com', 'adsrvr.org', 'adsafeprotected.com', 'moatads.com',
    'scorecardresearch.com', 'quantserve.com', 'chartbeat.com',
    'bugsnag.com', 'newrelic.com', 'datadoghq.com', 'sentry.io',
    'tiktok.com', 'bing.com/action', 'linkedin.com/px',
    'yandex.ru/metrika', 'yandex.ru/clck',
    'pinterest.com/ct', 'snap.licdn.com', 'reddit.com/api',
    'cdn.cookielaw.org', 'privacy-mgmt.com'
  ];
  await page.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    const u = req.url();
    // Block heavy media types outright
    if (type === 'media' || type === 'websocket') {
      return route.abort();
    }
    // Block tracking/ad domains for scripts, XHR, beacons, and images
    if (type === 'script' || type === 'xhr' || type === 'fetch' || type === 'ping' || type === 'image') {
      for (const d of BLOCKED_DOMAINS) {
        if (u.includes(d)) return route.abort();
      }
    }
    return route.continue();
  });

  // Track main frame response for status code detection
  let mainResponse = null;
  page.on('response', (response) => {
    try {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        mainResponse = response;
      }
    } catch { /* ignore detached frames */ }
  });

  try {
    // Fast commit, then RACE domcontentloaded vs. content-sufficient check.
    // Whichever fires first wins — we proceed as soon as we have enough to screenshot.
    await page.goto(url, {
      waitUntil: 'commit',
      timeout: timeout
    });
    mark('goto:commit');
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 7000 }).catch(() => {}),
      page.waitForFunction(() => {
        const body = document.body;
        if (!body) return false;
        const textLength = body.innerText.trim().length;
        const imgCount = document.querySelectorAll('img[src]').length;
        return textLength > 300 || imgCount > 3;
      }, { timeout: 7000 }).catch(() => {})
    ]);
    mark('race:done');

    // Scroll trigger (reduced delays for speed)
    await page.evaluate(async () => {
      window.scrollTo(0, document.body.scrollHeight / 3);
      await new Promise(r => setTimeout(r, 60));
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 60));
    });
    mark('scroll:done');

    // === EARLY BOT DETECTION — skip expensive consent work if blocked ===
    const httpStatus = mainResponse ? mainResponse.status() : 200;
    const isHttpError = [403, 429, 503].includes(httpStatus);

    const checkBlock = () => page.evaluate(() => {
      // Use textContent instead of innerText — doesn't trigger layout = WAY faster
      const text = (document.body?.textContent || '').toLowerCase().slice(0, 3000);
      const title = (document.title || '').toLowerCase();
      const h1 = (document.querySelector('h1')?.textContent || '').toLowerCase().trim();
      const fullText = title + ' ' + text;
      const strongBlockIndicators = [
        'access denied', 'zugriff verweigert', 'access to this page has been denied',
        'you have been blocked', 'sie wurden blockiert', 'blocked by',
        'cloudflare ray id', 'attention required | cloudflare',
        'checking your browser before accessing', 'please verify you are a human',
        'bitte bestätigen sie, dass sie ein mensch sind', 'captcha',
        'prüfe ihren browser', 'perimeterx', 'are you a robot', 'pardon our interruption'
      ];
      const textHit = strongBlockIndicators.some(ind => fullText.includes(ind));
      const h1Hit = ['access denied', 'forbidden', 'error'].includes(h1);
      return textHit || h1Hit;
    }).catch(() => false);

    let blocked = isHttpError || await checkBlock();
    mark('block-check-1:done');

    // If not blocked yet, give slow block-pages a chance (MediaMarkt, OBI-style)
    if (!blocked) {
      await page.waitForTimeout(400);
      mark('wait-retry:done');
      blocked = await checkBlock();
      mark('block-check-2:done');
    }

    if (blocked) {
      mark('early-block:detected');
      headers['X-Bot-Blocked'] = 'true';
      // Skip consent, CSS, screenshot — routes.js returns 1x1 pixel anyway
      headers['X-Timings'] = timings.join(',');
      return {
        buffer: Buffer.from([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00]),
        format: 'webp',
        fromCache: false,
        headers
      };
    }

    // === CONSENT: Combined Phase 1 + 2 in single evaluate (saves 30+ IPC roundtrips) ===
    mark('consent-start');
    try {
      await page.evaluate(() => {
        const selectors = [
          '[data-testid="uc-accept-all-button"]', '#uc-btn-accept-banner',
          'button.uc-list-button--accept', '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
          '#CybotCookiebotDialogBodyButtonAccept', '#onetrust-accept-btn-handler',
          '.onetrust-close-btn-handler', '.cmpboxbtn.cmpboxbtnyes', 'button.cmpboxbtnyes',
          '#qc-cmp2-ui button[mode="primary"]', '.cc-btn.cc-allow', '.cc-compliance .cc-btn',
          '.klaro .cm-btn-accept', '.klaro .cm-btn-accept-all', '#CookieBoxSaveButton',
          'a._brlbs-btn-cookie-allow', '#didomi-notice-agree-button', 'button[id*="accept-all"]',
          'button[class*="accept-all"]', '[id*="cookie"] button[id*="accept"]',
          '[class*="cookie"] button[class*="accept"]', '[class*="consent"] button[class*="accept"]',
        ];
        for (const s of selectors) {
          const btn = document.querySelector(s);
          if (btn && btn.offsetParent !== null) { btn.click(); return 'selector'; }
        }
        // Text fallback — limit to first 100 buttons to avoid full DOM scan
        const texts = ['Alle akzeptieren', 'Akzeptieren', 'Accept all', 'Accept All', 'Zustimmen', 'Einverstanden', 'Alle Cookies akzeptieren'];
        const buttons = Array.from(document.querySelectorAll('button, a[role="button"]')).slice(0, 100);
        for (const btn of buttons) {
          const t = (btn.textContent || '').trim();
          if (texts.some(x => t === x || t.startsWith(x))) { btn.click(); return 'text'; }
        }
        return null;
      });
    } catch { /* ignore */ }
    mark('consent-click:done');
    await page.waitForTimeout(150);
    mark('consent-wait:done');

    // === CSS nuke (fast - just addStyleTag, skip expensive getComputedStyle loop) ===
    try {
      await page.addStyleTag({ content: `
        [class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i],
        [class*="gdpr" i], [id*="gdpr" i], .cc-window, .cc-banner, #qc-cmp2-container,
        .cmpwrapper, .sp-message-container, .didomi-popup-container, .truste_popframe,
        .klaro, [id*="sp_message"], #usercentrics-root, .uc-banner, [class*="Sourcepoint"]
        { display: none !important; }
        body, html { overflow: auto !important; position: static !important; }
      `});
    } catch { /* ignore */ }
    
    const blockInfo = await page.evaluate(() => {
      const text = (document.body?.innerText || '').toLowerCase();
      const title = (document.title || '').toLowerCase();
      const fullText = (title + ' ' + text).slice(0, 2000);
      const textLen = (document.body?.innerText || '').trim().length;
      const html = document.documentElement?.innerHTML?.toLowerCase() || '';
      
      // Get h1 content for access denied detection
      const h1Element = document.querySelector('h1');
      const h1Text = (h1Element?.innerText || '').toLowerCase().trim();

      // Strong indicators — trigger regardless of page length
      const strongBlockIndicators = [
        'access denied',
        'zugriff verweigert',
        'access to this page has been denied',
        'you have been blocked',
        'sie wurden blockiert',
        'blocked by',
        'cloudflare ray id',
        'attention required | cloudflare',
        'checking your browser before accessing',
        'please verify you are a human',
        'bitte bestätigen sie, dass sie ein mensch sind',
        'captcha',
        'prüfe ihren browser',
        'perimeterx',
        'are you a robot',
        'pardon our interruption'
      ];
      const strongHit = strongBlockIndicators.some(ind => fullText.includes(ind));

      const isShortPage = textLen < 500;

      // Weaker indicators — only count if page is short
      const weakBlockIndicators = ['forbidden', '403 ', '429 ', 'rate limit'];
      const weakHit = isShortPage && weakBlockIndicators.some(ind => fullText.includes(ind));
      
      // Extended challenge keywords in HTML/scripts
      const challengeKeywords = ['akamai', 'incapsula', 'imperva', 'distil', 'datadome', 'arkose', 'recaptcha'];
      const challengeHit = challengeKeywords.some(kw => html.includes(kw));
      
      // Structure checks
      const hasAccessDeniedH1 = ['access denied', 'forbidden', 'error'].includes(h1Text);
      const isVerySmallPage = textLen < 200;
      const structureHit = hasAccessDeniedH1 || (isVerySmallPage && document.querySelectorAll('img').length === 0);

      return { 
        blocked: strongHit || weakHit || challengeHit || structureHit,
        textLen,
        hasAccessDeniedH1,
        isVerySmallPage
      };
    }).catch(() => ({ blocked: false, textLen: 0 }));
    
    // Combine HTTP status with page detection
    if (isHttpError || blockInfo.blocked) {
      headers['X-Bot-Blocked'] = 'true';
    }

    // === LOGIN WALL DETECTION ===
    const isLoginWall = await page.evaluate(() => {
      const loginIndicators = ['login', 'sign in', 'anmelden', 'log in', 'einloggen'];
      const text = (document.body?.innerText || '').toLowerCase().slice(0, 500);
      const hasLoginForm = document.querySelector('input[type="password"]') !== null;
      const loginTextCount = loginIndicators.filter(t => text.includes(t)).length;
      return hasLoginForm && loginTextCount >= 2;
    }).catch(() => false);

    if (isLoginWall) {
      headers['X-Login-Wall'] = 'true';
    }

    mark('consent+css:done');
    await page.waitForTimeout(120);

    const screenshotBuffer = await page.screenshot({
      type: format === 'jpeg' ? 'jpeg' : 'png',
      fullPage: false
    });

    // === BLANK PAGE DETECTION ===
    const isBlank = await page.evaluate(() => {
      const body = document.body;
      const text = (body?.innerText || '').trim();
      return text.length < 50;
    }).catch(() => false);

    if (isBlank) {
      headers['X-Blank-Page'] = 'true';
    }

    mark('screenshot:done');
    const resizedBuffer = await resizeImage(screenshotBuffer, thumbWidth, format);
    mark('resize:done');
    headers['X-Timings'] = timings.join(',');

    return {
      buffer: resizedBuffer,
      format: format === 'jpeg' ? 'jpeg' : 'png',
      fromCache: false,
      headers
    };

  } catch (error) {
    if (error.name === 'TimeoutError' || error.message?.includes('timeout')) {
      throw new Error('TIMEOUT');
    }
    throw error;
  } finally {
    await context.close();
  }
}

/**
 * Close the browser instance
 */
export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Generate cache key for URL + options
 */
export function generateCacheKey(url, options) {
  const data = JSON.stringify({ url, ...options });
  return createHash('sha256').update(data).digest('hex');
}
