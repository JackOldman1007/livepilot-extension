/**
 * dom-adapter.js — DOM access layer for LivePilot content scripts.
 *
 * RULES:
 * - ALL DOM reads/queries in content scripts go through this adapter.
 * - NEVER use document.querySelector directly in action code.
 * - Always handle null returns — never assume an element exists.
 *
 * Supports two selector formats:
 * 1. Standard CSS: "button.arco-btn-primary" → uses querySelector
 * 2. Text match:   "text:button:Flash sale"  → finds <button> containing "Flash sale"
 *    Format: "text:<cssSelector>:<searchText>"
 *    - cssSelector: CSS selector to narrow candidates (e.g. "button", "div.tab")
 *    - searchText: case-insensitive text to match against textContent
 *
 * Loaded as a classic script by content scripts (no ES module export).
 * Depends on selectors.js being loaded first (self.LivePilot.SELECTORS).
 */

// Wrapped in an IIFE deliberately. The TikTok LIVE product dashboard URL
// (/streamer/live/product/dashboard) matches TWO manifest content_scripts
// entries — the broad "/streamer*" one and the product-dashboard one — so
// this file is injected TWICE into the same isolated world. Top-level
// const/let live in the shared global lexical scope, so the second injection
// threw "Identifier 'SELECTORS' has already been declared" and painted a red
// SyntaxError on the exact page we ask operators to debug auto-pin from.
// Function scope makes re-injection idempotent.
(function () {
  'use strict';

  self.LivePilot = self.LivePilot || {};


  // ─── Text-based element matching ──────────────────────────────────
  const TEXT_PREFIX = 'text:';

  // ─── Failed-selector warning throttle ────────────────────────────
  // Stale selectors fire on every poll cycle (every 3s for product/pin
  // scraping). Without throttling, one broken chain produces ~20 warnings
  // per minute and floods the console so badly that operator can't see
  // their own diagnostic output. Throttle to one warn per chain per 5 min.
  const SELECTOR_WARN_THROTTLE_MS = 5 * 60 * 1000;
  const lastWarnedAt = new Map(); // chain key → epoch ms

  function _maybeWarnSelectorChainFailed(label, selectorChain) {
    const key = label + '|' + JSON.stringify(selectorChain);
    const now = Date.now();
    const last = lastWarnedAt.get(key) || 0;
    if (now - last < SELECTOR_WARN_THROTTLE_MS) return;
    lastWarnedAt.set(key, now);
    console.warn(`[LivePilot DOM] ${label}:`, selectorChain);
  }

  /**
   * Parse a text: selector into its parts.
   * Format: "text:cssSelector:searchText"
   * @returns {{ cssSelector: string, searchText: string } | null}
   */
  function parseTextSelector(selector) {
    if (!selector.startsWith(TEXT_PREFIX)) return null;
    const rest = selector.slice(TEXT_PREFIX.length);
    const colonIndex = rest.indexOf(':');
    if (colonIndex === -1) return null;
    return {
      cssSelector: rest.slice(0, colonIndex),
      searchText: rest.slice(colonIndex + 1).toLowerCase(),
    };
  }

  /**
   * Find an element matching a text: selector.
   * @param {string} selector - text:cssSelector:searchText
   * @param {Element} root
   * @returns {Element|null}
   */
  function findByText(selector, root) {
    const parsed = parseTextSelector(selector);
    if (!parsed) return null;

    const candidates = root.querySelectorAll(parsed.cssSelector);
    for (const el of candidates) {
      const text = el.textContent.trim().toLowerCase();
      // Match if the element's direct text contains the search text
      // Prefer exact or near-exact matches to avoid matching parent containers
      if (text === parsed.searchText || text.startsWith(parsed.searchText)) {
        return el;
      }
    }
    // Fallback: contains match (less precise)
    for (const el of candidates) {
      if (el.textContent.trim().toLowerCase().includes(parsed.searchText)) {
        return el;
      }
    }
    return null;
  }

  /**
   * Find all elements matching a text: selector.
   * @param {string} selector
   * @param {Element} root
   * @returns {Element[]}
   */
  function findAllByText(selector, root) {
    const parsed = parseTextSelector(selector);
    if (!parsed) return [];

    const candidates = root.querySelectorAll(parsed.cssSelector);
    return Array.from(candidates).filter((el) =>
      el.textContent.trim().toLowerCase().includes(parsed.searchText)
    );
  }

  // ─── Core selector resolution ──────────────────────────────────────

  /**
   * Try a single selector (CSS or text:) against a root element.
   * @param {string} selector
   * @param {Element} root
   * @returns {Element|null}
   */
  function resolveSelector(selector, root) {
    if (selector.startsWith(TEXT_PREFIX)) {
      return findByText(selector, root);
    }
    try {
      return root.querySelector(selector);
    } catch (err) {
      console.warn(`[LivePilot DOM] Invalid selector "${selector}":`, err.message);
      return null;
    }
  }

  /**
   * Try a single selector for all matches.
   * @param {string} selector
   * @param {Element} root
   * @returns {Element[]}
   */
  function resolveSelectorAll(selector, root) {
    if (selector.startsWith(TEXT_PREFIX)) {
      return findAllByText(selector, root);
    }
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (err) {
      console.warn(`[LivePilot DOM] Invalid selector "${selector}":`, err.message);
      return [];
    }
  }

  /**
   * Try each selector in a chain until one matches.
   * @param {string[]} selectorChain - Array of CSS/text selectors, most-specific first
   * @param {Element} [root=document] - Root element to search within
   * @returns {{ element: Element|null, selectorUsed: string|null, fallbackIndex: number }}
   */
  function findElement(selectorChain, root = document) {
    if (!Array.isArray(selectorChain) || selectorChain.length === 0) {
      console.warn('[LivePilot DOM] findElement called with empty selector chain');
      return { element: null, selectorUsed: null, fallbackIndex: -1 };
    }

    for (let i = 0; i < selectorChain.length; i++) {
      const selector = selectorChain[i];
      const el = resolveSelector(selector, root);
      if (el) {
        if (i > 0) {
          console.info(
            `[LivePilot DOM] Primary selector failed, used fallback #${i}: "${selector}"`
          );
        }
        return { element: el, selectorUsed: selector, fallbackIndex: i };
      }
    }

    // All selectors exhausted
    _maybeWarnSelectorChainFailed('All selectors failed', selectorChain);
    return { element: null, selectorUsed: null, fallbackIndex: -1 };
  }

  /**
   * Find all elements matching the first successful selector in a chain.
   * @param {string[]} selectorChain
   * @param {Element} [root=document]
   * @returns {{ elements: Element[], selectorUsed: string|null, fallbackIndex: number }}
   */
  function findAllElements(selectorChain, root = document) {
    if (!Array.isArray(selectorChain) || selectorChain.length === 0) {
      console.warn('[LivePilot DOM] findAllElements called with empty selector chain');
      return { elements: [], selectorUsed: null, fallbackIndex: -1 };
    }

    for (let i = 0; i < selectorChain.length; i++) {
      const selector = selectorChain[i];
      const els = resolveSelectorAll(selector, root);
      if (els.length > 0) {
        if (i > 0) {
          console.info(
            `[LivePilot DOM] Primary selector failed, used fallback #${i}: "${selector}"`
          );
        }
        return { elements: els, selectorUsed: selector, fallbackIndex: i };
      }
    }

    _maybeWarnSelectorChainFailed('All selectors failed (findAll)', selectorChain);
    return { elements: [], selectorUsed: null, fallbackIndex: -1 };
  }

  /**
   * Read text content from the first element matching a selector chain.
   * @param {string[]} selectorChain
   * @param {Element} [root=document]
   * @returns {string|null}
   */
  function readText(selectorChain, root = document) {
    const { element } = findElement(selectorChain, root);
    return element ? element.textContent.trim() : null;
  }

  /**
   * Randomized delay between automated actions (200-500ms).
   * NEVER use a fixed delay for automated clicks.
   * @param {number} [min=200]
   * @param {number} [max=500]
   * @returns {Promise<void>}
   */
  function delay(min = 200, max = 500) {
    const ms = min + Math.random() * (max - min);
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Set a React controlled input's value using native value setter.
   * React overrides the input's value property, so direct assignment doesn't
   * trigger React's onChange. The native setter + input event bypasses this.
   * @param {HTMLInputElement} input
   * @param {string} value
   */
  function setReactInputValue(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value'
    ).set;
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Click an element with a randomized delay, simulating human behavior.
   * @param {Element} el
   * @param {number} [minDelay=200]
   * @param {number} [maxDelay=500]
   */
  async function humanClick(el, minDelay = 200, maxDelay = 500) {
    await delay(minDelay, maxDelay);
    el.click();
  }

  // Expose on global namespace for content scripts
  self.LivePilot.dom = {
    findElement,
    findAllElements,
    readText,
    delay,
    setReactInputValue,
    humanClick,
  };
})();
