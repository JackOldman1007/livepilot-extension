/**
 * scan-diagnostics.js — what did the activity scanner actually see?
 * (Inventory BUG-0104, tracker 2026-09-15)
 *
 * After the 2026-09-04 build shipped, the Inventory server recorded 189
 * comment-based requests and ZERO activity-based ones across 11 lives. No
 * viewer_activity event ever left the operator PC, and nothing reported
 * which build was running or what the page rendered — so "extension never
 * reloaded" and "the activity rows live somewhere the selector does not
 * look" were indistinguishable from the server.
 *
 * buildScanSample() produces a bounded, text-only description of one scan:
 *   - how many Arco virtual lists exist and the first rows of each
 *   - every activity-shaped line in the WHOLE page text, independent of
 *     the list selector (if these are non-empty while the list samples
 *     carry no activity hits, the selector is the bug; if both are empty
 *     during a live, TikTok renders activity somewhere without text)
 * live-console.js sends it through the service worker to
 * POST /api/livepilot/v1/diagnostics roughly once a minute.
 *
 * Plain script (no ES exports): loaded as a content-script dependency and
 * registered on self.LivePilot.diagnostics; the node test loads it via vm.
 */
(function (root) {
  'use strict';

  const SAMPLE_MAX_ROWS = 30;
  const SAMPLE_MAX_TEXT = 300;
  // Mirrors the cheap pre-filter in live-console.scrapeViewerActivity and the
  // three forwarded verbs in activity-classifier.js.
  const ACTIVITY_PREFILTER = /interested in|to cart|ask(?:ed|s)? to (?:show|see)/i;

  // Only line breaks/tabs are folded — the double space TikTok renders before
  // "No." is real and the server-side regex depends on seeing it verbatim.
  const clip = (s) => String(s || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, SAMPLE_MAX_TEXT);

  function stripQuery(url) {
    const s = String(url || '');
    const cut = s.search(/[?#]/);
    return cut >= 0 ? s.slice(0, cut) : s;
  }

  /**
   * @param {object} input
   * @param {Array<{rows: string[]}>} input.lists - text of every row of every virtual list, in DOM order
   * @param {string} input.bodyText - document.body.innerText (or equivalent)
   * @param {string} input.pageUrl - location.href
   */
  function buildScanSample({ lists = [], bodyText = '', pageUrl = '' } = {}) {
    const outLists = lists.map((l) => {
      const rows = Array.isArray(l?.rows) ? l.rows : [];
      const seen = new Set();
      const sample = [];
      let activityHits = 0;
      for (const raw of rows) {
        const t = clip(raw);
        if (!t) continue;
        if (ACTIVITY_PREFILTER.test(t)) activityHits += 1;
        if (seen.has(t) || sample.length >= SAMPLE_MAX_ROWS) continue;
        seen.add(t);
        sample.push(t);
      }
      return { rows: rows.length, sample, activity_hits: activityHits };
    });

    const bodyLines = String(bodyText || '').split(/\r?\n/);
    let bodyTotal = 0;
    const bodyActivity = [];
    for (const line of bodyLines) {
      const t = clip(line);
      if (!t || !ACTIVITY_PREFILTER.test(t)) continue;
      bodyTotal += 1;
      if (bodyActivity.length < SAMPLE_MAX_ROWS) bodyActivity.push(t);
    }

    return {
      page_url: stripQuery(pageUrl),
      lists_found: lists.length,
      lists: outLists,
      body_activity_lines: bodyActivity,
      body_activity_total: bodyTotal,
    };
  }

  root.LivePilot = root.LivePilot || {};
  root.LivePilot.diagnostics = { buildScanSample, ACTIVITY_PREFILTER, SAMPLE_MAX_ROWS, SAMPLE_MAX_TEXT };
})(typeof self !== 'undefined' ? self : globalThis);
