// background.js

// Safe defaults only. URLs start empty so new users are forced to configure them
// explicitly — we don't want to leak someone else's internal IP as a default.
const DEFAULTS = {
  enabled: true,
  position: 'left',
  thumbSize: 120,
  backendUrl: '',
  searxngUrls: [],
};

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set(DEFAULTS, () => {
      // New install → open options so user can configure backend + SearXNG URLs.
      try {
        if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
      } catch {}
    });
  } else if (details.reason === 'update') {
    // On update, backfill any missing keys with defaults.
    chrome.storage.sync.get(null, (settings) => {
      const updatedSettings = { ...settings };
      let needsUpdate = false;
      for (const key in DEFAULTS) {
        if (!Object.prototype.hasOwnProperty.call(settings, key)) {
          updatedSettings[key] = DEFAULTS[key];
          needsUpdate = true;
        }
      }
      if (needsUpdate) {
        chrome.storage.sync.set(updatedSettings);
      }
    });
  }
});
