/**
 * network-tap.js — content-script-side bridge for the page-context tap.
 *
 * Runs in the content-script isolated world. Two jobs:
 *   1. Inject network-tap-page.js into the PAGE context as a <script>
 *      tag so its fetch/WebSocket wrappers can observe TikTok's actual
 *      network calls (the page's `window` is different from ours).
 *   2. Listen for window.postMessage events from the page wrapper and
 *      forward them to the service worker via chrome.runtime.sendMessage.
 *
 * Risk profile: ZERO new TikTok-facing requests. Pure observer.
 *
 * Loaded BEFORE live-console.js in manifest.json content_scripts so the
 * tap installs at document_start, before TikTok's bundle initializes.
 */
(function () {
  'use strict';

  const TAG = 'lp_net_tap';

  // ─── 1. Inject the page-context script ──────────────────────────
  // Use chrome.runtime.getURL so the path resolves correctly inside
  // the extension package. The script removes itself from the DOM
  // after loading to keep the page clean.
  function injectPageScript() {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('lib/network-tap-page.js');
    s.async = false;  // execute as soon as loaded, blocks parser briefly
    s.onload = function () { this.remove(); };
    s.onerror = function () {
      console.warn('[LivePilot network-tap] failed to inject page script');
      this.remove();
    };
    // Append to documentElement (works at document_start before <head> exists)
    (document.head || document.documentElement).appendChild(s);
  }
  injectPageScript();

  // ─── 2. Bridge page → service worker ────────────────────────────
  // The page-context tap uses postMessage (only IPC available across
  // worlds). Our content script catches it and re-forwards via the
  // chrome.runtime.sendMessage channel.
  let extensionContextValid = true;
  let captureCount = 0;
  const STATS_REPORT_EVERY = 50;  // log progress every N captures

  window.addEventListener('message', (event) => {
    if (!extensionContextValid) return;
    // Reject anything that didn't come from this window OR doesn't have our tag
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== TAG) return;

    captureCount++;

    chrome.runtime.sendMessage({
      source: 'live_console',          // route through existing live_console handler dispatch
      type: 'network_capture',
      payload: {
        kind: msg.kind,                // 'fetch' | 'ws_open' | 'ws_recv' | 'ws_close'
        captured_at: msg.captured_at,
        ...msg.payload,
      },
    }).catch((err) => {
      if (err.message?.includes('Extension context invalidated')) {
        extensionContextValid = false;
        console.warn('[LivePilot network-tap] extension context lost — bridge stopping');
      }
    });

    if (captureCount % STATS_REPORT_EVERY === 0) {
      console.info(`[LivePilot network-tap] ${captureCount} payloads bridged`);
    }
  });

  console.info('[LivePilot network-tap] content-script bridge installed');
})();
