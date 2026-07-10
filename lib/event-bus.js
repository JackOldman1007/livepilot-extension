/**
 * EventBus — internal pub/sub for LivePilot.
 * Used by service worker and side panel (ES module).
 * Content scripts communicate via chrome.runtime.sendMessage instead.
 */

export class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event type.
   * @param {string} type - Event type (e.g. "chat_message", "metric_update", "host_show_product")
   * @param {Function} handler - Callback receiving the event payload
   * @returns {Function} Unsubscribe function
   */
  on(type, handler) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type).add(handler);

    // Return unsubscribe function for convenience
    return () => this.off(type, handler);
  }

  /**
   * Unsubscribe from an event type.
   */
  off(type, handler) {
    const handlers = this._listeners.get(type);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) this._listeners.delete(type);
    }
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} type - Event type
   * @param {object} payload - Event data
   */
  emit(type, payload) {
    const handlers = this._listeners.get(type);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] Error in handler for "${type}":`, err);
      }
    }
  }

  /**
   * Subscribe to an event type, but only fire once.
   */
  once(type, handler) {
    const wrappedHandler = (payload) => {
      this.off(type, wrappedHandler);
      handler(payload);
    };
    return this.on(type, wrappedHandler);
  }

  /**
   * Remove all listeners (useful for teardown/testing).
   */
  clear() {
    this._listeners.clear();
  }
}
