/**
 * THE PRODUCTION ADMISSION SEQUENCE — one owner, five awaited steps, fail-closed.
 *
 * =====================================================================
 * WHY THIS FILE EXISTS AT ALL
 * =====================================================================
 * Every primitive it calls already existed and had tests. None of them were
 * reachable from production: `recordImmutableSource`, `claimTransportAttempt`,
 * `recordDeliveryStarted` and `appendConsumeMarker` had definitions and test
 * callers and NOTHING ELSE. Meanwhile the live path fired a generic
 * fire-and-forget comms upsert at the same `telegram-in-<updateId>` id and
 * walked straight on to the pane.
 *
 * So there were two writers for one row, and the one that ran in production was
 * the one that could rewrite body, session, sender, target and metadata. A
 * kernel that is not on the path is not a kernel; it is a very well-tested
 * opinion.
 *
 * =====================================================================
 * THE ORDER IS THE INVARIANT
 * =====================================================================
 *   A  record the immutable source          -> identity exists and is fixed
 *   B  claim the one transport attempt      -> exactly one sender may proceed
 *   C  build the FINAL bytes, then mark     -> what is hashed is what is sent
 *   D  record delivery_started              -> the pane write is authorised
 *   E  write the pane, once, with those bytes
 *
 * Every step is AWAITED. The defect this replaces was not a missing step, it
 * was a step nobody waited for: the old upsert was `void promise.then(...)`, so
 * "journaled" and "delivered" raced, and on a crash between them the durable
 * story could say either. A sequence you do not await is not a sequence.
 *
 * A failure anywhere BEFORE D means nothing was shown to anyone: the caller
 * must not write a pane, and the record stays pending for an honest retry.
 * From D onward the outcome is AMBIGUOUS by construction — the bytes were
 * authorised, so a later failure can never be reported as "did not happen".
 *
 * =====================================================================
 * WHY C IS WHERE IT IS
 * =====================================================================
 * The digest must cover the bytes the consumer will actually receive. The old
 * shape hashed `safeMessage`, which is then decorated by recall prepending and
 * the reply-target guard block before it reaches a pane — so the delivery
 * "proved" a string that was never delivered. `composeFinalBody` is therefore
 * called by the sequence, not before it, and the marker goes on last.
 */
const {
  sha256,
  applyTelegramAdmissionSchema,
  verifyInstalledSchema,
  recordImmutableSource,
  claimTransportAttempt,
  recordDeliveryStarted,
  TELEGRAM_CUTOVER_ID,
} = require('./telegram-admission-store');
const { findActivePaneLaunch } = require('./telegram-launch-registry');
const { appendConsumeMarker, parseConsumeMarker } = require('./telegram-consume-marker');
const { canonicalQueuedPayloadDigest } = require('./telegram-consumed-proof');
const { probeRuntimeProofCapability } = require('./telegram-consumption-proof');
const nodeTypes = require('node:util').types;

/**
 * PHASES, not just reasons.
 *
 * The drain has to decide between "retry this" and "never touch this again
 * without a human". That decision is not derivable from an error string, and
 * guessing it wrong in either direction is a real outage: guess `retry` on an
 * ambiguous delivery and James reads the same message twice; guess `ambiguous`
 * on a clean refusal and the queue wedges behind a message that was never sent.
 */
const PHASES = Object.freeze({
  BEFORE_DELIVERY: 'before_delivery',
  AMBIGUOUS: 'ambiguous',
});

/** Marker fields whose exact round-trip is a precondition of delivery. */
const MARKER_FIELDS = Object.freeze([
  'updateId', 'messageId', 'routeKey', 'windowKey', 'profile', 'chatId',
  'appGeneration', 'queuedPayloadSha256', 'claimId', 'attemptNonce',
]);

function refuse(stage, reason, detail = null, phase = PHASES.BEFORE_DELIVERY) {
  const out = { ok: false, stage, reason, phase };
  if (detail !== null && detail !== undefined) out.detail = detail;
  return out;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Modes. `full` is the main Architect pane, the only place a consume marker can
 * come back to us. `source_only` is a scoped profile window: the bytes are
 * handed to ANOTHER process which renders its own pane, so this process cannot
 * honestly hash what that pane received and no receipt can ever attach.
 *
 * Claiming a transport attempt for a route whose proof can never arrive is
 * exactly the trap Oracle named — every delivery would become a permanent hold.
 * So the scoped route records its immutable source, keeps one owner for the
 * row, and stops. It does not pretend to be proven, and it does not wedge.
 */
const MODES = Object.freeze({ FULL: 'full', SOURCE_ONLY: 'source_only' });

/** The ONE positive answer this gate accepts. Anything else is not a yes. */
const READINESS_POSITIVE_REASON = 'runtime_proof_observed';

/**
 * THE EXACT RECORD `probeRuntimeProofCapability` RETURNS — every branch of it,
 * four own keys, no more and no fewer.
 *
 * Pinned as a set rather than checked field by field because Oracle #47 got two
 * more shapes through a gate that only asked whether the fields it wanted were
 * READABLE: `Object.create(goodAnswer)` inherits all four and owns none, and an
 * answer carrying an extra `ready` left a branch in this file reading a field
 * production never emits. Both are the same defect — latitude. An answer that
 * is not literally the probe's own record is not the probe's answer, and this
 * lane has now spent three rounds discovering that one shape at a time.
 */
const READINESS_ANSWER_KEYS = Object.freeze(['attainable', 'reason', 'runtime', 'lastProofAtMs']);

function normalizeRuntime(value) {
  return isNonEmptyString(value) ? value.trim().toLowerCase() : null;
}

/**
 * A refusal detail may carry only values that cannot run code (Architect #84).
 *
 * Everything in a rejected answer is suspect by definition, and a detail object
 * travels: it gets logged, serialized, and folded into a health surface. A
 * `toJSON` or `toString` on a value we are in the middle of refusing would run
 * somewhere far away from here, in a context that has no idea it is holding
 * something hostile. Primitives pass through; anything else is reported as its
 * type and nothing more.
 */
function safeDetailValue(value) {
  if (value === null || value === undefined) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return value;
  if (kind === 'bigint') return `[bigint]`;
  if (kind === 'symbol') return '[symbol]';
  if (kind === 'function') return '[function]';
  return '[object]';
}

/**
 * =====================================================================
 * ONE COHERENT POSITIVE CONTRACT, BOUND BACK TO THE LAUNCH (Oracle #37).
 * =====================================================================
 * The first version of this gate was `ready === true || attainable === true`,
 * and Oracle drove three answers straight through it into D on a real ledger,
 * each creating a claim:
 *
 *   {ready: true, attainable: false, reason: runtime_proof_stale, runtime: codex}
 *   {attainable: true, reason: runtime_proof_observed, runtime: claude}   <- other pane
 *   {attainable: true, reason: runtime_proof_stale,    runtime: codex}
 *
 * An OR over two independent booleans validates ONE TRUE BIT. It cannot see a
 * self-contradiction, it never reads the reason that explains the bit, and it
 * never asks whether the answer is even ABOUT the pane we are going to write.
 * The prior tests captured which runtime the probe was ASKED about — not which
 * runtime the answer came back describing, which is the half that matters.
 *
 * So there is now exactly one shape that means yes, and every clause of it is
 * load-bearing:
 *
 *   attainable === true          the probe's own word, and the ONLY acceptance
 *                                path. `ready` is not an alternate; present and
 *                                not-true, it is a contradiction and refuses.
 *   reason === observed          the bit must be explained by the one reason
 *                                that means proof has actually flowed. Every
 *                                unattainable reason is now visibly incoherent
 *                                with attainable:true instead of ignored.
 *   runtime === launch runtime   normalized on both sides and compared to what
 *                                the LAUNCH REGISTRY recorded, so an answer
 *                                about another pane cannot authorise this one.
 *   proof timestamp is real      a finite positive integer that is not in the
 *                                future.
 *
 * AND THEN THE ANSWER MUST BE REPRODUCIBLE BY THE REAL PROBE. The four clauses
 * above are this file's opinion of the probe's contract, and a hand-written
 * mirror of someone else's rule drifts the moment theirs changes. So the last
 * step re-runs `probeRuntimeProofCapability` — the actual production function,
 * on the actual production window — over the evidence the answer itself states,
 * and requires it to land on the same verdict. A prober cannot claim `observed`
 * over a timestamp the real probe would call stale, because the real probe is
 * the one being asked.
 *
 * Fail closed everywhere: this returns ok only for the exact shape above.
 */
function evaluatePaneReadinessAnswer(input = {}) {
  const { answer, launchRuntime, nowMs } = input;

  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    return {
      ok: false,
      reason: 'pane_readiness_unreadable',
      detail: { received: answer === undefined ? 'undefined' : typeof answer },
    };
  }

  // A PLAIN RECORD, NOT SOMETHING THAT MERELY ANSWERS QUESTIONS (Oracle #47).
  //
  // `Object.create(goodAnswer)` reads identically to a good answer through
  // every property access below while owning nothing, and it crossed D.
  //
  // A CORRECTION TO WHAT THIS LINE USED TO CLAIM (Architect #77): it does NOT
  // exclude a getter or a Proxy. An object literal with an accessor has
  // Object.prototype, and a Proxy reports its target's prototype. Those are
  // caught by the descriptor rules below, not here. What this catches is a
  // class instance or a foreign prototype chain, and that is all it catches.
  //
  // Reflection itself is guarded: every step below can run user code on a
  // Proxy, and a trap that throws must refuse rather than escape as an
  // exception the caller never asked to handle.
  let proto;
  let descriptors;
  let ownKeys;
  try {
    proto = Object.getPrototypeOf(answer);
    // Reflect.ownKeys, NOT Object.keys: the latter returns only own ENUMERABLE
    // STRING keys, so a non-enumerable extra or a symbol-keyed field walked
    // straight past the "no foreign fields" rule it was supposed to fail.
    ownKeys = Reflect.ownKeys(answer);
    descriptors = Object.getOwnPropertyDescriptors(answer);
  } catch {
    // THE DIAGNOSTIC MAY NOT INTERROGATE THE HOSTILE VALUE (Architect #84).
    //
    // Reading `err.message` here was the same defect one layer further out: a
    // trap can throw an object whose `message` is itself a throwing getter, and
    // the refusal would escape as an exception all over again - from inside the
    // handler written to stop exactly that. The caught value is not touched at
    // all. A constant is worth less as a diagnostic and cannot be turned into a
    // weapon, and this branch already names precisely where it happened.
    return {
      ok: false,
      reason: 'pane_readiness_unreadable',
      detail: { received: 'reflection_threw' },
    };
  }

  // A PROXY IS NOT A RECORD, even a quiet one. It reports its target's
  // prototype and can hand back perfectly good descriptors, so nothing above
  // or below distinguishes it - and `isProxy` runs no traps, so asking is
  // free and cannot itself be lied to. The probe returns object literals; the
  // class is closed here rather than argued about case by case.
  if (nodeTypes.isProxy(answer)) {
    return { ok: false, reason: 'pane_readiness_not_a_plain_record', detail: { proxy: true } };
  }

  if (proto !== Object.prototype && proto !== null) {
    // `proto?.constructor?.name` walked a FOREIGN prototype to build this
    // string, and a foreign prototype is exactly the thing we have just decided
    // we do not trust. A throwing `constructor` getter escaped through the
    // refusal (Architect #84). The identity of the prototype is not worth a
    // second door into this function.
    return {
      ok: false,
      reason: 'pane_readiness_not_a_plain_record',
      detail: { prototype: 'foreign' },
    };
  }

  // EXACTLY THE PROBE'S OWN KEYS. Inherited fields are not own fields, and a
  // foreign field means this is not the record we think we are reading.
  //
  // This also RETIRES `ready` outright rather than leaving a branch in here
  // that reads a field production never emits. The old gate treated it as an
  // alternate yes; the version before this one still consulted it to catch a
  // self-contradiction. Both were latitude, and latitude is what has been
  // getting through. The contract is now literal.
  const symbolKeys = ownKeys.filter((key) => typeof key === 'symbol');
  const stringKeys = ownKeys.filter((key) => typeof key === 'string');
  const missing = READINESS_ANSWER_KEYS.filter((key) => !stringKeys.includes(key));
  const unexpected = stringKeys.filter((key) => !READINESS_ANSWER_KEYS.includes(key));
  if (missing.length > 0 || unexpected.length > 0 || symbolKeys.length > 0) {
    return {
      ok: false,
      reason: 'pane_readiness_shape_unexpected',
      detail: {
        missing,
        unexpected,
        symbolKeys: symbolKeys.map((key) => String(key)),
        expected: [...READINESS_ANSWER_KEYS],
      },
    };
  }

  // ===================================================================
  // DATA, NOT BEHAVIOUR - AND READ EXACTLY ONCE (Architect #77).
  //
  // An accessor is not a stated fact, it is code that runs every time the
  // property is touched, so it can answer `true` to the check and something
  // else to the use. Every field below was read straight off `answer`, more
  // than once in places, which is a time-of-check/time-of-use gap wide enough
  // to drive a delivery through.
  //
  // So: every required field must be an own DATA descriptor, and from here
  // down nothing reads `answer` again. The snapshot taken from the descriptors
  // IS the answer; a getter cannot change its mind about a value already
  // captured.
  // ===================================================================
  const accessors = READINESS_ANSWER_KEYS.filter(
    (key) => !Object.prototype.hasOwnProperty.call(descriptors[key] || {}, 'value')
  );
  if (accessors.length > 0) {
    return {
      ok: false,
      reason: 'pane_readiness_not_a_data_record',
      detail: { accessors },
    };
  }
  const stated = {
    attainable: descriptors.attainable.value,
    reason: descriptors.reason.value,
    runtime: descriptors.runtime.value,
    lastProofAtMs: descriptors.lastProofAtMs.value,
  };

  if (stated.attainable !== true) {
    return {
      ok: false,
      reason: 'pane_readiness_unproven',
      detail: {
        readinessReason: safeDetailValue(stated.reason),
        attainable: safeDetailValue(stated.attainable),
        runtime: safeDetailValue(stated.runtime),
        lastProofAtMs: safeDetailValue(stated.lastProofAtMs),
      },
    };
  }

  if (stated.reason !== READINESS_POSITIVE_REASON) {
    // attainable:true carrying an unattainable reason is not a yes with a
    // stale note attached; it is two contradictory claims in one object.
    return {
      ok: false,
      reason: 'pane_readiness_reason_incoherent',
      detail: { readinessReason: safeDetailValue(stated.reason), expected: READINESS_POSITIVE_REASON },
    };
  }

  const launch = normalizeRuntime(launchRuntime);
  if (!launch) {
    return { ok: false, reason: 'pane_readiness_launch_runtime_unknown', detail: { launchRuntime: launchRuntime ?? null } };
  }
  const answered = normalizeRuntime(stated.runtime);
  if (!answered) {
    return { ok: false, reason: 'pane_readiness_runtime_missing', detail: { runtime: safeDetailValue(stated.runtime) } };
  }
  if (answered !== launch) {
    // THE ALTERNATE-PANE ANSWER. A probe that reports on `claude` cannot
    // authorise a write to a pane the registry bound to `codex`.
    return {
      ok: false,
      reason: 'pane_readiness_runtime_mismatch',
      detail: { launchRuntime: launch, answeredRuntime: answered },
    };
  }

  // AN ACTUAL NUMBER, CHECKED BEFORE ANY ARITHMETIC TOUCHES IT (Oracle #47).
  //
  // `Number(answer.lastProofAtMs)` was the coercion hole: String(now - 1000) is
  // a perfectly fresh safe integer once coerced, and so is any object with a
  // valueOf. The production probe reads its timestamp out of the receipt store
  // and returns a number; a string means whatever produced this answer is not
  // that probe, and guessing on its behalf is the direction that delivers.
  const lastProofAtMs = stated.lastProofAtMs;
  if (typeof lastProofAtMs !== 'number'
    || !Number.isSafeInteger(lastProofAtMs)
    || lastProofAtMs <= 0) {
    return {
      ok: false,
      reason: 'pane_readiness_proof_time_invalid',
      detail: {
        lastProofAtMs: typeof lastProofAtMs === 'object' ? '[object]' : (lastProofAtMs ?? null),
        type: typeof lastProofAtMs,
      },
    };
  }
  const now = Number(nowMs);
  if (!Number.isFinite(now)) {
    return { ok: false, reason: 'pane_readiness_clock_unknown', detail: { nowMs: nowMs ?? null } };
  }
  if (lastProofAtMs > now) {
    // Proof from the future is a broken or lying clock, and the direction it
    // breaks in is the one that delivers.
    return {
      ok: false,
      reason: 'pane_readiness_proof_time_in_future',
      detail: { lastProofAtMs, nowMs: now },
    };
  }

  // THE RULE IS NOT COPIED HERE, IT IS CALLED. Freshness belongs to the probe;
  // re-deriving its window in this file would be a second copy of someone
  // else's truth, and the two would drift apart silently.
  const rederived = probeRuntimeProofCapability({
    runtime: answered,
    receiptActivity: { [answered]: lastProofAtMs },
    nowMs: now,
  });
  if (rederived.attainable !== true
    || rederived.reason !== READINESS_POSITIVE_REASON
    || normalizeRuntime(rederived.runtime) !== answered
    || Number(rederived.lastProofAtMs) !== lastProofAtMs) {
    return {
      ok: false,
      reason: 'pane_readiness_not_reproducible',
      detail: {
        offered: {
          attainable: safeDetailValue(stated.attainable),
          reason: safeDetailValue(stated.reason),
          runtime: answered,
          lastProofAtMs,
        },
        rederived: {
          attainable: rederived.attainable,
          reason: rederived.reason,
          runtime: rederived.runtime,
          lastProofAtMs: rederived.lastProofAtMs,
        },
      },
    };
  }

  return { ok: true, runtime: answered, lastProofAtMs };
}

async function runTelegramAdmissionSequence(input = {}) {
  const {
    db,
    job = {},
    record = {},
    appGeneration,
    paneId = '1',
    role = 'architect',
    obligorAddress = 'architect',
    mode = MODES.FULL,
    composeFinalBody,
    // REQUIRED IN FULL MODE. Deliberately undefaulted: see the B_readiness gate.
    paneReadiness,
    now = () => Date.now(),
    nonce,
    cutoverId = TELEGRAM_CUTOVER_ID,
    // Seams. Defaulted to the real primitives; overridden only by tests that
    // need to fail one exact step and prove nothing after it ran.
    steps = {},
  } = input;

  // ===================================================================
  // THE SEQUENCE OWNS THE CLEANUP IDENTITY (Oracle #13, blocker 2).
  //
  // The drain used to answer "which claim did that refusal create?" by
  // re-reading the tuple and closing whatever it found. On a lost race at B
  // that read returns ANOTHER PROCESS'S LIVE CLAIM, and the old code closed it
  // — releasing someone else's in-flight delivery and inviting a duplicate.
  // The only place that knows which claim this attempt owns is the code that
  // made it, so every refusal from here down carries that answer explicitly:
  // `ownedClaimId` is null until B succeeds, and null means "this attempt
  // latched nothing; you may not close anything on its behalf".
  // ===================================================================
  let ownedClaimId = null;
  const refuseHere = (stage, reason, detail = null, phase = PHASES.BEFORE_DELIVERY) => ({
    ...refuse(stage, reason, detail, phase),
    ownedClaimId,
    // PROVABLY UNSENT ONLY BEFORE D. A refusal we returned from between B and D
    // is first-hand evidence that no bytes were authorised; anything at or past
    // the ambiguous boundary is not, and must never authorise a close.
    ownedClaimUnsent: ownedClaimId !== null && phase === PHASES.BEFORE_DELIVERY,
  });

  const stepRecordSource = steps.recordImmutableSource || recordImmutableSource;
  const stepClaim = steps.claimTransportAttempt || claimTransportAttempt;
  const stepDeliveryStarted = steps.recordDeliveryStarted || recordDeliveryStarted;
  const stepFindLaunch = steps.findActivePaneLaunch || findActivePaneLaunch;

  if (!db) return refuseHere('precondition', 'sequence_no_durable_handle');
  if (typeof composeFinalBody !== 'function' && mode === MODES.FULL) {
    return refuseHere('precondition', 'sequence_no_compose_final_body');
  }
  if (!isNonEmptyString(job.messageId)) return refuseHere('precondition', 'sequence_missing:messageId');
  if (!Number.isSafeInteger(Number(job.updateId)) || Number(job.updateId) <= 0) {
    return refuseHere('precondition', 'sequence_missing:updateId');
  }
  if (!isNonEmptyString(appGeneration)) return refuseHere('precondition', 'sequence_missing:appGeneration');

  // STALE SCHEMA STOPS EVERYTHING, BEFORE ANY WRITE.
  //
  // Apply, then VERIFY — and the verify is the load-bearing half. `CREATE TABLE
  // IF NOT EXISTS` succeeds against a database carrying an OLDER shape of these
  // tables and reports success, so applying the schema proves nothing about
  // what is actually installed. This is the A2b lesson: check the installed
  // shape, never trust the create.
  const applied = applyTelegramAdmissionSchema(db);
  if (!applied.ok) return refuseHere('schema', 'sequence_schema_apply_failed', applied);
  const schema = verifyInstalledSchema(db);
  if (!schema.ok) return refuseHere('schema', 'sequence_schema_unverified', schema);

  const updateId = Number(job.updateId);
  const routeKey = String(job.routeKey || job.profile || job.windowKey || 'main');
  const queuedPayloadSha256 = canonicalQueuedPayloadDigest(record);

  // ---------------------------------------------------------------- A
  const source = stepRecordSource(db, {
    messageId: job.messageId,
    updateId,
    chatId: job.chatId,
    routeKey,
    profile: String(job.profile || routeKey),
    windowKey: String(job.windowKey || routeKey),
    rawBody: String(job.rawBody ?? ''),
    canonicalPayloadSha256: queuedPayloadSha256,
    mediaIdentitySha256: job.mediaIdentitySha256,
    cutoverId,
    obligorAddress,
    sessionId: job.sessionId ?? null,
    recordedAtMs: Number(job.sentAtMs) > 0 ? Number(job.sentAtMs) : now(),
  });
  if (!source.ok) return refuseHere('A_source', source.reason, source.detail ?? null);
  if (!Number.isSafeInteger(Number(source.sourceRowId)) || Number(source.sourceRowId) <= 0) {
    // The committed identity is REQUIRED, not merely `ok`. A step that reports
    // success without returning the row id it created has not given the next
    // step anything to join to.
    return refuseHere('A_source', 'source_row_id_missing', source);
  }

  if (mode === MODES.SOURCE_ONLY) {
    return {
      ok: true,
      mode,
      stage: 'A_source',
      sourceRowId: Number(source.sourceRowId),
      obligationId: source.obligationId ?? null,
      created: source.created === true,
      // NAMED, so no downstream reader can mistake this for an authorised
      // delivery. There is no claim and no delivery_started behind it.
      authorized: null,
      queuedPayloadSha256,
    };
  }

  // ---------------------------------------------------------------- B
  const launch = stepFindLaunch(db, { appGeneration, paneId: String(paneId) });
  if (!launch.ok) return refuseHere('B_launch', launch.reason, launch.detail ?? null);
  if (String(launch.role) !== String(role)) {
    return refuseHere('B_launch', 'launch_role_mismatch', {
      launchRole: launch.role, offered: role,
    });
  }

  // ===================================================================
  // PANE READINESS, AND IT REFUSES BEFORE ANYTHING IS LATCHED (Oracle #7).
  //
  // The launch rows above prove a pane was launched and bound for this
  // generation. They do NOT prove that pane can ever answer. A runtime that has
  // never produced a terminal receipt turns every claim into a permanent hold:
  // B latches, D authorises, the bytes go out, and no proof can ever retire it.
  // That is not a hypothetical — it is the live diagnosis on this very queue
  // (`unprovable_pane:runtime_never_produced_proof`), and activating the kernel
  // without this gate would manufacture one durable hold per message.
  //
  // So the question is asked HERE, above B, where the honest answer is still
  // "nothing happened": no claim, no D, nothing to close, the record stays
  // queued and visible. A stuck queue is recoverable; a latched-and-unprovable
  // one needs a human.
  //
  // FAIL CLOSED IN EVERY DIRECTION. Absent probe, a throw, a malformed answer,
  // or anything short of a definite yes all refuse. A readiness gate that
  // defaults to ready is not a gate, and "I could not tell" is precisely the
  // state that must not deliver.
  //
  // The probe is handed the runtime the LAUNCH REGISTRY recorded, not one the
  // caller names, so a caller cannot answer for a different pane than the one
  // about to be written.
  // ===================================================================
  if (typeof paneReadiness !== 'function') {
    return refuseHere('B_readiness', 'sequence_no_pane_readiness_probe');
  }
  let readiness;
  try {
    readiness = await paneReadiness({
      runtime: launch.consumerRuntime ?? null,
      appGeneration,
      paneId: String(paneId),
      launchId: launch.launchId,
      routeKey,
      updateId,
    });
  } catch (err) {
    return refuseHere('B_readiness', `pane_readiness_threw:${err.message}`);
  }
  // ONE COHERENT CONTRACT, BOUND TO THE LAUNCH-RECORDED RUNTIME. See
  // `evaluatePaneReadinessAnswer` for why an OR over two booleans was not a
  // gate. The refusal reasons stay in the probe's own vocabulary so the drain
  // and the health surface keep reading the same words.
  const readinessVerdict = evaluatePaneReadinessAnswer({
    answer: readiness,
    launchRuntime: launch.consumerRuntime,
    nowMs: now(),
  });
  if (!readinessVerdict.ok) {
    return refuseHere('B_readiness', readinessVerdict.reason, {
      ...(readinessVerdict.detail || {}),
      launchRuntime: launch.consumerRuntime ?? null,
      launchId: launch.launchId,
    });
  }

  const attemptNonce = isNonEmptyString(job.attemptNonce)
    ? job.attemptNonce
    : (typeof nonce === 'function' ? String(nonce()) : '');
  if (!isNonEmptyString(attemptNonce)) return refuseHere('B_claim', 'sequence_missing:attemptNonce');

  const claim = stepClaim(db, {
    cutoverId,
    routeKey,
    updateId,
    sourceRowId: Number(source.sourceRowId),
    appGeneration,
    paneLaunchId: launch.launchId,
    paneId: String(paneId),
    role,
    consumerRuntime: launch.consumerRuntime,
    attemptNonce,
    attemptAtMs: now(),
  });
  // A LOST RACE IS NOT OWNERSHIP. `claim_held_by_other` returns here with
  // `ownedClaimId` still null, deliberately: the live claim it names belongs to
  // someone else and closing it is the exact defect this guard exists to stop.
  if (!claim.ok) return refuseHere('B_claim', claim.reason, claim.detail ?? null);
  if (!isNonEmptyString(claim.claimId)) {
    return refuseHere('B_claim', 'claim_id_missing', claim);
  }
  // FROM HERE DOWN THIS SEQUENCE OWNS A CLAIM, and every refusal below says so.
  ownedClaimId = String(claim.claimId);

  // ---------------------------------------------------------------- C
  let finalBody;
  try {
    finalBody = await composeFinalBody();
  } catch (err) {
    // The claim is held and NOTHING was delivered. Provably unsent by the
    // invariant, so it is safe to leave for `closeUnsentClaim` — never for a
    // silent re-claim by the next pass.
    return refuseHere('C_compose', `compose_threw:${err.message}`);
  }
  if (typeof finalBody !== 'string' || finalBody.length === 0) {
    return refuseHere('C_compose', 'compose_empty_body');
  }

  const markerFields = {
    updateId: String(updateId),
    messageId: String(job.messageId),
    routeKey,
    windowKey: String(job.windowKey || routeKey),
    profile: String(job.profile || routeKey),
    chatId: String(job.chatId ?? ''),
    appGeneration: String(appGeneration),
    queuedPayloadSha256,
    claimId: String(claim.claimId),
    attemptNonce: String(attemptNonce),
  };
  const authorizedText = appendConsumeMarker(finalBody, markerFields);

  // PARSE WHAT WE ARE ABOUT TO SEND, WITH THE CONSUMER'S OWN PARSER.
  //
  // `appendConsumeMarker` returns the text UNCHANGED when any field is
  // unusable — a silent success that would deliver an unmarked prompt whose
  // proof can never come back. And a body containing its own marker-lookalike
  // changes what the parser sees. The only way to know the consumer will read
  // the identity we meant is to read it back the same way it will.
  const roundTrip = parseConsumeMarker(authorizedText);
  if (!roundTrip) return refuseHere('C_marker', 'marker_round_trip_failed');
  for (const field of MARKER_FIELDS) {
    if (String(roundTrip[field]) !== String(markerFields[field])) {
      return refuseHere('C_marker', 'marker_round_trip_mismatch', {
        field, expected: markerFields[field], parsed: roundTrip[field] ?? null,
      });
    }
  }

  // THESE EXACT BYTES. Hashed after every decoration, including the marker.
  const deliveredPromptSha256 = sha256(authorizedText);
  const deliveredPromptBytes = Buffer.byteLength(authorizedText, 'utf8');

  // ---------------------------------------------------------------- D
  const started = stepDeliveryStarted(db, {
    claimId: claim.claimId,
    atMs: now(),
    deliveredPromptSha256,
    deliveredPromptBytes,
    detail: `route=${routeKey} pane=${paneId} runtime=${launch.consumerRuntime}`,
  });
  if (!started.ok) return refuseHere('D_delivery_started', started.reason, started.detail ?? null);

  // ---------------------------------------------------------------- E
  // The caller writes the pane ONCE, with `authorized.text` and nothing else.
  return {
    ok: true,
    mode,
    stage: 'D_delivery_started',
    sourceRowId: Number(source.sourceRowId),
    obligationId: source.obligationId ?? null,
    claimId: claim.claimId,
    attemptNonce,
    paneLaunchId: launch.launchId,
    consumerRuntime: launch.consumerRuntime,
    queuedPayloadSha256,
    replayed: started.created === false,
    commsProjection: started.commsProjection ?? null,
    authorized: {
      text: authorizedText,
      sha256: deliveredPromptSha256,
      bytes: deliveredPromptBytes,
    },
  };
}

module.exports = {
  PHASES,
  MODES,
  MARKER_FIELDS,
  READINESS_POSITIVE_REASON,
  evaluatePaneReadinessAnswer,
  runTelegramAdmissionSequence,
};
