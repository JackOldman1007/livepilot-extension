/**
 * StorageAdapter — async wrapper over chrome.storage.
 *
 * - Settings (flash template, thresholds): chrome.storage.sync
 * - Session data (logs, metrics): chrome.storage.local
 *
 * ALL storage access in LivePilot goes through this module.
 * In v2 this can be swapped for an API client without touching callers.
 */

// Keys that live in sync storage (small, cross-device)
const SYNC_KEYS = new Set([
  'flash_template',
  'alert_thresholds',
  'selector_overrides',
  'settings',
  'livepilot_api',
]);

function getArea(key) {
  return SYNC_KEYS.has(key) ? 'sync' : 'local';
}

function getStorage(area) {
  return chrome.storage[area];
}

export const StorageAdapter = {
  /**
   * Get a value by key.
   * @param {string} key
   * @returns {Promise<any>} Resolved value, or undefined if not set
   */
  async get(key) {
    const area = getArea(key);
    const result = await getStorage(area).get(key);
    return result[key];
  },

  /**
   * Set a value by key.
   * @param {string} key
   * @param {any} value
   */
  async set(key, value) {
    const area = getArea(key);
    await getStorage(area).set({ [key]: value });
  },

  /**
   * Remove a key.
   * @param {string} key
   */
  async remove(key) {
    const area = getArea(key);
    await getStorage(area).remove(key);
  },

  /**
   * Get multiple keys at once.
   * @param {string[]} keys
   * @returns {Promise<object>} Key-value map
   */
  async getMany(keys) {
    // Split keys by storage area
    const syncKeys = keys.filter(k => SYNC_KEYS.has(k));
    const localKeys = keys.filter(k => !SYNC_KEYS.has(k));

    const results = {};

    if (syncKeys.length > 0) {
      const syncResult = await getStorage('sync').get(syncKeys);
      Object.assign(results, syncResult);
    }
    if (localKeys.length > 0) {
      const localResult = await getStorage('local').get(localKeys);
      Object.assign(results, localResult);
    }

    return results;
  },

  /**
   * Append an item to an array stored at key.
   * Used for session logs — avoids read-modify-write race conditions
   * by reading and writing in one operation.
   * @param {string} key
   * @param {any} item
   */
  async append(key, item) {
    const current = (await this.get(key)) || [];
    current.push(item);
    await this.set(key, current);
  },

  /**
   * Get all keys matching a prefix from local storage.
   * Useful for listing session logs (session_log_*).
   * @param {string} prefix
   * @returns {Promise<object>} Matching key-value pairs
   */
  async getByPrefix(prefix) {
    const all = await getStorage('local').get(null);
    const matched = {};
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(prefix)) {
        matched[key] = value;
      }
    }
    return matched;
  },
};

/**
 * Default settings — used when no user config exists yet.
 */
export const DEFAULTS = {
  flash_template: {
    discountPercent: 10,
    defaultQuantity: 5,
    countdownSeconds: 20,
    durationMinutes: 10,
  },
  alert_thresholds: {
    viewerDropPercent: 30,
    viewerDropWindowMinutes: 5,
    ctrFloor: 3.0,
    ctorFloor: 1.5,
  },
};
