/**
 * WHICH CLI IS THIS PANE ACTUALLY RUNNING.
 *
 * =====================================================================
 * WHY THIS MOVED OUT OF `pty-handlers`
 * =====================================================================
 * `pty-handlers` computed the pane's runtime and then threw it away: the spawn
 * call passed `mode = null`, so `daemon-client` had nothing to name the launch
 * with and `recordPaneLaunchForSpawn` returned null on every normal pane.
 * The launch registry was wired and could never fire, and the admission
 * producer failed `no_launch_binding` for every real prompt.
 *
 * The fix cannot be a second copy of the detection rules in `daemon-client`.
 * Two copies drift, and then the row says `codex` while the pane runs `claude`
 * — an identity that is worse than the missing one it replaced. So the function
 * lives here, `pty-handlers` calls it for the behaviour it always had, and
 * `daemon-client` calls the SAME function for the launch row.
 *
 * =====================================================================
 * WHY THERE ARE TWO FUNCTIONS AND NOT ONE
 * =====================================================================
 * `detectCliFromCommand` answers "how should this pane be treated" and defaults
 * to `claude` for an empty or unrecognised command. That default is right for
 * TEMP-directory selection and firmware routing — a guess that costs nothing.
 *
 * It is exactly wrong for a launch row. A launch record is EVIDENCE: a later
 * admission joins to it and refuses when the runtime disagrees. Recording
 * `claude` for a bare shell would mint an identity naming a consumer that does
 * not exist, which is this checkpoint's entire defect class. So the registry
 * uses the strict variant, which returns null rather than guessing, and no
 * launch row is written at all when the runtime is unknown.
 */

/** Supported consumer runtimes for the Telegram admission lane. */
const CONSUMER_RUNTIMES = Object.freeze({ CODEX: 'codex', CLAUDE: 'claude' });

/**
 * Pane treatment. Unchanged behaviour, including the `claude` default, because
 * its existing callers depend on always getting an answer.
 */
function detectCliFromCommand(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) return 'claude';
  if (normalized.startsWith('gemini')) return 'gemini';
  if (normalized.startsWith('codex')) return 'codex';
  if (normalized.startsWith('claude')) return 'claude';
  if (normalized.includes('gemini')) return 'gemini';
  if (normalized.includes('codex')) return 'codex';
  return 'claude';
}

/**
 * Launch-record identity. NO DEFAULT, deliberately.
 *
 * Returns a runtime only when the command actually names one. `gemini` is a
 * real pane runtime but has no admission producer, so it resolves to null here
 * too: writing a launch for a runtime that can never bind a session would leave
 * permanently unbound rows that look like evidence of a consumer.
 */
function resolveConsumerRuntimeForLaunch(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (!normalized) return null;
  const detected = detectCliFromCommand(normalized);
  if (detected === CONSUMER_RUNTIMES.CODEX || detected === CONSUMER_RUNTIMES.CLAUDE) {
    // `detectCliFromCommand` falls back to `claude`; only accept it when the
    // command genuinely mentions the runtime rather than defaulting into it.
    if (detected === CONSUMER_RUNTIMES.CLAUDE && !normalized.includes('claude')) return null;
    return detected;
  }
  return null;
}

module.exports = {
  CONSUMER_RUNTIMES,
  detectCliFromCommand,
  resolveConsumerRuntimeForLaunch,
};
