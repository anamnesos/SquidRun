/**
 * SquidRun Status Strip (legacy module)
 * Status strip UI was removed; this module now maintains only session timer text.
 */

const log = require('./logger');

// Session start time for duration tracking
let sessionStartTime = Date.now();
let sessionTimerInterval = null;
let initialized = false;

/**
 * Update session timer display in X:XX format.
 */
function updateSessionTimer() {
  const timerEl = document.getElementById('sessionTimer');
  if (!timerEl) return;

  const elapsed = Date.now() - sessionStartTime;
  const totalMinutes = Math.floor(elapsed / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  timerEl.textContent = `Session: ${hours}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Initialize session timer behavior.
 */
function initStatusStrip() {
  if (initialized) return;
  initialized = true;

  sessionStartTime = Date.now();
  updateSessionTimer();
  sessionTimerInterval = setInterval(updateSessionTimer, 60000);

  log.info('StatusStrip', 'Initialized (timer-only mode)');
}

/**
 * Shutdown and clear timer interval.
 */
function shutdownStatusStrip() {
  initialized = false;
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
}

module.exports = {
  initStatusStrip,
  shutdownStatusStrip,
};
