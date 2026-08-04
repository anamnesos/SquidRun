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
  runTelegramAdmissionSequence,
};
