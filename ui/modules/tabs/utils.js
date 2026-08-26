/**
 * Shared utilities for tabs modules
 * Extracted to eliminate duplicate code
 */

/**
 * Escape HTML special characters to prevent XSS.
 *
 * S468 weaker-duplicate hunt: the old DOM-based version (div.textContent ->
 * innerHTML) did NOT escape quotes, and callers interpolate into ATTRIBUTE
 * contexts (bridge.js title="...", voice-broker.js data-state="...") where a
 * bare `"` breaks out. Replaced with the strong 5-entity twin used by the
 * sibling copies in the codebase (phone-voice-client / squid-room-surface);
 * also no longer swallows non-string values.
 * @param {unknown} value - Value to escape
 * @returns {string} Escaped text
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  escapeHtml,
};
