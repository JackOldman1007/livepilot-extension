/**
 * host-v2.js — Host Display v2 with Dissolve System.
 *
 * All v1 functionality PLUS:
 * - Talking points dissolve when host covers them (visible → dimmed → collapsed)
 * - Reversible: undo last dissolve, reset all
 * - Remaining visible items get promoted (more space)
 * - State machine per talking point, controlled by operator panel messages
 *
 * Communication:
 *   Service Worker → host-v2.js via chrome.runtime.onMessage
 *   host-v2.js → Service Worker via chrome.runtime.sendMessage
 */

// ─── State ────────────────────────────────────────────────
let currentProduct = null;
let productStartTime = null;
let productTimerInterval = null;
let sessionStartTime = null;
let sessionTimerInterval = null;
let battleCards = new Map();
let intentMessages = [];

// ─── Dissolve State ───────────────────────────────────────
// Each talking point: { id, type, text, state: 'visible'|'suggested'|'dimmed'|'collapsed' }
let talkingPoints = [];
let dissolutionHistory = []; // stack of dissolved point IDs for undo
let dissolveTimers = new Map(); // pointId → setTimeout handle for dimmed→collapsed

// ─── DOM References ───────────────────────────────────────
const $ = (id) => document.getElementById(id);

const dom = {
  connectionBadge: $('connection-badge'),
  viewerCount: $('viewer-count'),
  sessionTimer: $('session-timer'),
  productImage: $('product-image'),
  productImagePlaceholder: $('product-image-placeholder'),
  brand: $('product-brand'),
  model: $('product-model'),
  material: $('product-material'),
  color: $('product-color'),
  size: $('product-size'),
  year: $('product-year'),
  condition: $('product-condition'),
  priceOurs: $('price-ours'),
  priceFlash: $('price-flash'),
  priceRetail: $('price-retail'),
  priceTrr: $('price-trr'),
  priceFp: $('price-fp'),
  priceSavings: $('price-savings'),
  sellingPoints: $('selling-points'),
  funFacts: $('fun-facts'),
  celebritySection: $('celebrity-section'),
  celebrityPoints: $('celebrity-points'),
  raritySection: $('rarity-section'),
  rarityPoints: $('rarity-points'),
  operatorWrap: $('operator-msg-wrap'),
  operatorMsg: $('operator-msg'),
  intentChat: $('intent-chat'),
  timerValue: $('timer-value'),
  nextProductName: $('next-product-name'),
  pointsRemaining: $('points-remaining'),
};

// ─── Format Helpers ───────────────────────────────────────
function formatPrice(val) {
  if (val == null || val === 0) return '—';
  return '$' + Number(val).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════
// DISSOLVE SYSTEM
// ═══════════════════════════════════════════════════════════

/**
 * Dissolve a talking point: visible → dimmed (0.6s) → collapsed (after 2s)
 */
function dissolvePoint(pointId) {
  const point = talkingPoints.find(p => p.id === pointId);
  if (!point || point.state === 'dimmed' || point.state === 'collapsed') return;

  const el = document.querySelector(`[data-point-id="${pointId}"]`);
  if (!el) return;

  // Step 1: Dim
  point.state = 'dimmed';
  el.dataset.state = 'dimmed';

  // Track for undo
  dissolutionHistory.push(pointId);

  // Step 2: Collapse after 2 seconds
  const timer = setTimeout(() => {
    if (point.state === 'dimmed') {
      point.state = 'collapsed';
      el.dataset.state = 'collapsed';
      updatePointsCounter();
      updatePromotionClass();
    }
    dissolveTimers.delete(pointId);
  }, 2000);

  dissolveTimers.set(pointId, timer);
  updatePointsCounter();
  updatePromotionClass();
  reportPointStates();
}

/**
 * Suggest a talking point was mentioned (speech recognition hint).
 * Host display shows subtle highlight. Operator confirms to dissolve.
 */
function suggestPoint(pointId) {
  const point = talkingPoints.find(p => p.id === pointId);
  if (!point || point.state !== 'visible') return;

  const el = document.querySelector(`[data-point-id="${pointId}"]`);
  if (!el) return;

  point.state = 'suggested';
  el.dataset.state = 'suggested';
}

/**
 * Restore a specific dissolved point back to visible.
 */
function restorePoint(pointId) {
  const point = talkingPoints.find(p => p.id === pointId);
  if (!point) return;
  if (point.state === 'visible') return;

  // Cancel any pending collapse timer
  if (dissolveTimers.has(pointId)) {
    clearTimeout(dissolveTimers.get(pointId));
    dissolveTimers.delete(pointId);
  }

  const el = document.querySelector(`[data-point-id="${pointId}"]`);
  if (!el) return;

  // Use restoring animation for collapsed items
  if (point.state === 'collapsed') {
    el.dataset.state = 'restoring';
    setTimeout(() => {
      el.dataset.state = 'visible';
      point.state = 'visible';
    }, 500);
  } else {
    el.dataset.state = 'visible';
    point.state = 'visible';
  }

  // Remove from dissolution history
  const idx = dissolutionHistory.lastIndexOf(pointId);
  if (idx !== -1) dissolutionHistory.splice(idx, 1);

  updatePointsCounter();
  updatePromotionClass();
  reportPointStates();
}

/**
 * Restore the most recently dissolved point.
 */
function restoreLastDissolved() {
  if (dissolutionHistory.length === 0) return;
  const lastId = dissolutionHistory[dissolutionHistory.length - 1];
  restorePoint(lastId);
}

/**
 * Reset all points to visible.
 */
function resetAllPoints() {
  // Cancel all pending timers
  for (const timer of dissolveTimers.values()) clearTimeout(timer);
  dissolveTimers.clear();
  dissolutionHistory = [];

  for (const point of talkingPoints) {
    if (point.state !== 'visible') {
      const el = document.querySelector(`[data-point-id="${point.id}"]`);
      if (el) {
        if (point.state === 'collapsed') {
          el.dataset.state = 'restoring';
          setTimeout(() => { el.dataset.state = 'visible'; }, 500);
        } else {
          el.dataset.state = 'visible';
        }
      }
      point.state = 'visible';
    }
  }

  updatePointsCounter();
  updatePromotionClass();
  reportPointStates();
}

/**
 * Update the "X remaining" counter.
 */
function updatePointsCounter() {
  const total = talkingPoints.length;
  const visible = talkingPoints.filter(p => p.state === 'visible' || p.state === 'suggested').length;
  if (total > 0) {
    dom.pointsRemaining.textContent = `${visible}/${total} remaining`;
  } else {
    dom.pointsRemaining.textContent = '';
  }
}

/**
 * Add/remove 'has-dissolved' class on point lists for CSS promotion.
 */
function updatePromotionClass() {
  const hasDissolved = talkingPoints.some(p => p.state === 'dimmed' || p.state === 'collapsed');
  for (const list of document.querySelectorAll('.point-list')) {
    list.classList.toggle('has-dissolved', hasDissolved);
  }
}

/**
 * Report current point states back to the service worker (for operator panel).
 */
function reportPointStates() {
  try {
    chrome.runtime.sendMessage({
      source: 'host_display_v2',
      type: 'host_point_states',
      payload: {
        points: talkingPoints.map(p => ({ id: p.id, type: p.type, text: p.text, state: p.state })),
      },
    });
  } catch { /* service worker might be asleep */ }
}

// ═══════════════════════════════════════════════════════════
// PRODUCT DISPLAY
// ═══════════════════════════════════════════════════════════

function showProduct(product) {
  currentProduct = product;
  productStartTime = Date.now();
  startProductTimer();

  // Reset dissolve state for new product
  for (const timer of dissolveTimers.values()) clearTimeout(timer);
  dissolveTimers.clear();
  dissolutionHistory = [];
  talkingPoints = [];

  // Identity
  dom.brand.textContent = product.brand_name || '—';
  dom.model.textContent = product.model_name || 'Unknown Model';
  dom.material.textContent = product.material || '';
  dom.color.textContent = product.color || '';
  dom.size.textContent = product.size || '';
  dom.year.textContent = product.year_estimate || '';
  dom.condition.textContent = product.condition ? product.condition.replace('_', ' ') : '';

  // Image
  if (product.image_url) {
    dom.productImage.src = product.image_url;
    dom.productImage.style.display = 'block';
    dom.productImagePlaceholder.style.display = 'none';
  } else {
    dom.productImage.style.display = 'none';
    dom.productImagePlaceholder.style.display = 'flex';
    dom.productImagePlaceholder.textContent = product.brand_name || 'No Image';
  }

  // Pricing
  const ourPrice = product.our_price || product.flash_price;
  const retailPrice = product.retail_price_usd;
  const trrPrice = product.competitor_prices?.therealreal?.price;
  const fpPrice = product.competitor_prices?.fashionphile?.price;
  const flashPrice = product.flash_price;

  dom.priceOurs.textContent = formatPrice(ourPrice);
  dom.priceFlash.textContent = formatPrice(flashPrice);
  dom.priceRetail.textContent = formatPrice(retailPrice);
  dom.priceTrr.textContent = formatPrice(trrPrice);
  dom.priceFp.textContent = formatPrice(fpPrice);

  if (retailPrice && ourPrice) {
    const saved = retailPrice - (flashPrice || ourPrice);
    const pct = Math.round((saved / retailPrice) * 100);
    dom.priceSavings.textContent = `${formatPrice(saved)} (${pct}%)`;
  } else {
    dom.priceSavings.textContent = '—';
  }

  // Selling Points (with dissolve IDs)
  renderPointList(dom.sellingPoints, product.selling_points, 'selling_point', 'No selling points available');

  // Fun Facts
  renderPointList(dom.funFacts, product.fun_facts, 'fun_fact', 'No stories available');

  // Celebrity
  if (product.celebrity_mentions) {
    dom.celebritySection.style.display = 'block';
    const celTexts = Array.isArray(product.celebrity_mentions)
      ? product.celebrity_mentions
      : [product.celebrity_mentions];
    renderPointList(dom.celebrityPoints, celTexts, 'celebrity', '');
  } else {
    dom.celebritySection.style.display = 'none';
  }

  // Rarity
  if (product.rarity_notes) {
    dom.raritySection.style.display = 'block';
    const rarTexts = Array.isArray(product.rarity_notes)
      ? product.rarity_notes
      : [product.rarity_notes];
    renderPointList(dom.rarityPoints, rarTexts, 'rarity', '');
  } else {
    dom.raritySection.style.display = 'none';
  }

  // Update counter and report
  updatePointsCounter();
  updatePromotionClass();

  // Clear intent chat for new product
  intentMessages = [];
  renderIntentChat();

  // Report points to operator panel
  setTimeout(() => reportPointStates(), 100);
}

/**
 * Render a list of talking points with dissolve support.
 * Each item gets a unique data-point-id and is tracked in talkingPoints[].
 */
function renderPointList(container, items, type, emptyMsg) {
  container.textContent = '';

  if (!items || items.length === 0) {
    if (emptyMsg) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.textContent = emptyMsg;
      container.appendChild(div);
    }
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const text = items[i];
    const typePrefix = { selling_point: 'sp', fun_fact: 'ff', celebrity: 'cel', rarity: 'rar' }[type] || type.substring(0, 2);
    const pointId = `${typePrefix}-${i}`;

    // Register in talking points tracker
    talkingPoints.push({ id: pointId, type, text, state: 'visible' });

    // Create DOM element
    const div = document.createElement('div');
    div.className = 'point-item';
    div.dataset.pointId = pointId;
    div.dataset.state = 'visible';
    div.textContent = text;
    container.appendChild(div);
  }
}

// ─── Product Timer ────────────────────────────────────────
function startProductTimer() {
  if (productTimerInterval) clearInterval(productTimerInterval);
  productTimerInterval = setInterval(() => {
    if (!productStartTime) return;
    const elapsed = Date.now() - productStartTime;
    dom.timerValue.textContent = formatTime(elapsed);

    const mins = elapsed / 60000;
    dom.timerValue.className = 'timer-value' +
      (mins >= 8 ? ' overtime' : mins >= 5 ? ' warning' : '');
  }, 1000);
}

// ─── Session Timer ────────────────────────────────────────
function startSessionTimer() {
  sessionStartTime = Date.now();
  if (sessionTimerInterval) clearInterval(sessionTimerInterval);
  sessionTimerInterval = setInterval(() => {
    const elapsed = Date.now() - sessionStartTime;
    const hrs = Math.floor(elapsed / 3600000);
    const mins = Math.floor((elapsed % 3600000) / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    dom.sessionTimer.textContent = hrs > 0
      ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, 1000);
}

// ─── Chat Filtering (Purchase Intent Only) ────────────────
const INTENT_PATTERNS = /how much|price|buy|want|can i|show me|available|ship|size|color|strap|year|condition|authentic|real|discount|deal|offer|cost|\?$/i;

function addChatMessage(name, text) {
  if (!INTENT_PATTERNS.test(text)) return;

  intentMessages.unshift({ name, text, time: Date.now() });
  if (intentMessages.length > 8) intentMessages.pop();
  renderIntentChat();
}

function renderIntentChat() {
  dom.intentChat.textContent = '';
  if (intentMessages.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'Purchase-intent comments will appear here';
    dom.intentChat.appendChild(p);
    return;
  }
  for (const msg of intentMessages) {
    const div = document.createElement('div');
    div.className = 'chat-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.textContent = msg.name;

    const textSpan = document.createElement('span');
    textSpan.className = 'chat-text';
    textSpan.textContent = msg.text;

    div.appendChild(nameSpan);
    div.appendChild(textSpan);
    dom.intentChat.appendChild(div);
  }
}

// ─── Operator Message ─────────────────────────────────────
function showOperatorMessage(text) {
  dom.operatorMsg.textContent = text;
  dom.operatorWrap.style.display = 'block';
}

$('btn-dismiss-operator')?.addEventListener('click', () => {
  dom.operatorWrap.style.display = 'none';
});

// ─── Load Battle Cards from Inventory API ─────────────────
async function loadBattleCards(apiUrl) {
  try {
    const resp = await fetch(apiUrl);
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);
    const data = await resp.json();
    const products = data.data?.products || data.products || [];
    battleCards.clear();
    for (const p of products) {
      if (p.screening_code) battleCards.set(p.screening_code, p);
      if (p.product_code) battleCards.set(p.product_code, p);
      const key = `${(p.brand_name || '').toLowerCase()}|${(p.model_name || '').toLowerCase()}`;
      if (!battleCards.has(key)) battleCards.set(key, p);
    }
    console.info(`[Host Display v2] Loaded ${products.length} battle cards`);
    return products.length;
  } catch (err) {
    console.error('[Host Display v2] Failed to load battle cards:', err);
    return 0;
  }
}

// ─── Find battle card by various identifiers ──────────────
function findBattleCard(identifier) {
  if (!identifier) return null;
  if (battleCards.has(identifier)) return battleCards.get(identifier);
  const lower = identifier.toLowerCase();
  for (const [key, card] of battleCards) {
    if (key.includes(lower) || lower.includes(key)) return card;
  }
  for (const [, card] of battleCards) {
    const cardName = `${card.brand_name} ${card.model_name}`.toLowerCase();
    if (cardName.includes(lower) || lower.includes(card.model_name?.toLowerCase())) return card;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'host_show_product': {
      const card = payload.product || findBattleCard(payload.identifier);
      if (card) showProduct(card);
      else console.warn('[Host Display v2] Product not found:', payload.identifier);
      sendResponse({ received: true });
      break;
    }

    case 'host_chat_message': {
      if (payload.name && payload.text) addChatMessage(payload.name, payload.text);
      sendResponse({ received: true });
      break;
    }

    case 'host_chat_batch': {
      if (Array.isArray(payload.messages)) {
        for (const msg of payload.messages) {
          if (msg.name && msg.text) addChatMessage(msg.name, msg.text);
        }
      }
      sendResponse({ received: true });
      break;
    }

    case 'host_operator_message': {
      if (payload.text) showOperatorMessage(payload.text);
      sendResponse({ received: true });
      break;
    }

    case 'host_set_next_product': {
      dom.nextProductName.textContent = payload.name || '—';
      sendResponse({ received: true });
      break;
    }

    case 'host_metric_update': {
      if (payload.viewers != null) dom.viewerCount.textContent = `Viewers ${payload.viewers}`;
      sendResponse({ received: true });
      break;
    }

    case 'host_flash_price': {
      if (currentProduct) {
        currentProduct.flash_price = payload.price;
        dom.priceFlash.textContent = formatPrice(payload.price);
        const retail = currentProduct.retail_price_usd;
        if (retail && payload.price) {
          const saved = retail - payload.price;
          const pct = Math.round((saved / retail) * 100);
          dom.priceSavings.textContent = `${formatPrice(saved)} (${pct}%)`;
        }
      }
      sendResponse({ received: true });
      break;
    }

    // ─── Dissolve Messages ──────────────────────────────
    case 'host_dissolve_point': {
      dissolvePoint(payload.pointId);
      sendResponse({ received: true });
      break;
    }

    case 'host_suggest_point': {
      suggestPoint(payload.pointId);
      sendResponse({ received: true });
      break;
    }

    case 'host_restore_point': {
      restorePoint(payload.pointId);
      sendResponse({ received: true });
      break;
    }

    case 'host_restore_last': {
      restoreLastDissolved();
      sendResponse({ received: true });
      break;
    }

    case 'host_reset_points': {
      resetAllPoints();
      sendResponse({ received: true });
      break;
    }

    case 'host_get_point_states': {
      sendResponse({
        received: true,
        points: talkingPoints.map(p => ({ id: p.id, type: p.type, text: p.text, state: p.state })),
      });
      break;
    }

    case 'connection_update': {
      dom.connectionBadge.textContent = payload.connected ? 'Connected' : 'Not Connected';
      dom.connectionBadge.className = `badge ${payload.connected ? 'connected' : 'disconnected'}`;
      if (payload.connected && !sessionStartTime) startSessionTimer();
      sendResponse({ received: true });
      break;
    }

    case 'ping': {
      sendResponse({ success: true, source: 'host_display_v2', timestamp: Date.now() });
      break;
    }

    default:
      sendResponse({ received: true });
  }

  return false;
});

// ─── Register with Service Worker ─────────────────────────
async function registerWithServiceWorker() {
  try {
    await chrome.runtime.sendMessage({
      source: 'host_display_v2',
      type: 'host_display_ready',
      payload: { timestamp: Date.now(), version: 2 },
    });
    console.info('[Host Display v2] Registered with service worker');
  } catch (err) {
    if (!err.message?.includes('Extension context invalidated')) {
      console.warn('[Host Display v2] Registration failed:', err.message);
    }
  }
}

// ─── Fullscreen Toggle ────────────────────────────────────
$('btn-fullscreen')?.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
    document.body.classList.add('fullscreen');
  } else {
    document.exitFullscreen();
    document.body.classList.remove('fullscreen');
  }
});

// ─── Initialize ───────────────────────────────────────────
registerWithServiceWorker();
setInterval(() => registerWithServiceWorker(), 25000);

// ─── Expose for debugging ─────────────────────────────────
globalThis.__hostDisplayV2 = {
  showProduct,
  loadBattleCards,
  findBattleCard,
  addChatMessage,
  showOperatorMessage,
  dissolvePoint,
  restorePoint,
  restoreLastDissolved,
  resetAllPoints,
  talkingPoints: () => talkingPoints,
  dissolutionHistory: () => dissolutionHistory,
  battleCards,
};
