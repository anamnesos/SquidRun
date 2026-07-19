#!/usr/bin/env node
'use strict';

// Deliberately built-in-only. This one-shot process must never load anything
// from ui/node_modules because the restoration predicate excludes its ancestor
// chain while it asks the PowerShell runner for the canonical quiet result.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DEFAULT_TASK_NAME = 'SquidRun-Build1B-MainE28-Restoration';
const DEFAULT_DEBOUNCE_MS = 10 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const LOCK_PARSE_GRACE_MS = 10 * 60 * 1000;
const SAFE_RETRY_EXIT_CODES = new Set([42, 43]);
const EXPECTED_NOTICE_AUDIENCE = ['architect', 'builder', 'oracle'];
const RESTORATION_SCHEMA = 'squidrun.build1b.main_e28_restoration.v1';
const EXPECTED_ELECTRON_VERSION = '28.3.3';
const EXPECTED_ELECTRON_EXE_SHA256 = '67dc2a7036860a68e5312c212c31b8772ac463ed0289fcc44897867f55075e89';
const H6_STAGE_HEAD = '2db3e392ab6aaae16609eaf939058e6b35d97303';
const EXPECTED_H6_NATIVE_RECEIPT_SHA256 = 'c70d26297d94aa370abc3c1ba83ddda692a8a7c4ba1f4ca70b4707a326b31894';
const EXPECTED_H6_WINDOW_RECEIPT_SHA256 = '2711f2f68753be374a9ef8a7056146f24c900b889ab349ff7b30e56f72e62f50';
const EXPECTED_H6_STAGE_RECEIPT_SHA256 = '22232119828b65f30442b90880ed11eb011a26989ff0ba0ae00eafa6aadda92a';
const EXPECTED_DAMAGE_CHARACTERIZATION_SHA256 = '372e241c948f7b87c1403f25d44ee85d1db2bc8e067b970794564ef24bdef7e9';
const NOTICE_CLOCK_SKEW_MS = 60 * 1000;
const PREPARED_ENABLE_AUTHORIZATION_MAX_MS = 30 * 60 * 1000;
const REQUIRED_NATIVE_MODULES = ['better-sqlite3', 'node-pty', 'sharp', 'onnxruntime-node', 'sqlite-vec'];

function parseArgs(argv = []) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '');
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      flags[key] = String(next);
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function ensureDirectoryFor(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  ensureDirectoryFor(filePath);
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor = null;
  try {
    descriptor = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(descriptor, JSON.stringify(payload, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {}
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifySourceIntegrity(paths, expected = {}) {
  const definitions = {
    watcher: paths.watcherScriptPath,
    restore: paths.restoreScriptPath,
    module: paths.syncModulePath,
    registration: paths.registrationScriptPath,
  };
  const entries = {};
  let complete = true;
  let matches = true;
  for (const [name, filePath] of Object.entries(definitions)) {
    const expectedSha256 = String(expected[name] || '').toLowerCase();
    let actualSha256 = null;
    let error = null;
    try {
      actualSha256 = sha256File(filePath);
    } catch (caught) {
      error = caught.message;
    }
    const validExpected = /^[a-f0-9]{64}$/.test(expectedSha256);
    const match = validExpected && actualSha256 === expectedSha256;
    complete = complete && validExpected;
    matches = matches && match;
    entries[name] = { path: filePath, expectedSha256, actualSha256, match, error };
  }
  return {
    required: true,
    ok: complete && matches,
    complete,
    matches,
    reason: complete && matches ? 'registered_source_hashes_match' : 'registered_source_integrity_mismatch',
    entries,
  };
}

function isValidTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])])
  );
}

function canonicalJsonSha256(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalizeJson(value)), 'utf8')
    .digest('hex');
}

function isExactZero(value) {
  return Number.isInteger(value) && value === 0;
}

function isQuietSnapshot(value) {
  return value?.ok === true
    && isExactZero(value.activeProjectProcessCount)
    && Array.isArray(value.activeProjectProcesses)
    && value.activeProjectProcesses.length === 0
    && isValidTimestamp(value.checkedAtUtc);
}

function isSourceProvenance(value, expectedHead) {
  const hashes = value?.hashes;
  return value?.branch === 'main'
    && value?.head === expectedHead
    && value?.trackedUiWorktreeClean === true
    && value?.trackedUiIndexClean === true
    && value?.packageElectron === EXPECTED_ELECTRON_VERSION
    && value?.lockRootElectron === EXPECTED_ELECTRON_VERSION
    && value?.lockElectron === EXPECTED_ELECTRON_VERSION
    && hashes && typeof hashes === 'object' && !Array.isArray(hashes)
    && Object.keys(hashes).length >= 5
    && Object.values(hashes).every((candidate) => isSha256(candidate));
}

function isReferenceProvenance(value, expectedHead) {
  return value?.head === expectedHead
    && value?.trackedClean === true
    && Array.isArray(value?.trackedStatus)
    && value.trackedStatus.length === 0
    && value?.lockMatchesMain === true
    && value?.lockHashMode === 'utf8_lf_normalized'
    && isSha256(value?.mainLockSha256)
    && value.mainLockSha256 === value.referenceLockSha256;
}

function isNativeHashRows(value) {
  return Array.isArray(value)
    && value.length >= REQUIRED_NATIVE_MODULES.length
    && REQUIRED_NATIVE_MODULES.every((moduleName) => value.some((row) => row?.module === moduleName))
    && value.every((row) => REQUIRED_NATIVE_MODULES.includes(row?.module)
      && isNonEmptyString(row?.path)
      && Number.isInteger(row?.bytes)
      && row.bytes >= 0
      && isSha256(row?.sha256));
}

function isNativePresence(value) {
  return value?.allPresent === true
    && Array.isArray(value?.requiredModules)
    && REQUIRED_NATIVE_MODULES.every((moduleName) => value.requiredModules.includes(moduleName))
    && value?.counts && typeof value.counts === 'object'
    && REQUIRED_NATIVE_MODULES.every((moduleName) => Number.isInteger(value.counts[moduleName]) && value.counts[moduleName] >= 1);
}

function isPathInside(candidate, allowedRoot) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(allowedRoot);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function sameResolvedPath(left, right) {
  if (!isNonEmptyString(left) || !isNonEmptyString(right)) return false;
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isExistingFileInside(candidate, allowedRoot) {
  if (!isNonEmptyString(candidate) || !path.isAbsolute(candidate) || !isPathInside(candidate, allowedRoot)) return false;
  try {
    return fs.statSync(path.resolve(candidate)).isFile();
  } catch {
    return false;
  }
}

function validateRestorationPayload(payload, receiptPath, expectedHead, receiptRoot, registrationEpochMs, validationOptions = {}) {
  const errors = [];
  const evidenceSha256 = validationOptions.sha256FileFn || sha256File;
  const validationNowMs = Number(validationOptions.nowMs ?? Date.now());
  const latestAcceptedTimestampMs = validationNowMs + 60_000;
  const resolvedReceiptPath = typeof receiptPath === 'string' ? path.resolve(receiptPath) : null;
  const resolvedReceiptRoot = path.resolve(receiptRoot);
  const projectRoot = path.resolve(resolvedReceiptRoot, '..', '..', '..', '..');
  const expectedReferenceRoot = path.join(
    path.dirname(projectRoot),
    '_archive',
    'squidrun-worktrees',
    'squidrun-build1b-main-e28-reference'
  );
  const expectedProtectedPath = path.join(projectRoot, 'ui', 'node_modules', 'electron', 'dist', 'electron.exe');
  const expectedH6NativePath = path.join(projectRoot, '.squidrun', 'coord', 'build1b-e29-s480', 'rollback-native-e28-2db3e392.json');
  const expectedH6WindowPath = path.join(projectRoot, '.squidrun', 'coord', 'build1b-e29-s480', 'rollback-windows-e28-2db3e392', 'window-capture-receipt.json');
  const expectedH6StagePath = path.join(projectRoot, '.squidrun', 'coord', 'build1b-e29-s480', 'stage-receipt-2db3e392.json');
  const expectedDamagePath = path.join(projectRoot, '.squidrun', 'coord', 'build1b-e29-s480', 'main-node-modules-damage-characterization.json');
  const capturedAtMs = Date.parse(payload?.capturedAt || '');
  const receiptName = resolvedReceiptPath ? path.basename(resolvedReceiptPath) : '';
  const receiptSuffix = '-main-e28-restoration.json';
  const receiptRunId = receiptName.endsWith(receiptSuffix) ? receiptName.slice(0, -receiptSuffix.length) : '';
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) errors.push('payload_not_object');
  if (payload?.schema !== RESTORATION_SCHEMA) errors.push('schema');
  if (payload?.ok !== true) errors.push('ok');
  if (payload?.restartState !== 'restart_ready_electron_28_3_3') errors.push('restart_state');
  if (!resolvedReceiptPath || !isPathInside(resolvedReceiptPath, receiptRoot)) errors.push('receipt_outside_root');
  if (!resolvedReceiptPath || !resolvedReceiptPath.endsWith('-main-e28-restoration.json')) errors.push('receipt_name');
  if (!isNonEmptyString(receiptRunId) || payload?.runId !== receiptRunId) errors.push('run_id');
  if (!resolvedReceiptPath || path.resolve(String(payload?.receiptPath || '')) !== resolvedReceiptPath) errors.push('self_receipt_path');
  if (!Number.isFinite(capturedAtMs) || capturedAtMs < Number(registrationEpochMs) || capturedAtMs > latestAcceptedTimestampMs) errors.push('registration_epoch');
  if (String(payload?.MR1?.head || '').toLowerCase() !== expectedHead) errors.push('mr1_head');
  if (payload?.MR1?.branch !== 'main') errors.push('mr1_branch');
  if (payload?.MR1?.packageElectron !== EXPECTED_ELECTRON_VERSION
    || payload?.MR1?.lockRootElectron !== EXPECTED_ELECTRON_VERSION
    || payload?.MR1?.lockElectron !== EXPECTED_ELECTRON_VERSION) errors.push('mr1_versions');
  const retainedCommits = payload?.MR1?.retainedCommitsAfterH6Coverage;
  const retainedTipMatchesHead = expectedHead === H6_STAGE_HEAD
    ? Array.isArray(retainedCommits) && retainedCommits.length === 0
    : Array.isArray(retainedCommits)
      && retainedCommits.length > 0
      && retainedCommits[retainedCommits.length - 1]?.commit === expectedHead;
  if (payload?.MR1?.ladderBranch !== 'build-1b-ladder'
    || payload?.MR1?.ladderStageCommit !== H6_STAGE_HEAD
    || payload?.MR1?.h6CoveredSourceThrough !== H6_STAGE_HEAD
    || !Array.isArray(retainedCommits)
    || !retainedCommits.every((row) => /^[a-f0-9]{40}$/.test(row?.commit || '')
      && isNonEmptyString(row?.subject)
      && isNonEmptyString(row?.justification))
    || !retainedTipMatchesHead) errors.push('mr1_retained_commits');
  const sourceProvenance = payload?.MR1?.sourceProvenance;
  if (!['initial', 'postReferenceInstall', 'postPlan', 'finalValidation', 'beforeReceipt', 'afterProvisionalReceipt']
    .every((name) => isSourceProvenance(sourceProvenance?.[name], expectedHead))) errors.push('mr1_source_provenance');
  const sourceManifest = payload?.MR1?.trackedUiSourceManifest;
  const sourceManifests = [
    sourceManifest?.initial,
    sourceManifest?.finalValidation,
    sourceManifest?.beforeReceipt,
    sourceManifest?.afterProvisionalReceipt,
  ];
  if (sourceManifest?.unchanged !== true
    || !sourceManifests.every((entry) => Number.isInteger(entry?.trackedFileCount)
      && entry.trackedFileCount > 0
      && Number.isInteger(entry?.trackedBytes)
      && entry.trackedBytes > 0
      && isSha256(entry?.sha256))
    || new Set(sourceManifests.map((entry) => entry?.trackedFileCount)).size !== 1
    || new Set(sourceManifests.map((entry) => entry?.trackedBytes)).size !== 1
    || new Set(sourceManifests.map((entry) => entry?.sha256)).size !== 1) errors.push('mr1_source_manifest');

  const referenceNative = payload?.MR2?.referenceNativeHashes;
  const mainNative = payload?.MR2?.mainNativeHashes;
  const sample = payload?.MR2?.randomSample;
  const referenceProvenance = payload?.MR2?.referenceProvenance;
  const syncPlanArtifactBinding = payload?.MR2?.syncPlanArtifact;
  const syncPlanArtifactPath = String(syncPlanArtifactBinding?.path || '');
  const syncPlanArtifact = isExistingFileInside(syncPlanArtifactPath, resolvedReceiptRoot)
    ? readJson(path.resolve(syncPlanArtifactPath), null)
    : null;
  let syncPlanArtifactSha256 = null;
  try { syncPlanArtifactSha256 = sha256File(syncPlanArtifactPath); } catch {}
  const artifactPlan = syncPlanArtifact?.plan;
  const planActionContracts = [
    ['deleteExtraFiles', 'extra_file_deleted'],
    ['deleteExtraDirectories', 'extra_directory_deleted'],
    ['createDirectories', 'directory_created'],
    ['copyMissing', 'missing_file_committed'],
    ['replaceDifferent', 'replacement_committed'],
  ];
  const planActionsShapeValid = planActionContracts.every(([key]) => Array.isArray(artifactPlan?.[key])
    && artifactPlan[key].every((entry) => isNonEmptyString(entry?.relativePath)));
  const expectedCompletedActions = planActionsShapeValid
    ? planActionContracts.flatMap(([key, stage]) => artifactPlan[key].map((entry) => ({
      stage,
      relativePath: entry.relativePath,
    })))
    : [];
  const syncPlanArtifactValid = syncPlanArtifactBinding?.schema === 'squidrun.build1b.main_e28_restoration_sync_plan.v1'
    && isSha256(syncPlanArtifactBinding?.sha256)
    && syncPlanArtifactBinding.sha256.toLowerCase() === syncPlanArtifactSha256
    && Number.isInteger(syncPlanArtifactBinding?.mutationCount)
    && syncPlanArtifactBinding.mutationCount === payload?.MR2?.syncPlan?.mutationCount
    && syncPlanArtifact?.schema === syncPlanArtifactBinding.schema
    && syncPlanArtifact?.runId === receiptRunId
    && syncPlanArtifact?.head === expectedHead
    && syncPlanArtifact?.protectedRelativePath === 'electron\\dist\\electron.exe'
    && artifactPlan?.schema === 'squidrun.dependency_sync_plan.v1'
    && artifactPlan.mutationCount === syncPlanArtifactBinding.mutationCount
    && planActionsShapeValid
    && expectedCompletedActions.length === artifactPlan.mutationCount
    && planActionContracts.every(([key]) => Number(payload?.MR2?.syncPlan?.[key]) === artifactPlan[key].length)
    && isExactZero(artifactPlan.protectedMutationCount)
    && isExactZero(artifactPlan.protectedDirectoryMutationCount)
    && isExactZero(artifactPlan.protectedPathStateConflictCount);
  const completedActions = payload?.MR2?.sync?.completedActions;
  const completedMutationCount = Number(payload?.MR2?.sync?.createDirectories || 0)
    + Number(payload?.MR2?.sync?.copyMissing || 0)
    + Number(payload?.MR2?.sync?.replaceDifferent || 0)
    + Number(payload?.MR2?.sync?.deleteExtraFiles || 0)
    + Number(payload?.MR2?.sync?.deleteExtraDirectories || 0);
  const completedActionsValid = Array.isArray(completedActions)
    && completedActions.length === payload?.MR2?.syncPlan?.mutationCount
    && completedMutationCount === payload?.MR2?.syncPlan?.mutationCount
    && completedActions.every((entry, index) => entry?.stage === expectedCompletedActions[index]?.stage
      && entry?.relativePath === expectedCompletedActions[index]?.relativePath
      && isValidTimestamp(entry?.completedAtUtc)
      && Date.parse(entry.completedAtUtc) <= latestAcceptedTimestampMs);
  if (payload?.MR2?.referenceHead !== expectedHead
    || !sameResolvedPath(String(payload?.MR2?.referenceRoot || ''), expectedReferenceRoot)
    || !isExactZero(payload?.MR2?.referenceNpmCiExitCode)
    || typeof payload?.MR2?.referenceNpmCiDurationSeconds !== 'number'
    || payload.MR2.referenceNpmCiDurationSeconds < 0
    || !Number.isInteger(payload?.MR2?.referenceTopLevelCount)
    || payload.MR2.referenceTopLevelCount <= 0
    || payload.MR2.referenceTopLevelCount !== payload?.MR2?.mainTopLevelCount
    || !Number.isInteger(payload?.MR2?.referenceFileCount)
    || payload.MR2.referenceFileCount <= 0
    || payload.MR2.referenceFileCount !== payload?.MR2?.mainFileCount
    || payload?.MR2?.electronPackageMetadata !== EXPECTED_ELECTRON_VERSION
    || payload?.MR2?.finalFullCoherencePass !== true
    || payload?.MR2?.nativeHashesMatch !== true
    || payload?.MR2?.randomSampleAllMatch !== true
    || !Array.isArray(payload?.MR2?.missingFiles)
    || payload.MR2.missingFiles.length !== 0
    || !Array.isArray(payload?.MR2?.extraFiles)
    || payload.MR2.extraFiles.length !== 0
    || !isNativePresence(payload?.MR2?.referenceNativePresence)
    || !isNativePresence(payload?.MR2?.mainNativePresence)
    || !isNativeHashRows(referenceNative)
    || !isNativeHashRows(mainNative)
    || canonicalJsonSha256(referenceNative) !== canonicalJsonSha256(mainNative)
    || !Number.isInteger(payload?.MR2?.randomSampleSeed)
    || payload.MR2.randomSampleSeed <= 0
    || !Number.isInteger(payload?.MR2?.randomSampleSize)
    || payload.MR2.randomSampleSize <= 0
    || !Array.isArray(sample)
    || sample.length !== payload?.MR2?.randomSampleSize
    || !sample.every((row) => isNonEmptyString(row?.path)
      && isSha256(row?.referenceSha256)
      && row.referenceSha256 === row?.mainSha256
      && row?.match === true)
    || !['preInstall', 'postInstall', 'postPlan', 'finalValidation']
      .every((name) => isReferenceProvenance(referenceProvenance?.[name], expectedHead))
    || !isExactZero(payload?.MR2?.finalFullCoherencePlan?.mutationCount)
    || !isExactZero(payload?.MR2?.finalFullCoherencePlan?.protectedMutationCount)
    || !isExactZero(payload?.MR2?.finalFullCoherencePlan?.protectedDirectoryMutationCount)
    || !isExactZero(payload?.MR2?.finalFullCoherencePlan?.protectedPathStateConflictCount)
    || !syncPlanArtifactValid
    || !completedActionsValid) errors.push('mr2');
  const mr3Hashes = [
    payload?.MR3?.sha256Before,
    payload?.MR3?.sha256AfterSync,
    payload?.MR3?.sha256After,
    payload?.MR3?.expectedSha256,
  ];
  if (payload?.MR3?.untouched !== true
    || payload?.MR3?.atomicReplacement !== true
    || !sameResolvedPath(String(payload?.MR3?.protectedPath || ''), expectedProtectedPath)
    || mr3Hashes.some((candidate) => !isSha256(candidate))
    || new Set(mr3Hashes.map((candidate) => candidate.toLowerCase())).size !== 1
    || payload.MR3.expectedSha256.toLowerCase() !== EXPECTED_ELECTRON_EXE_SHA256
    || !Number.isInteger(payload?.MR3?.atomicCommitCount)
    || payload.MR3.atomicCommitCount < 0
    || payload.MR3.atomicCommitCount !== payload?.MR3?.expectedAtomicCommitCount
    || !isExactZero(payload?.MR3?.protectedMutationCount)
    || !isExactZero(payload?.MR3?.protectedDirectoryMutationCount)
    || !isExactZero(payload?.MR3?.protectedPathStateConflictCount)) errors.push('mr3');
  const fullSuite = payload?.MR4?.fullSuiteMinusCharacterizedEolPair;
  const commsSuite = payload?.MR4?.hmSendAndCommsRoundTripTests;
  const eolSuite = payload?.MR4?.characterizedEolSuitesDiagnosticOnly;
  const logArtifactValid = (row) => {
    const logPath = String(row?.log || '');
    if (!isExistingFileInside(logPath, resolvedReceiptRoot)
      || !path.basename(logPath).startsWith(`${receiptRunId}-`)
      || !isSha256(row?.logSha256)
      || !Number.isInteger(row?.logBytes)
      || row.logBytes < 0) return false;
    try {
      const stat = fs.statSync(logPath);
      return stat.size === row.logBytes && evidenceSha256(logPath) === row.logSha256.toLowerCase();
    } catch {
      return false;
    }
  };
  if (!isExactZero(fullSuite?.exitCode)
    || fullSuite?.timedOut !== false
    || fullSuite?.forceExit !== true
    || typeof fullSuite?.durationSeconds !== 'number'
    || fullSuite.durationSeconds < 0
    || !logArtifactValid(fullSuite)
    || !isExactZero(commsSuite?.exitCode)
    || commsSuite?.timedOut !== false
    || commsSuite?.forceExit !== true
    || typeof commsSuite?.durationSeconds !== 'number'
    || commsSuite.durationSeconds < 0
    || !logArtifactValid(commsSuite)
    || eolSuite?.gatesRestart !== false
    || eolSuite?.forceExit !== true
    || !logArtifactValid(eolSuite)
    || !Array.isArray(eolSuite?.checkoutState?.characterizedSuites)
    || !['system-protected-evals', 'the-tell-normalize-parity']
      .every((name) => eolSuite.checkoutState.characterizedSuites.includes(name))) errors.push('mr4');
  const h6Initial = payload?.MR5?.h6ReceiptValidation;
  const h6Final = payload?.MR5?.h6ReceiptValidationFinal;
  const h6AfterProvisional = payload?.MR5?.h6ReceiptValidationAfterProvisionalReceipt;
  const exactH6Evidence = [h6Initial, h6Final, h6AfterProvisional].every((entry) => entry?.ok === true
    && sameResolvedPath(String(entry?.native?.path || ''), expectedH6NativePath)
    && String(entry?.native?.sha256 || '').toLowerCase() === EXPECTED_H6_NATIVE_RECEIPT_SHA256
    && sameResolvedPath(String(entry?.window?.path || ''), expectedH6WindowPath)
    && String(entry?.window?.sha256 || '').toLowerCase() === EXPECTED_H6_WINDOW_RECEIPT_SHA256
    && sameResolvedPath(String(entry?.stage?.path || ''), expectedH6StagePath)
    && String(entry?.stage?.sha256 || '').toLowerCase() === EXPECTED_H6_STAGE_RECEIPT_SHA256);
  let actualH6EvidenceMatches = false;
  try {
    actualH6EvidenceMatches = evidenceSha256(expectedH6NativePath) === EXPECTED_H6_NATIVE_RECEIPT_SHA256
      && evidenceSha256(expectedH6WindowPath) === EXPECTED_H6_WINDOW_RECEIPT_SHA256
      && evidenceSha256(expectedH6StagePath) === EXPECTED_H6_STAGE_RECEIPT_SHA256;
  } catch {}
  if (!isNonEmptyString(payload?.MR5?.statement)
    || !/electron 28\.3\.3/i.test(payload.MR5.statement)
    || !payload.MR5.statement.includes('H6')
    || /\bshould\b/i.test(payload.MR5.statement)
    || payload?.MR5?.h6NativeReceipt !== '.squidrun/coord/build1b-e29-s480/rollback-native-e28-2db3e392.json'
    || payload?.MR5?.h6WindowReceipt !== '.squidrun/coord/build1b-e29-s480/rollback-windows-e28-2db3e392/window-capture-receipt.json'
    || h6Initial?.ok !== true
    || h6Final?.ok !== true
    || h6AfterProvisional?.ok !== true
    || !exactH6Evidence
    || !actualH6EvidenceMatches
    || payload?.MR5?.h6EvidenceUnchanged !== true
    || h6Initial?.native?.expectedCommit !== '2db3e392'
    || h6Initial?.window?.head !== H6_STAGE_HEAD
    || h6Initial?.stage?.head !== H6_STAGE_HEAD
    || !isSha256(h6Initial?.native?.sha256)
    || !isSha256(h6Initial?.window?.sha256)
    || !isSha256(h6Initial?.stage?.sha256)
    || !isSha256(h6Initial?.packagedArtifact?.executableSha256)
    || !isSha256(h6Initial?.packagedArtifact?.asarSha256)
    || canonicalJsonSha256(h6Initial) !== canonicalJsonSha256(h6Final)
    || canonicalJsonSha256(h6Initial) !== canonicalJsonSha256(h6AfterProvisional)
    || !Array.isArray(payload?.MR5?.residualRisks)
    || payload.MR5.residualRisks.length === 0
    || !payload.MR5.residualRisks.every((risk) => isNonEmptyString(risk))) errors.push('mr5');
  const quietSnapshots = [
    payload?.MR6?.initialQuiet,
    payload?.MR6?.postReferenceQuiet,
    payload?.MR6?.postPlanQuiet,
    payload?.MR6?.finalValidationQuiet,
    payload?.MR6?.finalReceiptQuiet,
    payload?.MR6?.postProvisionalReceiptQuiet,
  ];
  const provisionalReceiptPath = String(payload?.MR6?.provisionalReceiptPath || '');
  const provisionalReceipt = isExistingFileInside(provisionalReceiptPath, resolvedReceiptRoot)
    ? readJson(path.resolve(provisionalReceiptPath), null)
    : null;
  let provisionalReceiptSha256 = null;
  try { provisionalReceiptSha256 = evidenceSha256(provisionalReceiptPath); } catch {}
  const provisionalReceiptValid = provisionalReceipt?.schema === 'squidrun.build1b.main_e28_restoration_pre_success_validation.v1'
    && provisionalReceipt?.runId === receiptRunId
    && provisionalReceipt?.kind === 'pre_success_validation'
    && provisionalReceipt?.ok === false
    && provisionalReceipt?.candidateWouldPass === true
    && provisionalReceipt?.restartState === 'restart_blocked_pending_post_receipt_quiet_check'
    && provisionalReceipt?.head === expectedHead
    && String(provisionalReceipt?.protectedElectronSha256 || '').toLowerCase() === EXPECTED_ELECTRON_EXE_SHA256
    && isValidTimestamp(provisionalReceipt?.capturedAtUtc)
    && Date.parse(provisionalReceipt.capturedAtUtc) >= Number(registrationEpochMs)
    && Date.parse(provisionalReceipt.capturedAtUtc) <= latestAcceptedTimestampMs
    && sameResolvedPath(String(provisionalReceipt?.receiptPath || ''), provisionalReceiptPath)
    && path.basename(provisionalReceiptPath) === `${receiptRunId}-pre-success-validation.json`
    && isSha256(payload?.MR6?.provisionalReceiptSha256)
    && payload.MR6.provisionalReceiptSha256.toLowerCase() === provisionalReceiptSha256
    && isQuietSnapshot(provisionalReceipt?.finalReceiptQuiet)
    && canonicalJsonSha256(provisionalReceipt.finalReceiptQuiet) === canonicalJsonSha256(payload?.MR6?.finalReceiptQuiet);
  if (payload?.MR6?.naturalQuietWindowRequired !== true
    || !isExactZero(payload?.MR6?.projectProcessStopCommands)
    || payload?.MR6?.zeroProjectProcessSnapshots !== true
    || payload?.MR6?.atomicSameDirectoryReplacement !== true
    || !isNonEmptyString(payload?.MR6?.ownedChildTerminationPolicy)
    || !quietSnapshots.every((snapshot) => isQuietSnapshot(snapshot)
      && Date.parse(snapshot.checkedAtUtc) <= latestAcceptedTimestampMs)
    || !Array.isArray(payload?.MR6?.activeProjectProcessesAfter)
    || payload.MR6.activeProjectProcessesAfter.length !== 0
    || !Array.isArray(payload?.MR6?.initialProjectProcessStartTimes)
    || payload.MR6.initialProjectProcessStartTimes.length !== 0
    || !Array.isArray(payload?.MR6?.finalProjectProcessStartTimes)
    || payload.MR6.finalProjectProcessStartTimes.length !== 0
    || canonicalJsonSha256(payload.MR6.initialProjectProcessStartTimes)
      !== canonicalJsonSha256(payload.MR6.finalProjectProcessStartTimes)
    || payload?.MR6?.projectProcessStartTimesUnchanged !== true
    || !Number.isInteger(payload?.MR6?.midRunGuardIntervalMs)
    || payload.MR6.midRunGuardIntervalMs < 100
    || !isExactZero(payload?.MR6?.protectedElectronPlannedMutations)
    || !isExactZero(payload?.MR6?.protectedParentDirectoryPlannedMutations)
    || !isExactZero(payload?.MR6?.protectedPathStateConflicts)
    || !provisionalReceiptValid) errors.push('mr6');
  let actualDamageSha256 = null;
  try { actualDamageSha256 = evidenceSha256(expectedDamagePath); } catch {}
  if (payload?.MR7?.originalMissingTopLevelEntries !== 454
    || payload?.MR7?.originalMissingNestedFiles !== 9124
    || !isNonEmptyString(payload?.MR7?.supersededIntermediate)
    || !/E29/i.test(payload.MR7.supersededIntermediate)
    || payload?.MR7?.damageCharacterization !== '.squidrun/coord/build1b-e29-s480/main-node-modules-damage-characterization.json'
    || !sameResolvedPath(expectedDamagePath, path.join(projectRoot, payload?.MR7?.damageCharacterization || ''))
    || payload?.MR7?.damageCharacterizationSha256 !== EXPECTED_DAMAGE_CHARACTERIZATION_SHA256
    || actualDamageSha256 !== EXPECTED_DAMAGE_CHARACTERIZATION_SHA256
    || !isNonEmptyString(payload?.MR7?.originalUndersell)
    || !/EBUSY/i.test(payload.MR7.originalUndersell)) errors.push('mr7');
  return {
    ok: errors.length === 0,
    errors,
    payload,
    receiptPath: resolvedReceiptPath,
    capturedAtMs: Number.isFinite(capturedAtMs) ? capturedAtMs : null,
  };
}

function readAndValidateRestorationReceipt(receiptPath, expectedHead, receiptRoot, registrationEpochMs, validationOptions = {}) {
  if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
    return { ok: false, errors: ['receipt_path_not_absolute'], receiptPath: receiptPath || null };
  }
  const resolvedReceiptPath = path.resolve(receiptPath);
  const payload = readJson(resolvedReceiptPath, null);
  if (!payload) return { ok: false, errors: ['receipt_missing_or_invalid'], receiptPath: resolvedReceiptPath };
  return validateRestorationPayload(payload, resolvedReceiptPath, expectedHead, receiptRoot, registrationEpochMs, validationOptions);
}

function validateDoneReceipt(done, paths, expectedHead, taskName, registrationEpochMs, validationOptions = {}) {
  const errors = [];
  const latestAcceptedTimestampMs = Number(validationOptions.nowMs ?? Date.now()) + 60_000;
  if (done?.schema !== 'squidrun.build1b.main_e28_restoration_watch_done.v1') errors.push('schema');
  if (done?.ok !== true) errors.push('ok');
  if (done?.taskName !== taskName) errors.push('task_name');
  if (done?.expectedHead !== expectedHead) errors.push('expected_head');
  if (Number(done?.registrationEpochMs) !== Number(registrationEpochMs)) errors.push('registration_epoch');
  if (!isValidTimestamp(done?.completedAt)
    || Date.parse(done.completedAt) < Number(registrationEpochMs)
    || Date.parse(done.completedAt) > latestAcceptedTimestampMs) errors.push('completed_at');
  if (done?.restartState !== 'restart_ready_electron_28_3_3') errors.push('restart_state');
  const restoration = readAndValidateRestorationReceipt(
    done?.restorationReceiptPath,
    expectedHead,
    paths.restorationReceiptRoot,
    registrationEpochMs,
    validationOptions
  );
  if (!restoration.ok) errors.push('restoration_receipt');
  return { ok: errors.length === 0, errors, restoration };
}

function validateTerminalReceipt(terminal, paths, expectedHead, taskName, registrationEpochMs, validationOptions = {}) {
  const errors = [];
  const latestAcceptedTimestampMs = Number(validationOptions.nowMs ?? Date.now()) + 60_000;
  if (terminal?.schema !== 'squidrun.build1b.main_e28_restoration_watch_terminal.v1') errors.push('schema');
  if (terminal?.terminal !== true || terminal?.ok !== false) errors.push('terminal_shape');
  if (terminal?.taskName !== taskName) errors.push('task_name');
  if (terminal?.expectedHead !== expectedHead) errors.push('expected_head');
  if (Number(terminal?.registrationEpochMs) !== Number(registrationEpochMs)) errors.push('registration_epoch');
  if (!isValidTimestamp(terminal?.capturedAt)
    || Date.parse(terminal.capturedAt) < Number(registrationEpochMs)
    || Date.parse(terminal.capturedAt) > latestAcceptedTimestampMs) errors.push('captured_at');
  if (path.resolve(String(terminal?.terminalPath || '')) !== path.resolve(paths.terminalPath)) errors.push('self_terminal_path');
  if (typeof terminal?.restartState !== 'string' || !terminal.restartState.startsWith('restart_blocked')) errors.push('restart_state');
  let restoration = null;
  if (terminal?.restorationReceiptPath !== null && terminal?.restorationReceiptPath !== undefined) {
    restoration = readAndValidateRestorationReceipt(
      terminal.restorationReceiptPath,
      expectedHead,
      paths.restorationReceiptRoot,
      registrationEpochMs,
      validationOptions
    );
    if (!restoration.ok) errors.push('restoration_receipt');
  }
  return { ok: errors.length === 0, errors, restoration };
}

function verifyRegistrationProof(proofPath, expected = {}) {
  const resolvedProofPath = path.resolve(String(proofPath || ''));
  const proof = readJson(resolvedProofPath, null);
  const errors = [];
  if (!proof) errors.push('proof_missing_or_invalid');
  if (proof?.schema !== 'squidrun.build1b.main_e28_restoration_task_registration_proof.v1') errors.push('schema');
  if (proof?.taskName !== expected.taskName) errors.push('task_name');
  if (expected.proofPath && resolvedProofPath !== path.resolve(expected.proofPath)) errors.push('proof_path_contract');
  if (proof?.expectedHead !== expected.expectedHead) errors.push('expected_head');
  if (!Number.isInteger(proof?.registrationEpochMs)
    || proof.registrationEpochMs !== expected.registrationEpochMs) errors.push('registration_epoch');
  if (path.resolve(String(proof?.proofPath || '')) !== resolvedProofPath) errors.push('self_proof_path');
  if (!isSha256(proof?.watcherArgumentsSha256)
    || (expected.watcherArgumentsSha256
      && proof.watcherArgumentsSha256 !== expected.watcherArgumentsSha256)) errors.push('watcher_arguments_sha256');
  for (const name of ['watcher', 'restore', 'module', 'registration']) {
    if (String(proof?.sourceIntegrity?.[name]?.sha256 || '').toLowerCase()
      !== String(expected.sourceIntegrity?.[name] || '').toLowerCase()) errors.push(`source_${name}`);
    if (expected.sourcePaths?.[name]
      && path.resolve(String(proof?.sourceIntegrity?.[name]?.path || ''))
        !== path.resolve(expected.sourcePaths[name])) errors.push(`source_path_${name}`);
  }
  const nowMs = Number(expected.nowMs ?? Date.now());
  const committedErrors = [];
  const pendingErrors = [];
  if (proof?.phase === 'committed_enabled') {
    if (proof?.ok !== true) committedErrors.push('ok');
    if (!isValidTimestamp(proof?.committedAt)
      || Date.parse(proof.committedAt) < expected.registrationEpochMs
      || Date.parse(proof.committedAt) > nowMs) committedErrors.push('committed_at');
    if (proof?.registeredTask?.enabled !== true
      || proof?.registeredTask?.ownerMarkerVerified !== true
      || proof?.registeredTask?.runtimeReady !== true) committedErrors.push('registered_task_state');
  } else if (proof?.phase === 'prepared_enable_authorized') {
    if (proof?.ok !== false || proof?.enableAuthorized !== true) pendingErrors.push('enable_authorization');
    const preparedAtMs = Date.parse(proof?.preparedAt || '');
    const expiresAtMs = Date.parse(proof?.enableAuthorizationExpiresAt || '');
    if (!Number.isFinite(preparedAtMs)
      || preparedAtMs < expected.registrationEpochMs
      || preparedAtMs > nowMs) pendingErrors.push('prepared_at');
    if (!Number.isFinite(expiresAtMs)
      || expiresAtMs <= nowMs
      || !Number.isFinite(preparedAtMs)
      || expiresAtMs > preparedAtMs + PREPARED_ENABLE_AUTHORIZATION_MAX_MS) pendingErrors.push('enable_authorization_expired');
    if (proof?.registeredTask?.enabled !== false
      || proof?.registeredTask?.ownerMarkerVerified !== true
      || proof?.registeredTask?.runtimeReady !== false) pendingErrors.push('registered_task_state');
  } else {
    errors.push('phase');
  }
  const committed = proof?.phase === 'committed_enabled' && committedErrors.length === 0;
  const pending = proof?.phase === 'prepared_enable_authorized' && pendingErrors.length === 0;
  return {
    ok: errors.length === 0 && committed,
    pending: errors.length === 0 && pending,
    errors: [...errors, ...(committed ? [] : committedErrors), ...(pending ? [] : pendingErrors)],
    proofPath: resolvedProofPath,
    proof,
  };
}

function noticeMatches(notice, {
  status,
  anchorKey,
  anchorPath,
  expectedHead,
  registrationEpochMs,
  restorationReceiptPath,
  nowMs = Date.now(),
}) {
  if (!notice || typeof notice !== 'object') return false;
  const audience = Array.isArray(notice.audience) ? [...notice.audience].sort() : [];
  const expectedAudience = [...EXPECTED_NOTICE_AUDIENCE].sort();
  const createdAtMs = Date.parse(notice.createdAt || '');
  const hasConflictingAnchor = status === 'complete'
    ? Object.prototype.hasOwnProperty.call(notice, 'terminalPath')
    : Object.prototype.hasOwnProperty.call(notice, 'donePath');
  return notice.schema === 'squidrun.next_session_notice.v1'
    && notice.topic === 'build1b-main-e28-restoration'
    && notice.status === status
    && audience.length === expectedAudience.length
    && audience.every((role, index) => role === expectedAudience[index])
    && notice[anchorKey] === anchorPath
    && notice.expectedHead === expectedHead
    && Number.isInteger(notice.registrationEpochMs)
    && notice.registrationEpochMs === registrationEpochMs
    && notice.restorationReceiptPath === restorationReceiptPath
    && typeof notice.message === 'string'
    && notice.message.trim().length > 0
    && Number.isFinite(createdAtMs)
    && createdAtMs >= registrationEpochMs
    && createdAtMs <= Number(nowMs) + NOTICE_CLOCK_SKEW_MS
    && !hasConflictingAnchor;
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: Number(options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS),
    maxBuffer: Number(options.maxBuffer || 16 * 1024 * 1024),
    env: options.env || process.env,
  });
  return {
    command,
    args,
    cwd: options.cwd || null,
    exitCode: Number.isInteger(result.status) ? result.status : (result.error ? 1 : 0),
    signal: result.signal || null,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    error: result.error ? result.error.message : null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function parseJsonCommandOutput(result) {
  const text = String(result?.stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const candidate = lines.slice(index).join('\n').trim();
      if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
      try {
        return JSON.parse(candidate);
      } catch {}
    }
    return null;
  }
}

function getProcessCreationUtc(powershellPath, pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  const escaped = String(numeric);
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${escaped}" -ErrorAction SilentlyContinue`,
    `if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`,
  ].join('; ');
  const result = runCommand(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: 30000,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

function resolvePaths(projectRoot) {
  const root = path.resolve(projectRoot);
  const watcherReceiptRoot = path.join(
    root,
    '.squidrun',
    'coord',
    'build1b-e29-s480',
    'main-e28-restoration-watcher'
  );
  return {
    projectRoot: root,
    watcherScriptPath: path.join(root, 'ui', 'scripts', 'hm-main-e28-restoration-watch.js'),
    restoreScriptPath: path.join(root, 'ui', 'scripts', 'hm-restore-main-e28-coherence.ps1'),
    syncModulePath: path.join(root, 'ui', 'scripts', 'hm-main-e28-tree-sync.psm1'),
    registrationScriptPath: path.join(root, 'ui', 'scripts', 'hm-register-main-e28-restoration-watch.ps1'),
    statePath: path.join(root, '.squidrun', 'runtime', 'main-e28-restoration-watch-state.json'),
    invocationLockPath: path.join(root, '.squidrun', 'runtime', 'main-e28-restoration-watch.lock.json'),
    donePath: path.join(watcherReceiptRoot, 'done.json'),
    terminalPath: path.join(watcherReceiptRoot, 'terminal-failure.json'),
    registrationProofPath: path.join(watcherReceiptRoot, 'registration-proof.json'),
    nextSessionNoticePath: path.join(root, '.squidrun', 'runtime', 'next-session-notices', 'main-e28-restoration.json'),
    watcherReceiptRoot,
    restorationReceiptRoot: path.join(
      root,
      '.squidrun',
      'coord',
      'build1b-e29-s480',
      'main-e28-restoration'
    ),
  };
}

function findSuccessfulRestorationReceipt(receiptRoot, expectedHead = '', registrationEpochMs = 0, validationOptions = {}) {
  let names;
  try {
    names = fs.readdirSync(receiptRoot)
      .filter((name) => name.endsWith('-main-e28-restoration.json'))
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const receiptPath = path.join(receiptRoot, name);
    const validation = readAndValidateRestorationReceipt(
      path.resolve(receiptPath),
      expectedHead,
      receiptRoot,
      registrationEpochMs,
      validationOptions
    );
    if (validation.ok) {
      return { receiptPath: validation.receiptPath, payload: validation.payload, validation };
    }
  }
  return null;
}

function findBlockingRecoveryOutcome(
  watcherReceiptRoot,
  taskName,
  expectedHead,
  registrationEpochMs,
  restorationReceiptPath,
  validationNowMs = Date.now()
) {
  let names;
  try {
    names = fs.readdirSync(watcherReceiptRoot).filter((name) => name.endsWith('.json')).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    const eventPath = path.join(watcherReceiptRoot, name);
    const event = readJson(eventPath, null);
    if (event?.schema !== 'squidrun.build1b.main_e28_restoration_watch_event.v1'
      || event?.kind !== 'script_abort_or_failure'
      || event?.taskName !== taskName
      || event?.expectedHead !== expectedHead
      || Number(event?.registrationEpochMs) !== Number(registrationEpochMs)
      || !isValidTimestamp(event?.capturedAt)
      || Date.parse(event.capturedAt) < Number(registrationEpochMs)
      || Date.parse(event.capturedAt) > Number(validationNowMs) + 60_000) continue;
    const boundReceiptPaths = [
      event?.restorationReceiptValidation?.receiptPath,
      event?.restoration?.receiptPath,
    ].filter(isNonEmptyString);
    if (!restorationReceiptPath
      || boundReceiptPaths.some((candidate) => sameResolvedPath(candidate, restorationReceiptPath))) {
      return { eventPath: path.resolve(eventPath), event };
    }
  }
  return null;
}

function acquireInvocationLock(options) {
  const {
    lockPath,
    powershellPath,
    nowMs = Date.now(),
    pid = process.pid,
    isPidAliveFn = isPidAlive,
    getProcessCreationUtcFn = getProcessCreationUtc,
  } = options;
  ensureDirectoryFor(lockPath);
  let existing = readJson(lockPath, null);
  let staleQuarantine = null;
  if (fs.existsSync(lockPath)) {
    if (!existing) {
      let ageMs = 0;
      try {
        ageMs = Math.max(0, nowMs - fs.statSync(lockPath).mtimeMs);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          return { ok: false, reason: 'watch_lock_stat_failed', error: error.message };
        }
      }
      if (fs.existsSync(lockPath) && ageMs < LOCK_PARSE_GRACE_MS) {
        return {
          ok: false,
          reason: 'watch_lock_unparseable_within_grace',
          ageMs,
          parseGraceMs: LOCK_PARSE_GRACE_MS,
        };
      }
    }
    const existingPid = Number(existing?.pid);
    const existingCreation = String(existing?.processCreationUtc || '');
    const pidAlive = isPidAliveFn(existingPid);
    const liveCreation = pidAlive
      ? getProcessCreationUtcFn(powershellPath, existingPid)
      : null;
    if (liveCreation && existingCreation && liveCreation === existingCreation) {
      return {
        ok: false,
        reason: 'watch_invocation_already_running',
        existing,
      };
    }
    if (pidAlive && liveCreation && existingCreation && liveCreation !== existingCreation) {
      return {
        ok: false,
        reason: 'watch_lock_live_identity_mismatch_conservative_refusal',
        existing,
        liveCreation,
      };
    }
    if (pidAlive && !liveCreation) {
      return {
        ok: false,
        reason: 'watch_lock_live_identity_unverifiable',
        existing,
      };
    }
    if (pidAlive && !existingCreation) {
      return {
        ok: false,
        reason: 'watch_lock_live_process_missing_recorded_identity',
        existing,
      };
    }
    const stalePath = `${lockPath}.stale-${new Date(nowMs).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`;
    try {
      fs.renameSync(lockPath, stalePath);
      staleQuarantine = {
        path: stalePath,
        reason: existing ? 'recorded_identity_not_live' : 'unparseable_metadata_after_grace',
        existing,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        return { ok: false, reason: 'watch_lock_stale_quarantine_failed', error: error.message };
      }
    }
    existing = null;
  }

  const token = crypto.randomUUID();
  const processCreationUtc = getProcessCreationUtcFn(powershellPath, pid);
  if (!processCreationUtc) {
    return {
      ok: false,
      reason: 'watch_lock_self_identity_unverifiable',
      pid,
    };
  }
  const payload = {
    schema: 'squidrun.build1b.main_e28_restoration_watch_lock.v1',
    token,
    pid,
    processCreationUtc,
    createdAt: new Date(nowMs).toISOString(),
  };
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return {
      ok: false,
      reason: error.code === 'EEXIST' ? 'watch_invocation_race_lost' : 'watch_lock_create_failed',
      error: error.message,
    };
  }
  return { ok: true, token, payload, lockPath, staleQuarantine };
}

function releaseInvocationLock(lock) {
  if (!lock?.ok) return;
  const current = readJson(lock.lockPath, null);
  if (!current || current.token !== lock.token) return;
  try {
    fs.unlinkSync(lock.lockPath);
  } catch {}
}

function writeEvent(paths, nowMs, kind, payload = {}) {
  const event = {
    schema: 'squidrun.build1b.main_e28_restoration_watch_event.v1',
    kind,
    capturedAt: new Date(nowMs).toISOString(),
    ...payload,
  };
  const timestamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const eventPath = path.join(paths.watcherReceiptRoot, `${timestamp}-${kind}-${crypto.randomUUID()}.json`);
  writeJsonAtomic(eventPath, event);
  return { event, eventPath };
}

function buildWatcherArguments(context = {}) {
  return [
    `"${context.watcherScriptPath}"`,
    'run',
    '--project-root',
    `"${context.projectRoot}"`,
    '--powershell-path',
    `"${context.powershellPath}"`,
    '--task-name',
    `"${context.taskName}"`,
    '--debounce-ms',
    String(context.debounceMs),
    '--restore-timeout-ms',
    String(context.restoreTimeoutMs),
    '--expected-head',
    String(context.expectedHead),
    '--registration-epoch-ms',
    String(context.registrationEpochMs),
    '--registration-proof-path',
    `"${context.registrationProofPath}"`,
    '--watcher-sha256',
    String(context.sourceIntegrity?.watcher || ''),
    '--restore-sha256',
    String(context.sourceIntegrity?.restore || ''),
    '--module-sha256',
    String(context.sourceIntegrity?.module || ''),
    '--registration-sha256',
    String(context.sourceIntegrity?.registration || ''),
    '--quiet-watch-poll-ms',
    String(context.quietWatchPollMs),
  ].join(' ');
}

function defaultDisableTask(taskName, context = {}) {
  if (!context.powershellPath || !context.registrationScriptPath || !context.projectRoot) {
    return {
      exitCode: 1,
      reason: 'task_control_helper_context_missing',
      ownershipVerified: false,
      stderr: 'PowerShell path, registration helper, or project root is missing.',
    };
  }
  const expectedRegistrationSha256 = String(context.sourceIntegrity?.registration || '').toLowerCase();
  let actualRegistrationSha256 = null;
  try { actualRegistrationSha256 = sha256File(context.registrationScriptPath); } catch {}
  if (!isSha256(expectedRegistrationSha256) || actualRegistrationSha256 !== expectedRegistrationSha256) {
    return {
      exitCode: 1,
      reason: 'task_control_helper_source_integrity_mismatch',
      ownershipVerified: false,
      expectedRegistrationSha256,
      actualRegistrationSha256,
      stderr: 'Refusing to execute a registration helper that differs from the task-bound source hash.',
    };
  }
  const execute = context.runCommand || runCommand;
  const control = execute(context.powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    context.registrationScriptPath,
    '-Action',
    'disable',
    '-TaskName',
    taskName,
  ], {
    cwd: context.projectRoot,
    timeoutMs: 3 * 60 * 1000,
  });
  const payload = parseJsonCommandOutput(control);
  const receiptPath = String(payload?.receiptPath || '');
  const receiptPathAccepted = Boolean(context.receiptRoot)
    && path.isAbsolute(receiptPath)
    && isExistingFileInside(receiptPath, context.receiptRoot);
  const diskPayload = receiptPathAccepted ? readJson(path.resolve(receiptPath), null) : null;
  const payloadMatchesCommittedReceipt = Boolean(diskPayload)
    && canonicalJsonSha256(payload) === canonicalJsonSha256(diskPayload);
  const expectedAnchorPath = path.join(context.receiptRoot, 'task-ownership-anchor.json');
  const exactOwnershipProof = (ownership, expectedEnabled) => ownership?.exists === true
    && ownership?.owned === true
    && ownership?.enabled === expectedEnabled
    && sameResolvedPath(String(ownership?.ownershipAnchorPath || ''), expectedAnchorPath)
    && ownership?.ownershipAnchorShapeValid === true
    && ownership?.registeredXmlArtifactValid === true
    && ownership?.semanticContractShapeValid === true
    && ownership?.watcherArgumentsDigestMatches === true
    && ownership?.semanticValidation?.accepted === true;
  const verifiedDisabled = control.exitCode === 0
    && payload?.schema === 'squidrun.build1b.main_e28_restoration_task_control.v2'
    && payload?.ok === true
    && payload?.action === 'disable'
    && payload?.phase === 'committed_verified'
    && payload?.taskName === taskName
    && receiptPathAccepted
    && payloadMatchesCommittedReceipt
    && exactOwnershipProof(payload?.ownershipBefore, true)
    && exactOwnershipProof(payload?.ownershipImmediateBeforeMutation, true)
    && payload?.operation?.exitCode === 0
    && payload?.operation?.timedOut === false
    && payload?.taskPresenceAfter?.ok === true
    && payload?.taskPresenceAfter?.exists === true
    && payload?.taskPresenceAfter?.enabled === false
    && exactOwnershipProof(payload?.ownershipAfter, false);
  return {
    exitCode: verifiedDisabled ? 0 : 1,
    reason: verifiedDisabled ? 'task_disable_verified_by_control_helper' : 'task_disable_not_verified_by_control_helper',
    ownershipVerified: payload?.ownershipAfter?.owned === true,
    verifiedDisabled,
    receiptPathAccepted,
    payloadMatchesCommittedReceipt,
    control,
    controlReceipt: payload,
    stderr: verifiedDisabled ? '' : String(control.stderr || payload?.error || 'Task disable could not be verified.'),
  };
}

function defaultRunPreflight({ powershellPath, restoreScriptPath, projectRoot }) {
  const command = runCommand(powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    restoreScriptPath,
    '-PreflightOnly',
  ], {
    cwd: projectRoot,
    timeoutMs: 120000,
  });
  return { command, payload: parseJsonCommandOutput(command) };
}

function defaultRunSustainedQuiet({
  powershellPath,
  restoreScriptPath,
  projectRoot,
  durationMs,
  pollIntervalMs,
}) {
  const durationSeconds = Math.max(600, Math.ceil(Number(durationMs) / 1000));
  const command = runCommand(powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    restoreScriptPath,
    '-PreflightOnly',
    '-QuietWatchSeconds',
    String(durationSeconds),
    '-QuietWatchPollMs',
    String(Math.max(10, Number(pollIntervalMs || 10))),
  ], {
    cwd: projectRoot,
    timeoutMs: (durationSeconds * 1000) + (5 * 60 * 1000),
  });
  return { command, payload: parseJsonCommandOutput(command) };
}

function defaultRunRestore({ powershellPath, restoreScriptPath, projectRoot, timeoutMs }) {
  const command = runCommand(powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    restoreScriptPath,
  ], {
    cwd: projectRoot,
    timeoutMs,
  });
  return { command, payload: parseJsonCommandOutput(command) };
}

function summarizeCommand(command) {
  return {
    exitCode: command?.exitCode ?? null,
    signal: command?.signal || null,
    timedOut: Boolean(command?.timedOut),
    error: command?.error || null,
    stderr: String(command?.stderr || '').slice(-4000),
  };
}

function buildState(base, updates, nowMs) {
  return {
    schema: 'squidrun.build1b.main_e28_restoration_watch_state.v1',
    ...base,
    ...updates,
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function runWatchCycle(options, injected = {}) {
  const nowMs = Number(injected.nowMs ?? Date.now());
  const restorationValidationOptions = {
    nowMs,
    sha256FileFn: injected.evidenceSha256File || sha256File,
  };
  const paths = options.paths || resolvePaths(options.projectRoot);
  const taskName = String(options.taskName || DEFAULT_TASK_NAME);
  const expectedHead = String(options.expectedHead || '').toLowerCase();
  const registrationEpochMs = Number(options.registrationEpochMs || 0);
  const debounceMs = Math.max(DEFAULT_DEBOUNCE_MS, Number(options.debounceMs || DEFAULT_DEBOUNCE_MS));
  const restoreTimeoutMs = Math.max(60000, Number(options.restoreTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS));
  const runPreflight = injected.runPreflight || defaultRunPreflight;
  const runSustainedQuiet = injected.runSustainedQuiet || defaultRunSustainedQuiet;
  const runRestore = injected.runRestore || defaultRunRestore;
  const disableTask = injected.disableTask || ((name) => defaultDisableTask(name, {
    watcherScriptPath: paths.watcherScriptPath,
    registrationScriptPath: paths.registrationScriptPath,
    projectRoot: paths.projectRoot,
    receiptRoot: paths.watcherReceiptRoot,
    powershellPath: options.powershellPath,
    taskName,
    debounceMs,
    restoreTimeoutMs,
    expectedHead,
    registrationEpochMs,
    registrationProofPath: paths.registrationProofPath,
    sourceIntegrity: options.sourceIntegrity || {},
    quietWatchPollMs: Number(options.quietWatchPollMs || 10),
  }));
  const acquireLock = injected.acquireLock || (() => acquireInvocationLock({
    lockPath: paths.invocationLockPath,
    powershellPath: options.powershellPath,
    nowMs,
  }));
  const releaseLock = injected.releaseLock || releaseInvocationLock;
  const lock = acquireLock();

  if (!lock.ok) {
    const receipt = writeEvent(paths, nowMs, 'invocation_refusal', {
      ok: false,
      reason: lock.reason,
      taskName,
      lock,
    });
    return { ok: false, exitCode: 0, kind: 'invocation_refusal', receiptPath: receipt.eventPath };
  }

  try {
    const invocationStart = writeEvent(paths, nowMs, 'watcher_invocation_start', {
      ok: true,
      taskName,
      pid: process.pid,
      expectedHead: expectedHead || null,
      registrationEpochMs,
      lock: {
        token: lock.token || null,
        staleQuarantine: lock.staleQuarantine || null,
      },
    });
    const terminalizeContractFailure = (kind, details, message, capturedMs = Date.now()) => {
      const terminalReceipt = {
        schema: 'squidrun.build1b.main_e28_restoration_watch_terminal.v1',
        terminal: true,
        ok: false,
        capturedAt: new Date(capturedMs).toISOString(),
        taskName,
        expectedHead: expectedHead || null,
        registrationEpochMs,
        kind,
        restartState: 'restart_blocked_repair_incomplete',
        terminalPath: paths.terminalPath,
        ...details,
      };
      writeJsonAtomic(paths.terminalPath, terminalReceipt);
      writeJsonAtomic(paths.nextSessionNoticePath, {
        schema: 'squidrun.next_session_notice.v1',
        audience: EXPECTED_NOTICE_AUDIENCE,
        topic: 'build1b-main-e28-restoration',
        status: 'terminal_failure',
        createdAt: new Date(capturedMs).toISOString(),
        message,
        expectedHead: expectedHead || null,
        registrationEpochMs,
        terminalPath: paths.terminalPath,
        restorationReceiptPath: details.restorationReceiptPath || null,
      });
      const disable = disableTask(taskName);
      const event = writeEvent(paths, capturedMs, kind, {
        ok: false,
        taskName,
        invocationStartReceiptPath: invocationStart.eventPath,
        expectedHead: expectedHead || null,
        registrationEpochMs,
        terminalPath: paths.terminalPath,
        ...details,
        disarm: disable,
      });
      writeJsonAtomic(paths.statePath, buildState({}, {
        taskName,
        expectedHead: expectedHead || null,
        registrationEpochMs,
        status: disable.exitCode === 0 ? 'terminal_failure_disarmed' : 'terminal_failure_disarm_pending',
        terminalPath: paths.terminalPath,
        ...details,
      }, capturedMs));
      return { ok: false, exitCode: 0, kind, receiptPath: event.eventPath };
    };

    if (!/^[a-f0-9]{40}$/.test(expectedHead)) {
      return terminalizeContractFailure(
        'registration_contract_failure',
        { registrationContract: { ok: false, reason: 'expected_head_missing_or_invalid' } },
        'Build 1B main E28 restoration watcher refused a task whose registered Git HEAD was missing or invalid. Do not restart or advance to E30.'
      );
    }
    if (!Number.isInteger(registrationEpochMs) || registrationEpochMs <= 0) {
      return terminalizeContractFailure(
        'registration_contract_failure',
        { registrationContract: { ok: false, reason: 'registration_epoch_missing_or_invalid' } },
        'Build 1B main E28 restoration watcher refused a task whose registration epoch was missing or invalid. Do not restart or advance to E30.'
      );
    }
    const sourceIntegrity = verifySourceIntegrity(paths, options.sourceIntegrity || {});
    if (!sourceIntegrity.ok) {
      return terminalizeContractFailure(
        'source_integrity_failure',
        { sourceIntegrity },
        'Build 1B main E28 restoration watcher refused to run because a registered source hash was missing or changed. Do not restart or advance to E30; read the terminal integrity receipt.',
        nowMs
      );
    }
    const registrationProof = verifyRegistrationProof(
      options.registrationProofPath || paths.registrationProofPath,
      {
        taskName,
        expectedHead,
        registrationEpochMs,
        nowMs,
        proofPath: paths.registrationProofPath,
        sourceIntegrity: options.sourceIntegrity || {},
        sourcePaths: {
          watcher: paths.watcherScriptPath,
          restore: paths.restoreScriptPath,
          module: paths.syncModulePath,
          registration: paths.registrationScriptPath,
        },
        watcherArgumentsSha256: crypto.createHash('sha256').update(buildWatcherArguments({
          watcherScriptPath: paths.watcherScriptPath,
          projectRoot: paths.projectRoot,
          powershellPath: options.powershellPath,
          taskName,
          debounceMs,
          restoreTimeoutMs,
          expectedHead,
          registrationEpochMs,
          registrationProofPath: paths.registrationProofPath,
          sourceIntegrity: options.sourceIntegrity || {},
          quietWatchPollMs: Number(options.quietWatchPollMs || 10),
        }), 'utf8').digest('hex'),
      }
    );
    if (registrationProof.pending) {
      const receipt = writeEvent(paths, nowMs, 'registration_proof_pending', {
        ok: false,
        safeToRetry: true,
        taskName,
        expectedHead,
        registrationEpochMs,
        registrationProof,
      });
      writeJsonAtomic(paths.statePath, buildState({}, {
        taskName,
        expectedHead,
        registrationEpochMs,
        status: 'registration_proof_pending',
        registrationProofPath: registrationProof.proofPath,
      }, nowMs));
      return { ok: false, exitCode: 0, kind: 'registration_proof_pending', receiptPath: receipt.eventPath };
    }
    if (!registrationProof.ok) {
      return terminalizeContractFailure(
        'registration_proof_failure',
        { registrationProof },
        'Build 1B main E28 restoration watcher found no committed registration proof for this exact task, HEAD, epoch, and source set. The task was disarmed; do not restart or advance to E30.',
        nowMs
      );
    }
    const recordTargetsCurrentRegistration = (record) => record
      && record.taskName === taskName
      && record.expectedHead === expectedHead
      && Number(record.registrationEpochMs) === registrationEpochMs;

    // A retained terminal for this exact task registration always outranks
    // done/recovery. Once a run terminalizes, an older same-head success may not
    // resurrect it on a later scheduled fire.
    const terminalPresent = fs.existsSync(paths.terminalPath);
    const terminal = readJson(paths.terminalPath, null);
    if (terminalPresent && !terminal) {
      return terminalizeContractFailure(
        'retained_terminal_receipt_invalid',
        { retainedTerminalValidation: { ok: false, errors: ['unreadable_or_invalid_json'] } },
        'Build 1B main E28 restoration found an unreadable retained terminal receipt. The task was disarmed; do not restart or advance to E30.'
      );
    }
    const terminalTargetsTaskAndHead = terminal
      && terminal.taskName === taskName
      && terminal.expectedHead === expectedHead;
    if (terminalTargetsTaskAndHead
      && (!Number.isInteger(terminal.registrationEpochMs) || terminal.registrationEpochMs <= 0)) {
      return terminalizeContractFailure(
        'retained_terminal_receipt_invalid',
        { retainedTerminalValidation: { ok: false, errors: ['registration_epoch'] }, retainedTerminal: terminal },
        'Build 1B main E28 restoration found a retained terminal receipt for this task and HEAD with no valid registration epoch. The task was disarmed; do not restart or advance to E30.'
      );
    }
    if (recordTargetsCurrentRegistration(terminal)) {
      const terminalValidation = validateTerminalReceipt(
        terminal,
        paths,
        expectedHead,
        taskName,
        registrationEpochMs,
        restorationValidationOptions
      );
      if (!terminalValidation.ok) {
        return terminalizeContractFailure(
          'retained_terminal_receipt_invalid',
          { retainedTerminalValidation: terminalValidation, retainedTerminal: terminal },
          'Build 1B main E28 restoration found a malformed retained terminal receipt. The task was disarmed; do not restart or advance to E30.'
        );
      }
      const restorationReceiptPath = terminal.restorationReceiptPath || null;
      const existingNotice = readJson(paths.nextSessionNoticePath, null);
      if (!noticeMatches(existingNotice, {
        status: 'terminal_failure',
        anchorKey: 'terminalPath',
        anchorPath: paths.terminalPath,
          expectedHead,
          registrationEpochMs,
          restorationReceiptPath,
          nowMs,
      })) {
        writeJsonAtomic(paths.nextSessionNoticePath, {
          schema: 'squidrun.next_session_notice.v1',
          audience: EXPECTED_NOTICE_AUDIENCE,
          topic: 'build1b-main-e28-restoration',
          status: 'terminal_failure',
          createdAt: new Date(nowMs).toISOString(),
          message: 'Build 1B main E28 restoration previously aborted or failed. The watcher repaired a missing next-session notice from the retained terminal receipt; do not restart or advance to E30.',
          terminalPath: paths.terminalPath,
          restorationReceiptPath,
          expectedHead,
          registrationEpochMs,
          recoveredFromTerminalReceipt: true,
        });
      }
      const disable = disableTask(taskName);
      const receipt = writeEvent(paths, nowMs, 'terminal_failure_short_circuit', {
        ok: false,
        taskName,
        expectedHead,
        registrationEpochMs,
        invocationStartReceiptPath: invocationStart.eventPath,
        terminalPath: paths.terminalPath,
        disarm: disable,
      });
      writeJsonAtomic(paths.statePath, buildState({}, {
        taskName,
        expectedHead,
        registrationEpochMs,
        status: disable.exitCode === 0 ? 'terminal_failure_disarmed' : 'terminal_failure_disarm_pending',
        terminalPath: paths.terminalPath,
      }, nowMs));
      return {
        ok: false,
        exitCode: 0,
        kind: disable.exitCode === 0 ? 'terminal_failure_short_circuit' : 'terminal_failure_disarm_pending',
        receiptPath: receipt.eventPath,
      };
    }
    if (terminal) {
      writeEvent(paths, nowMs, 'stale_terminal_ignored', {
        ok: false,
        taskName,
        expectedHead,
        registrationEpochMs,
        terminalExpectedHead: terminal.expectedHead || null,
        terminalRegistrationEpochMs: terminal.registrationEpochMs || null,
        terminalPath: paths.terminalPath,
      });
    }

    const donePresent = fs.existsSync(paths.donePath);
    const done = readJson(paths.donePath, null);
    if (donePresent && !done) {
      return terminalizeContractFailure(
        'retained_done_receipt_invalid',
        { retainedDoneValidation: { ok: false, errors: ['unreadable_or_invalid_json'] } },
        'Build 1B main E28 restoration found an unreadable retained done receipt. The task was disarmed; do not restart or advance to E30.'
      );
    }
    if (recordTargetsCurrentRegistration(done)) {
      const doneValidation = validateDoneReceipt(done, paths, expectedHead, taskName, registrationEpochMs, restorationValidationOptions);
      if (!doneValidation.ok) {
        return terminalizeContractFailure(
          'retained_done_receipt_invalid',
          { retainedDoneValidation: doneValidation, retainedDone: done },
          'Build 1B main E28 restoration found a malformed retained done receipt. The task was disarmed; do not restart or advance to E30.'
        );
      }
      const existingNotice = readJson(paths.nextSessionNoticePath, null);
      if (!noticeMatches(existingNotice, {
        status: 'complete',
        anchorKey: 'donePath',
        anchorPath: paths.donePath,
        expectedHead,
        registrationEpochMs,
        restorationReceiptPath: done.restorationReceiptPath,
        nowMs,
      })) {
        writeJsonAtomic(paths.nextSessionNoticePath, {
          schema: 'squidrun.next_session_notice.v1',
          audience: EXPECTED_NOTICE_AUDIENCE,
          topic: 'build1b-main-e28-restoration',
          status: 'complete',
          createdAt: new Date(nowMs).toISOString(),
          message: 'Build 1B main E28 restoration completed. The watcher repaired a missing next-session notice from the retained done receipt; read the restoration receipt before any E30 decision.',
          donePath: paths.donePath,
          restorationReceiptPath: done.restorationReceiptPath,
          expectedHead,
          registrationEpochMs,
          recoveredFromDoneReceipt: true,
        });
      }
      const disable = disableTask(taskName);
      const receipt = writeEvent(paths, nowMs, 'already_done_short_circuit', {
        ok: disable.exitCode === 0,
        taskName,
        expectedHead,
        registrationEpochMs,
        invocationStartReceiptPath: invocationStart.eventPath,
        donePath: paths.donePath,
        disarm: disable,
      });
      writeJsonAtomic(paths.statePath, buildState({}, {
        taskName,
        expectedHead,
        registrationEpochMs,
        status: disable.exitCode === 0 ? 'complete_disarmed' : 'complete_disarm_pending',
        donePath: paths.donePath,
        restorationReceiptPath: done.restorationReceiptPath,
      }, nowMs));
      return {
        ok: disable.exitCode === 0,
        restorationOk: true,
        exitCode: 0,
        kind: disable.exitCode === 0 ? 'already_done_short_circuit' : 'already_done_disarm_pending',
        receiptPath: receipt.eventPath,
      };
    }
    if (done) {
      writeEvent(paths, nowMs, 'stale_done_ignored', {
        ok: false,
        taskName,
        expectedHead,
        registrationEpochMs,
        doneExpectedHead: done.expectedHead || null,
        doneRegistrationEpochMs: done.registrationEpochMs || null,
        donePath: paths.donePath,
      });
    }

    // Crash-window closure: a fatal runner outcome is terminal authority even
    // if the watcher died after parking the event but before terminal.json.
    const retainedFailureOutcome = findBlockingRecoveryOutcome(
      paths.watcherReceiptRoot,
      taskName,
      expectedHead,
      registrationEpochMs,
      null,
      nowMs
    );
    if (retainedFailureOutcome) {
      return terminalizeContractFailure(
        'recovery_blocked_by_prior_failure_outcome',
        {
          blockingRecoveryOutcomePath: retainedFailureOutcome.eventPath,
          blockingRecoveryOutcome: retainedFailureOutcome.event,
        },
        'Build 1B main E28 restoration recovered a retained fatal runner handoff. The task was disarmed; do not repeat restoration, restart, or advance to E30.',
        nowMs
      );
    }

    // Only a fully validated success receipt created at or after this exact
    // task registration can be promoted to done.
    const recoveredSuccess = findSuccessfulRestorationReceipt(
      paths.restorationReceiptRoot,
      expectedHead,
      registrationEpochMs,
      restorationValidationOptions
    );
    if (recoveredSuccess) {
      const blockingRecoveryOutcome = findBlockingRecoveryOutcome(
        paths.watcherReceiptRoot,
        taskName,
        expectedHead,
          registrationEpochMs,
          recoveredSuccess.receiptPath,
          nowMs
      );
      if (blockingRecoveryOutcome) {
        return terminalizeContractFailure(
          'recovery_blocked_by_prior_failure_outcome',
          {
            restorationReceiptPath: recoveredSuccess.receiptPath,
            blockingRecoveryOutcomePath: blockingRecoveryOutcome.eventPath,
            blockingRecoveryOutcome: blockingRecoveryOutcome.event,
          },
          'Build 1B main E28 restoration found a prior failure handoff for the candidate recovery receipt. The task was disarmed; do not promote the raw receipt, restart, or advance to E30.',
          nowMs
        );
      }
      const recoveredDone = {
        schema: 'squidrun.build1b.main_e28_restoration_watch_done.v1',
        ok: true,
        recoveredAfterWatcherInterruption: true,
        completedAt: new Date(nowMs).toISOString(),
        taskName,
        expectedHead,
        registrationEpochMs,
        restorationReceiptPath: recoveredSuccess.receiptPath,
        restartState: recoveredSuccess.payload.restartState,
      };
      writeJsonAtomic(paths.donePath, recoveredDone);
      writeJsonAtomic(paths.nextSessionNoticePath, {
        schema: 'squidrun.next_session_notice.v1',
        audience: EXPECTED_NOTICE_AUDIENCE,
        topic: 'build1b-main-e28-restoration',
        status: 'complete',
        createdAt: new Date(nowMs).toISOString(),
        message: 'Build 1B main E28 restoration completed; the stateless watcher recovered the runner success receipt after an interrupted post-run handoff and disarmed without repeating restoration.',
        donePath: paths.donePath,
        restorationReceiptPath: recoveredSuccess.receiptPath,
        expectedHead,
        registrationEpochMs,
      });
      const disable = disableTask(taskName);
      const receipt = writeEvent(paths, nowMs, 'recovered_success_disarm', {
        ok: disable.exitCode === 0,
        taskName,
        expectedHead,
        registrationEpochMs,
        invocationStartReceiptPath: invocationStart.eventPath,
        donePath: paths.donePath,
        restorationReceiptPath: recoveredSuccess.receiptPath,
        disarm: disable,
      });
      writeJsonAtomic(paths.statePath, buildState({}, {
        taskName,
        expectedHead,
        registrationEpochMs,
        status: disable.exitCode === 0 ? 'complete_disarmed' : 'complete_disarm_pending',
        donePath: paths.donePath,
        restorationReceiptPath: recoveredSuccess.receiptPath,
        recoveredAfterWatcherInterruption: true,
      }, nowMs));
      return {
        ok: disable.exitCode === 0,
        restorationOk: true,
        exitCode: 0,
        kind: disable.exitCode === 0 ? 'recovered_success_disarm' : 'recovered_success_disarm_pending',
        receiptPath: receipt.eventPath,
      };
    }

    const priorState = readJson(paths.statePath, {}) || {};
    const preflight = runPreflight({
      powershellPath: options.powershellPath,
      restoreScriptPath: paths.restoreScriptPath,
      projectRoot: paths.projectRoot,
    });
    if (preflight.command?.exitCode !== 0 || !preflight.payload) {
      const state = buildState(priorState, {
        taskName,
        status: 'preflight_error',
        firstQuietSeenAtMs: null,
        firstQuietSeenAt: null,
        lastPreflight: summarizeCommand(preflight.command),
      }, nowMs);
      writeJsonAtomic(paths.statePath, state);
      const receipt = writeEvent(paths, nowMs, 'preflight_error', {
        ok: false,
        taskName,
        command: summarizeCommand(preflight.command),
      });
      return { ok: false, exitCode: 0, kind: 'preflight_error', receiptPath: receipt.eventPath };
    }

    if (String(preflight.payload.head || '').toLowerCase() !== expectedHead) {
      return terminalizeContractFailure(
        'expected_head_mismatch',
        { headBinding: { ok: false, stage: 'initial_preflight', expectedHead, actualHead: preflight.payload.head || null } },
        'Build 1B main E28 restoration watcher observed a Git HEAD different from the registered task. The stale task was disarmed; do not restart or advance to E30.',
        nowMs
      );
    }

    if (preflight.payload.ok !== true) {
      const state = buildState(priorState, {
        taskName,
        status: 'waiting_for_full_quiet',
        firstQuietSeenAtMs: null,
        firstQuietSeenAt: null,
        lastPreflightAt: new Date(nowMs).toISOString(),
        lastPreflightReason: preflight.payload.reason || null,
        lastActiveProjectProcessCount: Number(preflight.payload.activeProjectProcessCount || 0),
      }, nowMs);
      writeJsonAtomic(paths.statePath, state);
      const receipt = writeEvent(paths, nowMs, 'quiet_refusal', {
        ok: false,
        safeToRetry: true,
        taskName,
        preflight: preflight.payload,
      });
      return { ok: false, exitCode: 0, kind: 'quiet_refusal', receiptPath: receipt.eventPath };
    }

    const sustainedLaunchReceipt = writeEvent(paths, nowMs, 'sustained_quiet_watch_launch', {
      ok: true,
      taskName,
      requiredDurationMs: debounceMs,
      exactPredicate: 'hm-restore-main-e28-coherence.ps1 -PreflightOnly -QuietWatchSeconds',
    });
    writeJsonAtomic(paths.statePath, buildState(priorState, {
      taskName,
      status: 'sustained_quiet_monitoring',
      firstQuietSeenAtMs: null,
      firstQuietSeenAt: null,
      requiredDurationMs: debounceMs,
      sustainedLaunchReceiptPath: sustainedLaunchReceipt.eventPath,
      lastPreflightAt: new Date(nowMs).toISOString(),
    }, nowMs));
    const sustainedQuiet = runSustainedQuiet({
      powershellPath: options.powershellPath,
      restoreScriptPath: paths.restoreScriptPath,
      projectRoot: paths.projectRoot,
      durationMs: debounceMs,
      pollIntervalMs: Number(options.quietWatchPollMs || 10),
    });
    const requiredDurationSeconds = Math.ceil(debounceMs / 1000);
    const sustainedProof = sustainedQuiet.payload?.sustainedQuiet || null;
    const quietElapsedMs = Math.floor(Number(sustainedProof?.elapsedSeconds || 0) * 1000);
    const sustainedProofOk = sustainedQuiet.command?.exitCode === 0
      && sustainedQuiet.payload?.ok === true
      && sustainedProof?.ok === true
      && Number(sustainedProof?.requiredDurationSeconds || 0) >= requiredDurationSeconds
      && quietElapsedMs >= debounceMs;
    if (!sustainedProofOk) {
      const state = buildState(priorState, {
        taskName,
        status: 'sustained_quiet_refusal',
        firstQuietSeenAtMs: null,
        firstQuietSeenAt: null,
        requiredDurationMs: debounceMs,
        sustainedLaunchReceiptPath: sustainedLaunchReceipt.eventPath,
        lastSustainedQuietCommand: summarizeCommand(sustainedQuiet.command),
        lastSustainedQuietReason: sustainedQuiet.payload?.reason || 'sustained_quiet_command_failed',
        sustainedProofOk,
        quietElapsedMs,
      }, Date.now());
      writeJsonAtomic(paths.statePath, state);
      const receipt = writeEvent(paths, Date.now(), 'sustained_quiet_refusal', {
        ok: false,
        safeToRetry: true,
        taskName,
        sustainedLaunchReceiptPath: sustainedLaunchReceipt.eventPath,
        command: summarizeCommand(sustainedQuiet.command),
        preflight: sustainedQuiet.payload || null,
        sustainedProofOk,
        quietElapsedMs,
      });
      return { ok: false, exitCode: 0, kind: 'sustained_quiet_refusal', receiptPath: receipt.eventPath };
    }

    const sourceIntegrityAfterSustained = verifySourceIntegrity(paths, options.sourceIntegrity || {});
    if (!sourceIntegrityAfterSustained.ok) {
      return terminalizeContractFailure(
        'source_integrity_changed_during_quiet_watch',
        { sourceIntegrity: sourceIntegrityAfterSustained },
        'Build 1B main E28 restoration watcher detected registered source drift during the sustained quiet monitor. The stale task was disarmed; do not restart or advance to E30.'
      );
    }

    const launchPreflight = runPreflight({
      powershellPath: options.powershellPath,
      restoreScriptPath: paths.restoreScriptPath,
      projectRoot: paths.projectRoot,
    });
    if (launchPreflight.command?.exitCode !== 0 || launchPreflight.payload?.ok !== true) {
      const state = buildState(priorState, {
        taskName,
        status: 'launch_recheck_refusal',
        firstQuietSeenAtMs: null,
        firstQuietSeenAt: null,
        lastPreflightAt: new Date(nowMs).toISOString(),
        lastPreflightReason: launchPreflight.payload?.reason || 'launch_recheck_command_failed',
      }, nowMs);
      writeJsonAtomic(paths.statePath, state);
      const receipt = writeEvent(paths, nowMs, 'launch_recheck_refusal', {
        ok: false,
        safeToRetry: true,
        taskName,
        command: summarizeCommand(launchPreflight.command),
        preflight: launchPreflight.payload || null,
      });
      return { ok: false, exitCode: 0, kind: 'launch_recheck_refusal', receiptPath: receipt.eventPath };
    }

    if (String(launchPreflight.payload.head || '').toLowerCase() !== expectedHead) {
      return terminalizeContractFailure(
        'expected_head_mismatch',
        { headBinding: { ok: false, stage: 'launch_preflight', expectedHead, actualHead: launchPreflight.payload.head || null } },
        'Build 1B main E28 restoration watcher observed a Git HEAD change immediately before restore. The stale task was disarmed; do not restart or advance to E30.'
      );
    }

    const sourceIntegrityBeforeRestore = verifySourceIntegrity(paths, options.sourceIntegrity || {});
    if (!sourceIntegrityBeforeRestore.ok) {
      return terminalizeContractFailure(
        'source_integrity_changed_before_restore',
        { sourceIntegrity: sourceIntegrityBeforeRestore },
        'Build 1B main E28 restoration watcher detected registered source drift immediately before restore. The stale task was disarmed; do not restart or advance to E30.'
      );
    }

    const launchReceipt = writeEvent(paths, nowMs, 'restore_launch', {
      ok: true,
      taskName,
      registrationEpochMs,
      quietElapsedMs,
      debounceMs,
      sustainedQuietReceiptPath: sustainedLaunchReceipt.eventPath,
      sustainedQuiet: sustainedQuiet.payload.sustainedQuiet,
      launchPreflight: launchPreflight.payload,
      expectedHead,
      sourceIntegrityAfterSustained,
      sourceIntegrityBeforeRestore,
      restoreScriptPath: paths.restoreScriptPath,
    });
    const restore = runRestore({
      powershellPath: options.powershellPath,
      restoreScriptPath: paths.restoreScriptPath,
      projectRoot: paths.projectRoot,
      timeoutMs: restoreTimeoutMs,
    });
    const restoreExitCode = Number(restore.command?.exitCode ?? 1);
    const restorePayload = restore.payload || null;
    const sourceIntegrityAfterRestore = verifySourceIntegrity(paths, options.sourceIntegrity || {});
    const restorationReceiptValidation = readAndValidateRestorationReceipt(
      restorePayload?.receiptPath,
      expectedHead,
      paths.restorationReceiptRoot,
      registrationEpochMs,
      restorationValidationOptions
    );
    const reportedPayloadMatchesReceipt = restorationReceiptValidation.ok
      && restorePayload && typeof restorePayload === 'object' && !Array.isArray(restorePayload)
      && canonicalJsonSha256(restorePayload) === canonicalJsonSha256(restorationReceiptValidation.payload);
    const restoreSucceeded = restoreExitCode === 0
      && sourceIntegrityAfterRestore.ok
      && restorationReceiptValidation.ok
      && reportedPayloadMatchesReceipt;
    const safeRetryRefusal = SAFE_RETRY_EXIT_CODES.has(restoreExitCode)
      && sourceIntegrityAfterRestore.ok
      && restorePayload?.ok !== true;
    const completionKind = restoreSucceeded
      ? 'script_completion'
      : (safeRetryRefusal ? 'script_refusal' : 'script_abort_or_failure');
    const completionReceipt = writeEvent(paths, Date.now(), completionKind, {
      ok: restoreSucceeded,
      taskName,
      expectedHead,
      registrationEpochMs,
      launchReceiptPath: launchReceipt.eventPath,
      command: summarizeCommand(restore.command),
      restoration: restorePayload,
      sourceIntegrityAfterRestore,
      restorationReceiptValidation: {
        ok: restorationReceiptValidation.ok,
        errors: restorationReceiptValidation.errors || [],
        receiptPath: restorationReceiptValidation.receiptPath || null,
        reportedPayloadMatchesReceipt,
      },
    });

    if (restoreSucceeded) {
      const canonicalRestoration = restorationReceiptValidation.payload;
      const doneReceipt = {
        schema: 'squidrun.build1b.main_e28_restoration_watch_done.v1',
        ok: true,
        completedAt: new Date().toISOString(),
        taskName,
        expectedHead,
        registrationEpochMs,
        launchReceiptPath: launchReceipt.eventPath,
        completionReceiptPath: completionReceipt.eventPath,
        restorationReceiptPath: restorationReceiptValidation.receiptPath,
        restartState: canonicalRestoration.restartState,
      };
      writeJsonAtomic(paths.donePath, doneReceipt);
      writeJsonAtomic(paths.nextSessionNoticePath, {
        schema: 'squidrun.next_session_notice.v1',
        audience: EXPECTED_NOTICE_AUDIENCE,
        topic: 'build1b-main-e28-restoration',
        status: 'complete',
        createdAt: new Date().toISOString(),
        message: 'Build 1B main E28 dependency restoration completed in a sustained natural quiet window. Read the retained watcher and restoration receipts before any E30 decision.',
        donePath: paths.donePath,
        restorationReceiptPath: restorationReceiptValidation.receiptPath,
        expectedHead,
        registrationEpochMs,
      });
      const disable = disableTask(taskName);
      const disarmReceipt = writeEvent(paths, Date.now(), 'task_disarm_after_success', {
        ok: disable.exitCode === 0,
        taskName,
        donePath: paths.donePath,
        disarm: disable,
      });
      writeJsonAtomic(paths.statePath, buildState(priorState, {
        taskName,
        expectedHead,
        registrationEpochMs,
        status: disable.exitCode === 0 ? 'complete_disarmed' : 'complete_disarm_pending',
        firstQuietSeenAtMs: null,
        firstQuietSeenAt: null,
        sustainedQuietStartedAt: sustainedQuiet.payload.sustainedQuiet?.startedAtUtc || null,
        quietElapsedMs,
        donePath: paths.donePath,
        restorationReceiptPath: restorationReceiptValidation.receiptPath,
        disarmReceiptPath: disarmReceipt.eventPath,
      }, Date.now()));
      return {
        ok: disable.exitCode === 0,
        restorationOk: true,
        exitCode: 0,
        kind: disable.exitCode === 0 ? 'script_completion' : 'script_completion_disarm_pending',
        receiptPath: completionReceipt.eventPath,
      };
    }

    if (safeRetryRefusal) {
      writeJsonAtomic(paths.statePath, buildState(priorState, {
        taskName,
        expectedHead,
        registrationEpochMs,
        status: 'safe_refusal_waiting_for_new_debounce',
        firstQuietSeenAtMs: null,
        firstQuietSeenAt: null,
        lastRestoreExitCode: restoreExitCode,
        lastRestoreKind: restorePayload?.kind || null,
        lastCompletionReceiptPath: completionReceipt.eventPath,
      }, Date.now()));
      return { ok: false, exitCode: 0, kind: 'script_refusal', receiptPath: completionReceipt.eventPath };
    }

      const terminalReceipt = {
      schema: 'squidrun.build1b.main_e28_restoration_watch_terminal.v1',
      terminal: true,
      ok: false,
      capturedAt: new Date().toISOString(),
      taskName,
      expectedHead,
      registrationEpochMs,
      terminalPath: paths.terminalPath,
      restoreExitCode,
      restoreKind: restorePayload?.kind || null,
      completionReceiptPath: completionReceipt.eventPath,
      restorationReceiptPath: restorationReceiptValidation.ok ? restorationReceiptValidation.receiptPath : null,
      reportedRestorationReceiptPath: restorePayload?.receiptPath || null,
      reportedRestartState: restorePayload?.restartState || null,
      restartState: 'restart_blocked_repair_incomplete',
    };
    writeJsonAtomic(paths.terminalPath, terminalReceipt);
    writeJsonAtomic(paths.nextSessionNoticePath, {
      schema: 'squidrun.next_session_notice.v1',
      audience: EXPECTED_NOTICE_AUDIENCE,
      topic: 'build1b-main-e28-restoration',
      status: 'terminal_failure',
      createdAt: new Date().toISOString(),
      message: 'Build 1B main E28 restoration aborted or failed after launch. Do not restart or advance to E30; read the terminal and restoration receipts.',
      terminalPath: paths.terminalPath,
      restorationReceiptPath: restorationReceiptValidation.ok ? restorationReceiptValidation.receiptPath : null,
      expectedHead,
      registrationEpochMs,
    });
    const disable = disableTask(taskName);
    writeEvent(paths, Date.now(), 'task_disarm_after_terminal_failure', {
      ok: disable.exitCode === 0,
      taskName,
      terminalPath: paths.terminalPath,
      disarm: disable,
    });
    writeJsonAtomic(paths.statePath, buildState(priorState, {
      taskName,
      expectedHead,
      registrationEpochMs,
      status: disable.exitCode === 0 ? 'terminal_failure_disarmed' : 'terminal_failure_disarm_pending',
      terminalPath: paths.terminalPath,
      lastRestoreExitCode: restoreExitCode,
    }, Date.now()));
    return { ok: false, exitCode: 0, kind: 'script_abort_or_failure', receiptPath: completionReceipt.eventPath };
  } finally {
    releaseLock(lock);
  }
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node hm-main-e28-restoration-watch.js run --project-root <path> --powershell-path <pwsh.exe> --expected-head <sha> --registration-epoch-ms <n> --registration-proof-path <path> --watcher-sha256 <sha> --restore-sha256 <sha> --module-sha256 <sha> --registration-sha256 <sha> [--task-name <name>] [--debounce-ms <n>] [--quiet-watch-poll-ms <n>] [--restore-timeout-ms <n>]',
    '  node hm-main-e28-restoration-watch.js status --project-root <path>',
    '',
  ].join('\n'));
}

function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const projectRoot = flags['project-root'] ? path.resolve(flags['project-root']) : null;
  if (!command || !projectRoot) {
    printUsage();
    return 2;
  }
  const paths = resolvePaths(projectRoot);
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify({
      taskName: flags['task-name'] || DEFAULT_TASK_NAME,
      paths,
      state: readJson(paths.statePath, null),
      done: readJson(paths.donePath, null),
      terminal: readJson(paths.terminalPath, null),
    }, null, 2)}\n`);
    return 0;
  }
  if (command !== 'run' || !flags['powershell-path']) {
    printUsage();
    return 2;
  }
  const result = runWatchCycle({
    projectRoot,
    paths,
    powershellPath: path.resolve(flags['powershell-path']),
    taskName: flags['task-name'] || DEFAULT_TASK_NAME,
    debounceMs: Number(flags['debounce-ms'] || DEFAULT_DEBOUNCE_MS),
    quietWatchPollMs: Number(flags['quiet-watch-poll-ms'] || 10),
    restoreTimeoutMs: Number(flags['restore-timeout-ms'] || DEFAULT_COMMAND_TIMEOUT_MS),
    expectedHead: flags['expected-head'] || '',
    registrationEpochMs: Number(flags['registration-epoch-ms'] || 0),
    registrationProofPath: flags['registration-proof-path']
      ? path.resolve(flags['registration-proof-path'])
      : paths.registrationProofPath,
    sourceIntegrity: {
      watcher: flags['watcher-sha256'] || '',
      restore: flags['restore-sha256'] || '',
      module: flags['module-sha256'] || '',
      registration: flags['registration-sha256'] || '',
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return Number(result.exitCode || 0);
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  DEFAULT_TASK_NAME,
  DEFAULT_DEBOUNCE_MS,
  LOCK_PARSE_GRACE_MS,
  SAFE_RETRY_EXIT_CODES,
  parseArgs,
  readJson,
  writeJsonAtomic,
  sha256File,
  verifySourceIntegrity,
  validateRestorationPayload,
  readAndValidateRestorationReceipt,
  validateDoneReceipt,
  validateTerminalReceipt,
  verifyRegistrationProof,
  noticeMatches,
  buildWatcherArguments,
  defaultDisableTask,
  isPidAlive,
  runCommand,
  parseJsonCommandOutput,
  resolvePaths,
  findSuccessfulRestorationReceipt,
  findBlockingRecoveryOutcome,
  acquireInvocationLock,
  releaseInvocationLock,
  runWatchCycle,
  main,
};
