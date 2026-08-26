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

/**
 * THE SCHEDULING SESSION, PUBLISHED THE SAME WAY AND FOR THE SAME REASON.
 *
 * =====================================================================
 * WHY A SECOND VALUE WHEN PRODUCTION CURRENTLY HAS ONE
 * =====================================================================
 * `commsSessionScopeId` is BOTH the app generation and the producer session id
 * today — `publishAppGeneration(...)` is assigned straight into it, so
 * `currentAppGeneration()` and the spool's `producerSessionId` are the same
 * string. That is a live fact, not a design: the ledger app session
 * (`app-session-N`) is a different identifier that becomes known later in
 * startup and is never published anywhere a fence could read it.
 *
 * The fence has to bind BOTH (Architect #178 §5), and a "session" that is
 * literally the generation restated proves nothing a second time. So the ledger
 * session gets its own publication, from the app, at the point it is known —
 * and until it is published, `currentAppSchedulingSession()` is empty and every
 * consumer HOLDs. An empty authority is the correct answer to "who owns
 * scheduling" before anyone does; the defect this module exists to stop was a
 * consumer inventing a value rather than reading a published one.
 */
const ENV_APP_SCHEDULING_SESSION = 'SQUIDRUN_APP_SCHEDULING_SESSION';

/**
 * Publish `sessionId` as this generation's scheduling session and return it.
 *
 * ONE PUBLICATION PER GENERATION. A second call with a DIFFERENT value is
 * refused rather than allowed to win: the fence and the writer capture bind this
 * string, and a value that moved mid-generation would mean two artifacts issued
 * by "the same session" that disagree about which session that was. Re-
 * publishing the identical value is a harmless no-op, because startup legitimately
 * passes the same id through more than one assignment site.
 */
function publishAppSchedulingSession(sessionId) {
  const value = String(sessionId ?? '').trim();
  if (!value) return null;
  const existing = String(process.env[ENV_APP_SCHEDULING_SESSION] ?? '').trim();
  if (existing && existing !== value) return null;
  process.env[ENV_APP_SCHEDULING_SESSION] = value;
  return value;
}

/** The published scheduling session. Empty string when nothing is published. */
function currentAppSchedulingSession() {
  return String(process.env[ENV_APP_SCHEDULING_SESSION] ?? '');
}

module.exports = {
  ENV_APP_GENERATION,
  ENV_APP_SCHEDULING_SESSION,
  publishAppGeneration,
  currentAppGeneration,
  publishAppSchedulingSession,
  currentAppSchedulingSession,
};
