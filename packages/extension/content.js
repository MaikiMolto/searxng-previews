// content.js

(function () {
  'use strict';

  let settings = {};
  let intersectionObserver = null;
  let mutationObserver = null;
  let retryTimeouts = [];
  const APPLIED_ATTR = 'data-srp-applied';

  function cleanup() {
    document.querySelectorAll(`[${APPLIED_ATTR}]`).forEach(el => {
      const thumb = el.querySelector('.srp-thumb');
      if (thumb) {
        thumb.remove();
      }
      el.removeAttribute(APPLIED_ATTR);
    });
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    retryTimeouts.forEach(clearTimeout);
    retryTimeouts = [];
  }

  function getResultUrl(resultElement) {
    const link = resultElement.querySelector('h3 a[href]') || resultElement.querySelector('a.url_header[href]');
    return link ? link.href : null;
  }

  async function loadThumbnail(img) {
    const backendUrl = img.dataset.backendUrl;

    function showFavicon() {
      const placeholder = document.createElement('div');
      placeholder.className = `srp-thumb srp-thumb-${settings.position} srp-thumb-placeholder`;
      placeholder.style.width = img.style.width;
      placeholder.style.height = img.style.height;
      placeholder.innerHTML = `
        <div class="srp-thumb-ph-icon">🛡️</div>
        <div class="srp-thumb-ph-title">No Preview</div>
        <div class="srp-thumb-ph-hint">Bot protection / timeout / blocked</div>
      `;
      img.replaceWith(placeholder);
    }

    const safetyTimeout = setTimeout(() => {
      if (img.style.opacity === '0') {
        showFavicon();
      }
    }, 45000);

    try {
      const response = await fetch(backendUrl);
      const isBotBlocked = response.headers.get('X-Bot-Blocked') === 'true';
      const isLoginWall = response.headers.get('X-Login-Wall') === 'true';
      const isBlank = response.headers.get('X-Blank-Page') === 'true';

      if (!response.ok || isBotBlocked || isLoginWall || isBlank) {
        clearTimeout(safetyTimeout);
        showFavicon();
        return;
      }

      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      // Set handlers BEFORE src to catch sync loads
      img.onload = () => {
        clearTimeout(safetyTimeout);
        img.style.opacity = '1';
      };
      img.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        clearTimeout(safetyTimeout);
        showFavicon();
      };
      img.src = blobUrl;
    } catch (error) {
      // Backend unreachable — favicon only (self-hosted, no third-party fallback)
      clearTimeout(safetyTimeout);
      showFavicon();
    }
  }

  // Cleanup blob URLs when thumbnails are removed from DOM
  const blobCleanupObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        if (node.nodeName === 'IMG' && node.src && node.src.startsWith('blob:')) {
          URL.revokeObjectURL(node.src);
        }
      }
    }
  });
  blobCleanupObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });


  function applyThumbnail(resultElement) {
    if (!settings.enabled || settings.position === 'off' || resultElement.hasAttribute(APPLIED_ATTR)) {
      return;
    }

    const resultUrl = getResultUrl(resultElement);
    if (!resultUrl) {
      resultElement.setAttribute(APPLIED_ATTR, 'no-url');
      return;
    }
    // Replace SearXNG-native thumbnails with our own preview.
    // (Previously skipped — now we remove the SearXNG image so our screenshot wins.)
    const existingImgs = resultElement.querySelectorAll('img:not(.srp-thumb)');
    for (const eImg of existingImgs) {
      const src = eImg.getAttribute('src') || '';
      const isSearxngThumb = src.includes('/image_proxy') || src.includes('image_proxy');
      const isRealImage = src && !src.startsWith('data:image/svg') && !src.includes('favicon') && (eImg.width > 40 || eImg.naturalWidth > 40 || isSearxngThumb);
      if (isSearxngThumb || isRealImage) {
        eImg.remove();
      }
    }

    resultElement.setAttribute(APPLIED_ATTR, 'true');

    const domain = new URL(resultUrl).hostname;
    const thumbSize = settings.thumbSize || 120;
    const pixelWidth = Math.min(480, thumbSize * 2);

    const img = document.createElement('img');
    img.className = `srp-thumb srp-thumb-${settings.position}`;
    img.style.width = `${thumbSize}px`;
    img.style.height = `${Math.round(thumbSize * 0.75)}px`;
    img.decoding = 'async';
    img.style.opacity = '0';
    img.style.transition = 'opacity 0.3s ease-in-out';

    img.dataset.backendUrl = `${settings.backendUrl}/preview?url=${encodeURIComponent(resultUrl)}&width=${pixelWidth}&format=webp`;

    const container = resultElement.querySelector('h3') || resultElement.firstChild;

    if (settings.position === 'left' && container) {
      container.parentNode.insertBefore(img, container);
    } else if (settings.position === 'right' && container) {
      container.parentNode.appendChild(img);
    } else if (settings.position === 'hover' && container) {
      container.parentNode.appendChild(img);
    }

    // Start loading immediately — all results fetch in parallel.
    // Browser auto-caps at ~6 concurrent connections per host;
    // backend Semaphore caps at CONCURRENCY (default 5).
    loadThumbnail(img);
  }

  function createIntersectionObserver() {
    // Kept as no-op for backwards compat; eager loading above replaces this.
    intersectionObserver = null;
  }

  function run() {
    if (!settings.enabled || settings.position === 'off') {
      cleanup();
      return;
    }

    // Tolerate string (legacy) or array
    const urls = Array.isArray(settings.searxngUrls)
      ? settings.searxngUrls
      : (typeof settings.searxngUrls === 'string' ? settings.searxngUrls.split('\n').map(s => s.trim()).filter(Boolean) : []);
    const isSearxngPage = urls.some(url => {
      try {
        return window.location.origin === new URL(url).origin;
      } catch {
        return false;
      }
    });
    if (!isSearxngPage) return;

    // Mixed-content detection: HTTPS page + HTTP backend = browser will block requests
    const pageIsSecure = window.location.protocol === 'https:';
    const backendIsInsecure = settings.backendUrl && settings.backendUrl.startsWith('http://');
    if (pageIsSecure && backendIsInsecure) {
      console.warn(
        '[SearXNG Previews] ⚠️ Mixed Content detected: This page uses HTTPS but the backend URL is HTTP (%s). ' +
        'Browsers will block these requests. Please either:\n' +
        '  1. Put the preview service behind a reverse proxy with HTTPS (recommended)\n' +
        '  2. Access SearXNG via HTTP instead of HTTPS\n' +
        'See extension options for a reverse-proxy setup guide.',
        settings.backendUrl
      );
      // Inject a small, dismissible warning banner at the top of the page
      if (!document.getElementById('srp-mixed-content-warning')) {
        const banner = document.createElement('div');
        banner.id = 'srp-mixed-content-warning';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#b91c1c;color:#fff;' +
          'padding:8px 16px;font:13px/1.4 -apple-system,sans-serif;display:flex;align-items:center;gap:8px;';
        banner.innerHTML = '<span>⚠️ <b>SearXNG Previews:</b> Mixed Content — thumbnails may not load. ' +
          'Your SearXNG uses HTTPS but the backend is HTTP. ' +
          '<a href="#" style="color:#fca5a5;text-decoration:underline">Open extension settings</a> for help.</span>' +
          '<button style="margin-left:auto;background:none;border:none;color:#fff;font-size:18px;cursor:pointer;padding:0 4px">✕</button>';
        banner.querySelector('button').addEventListener('click', () => banner.remove());
        banner.querySelector('a').addEventListener('click', (e) => {
          e.preventDefault();
          if (chrome.runtime?.openOptionsPage) chrome.runtime.openOptionsPage();
        });
        (document.body || document.documentElement).prepend(banner);
      }
    }

    createIntersectionObserver();

    const resultsContainer = document.querySelector('#main_results, #results');
    if (!resultsContainer) {
      startBodyObserver();
      return;
    }

    const results = resultsContainer.querySelectorAll('article.result');
    if (results.length === 0) {
      startResultsObserver(resultsContainer);
      return;
    }

    results.forEach(el => applyThumbnail(el));
    startResultsObserver(resultsContainer);
  }

  function startBodyObserver() {
    if (mutationObserver) mutationObserver.disconnect();
    const bodyObserver = new MutationObserver(() => {
      const container = document.querySelector('#main_results, #results');
      if (container) {
        bodyObserver.disconnect();
        run();
      }
    });
    mutationObserver = bodyObserver;
    bodyObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function startResultsObserver(resultsContainer) {
    if (mutationObserver) mutationObserver.disconnect();
    mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1 && (node.matches('article.result') || node.querySelector('article.result'))) {
            const results = node.matches('article.result') ? [node] : node.querySelectorAll('article.result');
            results.forEach(applyThumbnail);
          }
        });
      });
    });
    mutationObserver.observe(resultsContainer, {
      childList: true,
      subtree: true
    });
  }

  function scheduleRetries() {
    const checkAndRun = () => {
      const results = document.querySelectorAll('article.result:not([data-srp-applied])');
      if (results.length > 0) {
        run();
      }
    };
    retryTimeouts.push(setTimeout(checkAndRun, 1000));
    retryTimeouts.push(setTimeout(checkAndRun, 3000));
  }

  function executeRun() {
    try {
      run();
      scheduleRetries();
    } catch (err) {
      // Silently fail in production
    }
  }

  function init() {
    chrome.storage.sync.get(null, (loadedSettings) => {
      settings = loadedSettings;
      executeRun();
    });
  }

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync') {
      cleanup();
      init();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();