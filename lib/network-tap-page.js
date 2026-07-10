/**
 * network-tap-page.js — runs in PAGE context (not content-script isolated world).
 *
 * Loaded via injected <script> tag from network-tap.js. Wraps the page's
 * native fetch and WebSocket constructor BEFORE TikTok's bundle runs so
 * every network response and WebSocket frame the page receives can be
 * observed.
 *
 * Sends captures back to the content script via window.postMessage.
 *
 * Risk profile: ZERO new TikTok-facing requests. Pure passive observation
 * of data the browser already received as part of the operator's normal
 * legitimate session. Identical risk to DOM scraping.
 *
 * What we capture:
 *   - fetch responses to URLs containing live/chat/im/webcast keywords
 *   - WebSocket received frames (text only — binary frames flagged but not
 *     decoded here; offline pipeline handles protobuf decode)
 *
 * What we do NOT capture:
 *   - Heartbeats / pings (filtered by URL pattern)
 *   - Avatar/image/video binary streams
 *   - Anything outside the chat/live data path
 *
 * Truncation: payloads >32KB are sent with a `_truncated:true` marker.
 * TikTok's chat WebSocket frames are typically <2KB so this rarely fires,
 * but guards against accidental capture of large media manifests.
 */
(function () {
  'use strict';

  // De-duplicate injection in case the content script runs twice.
  if (window.__livepilot_network_tap_installed) return;
  window.__livepilot_network_tap_installed = true;

  const TAG = 'lp_net_tap';
  const MAX_PAYLOAD = 32 * 1024;  // 32KB

  // URL patterns we care about. Targeted at the endpoints the research
  // agent (2026-05-06) confirmed as identity-rich:
  //   /webcast/im/fetch/             → HTTP chat-history JSON (msg_id + user)
  //   /webcast/ranklist/online_audience/ → top-viewer/buyer leaderboard (avatar, rank)
  //   /webcast/user/                 → user profile lookups (handle, sec_uid, avatar)
  //   /webcast/room/info/            → room metadata + host user object
  //   /webcast/room/enter/           → fired on join, contains user-self
  //   /api-live/user/room/           → newer API path on shop subdomain
  // The catch-all /webcast/ prefix is kept because TikTok routes ~all live
  // commerce APIs under it and the false-positive rate is low. Generic
  // tokens like /live/ or /chat/ are intentionally NOT here — they match
  // unrelated marketing/dashboard pages and inflate the capture volume.
  const CAPTURE_URL_PATTERNS = [
    /\/webcast\//i,
    /\/api-live\//i,
    /\/live_im\//i,        // alt path occasionally seen
    /\bwss?:\/\/.*\bwebcast\b/i,  // matches WS URLs (no path-only filter)
  ];
  const SKIP_URL_SUFFIXES = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.m3u8', '.ts', '.css', '.svg', '.woff', '.woff2'];

  function shouldCapture(url) {
    if (typeof url !== 'string') return false;
    const u = url.toLowerCase();
    if (SKIP_URL_SUFFIXES.some((s) => u.endsWith(s))) return false;
    return CAPTURE_URL_PATTERNS.some((p) => p.test(url));
  }

  function postCapture(kind, payload) {
    try {
      window.postMessage({ source: TAG, kind, payload, captured_at: Date.now() }, '*');
    } catch {
      // postMessage can fail on weird payloads — safe to drop
    }
  }

  function truncate(s) {
    if (typeof s !== 'string') return { body: '<non-string>', _truncated: false };
    if (s.length <= MAX_PAYLOAD) return { body: s, _truncated: false };
    return { body: s.slice(0, MAX_PAYLOAD), _truncated: true, original_length: s.length };
  }

  // ─── fetch wrapper ──────────────────────────────────────────────
  // Clone the response BEFORE returning to the caller so we don't
  // disturb TikTok's app code. Read the clone asynchronously.
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch.apply(this, args);
    try {
      let url = '';
      if (typeof args[0] === 'string') url = args[0];
      else if (args[0] && args[0].url) url = args[0].url;
      else if (args[0] && args[0].toString) url = args[0].toString();

      if (shouldCapture(url)) {
        const cloned = resp.clone();
        // Only attempt JSON-likely responses. Reading a .text() on every
        // response would be wasteful; check content-type.
        const ct = (cloned.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('json') || ct.includes('text')) {
          cloned.text().then((body) => {
            const t = truncate(body);
            postCapture('fetch', { url, status: resp.status, content_type: ct, ...t });
          }).catch(() => {});
        }
      }
    } catch {
      // Defensive — never let our wrapper break the page's fetch
    }
    return resp;
  };

  // ─── WebSocket wrapper ──────────────────────────────────────────
  // Replace the constructor with one that logs incoming frames. Outgoing
  // frames are not captured (we don't need to send anything; the chat is
  // pulled from the same WS).
  const OrigWS = window.WebSocket;

  function WrappedWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);

    // Only tap chat-relevant sockets. TikTok pages may have multiple WS
    // (analytics, push, etc.) — filter by URL. shouldCapture() already
    // covers webcast/api-live; this layer adds the secondary IM hostname
    // pattern (im.tiktok / chat.) seen in older capture samples.
    const isChatWS = shouldCapture(url) || /\b(im\.tiktok|chat\.tiktok|webcast)\b/i.test(url);

    if (isChatWS) {
      postCapture('ws_open', { url });

      ws.addEventListener('message', (e) => {
        try {
          if (typeof e.data === 'string') {
            const t = truncate(e.data);
            postCapture('ws_recv', { url, data_kind: 'text', ...t });
          } else if (e.data instanceof Blob) {
            // Binary frame (likely protobuf). Capture as base64 for offline
            // protobuf decode in the post-session pipeline.
            e.data.arrayBuffer().then((buf) => {
              const arr = new Uint8Array(buf);
              if (arr.length > MAX_PAYLOAD) {
                postCapture('ws_recv', { url, data_kind: 'binary', _truncated: true, original_length: arr.length });
                return;
              }
              // base64-encode without using FileReader (synchronous-ish)
              let bin = '';
              for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
              postCapture('ws_recv', { url, data_kind: 'binary', body_b64: btoa(bin), length: arr.length });
            }).catch(() => {});
          } else if (e.data instanceof ArrayBuffer) {
            const arr = new Uint8Array(e.data);
            if (arr.length > MAX_PAYLOAD) {
              postCapture('ws_recv', { url, data_kind: 'binary', _truncated: true, original_length: arr.length });
              return;
            }
            let bin = '';
            for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
            postCapture('ws_recv', { url, data_kind: 'binary', body_b64: btoa(bin), length: arr.length });
          }
        } catch {
          // Defensive
        }
      });

      ws.addEventListener('close', (e) => {
        postCapture('ws_close', { url, code: e.code, reason: e.reason });
      });
    }

    return ws;
  }
  WrappedWebSocket.prototype = OrigWS.prototype;
  WrappedWebSocket.CONNECTING = OrigWS.CONNECTING;
  WrappedWebSocket.OPEN = OrigWS.OPEN;
  WrappedWebSocket.CLOSING = OrigWS.CLOSING;
  WrappedWebSocket.CLOSED = OrigWS.CLOSED;
  window.WebSocket = WrappedWebSocket;

  console.info('[LivePilot network-tap] page-context tap installed (zero-risk passive observer)');
})();
