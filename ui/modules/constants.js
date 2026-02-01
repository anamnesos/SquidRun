/**
 * Shared constants for UI modules.
 * Consolidated from renderer.js, watcher.js, terminal.js (Session 58, Finding #8)
 */

// =============================================================================
// EXISTING CONSTANTS
// =============================================================================
const BYPASS_CLEAR_DELAY_MS = 75;

// =============================================================================
// UI / RENDERER CONSTANTS
// =============================================================================
const BUTTON_DEBOUNCE_MS = 500;
const SPINNER_INTERVAL_MS = 80;
const UI_IDLE_THRESHOLD_MS = 30000;       // 30s before showing idle state in UI
const UI_STUCK_THRESHOLD_MS = 60000;      // 60s without output = potentially stuck
const UI_IDLE_CLAIM_THRESHOLD_MS = 30000; // 30s idle = can show claim button

// =============================================================================
// WATCHER CONSTANTS
// =============================================================================
const TRIGGER_READ_RETRY_MS = 50;
const WATCHER_DEBOUNCE_MS = 200;          // Batch events within 200ms window

// =============================================================================
// TERMINAL / INJECTION CONSTANTS
// =============================================================================
// Typing guard
const TYPING_GUARD_MS = 300;              // Defer injection if user typed within this window

// Idle detection for injection
const INJECTION_IDLE_THRESHOLD_MS = 2000; // No output for 2s = idle for injection
const MAX_QUEUE_TIME_MS = 10000;          // Consider force inject after 10 seconds
const FORCE_INJECT_IDLE_MS = 500;         // For force-inject, require 500ms of silence
const EXTREME_WAIT_MS = 30000;            // Log warning if message queued this long
const ABSOLUTE_MAX_WAIT_MS = 60000;       // Emergency fallback: force inject after 60s
const QUEUE_RETRY_MS = 200;               // Check queue every 200ms
const BROADCAST_STAGGER_MS = 100;         // Delay between panes in broadcast
const INJECTION_LOCK_TIMEOUT_MS = 1000;   // Safety release if callbacks missed

// Adaptive Enter delay constants
const ENTER_DELAY_IDLE_MS = 50;           // Pane idle: fast Enter
const ENTER_DELAY_ACTIVE_MS = 150;        // Pane active: medium delay
const ENTER_DELAY_BUSY_MS = 300;          // Pane busy: longer delay
const PANE_ACTIVE_THRESHOLD_MS = 500;     // Recent output threshold for "active"
const PANE_BUSY_THRESHOLD_MS = 100;       // Very recent output threshold for "busy"
const FOCUS_RETRY_DELAY_MS = 20;          // Delay between focus retry attempts
const ENTER_VERIFY_DELAY_MS = 200;        // Delay before checking if Enter succeeded
const ENTER_RETRY_INTERVAL_MS = 200;      // Interval between checking if pane is idle
const PROMPT_READY_TIMEOUT_MS = 3000;     // Max time to wait for prompt-ready detection

module.exports = {
  // Existing
  BYPASS_CLEAR_DELAY_MS,
  // UI / Renderer
  BUTTON_DEBOUNCE_MS,
  SPINNER_INTERVAL_MS,
  UI_IDLE_THRESHOLD_MS,
  UI_STUCK_THRESHOLD_MS,
  UI_IDLE_CLAIM_THRESHOLD_MS,
  // Watcher
  TRIGGER_READ_RETRY_MS,
  WATCHER_DEBOUNCE_MS,
  // Terminal / Injection
  TYPING_GUARD_MS,
  INJECTION_IDLE_THRESHOLD_MS,
  MAX_QUEUE_TIME_MS,
  FORCE_INJECT_IDLE_MS,
  EXTREME_WAIT_MS,
  ABSOLUTE_MAX_WAIT_MS,
  QUEUE_RETRY_MS,
  BROADCAST_STAGGER_MS,
  INJECTION_LOCK_TIMEOUT_MS,
  ENTER_DELAY_IDLE_MS,
  ENTER_DELAY_ACTIVE_MS,
  ENTER_DELAY_BUSY_MS,
  PANE_ACTIVE_THRESHOLD_MS,
  PANE_BUSY_THRESHOLD_MS,
  FOCUS_RETRY_DELAY_MS,
  ENTER_VERIFY_DELAY_MS,
  ENTER_RETRY_INTERVAL_MS,
  PROMPT_READY_TIMEOUT_MS,
};
