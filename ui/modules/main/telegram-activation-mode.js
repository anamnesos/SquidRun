/**
 * THE TELEGRAM TRANSPORT ACTIVATION MODE (v7 §3 Phase L).
 *
 * =====================================================================
 * WHY A MODE AT ALL, WHEN THERE IS ONLY ONE VALUE
 * =====================================================================
 * v7 §3 splits activation into two phases, and Phase L is the one where the
 * repaired code is LOADED but decision transport is not yet enabled: legacy
 * records settle through the repaired pane path, `decision_v1` sources queue
 * durably behind them, and the stable cutover fence does not exist yet. That is
 * an operating state, not a build property, and it has to be nameable by the
 * process that is in it — otherwise "are we settling legacy right now?" is
 * answered by reading the source of whatever build happens to be running.
 *
 * So there is exactly one recognised value today, `legacy_settlement`, and the
 * module still exists, because the interesting cases are the ones that are NOT
 * that value.
 *
 * =====================================================================
 * ABSENT IS NOT A DEFAULT. THIS IS THE ENTIRE POINT.
 * =====================================================================
 * The tempting shape is `const mode = configured || 'legacy_settlement'`, and
 * it is wrong in the specific way this lane keeps being wrong: it converts "no
 * one has told us which state we are in" into a confident answer. An install
 * that never configured the mode would then silently claim to be settling
 * legacy — and Step 3 derives a stable fence whose whole validity rests on the
 * settlement having actually happened, once, under a known writer.
 *
 * The other tempting shape is `configured || <old behaviour>`, which is worse:
 * it hands `decision_v1` sources back to the pane path they must never take
 * before a fence exists, and calls it backwards compatibility.
 *
 * Both are refused here. Missing, empty, non-string, and unrecognised each get
 * their OWN named refusal, because "the operator has not set this yet" and "the
 * operator set it to something this build does not understand" are different
 * problems with different fixes, and collapsing them into one string is how an
 * operator gets sent to the wrong file.
 */

/** Phase L: legacy settles, decisions do not schedule. The only value today. */
const LEGACY_SETTLEMENT = 'legacy_settlement';

/**
 * Frozen ARRAY plus a predicate, never an exported Set: `Object.freeze` does
 * not freeze a Set's contents, so an exported "constant" Set is a membership
 * list any consumer can `.add()` to (Architect #121). Same reasoning, same
 * shape, as `telegram-legacy-journal`.
 */
const ACTIVATION_MODE_VALUES = Object.freeze([LEGACY_SETTLEMENT]);

const activationModes = new Set(ACTIVATION_MODE_VALUES);

/** @returns {boolean} EXACT membership. No trimming, no case folding. */
function isRecognizedActivationMode(value) {
  return typeof value === 'string' && activationModes.has(value);
}

/**
 * Resolve a configured value into a mode, or into a NAMED refusal.
 *
 * Total, pure, and never throws. The caller decides what a refusal costs; this
 * only decides what it is called.
 *
 * NOTHING IS NORMALISED INTO VALIDITY. `' legacy_settlement '` is unrecognised
 * rather than trimmed into the real value: whitespace in a configured protocol
 * mode means something wrote that value wrong, and quietly accepting it means
 * the next reader cannot tell a hand-edit from a producer bug. The trim below
 * exists only to tell "empty" apart from "unrecognised", never to repair.
 *
 * @returns {{ok: true, mode: string, reason: null}
 *          | {ok: false, mode: null, reason: string, detail?: object}}
 */
function resolveActivationMode(value) {
  if (value === undefined || value === null) {
    return { ok: false, mode: null, reason: 'activation_mode_missing' };
  }
  if (typeof value !== 'string') {
    return {
      ok: false,
      mode: null,
      reason: 'activation_mode_not_a_string',
      detail: { type: Array.isArray(value) ? 'array' : typeof value },
    };
  }
  if (value.trim() === '') {
    return { ok: false, mode: null, reason: 'activation_mode_empty' };
  }
  if (!activationModes.has(value)) {
    return { ok: false, mode: null, reason: 'activation_mode_unknown', detail: { value } };
  }
  return { ok: true, mode: value, reason: null };
}

// =====================================================================
// THE ONE-TIME FROZEN AUTHORITY, PUBLISHED WHERE OTHER PRODUCTION CONSUMERS
// CAN READ THE SAME VALUE THE COORDINATOR GOT (Architect #202)
// =====================================================================

/**
 * The app freezes the configured mode once, immediately after authoritative
 * settings load, and the drain coordinator resolves THAT frozen value. Anything
 * else that needs to know whether this process is in Phase L had no way to ask —
 * so the Step 3 fence's readiness proof checked its OWN output constants
 * instead, which is a module asserting that a module said so.
 *
 * That is the self-attestation Architect #202 caught: a local `schedulingEnabled
 * = false` can stay false while the live app schedules from a mode this file
 * never saw. Publishing the frozen value HERE, from the same capture that feeds
 * the coordinator, gives every consumer one answer instead of one answer and
 * several opinions.
 *
 * NOT AN ENV VAR, deliberately, unlike the app generation. The generation has to
 * cross a process boundary into panes; this value does not, and `process.env` is
 * writable by anything in the process — which would make the authority forgeable
 * by exactly the callers it exists to stop. Module state, published once.
 *
 * NULL IS A REAL FROZEN VALUE. "Frozen as unset" and "never frozen" are
 * different facts with different fixes, and a consumer that cannot tell them
 * apart will report a missing configuration as a startup-order bug or vice
 * versa.
 */
let frozenActivationMode = null;
let activationModeFrozen = false;

/**
 * Publish the frozen mode. Idempotent for an identical value, REFUSED for a
 * different one.
 *
 * One publication per generation, same rule as the scheduling session: the fence
 * and its readiness proof bind this value, and a mode that moved mid-generation
 * would mean two artifacts issued by "the same process" that disagree about
 * which state that process was in.
 *
 * @returns {{ok: true, mode: string|null, republished: boolean}
 *          | {ok: false, reason: string, detail?: object}}
 */
function publishFrozenActivationMode(raw) {
  const value = raw === undefined ? null : raw;
  if (activationModeFrozen) {
    if (frozenActivationMode === value) {
      return { ok: true, mode: frozenActivationMode, republished: true };
    }
    return {
      ok: false,
      reason: 'activation_mode_already_frozen',
      detail: { frozen: frozenActivationMode, offered: value },
    };
  }
  frozenActivationMode = value;
  activationModeFrozen = true;
  return { ok: true, mode: frozenActivationMode, republished: false };
}

/**
 * The frozen mode as the coordinator sees it.
 *
 * DOES NOT FREEZE, and does not fall back to reading settings. A consumer that
 * asked before the freeze is a consumer running outside the startup sequence
 * that owns this decision, and the honest answer is "never frozen" rather than a
 * value fetched from somewhere else — which would be the duplicate settings read
 * #202 forbids.
 *
 * @returns {{frozen: boolean, mode: string|null}}
 */
function currentFrozenActivationMode() {
  return { frozen: activationModeFrozen, mode: frozenActivationMode };
}

/**
 * FROZEN EXPORTS, so require order is not a security assumption.
 *
 * Mutating the cached exports object hands the replacement to every module that
 * destructures afterwards, and this module's answer decides whether anything is
 * allowed to reach a pane at all (Architect #127).
 */
module.exports = Object.freeze({
  LEGACY_SETTLEMENT,
  ACTIVATION_MODE_VALUES,
  isRecognizedActivationMode,
  resolveActivationMode,
  publishFrozenActivationMode,
  currentFrozenActivationMode,
});
