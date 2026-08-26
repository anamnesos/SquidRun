/**
 * Compaction Detector - 4-state machine per pane
 * Detects CLI compaction events using multi-signal scoring.
 *
 * States: none -> suspected -> confirmed -> cooldown -> none
 *
 * Signals are weighted and combined to produce a confidence score.
 * Transitions require sustained confidence above thresholds for minimum durations.
 */

const DETECTOR_VERSION = 1;

// --- Signal weights ---
const WEIGHT_LEXICAL = 0.3;
const WEIGHT_STRUCTURED = 0.5;
const WEIGHT_BURST_NO_PROMPT = 0.3;
const WEIGHT_NO_CAUSATION = 0.2;

// --- Transition thresholds ---
const T_SUSPECT = 0.3;
const T_CONFIRM = 0.6;

// --- Timing (ms) ---
const SUSPECT_SUSTAIN_MS = 300;
const CONFIRM_SUSTAIN_MS = 800;
const CONFIDENCE_DECAY_MS = 500;
const COOLDOWN_MS = 1500;
const RAPID_SUSPECT_WINDOW_MS = 2000;
const RAPID_SUSPECT_COUNT = 3;
const MAX_CONFIRMED_MS = 30000; // Safety: max time in confirmed state (real compaction is 5-15s)
const EVIDENCE_DECAY_RESET_MS = 5000; // Reset detector if stream is inactive for this window

// --- Lexical patterns ---
const LEXICAL_PATTERNS = [
  /compacting/i,
  /summariz(e|ing) (the |your |this )?conversation/i,
  /context window/i,
  /truncat(e|ed|ing) (the |earlier |previous )?messages/i,
  /conversation (is )?(too |very )?long/i,
  /reducing context/i,
];

// --- Structured block patterns ---
const STRUCTURED_PATTERNS = [
  /^#{1,3}\s+summary/im,
  /^[-*]\s+.{10,}\n^[-*]\s+.{10,}\n^[-*]\s+.{10,}/im,
];

// --- Prompt-ready patterns ---
const PROMPT_READY_PATTERNS = [
  /[$>]\s*$/m,
  /(^|\n)>\s*(\n|$)/m,
];

/**
 * Per-pane detector state
 */
function createPaneState() {
  return {
    state: 'none',            // none | suspected | confirmed | cooldown
    confidence: 0,
    activeSignals: new Set(),
    sustainedSince: null,     // timestamp when current confidence level was first sustained
    confirmedAt: null,        // timestamp when confirmed state was entered
    cooldownAt: null,         // timestamp when cooldown started
    suspectHits: [],          // timestamps of suspect-level hits for rapid-fire detection
    lastChunkTime: null,
    chunksSincePrompt: 0,     // chunks received without a prompt-ready signal
    lastInjectTime: null,     // last time inject.requested was seen for this pane
    lastEvidenceAt: null,     // last time lexical/structured evidence was observed
    evidenceDecayTimer: null, // timer handle for stale-evidence reset
    lexicalSeenSinceSuspected: false, // require lexical marker before confirming
  };
}

let bus = null;
const paneDetectors = new Map(); // paneId -> pane state

function clearEvidenceDecayTimer(detector) {
  if (!detector || !detector.evidenceDecayTimer) return;
  clearTimeout(detector.evidenceDecayTimer);
  detector.evidenceDecayTimer = null;
}

function hasCompactionEvidence(signals) {
  return signals.has('lexical') || signals.has('structured');
}

function resetToNone(paneId, reason = 'chunk_inactivity_timeout') {
  const detector = getDetector(paneId);
  const now = typeof Date.now === 'function' ? Date.now() : Date.now();
  const wasConfirmed = detector.state === 'confirmed';
  const durationMs = detector.confirmedAt ? now - detector.confirmedAt : 0;

  clearEvidenceDecayTimer(detector);
  detector.state = 'none';
  detector.confidence = 0;
  detector.activeSignals = new Set();
  detector.sustainedSince = null;
  detector.confirmedAt = null;
  detector.cooldownAt = null;
  detector.suspectHits = [];
  detector.chunksSincePrompt = 0;
  detector.lastEvidenceAt = null;
  detector.lexicalSeenSinceSuspected = false;

  if (wasConfirmed) {
    emitEvent(paneId, 'cli.compaction.ended', {
      durationMs,
      endReason: reason,
    });
  }
  updateGate(paneId, 'none');
}

function scheduleEvidenceDecayReset(paneId) {
  const detector = getDetector(paneId);
  clearEvidenceDecayTimer(detector);

  detector.evidenceDecayTimer = setTimeout(() => {
    const live = getDetector(paneId);
    if (live.state === 'none') {
      clearEvidenceDecayTimer(live);
      return;
    }
    const now = typeof Date.now === 'function' ? Date.now() : Date.now();
    if (!live.lastChunkTime || (now - live.lastChunkTime) >= EVIDENCE_DECAY_RESET_MS) {
      resetToNone(paneId, 'chunk_inactivity_timeout');
      return;
    }
    scheduleEvidenceDecayReset(paneId);
  }, EVIDENCE_DECAY_RESET_MS);
}

function recordCompactionEvidence(paneId, signals) {
  const detector = getDetector(paneId);
  if (!hasCompactionEvidence(signals)) return;
  detector.lastEvidenceAt = typeof Date.now === 'function' ? Date.now() : Date.now();
  scheduleEvidenceDecayReset(paneId);
}

/**
 * Get or create detector state for a pane
 */
function getDetector(paneId) {
  const id = String(paneId);
  if (!paneDetectors.has(id)) {
    paneDetectors.set(id, createPaneState());
  }
  return paneDetectors.get(id);
}

/**
 * Score signals from a PTY output chunk
 */
function scoreSignals(paneId, data) {
  const detector = getDetector(paneId);
  const signals = new Set();
  let score = 0;

  // Signal 1: Lexical markers
  for (const pattern of LEXICAL_PATTERNS) {
    if (pattern.test(data)) {
      signals.add('lexical');
      score += WEIGHT_LEXICAL;
      break; // one match is enough
    }
  }

  // Signal 2: Structured block patterns
  for (const pattern of STRUCTURED_PATTERNS) {
    if (pattern.test(data)) {
      signals.add('structured');
      score += WEIGHT_STRUCTURED;
      break;
    }
  }

  // Signal 3: Burst without prompt-ready
  // If we've had sustained output chunks without seeing a prompt
  detector.chunksSincePrompt++;
  const hasPrompt = PROMPT_READY_PATTERNS.some(p => p.test(data));
  if (hasPrompt) {
    detector.chunksSincePrompt = 0;
  } else if (detector.chunksSincePrompt >= 5) {
    signals.add('burst_no_prompt');
    score += WEIGHT_BURST_NO_PROMPT;
  }

  // Signal 4: Absence of user causation
  // If no inject.requested in the last 10 seconds, this output is unprompted
  const now = typeof Date.now === 'function' ? Date.now() : Date.now();
  if (!detector.lastInjectTime || (now - detector.lastInjectTime > 10000)) {
    signals.add('no_causation');
    score += WEIGHT_NO_CAUSATION;
  }

  // Cap at 1.0
  score = Math.min(score, 1.0);

  return { score, signals };
}

/**
 * Transition the detector state machine
 */
function transition(paneId, confidence, signals) {
  const detector = getDetector(paneId);
  const now = typeof Date.now === 'function' ? Date.now() : Date.now();
  const hasLexicalNow = signals.has('lexical');

  detector.confidence = confidence;
  detector.activeSignals = signals;
  detector.lastChunkTime = now;
  recordCompactionEvidence(paneId, signals);

  switch (detector.state) {
    case 'none': {
      if (confidence >= T_SUSPECT) {
        if (!detector.sustainedSince) {
          detector.sustainedSince = now;
        }
        if (now - detector.sustainedSince >= SUSPECT_SUSTAIN_MS) {
          detector.state = 'suspected';
          detector.sustainedSince = now; // reset for next transition
          detector.suspectHits.push(now);
          detector.lexicalSeenSinceSuspected = hasLexicalNow;
          emitEvent(paneId, 'cli.compaction.suspected', {
            confidence,
            detectorVersion: DETECTOR_VERSION,
            signals: Array.from(signals),
          });
          updateGate(paneId, 'suspected');
        }
      } else {
        detector.sustainedSince = null;
      }
      break;
    }

    case 'suspected': {
      if (hasLexicalNow) {
        detector.lexicalSeenSinceSuspected = true;
      }

      // Track suspect hits for rapid-fire detection
      if (confidence >= T_SUSPECT) {
        detector.suspectHits.push(now);
        // Trim old hits outside the window
        detector.suspectHits = detector.suspectHits.filter(
          t => now - t < RAPID_SUSPECT_WINDOW_MS
        );
      }

      // Check for promotion to confirmed
      const rapidFire = detector.suspectHits.length >= RAPID_SUSPECT_COUNT;
      const hasLexicalEvidence = detector.lexicalSeenSinceSuspected;
      if (confidence >= T_CONFIRM && hasLexicalEvidence) {
        if (!detector.sustainedSince) {
          detector.sustainedSince = now;
        }
        if (now - detector.sustainedSince >= CONFIRM_SUSTAIN_MS || rapidFire) {
          detector.state = 'confirmed';
          detector.confirmedAt = now;
          detector.sustainedSince = null;
          detector.lexicalSeenSinceSuspected = false;
          emitEvent(paneId, 'cli.compaction.started', {
            confidence,
            detectorVersion: DETECTOR_VERSION,
            transitionReason: rapidFire ? 'rapid_suspect_hits' : 'sustained_confidence',
          });
          updateGate(paneId, 'confirmed');
        }
      } else if (rapidFire && signals.size >= 2 && hasLexicalEvidence) {
        // Rapid suspect hits can promote without T_CONFIRM, but require multi-signal evidence
        detector.state = 'confirmed';
        detector.confirmedAt = now;
        detector.sustainedSince = null;
        detector.lexicalSeenSinceSuspected = false;
        emitEvent(paneId, 'cli.compaction.started', {
          confidence,
          detectorVersion: DETECTOR_VERSION,
          transitionReason: 'rapid_suspect_hits',
        });
        updateGate(paneId, 'confirmed');
      } else if (confidence < T_SUSPECT) {
        // Confidence dropped — decay back to none
        if (!detector.sustainedSince) {
          detector.sustainedSince = now;
        }
        if (now - detector.sustainedSince >= CONFIDENCE_DECAY_MS) {
          detector.state = 'none';
          detector.sustainedSince = null;
          detector.suspectHits = [];
          detector.lexicalSeenSinceSuspected = false;
          updateGate(paneId, 'none');
        }
      } else {
        // Between T_SUSPECT and T_CONFIRM — stay suspected, reset sustain for confirm
        detector.sustainedSince = null;
      }
      break;
    }

    case 'confirmed': {
      // Safety timeout: force cooldown if confirmed too long (false positive protection)
      if (detector.confirmedAt && (now - detector.confirmedAt) > MAX_CONFIRMED_MS) {
        enterCooldown(paneId, 'max_duration_timeout');
        break;
      }

      if (confidence < 0.2) {
        if (!detector.sustainedSince) {
          detector.sustainedSince = now;
        }
        if (now - detector.sustainedSince >= CONFIDENCE_DECAY_MS) {
          enterCooldown(paneId, 'confidence_decay');
        }
      } else {
        detector.sustainedSince = null;
      }
      break;
    }

    case 'cooldown': {
      if (confidence >= T_SUSPECT) {
        // Renewed evidence: only promote to confirmed when lexical evidence is present.
        if (hasLexicalNow) {
          detector.state = 'confirmed';
          detector.confirmedAt = now;
          detector.cooldownAt = null;
          detector.sustainedSince = null;
          detector.lexicalSeenSinceSuspected = false;
          emitEvent(paneId, 'cli.compaction.started', {
            confidence,
            detectorVersion: DETECTOR_VERSION,
            transitionReason: 'renewed_evidence',
          });
          updateGate(paneId, 'confirmed');
        }
      } else if (now - detector.cooldownAt >= COOLDOWN_MS) {
        detector.state = 'none';
        detector.cooldownAt = null;
        detector.sustainedSince = null;
        detector.suspectHits = [];
        detector.chunksSincePrompt = 0;
        detector.lexicalSeenSinceSuspected = false;
        updateGate(paneId, 'none');
      }
      break;
    }
  }
}

/**
 * Enter cooldown from confirmed state
 */
function enterCooldown(paneId, reason) {
  const detector = getDetector(paneId);
  const now = typeof Date.now === 'function' ? Date.now() : Date.now();
  const durationMs = detector.confirmedAt ? now - detector.confirmedAt : 0;

  detector.state = 'cooldown';
  detector.cooldownAt = now;
  detector.sustainedSince = null;
  detector.lexicalSeenSinceSuspected = false;

  emitEvent(paneId, 'cli.compaction.ended', {
    durationMs,
    endReason: reason,
  });
  updateGate(paneId, 'cooldown');
}

/**
 * Update the compacting gate in the state vector
 */
function updateGate(paneId, compacting) {
  if (bus) {
    bus.updateState(paneId, { gates: { compacting } });
  }
}

/**
 * Emit a detector event through the bus
 */
function emitEvent(paneId, type, payload) {
  if (bus) {
    bus.emit(type, {
      paneId,
      payload,
      source: 'compaction-detector.js',
    });
  }
}

/**
 * Process a PTY output chunk for compaction signals.
 * Called from terminal.js onData handler.
 *
 * @param {string} paneId - The pane producing the output
 * @param {string} data - Raw PTY output chunk
 */
function processChunk(paneId, data) {
  if (!data || typeof data !== 'string') return;

  const detector = getDetector(paneId);
  detector.lastChunkTime = typeof Date.now === 'function' ? Date.now() : Date.now();
  if (detector.state !== 'none') {
    // Any ongoing stream activity should keep the gate alive.
    scheduleEvidenceDecayReset(paneId);
  }

  // Check for prompt-ready (end of compaction signal)
  const hasPrompt = PROMPT_READY_PATTERNS.some(p => p.test(data));
  if (hasPrompt) {
    // Reset burst counter whenever a prompt is seen, regardless of state
    detector.chunksSincePrompt = 0;
    if (detector.state === 'confirmed') {
      enterCooldown(paneId, 'prompt_ready');
      scheduleEvidenceDecayReset(paneId);
      return;
    }
  }

  const { score, signals } = scoreSignals(paneId, data);
  transition(paneId, score, signals);
  if (detector.state !== 'none') {
    scheduleEvidenceDecayReset(paneId);
  } else {
    clearEvidenceDecayTimer(detector);
  }
}

/**
 * Initialize the compaction detector.
 * Subscribes to relevant events on the bus.
 *
 * @param {object} eventBus - The event bus instance
 */
function init(eventBus) {
  bus = eventBus;

  // Track inject.requested events to know about user causation
  bus.on('inject.requested', (event) => {
    const detector = getDetector(event.paneId);
    detector.lastInjectTime = event.ts || (typeof Date.now === 'function' ? Date.now() : Date.now());
  });
}

/**
 * Get the current detector state for a pane (for testing/introspection)
 */
function getState(paneId) {
  return getDetector(paneId);
}

/**
 * Reset all detector state (for testing)
 */
function reset() {
  for (const detector of paneDetectors.values()) {
    clearEvidenceDecayTimer(detector);
  }
  paneDetectors.clear();
  bus = null;
}

module.exports = {
  init,
  processChunk,
  getState,
  reset,
  // Exported for testing
  DETECTOR_VERSION,
  T_SUSPECT,
  T_CONFIRM,
  SUSPECT_SUSTAIN_MS,
  CONFIRM_SUSTAIN_MS,
  COOLDOWN_MS,
  CONFIDENCE_DECAY_MS,
  RAPID_SUSPECT_WINDOW_MS,
  RAPID_SUSPECT_COUNT,
  MAX_CONFIRMED_MS,
  EVIDENCE_DECAY_RESET_MS,
  LEXICAL_PATTERNS,
  STRUCTURED_PATTERNS,
  PROMPT_READY_PATTERNS,
};
