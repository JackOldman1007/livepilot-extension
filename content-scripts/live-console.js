/**
 * live-console.js — Content script for shop.tiktok.com/streamer.
 *
 * Section 1: Read-only DOM discovery mode.
 * - Logs Shopping Bag elements, flash sale form structure, pin button locations
 * - Zero automation, zero risk
 * - Responds to messages from service worker
 *
 * Depends on selectors.js and dom-adapter.js (loaded before this script).
 */

(function () {
  'use strict';

  const { SELECTORS } = self.LivePilot;
  const { findElement, findAllElements, readText } = self.LivePilot.dom;

  // ─── Notify Service Worker that we're alive ────────────────────
  // Retry registration to handle MV3 race condition where service worker
  // may be waking up when content script first loads.
  let extensionContextValid = true;

  async function registerWithServiceWorker(retries = 3, delayMs = 1000) {
    for (let i = 0; i < retries; i++) {
      try {
        const resp = await chrome.runtime.sendMessage({
          source: 'live_console',
          type: 'content_script_ready',
          payload: { url: location.href, timestamp: Date.now() },
        });
        console.info(`[LivePilot Console] Registered with service worker (attempt ${i + 1})`);
        return resp;
      } catch (err) {
        // Extension was reloaded/updated — this content script is orphaned
        if (err.message?.includes('Extension context invalidated')) {
          console.warn('[LivePilot Console] Extension reloaded — this content script is orphaned. Reload the page.');
          extensionContextValid = false;
          return null;
        }
        console.warn(`[LivePilot Console] Registration attempt ${i + 1} failed:`, err.message);
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }
    console.error('[LivePilot Console] Failed to register after all retries');
  }
  registerWithServiceWorker();

  // ─── Heartbeat: re-register periodically ──────────────────────
  // MV3 service workers lose in-memory state when suspended.
  // Re-registering every 25s keeps the knownTabs map fresh.
  setInterval(() => {
    if (!extensionContextValid) return;
    chrome.runtime.sendMessage({
      source: 'live_console',
      type: 'content_script_ready',
      payload: { url: location.href, timestamp: Date.now(), heartbeat: true },
    }).catch((err) => {
      if (err.message?.includes('Extension context invalidated')) {
        extensionContextValid = false;
        console.warn('[LivePilot Console] Extension context lost — stop heartbeat');
      }
    });
  }, 25000);

  // ─── Helper: capture element details ─────────────────────────
  function captureElement(el) {
    if (!el) return null;
    return {
      tag: el.tagName.toLowerCase(),
      classes: el.className ? el.className.toString().slice(0, 120) : '',
      id: el.id || null,
      dataTestId: el.getAttribute('data-testid') || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      role: el.getAttribute('role') || null,
      text: el.textContent?.trim().slice(0, 80) || '',
      dataAttributes: Array.from(el.attributes)
        .filter(a => a.name.startsWith('data-'))
        .map(a => `${a.name}="${a.value}"`)
        .join(', '),
    };
  }

  // ─── Helper: CSS path to an element ──────────────────────────
  function cssPath(el) {
    if (!el || el === document.body) return 'body';
    const parts = [];
    let current = el;
    for (let depth = 0; current && current !== document.body && depth < 6; depth++) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        selector += `#${current.id}`;
        parts.unshift(selector);
        break;
      }
      if (current.getAttribute('data-testid')) {
        selector += `[data-testid="${current.getAttribute('data-testid')}"]`;
        parts.unshift(selector);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (classes) selector += `.${classes}`;
      }
      parts.unshift(selector);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  // ─── Full Auto Discovery ─────────────────────────────────────
  function runFullDiscovery() {
    const report = {
      meta: {
        timestamp: new Date().toISOString(),
        url: location.href,
        title: document.title,
        userAgent: navigator.userAgent,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        hasIframes: document.querySelectorAll('iframe').length,
      },
      selectorResults: {},
      productList: [],
      buttons: [],
      inputs: [],
      dataTestIds: [],
      ariaRoles: [],
      tabs: [],
      modals: [],
      images: [],
    };

    // 1. Test all our predefined selectors
    for (const [groupName, selectors] of Object.entries(SELECTORS)) {
      report.selectorResults[groupName] = {};
      for (const [elementName, selectorChain] of Object.entries(selectors)) {
        const result = findElement(selectorChain);
        const allResult = findAllElements(selectorChain);
        report.selectorResults[groupName][elementName] = {
          found: result.element !== null,
          selectorUsed: result.selectorUsed,
          fallbackIndex: result.fallbackIndex,
          matchCount: allResult.elements.length,
          element: captureElement(result.element),
          cssPath: result.element ? cssPath(result.element) : null,
        };
      }
    }

    // 2. Smart product list detection — find likely product containers
    const listCandidates = document.querySelectorAll(
      '[role="list"], [role="listbox"], ul, ol, [class*="list"], [class*="product"], [class*="item-list"], [class*="shopping"]'
    );
    const seenContainers = new Set();
    for (const container of listCandidates) {
      const children = container.children;
      // A product list likely has 3+ similar children
      if (children.length >= 3 && !seenContainers.has(container)) {
        seenContainers.add(container);
        const firstChild = children[0];
        const sample = {
          container: captureElement(container),
          containerPath: cssPath(container),
          childCount: children.length,
          firstChild: captureElement(firstChild),
          firstChildPath: cssPath(firstChild),
          // Look deeper into the first child for product-like content
          hasImage: !!firstChild.querySelector('img'),
          hasButton: !!firstChild.querySelector('button'),
          hasPrice: !!(firstChild.textContent?.match(/\$[\d,.]+/) || firstChild.querySelector('[class*="price"]')),
          innerButtons: Array.from(firstChild.querySelectorAll('button')).map(b => ({
            text: b.textContent.trim().slice(0, 40),
            classes: b.className?.toString().slice(0, 80),
            ariaLabel: b.getAttribute('aria-label'),
          })),
          innerImages: Array.from(firstChild.querySelectorAll('img')).slice(0, 2).map(img => ({
            src: img.src?.slice(0, 100),
            alt: img.alt,
            width: img.width,
            height: img.height,
          })),
        };
        report.productList.push(sample);
      }
    }

    // 2b. Deep product row inspection — dump the inner structure of each product card
    const productRows = document.querySelectorAll('div.rounded-4.mb-8');
    report.productRowDetails = [];
    const maxRows = Math.min(productRows.length, 3); // Inspect first 3 rows
    for (let i = 0; i < maxRows; i++) {
      const row = productRows[i];
      const detail = {
        index: i,
        outerElement: captureElement(row),
        cssPath: cssPath(row),
        fullText: row.textContent.trim().slice(0, 200),
        innerHTML: row.innerHTML.slice(0, 2000),
        // Find all text-bearing elements (likely product name, price, etc.)
        textElements: [],
        // Find all images
        images: [],
        // Find all buttons
        buttons: [],
        // Find all inputs
        inputs: [],
        // Find price-like text
        priceTexts: [],
      };

      // Walk all child elements and capture text nodes
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        const directText = Array.from(node.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim())
          .filter(t => t.length > 0)
          .join(' ');

        if (directText.length > 2) {
          detail.textElements.push({
            tag: node.tagName.toLowerCase(),
            classes: node.className?.toString().slice(0, 100) || '',
            text: directText.slice(0, 120),
            cssPath: cssPath(node),
            // Flag if it looks like a price
            looksLikePrice: /\$[\d,.]+/.test(directText) || /[\d,.]+\s*(USD|usd)/.test(directText),
            // Flag if it looks like a product name (long text, not a number)
            looksLikeName: directText.length > 15 && !/^\$?[\d,.%]+$/.test(directText),
          });
        }

        // Check for price patterns in computed content too
        if (/\$[\d,.]+/.test(directText)) {
          detail.priceTexts.push({
            text: directText.slice(0, 60),
            tag: node.tagName.toLowerCase(),
            classes: node.className?.toString().slice(0, 100) || '',
            cssPath: cssPath(node),
          });
        }
      }

      // Images inside this row
      detail.images = Array.from(row.querySelectorAll('img')).map(img => ({
        src: img.src?.slice(0, 150),
        alt: img.alt || '',
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        classes: img.className?.toString().slice(0, 80) || '',
        cssPath: cssPath(img),
        parentClasses: img.parentElement?.className?.toString().slice(0, 80) || '',
      }));

      // Buttons inside this row
      detail.buttons = Array.from(row.querySelectorAll('button, [role="button"]')).map(btn => ({
        text: btn.textContent.trim().slice(0, 40),
        classes: btn.className?.toString().slice(0, 100) || '',
        ariaLabel: btn.getAttribute('aria-label') || '',
        disabled: btn.disabled,
        visible: btn.offsetParent !== null,
        cssPath: cssPath(btn),
      }));

      // Inputs inside this row
      detail.inputs = Array.from(row.querySelectorAll('input, select, textarea')).map(input => ({
        type: input.type || 'text',
        value: input.value?.slice(0, 30) || '',
        placeholder: input.placeholder || '',
        classes: input.className?.toString().slice(0, 80) || '',
        cssPath: cssPath(input),
      }));

      report.productRowDetails.push(detail);
    }

    // 3. All buttons — comprehensive scan
    const allButtons = document.querySelectorAll('button, [role="button"]');
    for (const btn of allButtons) {
      const text = btn.textContent.trim().toLowerCase();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      const isInteresting =
        text.includes('pin') || text.includes('flash') || text.includes('create') ||
        text.includes('start') || text.includes('sale') || text.includes('add') ||
        text.includes('submit') || text.includes('confirm') || text.includes('cancel') ||
        text.includes('delete') || text.includes('remove') || text.includes('edit') ||
        text.includes('save') || text.includes('live') || text.includes('product') ||
        text.includes('shop') || text.includes('bag') || text.includes('giveaway') ||
        text.includes('billboard') ||
        ariaLabel.includes('pin') || ariaLabel.includes('flash') || ariaLabel.includes('sale');

      if (isInteresting) {
        report.buttons.push({
          ...captureElement(btn),
          cssPath: cssPath(btn),
          disabled: btn.disabled,
          visible: btn.offsetParent !== null,
        });
      }
    }

    // 4. All form inputs
    const allInputs = document.querySelectorAll('input, select, textarea, [contenteditable="true"]');
    for (const input of allInputs) {
      report.inputs.push({
        ...captureElement(input),
        type: input.type || input.tagName.toLowerCase(),
        name: input.name || null,
        placeholder: input.placeholder || null,
        value: input.type === 'password' ? '***' : (input.value || '').slice(0, 40),
        cssPath: cssPath(input),
        visible: input.offsetParent !== null,
      });
    }

    // 5. data-testid elements
    const testIdEls = document.querySelectorAll('[data-testid]');
    for (const el of testIdEls) {
      report.dataTestIds.push({
        testId: el.getAttribute('data-testid'),
        tag: el.tagName.toLowerCase(),
        text: el.textContent?.trim().slice(0, 50),
        cssPath: cssPath(el),
      });
    }

    // 6. ARIA roles (tabs, lists, dialogs)
    const roleEls = document.querySelectorAll(
      '[role="tab"], [role="tablist"], [role="tabpanel"], [role="list"], [role="listitem"], [role="dialog"], [role="menu"], [role="menuitem"], [role="toolbar"]'
    );
    for (const el of roleEls) {
      report.ariaRoles.push({
        role: el.getAttribute('role'),
        ...captureElement(el),
        cssPath: cssPath(el),
      });
    }

    // 7. Tab-like navigation (common in TikTok's UI)
    const tabLike = document.querySelectorAll('[role="tab"], [class*="tab"], [class*="Tab"]');
    for (const el of tabLike) {
      report.tabs.push({
        ...captureElement(el),
        cssPath: cssPath(el),
        isSelected: el.getAttribute('aria-selected') === 'true' || el.classList.contains('active'),
      });
    }

    // 8. Modals / dialogs / popups
    const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="popup"], [class*="Popup"], [class*="drawer"], [class*="Drawer"]');
    for (const el of modals) {
      report.modals.push({
        ...captureElement(el),
        cssPath: cssPath(el),
        visible: el.offsetParent !== null,
      });
    }

    return report;
  }

  // ─── Format report as human-readable text ────────────────────
  function formatReport(report) {
    const lines = [];
    const hr = '─'.repeat(50);

    lines.push(`LIVEPILOT DOM DISCOVERY REPORT`);
    lines.push(hr);
    lines.push(`Date: ${report.meta.timestamp}`);
    lines.push(`URL: ${report.meta.url}`);
    lines.push(`Page title: ${report.meta.title}`);
    lines.push(`Viewport: ${report.meta.viewportWidth}x${report.meta.viewportHeight}`);
    lines.push(`Iframes on page: ${report.meta.hasIframes}`);
    lines.push('');

    // Section A: Selector results
    lines.push(`SECTION A — SELECTOR TEST RESULTS`);
    lines.push(hr);
    for (const [group, selectors] of Object.entries(report.selectorResults)) {
      lines.push(`[${group}]`);
      for (const [name, result] of Object.entries(selectors)) {
        const icon = result.found ? 'FOUND' : 'NOT FOUND';
        const fallback = result.fallbackIndex > 0 ? ` (fallback #${result.fallbackIndex})` : '';
        lines.push(`  ${icon} — ${name}${fallback}`);
        if (result.found) {
          lines.push(`    Tag: <${result.element.tag}>`);
          lines.push(`    Classes: ${result.element.classes || 'none'}`);
          lines.push(`    data-testid: ${result.element.dataTestId || 'none'}`);
          lines.push(`    aria-label: ${result.element.ariaLabel || 'none'}`);
          lines.push(`    Text: "${result.element.text}"`);
          lines.push(`    CSS path: ${result.cssPath}`);
          lines.push(`    Matches: ${result.matchCount}`);
        }
      }
      lines.push('');
    }

    // Section B: Product list candidates
    lines.push(`SECTION B — PRODUCT LIST CANDIDATES (auto-detected)`);
    lines.push(hr);
    if (report.productList.length === 0) {
      lines.push('  No product list candidates found.');
      lines.push('  This may mean products load lazily or are inside an iframe.');
    }
    for (let i = 0; i < report.productList.length; i++) {
      const pl = report.productList[i];
      lines.push(`  Candidate #${i + 1}:`);
      lines.push(`    Container: <${pl.container.tag}> classes="${pl.container.classes}"`);
      lines.push(`    Container path: ${pl.containerPath}`);
      lines.push(`    Child count: ${pl.childCount}`);
      lines.push(`    First child: <${pl.firstChild.tag}> classes="${pl.firstChild.classes}"`);
      lines.push(`    First child path: ${pl.firstChildPath}`);
      lines.push(`    Has image: ${pl.hasImage}`);
      lines.push(`    Has button: ${pl.hasButton}`);
      lines.push(`    Has price ($): ${pl.hasPrice}`);
      if (pl.innerButtons.length > 0) {
        lines.push(`    Buttons inside first child:`);
        for (const b of pl.innerButtons) {
          lines.push(`      - "${b.text}" classes="${b.classes}" aria-label="${b.ariaLabel || ''}"`);
        }
      }
      if (pl.innerImages.length > 0) {
        lines.push(`    Images inside first child:`);
        for (const img of pl.innerImages) {
          lines.push(`      - src="${img.src}" alt="${img.alt || ''}" ${img.width}x${img.height}`);
        }
      }
      lines.push('');
    }

    // Section B2: Deep product row inspection
    lines.push(`SECTION B2 — PRODUCT ROW DEEP INSPECTION`);
    lines.push(hr);
    if (!report.productRowDetails || report.productRowDetails.length === 0) {
      lines.push('  No product rows found (div.rounded-4.mb-8).');
    }
    for (const row of (report.productRowDetails || [])) {
      lines.push(`  === Product Row #${row.index + 1} ===`);
      lines.push(`  Full text: "${row.fullText}"`);
      lines.push(`  CSS path: ${row.cssPath}`);
      lines.push('');

      // Text elements (product name, price candidates)
      if (row.textElements.length > 0) {
        lines.push(`  Text elements inside this row:`);
        for (const te of row.textElements) {
          const flags = [];
          if (te.looksLikeName) flags.push('LIKELY NAME');
          if (te.looksLikePrice) flags.push('LIKELY PRICE');
          const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
          lines.push(`    "${te.text}"${flagStr}`);
          lines.push(`      <${te.tag}> classes="${te.classes}"`);
          lines.push(`      path: ${te.cssPath}`);
        }
        lines.push('');
      }

      // Price-like text specifically
      if (row.priceTexts.length > 0) {
        lines.push(`  Price-like text found:`);
        for (const p of row.priceTexts) {
          lines.push(`    "${p.text}" <${p.tag}> classes="${p.classes}" — ${p.cssPath}`);
        }
        lines.push('');
      }

      // Images
      if (row.images.length > 0) {
        lines.push(`  Images:`);
        for (const img of row.images) {
          lines.push(`    src="${img.src}"`);
          lines.push(`      ${img.width}x${img.height} classes="${img.classes}" parent="${img.parentClasses}"`);
          lines.push(`      path: ${img.cssPath}`);
        }
        lines.push('');
      }

      // Buttons
      if (row.buttons.length > 0) {
        lines.push(`  Buttons:`);
        for (const btn of row.buttons) {
          const vis = btn.visible ? '' : ' [HIDDEN]';
          const dis = btn.disabled ? ' [DISABLED]' : '';
          lines.push(`    "${btn.text}"${vis}${dis} classes="${btn.classes}" — ${btn.cssPath}`);
        }
        lines.push('');
      }

      // Inputs
      if (row.inputs.length > 0) {
        lines.push(`  Inputs:`);
        for (const inp of row.inputs) {
          lines.push(`    <input type="${inp.type}"> value="${inp.value}" placeholder="${inp.placeholder}" — ${inp.cssPath}`);
        }
        lines.push('');
      }

      // Raw HTML (truncated)
      lines.push(`  Raw HTML (first 1500 chars):`);
      lines.push(`  ${row.innerHTML.slice(0, 1500)}`);
      lines.push('');
    }

    // Section C: Interesting buttons
    lines.push(`SECTION C — INTERESTING BUTTONS`);
    lines.push(hr);
    if (report.buttons.length === 0) {
      lines.push('  No interesting buttons found.');
    }
    for (const btn of report.buttons) {
      const vis = btn.visible ? '' : ' [HIDDEN]';
      const dis = btn.disabled ? ' [DISABLED]' : '';
      lines.push(`  "${btn.text}"${vis}${dis}`);
      lines.push(`    Tag: <${btn.tag}>`);
      lines.push(`    Classes: ${btn.classes || 'none'}`);
      lines.push(`    data-testid: ${btn.dataTestId || 'none'}`);
      lines.push(`    aria-label: ${btn.ariaLabel || 'none'}`);
      lines.push(`    CSS path: ${btn.cssPath}`);
    }
    lines.push('');

    // Section D: data-testid elements
    lines.push(`SECTION D — DATA-TESTID ELEMENTS`);
    lines.push(hr);
    if (report.dataTestIds.length === 0) {
      lines.push('  None found.');
    }
    for (const el of report.dataTestIds) {
      lines.push(`  [data-testid="${el.testId}"] <${el.tag}> "${el.text}" — ${el.cssPath}`);
    }
    lines.push('');

    // Form inputs
    lines.push(`SECTION — FORM INPUTS`);
    lines.push(hr);
    const visibleInputs = report.inputs.filter(i => i.visible);
    const hiddenInputs = report.inputs.filter(i => !i.visible);
    lines.push(`  Visible: ${visibleInputs.length}, Hidden: ${hiddenInputs.length}`);
    for (const input of visibleInputs) {
      lines.push(`  <${input.tag}> type="${input.type}" name="${input.name || ''}" placeholder="${input.placeholder || ''}"`);
      lines.push(`    Classes: ${input.classes || 'none'}`);
      lines.push(`    data-testid: ${input.dataTestId || 'none'}`);
      lines.push(`    CSS path: ${input.cssPath}`);
    }
    lines.push('');

    // Tabs
    lines.push(`SECTION — TABS / NAVIGATION`);
    lines.push(hr);
    if (report.tabs.length === 0) {
      lines.push('  No tab-like elements found.');
    }
    for (const tab of report.tabs) {
      const sel = tab.isSelected ? ' [SELECTED]' : '';
      lines.push(`  "${tab.text}"${sel} <${tab.tag}> classes="${tab.classes}" — ${tab.cssPath}`);
    }
    lines.push('');

    // ARIA roles
    lines.push(`SECTION — ARIA ROLES`);
    lines.push(hr);
    if (report.ariaRoles.length === 0) {
      lines.push('  None found.');
    }
    for (const el of report.ariaRoles) {
      lines.push(`  role="${el.role}" <${el.tag}> "${el.text}" — ${el.cssPath}`);
    }
    lines.push('');

    // Modals
    if (report.modals.length > 0) {
      lines.push(`SECTION — MODALS / DIALOGS`);
      lines.push(hr);
      for (const m of report.modals) {
        const vis = m.visible ? 'VISIBLE' : 'HIDDEN';
        lines.push(`  [${vis}] <${m.tag}> classes="${m.classes}" — ${m.cssPath}`);
      }
      lines.push('');
    }

    lines.push(`URL: ${report.meta.url}`);
    lines.push(`END OF REPORT`);

    return lines.join('\n');
  }

  // ─── Legacy discovery (console logging) ──────────────────────
  function runDomDiscovery() {
    const report = runFullDiscovery();
    const formatted = formatReport(report);
    console.log('[LivePilot] DOM Discovery Report:\n' + formatted);

    chrome.runtime.sendMessage({
      source: 'live_console',
      type: 'dom_discovery_report',
      payload: { raw: report, formatted },
    }).catch(() => {});

    return report;
  }

  // ─── Message Handler ───────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type } = message;

    switch (type) {
      case 'ping': {
        sendResponse({ success: true, source: 'live_console', timestamp: Date.now() });
        break;
      }

      case 'get_product_list': {
        const products = scrapeProductList();
        // Strip DOM references before serializing for message passing
        const serializable = products.map(({ rowElement, ...rest }) => rest);
        sendResponse({ success: true, data: serializable });
        break;
      }

      case 'run_discovery': {
        const report = runFullDiscovery();
        const formatted = formatReport(report);
        sendResponse({ success: true, data: { raw: report, formatted } });
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown message type: ${type}` });
    }

    return false;
  });

  // ─── Product List Scraping ─────────────────────────────────────
  // Extract SKU from product name text. La Patina SKUs look like "S012260225154".
  function extractSku(nameText) {
    if (!nameText) return null;
    const match = nameText.match(/\b(S\d{12,})\b/);
    return match ? match[1] : null;
  }

  function scrapeProductList() {
    const { elements: rows } = findAllElements(SELECTORS.shoppingBag.productRow);

    if (rows.length === 0) {
      console.warn('[LivePilot Console] No product rows found in Shopping Bag');
      return [];
    }

    const products = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Filter out the "Product list in this LIVE" summary row —
      // it matches div.rounded-4.mb-8 but has no product name element
      const name = readText(SELECTORS.shoppingBag.productName, row);
      if (!name) continue;

      const price = readText(SELECTORS.shoppingBag.productPrice, row);
      const image = findElement(SELECTORS.shoppingBag.productImage, row).element;
      const sku = extractSku(name);

      products.push({
        index: products.length,
        id: sku || `row_${i}`,
        name,
        price: price || '',
        imageUrl: image?.src || '',
        rowElement: row,  // Keep reference for actions (NOT serialized in messages)
      });
    }

    console.info(`[LivePilot Console] Scraped ${products.length} products`);
    return products;
  }

  // ─── Chat Scraping ────────────────────────────────────────────
  // Scrape visible chat messages from the LIVE Console chat pane and emit
  // structured events. Three virtualized lists exist on this page (chat,
  // orders, viewer-activity); we disambiguate by walking up from the chat
  // textarea — see chat-probe.json (2026-05-02) and selectors.js > chat.
  //
  // DOM source has NO @handle access (TikTok hides it from the operator
  // side). We emit display_name + avatar_hash and let the server reconcile
  // identity if/when a WebSocket source ever sees the same viewer.
  //
  // Client-side dedup: same row stays in the virtualized list across many
  // poll cycles before scrolling out. We key by (display_name | avatar_hash
  // | message | second-bucket) and skip already-emitted rows. Server has
  // a unique index that catches whatever slips through.

  const CHAT = SELECTORS.chat;
  const seenChatKeys = new Set();
  const SEEN_KEYS_MAX = 2000;  // ~30-60 min of chat at typical rates

  // Extract the 32-char hex resource ID from a TikTok CDN avatar URL.
  // Path segment immediately before "~tplv-..." is the stable hash; the
  // resolution suffix and signature query string are NOT stable across
  // sources or time. See livepilot-v1.md > Identity Model.
  function extractAvatarHash(url) {
    if (!url) return null;
    try {
      const path = new URL(url, location.origin).pathname;  // strip query string
      const lastSeg = path.split('/').pop() || '';
      const beforeTilde = lastSeg.split('~')[0];            // chop resolution suffix
      // Validate it looks like a TikTok resource hash (32 lowercase hex chars).
      // If not, return whatever's there — server may still find a match.
      return /^[a-f0-9]{32}$/.test(beforeTilde) ? beforeTilde : (beforeTilde || null);
    } catch {
      return null;
    }
  }

  // Find the chat list element by anchoring on the chat textarea.
  // Cached because DOM walking on every poll is wasteful; re-resolved if
  // the cached node detaches (e.g., page navigation, panel re-render).
  let cachedChatList = null;
  function findChatList() {
    if (cachedChatList && cachedChatList.isConnected) return cachedChatList;
    const { element: ta } = findElement(CHAT.input);
    if (!ta) return null;
    let ancestor = ta.parentElement;
    for (let i = 0; i < 12 && ancestor; i++) {
      if (ancestor.className && ancestor.className.includes(CHAT.chatPaneAncestorClasses)) {
        const list = ancestor.querySelector('div.arco-list-content.arco-list-virtual');
        if (list) {
          cachedChatList = list;
          return list;
        }
      }
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  function scrapeChatMessages() {
    const list = findChatList();
    if (!list) return [];

    // Chat rows live two levels deep inside the virtualized list:
    //   list > height-spacer-div > transform-positioned-div > row > row > ...
    // Use the chatRow class signature to filter to actual chat rows
    // (excludes any sibling spacer/positioning divs the virtualizer adds).
    const rows = list.querySelectorAll(CHAT.chatRow[0]);
    const events = [];

    rows.forEach((row) => {
      // Skip rows that are clearly not chat (defense in depth — chatRow
      // class signature should already exclude these, but the lists do
      // share visual styling occasionally).
      if (row.matches(CHAT.purchaseRowMarker) || row.matches(CHAT.viewerActivityRowMarker)) return;

      const avatarImg = row.querySelector(CHAT.chatRowAvatarImg[0]);
      const nameEl = row.querySelector(CHAT.chatRowDisplayName[0]) || row.querySelector(CHAT.chatRowDisplayName[1]);
      const msgEl = row.querySelector(CHAT.chatRowMessage[0]) || row.querySelector(CHAT.chatRowMessage[1]);
      const badgeEl = row.querySelector(CHAT.chatRowBadge[0]);

      const display_name = nameEl?.textContent?.trim() || '';
      const raw_message = msgEl?.textContent?.trim() || '';
      const avatar_hash = extractAvatarHash(avatarImg?.src);
      const badge = badgeEl?.textContent?.trim() || null;

      // A row with no name AND no message is junk (e.g., system banner row
      // with just a notice div). Skip silently.
      if (!display_name || !raw_message) return;

      // Dedup key: content-only. Same row stays in the virtualized list
      // across many polls, so we MUST collapse on identity+message. The
      // tradeoff: a viewer spamming the SAME word multiple times gets
      // counted as one event. Acceptable for the DOM-only spike — the
      // server's second-bucket fallback dedup would collapse rapid spam
      // anyway, and the WebSocket source (when wired) carries
      // tiktok_message_id which resolves spam-vs-poll perfectly.
      const key = `${display_name}|${avatar_hash || 'noavatar'}|${raw_message}`;
      if (seenChatKeys.has(key)) return;
      seenChatKeys.add(key);

      events.push({
        display_name: display_name.slice(0, 200),
        avatar_hash,
        raw_message: raw_message.slice(0, 1000),  // server further caps for triage
        badge,                                    // "Host" / "Mod" / null — informational
        captured_at: new Date().toISOString(),
      });
    });

    // Keep the dedup set bounded (FIFO-ish via clear; trades a few duplicates
    // at the boundary for guaranteed unbounded-growth protection).
    if (seenChatKeys.size > SEEN_KEYS_MAX) {
      seenChatKeys.clear();
    }

    if (events.length > 0) {
      chrome.runtime.sendMessage({
        source: 'live_console',
        type: 'chat_messages',
        payload: { events, scraped_at: Date.now() },
      }).catch(() => {});
    }

    return events;
  }

  // ─── Polling loop: chat scraping only (auto-pin/flash removed 2026-05-03) ──
  setInterval(() => {
    if (!extensionContextValid) return;
    scrapeChatMessages();
  }, 1500);

  // ─── Auto-run discovery after a short delay ────────────────────
  setTimeout(() => {
    console.info('[LivePilot Console] Running initial DOM discovery...');
    runDomDiscovery();
  }, 3000);

})();
