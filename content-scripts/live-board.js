/**
 * live-board.js — Content script for the LIVE Board / Workbench page.
 *
 * Injected into:
 * - shop.tiktok.com/workbench/live/* (LIVE overview/analytics dashboard)
 * - shop.tiktok.com/live-board* (legacy)
 *
 * Uses the shared discovery library (lib/discovery.js) for comprehensive
 * page scanning. Reports all metrics, charts, tabs, tables, and interactive
 * elements so we can build the metric scraping and alerts.
 *
 * Depends on selectors.js, dom-adapter.js, and discovery.js (loaded before).
 */

(function () {
  'use strict';

  const { SELECTORS } = self.LivePilot;
  const { findElement, findAllElements, readText } = self.LivePilot.dom;
  const { registerWithServiceWorker, runPageDiscovery, formatDiscoveryReport, captureElement, cssPath } = self.LivePilot.discovery;

  // ─── Register with service worker ────────────────────────────
  let extensionContextValid = true;
  registerWithServiceWorker('live_board');

  // ─── Heartbeat: re-register periodically ──────────────────────
  setInterval(() => {
    if (!extensionContextValid) return;
    chrome.runtime.sendMessage({
      source: 'live_board',
      type: 'content_script_ready',
      payload: { url: location.href, timestamp: Date.now(), heartbeat: true },
    }).catch((err) => {
      if (err.message?.includes('Extension context invalidated')) {
        extensionContextValid = false;
        console.warn('[LivePilot Board] Extension context lost — stop heartbeat');
      }
    });
  }, 25000);

  // ─── Workbench-specific deep discovery ───────────────────────
  // The workbench/live/overview page has multiple tabs and sections.
  // We need to recursively discover all visible data on each sub-section.

  function runWorkbenchDiscovery() {
    // Run the shared page discovery first
    const report = runPageDiscovery('LIVE Board / Workbench');

    // Add workbench-specific deep inspection
    report.workbench = {
      // Overview cards (the big KPI cards at the top)
      overviewCards: [],
      // Time range selectors
      timeRanges: [],
      // Metric panels (detailed metric sections)
      metricPanels: [],
      // Navigation sidebar items
      sidebarItems: [],
      // All text content in metric areas (brute force capture)
      allVisibleText: [],
    };

    // 1. Find overview / KPI cards
    // These are typically card-like containers with a label + large number
    const cardCandidates = document.querySelectorAll(
      '[class*="card"], [class*="Card"], [class*="overview"], [class*="Overview"], [class*="kpi"], [class*="KPI"], [class*="stat"], [class*="Stat"], [class*="summary"], [class*="Summary"], [class*="metric"], [class*="Metric"], [class*="data-item"], [class*="indicator"]'
    );
    for (const card of cardCandidates) {
      if (card.offsetParent === null) continue; // hidden
      if (card.children.length > 15) continue; // too big, likely a container
      const text = card.textContent?.trim();
      if (!text || text.length > 300) continue;

      // Try to extract label + value pairs
      const labelValuePairs = [];
      // Look for number-text pairs within the card
      const innerElements = card.querySelectorAll('span, div, p, strong, b');
      for (const el of innerElements) {
        const directText = Array.from(el.childNodes)
          .filter(n => n.nodeType === Node.TEXT_NODE)
          .map(n => n.textContent.trim())
          .filter(t => t.length > 0)
          .join(' ');
        if (directText) {
          labelValuePairs.push({
            text: directText.slice(0, 60),
            tag: el.tagName.toLowerCase(),
            classes: el.className?.toString().slice(0, 80) || '',
            cssPath: cssPath(el),
            isNumber: /^[\$\-]?[\d,]+\.?\d*[%KMBk]?\s*$/.test(directText.replace(/\s/g, '')),
          });
        }
      }

      if (labelValuePairs.length > 0) {
        report.workbench.overviewCards.push({
          element: captureElement(card),
          cssPath: cssPath(card),
          fullText: text.slice(0, 200),
          pairs: labelValuePairs,
        });
      }
    }

    // 2. Find time range selectors (common in analytics dashboards)
    const timeSelectors = document.querySelectorAll(
      '[class*="time"], [class*="Time"], [class*="range"], [class*="Range"], [class*="period"], [class*="Period"], [class*="date"], [class*="Date"], [class*="filter"], [class*="Filter"]'
    );
    for (const el of timeSelectors) {
      if (el.offsetParent === null) continue;
      const text = el.textContent?.trim();
      if (!text || text.length > 100) continue;
      // Only capture if it looks like a time/date related control
      if (/today|yesterday|week|month|hour|minute|live|real.?time|last/i.test(text)) {
        report.workbench.timeRanges.push({
          ...captureElement(el),
          cssPath: cssPath(el),
        });
      }
    }

    // 3. Sidebar navigation
    const menuItems = document.querySelectorAll(
      '[role="menuitem"], [class*="menu-item"], [class*="MenuItem"], [class*="nav-item"], [class*="NavItem"], [class*="sidebar"] a, aside a'
    );
    for (const item of menuItems) {
      const text = item.textContent?.trim();
      if (!text || text.length > 60) continue;
      report.workbench.sidebarItems.push({
        text,
        href: item.getAttribute('href') || '',
        isActive: item.className?.includes('active') || item.className?.includes('selected') || item.getAttribute('aria-selected') === 'true',
        cssPath: cssPath(item),
      });
    }

    // 4. Brute-force: capture ALL visible text in the main content area
    // Walk the body and capture text from visible leaf-ish elements
    const mainContent = document.querySelector('main, [class*="content"], [class*="Content"], [role="main"]') || document.body;
    const textWalker = document.createTreeWalker(mainContent, NodeFilter.SHOW_ELEMENT);
    let node;
    let textCount = 0;
    while ((node = textWalker.nextNode()) && textCount < 200) {
      if (node.offsetParent === null) continue; // hidden
      if (node.children.length > 5) continue; // container, skip
      const directText = Array.from(node.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .filter(t => t.length > 0)
        .join(' ');
      if (directText && directText.length >= 2 && directText.length <= 100) {
        report.workbench.allVisibleText.push({
          text: directText,
          tag: node.tagName.toLowerCase(),
          classes: node.className?.toString().slice(0, 60) || '',
          cssPath: cssPath(node),
          isNumber: /^[\$\-]?[\d,]+\.?\d*[%KMBk]?\s*$/.test(directText.replace(/\s/g, '')),
        });
        textCount++;
      }
    }

    return report;
  }

  // ─── Format workbench-specific report section ────────────────
  function formatWorkbenchReport(report) {
    // Start with the shared format
    let formatted = formatDiscoveryReport(report);
    const lines = [formatted];
    const hr = '─'.repeat(50);

    lines.push('');
    lines.push(`WORKBENCH-SPECIFIC DISCOVERY`);
    lines.push(hr);

    // Overview cards
    if (report.workbench?.overviewCards?.length > 0) {
      lines.push('');
      lines.push('OVERVIEW / KPI CARDS:');
      for (let i = 0; i < report.workbench.overviewCards.length; i++) {
        const card = report.workbench.overviewCards[i];
        lines.push(`  Card #${i + 1}: "${card.fullText}"`);
        lines.push(`    Path: ${card.cssPath}`);
        lines.push(`    Label/value pairs inside:`);
        for (const p of card.pairs) {
          const flag = p.isNumber ? ' [NUMBER]' : '';
          lines.push(`      "${p.text}"${flag} <${p.tag}> classes="${p.classes}" — ${p.cssPath}`);
        }
      }
    }

    // Time range selectors
    if (report.workbench?.timeRanges?.length > 0) {
      lines.push('');
      lines.push('TIME RANGE SELECTORS:');
      for (const t of report.workbench.timeRanges) {
        lines.push(`  "${t.text}" <${t.tag}> — ${t.cssPath}`);
      }
    }

    // Sidebar
    if (report.workbench?.sidebarItems?.length > 0) {
      lines.push('');
      lines.push('SIDEBAR NAVIGATION:');
      for (const item of report.workbench.sidebarItems) {
        const active = item.isActive ? ' [ACTIVE]' : '';
        lines.push(`  "${item.text}"${active} href="${item.href}" — ${item.cssPath}`);
      }
    }

    // All visible text (the brute force capture)
    if (report.workbench?.allVisibleText?.length > 0) {
      lines.push('');
      lines.push('ALL VISIBLE TEXT (labels + values):');
      for (const t of report.workbench.allVisibleText) {
        const flag = t.isNumber ? ' [NUMBER]' : '';
        lines.push(`  "${t.text}"${flag} <${t.tag}> classes="${t.classes}" — ${t.cssPath}`);
      }
    }

    lines.push('');
    lines.push(`END OF WORKBENCH REPORT`);

    return lines.join('\n');
  }

  // ─── Message Handler ───────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type } = message;

    switch (type) {
      case 'ping': {
        sendResponse({ success: true, source: 'live_board', timestamp: Date.now() });
        break;
      }

      case 'run_discovery': {
        const report = runWorkbenchDiscovery();
        const formatted = formatWorkbenchReport(report);
        sendResponse({ success: true, data: { raw: report, formatted } });
        break;
      }

      case 'get_metrics': {
        // Stub — will scrape real metrics in Section 4
        // For now, try to extract whatever numbers we can find
        const metrics = {};
        const numberEls = document.querySelectorAll(
          '[class*="value"], [class*="count"], [class*="number"], [class*="metric"] span, [class*="stat"] span'
        );
        for (const el of numberEls) {
          if (el.offsetParent === null) continue;
          const text = el.textContent?.trim();
          if (text && /^\d/.test(text)) {
            const label = (el.previousElementSibling?.textContent?.trim() ||
                          el.parentElement?.getAttribute('aria-label') ||
                          el.className?.toString().slice(0, 40) || 'unknown').slice(0, 40);
            metrics[label] = text;
          }
        }
        sendResponse({ success: true, data: metrics });
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown message type: ${type}` });
    }

    return false;
  });

  // ─── Auto-run discovery ──────────────────────────────────────
  setTimeout(() => {
    console.info('[LivePilot Board] Running initial workbench discovery...');
    const report = runWorkbenchDiscovery();
    const formatted = formatWorkbenchReport(report);
    console.log('[LivePilot Board] Discovery Report:\n' + formatted);

    chrome.runtime.sendMessage({
      source: 'live_board',
      type: 'dom_discovery_report',
      payload: { raw: report, formatted },
    }).catch(() => {});
  }, 5000); // Wait longer — workbench pages have more async content

})();
