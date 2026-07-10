/**
 * host.js — Host Display controller for LivePilot.
 *
 * This page runs on the host's second screen (a Chrome extension page).
 * It receives product data and chat updates from the service worker,
 * and displays a teleprompter-style view optimized for on-camera use.
 *
 * Communication:
 *   Service Worker → host.js via chrome.runtime.onMessage
 *   host.js → Service Worker via chrome.runtime.sendMessage
 */

// ─── State ────────────────────────────────────────────────
let currentProduct = null;
let productStartTime = null;
let productTimerInterval = null;
let sessionStartTime = null;
let sessionTimerInterval = null;
let battleCards = new Map();  // screening_code → full product data
let intentMessages = [];

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
  celebrityText: $('celebrity-text'),
  raritySection: $('rarity-section'),
  rarityText: $('rarity-text'),
  operatorWrap: $('operator-msg-wrap'),
  operatorMsg: $('operator-msg'),
  intentChat: $('intent-chat'),
  timerValue: $('timer-value'),
  nextProductName: $('next-product-name'),
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

// ─── Display a Product ────────────────────────────────────
function showProduct(product) {
  currentProduct = product;
  productStartTime = Date.now();
  startProductTimer();

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

  // Calculate savings vs retail
  if (retailPrice && ourPrice) {
    const saved = retailPrice - (flashPrice || ourPrice);
    const pct = Math.round((saved / retailPrice) * 100);
    dom.priceSavings.textContent = `${formatPrice(saved)} (${pct}%)`;
  } else {
    dom.priceSavings.textContent = '—';
  }

  // Selling Points
  renderList(dom.sellingPoints, product.selling_points, 'No selling points available');

  // Fun Facts
  renderList(dom.funFacts, product.fun_facts, 'No stories available');

  // Celebrity
  if (product.celebrity_mentions) {
    dom.celebritySection.style.display = 'block';
    dom.celebrityText.textContent = product.celebrity_mentions;
  } else {
    dom.celebritySection.style.display = 'none';
  }

  // Rarity
  if (product.rarity_notes) {
    dom.raritySection.style.display = 'block';
    dom.rarityText.textContent = product.rarity_notes;
  } else {
    dom.raritySection.style.display = 'none';
  }

  // Clear intent chat for new product
  intentMessages = [];
  renderIntentChat();
}

function renderList(container, items, emptyMsg) {
  container.textContent = '';
  if (!items || items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = emptyMsg;
    container.appendChild(li);
    return;
  }
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    container.appendChild(li);
  }
}

// ─── Product Timer ────────────────────────────────────────
function startProductTimer() {
  if (productTimerInterval) clearInterval(productTimerInterval);
  productTimerInterval = setInterval(() => {
    if (!productStartTime) return;
    const elapsed = Date.now() - productStartTime;
    dom.timerValue.textContent = formatTime(elapsed);

    // Warning at 5 min, overtime at 8 min
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
      ? `⏱ ${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `⏱ ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }, 1000);
}

// ─── Chat Filtering (Purchase Intent Only) ────────────────
const INTENT_PATTERNS = /how much|price|buy|want|can i|show me|available|ship|size|color|strap|year|condition|authentic|real|discount|deal|offer|cost|\?$/i;

function addChatMessage(name, text) {
  if (!INTENT_PATTERNS.test(text)) return;  // Filter out non-intent messages

  intentMessages.unshift({ name, text, time: Date.now() });
  // Keep last 8 messages
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
      // Also index by brand+model for fuzzy matching
      const key = `${(p.brand_name || '').toLowerCase()}|${(p.model_name || '').toLowerCase()}`;
      if (!battleCards.has(key)) battleCards.set(key, p);
    }
    console.info(`[Host Display] Loaded ${products.length} battle cards`);
    return products.length;
  } catch (err) {
    console.error('[Host Display] Failed to load battle cards:', err);
    return 0;
  }
}

// ─── Find battle card by various identifiers ──────────────
function findBattleCard(identifier) {
  if (!identifier) return null;
  // Direct lookup by screening_code or product_code
  if (battleCards.has(identifier)) return battleCards.get(identifier);
  // Try lowercase brand|model key
  const lower = identifier.toLowerCase();
  for (const [key, card] of battleCards) {
    if (key.includes(lower) || lower.includes(key)) return card;
  }
  // Try partial name match
  for (const [, card] of battleCards) {
    const cardName = `${card.brand_name} ${card.model_name}`.toLowerCase();
    if (cardName.includes(lower) || lower.includes(card.model_name?.toLowerCase())) return card;
  }
  return null;
}

// ─── Message Handler (from Service Worker) ────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'host_show_product': {
      const card = payload.product || findBattleCard(payload.identifier);
      if (card) {
        showProduct(card);
      } else {
        console.warn('[Host Display] Product not found:', payload.identifier);
      }
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
      if (payload.viewers != null) dom.viewerCount.textContent = `👁 ${payload.viewers}`;
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

    case 'connection_update': {
      dom.connectionBadge.textContent = payload.connected ? 'Connected' : 'Not Connected';
      dom.connectionBadge.className = `badge ${payload.connected ? 'connected' : 'disconnected'}`;
      if (payload.connected && !sessionStartTime) startSessionTimer();
      sendResponse({ received: true });
      break;
    }

    case 'ping': {
      sendResponse({ success: true, source: 'host_display', timestamp: Date.now() });
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
      source: 'host_display',
      type: 'host_display_ready',
      payload: { timestamp: Date.now() },
    });
    console.info('[Host Display] Registered with service worker');
  } catch (err) {
    if (!err.message?.includes('Extension context invalidated')) {
      console.warn('[Host Display] Registration failed:', err.message);
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

// Re-register periodically (service worker may restart)
setInterval(() => registerWithServiceWorker(), 25000);

// Expose for debugging and manual product loading
globalThis.__hostDisplay = {
  showProduct,
  loadBattleCards,
  findBattleCard,
  addChatMessage,
  showOperatorMessage,
  battleCards,
};
