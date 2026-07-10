/**
 * Service Worker — message routing hub for LivePilot.
 *
 * Responsibilities:
 * - Route messages between Side Panel ↔ Content Scripts
 * - Manage EventBus, Logger, StorageAdapter
 * - Open Side Panel when extension icon is clicked
 *
 * Per DESIGN.md 3.5: Side Panel and Content Scripts never talk directly.
 * Everything goes through this service worker.
 */

import { EventBus } from '../lib/event-bus.js';
import { StorageAdapter, DEFAULTS } from '../lib/storage-adapter.js';
import { Logger } from '../lib/logger.js';

// ─── Singletons ──────────────────────────────────────────────────
const eventBus = new EventBus();
const logger = new Logger(eventBus);

// ─── LivePilot v1 Ingest (extension → inventory_system stub) ─────
// LAN-only ingest of chat events for the spike. URL is overridable
// via chrome.storage key `livepilot_v1_base` (set from Settings tab).
// Default targets the inventory_system dev port (27151) per .ports.md.
const LIVEPILOT_V1_DEFAULT_BASE = 'http://localhost:27151/api/livepilot/v1';
let livepilotV1Base = LIVEPILOT_V1_DEFAULT_BASE;
let liveSessionId = null;          // integer session_id returned by POST /sessions
let livePilotV1Ready = false;      // true once we've successfully opened a v1 session

// Hydrate v1 base from storage on cold start. Storage may be missing
// — that's fine, we keep the default.
StorageAdapter.get('livepilot_v1_base').then((v) => {
  if (typeof v === 'string' && v.startsWith('http')) livepilotV1Base = v;
}).catch(() => {});

// ─── Inventory spotlight (auto-pin, BUG-0095) ────────────────────
// The product-dashboard content script polls this through the SW because
// a content-script fetch carries Origin: https://shop.tiktok.com, which
// patina-luxe.com CORS rejects; the SW's chrome-extension:// origin is
// allowed. Overridable via chrome.storage key `inventory_api_base`
// (e.g. http://localhost:3001 for local testing).
const INVENTORY_API_DEFAULT_BASE = 'https://patina-luxe.com';
let inventoryApiBase = INVENTORY_API_DEFAULT_BASE;
StorageAdapter.get('inventory_api_base').then((v) => {
  if (typeof v === 'string' && v.startsWith('http')) inventoryApiBase = v;
}).catch(() => {});

async function openLivePilotV1Session() {
  if (livePilotV1Ready && liveSessionId) return liveSessionId;
  try {
    const resp = await fetch(`${livepilotV1Base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'own',
        title: `LivePilot session ${new Date().toISOString().slice(0, 16)}`,
        started_at: new Date().toISOString(),
      }),
    });
    if (!resp.ok) throw new Error(`POST /sessions returned ${resp.status}`);
    const body = await resp.json();
    liveSessionId = body.data?.session_id ?? body.session_id;  // tolerate envelope variance during spike
    if (!liveSessionId) throw new Error('No session_id in response');
    livePilotV1Ready = true;
    console.info(`[LivePilot SW] v1 session opened: id=${liveSessionId} at ${livepilotV1Base}`);
    return liveSessionId;
  } catch (err) {
    livePilotV1Ready = false;
    // Don't spam — back off to once per 30s on failure (will retry on next chat batch)
    if (!openLivePilotV1Session._lastWarn || Date.now() - openLivePilotV1Session._lastWarn > 30000) {
      console.warn(`[LivePilot SW] v1 session open failed: ${err.message}. Will retry on next batch.`);
      openLivePilotV1Session._lastWarn = Date.now();
    }
    return null;
  }
}

async function postChatEventsV1(events) {
  if (!events?.length) return { posted: 0 };
  const sid = liveSessionId || await openLivePilotV1Session();
  if (!sid) return { posted: 0, error: 'no_session' };
  // Each event needs session_id stamped on it for the v1 contract.
  const stamped = events.map((e) => ({ ...e, session_id: sid }));
  try {
    const resp = await fetch(`${livepilotV1Base}/chat-events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'dom', events: stamped }),
    });
    if (!resp.ok) throw new Error(`POST /chat-events returned ${resp.status}`);
    const body = await resp.json();
    return body.data || body;
  } catch (err) {
    // Mark session as not-ready so next batch re-opens it (dev server restarts etc.)
    livePilotV1Ready = false;
    if (!postChatEventsV1._lastWarn || Date.now() - postChatEventsV1._lastWarn > 30000) {
      console.warn(`[LivePilot SW] v1 chat-events POST failed: ${err.message}. Events held in client memory only.`);
      postChatEventsV1._lastWarn = Date.now();
    }
    return { posted: 0, error: err.message };
  }
}

// ─── Remote State Push (extension → VPS for remote monitoring) ───
const VPS_STATE_URL = 'https://battlecard.patina-luxe.com/api/state';
let remoteState = { pinned: null, intentChat: [], viewers: null, timestamp: 0 };
let remotePushTimer = null;

function updateRemoteState(updates) {
  Object.assign(remoteState, updates, { timestamp: Date.now() });
  // Debounce: push at most every 2 seconds
  if (!remotePushTimer) {
    remotePushTimer = setTimeout(async () => {
      remotePushTimer = null;
      try {
        await fetch(VPS_STATE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(remoteState),
        });
      } catch { /* VPS not reachable — silent fail */ }
    }, 2000);
  }
}

// ─── Battle Card Cache ───────────────────────────────────────────
// Loaded from inventory API before sessions. Indexed by multiple keys.
let battleCards = new Map();  // key → product object
let lastPinnedProduct = null;

function indexBattleCard(p) {
  if (p.screening_code) battleCards.set(p.screening_code, p);
  // Last 5 digits of screening code (operator shorthand)
  if (p.screening_code?.length >= 5) {
    battleCards.set(p.screening_code.slice(-5), p);
  }
  // Brand + model key for fuzzy matching
  const key = `${(p.brand_name || '').toLowerCase()}|${(p.model_name || '').toLowerCase()}`;
  if (key.length > 1) battleCards.set(key, p);
}

function findBattleCard(identifier) {
  if (!identifier) return null;

  // Direct lookup (screening_code, last-5-digits, or brand|model key)
  if (battleCards.has(identifier)) return battleCards.get(identifier);

  // Try SKU pattern match (S followed by 12+ digits)
  const skuMatch = identifier.match(/\b(S\d{12,})\b/);
  if (skuMatch && battleCards.has(skuMatch[1])) return battleCards.get(skuMatch[1]);

  // Try last 5 digits of any number sequence in the identifier
  const numMatch = identifier.match(/(\d{5,})/);
  if (numMatch) {
    const last5 = numMatch[1].slice(-5);
    if (battleCards.has(last5)) return battleCards.get(last5);
  }

  // Fuzzy: search by brand/model name in the identifier
  const lower = identifier.toLowerCase();
  for (const [, card] of battleCards) {
    if (!card.brand_name) continue;
    const brandLower = card.brand_name.toLowerCase();
    const modelLower = (card.model_name || '').toLowerCase();
    // Both brand and model appear in the identifier
    if (lower.includes(brandLower) && modelLower && lower.includes(modelLower)) return card;
  }

  return null;
}

// ─── Known Content Script Tabs ───────────────────────────────────
// Instead of querying tabs by URL (which fails silently when
// host_permissions don't match), we remember tabs that register.
const knownTabs = {
  liveConsole: new Map(),  // tabId → { url, timestamp }
  liveBoard: new Map(),    // tabId → { url, timestamp }
  hostDisplay: new Map(),  // tabId → { url, timestamp }
};

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  knownTabs.liveConsole.delete(tabId);
  knownTabs.liveBoard.delete(tabId);
  knownTabs.hostDisplay.delete(tabId);
});

// ─── Extension Icon Click → Open Side Panel ──────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[LivePilot SW] Side panel setup error:', err));

// ─── Service Worker Wake-up Recovery ─────────────────────────────
// MV3 service workers lose all in-memory state when suspended.
// On wake, proactively discover content script tabs via URL query.
async function recoverKnownTabs() {
  const patterns = [
    { map: 'liveConsole', urls: ['https://shop.tiktok.com/streamer*', 'https://*.tiktok.com/streamer*'] },
    { map: 'liveBoard', urls: ['https://shop.tiktok.com/workbench/live/*', 'https://shop.tiktok.com/live-board*'] },
  ];

  for (const { map, urls } of patterns) {
    for (const pattern of urls) {
      try {
        const tabs = await chrome.tabs.query({ url: pattern });
        for (const tab of tabs) {
          try {
            await chrome.tabs.sendMessage(tab.id, { source: 'service_worker', type: 'ping' });
            knownTabs[map].set(tab.id, { url: tab.url, timestamp: Date.now() });
            console.info(`[LivePilot SW] Recovered ${map} tab ${tab.id}: ${tab.url}`);
          } catch { /* content script not loaded in this tab */ }
        }
      } catch { /* pattern query failed */ }
    }
  }
}

// Run recovery immediately on SW startup (every time it wakes)
recoverKnownTabs();

// ─── Initialize defaults on install ──────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const template = await StorageAdapter.get('flash_template');
  if (!template) {
    await StorageAdapter.set('flash_template', DEFAULTS.flash_template);
  }

  const thresholds = await StorageAdapter.get('alert_thresholds');
  if (!thresholds) {
    await StorageAdapter.set('alert_thresholds', DEFAULTS.alert_thresholds);
  }

  console.info('[LivePilot SW] Extension installed, defaults initialized.');
});

// ─── Helper: send message to a known content script tab ──────────
async function sendToContentScript(tabMap, messageType, payload = {}) {
  // Try each known tab first
  for (const [tabId, info] of tabMap.entries()) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        source: 'service_worker',
        type: messageType,
        payload,
      });
      return { success: true, response, tabId, url: info.url };
    } catch (err) {
      console.warn(`[LivePilot SW] Tab ${tabId} (${info.url}) not responding:`, err.message);
      tabMap.delete(tabId);
    }
  }

  // Fallback: discover tabs by URL pattern (fixes MV3 race condition where
  // content_script_ready message was lost because service worker was asleep)
  const isConsole = tabMap === knownTabs.liveConsole;
  const urlPatterns = isConsole
    ? ['https://shop.tiktok.com/streamer*', 'https://*.tiktok.com/streamer*']
    : ['https://shop.tiktok.com/workbench/live/*', 'https://shop.tiktok.com/live-board*'];

  for (const pattern of urlPatterns) {
    try {
      const tabs = await chrome.tabs.query({ url: pattern });
      for (const tab of tabs) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, {
            source: 'service_worker',
            type: messageType,
            payload,
          });
          // Re-register this tab so future calls find it immediately
          tabMap.set(tab.id, { url: tab.url, timestamp: Date.now() });
          console.info(`[LivePilot SW] Auto-discovered tab ${tab.id} via URL query: ${tab.url}`);
          return { success: true, response, tabId: tab.id, url: tab.url };
        } catch (err) {
          console.warn(`[LivePilot SW] Tab ${tab.id} found by URL but not responding:`, err.message);
        }
      }
    } catch (err) {
      console.warn(`[LivePilot SW] tabs.query failed for ${pattern}:`, err.message);
    }
  }

  return {
    success: false,
    error: isConsole
      ? 'No LIVE Console content script connected. Make sure you have the TikTok LIVE Console page open and reload it.'
      : 'No LIVE Board content script connected.',
    debug: {
      knownLiveConsoleTabs: Array.from(knownTabs.liveConsole.entries()).map(([id, info]) => ({ id, ...info })),
      knownLiveBoardTabs: Array.from(knownTabs.liveBoard.entries()).map(([id, info]) => ({ id, ...info })),
    },
  };
}

// ─── Helper: auto-save discovery report as downloadable JSON ─────
async function saveDiscoveryToFile(report) {
  try {
    const json = JSON.stringify(report, null, 2);
    const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
    await chrome.downloads.download({
      url: dataUrl,
      filename: 'livepilot-discovery.json',
      conflictAction: 'overwrite',
      saveAs: false,
    });
    console.info('[LivePilot SW] Discovery report saved to Downloads/livepilot-discovery.json');
  } catch (err) {
    console.warn('[LivePilot SW] Failed to save discovery file:', err.message);
  }
}

// ─── Message Router ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('[LivePilot SW] Message handler error:', err);
      sendResponse({ success: false, error: err.message });
    });

  return true;
});

async function handleMessage(message, sender) {
  const { source, type, payload } = message;

  switch (type) {
    // ─── Content Script → Service Worker ────────────────────
    case 'content_script_ready': {
      const tabId = sender.tab?.id;
      const tabUrl = sender.tab?.url || 'unknown';

      // Register this tab so we can message it later
      if (source === 'live_console' && tabId) {
        knownTabs.liveConsole.set(tabId, { url: tabUrl, timestamp: Date.now() });
        console.info(`[LivePilot SW] LIVE Console registered: tab ${tabId} at ${tabUrl}`);
      } else if (source === 'live_board' && tabId) {
        knownTabs.liveBoard.set(tabId, { url: tabUrl, timestamp: Date.now() });
        console.info(`[LivePilot SW] LIVE Board registered: tab ${tabId} at ${tabUrl}`);
      }

      // Start a logging session if one isn't active
      if (!logger.sessionKey) {
        await logger.startSession();
      }

      // Open v1 session in parallel (LAN ingest to inventory_system).
      // Non-blocking — chat events will retry if the server isn't up yet.
      openLivePilotV1Session().catch(() => {});

      return { success: true, sessionKey: logger.sessionKey };
    }

    // ─── Product Dashboard → Service Worker (auto-pin) ───────
    // Proxies GET /api/livepilot/spotlight (public endpoint — the item the
    // operator QR-scanned in Inventory → In Stock). Returns { success,
    // data } where data is the spotlight item or null.
    case 'fetch_spotlight': {
      try {
        const resp = await fetch(`${inventoryApiBase}/api/livepilot/spotlight`, {
          headers: { 'Cache-Control': 'no-store' },
        });
        if (!resp.ok) return { success: false, error: `spotlight returned ${resp.status}`, data: null };
        const body = await resp.json();
        return { success: true, data: body?.data ?? null };
      } catch (err) {
        return { success: false, error: err.message, data: null };
      }
    }

    // ─── Host Display → Service Worker ──────────────────────
    case 'host_display_ready': {
      const tabId = sender.tab?.id;
      if (tabId) {
        knownTabs.hostDisplay.set(tabId, { url: sender.tab?.url || 'host-display', timestamp: Date.now() });
        console.info(`[LivePilot SW] Host Display registered: tab ${tabId}`);
      }
      return { success: true };
    }

    // ─── Send Product to Host Display (operator clicks "Show on Host") ──
    // Replaces the old 'pin_changed' auto-routing (auto-pin removed 2026-05-03).
    // Operator selects which product to feature; AI suggestions can fire the
    // same path. Falls through battle card lookup so the host display gets
    // enriched data when available.
    case 'send_product_to_host': {
      const product = payload?.product;
      if (!product) return { success: false, error: 'No product provided' };

      const card = findBattleCard(product.id) || findBattleCard(product.name);
      const displayProduct = card || product;
      lastPinnedProduct = displayProduct;

      let delivered = 0;
      for (const [tabId] of knownTabs.hostDisplay.entries()) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            type: 'host_show_product',
            payload: { product: displayProduct, identifier: product.id },
          });
          delivered++;
        } catch { knownTabs.hostDisplay.delete(tabId); }
      }

      console.info(`[LivePilot SW] Send to host → ${product.name?.slice(0, 40)} | tabs=${delivered} | battle card: ${card ? 'YES' : 'no'}`);
      updateRemoteState({ pinned: { name: product.name, id: product.id, productNo: product.productNo } });
      return { success: true, delivered, hasBattleCard: !!card };
    }

    // ─── Chat Messages (from content script) → Host + VPS + LivePilot v1
    // Schema (post-Q23): payload.events = [{ display_name, avatar_hash,
    // raw_message, badge, captured_at }, ...]. Tolerate the legacy
    // payload.messages shape for one release (older content scripts may
    // still be running on tabs that haven't been refreshed yet).
    // ─── Network Capture (from network-tap, page context) ──────
    // Forwards passive network observations from the page's actual
    // fetch + WebSocket to the local sink for offline @handle backfill.
    // Zero TikTok-facing requests — purely observational.
    case 'network_capture': {
      // Fire-and-forget POST to sink. If sink is down, drop silently
      // (network captures are bonus data, not core path).
      try {
        await fetch(`${livepilotV1Base.replace(/\/api\/livepilot\/v1$/, '')}/api/livepilot/v1/_network`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      } catch { /* never let net-tap break */ }
      return { success: true };
    }

    case 'chat_messages': {
      const events = payload?.events || [];
      const legacyMessages = payload?.messages;
      const forHost = events.length > 0
        ? events.map((e) => ({ name: e.display_name, text: e.raw_message }))
        : (legacyMessages || []);

      // Forward to Host Display tabs
      for (const [tabId] of knownTabs.hostDisplay.entries()) {
        try {
          await chrome.tabs.sendMessage(tabId, {
            type: 'host_chat_batch',
            payload: { messages: forHost },
          });
        } catch { knownTabs.hostDisplay.delete(tabId); }
      }

      // Push chat preview to VPS for remote monitoring
      if (forHost.length > 0) {
        updateRemoteState({ intentChat: forHost.slice(0, 15) });
      }

      // Persist to inventory_system v1 ingest (fire-and-forget; failures
      // are logged but don't block the rest of the message path).
      let ingestResult = null;
      if (events.length > 0) {
        ingestResult = await postChatEventsV1(events);
      }

      return {
        success: true,
        count: forHost.length,
        v1Ingested: ingestResult?.ingested ?? 0,
        v1Deduplicated: ingestResult?.deduplicated ?? 0,
      };
    }

    // ─── Load Battle Cards from Inventory API ─────────────────
    case 'load_battle_cards': {
      const apiUrl = payload?.apiUrl;
      const apiKey = payload?.apiKey;
      if (!apiUrl) return { success: false, error: 'No API URL provided' };

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['X-LivePilot-Key'] = apiKey;

        const resp = await fetch(apiUrl, { headers });
        if (!resp.ok) throw new Error(`API returned ${resp.status}`);

        const data = await resp.json();
        const products = data.data?.products || data.products || [];

        battleCards.clear();
        for (const p of products) indexBattleCard(p);

        // Save API config for future use
        await StorageAdapter.set('livepilot_api', { apiUrl, apiKey });

        console.info(`[LivePilot SW] Loaded ${products.length} battle cards from API`);
        return { success: true, count: products.length };
      } catch (err) {
        console.error('[LivePilot SW] Failed to load battle cards:', err.message);
        return { success: false, error: err.message };
      }
    }

    // ─── Forward messages to Host Display ───────────────────
    case 'host_show_product':
    case 'host_chat_message':
    case 'host_chat_batch':
    case 'host_operator_message':
    case 'host_set_next_product':
    case 'host_metric_update':
    case 'host_flash_price':
    case 'host_dissolve_point':
    case 'host_suggest_point':
    case 'host_restore_point':
    case 'host_restore_last':
    case 'host_reset_points':
    case 'host_get_point_states': {
      const results = [];
      for (const [tabId] of knownTabs.hostDisplay.entries()) {
        try {
          await chrome.tabs.sendMessage(tabId, { type, payload });
          results.push({ tabId, success: true });
        } catch (err) {
          knownTabs.hostDisplay.delete(tabId);
          results.push({ tabId, success: false, error: err.message });
        }
      }
      return { success: true, delivered: results.length, results };
    }

    // ─── Open Host Display in new window ────────────────────
    case 'open_host_display': {
      const url = chrome.runtime.getURL('host-display/host.html');
      const win = await chrome.windows.create({
        url,
        type: 'popup',
        width: 1200,
        height: 800,
      });
      return { success: true, windowId: win.id };
    }

    // ─── Open Host Display v2 (with dissolve system) ──────
    case 'open_host_display_v2': {
      const urlV2 = chrome.runtime.getURL('host-display-v2/host-v2.html');
      const winV2 = await chrome.windows.create({
        url: urlV2,
        type: 'popup',
        width: 1200,
        height: 800,
      });
      return { success: true, windowId: winV2.id };
    }

    // ─── Point States (from host display v2 → forward to panel) ─
    case 'host_point_states': {
      // This is sent by host-v2.js to report current point states.
      // The side panel listens for this via chrome.runtime.onMessage.
      return { success: true };
    }

    case 'dom_discovery_report': {
      console.info(`[LivePilot SW] DOM discovery report from ${source}`);
      eventBus.emit('dom_discovery', payload);
      // Auto-save to downloads so Claude can read it
      if (payload?.raw) {
        saveDiscoveryToFile(payload.raw);
      }
      return { success: true };
    }

    case 'product_list_update': {
      eventBus.emit('product_list_update', payload);
      return { success: true };
    }

    case 'metric_update': {
      eventBus.emit('metric_update', {
        action: 'scrape',
        params: payload,
        success: true,
      });
      return { success: true };
    }

    // ─── Full Discovery Report (both pages) ─────────────────
    case 'run_discovery_full': {
      const reports = [];
      const errors = [];

      // Try LIVE Console
      const consoleResult = await sendToContentScript(knownTabs.liveConsole, 'run_discovery');
      if (consoleResult.success && consoleResult.response?.data) {
        reports.push({ page: 'LIVE Console', ...consoleResult.response.data });
        if (consoleResult.response.data.raw) {
          saveDiscoveryToFile(consoleResult.response.data.raw);
        }
      } else {
        errors.push(`LIVE Console: ${consoleResult.error || 'not available'}`);
      }

      // Try LIVE Board / Workbench
      const boardResult = await sendToContentScript(knownTabs.liveBoard, 'run_discovery');
      if (boardResult.success && boardResult.response?.data) {
        reports.push({ page: 'LIVE Board / Workbench', ...boardResult.response.data });
      } else {
        errors.push(`LIVE Board: ${boardResult.error || 'not available'}`);
      }

      if (reports.length === 0) {
        return {
          success: false,
          error: 'No content scripts responded. ' + errors.join('; '),
          debug: {
            knownLiveConsoleTabs: Array.from(knownTabs.liveConsole.entries()).map(([id, info]) => ({ id, ...info })),
            knownLiveBoardTabs: Array.from(knownTabs.liveBoard.entries()).map(([id, info]) => ({ id, ...info })),
          },
        };
      }

      // Combine formatted reports
      const combined = reports.map(r => r.formatted).join('\n\n' + '═'.repeat(60) + '\n\n');
      const combinedRaw = reports.map(r => r.raw);

      return {
        success: true,
        data: {
          raw: combinedRaw,
          formatted: combined,
          pageCount: reports.length,
          errors: errors.length > 0 ? errors : undefined,
        },
      };
    }

    case 'request_product_list': {
      const result = await sendToContentScript(knownTabs.liveConsole, 'get_product_list');
      if (result.success) {
        return result.response;
      }
      return {
        success: false,
        error: result.error,
        debug: result.debug,
      };
    }

    // ─── Lightweight ping — verify content script is actually alive ─
    case 'ping_content_script': {
      const target = payload?.target === 'live_board' ? knownTabs.liveBoard : knownTabs.liveConsole;
      const result = await sendToContentScript(target, 'ping');
      return {
        success: result.success,
        tabId: result.tabId,
        url: result.url,
        error: result.error,
      };
    }

    // ─── Connection Status (with optional live verification) ──────
    case 'get_connection_status': {
      const data = {
        liveConsole: {
          connected: knownTabs.liveConsole.size > 0,
          tabs: Array.from(knownTabs.liveConsole.entries()).map(([id, info]) => ({ id, ...info })),
        },
        liveBoard: {
          connected: knownTabs.liveBoard.size > 0,
          tabs: Array.from(knownTabs.liveBoard.entries()).map(([id, info]) => ({ id, ...info })),
        },
      };

      // If caller wants verified status, actually ping content scripts
      if (payload?.verify) {
        const consoleResult = await sendToContentScript(knownTabs.liveConsole, 'ping');
        data.liveConsole.verified = consoleResult.success;
        if (consoleResult.success) {
          data.liveConsole.connected = true;
        }

        const boardResult = await sendToContentScript(knownTabs.liveBoard, 'ping');
        data.liveBoard.verified = boardResult.success;
        if (boardResult.success) {
          data.liveBoard.connected = true;
        }
      }

      return { success: true, data };
    }

    // ─── Settings ───────────────────────────────────────────
    case 'get_settings': {
      const data = await StorageAdapter.getMany([
        'flash_template',
        'alert_thresholds',
        'selector_overrides',
      ]);
      return { success: true, data };
    }

    case 'save_settings': {
      for (const [key, value] of Object.entries(payload)) {
        await StorageAdapter.set(key, value);
      }
      eventBus.emit('setting_change', {
        action: 'save',
        params: payload,
        success: true,
      });
      return { success: true };
    }

    // ─── Session Management ─────────────────────────────────
    case 'export_session': {
      const session = await logger.exportSession();
      return { success: true, data: session };
    }

    case 'new_session': {
      await logger.endSession();
      await logger.startSession();

      // Close v1 session (best-effort) and reset so next chat batch opens a fresh one.
      if (liveSessionId) {
        const oldId = liveSessionId;
        livePilotV1Ready = false;
        liveSessionId = null;
        fetch(`${livepilotV1Base}/sessions/${oldId}/end`, { method: 'POST' })
          .then(() => console.info(`[LivePilot SW] v1 session ${oldId} closed`))
          .catch((err) => console.warn(`[LivePilot SW] v1 session ${oldId} close failed: ${err.message}`));
      }
      await openLivePilotV1Session();

      return { success: true, sessionKey: logger.sessionKey, v1SessionId: liveSessionId };
    }

    case 'set_video_offset': {
      const offsetMs = payload?.offsetMs ?? 0;
      await logger.setVideoStartOffset(offsetMs);
      return { success: true, offsetMs };
    }

    default:
      console.warn(`[LivePilot SW] Unknown message type: ${type}`, message);
      return { success: false, error: `Unknown message type: ${type}` };
  }
}
