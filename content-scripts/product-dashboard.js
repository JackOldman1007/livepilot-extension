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
 * - Each spotlight PING is attempted ONCE, keyed on live_spotlights.id.
 *   Re-scanning the same bag is a NEW ping and DOES re-arm auto-pin (that is
 *   the operator's natural retry). Repeats inside RESCAN_DEBOUNCE_MS are
 *   dropped as scanner double-fire. Before 2026-08-19 the endpoint sent no
 *   id, so this key collapsed onto the bag code and every re-scan was a
 *   permanent silent no-op — the core of BUG-0095.
 * - Terminal outcomes also fire a desktop notification, because the banner
 *   lives in a tab the operator is not watching during a live.
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
  // A scanner gun can fire the same QR twice in ~1s (observed in prod:
  // S014260526036 pinged twice, 1 second apart). A DELIBERATE re-scan -- the
  // operator retrying because nothing visibly happened -- was never closer
  // than 11s in the field data. 5s separates the two cleanly: swallow the
  // gun's stutter, honour the human's retry.
  const RESCAN_DEBOUNCE_MS = 5000;

  let lastHandledSpotlightId = null;
  // Anchored to the last ACCEPTED attempt and never extended by a debounced
  // repeat -- otherwise a stuttering gun would hold the window open forever.
  let lastAttempt = { code: null, at: 0 };
  let running = false;
  let extensionContextValid = true;
  // 'unknown' until the first poll resolves, then 'ok' / 'error'. Only
  // TRANSITIONS are reported, so a sustained outage never spams the banner.
  let pollHealth = 'unknown';
  let warnedMissingPingId = false;

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

  // ─── Cross-window feedback (BUG-0095) ────────────────────────
  // The operator scans in the INVENTORY tab and watches the live; this banner
  // renders in the TikTok dashboard tab, which is backgrounded during a show.
  // Every outcome below was therefore invisible in practice, while Inventory
  // showed an unconditional green "Pinged to LIVE" toast the moment the row
  // was inserted -- a false success in the only window they were watching.
  // A desktop notification is the one channel that reaches them regardless of
  // focus. ("notifications" was already granted in the manifest, never used.)
  function notifyOperator(title, message) {
    try {
      chrome.runtime
        .sendMessage({ source: 'product_dashboard', type: 'autopin_notify', payload: { title, message } })
        .catch(() => {});
    } catch {
      /* SW asleep or context invalidated — never let this break the pin flow */
    }
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

  /**
   * Find the product row whose title contains the SKU. root defaults to page.
   * rowSelector defaults to the main-list chain; the add-modal passes its own
   * (S.addModalProductRow was defined but never wired up — the modal search
   * was silently relying on the main-list chain's table fallback).
   */
  function findRowBySku(sku, root, rowSelector = S.productRow) {
    const { elements: rows } = findAllElements(rowSelector, root);
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

    const modalRowChain = [...S.addModalProductRow, ...S.productRow];
    const row = await waitForCondition(() => findRowBySku(sku, modal, modalRowChain), FIND_TIMEOUT_MS);
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
        notifyOperator(`Auto-pin failed — ${sku}`, 'Product search box not found (step: find_search). Pin manually.');
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
          notifyOperator(`Auto-pin failed — ${sku}`, `${added.error} (step: ${added.step})`);
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
        notifyOperator(`Not in the live showcase — ${sku}`, 'Open the TikTok dashboard tab to add it, or pin manually.');
        return;
      }

      const result = await pinRow(row, sku);
      if (result.success) {
        showBanner('success', result.alreadyPinned
          ? [{ b: sku }, ' is already pinned.']
          : ['📌 ', { b: sku }, ' pinned to the live.']);
        logAttempt({ sku, spotlight_id: spotlightId, outcome: result.alreadyPinned ? 'already_pinned' : 'pinned', added: allowAdd });
        notifyOperator(result.alreadyPinned ? `Already pinned — ${sku}` : `Pinned — ${sku}`,
          result.alreadyPinned ? 'That bag was already pinned to the live.' : 'Now pinned to the live.');
      } else {
        showBanner('error', [{ b: sku }, ` — ${result.error} (step: ${result.step})`], [
          { label: 'Retry', onClick: () => { hideBanner(); runAutoPin(spotlight); } },
        ]);
        logAttempt({ sku, spotlight_id: spotlightId, outcome: 'error', step: result.step, error: result.error });
        notifyOperator(`Auto-pin failed — ${sku}`, `${result.error} (step: ${result.step})`);
      }
    } finally {
      running = false;
    }
  }

  // ─── Spotlight polling ────────────────────────────────────────

  /**
   * Report poll health on TRANSITION only.
   *
   * Before this, a failing service-worker fetch and "nothing is spotlighted"
   * took the same silent `return` — which made "auto-pin never works"
   * indistinguishable from "auto-pin never ran" from the operator's seat.
   * That ambiguity is the reason BUG-0095 sat undiagnosed for six weeks.
   */
  function setPollHealth(next, detail) {
    if (pollHealth === next) return;
    const previous = pollHealth;
    pollHealth = next;
    if (next === 'ok') {
      console.info('[LivePilot AutoPin] Spotlight endpoint reachable — auto-pin is armed.');
      // Only clear a banner we own, and never stomp a pin result mid-flight.
      if (previous === 'error' && !running) hideBanner();
    } else if (next === 'error') {
      console.error(`[LivePilot AutoPin] Spotlight poll FAILED: ${detail}`);
      logAttempt({ outcome: 'poll_error', error: String(detail) });
      if (!running) {
        showBanner('error', ['Auto-pin cannot reach the Inventory system — ', { b: String(detail) },
          '. Scans will NOT pin until this clears.']);
      }
      notifyOperator('LivePilot auto-pin is offline', `Cannot reach Inventory: ${detail}`);
    }
  }

  async function pollSpotlight() {
    if (!extensionContextValid || running) return;
    let response;
    try {
      response = await chrome.runtime.sendMessage({ source: 'product_dashboard', type: 'fetch_spotlight' });
    } catch (err) {
      // Extension reloaded/updated under us — stop cleanly.
      if (String(err?.message).includes('Extension context invalidated')) {
        extensionContextValid = false;
        console.warn('[LivePilot AutoPin] Extension was reloaded — reload this dashboard tab to re-arm auto-pin.');
        return;
      }
      setPollHealth('error', err?.message || 'service worker unreachable');
      return;
    }

    // The SW reports transport/HTTP failures in-band; they used to be dropped
    // on the floor here, identically to a legitimate empty spotlight.
    if (response && response.success === false) {
      setPollHealth('error', response.error || 'unknown error');
      return;
    }
    setPollHealth('ok');

    const spotlight = response?.data;
    if (!spotlight || !spotlight.screening_code) return;

    const code = spotlight.screening_code;

    // `id` is live_spotlights.id — the identity of THIS PING, not of the bag.
    // The screening_code fallback is the pre-fix behaviour, kept only as a
    // safety net against an old server build; on that path a re-scan of the
    // same bag still cannot re-arm, so say so loudly and once.
    if (spotlight.id == null && !warnedMissingPingId) {
      warnedMissingPingId = true;
      console.warn('[LivePilot AutoPin] Server did not send a spotlight id — falling back to the bag code. Re-scanning the SAME bag will not re-trigger auto-pin until the server is updated.');
      logAttempt({ sku: code, outcome: 'server_missing_ping_id' });
    }

    const spotlightId = spotlight.id ?? code;
    if (spotlightId === lastHandledSpotlightId) return;

    const now = Date.now();
    if (lastAttempt.code === code && now - lastAttempt.at < RESCAN_DEBOUNCE_MS) {
      // Consume the id, or this branch re-evaluates every POLL_MS.
      lastHandledSpotlightId = spotlightId;
      const gap = now - lastAttempt.at;
      console.info(`[LivePilot AutoPin] Ignored repeat scan of ${code} (${gap}ms after the last one — scanner double-fire).`);
      logAttempt({ sku: code, spotlight_id: spotlightId, outcome: 'debounced_rescan', since_last_ms: gap });
      return;
    }

    lastHandledSpotlightId = spotlightId;
    lastAttempt = { code, at: now };

    console.info(`[LivePilot AutoPin] New spotlight: ${code} (ping ${spotlightId})`);
    runAutoPin(spotlight);
  }

  setInterval(pollSpotlight, POLL_MS);

  console.info('[LivePilot AutoPin] Product-dashboard auto-pin armed (polling spotlight every 2s). Press Alt+Shift+L to download the attempt log.');
})();
