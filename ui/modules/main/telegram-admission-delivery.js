/**
 * THE GLUE BETWEEN THE APP AND THE ADMISSION KERNEL.
 *
 * It lives here rather than as two more methods on `squidrun-app.js` for the
 * same reason `app-generation.js` does: that file is a 16k-line god-object
 * sitting ~1.5k lines above its frozen ceiling, and buying this correctness
 * with more of exactly the problem the guard exists to stop is a bad trade.
 *
 * It also makes the glue testable without constructing the app: everything it
 * needs arrives as an argument or as a named method on the `app` it is handed.
 */
const { randomBytes } = require('node:crypto');

const { TelegramAdmissionWriter } = require('./telegram-admission-writer');
const { runTelegramAdmissionSequence, MODES } = require('./telegram-admission-sequence');
const { currentAppGeneration } = require('./app-generation');
const { findTransportClaim } = require('./telegram-claim-lookup');
const { closeUnsentClaim } = require('./telegram-admission-store');

/**
 * Resolve the durable handle this admission will be written on.
 *
 * Opened and closed per admission. A long-lived writer on the app is a
 * lifecycle bug waiting to happen — quit, profile switch, re-init — for a path
 * that handles a handful of messages a minute, and a stale handle here does not
 * fail loudly, it fails into a database nobody is reading.
 */
function resolveAdmissionWriter(app) {
  if (typeof app.telegramAdmissionWriterFactory === 'function') {
    return { ok: true, writer: app.telegramAdmissionWriterFactory() };
  }

  const harnessDbPath = String(process.env.SQUIDRUN_ADMISSION_DB_PATH || '').trim();
  if (harnessDbPath) {
    // An ISOLATED database for harnesses that drive the whole app object.
    // Production never sets this; it exists so a test can exercise the real
    // sequence against a temp ledger instead of mocking the thing under test.
    return {
      ok: true,
      writer: new TelegramAdmissionWriter({
        dbPath: harnessDbPath,
        sessionId: app.commsSessionScopeId || null,
      }),
    };
  }

  if (process.env.JEST_WORKER_ID) {
    // A HARD INTERLOCK, not a shaped check.
    //
    // The default writer resolves the evidence ledger by walking for a project
    // root. Under Jest that walk can land on the REAL one, and this sequence
    // writes. No test may reach the live ledger by forgetting to inject a temp
    // database, so the absence of one refuses loudly here instead of succeeding
    // somewhere it must never touch.
    return { ok: false, reason: 'admission_writer_factory_required_under_test' };
  }

  return {
    ok: true,
    writer: new TelegramAdmissionWriter({ sessionId: app.commsSessionScopeId || null }),
  };
}

/** Run the awaited A-B-C-D sequence for one inbound job. */
async function runAdmissionForJob(app, options = {}) {
  const resolved = resolveAdmissionWriter(app);
  if (!resolved.ok) {
    return { ok: false, stage: 'writer', reason: resolved.reason, phase: 'before_delivery' };
  }

  const writer = resolved.writer;
  const opened = writer.open();
  if (!opened.ok) {
    // No durable handle means no honest record of a delivery, so nothing may be
    // delivered. An undelivered message stays pending and recoverable.
    return {
      ok: false,
      stage: 'writer',
      reason: opened.reason || 'writer_unavailable',
      phase: 'before_delivery',
    };
  }
  try {
    return await runTelegramAdmissionSequence({
      db: writer.db,
      job: options.job,
      record: options.record || {},
      appGeneration: currentAppGeneration(),
      paneId: '1',
      role: 'architect',
      obligorAddress: 'architect',
      mode: options.mode || MODES.FULL,
      composeFinalBody: options.composeFinalBody,
      nonce: () => `n_${randomBytes(12).toString('hex')}`,
    });
  } finally {
    writer.close();
  }
}

/**
 * The identity the kernel is asked to record, derived from the SAME job the
 * pane delivery uses. Built here so there is one place where a field can go
 * missing, and one place a test has to cover to prove it did not.
 */
function buildAdmissionJob(job = {}, deliveryIdentity = {}) {
  return {
    messageId: job.inboundMessageId,
    updateId: job.updateId,
    chatId: job.metadata?.chatId,
    routeKey: deliveryIdentity.routeKey,
    profile: deliveryIdentity.profile,
    windowKey: job.inboundWindowKey,
    rawBody: job.body,
    // ===================================================================
    // THE SESSION THE MESSAGE BELONGS TO, NOT THE ONE DELIVERING IT.
    // ===================================================================
    // `inboundSessionScopeId` is the CURRENT delivery session, and it was being
    // written into an IMMUTABLE identity column. So the same message replayed
    // after a restart - crash after A, retry in G+1 - recorded a different
    // source session than the row that already existed and failed
    // `source_identity_conflict` on a field that describes when we happened to
    // be delivering, not what James sent (Oracle #10, reproduced).
    //
    // The spool record's own session is stable across every retry, which is the
    // only property an immutable column may be built on. The claim still
    // carries the CURRENT launch and generation; that is where "which process
    // is delivering this" belongs.
    // A RECORD WITH NO ORIGINAL SESSION RECORDS NULL, not today's session. The
    // column is nullable on purpose; filling it with the delivering session
    // would restore the exact instability this line removes.
    sessionId: job.record?.targetSession || null,
    sentAtMs: job.sentAtMs,
  };
}

/**
 * THE DRAIN'S READ OF THE ATTEMPT LATCH, on the app's own durable handle.
 *
 * Throws rather than returning null when the store cannot be reached. The drain
 * maps a throw to a hold; a null means "nothing has claimed this", and those
 * two must never be confused, because the second one delivers.
 */
async function lookupTransportClaimForApp(app, query = {}) {
  const resolved = resolveAdmissionWriter(app);
  if (!resolved.ok) throw new Error(`transport claim writer unavailable: ${resolved.reason}`);
  return findTransportClaim({
    updateId: query.updateId,
    routeKey: query.routeKey,
    writerFactory: () => resolved.writer,
  });
}

/** Release a provably-unsent claim held by a boot that has ended. */
async function closeUnsentClaimForApp(app, input = {}) {
  const resolved = resolveAdmissionWriter(app);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const writer = resolved.writer;
  const opened = writer.open();
  if (!opened.ok) return { ok: false, reason: opened.reason || 'writer_unavailable' };
  try {
    return closeUnsentClaim(writer.db, {
      claimId: input.claimId,
      reason: input.reason,
      atMs: input.atMs,
    });
  } finally {
    writer.close();
  }
}

/**
 * SOURCE ONLY FOR A SCOPED WINDOW, and named as such.
 *
 * The bytes go to ANOTHER PROCESS, which renders its own pane. This process
 * cannot honestly hash what that pane received, so a consume marker here would
 * ask for an echo nobody can send and the claim would hold forever — Oracle's
 * exact warning about turning every delivery_started into a permanent hold. The
 * kernel still owns the row; it just does not pretend to have proof it cannot
 * get.
 */
async function admitScopedTelegramSource(app, options = {}) {
  const { job, record, inboundMessageId, log } = options;
  const admission = await app.runTelegramAdmissionForJob({
    job, record, mode: MODES.SOURCE_ONLY,
  });
  if (admission.ok) return { ok: true, admission };

  log.warn(
    'Telegram',
    `Scoped admission refused for ${inboundMessageId} at ${admission.stage} (${admission.reason}); not delivering`
  );
  return {
    ok: false,
    admission,
    refusal: {
      ok: false,
      status: `admission_refused:${admission.reason}`,
      admissionStage: admission.stage,
      // SOURCE-ONLY NEVER CLAIMS, so a scoped refusal can never own a claim to
      // release. Stated rather than left absent, so the drain's contract is
      // satisfied by a value this path chose.
      claimRelease: claimReleaseFor(admission),
    },
  };
}

/**
 * WHAT A REFUSED DELIVERY AUTHORISES THE DRAIN TO CLEAN UP.
 *
 * Three answers, and the difference between them is the difference between a
 * released message and someone else's delivery being torn out from under them
 * (Oracle #13, blocker 2):
 *
 *   owned_unsent  this attempt made claim X and returned before D. First-hand
 *                 evidence that nothing was written. Close X — exactly X.
 *   none          this attempt latched nothing (refused before B, or lost the
 *                 race at B). There is nothing of ours to close, and whatever
 *                 else holds the tuple is not ours to touch.
 *   unknown       we cannot say which side of the boundary we ended on. HOLD.
 *
 * A receipt that names no claim can never authorise closing one. That is the
 * whole invariant, and it is why the drain reads this instead of re-reading the
 * database and closing whatever it finds.
 */
function claimReleaseFor(admission = {}) {
  const claimId = typeof admission.ownedClaimId === 'string' ? admission.ownedClaimId.trim() : '';
  if (admission.ownedClaimUnsent === true && claimId) {
    return { kind: 'owned_unsent', claimId };
  }
  return { kind: 'none' };
}

/**
 * THE AUTHORISED MAIN-PANE WRITE.
 *
 * Compose happens INSIDE the sequence so the digest covers the recall block,
 * the reply-target guard and the consume marker — the bytes that actually reach
 * the pane. Then exactly one write, with exactly those bytes. Nothing between D
 * and E may touch the string.
 */
async function deliverAdmittedMainTelegram(app, options = {}) {
  const {
    safeMessage, recallContext, job, record, inboundMessageId, log,
  } = options;

  let composed = null;
  let admission;
  try {
    admission = await app.runTelegramAdmissionForJob({
      job,
      record,
      mode: MODES.FULL,
      composeFinalBody: async () => {
        composed = await app.composeHumanPaneMessage(safeMessage, recallContext, 'Telegram');
        return composed.outboundMessage;
      },
    });
  } catch (err) {
    // A throw out of the kernel means E has not run — the pane write is below
    // this call — but it does NOT tell us which step threw, so it cannot say
    // whether a claim was taken or how far the sequence got. Unknown boundary:
    // the drain holds rather than closing or retrying (Oracle #13's rule).
    return {
      ok: false,
      status: 'admission_runtime_error',
      error: err.message,
      claimRelease: { kind: 'unknown' },
    };
  }

  if (!admission.ok) {
    log.warn(
      'Telegram',
      `Main admission refused for ${inboundMessageId} at ${admission.stage} (${admission.reason}); no pane write`
    );
    return {
      ok: false,
      status: `admission_refused:${admission.reason}`,
      admissionStage: admission.stage,
      admissionPhase: admission.phase || 'before_delivery',
      claimRelease: claimReleaseFor(admission),
    };
  }

  if (admission.replayed) {
    // delivery_started already existed for these exact bytes. Something wrote,
    // or was writing, this pane before. Re-writing on the strength of an
    // idempotent record is how James reads the same message twice.
    log.warn(
      'Telegram',
      `Main admission for ${inboundMessageId} replayed an existing delivery_started; holding instead of writing again`
    );
    // PAST D BY DEFINITION — a delivery_started already exists for these bytes,
    // so nothing here may close anything.
    return {
      ok: false,
      accepted: true,
      status: 'accepted.delivery_started_replay',
      claimRelease: { kind: 'none' },
    };
  }

  try {
    return await app.deliverHumanMessageWithRecall(
      admission.authorized.text,
      { ...recallContext, preComposed: composed },
      'Telegram'
    );
  } catch (err) {
    // PAST the authorisation boundary: these bytes may already be on screen.
    // Ambiguous, never definite — the durable claim holds and only proof or
    // explicit recovery releases it.
    return {
      ok: false,
      accepted: true,
      ambiguous: true,
      status: 'main_pane_runtime_error',
      error: err.message,
      claimRelease: { kind: 'none' },
    };
  }
}

module.exports = {
  MODES,
  claimReleaseFor,
  resolveAdmissionWriter,
  buildAdmissionJob,
  runAdmissionForJob,
  lookupTransportClaimForApp,
  closeUnsentClaimForApp,
  admitScopedTelegramSource,
  deliverAdmittedMainTelegram,
};
