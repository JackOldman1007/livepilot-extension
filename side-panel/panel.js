/**
 * panel.js — Side Panel UI controller for LivePilot.
 *
 * Responsibilities:
 * - Tab switching
 * - Connection status display
 * - Message passing to/from service worker
 * - Toast notifications
 *
 * Section 1: Shell only. Product list rendering and action buttons
 * will be implemented in Sections 2-3.
 */

// ─── DOM References ──────────────────────────────────────────────
const $connectionStatus = document.getElementById('connection-status');
const $sessionIndicator = document.getElementById('session-indicator');
const $tabNav = document.getElementById('tab-nav');
const $toastContainer = document.getElementById('toast-container');

// Tab panels (flash + pin tabs removed 2026-05-03; replaced by single Bag tab)
const tabPanels = {
  bag: document.getElementById('tab-bag'),
  log: document.getElementById('tab-log'),
  settings: document.getElementById('tab-settings'),
};

// ─── Tab Switching ───────────────────────────────────────────────
$tabNav.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;

  const tabName = btn.dataset.tab;

  // Update button states
  $tabNav.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');

  // Update panel visibility
  for (const [name, panel] of Object.entries(tabPanels)) {
    panel.classList.toggle('active', name === tabName);
  }
});

// ─── Connection Status ───────────────────────────────────────────
let sessionStartTime = null;
let sessionTimerInterval = null;

function setConnected(connected, sessionKey) {
  $connectionStatus.textContent = connected ? 'Connected' : 'Disconnected';
  $connectionStatus.className = `status-badge ${connected ? 'connected' : 'disconnected'}`;

  if (connected && !sessionStartTime) {
    sessionStartTime = Date.now();
    startSessionTimer();
  }
}

function startSessionTimer() {
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);

  sessionTimerInterval = setInterval(() => {
    if (!sessionStartTime) return;
    const elapsed = Date.now() - sessionStartTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    $sessionIndicator.textContent =
      `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, 1000);
}

// ─── Toast Notifications ─────────────────────────────────────────
function showToast(message, type = 'success', durationMs = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s';
    setTimeout(() => toast.remove(), 200);
  }, durationMs);
}

// ─── Service Worker Communication ────────────────────────────────
async function sendToServiceWorker(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({
      source: 'side_panel',
      type,
      payload,
    });
    return response;
  } catch (err) {
    console.error('[LivePilot Panel] Message failed:', err);
    showToast(`Communication error: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
}

// ─── Listen for messages from service worker ─────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'connection_update':
      setConnected(payload.connected, payload.sessionKey);
      break;

    case 'product_list_update':
      // Section 2 will render product lists here
      console.info('[LivePilot Panel] Product list received:', payload);
      break;

    case 'metric_update':
      // Section 4 will update metric display here
      console.info('[LivePilot Panel] Metric update:', payload);
      break;

    case 'action_result':
      if (payload.success) {
        showToast(payload.message || 'Action completed', 'success');
      } else {
        showToast(payload.error || 'Action failed', 'error');
      }
      break;

    default:
      console.warn('[LivePilot Panel] Unknown message:', type);
  }

  sendResponse({ received: true });
  return false;
});

// ─── Initial connection check ────────────────────────────────────
let wasConsoleConnected = false;
let wasBoardConnected = false;

async function checkConnection() {
  // Use verified ping — lightweight, doesn't trigger DOM scraping
  const response = await sendToServiceWorker('get_connection_status', { verify: true });

  if (response?.success) {
    const consoleAlive = response.data.liveConsole.verified || response.data.liveConsole.connected;
    const boardAlive = response.data.liveBoard.verified || response.data.liveBoard.connected;

    // LIVE Console connection state change
    if (consoleAlive && !wasConsoleConnected) {
      showToast('Connected to LIVE Console', 'success');
      wasConsoleConnected = true;
    } else if (!consoleAlive && wasConsoleConnected) {
      showToast('Lost connection to LIVE Console', 'error');
      wasConsoleConnected = false;
    }

    // LIVE Board connection state change (informational)
    if (boardAlive && !wasBoardConnected) {
      showToast('LIVE Dashboard connected', 'success');
      wasBoardConnected = true;
    } else if (!boardAlive && wasBoardConnected) {
      wasBoardConnected = false;
    }

    setConnected(consoleAlive);
    $connectionStatus.title = consoleAlive
      ? `Console: connected | Dashboard: ${boardAlive ? 'connected' : 'not detected'}`
      : 'LIVE Console not connected — make sure the streamer page is open';
  } else {
    setConnected(false);
    $connectionStatus.title = response?.error || 'Cannot reach service worker';
    console.warn('[LivePilot Panel] Connection check failed:', response?.error);
  }
}

// Check connection on load with fast retries for the first 30s
// (service worker might be waking up from suspension)
checkConnection();
const fastCheckInterval = setInterval(checkConnection, 3000);
setTimeout(() => clearInterval(fastCheckInterval), 30000);
setInterval(checkConnection, 10000);

// ─── Product List Rendering (Bag tab) ───────────────────────────
// Single consolidated product list. Each row has a "Show on Host" button
// that sends the product to the Host Display screen via service worker.
// Replaces the old auto-flash + auto-pin actions (removed 2026-05-03).
let cachedProducts = [];

const $bagList = document.getElementById('bag-product-list');
const $bagSearch = document.getElementById('bag-search');

function renderProductList(container, products) {
  container.textContent = '';

  if (products.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = wasConsoleConnected ? 'No products match your search' : 'Waiting for LIVE Console connection...';
    container.appendChild(p);
    return;
  }

  for (const product of products) {
    const row = document.createElement('div');
    row.className = 'product-row';

    // Image
    const img = document.createElement('div');
    img.className = 'product-img';
    if (product.imageUrl) {
      const imgEl = document.createElement('img');
      imgEl.src = product.imageUrl;
      imgEl.alt = product.name?.slice(0, 30) || '';
      img.appendChild(imgEl);
    }
    row.appendChild(img);

    // Info
    const info = document.createElement('div');
    info.className = 'product-info';

    const name = document.createElement('div');
    name.className = 'product-name';
    name.textContent = product.name?.slice(0, 60) || 'Unknown';
    name.title = product.name || '';
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'product-meta';
    meta.textContent = [product.price, product.id].filter(Boolean).join(' | ');
    info.appendChild(meta);

    row.appendChild(info);

    // "Show on Host" — sends product to host display tab via service worker.
    const btn = document.createElement('button');
    btn.className = 'btn btn-host';
    btn.textContent = 'Show on Host';
    btn.title = 'Send this product to the Host Display screen';
    btn.addEventListener('click', () => handleSendToHost(product, btn));
    row.appendChild(btn);

    container.appendChild(row);
  }
}

function filterProducts(searchTerm) {
  if (!searchTerm) return cachedProducts;
  const lower = searchTerm.toLowerCase();
  return cachedProducts.filter(p =>
    (p.name || '').toLowerCase().includes(lower) ||
    (p.id || '').toLowerCase().includes(lower) ||
    (p.price || '').toLowerCase().includes(lower)
  );
}

async function handleSendToHost(product, btn) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Sending...';
  const resp = await sendToServiceWorker('send_product_to_host', { product });
  btn.disabled = false;
  if (resp?.success) {
    btn.textContent = resp.delivered > 0 ? 'Sent ✓' : 'No host tab';
    showToast(
      resp.delivered > 0
        ? `Sent to host: ${product.name?.slice(0, 30)}`
        : 'No Host Display tab open — open one from Settings',
      resp.delivered > 0 ? 'success' : 'warning'
    );
    setTimeout(() => { btn.textContent = originalText; }, 2000);
  } else {
    btn.textContent = originalText;
    showToast(resp?.error || 'Send failed', 'error');
  }
}

async function refreshProductList() {
  const resp = await sendToServiceWorker('request_product_list');
  if (resp?.success && resp.data) {
    cachedProducts = resp.data;
    renderProductList($bagList, filterProducts($bagSearch?.value));
  }
}

$bagSearch?.addEventListener('input', () => {
  renderProductList($bagList, filterProducts($bagSearch.value));
});

// Refresh product list every 5 seconds when connected
setInterval(() => {
  if (wasConsoleConnected) refreshProductList();
}, 5000);

// ─── Battle Card Loading ────────────────────────────────────────
const $apiUrl = document.getElementById('api-url');
const $apiKey = document.getElementById('api-key');
const $loadCards = document.getElementById('btn-load-cards');
const $cardsStatus = document.getElementById('cards-status');

// ─── Live Chat Ingest token ─────────────────────────────────────
// Without this the extension can still run the live, but every chat batch is
// rejected 401 and the Request List (FEAT-0124/0125) stays empty. Kept out of
// the source on purpose — src/ is mirrored to a PUBLIC repo, so the token is
// entered per machine. See docs/livepilot-v1-activation.md (Inventory repo).
const $ingestToken = document.getElementById('ingest-token');
const $saveIngest = document.getElementById('btn-save-ingest');
const $ingestStatus = document.getElementById('ingest-status');

// Load saved API config
(async () => {
  const saved = await sendToServiceWorker('get_settings');
  const api = saved?.data?.livepilot_api;
  if (api?.apiUrl && $apiUrl) $apiUrl.value = api.apiUrl;
  if (api?.apiKey && $apiKey) $apiKey.value = api.apiKey;

  const ingest = saved?.data?.livepilot_v1_token;
  if (ingest && $ingestToken) {
    $ingestToken.value = ingest;
    if ($ingestStatus) {
      $ingestStatus.textContent = 'Token set on this machine';
      $ingestStatus.style.color = '#059669';
    }
  }
})();

if ($saveIngest) {
  $saveIngest.addEventListener('click', async () => {
    const token = $ingestToken?.value.trim() || '';
    // Saving an empty value is a legitimate way to clear a bad token, so it is
    // allowed — just say which of the two things happened.
    const resp = await sendToServiceWorker('save_settings', { livepilot_v1_token: token });
    if (resp?.success) {
      $ingestStatus.textContent = token ? 'Token saved' : 'Token cleared — chat ingest will be rejected';
      $ingestStatus.style.color = token ? '#059669' : '#f59e0b';
      showToast(token ? 'Ingest token saved' : 'Ingest token cleared', token ? 'success' : 'warning');
    } else {
      $ingestStatus.textContent = `Error: ${resp?.error || 'save failed'}`;
      $ingestStatus.style.color = '#ef4444';
      showToast('Failed to save ingest token', 'error');
    }
  });
}

if ($loadCards) {
  $loadCards.addEventListener('click', async () => {
    const apiUrl = $apiUrl?.value.trim();
    const apiKey = $apiKey?.value.trim();
    if (!apiUrl) { showToast('Enter API URL first', 'warning'); return; }

    $loadCards.disabled = true;
    $loadCards.textContent = 'Loading...';
    $cardsStatus.textContent = '';

    const resp = await sendToServiceWorker('load_battle_cards', { apiUrl, apiKey });
    if (resp?.success) {
      $cardsStatus.textContent = `Loaded ${resp.count} battle cards`;
      $cardsStatus.style.color = '#059669';
      showToast(`${resp.count} battle cards loaded`, 'success');
    } else {
      $cardsStatus.textContent = `Error: ${resp?.error}`;
      $cardsStatus.style.color = '#ef4444';
      showToast(`Failed: ${resp?.error}`, 'error');
    }

    $loadCards.disabled = false;
    $loadCards.textContent = 'Load Battle Cards';
  });
}

// ─── Copy Full Discovery Report ──────────────────────────────────
const $copyReportBtn = document.getElementById('btn-copy-report');

if ($copyReportBtn) {
  $copyReportBtn.addEventListener('click', copyFullReport);
}

async function copyFullReport() {
  $copyReportBtn.textContent = 'Scanning page...';
  $copyReportBtn.disabled = true;

  try {
    // Request discovery from content script via service worker
    const resp = await sendToServiceWorker('run_discovery_full');
    const lines = [];

    // Header
    lines.push('=== LIVEPILOT AUTO-DISCOVERY REPORT ===');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Extension ID: ${chrome.runtime.id}`);
    lines.push(`Extension version: ${chrome.runtime.getManifest().version}`);
    lines.push('');

    // Discovery reports from content scripts
    if (resp?.success && resp.data?.formatted) {
      lines.push(`Pages scanned: ${resp.data.pageCount || 1}`);
      if (resp.data.errors) {
        lines.push(`Pages not available: ${resp.data.errors.join('; ')}`);
      }
      lines.push('');
      lines.push(resp.data.formatted);
    } else {
      lines.push('CONTENT SCRIPT REPORT: FAILED');
      lines.push(`Error: ${resp?.error || 'No response from content script'}`);
      if (resp?.debug) {
        lines.push(`Debug info: ${JSON.stringify(resp.debug, null, 2)}`);
      }
      lines.push('');
      lines.push('This usually means:');
      lines.push('1. The TikTok page URL does not match the extension\'s content_scripts pattern');
      lines.push('2. The content script crashed on load');
      lines.push('3. The page has not finished loading yet — wait and try again');
    }

    lines.push('');
    lines.push('=== EXTENSION DIAGNOSTICS ===');

    // Extension info
    const manifest = chrome.runtime.getManifest();
    lines.push(`Content script URL patterns: ${manifest.content_scripts?.map(cs => cs.matches.join(', ')).join(' | ')}`);
    lines.push(`Host permissions: ${manifest.host_permissions?.join(', ') || 'none'}`);
    lines.push(`Permissions: ${manifest.permissions?.join(', ')}`);

    const fullText = lines.join('\n');

    // Copy to clipboard
    await navigator.clipboard.writeText(fullText);

    showToast('Report copied to clipboard! Paste it into the Google Doc.', 'success', 5000);
    $copyReportBtn.textContent = 'Copied! Paste into Google Doc';
    setTimeout(() => {
      $copyReportBtn.textContent = '📋 Copy Full Discovery Report';
      $copyReportBtn.disabled = false;
    }, 3000);
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
    $copyReportBtn.textContent = '📋 Copy Full Discovery Report';
    $copyReportBtn.disabled = false;
  }
}

// ─── Diagnostics ─────────────────────────────────────────────────
const $debugBtn = document.getElementById('btn-debug');
const $debugOutput = document.getElementById('debug-output');

if ($debugBtn) {
  $debugBtn.addEventListener('click', runDiagnostics);
}

async function runDiagnostics() {
  $debugOutput.style.display = 'block';
  const lines = [];
  const log = (msg) => {
    lines.push(msg);
    $debugOutput.textContent = lines.join('\n');
  };

  log('=== LivePilot Diagnostics ===');
  log(`Time: ${new Date().toISOString()}`);
  log(`Extension ID: ${chrome.runtime.id}`);
  log('');

  // 1. Check service worker is alive
  log('[1] Service Worker...');
  try {
    const swResp = await chrome.runtime.sendMessage({
      source: 'side_panel',
      type: 'get_settings',
    });
    log(`  ✅ Service Worker responding`);
    log(`  Settings: ${JSON.stringify(swResp.data || 'none')}`);
  } catch (err) {
    log(`  ❌ Service Worker DEAD: ${err.message}`);
    log('  → Go to chrome://extensions and check for errors on LivePilot');
    return;
  }

  // 2. Check registered content script tabs
  log('');
  log('[2] Checking registered content scripts...');
  try {
    const statusResp = await chrome.runtime.sendMessage({
      source: 'side_panel',
      type: 'get_connection_status',
    });
    if (statusResp?.success) {
      const lc = statusResp.data.liveConsole;
      const lb = statusResp.data.liveBoard;
      if (lc.connected) {
        log(`  ✅ LIVE Console connected (${lc.tabs.length} tab(s)):`);
        for (const t of lc.tabs) {
          log(`    - Tab ${t.id}: ${t.url}`);
        }
      } else {
        log(`  ❌ LIVE Console: NO tabs registered`);
        log('');
        log('  This means the content script never loaded.');
        log('  Possible causes:');
        log('  1. The TikTok page URL does not match the content_scripts pattern');
        log('  2. The page has not finished loading yet');
        log('  3. There was a JS error in the content script');
        log('');
        log('  → Open the TikTok LIVE Console page');
        log('  → Press F12 → Console → filter by "LivePilot"');
        log('  → Look for errors');
        log('  → If nothing appears, the URL does not match');
      }
      log('');
      if (lb.connected) {
        log(`  ✅ LIVE Board connected (${lb.tabs.length} tab(s)):`);
        for (const t of lb.tabs) {
          log(`    - Tab ${t.id}: ${t.url}`);
        }
      } else {
        log(`  ⚠️  LIVE Board: not connected (optional for now)`);
      }
    }
  } catch (err) {
    log(`  ❌ Status check failed: ${err.message}`);
  }

  // 3. Try fetching product list
  log('');
  log('[3] Trying to fetch product list...');
  try {
    const resp = await chrome.runtime.sendMessage({
      source: 'side_panel',
      type: 'request_product_list',
    });
    if (resp.success) {
      log(`  ✅ Content script responding!`);
      log(`  Products found: ${resp.data?.length ?? 0}`);
    } else {
      log(`  ❌ ${resp.error}`);
    }
  } catch (err) {
    log(`  ❌ Message failed: ${err.message}`);
  }

  // 4. Extension info
  log('');
  log('[4] Extension info...');
  const manifest = chrome.runtime.getManifest();
  log(`  Name: ${manifest.name} v${manifest.version}`);
  log(`  Content script matches:`);
  for (const cs of manifest.content_scripts || []) {
    log(`    ${cs.matches.join(', ')}`);
  }
  log(`  Host permissions: ${manifest.host_permissions?.join(', ') || 'none'}`);

  log('');
  log('=== Copy this output and share it for debugging ===');
}

// ─── Export Session ──────────────────────────────────────────────
const $exportBtn = document.getElementById('btn-export');
const $newSessionBtn = document.getElementById('btn-new-session');
const $videoOffsetInput = document.getElementById('video-offset');
const $setOffsetBtn = document.getElementById('btn-set-offset');

if ($exportBtn) {
  $exportBtn.addEventListener('click', async () => {
    $exportBtn.disabled = true;
    $exportBtn.textContent = 'Exporting...';

    try {
      const resp = await sendToServiceWorker('export_session');
      if (!resp?.success || !resp.data) {
        showToast('No session data to export', 'warning');
        return;
      }

      const session = resp.data;
      const json = JSON.stringify(session, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      // Build filename: livepilot_20260326_143000.json
      const dateStr = session.startTimeISO
        ? session.startTimeISO.replace(/[-:T]/g, '').slice(0, 15)
        : session.sessionId.replace('session_log_', '');
      const filename = `livepilot_${dateStr}.json`;

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      const eventCount = (session.events?.length || 0) + (session.metricSnapshots?.length || 0);
      showToast(`Exported ${eventCount} events to ${filename}`, 'success', 5000);
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'error');
    } finally {
      $exportBtn.disabled = false;
      $exportBtn.textContent = 'Export Session JSON';
    }
  });
}

if ($newSessionBtn) {
  $newSessionBtn.addEventListener('click', async () => {
    const resp = await sendToServiceWorker('new_session');
    if (resp?.success) {
      sessionStartTime = Date.now();
      showToast('New session started', 'success');
    } else {
      showToast('Failed to start new session', 'error');
    }
  });
}

if ($setOffsetBtn) {
  $setOffsetBtn.addEventListener('click', async () => {
    const seconds = parseFloat($videoOffsetInput.value) || 0;
    const offsetMs = Math.round(seconds * 1000);
    const resp = await sendToServiceWorker('set_video_offset', { offsetMs });
    if (resp?.success) {
      showToast(`Video offset set to ${seconds}s`, 'success');
    } else {
      showToast('Failed to set offset', 'error');
    }
  });
}

// ─── Host Display Controls ──────────────────────────────────────
const $openHostDisplay = document.getElementById('btn-open-host-display');
const $operatorMsgInput = document.getElementById('operator-msg-input');
const $sendOperatorMsg = document.getElementById('btn-send-operator-msg');

if ($openHostDisplay) {
  $openHostDisplay.addEventListener('click', async () => {
    const resp = await sendToServiceWorker('open_host_display');
    if (resp?.success) {
      showToast('Host Display opened — drag to second monitor', 'success', 4000);
    } else {
      showToast('Failed to open Host Display', 'error');
    }
  });
}

if ($sendOperatorMsg && $operatorMsgInput) {
  const sendMsg = async () => {
    const text = $operatorMsgInput.value.trim();
    if (!text) return;
    const resp = await sendToServiceWorker('host_operator_message', { text });
    if (resp?.success) {
      $operatorMsgInput.value = '';
      showToast('Sent to host', 'success', 2000);
    } else {
      showToast('Host Display not open', 'warning');
    }
  };

  $sendOperatorMsg.addEventListener('click', sendMsg);
  $operatorMsgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMsg();
  });
}

// ─── Host Display v2 ────────────────────────────────────────────
const $openHostV2 = document.getElementById('btn-open-host-v2');

if ($openHostV2) {
  $openHostV2.addEventListener('click', async () => {
    const resp = await sendToServiceWorker('open_host_display_v2');
    if (resp?.success) {
      showToast('Host Display v2 opened — drag to second monitor', 'success', 4000);
    } else {
      showToast('Failed to open Host Display v2', 'error');
    }
  });
}

// ─── Dissolve Controls ─────────────────────────────────────────
const $autoDissolveToggle = document.getElementById('auto-dissolve-toggle');
const $dissolvePointList = document.getElementById('dissolve-point-list');
const $undoDissolve = document.getElementById('btn-undo-dissolve');
const $resetDissolve = document.getElementById('btn-reset-dissolve');
const $speechStatus = document.getElementById('speech-status');
const $dissolveTranscript = document.getElementById('dissolve-transcript');
const $transcriptText = document.getElementById('transcript-text');

let currentPoints = []; // talking points from host display
let speechRecognition = null;
let isListening = false;

// Render point list in dissolve controls
function renderDissolvePoints(points) {
  currentPoints = points;
  if (!$dissolvePointList) return;
  $dissolvePointList.textContent = '';

  if (!points || points.length === 0) {
    const p = document.createElement('p');
    p.className = 'settings-hint';
    p.textContent = 'Pin a product to see talking points';
    $dissolvePointList.appendChild(p);
    return;
  }

  points.forEach((point, index) => {
    const row = document.createElement('div');
    row.className = `dissolve-point-row state-${point.state}`;
    row.dataset.pointId = point.id;

    const num = document.createElement('span');
    num.className = 'dissolve-point-num';
    num.textContent = index + 1;

    const text = document.createElement('span');
    text.className = 'dissolve-point-text';
    text.textContent = point.text?.slice(0, 60) || '—';
    text.title = point.text || '';

    const stateIcon = document.createElement('span');
    stateIcon.className = 'dissolve-point-state';
    if (point.state === 'dimmed' || point.state === 'collapsed') {
      stateIcon.textContent = '\u2713'; // checkmark
      stateIcon.title = 'Covered — click to restore';
      stateIcon.addEventListener('click', (e) => {
        e.stopPropagation();
        sendToServiceWorker('host_restore_point', { pointId: point.id });
      });
    } else if (point.state === 'suggested') {
      stateIcon.textContent = '?';
      stateIcon.title = 'Speech match — click to confirm';
    }

    row.appendChild(num);
    row.appendChild(text);
    row.appendChild(stateIcon);

    // Click row to dissolve (if visible) or restore (if dissolved)
    row.addEventListener('click', () => {
      if (point.state === 'visible' || point.state === 'suggested') {
        sendToServiceWorker('host_dissolve_point', { pointId: point.id });
      } else if (point.state === 'dimmed' || point.state === 'collapsed') {
        sendToServiceWorker('host_restore_point', { pointId: point.id });
      }
    });

    $dissolvePointList.appendChild(row);
  });
}

// Listen for point state updates from host display v2
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'host_point_states' && message.payload?.points) {
    renderDissolvePoints(message.payload.points);
  }
});

// Undo / Reset buttons
$undoDissolve?.addEventListener('click', () => {
  sendToServiceWorker('host_restore_last', {});
});

$resetDissolve?.addEventListener('click', () => {
  sendToServiceWorker('host_reset_points', {});
});

// ─── Keyboard Shortcuts (1-9 to dissolve, Z=undo, R=reset) ─────
document.addEventListener('keydown', (e) => {
  // Don't trigger shortcuts when typing in input fields
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // Number keys 1-9: dissolve corresponding point
  if (e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key) - 1;
    if (currentPoints[idx]) {
      const point = currentPoints[idx];
      if (point.state === 'visible' || point.state === 'suggested') {
        sendToServiceWorker('host_dissolve_point', { pointId: point.id });
      }
    }
    return;
  }

  // Z: undo last dissolve
  if (e.key === 'z' || e.key === 'Z') {
    sendToServiceWorker('host_restore_last', {});
    return;
  }

  // R: reset all points
  if (e.key === 'r' || e.key === 'R') {
    sendToServiceWorker('host_reset_points', {});
    return;
  }
});

// ─── Speech Recognition (Auto-Dissolve) ─────────────────────────
function extractKeywords(text) {
  // Extract meaningful words (3+ chars, not stop words)
  const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'its', 'was', 'one', 'our', 'out', 'this', 'that', 'with', 'from', 'have', 'been', 'they', 'will', 'each', 'make', 'like', 'just', 'over', 'such', 'very', 'when', 'what', 'your', 'also', 'into', 'most', 'than', 'them', 'some', 'made', 'more']);
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));
}

function matchPointToTranscript(point, transcriptWords) {
  const pointKeywords = extractKeywords(point.text);
  if (pointKeywords.length === 0) return 0;

  let matches = 0;
  for (const keyword of pointKeywords) {
    if (transcriptWords.some(w => w.includes(keyword) || keyword.includes(w))) {
      matches++;
    }
  }
  return matches / pointKeywords.length;
}

function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('Speech recognition not supported in this browser', 'warning');
    $autoDissolveToggle.checked = false;
    return;
  }

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'en-US';

  let rollingTranscript = [];

  speechRecognition.onresult = (event) => {
    const latest = event.results[event.results.length - 1];
    const text = latest[0].transcript;
    const isFinal = latest.isFinal;

    if ($transcriptText) $transcriptText.textContent = text.slice(-80);

    if (isFinal) {
      const words = extractKeywords(text);
      rollingTranscript.push(...words);
      // Keep rolling window of last 50 words (~30 seconds of speech)
      if (rollingTranscript.length > 50) {
        rollingTranscript = rollingTranscript.slice(-50);
      }

      // Check each visible point for keyword match
      for (const point of currentPoints) {
        if (point.state !== 'visible') continue;
        const score = matchPointToTranscript(point, rollingTranscript);

        if (score >= 0.6) {
          // Strong match — suggest this point
          sendToServiceWorker('host_suggest_point', { pointId: point.id });

          // Auto-confirm if very high confidence
          if (score >= 0.85) {
            setTimeout(() => {
              sendToServiceWorker('host_dissolve_point', { pointId: point.id });
            }, 3000); // 3s delay for auto-confirm
          }
        }
      }
    }
  };

  speechRecognition.onerror = (event) => {
    console.warn('[LivePilot Panel] Speech error:', event.error);
    if (event.error === 'not-allowed') {
      showToast('Microphone access denied', 'error');
      $autoDissolveToggle.checked = false;
      stopSpeechRecognition();
    }
  };

  speechRecognition.onend = () => {
    // Auto-restart if still toggled on
    if (isListening && $autoDissolveToggle?.checked) {
      speechRecognition.start();
    }
  };

  speechRecognition.start();
  isListening = true;
  if ($speechStatus) $speechStatus.textContent = 'Listening';
  if ($speechStatus) $speechStatus.className = 'speech-indicator listening';
  if ($dissolveTranscript) $dissolveTranscript.style.display = 'flex';
}

function stopSpeechRecognition() {
  if (speechRecognition) {
    isListening = false;
    speechRecognition.stop();
    speechRecognition = null;
  }
  if ($speechStatus) $speechStatus.textContent = '';
  if ($speechStatus) $speechStatus.className = 'speech-indicator';
  if ($dissolveTranscript) $dissolveTranscript.style.display = 'none';
}

$autoDissolveToggle?.addEventListener('change', () => {
  if ($autoDissolveToggle.checked) {
    startSpeechRecognition();
  } else {
    stopSpeechRecognition();
  }
});

// ─── Expose for debugging ────────────────────────────────────────
globalThis.__livepilot_panel = {
  showToast,
  sendToServiceWorker,
  setConnected,
  runDiagnostics,
  currentPoints: () => currentPoints,
  renderDissolvePoints,
};
