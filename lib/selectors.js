/**
 * selectors.js — ALL DOM selectors for LivePilot.
 *
 * RULES:
 * - NEVER hardcode a selector outside this file.
 * - Each selector chain is an array, ordered most-specific → least-specific.
 * - dom-adapter.js tries each in order until one matches.
 * - Selectors prefixed with "text:" are handled by text-matching in dom-adapter.js
 *   Format: "text:tagName:search text" (case-insensitive contains match)
 *
 * Based on DOM Discovery from 2026-03-24 and 2026-03-25 (real live session).
 * TikTok LIVE Console uses ByteDance Arco Design (arco-*) components.
 * Zero data-testid attributes on page — selectors rely on Arco classes,
 * tracking classes, Tailwind utility classes, and text content.
 *
 * IMPORTANT: Product list is virtualized (arco-list-virtual) — only visible
 * products are in the DOM. Elements recycle on scroll.
 *
 * Loaded as a classic script by content scripts (no ES module export).
 * Attaches to self.LivePilot global namespace.
 */

self.LivePilot = self.LivePilot || {};

self.LivePilot.SELECTORS = {
  // ─── Shopping Bag (product list in LIVE Console) ───────────────
  // Products live under "Buy now" tab in a virtualized Arco list.
  // Two row types share div.rounded-4.mb-8:
  //   1. Product cards: have child div with styled-components class (sc-*) and order input
  //   2. "Product list in this LIVE" summary: has child div.mb-8.rounded-8
  // Filter in code using presence of productName element to distinguish.
  shoppingBag: {
    // The tab that shows products ("Buy now (N/N)")
    buyNowTab: [
      'div#arco-tabs-0-tab-0',                         // ID-based (may change across sessions)
      'text:div.arco-tabs-header-title:Buy now',        // Text match on Arco tab
      '.arco-tabs-header-title-active',                 // Currently selected tab
    ],
    // Search input for filtering products
    searchInput: [
      'input[placeholder="Search product ID or product name"]',  // Exact placeholder match
      'input.arco-input[placeholder*="Search product"]',         // Partial placeholder
      'input.arco-input[placeholder*="product"]',                // Looser match
    ],
    // The virtualized list container holding product rows
    container: [
      'div.arco-list-content.arco-list-virtual',       // Arco virtualized list
      '[class*="virtualized-container"]',               // Module hash class (partial)
      'div.arco-list-content',                         // Non-virtualized fallback
    ],
    // Individual product row/card (both product cards AND summary row)
    // Code must filter to actual products using hasProductName check
    productRow: [
      'div.rounded-4.mb-8',                            // Structural: rounded card with margin
    ],
    // Product name text within a row
    // Discovered 2026-03-25: classless <span> inside Tailwind utility div
    // e.g. "Pre-owned PRADA Matelassé leather ... S012260225154"
    productName: [
      'div.max-h-40.text-body-m-regular > span',       // Tailwind height + typography class → span
      'div.text-body-m-regular > span',                 // Looser: just the typography class
      '[class*="product-name"]',                        // Partial class match (fallback)
    ],
    // Product price text within a row
    // Discovered 2026-03-25: design token class "text-body-l-medium" on <span>
    // e.g. "$299.00"
    productPrice: [
      'div.mb-4 span.text-body-l-medium',              // Scoped: price inside margin-bottom-4 div
      'span.text-body-l-medium',                        // Design token class (stable)
      '[class*="price"]',                               // Partial class match (fallback)
    ],
    // Product image thumbnail within a row
    // Discovered 2026-03-25: img.w-full inside module-hashed card-img wrapper
    // 300x300 product images
    productImage: [
      'div[class*="card-img"] > img',                  // Module hash parent with "card-img" substring
      'img.w-full',                                    // Full-width img inside row (common pattern)
      'img',                                           // Last resort: first img in row
    ],
    // Product ID — NOT available as a data attribute on the DOM.
    // Product SKU is embedded at the end of the product name text (e.g. "S012260225154").
    // Extraction handled in code, not via selector.
    productId: [
      '[data-product-id]',                             // Wishful — doesn't exist, kept as first-try
      '[data-id]',                                     // Also doesn't exist
    ],
    // Order quantity input (Arco InputNumber) — per product row
    // Discovered 2026-03-25: has data-tid="m4b_input_number" tracking attribute
    quantityInput: [
      'input[data-tid="m4b_input_number"]',            // ByteDance tracking attribute (most stable!)
      'input[role="spinbutton"]',                      // ARIA role on Arco InputNumber
      'div.ml-2.w-52 input.arco-input',               // Structural: input inside size container
    ],
    // Product checkbox (for bulk selection)
    productCheckbox: [
      'div.absolute.left-4 label.arco-checkbox input', // Checkbox overlaid on product image
      'label.arco-checkbox input[type="checkbox"]',    // Generic Arco checkbox in row
    ],
    // Stock warning text (e.g. "Low Stock: 1")
    stockWarning: [
      'span.text-function-warning',                    // Warning color token class
      'span.text-overflow-single.text-function-warning', // Full class match
    ],
    // Per-product analytics labels (in expandable section at bottom of card)
    analyticsLabels: [
      'div.bg-neutral-bg1.flex div.text-body-s-regular.text-neutral-text3',
    ],
    // "Product list in this LIVE" summary row (NOT a product — filter this OUT)
    // Has text "Product list in this LIVE" and product thumbnails
    liveProductSummary: [
      'text:div.text-neutral-text1:Product list in this LIVE', // Text match
      'div.mb-8.rounded-8 div.text-neutral-text1.mb-8',       // Structural
    ],
  },

  // ─── Toolbar (action buttons row) ───────────────────────────────
  toolbar: {
    // Generic toolbar action row (Go LIVE / Add / etc.). Flash sale + pin
    // buttons are no longer scraped — features removed 2026-05-03.
    container: [
      'div.gap-10.flex.flex-nowrap',                   // Flex container with gap + nowrap
      'div.gap-10.flex',                               // Flex container with gap
    ],
    goLiveButton: [
      'text:button.arco-btn-status-danger:Go LIVE now',
      'text:button:Go LIVE now',
    ],
    addButton: [
      'text:button.m4b-button-link:Add',
      'text:button:Add',
    ],
  },

  // ─── Tabs ──────────────────────────────────────────────────────
  tabs: {
    buyNow: [
      'div#arco-tabs-0-tab-0',
      'text:div.arco-tabs-header-title:Buy now',
    ],
    auction: [
      'div#arco-tabs-0-tab-1',
      'text:div.arco-tabs-header-title:Auction',
    ],
    analytics: [
      'div#arco-tabs-1-tab-0',
      'text:div.arco-tabs-header-title:Analytics',
    ],
  },

  // ─── LIVE Analytics (embedded in LIVE Console page) ─────────────
  // Discovered 2026-03-26 via CDP screenshot + DOM query.
  // Metrics panel is on the right side of the LIVE Console — NO separate page needed!
  // Layout: 3x2 CSS Grid (grid-cols-3), each card is a div[class*="metricCard"].
  // Label: div.text-body-s-medium with index-module__name--* class
  // Value: sibling div.text-body-l-medium with index-module__data--* class
  liveAnalytics: {
    // The grid container holding all 6 metric cards
    container: [
      'div.grid.grid-cols-3.gap-8.mb-8',              // CSS Grid container
      'div.grid.grid-cols-3',                          // Looser match
    ],
    // Individual metric card
    metricCard: [
      'div[class*="metricCard"]',                      // Module-hashed class
      'div.bg-neutral-bg2.rounded-4',                  // Tailwind background + rounded
    ],
    // Metric label (inside card)
    metricLabel: [
      'div[class*="name--"].text-body-s-medium',       // Module hash "name" + design token
      'div.text-neutral-text3.text-body-s-medium',     // Color token + size
    ],
    // Metric value (inside card, sibling of label)
    metricValue: [
      'div[class*="data--"].text-body-l-medium',       // Module hash "data" + design token
      'div.text-neutral-text1.text-body-l-medium',     // Color token + size
    ],
    // Specific metrics by label text (use with text: selector inside container)
    gmv: [
      'text:div.text-body-s-medium:GMV',
    ],
    viewers: [
      'text:div.text-body-s-medium:Current viewers',
    ],
    impressions: [
      'text:div.text-body-s-medium:LIVE impression',
    ],
    tapThroughRate: [
      'text:div.text-body-s-medium:Tap-through rate',
    ],
    avgViewingDuration: [
      'text:div.text-body-s-medium:Avg. viewing duration',
    ],
    productClicks: [
      'text:div.text-body-s-medium:Product clicks',
    ],
    // "LIVE dashboard" link (top-right corner)
    dashboardLink: [
      'text:span:LIVE dashboard',
      'a[href*="dashboard"]',
    ],
    // Suggestion box
    suggestionContainer: [
      'div.arco-collapse.m4b-collapse[class*="bg-neu"]',
    ],
  },

  // ─── LIVE Board / Workbench (separate page — fallback for detailed metrics) ──
  // URL: shop.tiktok.com/workbench/live/overview
  // Only needed if embedded analytics panel doesn't have enough detail.
  // Selectors TBD — need to inspect during a live session.
  liveBoard: {
    viewers: [
      '[class*="viewer-count"]',
      '[class*="viewer"]',
    ],
    gmv: [
      '[class*="gmv"]',
      '[class*="GMV"]',
    ],
    ctr: [
      '[class*="ctr"]',
      '[class*="CTR"]',
    ],
    ctor: [
      '[class*="ctor"]',
      '[class*="CTOR"]',
    ],
  },

  // ─── Chat ──────────────────────────────────────────────────────
  // Three virtualized lists exist on the LIVE Console (chat, orders, viewer
  // activity). All share `div.arco-list-content.arco-list-virtual` so we
  // disambiguate by walking up from the chat textarea — see chat-probe.json
  // (2026-05-02). The chat list is the unique virtualized list that lives
  // inside the depth-4 ancestor `h-full w-full pb-12 flex flex-col relative`
  // of the textarea[placeholder="Type something..."].
  chat: {
    input: [
      'textarea[placeholder="Type something..."]',
      'textarea.arco-textarea.m4b-input-textarea',
      'textarea.arco-textarea',
    ],
    // Anchor: the chat-pane wrapper that holds exactly one virtualized list.
    // Walk up from chat input to find this; then querySelector the list inside.
    // (Used as a className contains-check, not a CSS selector — see live-console.js.)
    chatPaneAncestorClasses: 'h-full w-full pb-12 flex flex-col relative',
    // Each chat row inside the chat list. Discovered 2026-05-02 via chat-probe.json.
    // Distinct from order rows (`type="order_filter"`) and viewer-activity rows
    // (`type="open_product_detail_page_filter"`) which carry explicit type attrs.
    chatRow: [
      'div.rounded-8.relative.cursor-pointer',          // Chat-row Tailwind signature
      'div.rounded-8.cursor-pointer',                    // Looser
    ],
    // Inside each chat row:
    chatRowAvatarImg: [
      'div[data-tid="m4b_avatar"] img',                 // Most stable — ByteDance tracking attr
      'span.m4b-avatar-image > img',
      'img',                                            // Last resort: first img in row
    ],
    chatRowDisplayName: [
      'div.text-body-m-medium.text-neutral-text1 div div',  // Nested clamp div with the name text
      'div.text-body-m-medium.text-neutral-text1',          // Looser: container div
    ],
    chatRowBadge: [
      'span.truncate',                                   // "Host" / "Mod" badge text
    ],
    chatRowMessage: [
      'div.text-neutral-text1.pl-32.text-body-m-regular',  // Indented (pl-32) message body
      'div.pl-32.text-body-m-regular',
    ],
    // Other lists on the same page — kept explicit so future scrapers don't
    // accidentally pick them up as chat. Both carry a `type=` attribute.
    purchaseRowMarker: 'div[type="order_filter"]',
    viewerActivityRowMarker: 'div[type="open_product_detail_page_filter"]',
    // Viewer filter dropdown
    viewerFilter: [
      'input[placeholder="All viewers"]',
      'input.arco-input-tag-input',
    ],
  },

  // ─── LIVE Product Dashboard (auto-pin, BUG-0095) ─────────────────
  // shop.tiktok.com/streamer/live/product/dashboard — the product
  // management surface during a live. Pin selectors revived from the
  // 2026-03-25 live-console DOM discovery (same Arco components, and the
  // pc_pin_product_list_pin tracking class survives UI reskins better
  // than anything structural). The rest are layered text: fallbacks
  // pending a real-session DOM discovery pass on the dashboard itself.
  productDashboard: {
    // Search input above the product list ("search by product name/ID")
    searchInput: [
      'input[placeholder*="Search product"]',
      'input.arco-input[placeholder*="product"]',
      'input[placeholder*="Search"]',
      'input.arco-input',
    ],
    // A product card/row in the dashboard list
    productRow: [
      'div[data-log-config-id="product_card"]',        // Tracking attr if present
      'div.rounded-4.mb-8',                            // Structural (live-console pattern)
      'div[class*="product-card"]',
      'tr.arco-table-tr',                              // Table layout fallback
    ],
    // Product title text within a row — the SKU (screening code) is part
    // of the title string, so matching = title.includes(sku)
    productTitle: [
      'div.max-h-40.text-body-m-regular > span',       // live-console discovered
      'div.text-body-m-regular > span',
      '[class*="product-name"]',
      '[class*="title"]',
    ],
    // Pin button (not yet pinned) inside a product row
    pinButton: [
      'button.pc_pin_product_list_pin',                // Tracking class (most stable!)
      'button.arco-btn-primary[class*="pined-button"]',
      'text:button:Pin',
    ],
    // Unpin button (currently pinned product) — used to detect pinned state
    unpinButton: [
      'button.arco-btn-secondary[class*="pined-button"]',
      'text:button:Unpin',
    ],
    // "Add" / "Add products" button that opens the add-product flow
    addButton: [
      'text:button:Add products',
      'text:button:Add product',
      'text:button:Add',
    ],
    // The add-product modal/drawer
    addModal: [
      'div.arco-modal',
      'div.arco-drawer',
      '[role="dialog"]',
    ],
    // Search input inside the add-product modal
    addModalSearchInput: [
      'div.arco-modal input[placeholder*="Search"]',
      'div.arco-drawer input[placeholder*="Search"]',
      '[role="dialog"] input.arco-input',
    ],
    // Product row inside the add-product modal
    addModalProductRow: [
      'div.arco-modal tr.arco-table-tr',
      '[role="dialog"] tr.arco-table-tr',
      'div.arco-modal div.rounded-4.mb-8',
      '[role="dialog"] div[class*="product-card"]',
    ],
    // Row selection control (checkbox) inside the modal row
    addModalRowSelect: [
      'input[type="checkbox"]',
      'label.arco-checkbox',
      'span.arco-checkbox-mask',
    ],
    // Confirm button in the modal footer ("Add product(s)")
    addModalConfirm: [
      'text:button:Add products',
      'text:button:Add product',
      'text:button:Confirm',
      'div.arco-modal-footer button.arco-btn-primary',
      '[role="dialog"] button.arco-btn-primary',
    ],
  },
};
