/**
 * Logger — timestamped action logging for LivePilot.
 *
 * Every event includes three time values for video mapping:
 * - timestamp:     epoch ms (for computing / cross-session comparison)
 * - wallClock:     ISO string (for human reading)
 * - videoOffsetMs: ms since session start (for seeking in the recorded video)
 *
 * To jump to any event in the video: video.currentTime = event.videoOffsetMs / 1000
 * If video recording started at a different time, apply videoStartOffset calibration.
 *
 * Event schema: { timestamp, wallClock, videoOffsetMs, type, action, params, success, metadata? }
 */

import { StorageAdapter } from './storage-adapter.js';

// Session key format: session_log_20260322_143000
function makeSessionKey() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `session_log_${date}_${time}`;
}

// Format ms offset as HH:MM:SS for quick reference
function formatOffset(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export class Logger {
  constructor(eventBus) {
    this._eventBus = eventBus;
    this._sessionKey = null;
    this._sessionStartTime = null;
    this._videoStartOffset = 0;  // ms offset if video starts before/after session
    this._unsubscribers = [];
  }

  /**
   * Start logging for a new session.
   * @param {string} [sessionKey] - Override session key (for testing)
   */
  async startSession(sessionKey) {
    this._sessionKey = sessionKey || makeSessionKey();
    this._sessionStartTime = Date.now();
    this._videoStartOffset = 0;

    await StorageAdapter.set(this._sessionKey, {
      sessionId: this._sessionKey,
      startTime: this._sessionStartTime,
      startTimeISO: new Date(this._sessionStartTime).toISOString(),
      endTime: null,
      videoStartOffset: 0,
      events: [],
      metricSnapshots: [],
    });

    // Subscribe to all loggable event types
    // (flash_sale + pin removed 2026-05-03 along with auto-action features)
    const eventTypes = [
      'metric_alert',
      'metric_update',
      'setting_change',
      'error',
    ];

    for (const type of eventTypes) {
      const unsub = this._eventBus.on(type, (payload) => {
        this.log(type, payload);
      });
      this._unsubscribers.push(unsub);
    }

    console.info(`[LivePilot Logger] Session started: ${this._sessionKey} at ${new Date(this._sessionStartTime).toISOString()}`);
  }

  /**
   * Set video start offset (if video recording started at a different time).
   * Positive = video started BEFORE session (video is ahead).
   * Negative = video started AFTER session (video is behind).
   * @param {number} offsetMs - milliseconds
   */
  async setVideoStartOffset(offsetMs) {
    this._videoStartOffset = offsetMs;
    const session = await StorageAdapter.get(this._sessionKey);
    if (session) {
      session.videoStartOffset = offsetMs;
      await StorageAdapter.set(this._sessionKey, session);
    }
    console.info(`[LivePilot Logger] Video start offset set to ${offsetMs}ms`);
  }

  /**
   * Log a single event to the current session.
   */
  async log(type, { action = '', params = {}, success = true, metadata = {} } = {}) {
    if (!this._sessionKey) {
      console.warn('[LivePilot Logger] No active session — event dropped:', type);
      return;
    }

    const now = Date.now();
    const videoOffsetMs = (now - this._sessionStartTime) + this._videoStartOffset;

    const event = {
      timestamp: now,
      wallClock: new Date(now).toISOString(),
      videoOffsetMs,
      videoTime: formatOffset(Math.max(0, videoOffsetMs)),
      type,
      action,
      params,
      success,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };

    const session = await StorageAdapter.get(this._sessionKey);
    if (!session) return;

    if (type === 'metric_update') {
      session.metricSnapshots.push(event);
    } else {
      session.events.push(event);
    }

    await StorageAdapter.set(this._sessionKey, session);
  }

  /**
   * End the current session (sets endTime).
   */
  async endSession() {
    if (!this._sessionKey) return;

    const session = await StorageAdapter.get(this._sessionKey);
    if (session) {
      const now = Date.now();
      session.endTime = now;
      session.endTimeISO = new Date(now).toISOString();
      session.durationMs = now - session.startTime;
      session.durationFormatted = formatOffset(session.durationMs);
      await StorageAdapter.set(this._sessionKey, session);
    }

    for (const unsub of this._unsubscribers) {
      unsub();
    }
    this._unsubscribers = [];

    console.info(`[LivePilot Logger] Session ended: ${this._sessionKey}`);
    this._sessionKey = null;
    this._sessionStartTime = null;
  }

  get sessionKey() {
    return this._sessionKey;
  }

  get sessionStartTime() {
    return this._sessionStartTime;
  }

  /**
   * Export the current session as a JSON object.
   */
  async exportSession() {
    if (!this._sessionKey) return null;
    return StorageAdapter.get(this._sessionKey);
  }
}
