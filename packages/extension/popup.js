// popup.js

document.addEventListener('DOMContentLoaded', () => {
    const enabledToggle = document.getElementById('enabledToggle');
    const backendStatusIndicator = document.getElementById('backendStatusIndicator');
    const backendStatusText = document.getElementById('backendStatusText');
    const positionText = document.getElementById('positionText');
    const openOptionsBtn = document.getElementById('openOptions');
    const openDashboardBtn = document.getElementById('openDashboard');

    let currentBackendUrl = '';

    // Load current state
    chrome.storage.sync.get(['enabled', 'backendUrl', 'position'], (items) => {
        enabledToggle.checked = items.enabled !== false;
        positionText.textContent = items.position ? items.position.charAt(0).toUpperCase() + items.position.slice(1) : 'N/A';
        currentBackendUrl = items.backendUrl || '';
        updateDashboardBtn();
        checkHealth(currentBackendUrl);
    });

    // Toggle enabled state
    enabledToggle.addEventListener('change', () => {
        chrome.storage.sync.set({ enabled: enabledToggle.checked });
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
            return;
        }
        try {
            const response = await fetch(`${url}/health`, { mode: 'cors' });
            if (response.ok) {
                updateStatus('green', 'Online');
            } else {
                updateStatus('red', 'Offline');
            }
        } catch (error) {
            updateStatus('red', 'Unreachable');
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
                const pos = changes.position.newValue;
                positionText.textContent = pos.charAt(0).toUpperCase() + pos.slice(1);
            }
            if (changes.backendUrl) {
                currentBackendUrl = changes.backendUrl.newValue || '';
                updateDashboardBtn();
                checkHealth(currentBackendUrl);
            }
        }
    });
});
