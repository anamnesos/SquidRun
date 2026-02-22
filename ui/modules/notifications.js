/**
 * Consolidated notification system for SquidRun UI.
 * Replaces duplicate implementations in renderer.js (showStatusNotice)
 * and daemon-handlers.js (showToast).
 *
 * Tech debt item #9 from Session 57 audit.
 */

const DEFAULT_TOAST_TIMEOUT = 5000;
const DEFAULT_STATUSBAR_TIMEOUT = 6000;
const FADE_DURATION = 500;
const activeTimers = new Set();
const elementTimers = new WeakMap();

function trackTimer(element, callback, timeoutMs) {
  const handle = setTimeout(() => {
    activeTimers.delete(handle);
    if (element && elementTimers.get(element) === handle) {
      elementTimers.delete(element);
    }
    callback();
  }, timeoutMs);

  // Avoid keeping Node's event loop alive in Jest/CLI contexts.
  if (handle && typeof handle.unref === 'function') {
    handle.unref();
  }

  activeTimers.add(handle);
  if (element) {
    elementTimers.set(element, handle);
  }
  return handle;
}

function clearElementTimer(element) {
  if (!element) return;
  const handle = elementTimers.get(element);
  if (!handle) return;
  clearTimeout(handle);
  activeTimers.delete(handle);
  elementTimers.delete(element);
}

function clearNotificationTimers() {
  for (const handle of [...activeTimers]) {
    clearTimeout(handle);
    activeTimers.delete(handle);
  }
}

/**
 * Show a notification to the user.
 *
 * @param {string} message - The message to display
 * @param {Object} options - Notification options
 * @param {('info'|'warning'|'error')} [options.type='info'] - Notification type (affects styling)
 * @param {('toast'|'statusbar')} [options.location='toast'] - Where to show the notification
 * @param {number} [options.timeout] - Auto-dismiss timeout in ms (defaults based on location)
 */
function showNotification(message, options = {}) {
  const {
    type = 'info',
    location = 'toast',
    timeout
  } = options;

  if (location === 'statusbar') {
    showStatusbarNotification(message, timeout ?? DEFAULT_STATUSBAR_TIMEOUT);
  } else {
    showToastNotification(message, type, timeout ?? DEFAULT_TOAST_TIMEOUT);
  }
}

/**
 * Show a toast notification (floating, bottom-right).
 * Only one toast visible at a time.
 */
function showToastNotification(message, type, timeout) {
  const existing = document.querySelector('.toast-notification');
  if (existing) {
    clearElementTimer(existing);
    existing.remove();
  }

  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  trackTimer(toast, () => {
    toast.classList.add('toast-fade');
    trackTimer(toast, () => {
      clearElementTimer(toast);
      toast.remove();
    }, FADE_DURATION);
  }, timeout);
}

/**
 * Show a status bar notification (inline, appended to status bar).
 * Multiple can be visible; each auto-removes after timeout.
 */
function showStatusbarNotification(message, timeout) {
  const statusBar = document.querySelector('.status-bar');
  if (!statusBar) return;

  const notice = document.createElement('span');
  notice.className = 'status-notice';
  notice.textContent = ` | ${message}`;
  notice.style.cssText = 'color: #8fd3ff; margin-left: 8px;';
  statusBar.appendChild(notice);

  trackTimer(notice, () => {
    clearElementTimer(notice);
    notice.remove();
  }, timeout);
}

// Legacy API aliases for backward compatibility
function showToast(message, type = 'info') {
  showNotification(message, { type, location: 'toast' });
}

function showStatusNotice(message, timeoutMs = DEFAULT_STATUSBAR_TIMEOUT) {
  showNotification(message, { location: 'statusbar', timeout: timeoutMs });
}

module.exports = {
  showNotification,
  showToast,
  showStatusNotice,
  clearNotificationTimers,
  // Export constants for testing
  DEFAULT_TOAST_TIMEOUT,
  DEFAULT_STATUSBAR_TIMEOUT,
  FADE_DURATION
};
