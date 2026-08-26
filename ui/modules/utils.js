/**
 * SquidRun Utils - General utility functions
 * Extracted from renderer.js for modularization
 */

const log = require('./logger');
const { BUTTON_DEBOUNCE_MS } = require('./constants');

// Button debounce state - tracks last click time per button
const buttonDebounceState = {};

/**
 * Debounces button clicks to prevent rapid double-clicks
 * @param {string} buttonId - Unique identifier for the button
 * @param {Function} handler - Click handler to wrap
 * @returns {Function} Wrapped handler that debounces rapid clicks
 */
function debounceButton(buttonId, handler) {
  return function(...args) {
    const now = Date.now();
    const lastClick = buttonDebounceState[buttonId] || 0;
    if (now - lastClick < BUTTON_DEBOUNCE_MS) {
      log.info('UI', `Debounced rapid click on ${buttonId}`);
      return;
    }
    buttonDebounceState[buttonId] = now;
    return handler.apply(this, args);
  };
}

/**
 * Transforms title attributes into data-* attributes for shortcut tooltips
 * Extracts keyboard shortcuts from titles and applies styling classes
 */
function applyShortcutTooltips() {
  const shortcutRegex = /(Ctrl\+[A-Za-z0-9]+|Alt\+[A-Za-z0-9]+|Shift\+[A-Za-z0-9]+|Cmd\+[A-Za-z0-9]+|⌘[A-Za-z0-9]+|Esc|Escape|Enter|Tab|↑|↓)/gi;
  document.querySelectorAll('[title]').forEach((el) => {
    const title = el.getAttribute('title');
    if (!title) return;
    const matches = title.match(shortcutRegex);
    if (!matches) return;
    const shortcut = matches.join(' / ').replace(/Escape/gi, 'Esc');
    const cleaned = title
      .replace(shortcutRegex, '')
      .replace(/[()]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    el.dataset.tooltip = cleaned || title;
    el.dataset.shortcut = shortcut;
    el.classList.add('shortcut-tooltip');
    el.removeAttribute('title');
  });
}

module.exports = {
  debounceButton,
  applyShortcutTooltips,
};
