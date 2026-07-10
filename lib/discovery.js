/**
 * discovery.js — Shared DOM discovery functions for LivePilot content scripts.
 *
 * Used by both live-console.js and live-board.js to produce comprehensive
 * discovery reports of any TikTok page. Reports are formatted as plain text
 * for easy copy-paste by non-technical operators.
 *
 * Loaded as a classic script before content scripts.
 * Attaches to self.LivePilot.discovery namespace.
 */

self.LivePilot = self.LivePilot || {};

(function () {
  'use strict';

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

  // ─── Helper: register with service worker (with retry) ───────
  async function registerWithServiceWorker(source, retries = 3, delayMs = 1000) {
    for (let i = 0; i < retries; i++) {
      try {
        const resp = await chrome.runtime.sendMessage({
          source,
          type: 'content_script_ready',
          payload: { url: location.href, timestamp: Date.now() },
        });
        console.info(`[LivePilot ${source}] Registered with service worker (attempt ${i + 1})`);
        return resp;
      } catch (err) {
        // Extension was reloaded — this content script is orphaned
        if (err.message?.includes('Extension context invalidated')) {
          console.warn(`[LivePilot ${source}] Extension reloaded — content script orphaned. Reload the page.`);
          return null;
        }
        console.warn(`[LivePilot ${source}] Registration attempt ${i + 1} failed:`, err.message);
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, delayMs * (i + 1)));  // exponential backoff
        }
      }
    }
    console.error(`[LivePilot ${source}] Failed to register after all retries`);
  }

  // ─── Full page discovery ─────────────────────────────────────
  function runPageDiscovery(pageName) {
    const { SELECTORS } = self.LivePilot;
    const { findElement, findAllElements } = self.LivePilot.dom;

    const report = {
      meta: {
        timestamp: new Date().toISOString(),
        url: location.href,
        title: document.title,
        pageName,
        userAgent: navigator.userAgent,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        iframeCount: document.querySelectorAll('iframe').length,
      },
      selectorResults: {},
      sections: [],
      metrics: [],
      buttons: [],
      inputs: [],
      dataTestIds: [],
      ariaRoles: [],
      tabs: [],
      charts: [],
      tables: [],
      numbers: [],
    };

    // 1. Test all predefined selectors
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

    // 2. Find page sections (headings, cards, panels)
    const sectionEls = document.querySelectorAll(
      'h1, h2, h3, h4, [class*="title"], [class*="heading"], [class*="header"], [class*="card"], [class*="panel"], [class*="section"], [class*="widget"], [class*="module"], [class*="overview"]'
    );
    const seenSections = new Set();
    for (const el of sectionEls) {
      const text = el.textContent?.trim().slice(0, 100);
      if (!text || text.length < 2 || seenSections.has(text)) continue;
      // Only capture leaf-ish sections (not huge containers)
      if (el.children.length > 20) continue;
      seenSections.add(text);
      report.sections.push({
        ...captureElement(el),
        cssPath: cssPath(el),
        childCount: el.children.length,
        visible: el.offsetParent !== null,
      });
    }

    // 3. Find all metric-like elements (numbers with labels)
    // Look for patterns: number + label pairs, stat cards, KPI displays
    const metricCandidates = document.querySelectorAll(
      '[class*="metric"], [class*="stat"], [class*="kpi"], [class*="indicator"], [class*="value"], [class*="count"], [class*="number"], [class*="amount"], [class*="rate"], [class*="percent"], [class*="overview"], [class*="summary"], [class*="data-item"], [class*="data_item"]'
    );
    for (const el of metricCandidates) {
      const text = el.textContent?.trim();
      if (!text || text.length > 200 || text.length < 1) continue;
      // Only capture if it contains a number
      if (/\d/.test(text)) {
        report.metrics.push({
          ...captureElement(el),
          cssPath: cssPath(el),
          visible: el.offsetParent !== null,
        });
      }
    }

    // 4. Find number-bearing elements more aggressively
    // Walk visible elements and find ones whose direct text is a number/percentage/currency
    const allElements = document.querySelectorAll('span, div, p, td, th, strong, b, em');
    for (const el of allElements) {
      if (el.offsetParent === null) continue; // skip hidden
      if (el.children.length > 3) continue; // skip containers
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join(' ');
      if (!directText || directText.length > 50) continue;
      // Match: $123, 45.6%, 1,234, 0.5K, etc.
      if (/^[\$]?[\d,]+\.?\d*[%KMBk]?$/.test(directText.replace(/\s/g, '')) ||
          /^\d+\.?\d*\s*%$/.test(directText)) {
        report.numbers.push({
          value: directText,
          tag: el.tagName.toLowerCase(),
          classes: el.className?.toString().slice(0, 80) || '',
          cssPath: cssPath(el),
          // Look for a sibling/parent label
          parentText: el.parentElement?.textContent?.trim().slice(0, 80) || '',
          siblingLabel: (el.previousElementSibling?.textContent?.trim() ||
                        el.nextElementSibling?.textContent?.trim() || '').slice(0, 60),
        });
      }
    }

    // 5. All buttons
    const allButtons = document.querySelectorAll('button, [role="button"], a[class*="btn"]');
    for (const btn of allButtons) {
      const text = btn.textContent?.trim();
      if (!text || text.length > 100) continue;
      report.buttons.push({
        ...captureElement(btn),
        cssPath: cssPath(btn),
        disabled: btn.disabled || btn.getAttribute('aria-disabled') === 'true',
        visible: btn.offsetParent !== null,
        href: btn.tagName === 'A' ? btn.getAttribute('href') : null,
      });
    }

    // 6. All form inputs
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

    // 7. data-testid elements
    const testIdEls = document.querySelectorAll('[data-testid]');
    for (const el of testIdEls) {
      report.dataTestIds.push({
        testId: el.getAttribute('data-testid'),
        tag: el.tagName.toLowerCase(),
        text: el.textContent?.trim().slice(0, 50),
        cssPath: cssPath(el),
      });
    }

    // 8. ARIA roles
    const roleEls = document.querySelectorAll(
      '[role="tab"], [role="tablist"], [role="tabpanel"], [role="list"], [role="listitem"], [role="dialog"], [role="menu"], [role="menuitem"], [role="toolbar"], [role="grid"], [role="row"], [role="cell"]'
    );
    for (const el of roleEls) {
      report.ariaRoles.push({
        role: el.getAttribute('role'),
        ...captureElement(el),
        cssPath: cssPath(el),
      });
    }

    // 9. Tab navigation
    const tabLike = document.querySelectorAll('[role="tab"], [class*="tab-"], [class*="Tab"]');
    for (const el of tabLike) {
      const text = el.textContent?.trim();
      if (!text || text.length > 80) continue;
      report.tabs.push({
        ...captureElement(el),
        cssPath: cssPath(el),
        isSelected: el.getAttribute('aria-selected') === 'true' ||
                    el.classList.contains('active') ||
                    el.className?.includes('active'),
      });
    }

    // 10. Charts / graphs (canvas, svg, chart containers)
    const chartEls = document.querySelectorAll(
      'canvas, svg[class*="chart"], svg[class*="graph"], [class*="chart"], [class*="Chart"], [class*="graph"], [class*="Graph"], [class*="recharts"], [class*="echarts"], [class*="apexcharts"]'
    );
    for (const el of chartEls) {
      report.charts.push({
        ...captureElement(el),
        cssPath: cssPath(el),
        width: el.offsetWidth,
        height: el.offsetHeight,
        tagName: el.tagName.toLowerCase(),
        visible: el.offsetParent !== null,
      });
    }

    // 11. Tables
    const tableEls = document.querySelectorAll('table, [class*="table"], [role="grid"]');
    for (const el of tableEls) {
      const rows = el.querySelectorAll('tr, [role="row"]');
      const headers = el.querySelectorAll('th, thead td');
      report.tables.push({
        ...captureElement(el),
        cssPath: cssPath(el),
        rowCount: rows.length,
        headerTexts: Array.from(headers).map(h => h.textContent?.trim().slice(0, 40)),
        visible: el.offsetParent !== null,
      });
    }

    return report;
  }

  // ─── Format discovery report as plain text ───────────────────
  function formatDiscoveryReport(report) {
    const lines = [];
    const hr = '─'.repeat(50);

    lines.push(`LIVEPILOT DOM DISCOVERY REPORT — ${report.meta.pageName || 'Unknown Page'}`);
    lines.push(hr);
    lines.push(`Date: ${report.meta.timestamp}`);
    lines.push(`URL: ${report.meta.url}`);
    lines.push(`Page title: ${report.meta.title}`);
    lines.push(`Viewport: ${report.meta.viewportWidth}x${report.meta.viewportHeight}`);
    lines.push(`Iframes: ${report.meta.iframeCount}`);
    lines.push('');

    // Selector results
    lines.push(`SELECTOR TEST RESULTS`);
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
          if (result.element.id) lines.push(`    ID: ${result.element.id}`);
          if (result.element.dataTestId) lines.push(`    data-testid: ${result.element.dataTestId}`);
          if (result.element.ariaLabel) lines.push(`    aria-label: ${result.element.ariaLabel}`);
          if (result.element.dataAttributes) lines.push(`    data-*: ${result.element.dataAttributes}`);
          lines.push(`    Text: "${result.element.text}"`);
          lines.push(`    CSS path: ${result.cssPath}`);
          lines.push(`    Matches: ${result.matchCount}`);
        }
      }
      lines.push('');
    }

    // Numbers / metrics discovered
    if (report.numbers.length > 0) {
      lines.push(`NUMBERS & METRICS FOUND`);
      lines.push(hr);
      for (const n of report.numbers) {
        const label = n.siblingLabel || n.parentText.replace(n.value, '').trim().slice(0, 40);
        lines.push(`  "${n.value}" ← label: "${label}"`);
        lines.push(`    <${n.tag}> classes="${n.classes}" — ${n.cssPath}`);
      }
      lines.push('');
    }

    // Metric-class elements
    if (report.metrics.length > 0) {
      lines.push(`METRIC-CLASS ELEMENTS`);
      lines.push(hr);
      for (const m of report.metrics) {
        const vis = m.visible ? '' : ' [HIDDEN]';
        lines.push(`  "${m.text}"${vis}`);
        lines.push(`    <${m.tag}> classes="${m.classes}" — ${m.cssPath}`);
      }
      lines.push('');
    }

    // Tabs
    if (report.tabs.length > 0) {
      lines.push(`TABS / NAVIGATION`);
      lines.push(hr);
      for (const tab of report.tabs) {
        const sel = tab.isSelected ? ' [SELECTED]' : '';
        lines.push(`  "${tab.text}"${sel} <${tab.tag}> — ${tab.cssPath}`);
      }
      lines.push('');
    }

    // Charts
    if (report.charts.length > 0) {
      lines.push(`CHARTS / GRAPHS`);
      lines.push(hr);
      for (const c of report.charts) {
        lines.push(`  <${c.tagName}> ${c.width}x${c.height} classes="${c.classes}" — ${c.cssPath}`);
      }
      lines.push('');
    }

    // Tables
    if (report.tables.length > 0) {
      lines.push(`TABLES`);
      lines.push(hr);
      for (const t of report.tables) {
        lines.push(`  ${t.rowCount} rows, headers: [${t.headerTexts.join(', ')}]`);
        lines.push(`    <${t.tag}> classes="${t.classes}" — ${t.cssPath}`);
      }
      lines.push('');
    }

    // Buttons
    lines.push(`BUTTONS`);
    lines.push(hr);
    for (const btn of report.buttons) {
      const vis = btn.visible ? '' : ' [HIDDEN]';
      const dis = btn.disabled ? ' [DISABLED]' : '';
      lines.push(`  "${btn.text}"${vis}${dis}`);
      lines.push(`    <${btn.tag}> classes="${btn.classes || 'none'}" — ${btn.cssPath}`);
    }
    lines.push('');

    // Inputs
    const visibleInputs = report.inputs.filter(i => i.visible);
    if (visibleInputs.length > 0) {
      lines.push(`FORM INPUTS (visible: ${visibleInputs.length})`);
      lines.push(hr);
      for (const inp of visibleInputs) {
        lines.push(`  <${inp.tag}> type="${inp.type}" placeholder="${inp.placeholder || ''}" name="${inp.name || ''}" — ${inp.cssPath}`);
      }
      lines.push('');
    }

    // data-testid
    if (report.dataTestIds.length > 0) {
      lines.push(`DATA-TESTID ELEMENTS`);
      lines.push(hr);
      for (const el of report.dataTestIds) {
        lines.push(`  [data-testid="${el.testId}"] <${el.tag}> "${el.text}" — ${el.cssPath}`);
      }
      lines.push('');
    } else {
      lines.push(`DATA-TESTID ELEMENTS: None found.`);
      lines.push('');
    }

    // ARIA roles (abbreviated)
    const importantRoles = report.ariaRoles.filter(r =>
      ['tab', 'tablist', 'dialog', 'grid', 'toolbar'].includes(r.role)
    );
    if (importantRoles.length > 0) {
      lines.push(`ARIA ROLES (key ones)`);
      lines.push(hr);
      for (const el of importantRoles) {
        lines.push(`  role="${el.role}" <${el.tag}> "${el.text}" — ${el.cssPath}`);
      }
      lines.push('');
    }

    // Sections / headings
    const visibleSections = report.sections.filter(s => s.visible).slice(0, 30);
    if (visibleSections.length > 0) {
      lines.push(`PAGE SECTIONS / HEADINGS`);
      lines.push(hr);
      for (const s of visibleSections) {
        lines.push(`  "${s.text}" <${s.tag}> classes="${s.classes}" — ${s.cssPath}`);
      }
      lines.push('');
    }

    lines.push(`URL: ${report.meta.url}`);
    lines.push(`END OF REPORT`);

    return lines.join('\n');
  }

  // Expose
  self.LivePilot.discovery = {
    captureElement,
    cssPath,
    registerWithServiceWorker,
    runPageDiscovery,
    formatDiscoveryReport,
  };

})();
