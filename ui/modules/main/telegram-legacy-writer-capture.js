'use strict';

/**
 * THE IMMUTABLE ORIGINAL-WRITER CAPTURE — SCHEMA, READER, VALIDATORS
 * (v7 §4, Architect #178 §1 / #182 / #192 / #198, Oracle #105 / #107 / #116).
 *
 * =====================================================================
 * WHAT THIS MODULE IS, AND WHAT IT DELIBERATELY IS NOT
 * =====================================================================
 * It is the definition of one immutable singleton row, a reader that proves that
 * row's internal agreement three ways, and the pure validators around it.
 *
 * IT CANNOT WRITE. There is no insert, no issuer, no row builder, no material
 * builder, no retirement prover and no brand — not private, not exported, not
 * anywhere. A caller holding this module's entire surface cannot originate a
 * capture, cannot amend one, and cannot produce anything the fence will accept
 * as evidence. That is a property of the file, checkable by reading it, rather
 * than a promise made by a comment.
 *
 * =====================================================================
 * THE HOLE THIS ROW CLOSES
 * =====================================================================
 * The first fence draft proved the legacy writer was retired like this: a caller
 * handed in a generation, a session, a PID, a creation date, an executable path
 * and a command-line digest; production probed that PID; if nothing answered,
 * the original writer was declared retired and the fence was minted.
 *
 * Every field in that sentence came from the caller. An invented PID that
 * happens to be dead — which is most numbers — plus five invented strings
 * produced an authoritative retirement. The module computed a digest over the
 * assertion and the digest made it look like evidence. It was not evidence; it
 * was arithmetic performed on a claim.
 *
 * =====================================================================
 * THE FIX IS AN ORDERING, NOT A STRONGER CHECK
 * =====================================================================
 * There is no check a successor can run that turns a claim about a dead process
 * into knowledge of it. The dead process cannot be interrogated — that is what
 * dead means. So the evidence has to be written down BY THAT PROCESS, WHILE IT
 * IS ALIVE, and the successor's only job is to read it and confirm the author is
 * now definitively gone:
 *
 *   P    the exact legacy-writer-capable owner, live, issues its own capture
 *        from its own process identity and its own release. Nothing is passed
 *        in. It writes one immutable singleton row.
 *   G    a successor reads that exact row, probes that exact PID, requires a
 *        DEFINITIVELY ABSENT answer, and only then creates the fence.
 *   G+1  a later generation reads the same row and the same fence and derives
 *        identical ids. It may not remint either.
 *
 * `G` lives in `telegram-legacy-cutover-fence.js`, where the retirement prover is
 * module-private alongside the material and establishment brands it feeds — two
 * brands in two closures can only be joined by an exported minter in the middle,
 * which is the seam that had to close (Architect #192).
 *
 * =====================================================================
 * `P` DOES NOT EXIST YET, AND THERE IS NO CODE HERE PRETENDING OTHERWISE
 * =====================================================================
 * An earlier draft of `P` issued from a static positive reference capture plus a
 * durable database handle. That is not sufficient and the shortfall is exact:
 * an outside-owner REFERENCE to the legacy writer existing in a release is not
 * the same fact as EXECUTING AS THE EXACT CANONICAL LEGACY APPEND OWNER, and only
 * the second can honestly originate the predecessor row. Promoting the first
 * would put a weaker measurement into a permanent artifact that later
 * generations read as the stronger one.
 *
 * That draft is DELETED rather than parked (Architect #198). A known-invalid
 * write path kept private "for later" is dead code that still reads as a
 * finished design, and the next author would have wired it up. The contract a
 * real `P` must satisfy — issuance inside the actual production legacy-append
 * owner binding, or an unforgeable token minted only by that binding, touching no
 * protected queue state — is recorded in the Step 3 checkpoints and in the
 * capture-only activation bridge ruling v3, which is where a design belongs.
 *
 * The practical consequence is honest and unpleasant: on a machine with no
 * existing capture, no fence can be created at all. That blocked rollout is the
 * correct current answer (Oracle #105). The alternative is a build that invents
 * its own predecessor.
 *
 * =====================================================================
 * WHAT THE SINGLETON AND THE DERIVED ID DO *NOT* BUY (Architect #182 §4)
 * =====================================================================
 * Immutability, the singleton slot and the content-derived id give correctness
 * and fail-closed authority: no accidental replacement, no self-inconsistent
 * row, no second capture racing the first, no field edited after the fact. They
 * are NOT a trust root against an actor who can already write this database or
 * change this code. Anyone able to run the derivation can produce a well-formed
 * row, and no digest anywhere can distinguish that from the real thing — that is
 * what deriving from content means, not a gap in this implementation. A
 * structurally valid caller-preloaded row is not proof of owner issuance, and
 * nothing below should be read as claiming otherwise.
 */

const {
  DECISION_CUTOVER_ID,
} = require('./telegram-source-protocol');
const { canonicalJson, sha256 } = require('./canonical-json');
const { PROCESS_IDENTITY_SCHEMA } = require('./windows-process-identity');
const {
  WRITER_CAPABILITY_SCHEMA,
  WRITER_CAPABILITY_SCANNER_VERSION,
} = require('./telegram-loaded-release');

const CAPTURE_VERSION = 'legacy_writer_capture_v1';
const CAPTURE_ID_PREFIX = 'owc1_';
const CAPTURE_MATERIAL_SCHEMA = 'squidrun.telegram_legacy_writer_capture.material.v1';
const RETIREMENT_OBSERVATION_SCHEMA = 'squidrun.telegram_legacy_writer_capture.retirement.v1';
const CAPTURE_ID_RE = /^owc1_[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** The schema objects a capture write or read depends on. */
const CAPTURE_SCHEMA_OBJECTS = Object.freeze([
  'telegram_legacy_writer_captures',
  'trg_tg_writer_capture_immutable',
  'trg_tg_writer_capture_no_delete',
]);

/**
 * THE VOCABULARY IS THE READER'S AND THE SUCCESSOR'S, AND NOTHING ELSE'S.
 *
 * The issuance refusals (`..._release_not_legacy_writer_capable`,
 * `..._capability_not_production_issued`, `..._self_identity_*`,
 * `..._row_conflict`, `..._row_mismatch`, `..._insert_failed`) went with the
 * write path they belonged to. A reason string for an operation this build
 * cannot perform is a name for a branch nothing can reach, and it reads to the
 * next author like a feature that exists.
 */
const CAPTURE_REASONS = Object.freeze({
  GENERATION_UNPUBLISHED: 'writer_capture_generation_unpublished',
  SESSION_UNPUBLISHED: 'writer_capture_session_unpublished',
  SCHEMA_UNVERIFIED: 'writer_capture_schema_unverified',
  STORE_UNAVAILABLE: 'writer_capture_store_unavailable',
  ROW_COUNT_INVALID: 'writer_capture_row_count_invalid',
  ROW_INCOHERENT: 'writer_capture_row_incoherent',
  MATERIAL_SHAPE: 'writer_capture_material_shape_invalid',
  MATERIAL_VERSION: 'writer_capture_material_version_unrecognized',
  MATERIAL_CUTOVER_WRONG: 'writer_capture_material_cutover_unrecognized',
  MATERIAL_IDENTITY_SCHEMA: 'writer_capture_material_identity_schema_unrecognized',
  MATERIAL_CAPABILITY_SCHEMA: 'writer_capture_material_capability_schema_unrecognized',
  MATERIAL_NO_EVIDENCE: 'writer_capture_material_capability_evidence_missing',
  // Successor-side refusals.
  CAPTURE_ABSENT: 'writer_capture_absent',
  SUCCESSOR_CAPTURE_MISSING: 'writer_capture_successor_release_capture_missing',
  NAMES_CURRENT_PROCESS: 'writer_capture_names_current_process',
  NAMES_CURRENT_GENERATION: 'writer_capture_names_current_generation',
  NAMES_CURRENT_SESSION: 'writer_capture_names_current_session',
  NAMES_CURRENT_RELEASE: 'writer_capture_names_current_release',
  OWNER_LIVE: 'writer_capture_owner_live',
  OWNER_IDENTITY_MISMATCH: 'writer_capture_owner_identity_mismatch',
  OWNER_UNVERIFIABLE: 'writer_capture_owner_unverifiable',
});

function fail(reason, detail = null) {
  return detail === null ? { ok: false, reason } : { ok: false, reason, detail };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function keysExactly(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

const MATERIAL_KEYS = Object.freeze(['capability', 'captureVersion', 'decisionCutoverId', 'schema', 'writer']);
const WRITER_KEYS = Object.freeze([
  'appGeneration', 'commandLineSha256', 'executablePath', 'identitySchema',
  'pid', 'processCreatedAt', 'sessionId',
]);
const CAPABILITY_KEYS = Object.freeze(['fingerprint', 'manifestSha256', 'scanner', 'schema']);

/** The exact shape of the stored capability evidence blob, as this build reads it. */
const EVIDENCE_KEYS = Object.freeze([
  'anchors', 'capability', 'fileCount', 'manifestSha256', 'scanner', 'schema', 'totalBytes',
]);
const EVIDENCE_CAPABILITY_KEYS = Object.freeze([
  'outsideOwnerReferences', 'owner', 'ownerDefinition', 'ownerExport', 'symbol',
]);


/** `owc1_` + the SHA-256 of the canonical bytes. Lowercase hex, exactly. */
function deriveCaptureId(material) {
  return `${CAPTURE_ID_PREFIX}${sha256(canonicalJson(material))}`;
}

/**
 * SEMANTIC validation against THIS BUILD'S constants, never the blob's own.
 *
 * Same rule as the fence (Architect #178 §4): self-consistency proves the row
 * was not corrupted; this proves it is ours. A capture carrying a capability
 * schema or scanner version from a protocol nobody reviewed describes a
 * measurement this build cannot interpret, and interpreting it anyway is how a
 * weaker historical claim gets read as a stronger current one.
 */
function validateCaptureMaterialSemantics(material) {
  if (!keysExactly(material, MATERIAL_KEYS)) {
    return fail(CAPTURE_REASONS.MATERIAL_SHAPE, {
      keys: material && typeof material === 'object' ? Object.keys(material).sort() : null,
    });
  }
  if (material.schema !== CAPTURE_MATERIAL_SCHEMA) {
    return fail(CAPTURE_REASONS.MATERIAL_VERSION, { schema: material.schema });
  }
  if (material.captureVersion !== CAPTURE_VERSION) {
    return fail(CAPTURE_REASONS.MATERIAL_VERSION, { captureVersion: material.captureVersion });
  }
  if (material.decisionCutoverId !== DECISION_CUTOVER_ID) {
    return fail(CAPTURE_REASONS.MATERIAL_CUTOVER_WRONG, { decisionCutoverId: material.decisionCutoverId });
  }

  const writer = material.writer;
  if (!keysExactly(writer, WRITER_KEYS)) {
    return fail(CAPTURE_REASONS.MATERIAL_SHAPE, { field: 'writer' });
  }
  if (writer.identitySchema !== PROCESS_IDENTITY_SCHEMA) {
    return fail(CAPTURE_REASONS.MATERIAL_IDENTITY_SCHEMA, { identitySchema: writer.identitySchema });
  }
  if (!isPositiveInteger(writer.pid)) {
    return fail(CAPTURE_REASONS.MATERIAL_SHAPE, { field: 'writer.pid' });
  }
  if (!SHA256_RE.test(writer.commandLineSha256)) {
    return fail(CAPTURE_REASONS.MATERIAL_SHAPE, { field: 'writer.commandLineSha256' });
  }
  for (const field of ['appGeneration', 'sessionId', 'processCreatedAt', 'executablePath']) {
    if (!isNonEmptyString(writer[field])) {
      return fail(CAPTURE_REASONS.MATERIAL_SHAPE, { field: `writer.${field}` });
    }
  }

  const capability = material.capability;
  if (!keysExactly(capability, CAPABILITY_KEYS)) {
    return fail(CAPTURE_REASONS.MATERIAL_SHAPE, { field: 'capability' });
  }
  // THE POSITIVE CLAIM IS VERSIONED, and this build only understands one
  // version of it. Not "any capability schema": a future stronger call-graph
  // verifier is a DIFFERENT measurement, and reading its rows through this
  // reader — or these rows through its — would silently mix two claims that
  // mean different things (Oracle #107).
  if (capability.schema !== WRITER_CAPABILITY_SCHEMA) {
    return fail(CAPTURE_REASONS.MATERIAL_CAPABILITY_SCHEMA, { schema: capability.schema });
  }
  if (capability.scanner !== WRITER_CAPABILITY_SCANNER_VERSION) {
    return fail(CAPTURE_REASONS.MATERIAL_CAPABILITY_SCHEMA, { scanner: capability.scanner });
  }
  if (!SHA256_RE.test(capability.fingerprint) || !SHA256_RE.test(capability.manifestSha256)) {
    return fail(CAPTURE_REASONS.MATERIAL_SHAPE, { field: 'capability.digests' });
  }
  return { ok: true };
}

// =====================================================================
// THE DURABLE ROW
// =====================================================================

const CAPTURE_COLUMNS = Object.freeze([
  'capture_id', 'capture_slot', 'capture_version', 'decision_cutover_id',
  'identity_schema', 'writer_app_generation', 'writer_session_id', 'writer_pid',
  'writer_process_created_at', 'writer_executable_path', 'writer_command_line_sha256',
  'capability_schema', 'capability_scanner', 'capability_manifest_sha256',
  'capability_fingerprint', 'capability_reference_count', 'capability_evidence_json',
  'canonical_material_json', 'created_at_ms',
]);

/** Total reference LINES across every outside-owner file in the evidence. */
function countReferenceLines(evidence) {
  return evidence.capability.outsideOwnerReferences
    .reduce((total, entry) => total + entry.references.length, 0);
}

/**
 * EXACT semantic validation of the stored capability evidence (Architect #187
 * §5), against this build's constants and this build's shape rules.
 *
 * Deriving the fingerprint from the blob proves the blob is the one that was
 * measured; it does not prove this build can INTERPRET what was measured. A blob
 * whose reference entries are strings instead of `{path, references[]}`, or
 * whose anchors are missing, hashes perfectly well and means nothing here.
 */
function validateCapabilityEvidence(evidence) {
  const shape = (reason) => fail(CAPTURE_REASONS.ROW_INCOHERENT, { reason });
  if (!keysExactly(evidence, EVIDENCE_KEYS)) return shape('capability_evidence_keys');
  if (evidence.schema !== WRITER_CAPABILITY_SCHEMA) return shape('capability_evidence_schema');
  if (evidence.scanner !== WRITER_CAPABILITY_SCANNER_VERSION) return shape('capability_evidence_scanner');
  if (!SHA256_RE.test(evidence.manifestSha256)) return shape('capability_evidence_manifest_digest');
  if (!isPositiveInteger(evidence.fileCount) || !isPositiveInteger(evidence.totalBytes)) {
    return shape('capability_evidence_counts');
  }
  if (!Array.isArray(evidence.anchors) || evidence.anchors.length === 0) {
    return shape('capability_evidence_anchors');
  }
  for (const anchor of evidence.anchors) {
    if (!keysExactly(anchor, ['path', 'sha256'])) return shape('capability_evidence_anchor_shape');
    if (!isNonEmptyString(anchor.path) || !SHA256_RE.test(anchor.sha256)) {
      return shape('capability_evidence_anchor_fields');
    }
  }

  const capability = evidence.capability;
  if (!keysExactly(capability, EVIDENCE_CAPABILITY_KEYS)) return shape('capability_evidence_body_keys');
  for (const field of ['symbol', 'owner', 'ownerDefinition', 'ownerExport']) {
    if (!isNonEmptyString(capability[field])) return shape(`capability_evidence_${field}`);
  }
  const references = capability.outsideOwnerReferences;
  if (!Array.isArray(references) || references.length === 0) {
    return fail(CAPTURE_REASONS.MATERIAL_NO_EVIDENCE);
  }
  let previousPath = null;
  for (const entry of references) {
    if (!keysExactly(entry, ['path', 'references'])) return shape('capability_evidence_reference_shape');
    if (!isNonEmptyString(entry.path)) return shape('capability_evidence_reference_path');
    // SORTED, AND CHECKED AS SORTED. The producer sorts so the digest is stable;
    // an unsorted stored blob is one that did not come from that producer.
    if (previousPath !== null && !(previousPath < entry.path)) {
      return shape('capability_evidence_references_unsorted');
    }
    previousPath = entry.path;
    if (!Array.isArray(entry.references) || entry.references.length === 0) {
      return shape('capability_evidence_reference_lines');
    }
    if (!entry.references.every((line) => isNonEmptyString(line))) {
      return shape('capability_evidence_reference_line_shape');
    }
    // THE OWNER IS NOT AN OUTSIDE-OWNER REFERENCE. Its definition and export are
    // the permitted two lines; listing it here would make every release look
    // legacy-capable, including the repaired one.
    if (entry.path === capability.owner) return shape('capability_evidence_owner_listed_as_outside');
  }
  return { ok: true };
}


/** Rebuild the canonical material FROM THE STORED COLUMNS, never from the blob. */
function captureMaterialFromRow(row) {
  return {
    // FROM THIS BUILD'S CONSTANT, never from the stored blob. If the row was
    // written under a different material schema the rebuild will not equal
    // `canonical_material_json`, which is the check doing the work.
    schema: CAPTURE_MATERIAL_SCHEMA,
    captureVersion: row.capture_version,
    decisionCutoverId: row.decision_cutover_id,
    writer: {
      identitySchema: row.identity_schema,
      appGeneration: row.writer_app_generation,
      sessionId: row.writer_session_id,
      pid: row.writer_pid,
      processCreatedAt: row.writer_process_created_at,
      executablePath: row.writer_executable_path,
      commandLineSha256: row.writer_command_line_sha256,
    },
    capability: {
      schema: row.capability_schema,
      scanner: row.capability_scanner,
      manifestSha256: row.capability_manifest_sha256,
      fingerprint: row.capability_fingerprint,
    },
  };
}

/**
 * The stored capture, with its internal agreement checked three ways.
 *
 * Columns re-serialised independently must equal the stored blob, and the id
 * must derive from that material. A row with one edited field breaks at least
 * two of the three.
 */
function readStoredWriterCapture(db) {
  let rows;
  try {
    rows = db.prepare(`SELECT ${CAPTURE_COLUMNS.join(', ')} FROM telegram_legacy_writer_captures`).all();
  } catch (error) {
    return fail(CAPTURE_REASONS.STORE_UNAVAILABLE, { message: error?.message || String(error) });
  }
  if (rows.length === 0) return { ok: true, row: null, material: null };
  if (rows.length > 1) return fail(CAPTURE_REASONS.ROW_COUNT_INVALID, { rows: rows.length });

  const [row] = rows;
  if (!CAPTURE_ID_RE.test(String(row.capture_id))) {
    return fail(CAPTURE_REASONS.ROW_INCOHERENT, { reason: 'stored_id_is_not_an_owc1_id' });
  }
  if (row.capture_slot !== 1) {
    return fail(CAPTURE_REASONS.ROW_INCOHERENT, { reason: 'stored_row_is_not_the_singleton_slot' });
  }

  let material;
  try {
    material = captureMaterialFromRow(row);
  } catch (error) {
    return fail(CAPTURE_REASONS.ROW_INCOHERENT, { message: error?.message || String(error) });
  }
  const semantics = validateCaptureMaterialSemantics(material);
  if (!semantics.ok) return { ...semantics, storedCaptureId: row.capture_id };

  if (!isPositiveInteger(row.created_at_ms)) {
    return fail(CAPTURE_REASONS.ROW_INCOHERENT, { reason: 'invalid_created_at_ms' });
  }
  // THE EVIDENCE MUST DERIVE THE FINGERPRINT THE MATERIAL CARRIES.
  //
  // This is the check that makes the stored evidence load-bearing rather than
  // decorative. The capture id derives from the material, and the material
  // carries only the capability FINGERPRINT — so without this, the evidence blob
  // beside it could describe any release at all and every other check would
  // still pass. The stored blob is therefore the COMPLETE capability material,
  // not a readable summary of it, precisely so that hashing it is a real
  // comparison against an independently stored value instead of a tautology.
  let evidence;
  try {
    evidence = JSON.parse(String(row.capability_evidence_json));
  } catch {
    return fail(CAPTURE_REASONS.ROW_INCOHERENT, { reason: 'capability_evidence_unparseable' });
  }
  if (sha256(canonicalJson(evidence)) !== row.capability_fingerprint) {
    return fail(CAPTURE_REASONS.ROW_INCOHERENT, { reason: 'capability_evidence_does_not_derive_fingerprint' });
  }
  // EXACT SHAPE AND SEMANTICS, not merely "it hashes". A blob can be exactly the
  // one that was measured and still be a measurement this build cannot read.
  // The eligibility rule — at least one outside-owner reference — is re-checked
  // here on every read rather than trusted from write time.
  const evidenceValid = validateCapabilityEvidence(evidence);
  if (!evidenceValid.ok) return evidenceValid;
  if (countReferenceLines(evidence) !== row.capability_reference_count) {
    return fail(CAPTURE_REASONS.ROW_INCOHERENT, { reason: 'capability_reference_count_disagrees' });
  }
  if (evidence.schema !== row.capability_schema || evidence.scanner !== row.capability_scanner
    || evidence.manifestSha256 !== row.capability_manifest_sha256) {
    return fail(CAPTURE_REASONS.ROW_INCOHERENT, { reason: 'capability_evidence_disagrees_with_columns' });
  }

  const canonical = canonicalJson(material);
  if (canonical !== row.canonical_material_json) {
    return fail(CAPTURE_REASONS.ROW_INCOHERENT, { reason: 'columns_disagree_with_stored_material' });
  }
  if (deriveCaptureId(material) !== row.capture_id) {
    return fail(CAPTURE_REASONS.ROW_INCOHERENT, { reason: 'stored_material_does_not_derive_stored_id' });
  }
  return { ok: true, row, material, evidence, canonical };
}

// =====================================================================
// ISSUANCE — P ONLY, AND ONLY WHILE P IS ALIVE
// =====================================================================


/**
 * THE SUCCESSOR SIDE LIVES IN THE FENCE MODULE NOW (Architect #192).
 *
 * `proveStoredWriterRetired` used to sit here and be exported. It could not stay
 * both exported and honest: the retirement result is a BRAND, the fence material
 * that consumes it is minted by a different private WeakSet, and two brands in
 * two module closures cannot be linked without an exported minter in the middle
 * — which is precisely the injection seam the whole pass exists to close.
 *
 * So the retirement prover moved into the one closure that also owns the journal,
 * material and establishment brands, and it is private there. This module keeps
 * what a successor legitimately needs and nothing that writes: the immutable
 * row reader, the schema object list, the reason vocabulary and the pure
 * calculations. Read-only by construction, not by convention (ruling v1: G has
 * read-only access to the capture and no issuance or backfill path).
 */

module.exports = Object.freeze({
  CAPTURE_VERSION,
  CAPTURE_ID_PREFIX,
  CAPTURE_MATERIAL_SCHEMA,
  RETIREMENT_OBSERVATION_SCHEMA,
  CAPTURE_SCHEMA_OBJECTS,
  CAPTURE_COLUMNS,
  CAPTURE_REASONS,
  MATERIAL_KEYS,
  // READ AND CALCULATE. NOTHING HERE WRITES, ISSUES OR MINTS.
  //
  // No insert, no issuer, no retirement prover, no brand. A caller holding this
  // module's whole surface cannot reach the authoritative row with material it
  // assembled itself (Oracle #107), cannot originate a capture, and cannot
  // produce anything the fence will accept as evidence. The row builder, the
  // material builder and the issuer came off this list together with the write
  // path they served: assembly beside an immutable table is an invitation, and a
  // known-invalid issuer kept private still reads to the next author like a
  // finished design (Architect #198).
  deriveCaptureId,
  validateCaptureMaterialSemantics,
  captureMaterialFromRow,
  readStoredWriterCapture,
});
