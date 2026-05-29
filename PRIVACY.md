# Privacy Policy — SearXNG Result Previews

_Last updated: 2026-05-29_

## Summary

This browser extension and its companion preview backend do **not** collect, transmit, or share any personally identifiable information with the extension author, with any third party, or with any centralized service. There is no analytics, no telemetry, and no tracking.

## What the extension does

**SearXNG Result Previews** adds thumbnail previews next to the search results shown on your SearXNG instance. To generate those thumbnails it:

1. Reads the search-result URLs already visible on the SearXNG page you are viewing.
2. Sends each URL to a **preview backend** of your choice (configured by you in the extension Options page).
3. Receives a small image (WebP/PNG) and displays it next to the result.

The backend you point the extension at can be:
- The same machine that runs your SearXNG (recommended, fully self-hosted), or
- Any other instance you trust.

The **author of this extension does not operate any default or fallback backend**. If you do not configure a backend URL the extension simply shows nothing.

## Data the extension stores locally

The extension stores the following in your browser's local extension storage (`chrome.storage.local`):

- Your configured backend URL(s)
- Your UI preferences (thumbnail position, size, theme, language, privacy mode)
- A list of SearXNG instance URLs you have whitelisted for the extension to run on

This data never leaves your browser. Clearing the extension's storage (or uninstalling the extension) removes it completely.

## Data sent to the backend

When the extension requests a preview, the backend receives:

- The **target URL** for which a thumbnail is requested
- Standard HTTP request metadata (your local IP towards the backend, request headers your browser would normally send)

The backend does **not** receive your search query, your SearXNG settings, your browsing history, cookies, or any account information.

If you self-host the backend (the supported and recommended setup), the URLs only travel between your browser and your own server, on your own network.

## Data the backend stores

The reference backend implementation stores screenshots in a local file cache on disk so that repeated requests for the same URL are fast and do not re-hit the target site. The cache has a configurable TTL (default 24 hours) and a configurable maximum size (default 500 MB). No user identifiers are stored next to the cache entries.

## Third parties

When the backend captures a screenshot it performs a normal HTTP `GET` request against the target URL using a headless Chromium browser. From the target site's perspective this looks like an ordinary page visit originating from the backend's IP address. The extension never causes your browser to make additional requests to third parties beyond what the SearXNG page itself would already request.

No analytics, advertising, or third-party tracking SDKs are bundled with the extension or with the backend.

## Permissions justification

The extension declares the following permissions in its manifest:

- **`storage`** — to remember your settings (backend URL, theme, etc.) across browser sessions.
- **`activeTab`** — to inject the preview UI into the page when the user clicks the extension icon, without requiring broad always-on host access.
- **`host_permissions: <all_urls>`** — the extension needs to be able to run on any URL the user uses as a SearXNG instance, because SearXNG can be self-hosted on any domain. The extension itself **only activates on pages that look like a SearXNG results page** (detected by DOM structure); on all other pages it stays inactive.

## Contact

Questions, security reports, or removal requests:
https://github.com/MaikiMolto/searxng-previews/issues

## Changes to this policy

This document lives in the project repository. The full edit history is publicly visible at:
https://github.com/MaikiMolto/searxng-previews/commits/main/PRIVACY.md
