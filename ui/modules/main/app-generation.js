/**
 * THE APP GENERATION, PUBLISHED WHERE PANES CAN INHERIT IT.
 *
 * =====================================================================
 * WHY THIS IS ITS OWN MODULE
 * =====================================================================
 * `commsSessionScopeId` is assigned in the app constructor and then REPLACED
 * several times during startup as the real session number and ledger session id
 * become known. The environment variable panes inherit was published at the
 * FIRST of those points only. So a pane launched after startup carried
 * `app-<pid>-<ms>` while the drain's transport claim carried
 * `app-session-<n>-<id>`, and the admission join compares exactly those two.
 * Every real Telegram message would have failed
 * `admission_launch_identity_mismatch` — on evidence that looked complete from
 * either side alone.
 *
 * That is this lane's recurring seam defect in one variable: a producer
 * emitting one value and a consumer reading another, with nothing in between to
 * notice. Routing every assignment through this function is what makes the two
 * move together.
 *
 * It lives here rather than as a method on the app because `squidrun-app.js` is
 * a 16k-line god-object sitting well above its frozen growth ceiling. Adding a
 * method there would have bought this correctness with more of exactly the
 * problem that guard exists to stop.
 */

const ENV_APP_GENERATION = 'SQUIDRUN_APP_GENERATION';

/**
 * Publish `scopeId` as the current app generation and return it, so callers can
 * assign in a single expression and cannot set the field without publishing.
 */
function publishAppGeneration(scopeId) {
  process.env[ENV_APP_GENERATION] = String(scopeId ?? '');
  return scopeId;
}

/** What panes will inherit right now. Empty string when nothing is published. */
function currentAppGeneration() {
  return String(process.env[ENV_APP_GENERATION] ?? '');
}

module.exports = { ENV_APP_GENERATION, publishAppGeneration, currentAppGeneration };
