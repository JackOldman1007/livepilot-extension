/**
 * product-dashboard.js — Auto-pin on the TikTok LIVE product dashboard.
 * (Inventory tracker BUG-0095)
 *
 * Runs on shop.tiktok.com/streamer/live/product* . Polls the Inventory
 * system's spotlight endpoint (GET /api/livepilot/spotlight — the item the
 * operator just QR-scanned in Inventory → In Stock) via the service worker
 * (content scripts can't fetch cross-origin; the SW carries the
 * chrome-extension:// origin that patina-luxe.com CORS allows).
 *
 * On a NEW spotlight:
 *   1. Type the SKU (screening code, part of the product title) into the
 *      dashboard search box
 *   2. Find the matching product card
 *   3. Click its Pin button (human-like delay; verified by unpin-button flip)
 *   4. If no card matches → red banner "not in the live showcase" with an
 *      [Add to showcase] button that automates the add flow:
 *      Add → modal → search SKU → select card → confirm → then pin.
 *
 * SAFETY:
 * - Never retries a failed step silently — every failure lands in the
 *   banner with the step name so the operator can act manually.
 * - Each spotlight id is attempted ONCE (manual "Retry" re-arms it).
 * - All selectors live in lib/selectors.js (productDashboard group).
 *
 * Loaded as a classic script after selectors.js + dom-adapter.js.
 */

(function () {
  'use strict';

  const { findElement, findAllElements, readText, humanClick, setReactInputValue, delay } = self.LivePilot.dom;
  const { SELECTORS } = self.LivePilot;
  const S = SELECTORS.productDashboard;

  const POLL_MS = 2000;
  const FIND_TIMEOUT_MS = 8000;

  let lastHandledSpotlightId = null;
  let running = false;
  let extensionContextValid = true;

  // ─── Banner UI ────────────────────────────────────────────────
  // Single fixed banner, bottom-right. States: idle (hidden), working,
  // success (auto-hides), error (sticky, may carry an action button).

  let banner = null;

  function ensureBanner() {
    if (banner && document.body.contains(banner)) return banner;
    banner = document.createElement('div');
    banner.id = 'livepilot-autopin-banner';
    banner.style.cssText = [
      'position:fixed', 'bottom:24px', 'right:24px', 'z-index:2147483646',
      'max-width:380px', 'padding:12px 16px', 'border-radius:10px',
      'font:13px/1.45 system-ui,sans-serif', 'color:#fff',
      'box-shadow:0 6px 24px rgba(0,0,0,.35)', 'display:none',
    ].join(';');
    document.body.appendChild(banner);
    return banner;
  }

  function hideBanner() {
    if (banner) banner.style.display = 'none';
  }

  /**
   * showBanner(kind, parts, actions)
   * parts: array of strings (plain text) or {b: string} for bold — built
   * with textContent only; nothing from the API touches innerHTML.
   */
  function showBanner(kind, parts, actions = []) {
    const el = ensureBanner();
    const bg = { working: '#1d4ed8', success: '#047857', error: '#b91c1c' }[kind] || '#334155';
    el.style.background = bg;
    el.style.display = 'block';
    el.textContent = '';
    const text = document.createElement('div');
    for (const part of Array.isArray(parts) ? parts : [parts]) {
      if (part && typeof part === 'object' && 'b' in part) {
        const b = document.createElement('b');
        b.textContent = part.b;
        text.appendChild(b);
      } else {
        text.appendChild(document.createTextNode(String(part)));
      }
    }
    el.appendChild(text);
    if (actions.length) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-top:10px;display:flex;gap:8px';
      for (const { label, onClick } of actions) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = 'padding:6px 12px;border:0;border-radius:6px;background:#fff;color:#111;font-weight:600;cursor:pointer';
        btn.addEventListener('click', onClick);
        row.appendChild(btn);
      }
      el.appendChild(row);
    }
    if (kind === 'success') setTimeout(hideBanner, 5000);
  }

  // ─── Persistent attempt log (BUG-0095 field-test aid) ─────────
  // Console traces and banners are ephemeral — they vanish when the dashboard
  // tab closes. For the first real-live rollout we also append every terminal
  // outcome to chrome.storage.local so the whole session can be reviewed
  // afterward. Alt+Shift+L downloads the log as JSONL. Writes are serialized
  // (get→push→set is not atomic) and are never allowed to break the pin flow.
  const LOG_KEY = 'autopin_log';
  const LOG_CAP = 1000;
  let logChain = Promise.resolve();

  function logAttempt(entry) {
    logChain = logChain.then(async () => {
      const record = { t: new Date().toISOString(), ...entry };
      const stored = await chrome.storage.local.get(LOG_KEY);
      const log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
      log.push(record);
      if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
      await chrome.storage.local.set({ [LOG_KEY]: log });
    }).catch((err) => {
      // A log-write failure must never break the pin flow.
      console.warn('[LivePilot AutoPin] log write skipped:', err?.message || err);
    });
    return logChain;
  }

  async function downloadLog() {
    let log = [];
    try {
      const stored = await chrome.storage.local.get(LOG_KEY);
      log = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
    } catch (err) {
      console.warn('[LivePilot AutoPin] log read failed:', err?.message || err);
    }
    const jsonl = log.map((r) => JSON.stringify(r)).join('\n');
    const blob = new Blob([jsonl ? jsonl + '\n' : ''], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `autopin-log-${new Date().toISOString().slice(0, 10)}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showBanner('success', [`Downloaded auto-pin log — ${log.length} entr${log.length === 1 ? 'y' : 'ies'}.`]);
  }

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      downloadLog();
    }
  });

  // ─── DOM helpers ──────────────────────────────────────────────

  async function waitForElement(selectorChain, timeoutMs = 5000, root) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { element } = findElement(selectorChain, root);
      if (element) return element;
      await delay(250, 350);
    }
    return null;
  }

  async function waitForCondition(fn, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = fn();
      if (value) return value;
      await delay(250, 350);
    }
    return null;
  }

  /** Find the product row whose title contains the SKU. root defaults to page. */
  function findRowBySku(sku, root) {
    const { elements: rows } = findAllElements(S.productRow, root);
    for (const row of rows) {
      // readText takes a selector CHAIN + root (dom-adapter API)
      const title = readText(S.productTitle, row) || row.textContent || '';
      if (title.toUpperCase().includes(sku.toUpperCase())) {
        return row;
      }
    }
    return null;
  }

  async function typeIntoSearch(selectorChain, sku, root) {
    const input = await waitForElement(selectorChain, FIND_TIMEOUT_MS, root);
    if (!input) return null;
    setReactInputValue(input, sku);
    await delay(200, 400);
    // Most TikTok search boxes filter live; Enter covers the ones that don't.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return input;
  }

  // ─── Pin flow ─────────────────────────────────────────────────

  async function pinRow(row, sku) {
    // Already pinned? (row shows Unpin instead of Pin)
    const { element: unpinBtn } = findElement(S.unpinButton, row);
    if (unpinBtn) return { success: true, alreadyPinned: true };

    const { element: pinBtn } = findElement(S.pinButton, row);
    if (!pinBtn) return { success: false, step: 'find_pin_button', error: 'Pin button not found in the product card' };

    await humanClick(pinBtn);
    console.info('[LivePilot AutoPin] pin clicked, verifying…');

    // Verify: the card should flip to Unpin. React re-renders the list on
    // pin, so the held `row` reference goes STALE (detached, still holding
    // the old Pin button) — re-locate the card by SKU on every poll.
    const flipped = await waitForCondition(() => {
      const freshRow = findRowBySku(sku);
      if (!freshRow) return false;
      const { element: unpin } = findElement(S.unpinButton, freshRow);
      if (unpin) return true;
      const { element: stillPin } = findElement(S.pinButton, freshRow);
      return stillPin ? false : true;
    }, 6000);

    if (!flipped) {
      return { success: false, step: 'verify_pin', error: 'Clicked Pin but the card did not switch to pinned state' };
    }
    console.info(`[LivePilot AutoPin] Pinned ${sku}`);
    return { success: true };
  }

  // ─── Add-to-showcase flow ─────────────────────────────────────

  async function addProductFlow(sku) {
    showBanner('working', [{ b: sku }, ' — adding to the live showcase…']);

    const addBtn = await waitForElement(S.addButton, FIND_TIMEOUT_MS);
    if (!addBtn) return { success: false, step: 'find_add_button', error: 'Add products button not found' };
    await humanClick(addBtn);

    const modal = await waitForElement(S.addModal, FIND_TIMEOUT_MS);
    if (!modal) return { success: false, step: 'open_add_modal', error: 'Add-product dialog did not open' };

    const searchInput = await typeIntoSearch(S.addModalSearchInput, sku, modal);
    if (!searchInput) return { success: false, step: 'modal_search', error: 'Search box inside the dialog not found' };

    const row = await waitForCondition(() => findRowBySku(sku, modal), FIND_TIMEOUT_MS);
    if (!row) {
      return {
        success: false, step: 'modal_find_product',
        error: `No product matching ${sku} in your shop — check that the item is listed on TikTok`,
      };
    }

    const { element: selectEl } = findElement(S.addModalRowSelect, row);
    await humanClick(selectEl || row);

    const confirmBtn = await waitForElement(S.addModalConfirm, FIND_TIMEOUT_MS, modal);
    if (!confirmBtn) return { success: false, step: 'modal_confirm', error: 'Add confirm button not found in the dialog' };
    await humanClick(confirmBtn);

    // Wait for the modal to close, then the card to appear in the main list.
    await waitForCondition(() => !document.contains(modal) || modal.offsetParent === null, 8000);
    return { success: true };
  }

  // ─── Orchestrator ─────────────────────────────────────────────

  async function runAutoPin(spotlight, { allowAdd = false } = {}) {
    const sku = String(spotlight.screening_code || '').trim();
    if (!sku) return;
    const spotlightId = spotlight.id ?? spotlight.screening_code;
    running = true;
    try {
      showBanner('working', [{ b: sku }, ' — searching the live showcase…']);

      const searchInput = await typeIntoSearch(S.searchInput, sku);
      if (!searchInput) {
        showBanner('error', [{ b: sku }, ' — product search box not found on this page (step: find_search)']);
        logAttempt({ sku, spotlight_id: spotlightId, outcome: 'error', step: 'find_search', error: 'product search box not found' });
        return;
      }

      console.info('[LivePilot AutoPin] search filled, locating card…');
      let row = await waitForCondition(() => findRowBySku(sku), FIND_TIMEOUT_MS);
      console.info(`[LivePilot AutoPin] card ${row ? 'found' : 'NOT found'}`);

      if (!row && allowAdd) {
        const added = await addProductFlow(sku);
        if (!added.success) {
          showBanner('error', [{ b: sku }, ` — add to showcase failed: ${added.error} (step: ${added.step})`], [
            { label: 'Retry', onClick: () => { hideBanner(); runAutoPin(spotlight, { allowAdd: true }); } },
          ]);
          logAttempt({ sku, spotlight_id: spotlightId, outcome: 'error', step: added.step, error: added.error });
          return;
        }
        await typeIntoSearch(S.searchInput, sku);
        row = await waitForCondition(() => findRowBySku(sku), FIND_TIMEOUT_MS);
      }

      if (!row) {
        showBanner('error',
          [{ b: sku }, ' has not been added to the live showcase.'],
          [
            { label: 'Add to showcase', onClick: () => { hideBanner(); runAutoPin(spotlight, { allowAdd: true }); } },
            { label: 'Dismiss', onClick: hideBanner },
          ]);
        logAttempt({ sku, spotlight_id: spotlightId, outcome: 'not_in_showcase' });
        return;
      }

      const result = await pinRow(row, sku);
      if (result.success) {
        showBanner('success', result.alreadyPinned
          ? [{ b: sku }, ' is already pinned.']
          : ['📌 ', { b: sku }, ' pinned to the live.']);
        logAttempt({ sku, spotlight_id: spotlightId, outcome: result.alreadyPinned ? 'already_pinned' : 'pinned', added: allowAdd });
      } else {
        showBanner('error', [{ b: sku }, ` — ${result.error} (step: ${result.step})`], [
          { label: 'Retry', onClick: () => { hideBanner(); runAutoPin(spotlight); } },
        ]);
        logAttempt({ sku, spotlight_id: spotlightId, outcome: 'error', step: result.step, error: result.error });
      }
    } finally {
      running = false;
    }
  }

  // ─── Spotlight polling ────────────────────────────────────────

  async function pollSpotlight() {
    if (!extensionContextValid || running) return;
    let response;
    try {
      response = await chrome.runtime.sendMessage({ source: 'product_dashboard', type: 'fetch_spotlight' });
    } catch (err) {
      // Extension reloaded/updated under us — stop cleanly.
      if (String(err?.message).includes('Extension context invalidated')) {
        extensionContextValid = false;
      }
      return;
    }
    const spotlight = response?.data;
    if (!spotlight || !spotlight.screening_code) return;

    const spotlightId = spotlight.id ?? spotlight.screening_code;
    if (spotlightId === lastHandledSpotlightId) return;
    lastHandledSpotlightId = spotlightId;

    console.info(`[LivePilot AutoPin] New spotlight: ${spotlight.screening_code}`);
    runAutoPin(spotlight);
  }

  setInterval(pollSpotlight, POLL_MS);

  console.info('[LivePilot AutoPin] Product-dashboard auto-pin armed (polling spotlight every 2s). Press Alt+Shift+L to download the attempt log.');
})();
