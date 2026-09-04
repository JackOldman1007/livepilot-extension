/**
 * activity-classifier.js — classify TikTok LIVE console viewer-activity
 * lines (Inventory tracker 2026-09: "Expand Request List data collection to
 * also capture customer interest activities from the activity feed").
 *
 * The LIVE console renders viewer activity as one-line system rows inside the
 * same Arco virtual list as chat, e.g. (real captures, data/viewers.json —
 * note the DOUBLE space before "No."):
 *   "JULIE🍒 is interested in this product  No.19"
 *   "African hair braiding added a product to cart  No.72"
 *   "amy asked to show product No.3"
 *
 * live-console.js used to DISCARD these rows (they were only an exclusion
 * marker). It now sends them to the Inventory ingest as chat events tagged
 * event_type: 'viewer_activity'; the server-side detector
 * (livepilotIngest.detectRequestFromEvent) turns them into Request List rows
 * with source='activity'. This file only decides WHICH rows are worth
 * sending and splits the viewer name off the sentence.
 *
 * Plain script (no ES exports) because it is loaded as a content-script
 * dependency; it registers on self.LivePilot.activity. The node test loads
 * it through vm with a stub `self`.
 */
(function (root) {
  'use strict';

  const PRODUCT_NO = '(?:\\s+(?:this|the))?(?:\\s+product)?\\s*No\\.?\\s*(\\d{1,4})';
  // Order matters only for the `type` label; every pattern anchors on the
  // verb phrase so the viewer name is whatever precedes it.
  const PATTERNS = [
    { type: 'add_to_cart',   re: new RegExp('^(.*?)\\s+added (?:a product to cart)?' + PRODUCT_NO, 'i') },
    { type: 'interested_in', re: new RegExp('^(.*?)\\s+is interested in' + PRODUCT_NO, 'i') },
    { type: 'ask_to_show',   re: new RegExp('^(.*?)\\s+ask(?:ed|s)? to (?:show|see)' + PRODUCT_NO, 'i') },
    { type: 'viewing',       re: new RegExp('^(.*?)\\s+is viewing' + PRODUCT_NO, 'i') },
  ];

  // Types the Inventory Request List acts on. 'viewing' is classified but
  // not forwarded — it is noise at live volume and the server ignores it.
  const FORWARDED = new Set(['add_to_cart', 'interested_in', 'ask_to_show']);

  /**
   * @param {string} text - full textContent of one activity row
   * @returns {null | { type, user, productNo, forward: boolean }}
   */
  function classifyActivityLine(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 200) return null;
    for (const { type, re } of PATTERNS) {
      const m = t.match(re);
      if (!m) continue;
      const user = (m[1] || '').trim();
      // TikTok sometimes renders a bare numeric internal id as the name.
      if (!user || /^\d{10,}$/.test(user)) return null;
      return { type, user, productNo: m[2], forward: FORWARDED.has(type) };
    }
    return null;
  }

  const api = { classifyActivityLine, FORWARDED_ACTIVITY_TYPES: FORWARDED };
  root.LivePilot = root.LivePilot || {};
  root.LivePilot.activity = api;
})(typeof self !== 'undefined' ? self : globalThis);
