// popup.js

document.addEventListener('DOMContentLoaded', () => {
    const enabledToggle = document.getElementById('enabledToggle');
    const backendStatusIndicator = document.getElementById('backendStatusIndicator');
    const backendStatusText = document.getElementById('backendStatusText');
    const positionSelect = document.getElementById('positionSelect');
    const workersSelect = document.getElementById('workersSelect');
    const popupHint = document.getElementById('popupHint');
    const openOptionsBtn = document.getElementById('openOptions');
    const openDashboardBtn = document.getElementById('openDashboard');

    let currentBackendUrl = '';

    // Load current state
    chrome.storage.sync.get(['enabled', 'backendUrl', 'position'], async (items) => {
        enabledToggle.checked = items.enabled !== false;
        positionSelect.value = items.position || 'left';
        currentBackendUrl = items.backendUrl || '';
        updateDashboardBtn();
        await checkHealth(currentBackendUrl);
        await loadWorkers(currentBackendUrl);
    });

    // Toggle enabled state
    enabledToggle.addEventListener('change', () => {
        chrome.storage.sync.set({ enabled: enabledToggle.checked });
    });

    // Quick position change
    positionSelect.addEventListener('change', () => {
        chrome.storage.sync.set({ position: positionSelect.value });
        popupHint.textContent = 'Position saved — reload SearXNG tab if needed';
    });

    // Quick worker change
    workersSelect.addEventListener('change', async () => {
        if (!currentBackendUrl) {
            popupHint.textContent = 'Set backend URL first';
            return;
        }
        try {
            const res = await fetch(`${currentBackendUrl}/api/settings`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workers: parseInt(workersSelect.value, 10) })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            popupHint.textContent = `Workers set to ${workersSelect.value}`;
        } catch {
            popupHint.textContent = 'Could not update workers';
        }
    });

    // Open options page
    openOptionsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // Open dashboard (backend WebUI)
    openDashboardBtn.addEventListener('click', () => {
        if (currentBackendUrl) {
            chrome.tabs.create({ url: currentBackendUrl });
        }
    });

    function updateDashboardBtn() {
        openDashboardBtn.disabled = !currentBackendUrl;
        openDashboardBtn.title = currentBackendUrl
            ? `Open ${currentBackendUrl}`
            : 'Set a backend URL first';
    }

    // Check backend health
    async function checkHealth(url) {
        if (!url) {
            updateStatus('gray', 'Not Configured');
            return false;
        }
        try {
            const response = await fetch(`${url}/health`, { mode: 'cors' });
            if (response.ok) {
                updateStatus('green', 'Online');
                return true;
            } else {
                updateStatus('red', 'Offline');
                return false;
            }
        } catch (error) {
            updateStatus('red', 'Unreachable');
            return false;
        }
    }

    async function loadWorkers(url) {
        workersSelect.disabled = true;
        if (!url) return;
        try {
            const res = await fetch(`${url}/api/stats`, { mode: 'cors' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const workers = String(data?.pool?.max || 6);
            workersSelect.value = workers;
            workersSelect.disabled = false;
        } catch {
            popupHint.textContent = 'Workers unavailable — backend offline?';
        }
    }
    
    function updateStatus(color, text) {
        backendStatusIndicator.style.backgroundColor = color;
        backendStatusText.textContent = text;
    }

    // Listen for changes to update the popup UI in real-time
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'sync') {
            if (changes.enabled) {
                enabledToggle.checked = changes.enabled.newValue;
            }
            if (changes.position) {
                positionSelect.value = changes.position.newValue || 'left';
            }
            if (changes.backendUrl) {
                currentBackendUrl = changes.backendUrl.newValue || '';
                updateDashboardBtn();
                checkHealth(currentBackendUrl);
                loadWorkers(currentBackendUrl);
            }
        }
    });
});
