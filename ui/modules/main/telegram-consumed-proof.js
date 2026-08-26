/**
 * `telegram_consumed.v1` — the ONE schema that can retire a Telegram inbound
 * record, and the ONE validator that may say so.
 *
 * =====================================================================
 * WHY EVERY EARLIER ATTEMPT FAILED
 * =====================================================================
 * Four times in one day this system reported its own success while the thing
 * that mattered had not happened:
 *
 *   - a shadow-runner status file said running:true while the process was dead;
 *   - startup health scored 100/100 while six of Operator's messages rotted;
 *   - the drain treated `accepted.daemon_pty_unverified` as meaningful;
 *   - the delivery bus certified 2283 bytes packetized, reassembled, written
 *     and ACKED — while the pane held 125 characters beginning mid-word.
 *
 * That last one is the reason this file exists in its current shape. A proof
 * keyed to the EXISTENCE of a delivery ack proves nothing: a truncated write
 * satisfies it, the record retires, and Operator loses the tail of his message
 * with every layer reporting success. So proof here is not "an ack happened".
 * Proof is: THE CONSUMER ECHOED BACK A DIGEST OF THE EXACT BYTES IT RECEIVED,
 * AND THEY MATCH WHAT WE SENT.
 *
 * A truncated delivery cannot satisfy that. It hashes differently. That is the
 * whole point, and it is tested.
 *
 * =====================================================================
 * WHAT MAKES THIS RUNTIME-NEUTRAL
 * =====================================================================
 * Not the producer — there is no single component that both sees every pane
 * delivery AND can vouch for what a model actually consumed. The PTY layer
 * sees them all and is precisely what certified 2417 bytes for a 125-char
 * tail; seeing every delivery is not proving any of them.
 *
 * Neutrality lives in the SCHEMA. Each runtime has its own consumer adapter
 * (Claude's UserPromptSubmit hook, Codex's UserPromptSubmit hook) and those
 * adapters may differ internally as much as they like. What they emit is
 * byte-identical in shape, and this validator cannot tell which runtime
 * produced a record except by reading the `runtime` field it carries. A future
 * runtime plugs in by emitting the same schema; nothing here changes.
 *
 * =====================================================================
 * ABSENCE IS NOT A VERDICT
 * =====================================================================
 * The S491 root cause was NOT that Codex is incapable of proving consumption.
 * `.codex/hooks.json` declared the receipt adapter all along; `config.toml`
 * carried no trust row for any project hook, so Codex skipped it silently and
 * wrote nothing. Every layer downstream read that silence as "this runtime
 * cannot prove consumption" and held forever.
 *
 * So a missing producer must never be reported as an incapable runtime. The
 * two are different findings with different fixes, and `PRODUCER_STATES` below
 * keeps them apart by construction.
 */
const crypto = require('node:crypto');

const { readStampedProtocol } = require('./telegram-source-protocol');

/**
 * PHASE 1 OF TWO. This schema records ADMISSION, not consumption, and the name
 * is load-bearing.
 *
 * Codex 0.146 `UserPromptSubmit` runs BEFORE `record_pending_input` and before
 * first sampling, and it ALSO fires on TurnAborted branches. So a turn that
 * admits the prompt and then aborts still produces one of these records. It
 * proves the exact bytes reached the consumer boundary, bound to pane, session,
 * turn, generation and both digests - and it proves nothing about whether
 * anything was ever DONE with them.
 *
 * On this queue that distinction is the difference between correct and
 * catastrophic: admission alone could retire "Example customer approved job...
 * change job to invoice" on the strength of a turn that never ran.
 *
 * So it is called admission. If it were named `prompt_consumed`, somebody
 * downstream - plausibly a future me - would retire on it and the NAME would
 * make that look correct. Today has already shown what a reassuring name over
 * an unverified fact costs. A terminal hook for the SAME bound turn promotes
 * this to retirement authority; nothing else may.
 */
const SCHEMA = 'telegram_admission.v1';
/** Phase 2. Only a record of THIS schema may authorise retirement. */
const TERMINAL_SCHEMA = 'telegram_consumed.v1';

/**
 * The ONLY positive classes. A record must carry one of these; carrying the
 * right identity fields is not enough.
 *
 * GATE ITEM 2, and it was a real hole in my previous draft: a plain object
 * with the expected ids and timestamps satisfied that validator completely. It
 * asked "do these fields match" and never "is this actually a proof". A
 * fabricated object answers the first question perfectly.
 */
const POSITIVE_PROOF_CLASSES = Object.freeze(new Set(['prompt_admitted']));

/**
 * Why no proof exists yet — kept strictly apart from "cannot exist".
 *
 * `producer_never_fired` is the S491 state: an adapter is declared but
 * untrusted, so it runs zero times and leaves no trace. It reads identically
 * to "unsupported runtime" from the outside, and conflating them is what cost
 * 8.6 hours.
 */
const PRODUCER_STATES = Object.freeze({
  OBSERVED: 'producer_observed',
  NEVER_FIRED: 'producer_never_fired',
  UNSUPPORTED: 'runtime_unsupported',
  UNKNOWN: 'producer_unknown',
});

/** Every field that must be present and correct. No field is optional. */
const REQUIRED_FIELDS = Object.freeze([
  'schema',
  'proofClass',
  'runtime',
  'updateId',
  'messageId',
  'routeKey',
  'windowKey',
  'profile',
  'chatId',
  'appGeneration',
  'consumerSessionId',
  'paneId',
  'queuedPayloadSha256',
  'deliveredPromptSha256',
  'deliveredPromptBytes',
  'consumedAtMs',
  // ===================================================================
  // THE FIELDS THE RECORD MUST ASSERT ABOUT ITSELF.
  //
  // These existed only in side columns on `telegram_admission_receipts` and in
  // caller input, so the sole validator never compared them. A field carried
  // ALONGSIDE the record is not a field the record asserts: the verbatim bytes
  // could be replayed against a different claim, launch, role or submission and
  // every comparison the validator actually performed would still pass.
  // ===================================================================
  'claimId',
  'attemptNonce',
  'paneLaunchId',
  'role',
  'hookProcessId',
  'hookParentProcessId',
  'runtimeSubmissionId',
  'runtimeSubmissionKind',
]);

const SHA256_RE = /^[0-9a-f]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.from(String(value ?? ''), 'utf8')).digest('hex');
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

/**
 * The canonical digest of what the QUEUE holds for this update.
 *
 * Deliberately computed from the durable record's own fields rather than from
 * the formatted prompt: the prompt gets a `[Telegram from x]:` prefix, recall
 * context, and possibly a truncation notice, none of which are the message.
 * This digest answers "is this the same MESSAGE", so that the same updateId
 * carrying a different body cannot match (gate item 1).
 */
function mediaIdentity(media) {
  if (!media || typeof media !== 'object') return null;
  // Identity, not the bytes: the parts that decide WHICH artifact this is and
  // how it will be presented. A local path is deliberately excluded — it is
  // mutable and machine-specific, and hashing it would make the same message
  // digest differently on two machines.
  return {
    kind: media.kind ?? null,
    telegramKind: media.telegramKind ?? null,
    fileId: media.fileId ?? null,
    fileUniqueId: media.fileUniqueId ?? null,
    mimeType: media.mimeType ?? null,
    fileName: media.fileName ?? null,
    fileSize: Number.isFinite(Number(media.fileSize)) ? Number(media.fileSize) : null,
    caption: typeof media.caption === 'string' ? media.caption : null,
    duration: Number.isFinite(Number(media.duration)) ? Number(media.duration) : null,
    width: Number.isFinite(Number(media.width)) ? Number(media.width) : null,
    height: Number.isFinite(Number(media.height)) ? Number(media.height) : null,
  };
}

/**
 * The canonical digest of what the QUEUE holds for this update.
 *
 * MUST COVER EVERYTHING THE CONSUMER CAN SEE (gate probe 3). The first version
 * hashed five text-only fields, which meant a record whose TEXT was unchanged
 * but whose photo, document or caption had been swapped produced an identical
 * digest and matched. For a plumbing business that is not a theoretical gap: a
 * message reading "here is the one I meant" is entirely defined by its
 * attachment.
 *
 * Deliberately computed from the durable record's own fields rather than from
 * the formatted prompt: the prompt gets a `[Telegram from x]:` prefix, recall
 * context, a consume marker and possibly a truncation notice, none of which
 * are the message.
 */
function canonicalQueuedPayloadDigest(record = {}) {
  const payload = {
    v: 2,
    updateId: Number(record.updateId),
    updateKind: record.updateKind ?? null,
    text: typeof record.text === 'string' ? record.text : '',
    chatId: record.chatId ?? null,
    from: record.from ?? null,
    messageId: record.messageId ?? null,
    // Stable route identity: the same bytes delivered to a different window or
    // profile are not the same delivery.
    routeKey: record.routeKey ?? null,
    targetProfile: record.targetProfile ?? null,
    targetWindow: record.targetWindow ?? null,
    media: mediaIdentity(record.media),
    photo: mediaIdentity(record.photo),
    video: mediaIdentity(record.video),
    document: mediaIdentity(record.document),
  };

  // ===================================================================
  // THE POST-CUTOVER TUPLE IS COVERED, AND LEGACY RECORDS DO NOT MOVE (v7 §1).
  //
  // v7 requires the canonical source digest to cover the new protocol fields,
  // because an unstamped digest would let a record's transport identity change
  // without its digest changing - and that digest is what the decision, plan and
  // proof tables all join on.
  //
  // But it ALSO requires that "existing records 700100102..700100106 stay legacy
  // byte-for-byte". Those two together mean the new fields cannot simply be
  // added to the v2 object: doing that would emit four extra nulls for every
  // record in the live queue and change all twelve digests, which is the live
  // fence this repair is under orders not to touch.
  //
  // So the shape is versioned by CONTENT, not by build. A record with no
  // complete stamp hashes exactly the v2 bytes it hashes today - same key order,
  // same values, same digest - and a stamped record gets the v3 shape that
  // covers its tuple. There is a test pinning a live-shaped legacy record to its
  // literal digest so this can never drift silently.
  // ===================================================================
  const stamped = readStampedProtocol(record);
  if (!stamped) return sha256(JSON.stringify(payload));

  return sha256(JSON.stringify({
    ...payload,
    v: 3,
    transportProtocol: stamped.transportProtocol,
    decisionCutoverId: stamped.decisionCutoverId,
    producerAppGeneration: stamped.producerAppGeneration,
    producerSessionId: stamped.producerSessionId,
  }));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sameScalar(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') return false;
  const left = String(a).trim();
  const right = String(b).trim();
  return Boolean(left) && left === right;
}

/**
 * Build a proof record at a consumer boundary. Shared by EVERY runtime adapter
 * so the shape cannot drift between them.
 *
 * `deliveredPrompt` must be the exact text the consumer received — not what
 * the sender believes it wrote. That distinction is the entire defence against
 * the truncated-but-acked delivery.
 */
function buildAdmissionRecord(input = {}) {
  const deliveredPrompt = String(input.deliveredPrompt ?? '');
  return {
    schema: SCHEMA,
    proofClass: 'prompt_admitted',
    runtime: isNonEmptyString(input.runtime) ? input.runtime.trim().toLowerCase() : null,
    updateId: Number(input.updateId),
    messageId: input.messageId ?? null,
    routeKey: input.routeKey ?? null,
    windowKey: input.windowKey ?? null,
    profile: input.profile ?? null,
    chatId: input.chatId ?? null,
    appGeneration: input.appGeneration ?? null,
    consumerSessionId: input.consumerSessionId ?? null,
    consumerTurnId: input.consumerTurnId ?? null,
    paneId: input.paneId ?? null,
    queuedPayloadSha256: input.queuedPayloadSha256 ?? null,
    deliveredPromptSha256: sha256(deliveredPrompt),
    deliveredPromptBytes: byteLength(deliveredPrompt),
    consumedAtMs: Number.isFinite(Number(input.consumedAtMs)) ? Number(input.consumedAtMs) : null,
    // THE ATTEMPT, THE LAUNCH, THE ROLE, THE HOOK PROCESS AND THE TYPED
    // SUBMISSION — asserted BY the record, not merely stored beside it.
    claimId: input.claimId ?? null,
    attemptNonce: input.attemptNonce ?? null,
    paneLaunchId: input.paneLaunchId ?? null,
    role: input.role ?? null,
    hookProcessId: input.hookProcessId ?? null,
    hookParentProcessId: input.hookParentProcessId ?? null,
    runtimeSubmissionId: input.runtimeSubmissionId ?? null,
    runtimeSubmissionKind: input.runtimeSubmissionKind ?? null,
  };
}

/**
 * THE ONE VALIDATOR. Every automatic retirement routes through this.
 *
 * @param {object} input
 *   proof     candidate `telegram_consumed.v1` record
 *   expected  identity + digests the drain recorded when it delivered
 *   attempt   {atMs, generation} from the durable latch, or null
 * @returns {{proven: boolean, reason: string}}
 */
function validateAdmissionRecord(input = {}) {
  const { proof, expected, attempt } = input;

  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    return { proven: false, reason: 'no_proof' };
  }
  if (!expected || typeof expected !== 'object') {
    return { proven: false, reason: 'no_expected_identity' };
  }

  // POSITIVE CLASS FIRST. Checked before identity so a fabricated object is
  // rejected for what it IS, not for a field it happens to be missing.
  if (proof.schema !== SCHEMA) {
    return { proven: false, reason: `wrong_schema:${proof.schema || 'none'}` };
  }
  if (!isNonEmptyString(proof.proofClass) || !POSITIVE_PROOF_CLASSES.has(proof.proofClass)) {
    return { proven: false, reason: `not_a_positive_proof_class:${proof.proofClass || 'none'}` };
  }

  for (const field of REQUIRED_FIELDS) {
    const value = proof[field];
    if (value === null || value === undefined || String(value).trim() === '') {
      return { proven: false, reason: `proof_field_missing:${field}` };
    }
  }

  // IDENTITY. Every field, from the proof's own body.
  for (const field of ['updateId', 'messageId', 'routeKey', 'windowKey', 'profile', 'chatId']) {
    const want = expected[field];
    if (want === null || want === undefined || String(want).trim() === '') {
      return { proven: false, reason: `expected_identity_missing:${field}` };
    }
    if (!sameScalar(proof[field], want)) {
      return { proven: false, reason: `identity_mismatch:${field}` };
    }
  }

  // GENERATION, RUNTIME and CONSUMER SESSION.
  //
  // REQUIRING A FIELD TO BE PRESENT IS NOT REQUIRING IT TO BE CORRECT. The
  // first cut of this validator demanded `runtime` and `consumerSessionId`
  // exist and then never compared either, so a receipt from the wrong runtime
  // or a stale consumer session passed as long as everything else lined up.
  // That is the same shape as the earlier `{verified:true}` bug, one layer up.
  if (!sameScalar(proof.appGeneration, expected.appGeneration)) {
    return { proven: false, reason: 'generation_mismatch' };
  }
  if (!sameScalar(proof.runtime, expected.runtime)) {
    return { proven: false, reason: 'runtime_mismatch' };
  }
  if (!sameScalar(proof.consumerSessionId, expected.consumerSessionId)) {
    return { proven: false, reason: 'consumer_session_mismatch' };
  }
  // PANE BINDING. Codex sessions with the same CWD run in panes 1 and 3, so a
  // receipt that cannot name its pane cannot be attributed to this route.
  if (!sameScalar(proof.paneId, expected.paneId)) {
    return { proven: false, reason: 'pane_mismatch' };
  }

  // ===================================================================
  // THE REST OF THE TUPLE, COMPARED RATHER THAN MERELY REQUIRED.
  //
  // `claimId` and `attemptNonce` are what make this THE attempt rather than an
  // attempt: the producer used to bind a receipt to the newest live claim for
  // the source row, so after a retry the receipt attached to the wrong one and
  // passed every check. `paneLaunchId` and `role` come from the daemon-owned
  // launch, so a receipt written under a stale pane cannot borrow a live one.
  // The hook process identity and typed submission identity are the consumer's
  // own account of itself, and were previously unfalsifiable.
  // ===================================================================
  for (const field of [
    'claimId', 'attemptNonce', 'paneLaunchId', 'role',
    'hookProcessId', 'hookParentProcessId',
    'runtimeSubmissionId', 'runtimeSubmissionKind',
  ]) {
    const want = expected[field];
    if (want === null || want === undefined || String(want).trim() === '') {
      return { proven: false, reason: `expected_identity_missing:${field}` };
    }
    if (!sameScalar(proof[field], want)) {
      return { proven: false, reason: `identity_mismatch:${field}` };
    }
  }

  // PAYLOAD IDENTITY. Same id with a changed body must not match.
  if (!SHA256_RE.test(String(proof.queuedPayloadSha256))) {
    return { proven: false, reason: 'queued_digest_malformed' };
  }
  if (!sameScalar(proof.queuedPayloadSha256, expected.queuedPayloadSha256)) {
    return { proven: false, reason: 'queued_payload_digest_mismatch' };
  }

  // PAYLOAD INTEGRITY — the truncated-but-acked defence.
  if (!SHA256_RE.test(String(proof.deliveredPromptSha256))) {
    return { proven: false, reason: 'delivered_digest_malformed' };
  }
  if (!sameScalar(proof.deliveredPromptSha256, expected.deliveredPromptSha256)) {
    // The consumer hashed something other than what we sent. 2283 bytes out,
    // 125 characters in, ack fired anyway — this is where that dies.
    return { proven: false, reason: 'delivered_payload_digest_mismatch' };
  }
  // Byte length is checked TOO, though a digest match implies it. A digest
  // comparison that is ever loosened must not silently take the length with it.
  if (Number(proof.deliveredPromptBytes) !== Number(expected.deliveredPromptBytes)) {
    return { proven: false, reason: 'delivered_payload_length_mismatch' };
  }

  // ORDERING. Proof must postdate the attempt it claims to resolve.
  const consumedAtMs = Number(proof.consumedAtMs);
  if (!Number.isFinite(consumedAtMs) || consumedAtMs <= 0) {
    return { proven: false, reason: 'proof_time_unknown' };
  }
  if (attempt) {
    const attemptedAtMs = Number(attempt.atMs);
    if (!Number.isFinite(attemptedAtMs) || attemptedAtMs <= 0) {
      return { proven: false, reason: 'attempt_time_unknown' };
    }
    if (consumedAtMs < attemptedAtMs) {
      return { proven: false, reason: 'proof_predates_attempt' };
    }
    // ATTEMPT-GENERATION EQUALITY (gate probe 2). Matching the CURRENT app
    // generation is not enough: the attempt this record claims to resolve was
    // made by some generation too, and if that is not the same one then the
    // record answers a delivery nobody is waiting on. An attempt with no
    // recorded generation cannot be reconciled at all, so it fails closed
    // exactly like an undated one.
    if (!isNonEmptyString(attempt.generation)) {
      return { proven: false, reason: 'attempt_generation_unknown' };
    }
    if (!sameScalar(proof.appGeneration, attempt.generation)) {
      return { proven: false, reason: 'attempt_generation_mismatch' };
    }
  }

  // ADMITTED, not consumed. This record may not retire anything on its own.
  return { proven: true, reason: 'admission_proven' };
}

/* =====================================================================
 * PHASE 2. THE TERMINAL RECORD — the only thing that may retire a record.
 *
 * `TERMINAL_SCHEMA` has existed as a NAME since the admission checkpoint, with
 * nothing behind it: no builder, no validator, no table, no lookup. A constant
 * declaring that some other record will one day authorise retirement is not a
 * two-phase design, it is a one-phase design with a promise attached — and the
 * promise reads, to anything downstream, exactly like the thing itself.
 *
 * WHAT MAKES A RECORD TERMINAL. Admission fires at `UserPromptSubmit`, which
 * Codex runs BEFORE `record_pending_input` and which also fires on TurnAborted.
 * So admission answers "the exact bytes reached the consumer boundary" and
 * nothing more. Terminal fires when that same bound submission REACHES ITS END:
 * the turn that received those bytes ran and stopped. The two are separated by
 * the case that matters — a turn that admits "Example customer approved job,
 * change job to invoice" and then aborts produces an admission and must produce
 * no terminal record at all.
 *
 * WHY IT IS BUILT FROM THE ADMISSION RECORD RATHER THAN FROM CALLER INPUT.
 * Every identity field here already exists, verbatim, in a stored, immutable,
 * trigger-protected admission row. Re-accepting those fields from a caller
 * would create a second account of the same delivery that could disagree with
 * the first, and the validator would then be checking the newer, weaker one
 * with complete rigour. The terminal record COPIES; it does not re-assert.
 * ===================================================================== */

/** The only positive terminal class. Admission's class is deliberately absent. */
const TERMINAL_PROOF_CLASSES = Object.freeze(new Set(['prompt_consumed']));

/**
 * How the consumer's turn ended. Only a real, observed end-of-turn event may
 * appear here, and the set is closed: an unrecognised event name is refused
 * rather than treated as a generic "something happened".
 *
 * `turn_completed` is the runtime's own end-of-turn hook (Codex `Stop`,
 * Claude `Stop`). There is deliberately NO entry for "the model produced
 * output", "the pane looked idle", or any inference — each of those is the
 * shape that certified 2417 bytes for a 125-character tail.
 */
const TERMINAL_EVENTS = Object.freeze(new Set(['turn_completed']));

/**
 * Everything a terminal record must carry. It is the admission tuple PLUS the
 * three fields that make it terminal, because a validator that had to join to
 * another table to learn the identity of the thing in front of it is a
 * validator that can be fed a row whose join has since been rewritten.
 */
const TERMINAL_REQUIRED_FIELDS = Object.freeze([
  ...REQUIRED_FIELDS,
  // WHICH ADMISSION THIS TERMINATES. Without it a terminal record floats free
  // of the exact bytes that were admitted, and "the turn ended" stops being a
  // statement about this delivery.
  'admissionId',
  'terminalEvent',
  'terminalAtMs',
]);

/**
 * Build the terminal record for an admission that has now reached end-of-turn.
 *
 * @param {object} input
 *   admissionRecord  the VERBATIM stored admission record (parsed record_json)
 *   admissionId      its derived primary key
 *   terminalEvent    a member of TERMINAL_EVENTS
 *   terminalAtMs     when the turn ended
 * @returns {{ok: true, record: object} | {ok: false, reason: string}}
 */
function buildConsumedRecord(input = {}) {
  const admission = input.admissionRecord;
  if (!admission || typeof admission !== 'object' || Array.isArray(admission)) {
    return { ok: false, reason: 'no_admission_record' };
  }
  if (admission.schema !== SCHEMA) {
    return { ok: false, reason: `admission_wrong_schema:${admission.schema || 'none'}` };
  }
  if (!POSITIVE_PROOF_CLASSES.has(admission.proofClass)) {
    return { ok: false, reason: `admission_not_positive_class:${admission.proofClass || 'none'}` };
  }
  if (!isNonEmptyString(input.admissionId)) {
    return { ok: false, reason: 'no_admission_id' };
  }
  const terminalEvent = isNonEmptyString(input.terminalEvent) ? input.terminalEvent.trim() : null;
  if (!terminalEvent || !TERMINAL_EVENTS.has(terminalEvent)) {
    return { ok: false, reason: `terminal_event_unrecognised:${terminalEvent || 'none'}` };
  }
  const terminalAtMs = Number(input.terminalAtMs);
  if (!Number.isSafeInteger(terminalAtMs) || terminalAtMs <= 0) {
    return { ok: false, reason: 'terminal_time_unknown' };
  }
  // A TURN CANNOT END BEFORE IT WAS ADMITTED. A clock that says otherwise is
  // describing two different deliveries, so refuse rather than record it.
  const admittedAtMs = Number(admission.consumedAtMs);
  if (!Number.isSafeInteger(admittedAtMs) || admittedAtMs <= 0) {
    return { ok: false, reason: 'admission_time_unknown' };
  }
  if (terminalAtMs < admittedAtMs) {
    return { ok: false, reason: 'terminal_predates_admission' };
  }

  // Field-by-field COPY from the admission record. A spread would silently
  // carry any future admission field into a schema that never declared it.
  const record = { schema: TERMINAL_SCHEMA, proofClass: 'prompt_consumed' };
  for (const field of REQUIRED_FIELDS) {
    if (field === 'schema' || field === 'proofClass') continue;
    record[field] = admission[field];
  }
  record.consumerTurnId = admission.consumerTurnId ?? null;
  record.admissionId = String(input.admissionId);
  record.terminalEvent = terminalEvent;
  record.terminalAtMs = terminalAtMs;
  return { ok: true, record };
}

/**
 * IS THIS A WELL-FORMED TERMINAL RECORD AT ALL — asked WITHOUT an expectation.
 *
 * The lookup layer needs this and must not have the other one. Handing a
 * partial `expected` to `validateConsumedRecord` would make it report
 * `expected_identity_missing:claimId` for a perfectly good record, and the
 * obvious "fix" is for the lookup to fill the gaps from what it was asked
 * about — which is identity synthesis, arriving by the back door, in the exact
 * function whose whole purpose is to stop it.
 *
 * So the split is: this answers "is this a terminal record", and the caller's
 * own proof gate answers "is it about the message I asked for". Neither ever
 * writes a field it then reads back as evidence.
 */
function validateConsumedRecordShape(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'no_proof' };
  }
  if (record.schema === SCHEMA) return { ok: false, reason: 'admission_is_not_terminal_proof' };
  if (record.schema !== TERMINAL_SCHEMA) {
    return { ok: false, reason: `wrong_schema:${record.schema || 'none'}` };
  }
  if (!isNonEmptyString(record.proofClass) || !TERMINAL_PROOF_CLASSES.has(record.proofClass)) {
    return { ok: false, reason: `not_a_terminal_proof_class:${record.proofClass || 'none'}` };
  }
  for (const field of TERMINAL_REQUIRED_FIELDS) {
    const value = record[field];
    if (value === null || value === undefined || String(value).trim() === '') {
      return { ok: false, reason: `proof_field_missing:${field}` };
    }
  }
  if (!TERMINAL_EVENTS.has(String(record.terminalEvent))) {
    return { ok: false, reason: `terminal_event_unrecognised:${record.terminalEvent}` };
  }
  const terminalAtMs = Number(record.terminalAtMs);
  const consumedAtMs = Number(record.consumedAtMs);
  if (!Number.isFinite(terminalAtMs) || terminalAtMs <= 0) {
    return { ok: false, reason: 'terminal_time_unknown' };
  }
  if (!Number.isFinite(consumedAtMs) || consumedAtMs <= 0) {
    return { ok: false, reason: 'proof_time_unknown' };
  }
  if (terminalAtMs < consumedAtMs) return { ok: false, reason: 'terminal_predates_admission' };
  return { ok: true };
}

/**
 * THE ONE TERMINAL VALIDATOR. Only a record this function proves may retire a
 * Telegram ingress record on the automatic path.
 *
 * Reuses the admission validator for the whole shared tuple rather than
 * restating it: two copies of an identity comparison drift, and the half that
 * drifts looser is the one that ends up in front of Operator.
 *
 * @param {object} input
 *   proof     candidate `telegram_consumed.v1` record
 *   expected  identity the drain recorded when it delivered
 *   attempt   {atMs, generation} from the durable latch, or null
 */
function validateConsumedRecord(input = {}) {
  const { proof, expected, attempt } = input;

  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    return { proven: false, reason: 'no_proof' };
  }
  if (!expected || typeof expected !== 'object') {
    return { proven: false, reason: 'no_expected_identity' };
  }
  // CLASS FIRST, and it must be the TERMINAL class. An admission record
  // reaching this function is the exact confusion the two-phase split exists to
  // prevent, so it is named as such rather than failing on a missing field.
  if (proof.schema === SCHEMA) {
    return { proven: false, reason: 'admission_is_not_terminal_proof' };
  }
  if (proof.schema !== TERMINAL_SCHEMA) {
    return { proven: false, reason: `wrong_schema:${proof.schema || 'none'}` };
  }
  if (!isNonEmptyString(proof.proofClass) || !TERMINAL_PROOF_CLASSES.has(proof.proofClass)) {
    return { proven: false, reason: `not_a_terminal_proof_class:${proof.proofClass || 'none'}` };
  }
  for (const field of TERMINAL_REQUIRED_FIELDS) {
    const value = proof[field];
    if (value === null || value === undefined || String(value).trim() === '') {
      return { proven: false, reason: `proof_field_missing:${field}` };
    }
  }
  if (!TERMINAL_EVENTS.has(String(proof.terminalEvent))) {
    return { proven: false, reason: `terminal_event_unrecognised:${proof.terminalEvent}` };
  }

  // THE SHARED TUPLE, judged by the shared validator. It is handed a copy
  // wearing the admission schema/class precisely so that the identity, digest
  // and attempt-generation comparisons run byte-identically for both phases.
  const asAdmission = { ...proof, schema: SCHEMA, proofClass: 'prompt_admitted' };
  const shared = validateAdmissionRecord({ proof: asAdmission, expected, attempt });
  if (!shared.proven) return shared;

  // TERMINAL ORDERING. Admission time was already ordered against the attempt
  // by the shared pass; the turn's end must in turn postdate its own admission.
  const terminalAtMs = Number(proof.terminalAtMs);
  if (!Number.isFinite(terminalAtMs) || terminalAtMs <= 0) {
    return { proven: false, reason: 'terminal_time_unknown' };
  }
  if (terminalAtMs < Number(proof.consumedAtMs)) {
    return { proven: false, reason: 'terminal_predates_admission' };
  }

  // THE ADMISSION IT TERMINATES, when the caller knows which one to expect.
  // Absence of an expectation is not licence to skip the field — it is required
  // above — it only means nobody has an independent value to compare against.
  if (expected.admissionId !== undefined && expected.admissionId !== null
    && String(expected.admissionId).trim() !== ''
    && !sameScalar(proof.admissionId, expected.admissionId)) {
    return { proven: false, reason: 'admission_id_mismatch' };
  }

  return { proven: true, reason: 'terminal_consumption_proven' };
}

module.exports = {
  SCHEMA,
  ADMISSION_SCHEMA: SCHEMA,
  TERMINAL_SCHEMA,
  POSITIVE_PROOF_CLASSES,
  TERMINAL_PROOF_CLASSES,
  TERMINAL_EVENTS,
  PRODUCER_STATES,
  REQUIRED_FIELDS,
  TERMINAL_REQUIRED_FIELDS,
  sha256,
  byteLength,
  canonicalQueuedPayloadDigest,
  buildAdmissionRecord,
  validateAdmissionRecord,
  buildConsumedRecord,
  validateConsumedRecord,
  validateConsumedRecordShape,
};
