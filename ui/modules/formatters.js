/**
 * Unified formatting utilities for Hivemind UI.
 * Consolidates duplicate time formatting logic from:
 * - renderer.js (formatTimeSince)
 * - triggers.js (formatDuration)
 * - tabs.js (formatDuration)
 * - replay/debug-replay.js (formatDuration)
 *
 * Tech debt item #10 from Session 57 audit.
 */

/**
 * Format a duration in milliseconds to human-readable string.
 *
 * @param {number} ms - Duration in milliseconds
 * @param {Object} options - Formatting options
 * @param {('short'|'compound'|'precise')} [options.style='compound'] - Format style
 *   - 'short': Single largest unit (e.g., "5s", "10m", "2h")
 *   - 'compound': Up to two units (e.g., "2h 30m", "5m 30s")
 *   - 'precise': Decimal precision (e.g., "1.5s", "2.5m", "500ms")
 * @returns {string} Formatted duration string
 */
function formatDuration(ms, options = {}) {
  const { style = 'compound' } = options;

  if (style === 'precise') {
    return formatPrecise(ms);
  } else if (style === 'short') {
    return formatShort(ms);
  } else {
    return formatCompound(ms);
  }
}

/**
 * Short format - single largest unit.
 * Used by health indicators in renderer.js
 */
function formatShort(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 0) return '-';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

/**
 * Compound format - up to two units for better precision.
 * Used by triggers.js and tabs.js
 */
function formatCompound(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Precise format - decimal notation for exact timing.
 * Used by replay/debug-replay.js and memory-summarizer.js
 */
function formatPrecise(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

/**
 * Format time elapsed since a timestamp.
 * Convenience wrapper for formatDuration with 'short' style.
 *
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} Formatted time since string
 */
function formatTimeSince(timestamp) {
  if (!timestamp) return '-';
  const elapsed = Date.now() - timestamp;
  if (elapsed < 0) return '-';
  return formatDuration(elapsed, { style: 'short' });
}

module.exports = {
  formatDuration,
  formatTimeSince,
  // Export individual formatters for direct use if needed
  formatShort,
  formatCompound,
  formatPrecise
};
