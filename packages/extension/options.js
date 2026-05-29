// options.js

document.addEventListener('DOMContentLoaded', () => {
    const saveButton = document.getElementById('save');
    const statusEl = document.getElementById('status');
    const enabledToggle = document.getElementById('enabled');
    const positionRadios = document.querySelectorAll('input[name="position"]');
    const privacyRadios = document.querySelectorAll('input[name="privacyMode"]');
    const thumbSizeInput = document.getElementById('thumbSize');
    const thumbSizeValue = document.getElementById('thumbSizeValue');
    const backendUrlInput = document.getElementById('backendUrl');
    const searxngUrlsInput = document.getElementById('searxngUrls');
    const healthStatus = document.getElementById('healthStatus');
    const checkHealthBtn = document.getElementById('checkHealth');

    // Load settings — empty defaults so new users see placeholders, not someone else's IP.
    chrome.storage.sync.get({
        enabled: true,
        position: 'left',
        thumbSize: 120,
        privacyMode: 'strict',
        backendUrl: '',
        searxngUrls: []
    }, (items) => {
        enabledToggle.checked = items.enabled;
        positionRadios.forEach(r => { r.checked = (r.value === items.position); });
        // Migrate old 'standard' value → 'favicons' (renamed for clarity)
        const privacyValue = items.privacyMode === 'standard' ? 'favicons'
            : (items.privacyMode === 'favicons' ? 'favicons' : 'strict');
        privacyRadios.forEach(r => { r.checked = (r.value === privacyValue); });
        thumbSizeInput.value = items.thumbSize;
        thumbSizeValue.textContent = items.thumbSize;
        backendUrlInput.value = items.backendUrl || '';
        // Array → newline-separated textarea
        const urls = Array.isArray(items.searxngUrls)
            ? items.searxngUrls
            : (typeof items.searxngUrls === 'string' && items.searxngUrls.trim() ? [items.searxngUrls] : []);
        searxngUrlsInput.value = urls.join('\n');
    });

    // Live update range display
    thumbSizeInput.addEventListener('input', () => {
        thumbSizeValue.textContent = thumbSizeInput.value;
    });

    // URL validation helper
    const isValidUrl = (str) => {
        try {
            const u = new URL(str);
            return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
            return false;
        }
    };

    // Dashboard button
    const openDashboardBtn = document.getElementById('openDashboard');
    const updateDashboardBtn = () => {
        const url = backendUrlInput.value.trim();
        if (openDashboardBtn) {
            openDashboardBtn.disabled = !url;
            openDashboardBtn.style.opacity = url ? '1' : '0.4';
            openDashboardBtn.style.cursor = url ? 'pointer' : 'not-allowed';
            openDashboardBtn.title = url ? `Open ${url}` : 'Set a backend URL first';
        }
    };
    if (openDashboardBtn) {
        openDashboardBtn.addEventListener('click', () => {
            const url = backendUrlInput.value.trim().replace(/\/+$/, '');
            if (url) window.open(url, '_blank');
        });
    }
    backendUrlInput.addEventListener('input', updateDashboardBtn);
    // Initial state
    updateDashboardBtn();

    // Health check button
    if (checkHealthBtn) {
        checkHealthBtn.addEventListener('click', async () => {
            const url = backendUrlInput.value.trim().replace(/\/+$/, '');
            healthStatus.textContent = '';
            if (!url) {
                statusEl.style.color = 'var(--error-color)';
                statusEl.textContent = '⚠ Please enter a Backend URL first.';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
                return;
            }
            if (!isValidUrl(url)) {
                statusEl.style.color = 'var(--error-color)';
                statusEl.textContent = '⚠ Not a valid http(s):// URL.';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
                return;
            }
            // Check for mixed-content risk: any HTTPS SearXNG URL + HTTP backend
            const searxngLines = searxngUrlsInput.value.split('\n').map(s => s.trim()).filter(Boolean);
            const backendIsHttp = url.startsWith('http://');
            const hasHttpsSearxng = searxngLines.some(u => u.startsWith('https://'));
            let mixedContentWarning = false;
            if (backendIsHttp && hasHttpsSearxng) {
                mixedContentWarning = true;
            }
            healthStatus.textContent = '⏳';
            try {
                const res = await fetch(`${url}/health`, { cache: 'no-store' });
                if (res.ok) {
                    healthStatus.textContent = mixedContentWarning ? '⚠️' : '✅';
                    statusEl.style.color = mixedContentWarning ? 'var(--warning-color)' : 'var(--success-color)';
                    statusEl.textContent = mixedContentWarning
                        ? '✅ Backend reachable — ⚠️ but Mixed Content: HTTPS SearXNG + HTTP backend. Browsers may block thumbnails. See reverse proxy guide below.'
                        : '✅ Backend is reachable.';
                    if (!mixedContentWarning) setTimeout(() => { statusEl.textContent = ''; }, 4000);
                } else {
                    healthStatus.textContent = '❌';
                    statusEl.style.color = 'var(--error-color)';
                    statusEl.textContent = `❌ Backend responded with status ${res.status}.`;
                    setTimeout(() => { statusEl.textContent = ''; }, 4000);
                }
            } catch (err) {
                healthStatus.textContent = '❌';
                statusEl.style.color = 'var(--error-color)';
                statusEl.textContent = '❌ Could not reach backend. CORS, mixed-content, or wrong URL?';
                setTimeout(() => { statusEl.textContent = ''; }, 5000);
            }
        });
    }

    // Save settings on click
    saveButton.addEventListener('click', (e) => {
        e.preventDefault();
        const selectedPosition = [...positionRadios].find(r => r.checked)?.value || 'left';
        const backendUrl = backendUrlInput.value.trim().replace(/\/+$/, '');
        const urls = searxngUrlsInput.value
            .split('\n')
            .map(s => s.trim().replace(/\/+$/, ''))
            .filter(Boolean);

        // Validate: if extension is enabled, we need at least backend + one URL.
        if (enabledToggle.checked) {
            if (!backendUrl || !isValidUrl(backendUrl)) {
                statusEl.style.color = 'var(--error-color)';
                statusEl.textContent = '⚠ Please enter a valid Backend URL (http:// or https://).';
                return;
            }
            if (urls.length === 0) {
                statusEl.style.color = 'var(--error-color)';
                statusEl.textContent = '⚠ Please add at least one SearXNG instance URL.';
                return;
            }
            const badUrl = urls.find(u => !isValidUrl(u));
            if (badUrl) {
                statusEl.style.color = 'var(--error-color)';
                statusEl.textContent = `⚠ Invalid URL: "${badUrl}" — must start with http:// or https://.`;
                return;
            }
        }

        const selectedPrivacy = [...privacyRadios].find(r => r.checked)?.value || 'strict';
        chrome.storage.sync.set({
            enabled: enabledToggle.checked,
            position: selectedPosition,
            thumbSize: parseInt(thumbSizeInput.value, 10),
            privacyMode: selectedPrivacy,
            backendUrl,
            searxngUrls: urls
        }, () => {
            statusEl.style.color = 'var(--success-color)';
            statusEl.textContent = '✅ Settings saved. Reload your SearXNG tabs to apply.';
            setTimeout(() => { statusEl.textContent = ''; }, 4000);
        });
    });
});
