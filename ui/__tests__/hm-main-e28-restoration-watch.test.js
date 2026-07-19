'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  DEFAULT_DEBOUNCE_MS,
  LOCK_PARSE_GRACE_MS,
  acquireInvocationLock,
  buildWatcherArguments,
  defaultDisableTask,
  findSuccessfulRestorationReceipt,
  noticeMatches,
  readAndValidateRestorationReceipt,
  releaseInvocationLock,
  resolvePaths,
  runWatchCycle,
  sha256File,
  verifySourceIntegrity,
} = require('../scripts/hm-main-e28-restoration-watch');

const EXPECTED_HEAD = 'a'.repeat(40);
const REGISTRATION_EPOCH_MS = 1_000;
const H6_NATIVE_SHA256 = 'c70d26297d94aa370abc3c1ba83ddda692a8a7c4ba1f4ca70b4707a326b31894';
const H6_WINDOW_SHA256 = '2711f2f68753be374a9ef8a7056146f24c900b889ab349ff7b30e56f72e62f50';
const H6_STAGE_SHA256 = '22232119828b65f30442b90880ed11eb011a26989ff0ba0ae00eafa6aadda92a';
const DAMAGE_SHA256 = '372e241c948f7b87c1403f25d44ee85d1db2bc8e067b970794564ef24bdef7e9';

function quietPayload(head = EXPECTED_HEAD) {
  return {
    schema: 'squidrun.build1b.main_e28_restoration_preflight.v1',
    ok: true,
    reason: 'natural_quiet_window_present',
    activeProjectProcessCount: 0,
    head,
  };
}

function activePayload(count = 2) {
  return {
    schema: 'squidrun.build1b.main_e28_restoration_preflight.v1',
    ok: false,
    reason: 'natural_quiet_window_absent_refusing_loaded_tree_mutation',
    activeProjectProcessCount: count,
    activeProjectProcesses: [{ ProcessId: 100 }, { ProcessId: 101 }].slice(0, count),
    head: EXPECTED_HEAD,
  };
}

function command(exitCode = 0) {
  return { exitCode, stdout: '', stderr: '', timedOut: false };
}

describe('hm-main-e28-restoration-watch', () => {
  test('PowerShell packet scripts contain no ambiguous null-conditional variable syntax', () => {
    const scripts = [
      'hm-register-main-e28-restoration-watch.ps1',
      'hm-restore-main-e28-coherence.ps1',
      'hm-rehearse-main-e28-tree-sync.ps1',
      'hm-main-e28-tree-sync.psm1',
    ];

    for (const script of scripts) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', script), 'utf8');
      expect(source.match(/\$[A-Za-z_][A-Za-z0-9_]*\?\./g) || []).toEqual([]);
    }
  });

  test('registration task XML uses the UTF-16LE BOM contract required by schtasks.exe', () => {
    const source = fs.readFileSync(path.join(
      __dirname,
      '..',
      'scripts',
      'hm-register-main-e28-restoration-watch.ps1'
    ), 'utf8');
    const writer = source.match(/function Write-TextAtomic[\s\S]*?function Enter-TaskMutationMutex/);

    expect(writer).not.toBeNull();
    expect(writer[0]).toContain('[Text.UnicodeEncoding]::new($false, $true, $true)');
    expect(writer[0]).toContain('$encoding.GetPreamble()');
    expect(source).toContain('<?xml version="1.0" encoding="UTF-16"?>');
    expect(source).not.toContain('<?xml version="1.0" encoding="UTF-8"?>');
  });

  let root;
  let paths;
  let defaultSourceIntegrity;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-e28-watch-'));
    paths = resolvePaths(root);
    for (const [filePath, value] of [
      [paths.watcherScriptPath, 'watcher'],
      [paths.restoreScriptPath, 'restore'],
      [paths.syncModulePath, 'module'],
      [paths.registrationScriptPath, 'registration'],
    ]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, value, 'utf8');
    }
    defaultSourceIntegrity = {
      watcher: sha256File(paths.watcherScriptPath),
      restore: sha256File(paths.restoreScriptPath),
      module: sha256File(paths.syncModulePath),
      registration: sha256File(paths.registrationScriptPath),
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function evidenceSha256File(filePath) {
    const normalized = path.resolve(filePath).toLowerCase();
    if (normalized.endsWith('rollback-native-e28-2db3e392.json')) return H6_NATIVE_SHA256;
    if (normalized.endsWith(path.join('rollback-windows-e28-2db3e392', 'window-capture-receipt.json').toLowerCase())) return H6_WINDOW_SHA256;
    if (normalized.endsWith('stage-receipt-2db3e392.json')) return H6_STAGE_SHA256;
    if (normalized.endsWith('main-node-modules-damage-characterization.json')) return DAMAGE_SHA256;
    return sha256File(filePath);
  }

  function writeSuccessfulRestorationReceipt(capturedMs, head = EXPECTED_HEAD, overrides = {}) {
    fs.mkdirSync(paths.restorationReceiptRoot, { recursive: true });
    const receiptPath = path.join(
      paths.restorationReceiptRoot,
      `${String(capturedMs).padStart(14, '0')}-${Math.random().toString(16).slice(2)}-main-e28-restoration.json`
    );
    const runId = path.basename(receiptPath).replace(/-main-e28-restoration\.json$/, '');
    const hash = 'b'.repeat(64);
    const expectedReferenceRoot = path.join(
      path.dirname(root),
      '_archive',
      'squidrun-worktrees',
      'squidrun-build1b-main-e28-reference'
    );
    const h6NativePath = path.join(root, '.squidrun', 'coord', 'build1b-e29-s480', 'rollback-native-e28-2db3e392.json');
    const h6WindowPath = path.join(root, '.squidrun', 'coord', 'build1b-e29-s480', 'rollback-windows-e28-2db3e392', 'window-capture-receipt.json');
    const h6StagePath = path.join(root, '.squidrun', 'coord', 'build1b-e29-s480', 'stage-receipt-2db3e392.json');
    const damagePath = path.join(root, '.squidrun', 'coord', 'build1b-e29-s480', 'main-node-modules-damage-characterization.json');
    const fullSuiteLog = path.join(paths.restorationReceiptRoot, `${runId}-full-suite.log`);
    const commsLog = path.join(paths.restorationReceiptRoot, `${runId}-comms.log`);
    const eolLog = path.join(paths.restorationReceiptRoot, `${runId}-eol.log`);
    for (const evidencePath of [h6NativePath, h6WindowPath, h6StagePath, damagePath, fullSuiteLog, commsLog, eolLog]) {
      fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
      fs.writeFileSync(evidencePath, 'fixture', 'utf8');
    }
    const sourceHashes = {
      'ui/package.json': hash,
      'ui/package-lock.json': hash,
      'ui/scripts/restore.ps1': hash,
      'ui/scripts/sync.psm1': hash,
      'ui/scripts/watch.js': hash,
    };
    const sourceProvenance = (stage) => ({
      stage,
      branch: 'main',
      head,
      trackedUiWorktreeClean: true,
      trackedUiIndexClean: true,
      hashes: sourceHashes,
      packageElectron: '28.3.3',
      lockRootElectron: '28.3.3',
      lockElectron: '28.3.3',
    });
    const manifest = (stage) => ({
      stage,
      trackedFileCount: 100,
      trackedBytes: 1000,
      sha256: hash,
    });
    const referenceProvenance = (stage) => ({
      stage,
      head,
      trackedStatus: [],
      trackedClean: true,
      lockHashMode: 'utf8_lf_normalized',
      mainLockSha256: hash,
      referenceLockSha256: hash,
      lockMatchesMain: true,
    });
    const nativeHashes = [
      ['better-sqlite3', 'better-sqlite3\\build\\Release\\better_sqlite3.node'],
      ['node-pty', 'node-pty\\build\\Release\\pty.node'],
      ['sharp', 'sharp\\build\\Release\\sharp.node'],
      ['onnxruntime-node', 'onnxruntime-node\\bin\\onnxruntime.dll'],
      ['sqlite-vec', 'sqlite-vec-win32-x64\\vec0.dll'],
    ].map(([module, nativePath]) => ({ module, path: nativePath, bytes: 1, sha256: hash }));
    const nativePresence = {
      requiredModules: ['better-sqlite3', 'node-pty', 'sharp', 'onnxruntime-node', 'sqlite-vec'],
      counts: {
        'better-sqlite3': 1,
        'node-pty': 1,
        sharp: 1,
        'onnxruntime-node': 1,
        'sqlite-vec': 1,
      },
      allPresent: true,
    };
    const h6Validation = {
      native: {
        path: h6NativePath,
        sha256: H6_NATIVE_SHA256,
        expectedCommit: '2db3e392',
      },
      window: {
        path: h6WindowPath,
        sha256: H6_WINDOW_SHA256,
        head: '2db3e392ab6aaae16609eaf939058e6b35d97303',
      },
      stage: {
        path: h6StagePath,
        sha256: H6_STAGE_SHA256,
        head: '2db3e392ab6aaae16609eaf939058e6b35d97303',
      },
      packagedArtifact: { executableSha256: hash, asarSha256: hash },
      ok: true,
    };
    const quiet = (stage) => ({
      ok: true,
      stage,
      checkedAtUtc: new Date(capturedMs).toISOString(),
      activeProjectProcessCount: 0,
      activeProjectProcesses: [],
    });
    const finalReceiptQuiet = quiet('final_receipt');
    const postProvisionalReceiptQuiet = quiet('after_provisional_receipt_before_final_success');
    const provisionalReceiptPath = path.join(
      paths.restorationReceiptRoot,
      `${runId}-pre-success-validation.json`
    );
    const provisionalReceipt = {
      schema: 'squidrun.build1b.main_e28_restoration_pre_success_validation.v1',
      runId,
      kind: 'pre_success_validation',
      capturedAtUtc: new Date(capturedMs).toISOString(),
      ok: false,
      candidateWouldPass: true,
      restartState: 'restart_blocked_pending_post_receipt_quiet_check',
      head,
      protectedElectronSha256: '67dc2a7036860a68e5312c212c31b8772ac463ed0289fcc44897867f55075e89',
      finalReceiptQuiet,
      receiptPath: provisionalReceiptPath,
    };
    fs.writeFileSync(provisionalReceiptPath, JSON.stringify(provisionalReceipt), 'utf8');
    const syncPlanSummary = {
      mutationCount: 1,
      protectedMutationCount: 0,
      protectedDirectoryMutationCount: 0,
      protectedPathStateConflictCount: 0,
      createDirectories: 0,
      copyMissing: 1,
      replaceDifferent: 0,
      deleteExtraFiles: 0,
      deleteExtraDirectories: 0,
    };
    const syncPlanArtifactPath = path.join(
      paths.restorationReceiptRoot,
      `${runId}-sync-plan.json`
    );
    const syncPlanArtifact = {
      schema: 'squidrun.build1b.main_e28_restoration_sync_plan.v1',
      runId,
      head,
      createdAtUtc: new Date(capturedMs).toISOString(),
      protectedRelativePath: 'electron\\dist\\electron.exe',
      plan: {
        schema: 'squidrun.dependency_sync_plan.v1',
        mutationCount: 1,
        protectedMutationCount: 0,
        protectedDirectoryMutationCount: 0,
        protectedPathStateConflictCount: 0,
        createDirectories: [],
        copyMissing: [{ relativePath: 'fixture\\missing.js' }],
        replaceDifferent: [],
        deleteExtraFiles: [],
        deleteExtraDirectories: [],
      },
    };
    fs.writeFileSync(syncPlanArtifactPath, JSON.stringify(syncPlanArtifact), 'utf8');
    const syncResult = {
      createDirectories: 0,
      copyMissing: 1,
      replaceDifferent: 0,
      deleteExtraFiles: 0,
      deleteExtraDirectories: 0,
      atomicCommits: 1,
      completedActions: [{
        stage: 'missing_file_committed',
        relativePath: 'fixture\\missing.js',
        completedAtUtc: new Date(capturedMs).toISOString(),
      }],
    };
    const payload = {
      schema: 'squidrun.build1b.main_e28_restoration.v1',
      runId,
      capturedAt: new Date(capturedMs).toISOString(),
      ok: true,
      restartState: 'restart_ready_electron_28_3_3',
      receiptPath,
      MR1: {
        branch: 'main',
        head,
        packageElectron: '28.3.3',
        lockRootElectron: '28.3.3',
        lockElectron: '28.3.3',
        ladderBranch: 'build-1b-ladder',
        ladderStageCommit: '2db3e392ab6aaae16609eaf939058e6b35d97303',
        h6CoveredSourceThrough: '2db3e392ab6aaae16609eaf939058e6b35d97303',
        retainedCommitsAfterH6Coverage: head === '2db3e392ab6aaae16609eaf939058e6b35d97303' ? [] : [{
          commit: head,
          subject: 'fixture retained commit',
          justification: 'fixture execution coverage',
        }],
        sourceProvenance: {
          initial: sourceProvenance('initial'),
          postReferenceInstall: sourceProvenance('post_reference_install'),
          postPlan: sourceProvenance('post_plan'),
          finalValidation: sourceProvenance('final_validation'),
          beforeReceipt: sourceProvenance('before_receipt'),
          afterProvisionalReceipt: sourceProvenance('after_provisional_receipt'),
        },
        trackedUiSourceManifest: {
          initial: manifest('initial'),
          finalValidation: manifest('final_validation'),
          beforeReceipt: manifest('before_receipt'),
          afterProvisionalReceipt: manifest('after_provisional_receipt'),
          unchanged: true,
        },
      },
      MR2: {
        referenceRoot: expectedReferenceRoot,
        referenceHead: head,
        referenceNpmCiExitCode: 0,
        referenceNpmCiDurationSeconds: 1,
        referenceTopLevelCount: 100,
        mainTopLevelCount: 100,
        referenceFileCount: 1000,
        mainFileCount: 1000,
        electronPackageMetadata: '28.3.3',
        finalFullCoherencePass: true,
        nativeHashesMatch: true,
        referenceNativePresence: nativePresence,
        mainNativePresence: nativePresence,
        referenceNativeHashes: nativeHashes,
        mainNativeHashes: nativeHashes,
        randomSampleSeed: 123,
        randomSampleSize: 1,
        randomSample: [{ path: 'one.js', referenceSha256: hash, mainSha256: hash, match: true }],
        randomSampleAllMatch: true,
        missingFiles: [],
        extraFiles: [],
        syncPlan: syncPlanSummary,
        syncPlanArtifact: {
          schema: syncPlanArtifact.schema,
          path: syncPlanArtifactPath,
          sha256: sha256File(syncPlanArtifactPath),
          mutationCount: 1,
        },
        sync: syncResult,
        finalFullCoherencePlan: {
          mutationCount: 0,
          protectedMutationCount: 0,
          protectedDirectoryMutationCount: 0,
          protectedPathStateConflictCount: 0,
        },
        referenceProvenance: {
          preInstall: referenceProvenance('pre_install'),
          postInstall: referenceProvenance('post_install'),
          postPlan: referenceProvenance('post_plan'),
          finalValidation: referenceProvenance('final_validation'),
        },
      },
      MR3: {
        protectedPath: path.join(root, 'ui', 'node_modules', 'electron', 'dist', 'electron.exe'),
        sha256Before: '67dc2a7036860a68e5312c212c31b8772ac463ed0289fcc44897867f55075e89',
        sha256AfterSync: '67dc2a7036860a68e5312c212c31b8772ac463ed0289fcc44897867f55075e89',
        sha256After: '67dc2a7036860a68e5312c212c31b8772ac463ed0289fcc44897867f55075e89',
        expectedSha256: '67dc2a7036860a68e5312c212c31b8772ac463ed0289fcc44897867f55075e89',
        untouched: true,
        atomicReplacement: true,
        atomicCommitCount: 1,
        expectedAtomicCommitCount: 1,
        protectedMutationCount: 0,
        protectedDirectoryMutationCount: 0,
        protectedPathStateConflictCount: 0,
      },
      MR4: {
        fullSuiteMinusCharacterizedEolPair: {
          exitCode: 0,
          timedOut: false,
          forceExit: true,
          durationSeconds: 1,
          log: fullSuiteLog,
          logSha256: sha256File(fullSuiteLog),
          logBytes: fs.statSync(fullSuiteLog).size,
        },
        characterizedEolSuitesDiagnosticOnly: {
          gatesRestart: false,
          forceExit: true,
          log: eolLog,
          logSha256: sha256File(eolLog),
          logBytes: fs.statSync(eolLog).size,
          checkoutState: { characterizedSuites: ['system-protected-evals', 'the-tell-normalize-parity'] },
        },
        hmSendAndCommsRoundTripTests: {
          exitCode: 0,
          timedOut: false,
          forceExit: true,
          durationSeconds: 1,
          log: commsLog,
          logSha256: sha256File(commsLog),
          logBytes: fs.statSync(commsLog).size,
        },
      },
      MR5: {
        statement: 'On restart electron 28.3.3 uses the E28 tree proven by H6.',
        h6NativeReceipt: '.squidrun/coord/build1b-e29-s480/rollback-native-e28-2db3e392.json',
        h6WindowReceipt: '.squidrun/coord/build1b-e29-s480/rollback-windows-e28-2db3e392/window-capture-receipt.json',
        h6ReceiptValidation: h6Validation,
        h6ReceiptValidationFinal: h6Validation,
        h6ReceiptValidationAfterProvisionalReceipt: h6Validation,
        h6EvidenceUnchanged: true,
        residualRisks: ['Known residual risk.'],
      },
      MR6: {
        naturalQuietWindowRequired: true,
        projectProcessStopCommands: 0,
        ownedChildTerminationPolicy: 'Only owned child processes may be terminated.',
        initialQuiet: quiet('initial'),
        postReferenceQuiet: quiet('post_reference'),
        postPlanQuiet: quiet('post_plan'),
        finalValidationQuiet: quiet('final_validation'),
        finalReceiptQuiet,
        postProvisionalReceiptQuiet,
        provisionalReceiptPath,
        provisionalReceiptSha256: sha256File(provisionalReceiptPath),
        activeProjectProcessesAfter: [],
        initialProjectProcessStartTimes: [],
        finalProjectProcessStartTimes: [],
        projectProcessStartTimesUnchanged: true,
        zeroProjectProcessSnapshots: true,
        midRunGuardIntervalMs: 100,
        atomicSameDirectoryReplacement: true,
        protectedElectronPlannedMutations: 0,
        protectedParentDirectoryPlannedMutations: 0,
        protectedPathStateConflicts: 0,
      },
      MR7: {
        originalMissingTopLevelEntries: 454,
        originalMissingNestedFiles: 9124,
        supersededIntermediate: 'E29 missing-only fill was superseded.',
        damageCharacterization: '.squidrun/coord/build1b-e29-s480/main-node-modules-damage-characterization.json',
        damageCharacterizationSha256: DAMAGE_SHA256,
        originalUndersell: 'The original EBUSY wording undersold removed content.',
      },
      ...overrides,
    };
    fs.writeFileSync(receiptPath, JSON.stringify(payload), 'utf8');
    return { receiptPath, payload };
  }

  function writeDoneReceipt(capturedMs, options = {}) {
    const success = options.success || writeSuccessfulRestorationReceipt(capturedMs - 1);
    fs.mkdirSync(path.dirname(paths.donePath), { recursive: true });
    const done = {
      schema: 'squidrun.build1b.main_e28_restoration_watch_done.v1',
      ok: true,
      completedAt: new Date(capturedMs).toISOString(),
      taskName: 'test-e28-task',
      expectedHead: EXPECTED_HEAD,
      registrationEpochMs: REGISTRATION_EPOCH_MS,
      restorationReceiptPath: success.receiptPath,
      restartState: 'restart_ready_electron_28_3_3',
      ...options.done,
    };
    fs.writeFileSync(paths.donePath, JSON.stringify(done), 'utf8');
    return { done, success };
  }

  function writeTerminalReceipt(capturedMs, overrides = {}) {
    fs.mkdirSync(path.dirname(paths.terminalPath), { recursive: true });
    const terminal = {
      schema: 'squidrun.build1b.main_e28_restoration_watch_terminal.v1',
      terminal: true,
      ok: false,
      capturedAt: new Date(capturedMs).toISOString(),
      taskName: 'test-e28-task',
      expectedHead: EXPECTED_HEAD,
      registrationEpochMs: REGISTRATION_EPOCH_MS,
      terminalPath: paths.terminalPath,
      restartState: 'restart_blocked_repair_incomplete',
      ...overrides,
    };
    fs.writeFileSync(paths.terminalPath, JSON.stringify(terminal), 'utf8');
    return terminal;
  }

  function runAt(nowMs, overrides = {}) {
    const disableTask = overrides.disableTask || jest.fn(() => command(0));
    const runPreflight = overrides.runPreflight || jest.fn(() => ({
      command: command(0),
      payload: quietPayload(),
    }));
    const runRestore = overrides.runRestore || jest.fn(() => ({
      command: command(0),
      payload: writeSuccessfulRestorationReceipt(
        Math.max(nowMs, REGISTRATION_EPOCH_MS + 1),
        overrides.expectedHead ?? EXPECTED_HEAD
      ).payload,
    }));
    const runSustainedQuiet = overrides.runSustainedQuiet || jest.fn(() => ({
      command: command(0),
      payload: {
        ...quietPayload(),
        sustainedQuiet: {
          ok: true,
          requiredDurationSeconds: DEFAULT_DEBOUNCE_MS / 1000,
          elapsedSeconds: DEFAULT_DEBOUNCE_MS / 1000,
          exactPredicate: 'Get-ProjectProcesses',
        },
      },
    }));
    const registrationHead = overrides.expectedHead ?? EXPECTED_HEAD;
    const registrationEpochMs = overrides.registrationEpochMs ?? REGISTRATION_EPOCH_MS;
    const sourceIntegrity = overrides.sourceIntegrity || defaultSourceIntegrity;
    const watcherArgumentsSha256 = crypto.createHash('sha256').update(buildWatcherArguments({
      watcherScriptPath: paths.watcherScriptPath,
      projectRoot: paths.projectRoot,
      powershellPath: 'C:\\pwsh.exe',
      taskName: 'test-e28-task',
      debounceMs: DEFAULT_DEBOUNCE_MS,
      restoreTimeoutMs: 3 * 60 * 60 * 1000,
      expectedHead: registrationHead,
      registrationEpochMs,
      registrationProofPath: paths.registrationProofPath,
      sourceIntegrity,
      quietWatchPollMs: 10,
    }), 'utf8').digest('hex');
    if (overrides.registrationProof !== false) {
      fs.mkdirSync(path.dirname(paths.registrationProofPath), { recursive: true });
      fs.writeFileSync(paths.registrationProofPath, JSON.stringify({
        schema: 'squidrun.build1b.main_e28_restoration_task_registration_proof.v1',
        phase: 'committed_enabled',
        ok: true,
        proofPath: paths.registrationProofPath,
        taskName: 'test-e28-task',
        expectedHead: registrationHead,
        registrationEpochMs,
        committedAt: new Date(Math.max(nowMs, REGISTRATION_EPOCH_MS + 1)).toISOString(),
        watcherArgumentsSha256,
        sourceIntegrity: {
          watcher: { path: paths.watcherScriptPath, sha256: sourceIntegrity.watcher },
          restore: { path: paths.restoreScriptPath, sha256: sourceIntegrity.restore },
          module: { path: paths.syncModulePath, sha256: sourceIntegrity.module },
          registration: { path: paths.registrationScriptPath, sha256: sourceIntegrity.registration },
        },
        registeredTask: {
          enabled: true,
          ownerMarkerVerified: true,
          runtimeReady: true,
        },
        ...(overrides.registrationProofPayload || {}),
      }), 'utf8');
    }
    const result = runWatchCycle({
      projectRoot: root,
      paths,
      powershellPath: 'C:\\pwsh.exe',
      taskName: 'test-e28-task',
      debounceMs: DEFAULT_DEBOUNCE_MS,
      expectedHead: registrationHead,
      registrationEpochMs,
      sourceIntegrity,
    }, {
      nowMs,
      runPreflight,
      runSustainedQuiet,
      runRestore,
      disableTask,
      evidenceSha256File,
      acquireLock: () => ({ ok: true, token: 'test-lock' }),
      releaseLock: () => {},
    });
    return { result, runPreflight, runSustainedQuiet, runRestore, disableTask };
  }

  test('active project processes reset the sustained-quiet clock and never launch restoration', () => {
    fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
    fs.writeFileSync(paths.statePath, JSON.stringify({ firstQuietSeenAtMs: 1000 }), 'utf8');
    const runRestore = jest.fn();
    const { result } = runAt(2000, {
      runPreflight: jest.fn(() => ({ command: command(0), payload: activePayload(2) })),
      runRestore,
    });

    expect(result.kind).toBe('quiet_refusal');
    expect(runRestore).not.toHaveBeenCalled();
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    expect(state.firstQuietSeenAtMs).toBeNull();
    expect(state.status).toBe('waiting_for_full_quiet');
  });

  test('full quiet requires one continuous ten-minute monitor before launch', () => {
    const { result, runPreflight, runSustainedQuiet, runRestore } = runAt(10_000);

    expect(result.kind).toBe('script_completion');
    expect(runPreflight).toHaveBeenCalledTimes(2);
    expect(runSustainedQuiet).toHaveBeenCalledTimes(1);
    expect(runRestore).toHaveBeenCalledTimes(1);
  });

  test('a process observed during the continuous monitor refuses launch', () => {
    const runSustainedQuiet = jest.fn(() => ({
      command: command(0),
      payload: {
        ok: false,
        reason: 'sustained_quiet_window_lost',
        sustainedQuiet: { ok: false, loss: { reason: 'project_process_observed_by_exact_predicate' } },
      },
    }));
    const { result, runPreflight, runRestore } = runAt(10_000, { runSustainedQuiet });

    expect(result.kind).toBe('sustained_quiet_refusal');
    expect(runPreflight).toHaveBeenCalledTimes(1);
    expect(runRestore).not.toHaveBeenCalled();
  });

  test('immediate launch recheck can veto a previously sustained quiet window', () => {
    fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
    fs.writeFileSync(paths.statePath, JSON.stringify({ firstQuietSeenAtMs: 10_000 }), 'utf8');
    const runPreflight = jest
      .fn()
      .mockReturnValueOnce({ command: command(0), payload: quietPayload() })
      .mockReturnValueOnce({ command: command(0), payload: activePayload(1) });
    const runRestore = jest.fn();
    const { result } = runAt(10_000 + DEFAULT_DEBOUNCE_MS, { runPreflight, runRestore });

    expect(result.kind).toBe('launch_recheck_refusal');
    expect(runPreflight).toHaveBeenCalledTimes(2);
    expect(runRestore).not.toHaveBeenCalled();
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    expect(state.firstQuietSeenAtMs).toBeNull();
  });

  test('successful restoration writes done and next-session receipts then disables the task', () => {
    fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
    fs.writeFileSync(paths.statePath, JSON.stringify({ firstQuietSeenAtMs: 10_000 }), 'utf8');
    const disableTask = jest.fn(() => command(0));
    const { result, runPreflight, runRestore } = runAt(10_000 + DEFAULT_DEBOUNCE_MS, { disableTask });

    expect(result.kind).toBe('script_completion');
    expect(runPreflight).toHaveBeenCalledTimes(2);
    expect(runRestore).toHaveBeenCalledTimes(1);
    expect(disableTask).toHaveBeenCalledWith('test-e28-task');
    expect(JSON.parse(fs.readFileSync(paths.donePath, 'utf8')).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.nextSessionNoticePath, 'utf8')).status).toBe('complete');
    expect(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).status).toBe('complete_disarmed');
  });

  test('done receipt short-circuits every accidental later invocation and retries disarm', () => {
    writeDoneReceipt(50_000);
    const runPreflight = jest.fn(() => { throw new Error('must not run'); });
    const disableTask = jest.fn(() => command(0));
    const { result } = runAt(50_000, { runPreflight, disableTask });

    expect(result.kind).toBe('already_done_short_circuit');
    expect(runPreflight).not.toHaveBeenCalled();
    expect(disableTask).toHaveBeenCalledWith('test-e28-task');
    expect(JSON.parse(fs.readFileSync(paths.nextSessionNoticePath, 'utf8')).recoveredFromDoneReceipt).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).status).toBe('complete_disarmed');
  });

  test('runner success receipt closes the watcher crash window without repeating restoration', () => {
    writeSuccessfulRestorationReceipt(54_000);
    const runPreflight = jest.fn(() => { throw new Error('must not run'); });
    const runRestore = jest.fn(() => { throw new Error('must not run'); });
    const disableTask = jest.fn(() => command(0));
    const { result } = runAt(55_000, { runPreflight, runRestore, disableTask });

    expect(result.kind).toBe('recovered_success_disarm');
    expect(runPreflight).not.toHaveBeenCalled();
    expect(runRestore).not.toHaveBeenCalled();
    expect(disableTask).toHaveBeenCalledWith('test-e28-task');
    expect(JSON.parse(fs.readFileSync(paths.donePath, 'utf8')).recoveredAfterWatcherInterruption).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).status).toBe('complete_disarmed');
  });

  test('crash recovery refuses a raw success receipt already bound to a failure handoff', () => {
    const success = writeSuccessfulRestorationReceipt(54_500);
    fs.mkdirSync(paths.watcherReceiptRoot, { recursive: true });
    const failureEventPath = path.join(paths.watcherReceiptRoot, 'prior-script-abort-or-failure.json');
    fs.writeFileSync(failureEventPath, JSON.stringify({
      schema: 'squidrun.build1b.main_e28_restoration_watch_event.v1',
      kind: 'script_abort_or_failure',
      capturedAt: new Date(54_600).toISOString(),
      taskName: 'test-e28-task',
      expectedHead: EXPECTED_HEAD,
      registrationEpochMs: REGISTRATION_EPOCH_MS,
      command: command(1),
      restoration: success.payload,
      restorationReceiptValidation: {
        ok: true,
        receiptPath: success.receiptPath,
        reportedPayloadMatchesReceipt: true,
      },
    }), 'utf8');
    const runPreflight = jest.fn();
    const runRestore = jest.fn();
    const disableTask = jest.fn(() => command(0));

    const { result } = runAt(55_000, { runPreflight, runRestore, disableTask });

    expect(result.kind).toBe('recovery_blocked_by_prior_failure_outcome');
    expect(runPreflight).not.toHaveBeenCalled();
    expect(runRestore).not.toHaveBeenCalled();
    expect(disableTask).toHaveBeenCalledWith('test-e28-task');
    expect(fs.existsSync(paths.donePath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(paths.terminalPath, 'utf8')).blockingRecoveryOutcomePath)
      .toBe(path.resolve(failureEventPath));
  });

  test('a retained fatal handoff terminalizes even when no raw success receipt exists', () => {
    fs.mkdirSync(paths.watcherReceiptRoot, { recursive: true });
    const failureEventPath = path.join(paths.watcherReceiptRoot, 'fatal-before-terminal-write.json');
    fs.writeFileSync(failureEventPath, JSON.stringify({
      schema: 'squidrun.build1b.main_e28_restoration_watch_event.v1',
      kind: 'script_abort_or_failure',
      capturedAt: new Date(55_500).toISOString(),
      taskName: 'test-e28-task',
      expectedHead: EXPECTED_HEAD,
      registrationEpochMs: REGISTRATION_EPOCH_MS,
      command: command(1),
      restoration: null,
      restorationReceiptValidation: { ok: false, receiptPath: null },
    }), 'utf8');
    const runPreflight = jest.fn();
    const runRestore = jest.fn();

    const { result } = runAt(56_000, { runPreflight, runRestore });

    expect(result.kind).toBe('recovery_blocked_by_prior_failure_outcome');
    expect(runPreflight).not.toHaveBeenCalled();
    expect(runRestore).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(paths.terminalPath, 'utf8')).blockingRecoveryOutcomePath)
      .toBe(path.resolve(failureEventPath));
  });

  test('crash recovery ignores stale successful receipts from another Git head', () => {
    const oldHead = 'b'.repeat(40);
    writeSuccessfulRestorationReceipt(3_000, oldHead);
    const matching = writeSuccessfulRestorationReceipt(2_000, EXPECTED_HEAD);

    const recovered = findSuccessfulRestorationReceipt(
      paths.restorationReceiptRoot,
      EXPECTED_HEAD,
      REGISTRATION_EPOCH_MS,
      { nowMs: 5_000, sha256FileFn: evidenceSha256File }
    );
    expect(recovered.receiptPath).toBe(matching.receiptPath);
    expect(recovered.payload.MR1.head).toBe(EXPECTED_HEAD);
  });

  test('safe exit-42 refusal resets debounce without disabling the task', () => {
    fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
    fs.writeFileSync(paths.statePath, JSON.stringify({ firstQuietSeenAtMs: 10_000 }), 'utf8');
    const disableTask = jest.fn(() => command(0));
    const { result } = runAt(10_000 + DEFAULT_DEBOUNCE_MS, {
      disableTask,
      runRestore: jest.fn(() => ({
        command: command(42),
        payload: { ok: false, kind: 'post_reference_quiet_refusal' },
      })),
    });

    expect(result.kind).toBe('script_refusal');
    expect(disableTask).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.terminalPath)).toBe(false);
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    expect(state.firstQuietSeenAtMs).toBeNull();
    expect(state.status).toBe('safe_refusal_waiting_for_new_debounce');
  });

  test('nonzero child exit cannot be promoted by an ok true payload', () => {
    const disableTask = jest.fn(() => command(0));
    const { result } = runAt(80_000, {
      disableTask,
      runRestore: jest.fn(() => ({
        command: command(1),
        payload: {
          ok: true,
          restartState: 'restart_ready_electron_28_3_3',
          receiptPath: 'contradictory.json',
        },
      })),
    });

    expect(result.kind).toBe('script_abort_or_failure');
    expect(fs.existsSync(paths.donePath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(paths.terminalPath, 'utf8')).terminal).toBe(true);
  });

  test('done outcome reports disarm pending when task disable fails', () => {
    writeDoneReceipt(81_000);
    const disableTask = jest.fn(() => command(1));
    const { result } = runAt(81_000, { disableTask });

    expect(result.ok).toBe(false);
    expect(result.restorationOk).toBe(true);
    expect(result.kind).toBe('already_done_disarm_pending');
    const event = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    expect(event.ok).toBe(false);
  });

  test('mid-sync exit-44 abort becomes terminal, visible next session, and disarmed', () => {
    fs.mkdirSync(path.dirname(paths.statePath), { recursive: true });
    fs.writeFileSync(paths.statePath, JSON.stringify({ firstQuietSeenAtMs: 10_000 }), 'utf8');
    const disableTask = jest.fn(() => command(0));
    const { result } = runAt(10_000 + DEFAULT_DEBOUNCE_MS, {
      disableTask,
      runRestore: jest.fn(() => ({
        command: command(44),
        payload: {
          ok: false,
          kind: 'mid_sync_relaunch_abort',
          restartState: 'restart_blocked_repair_incomplete',
          receiptPath: 'abort.json',
        },
      })),
    });

    expect(result.kind).toBe('script_abort_or_failure');
    expect(disableTask).toHaveBeenCalledWith('test-e28-task');
    expect(JSON.parse(fs.readFileSync(paths.terminalPath, 'utf8')).terminal).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.nextSessionNoticePath, 'utf8')).status).toBe('terminal_failure');
    expect(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).status).toBe('terminal_failure_disarmed');
  });

  test('registered source hashes fail closed before preflight and disarm the task', () => {
    for (const [filePath, value] of [
      [paths.watcherScriptPath, 'watcher'],
      [paths.restoreScriptPath, 'restore'],
      [paths.syncModulePath, 'module'],
    ]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, value, 'utf8');
    }
    const expected = {
      watcher: sha256File(paths.watcherScriptPath),
      restore: sha256File(paths.restoreScriptPath),
      module: sha256File(paths.syncModulePath),
      registration: sha256File(paths.registrationScriptPath),
    };
    expect(verifySourceIntegrity(paths, expected).ok).toBe(true);
    fs.appendFileSync(paths.restoreScriptPath, '-drift', 'utf8');

    const runPreflight = jest.fn();
    const disableTask = jest.fn(() => command(0));
    const { result } = runAt(70_000, {
      sourceIntegrity: expected,
      runPreflight,
      disableTask,
    });

    expect(result.kind).toBe('source_integrity_failure');
    expect(runPreflight).not.toHaveBeenCalled();
    expect(disableTask).toHaveBeenCalledWith('test-e28-task');
    expect(JSON.parse(fs.readFileSync(paths.terminalPath, 'utf8')).sourceIntegrity.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).status).toBe('terminal_failure_disarmed');
  });

  test('missing committed registration proof disarms before preflight', () => {
    const runPreflight = jest.fn();
    const { result } = runAt(70_500, { registrationProof: false, runPreflight });

    expect(result.kind).toBe('registration_proof_failure');
    expect(runPreflight).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(paths.terminalPath, 'utf8')).registrationProof.ok).toBe(false);
  });

  test('short-lived prepared enable authorization retries harmlessly instead of self-terminalizing', () => {
    const nowMs = 81_500;
    const preparedAtMs = nowMs - 1;
    const runPreflight = jest.fn();
    const disableTask = jest.fn(() => command(0));
    const { result } = runAt(nowMs, {
      runPreflight,
      disableTask,
      registrationProofPayload: {
        phase: 'prepared_enable_authorized',
        ok: false,
        preparedAt: new Date(preparedAtMs).toISOString(),
        enableAuthorized: true,
        enableAuthorizationExpiresAt: new Date(preparedAtMs + (30 * 60 * 1000)).toISOString(),
        registeredTask: {
          enabled: false,
          ownerMarkerVerified: true,
          runtimeReady: false,
        },
      },
    });

    expect(result.kind).toBe('registration_proof_pending');
    expect(runPreflight).not.toHaveBeenCalled();
    expect(disableTask).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.terminalPath)).toBe(false);
  });

  test('future or overlong prepared enable authorization terminalizes instead of waiting', () => {
    const nowMs = 82_000;
    const runPreflight = jest.fn();
    const disableTask = jest.fn(() => command(0));
    const { result } = runAt(nowMs, {
      runPreflight,
      disableTask,
      registrationProofPayload: {
        phase: 'prepared_enable_authorized',
        ok: false,
        preparedAt: new Date(nowMs + 1).toISOString(),
        enableAuthorized: true,
        enableAuthorizationExpiresAt: new Date(nowMs + (31 * 60 * 1000)).toISOString(),
        registeredTask: {
          enabled: false,
          ownerMarkerVerified: true,
          runtimeReady: false,
        },
      },
    });

    expect(result.kind).toBe('registration_proof_failure');
    expect(runPreflight).not.toHaveBeenCalled();
    expect(disableTask).toHaveBeenCalledWith('test-e28-task');
  });

  test('next-session notice matching rejects future timestamps and conflicting anchors', () => {
    const nowMs = 90_000;
    const baseNotice = {
      schema: 'squidrun.next_session_notice.v1',
      audience: ['architect', 'builder', 'oracle'],
      topic: 'build1b-main-e28-restoration',
      status: 'complete',
      createdAt: new Date(nowMs).toISOString(),
      message: 'complete',
      donePath: paths.donePath,
      expectedHead: EXPECTED_HEAD,
      registrationEpochMs: REGISTRATION_EPOCH_MS,
      restorationReceiptPath: 'receipt.json',
    };
    const expected = {
      status: 'complete',
      anchorKey: 'donePath',
      anchorPath: paths.donePath,
      expectedHead: EXPECTED_HEAD,
      registrationEpochMs: REGISTRATION_EPOCH_MS,
      restorationReceiptPath: 'receipt.json',
      nowMs,
    };

    expect(noticeMatches(baseNotice, expected)).toBe(true);
    expect(noticeMatches({ ...baseNotice, createdAt: new Date(nowMs + 61_000).toISOString() }, expected)).toBe(false);
    expect(noticeMatches({ ...baseNotice, terminalPath: paths.terminalPath }, expected)).toBe(false);
  });

  test('default disarm trusts only a committed exact-ownership control-helper receipt', () => {
    const receiptPath = path.join(paths.watcherReceiptRoot, 'disable-control.json');
    const ownership = (enabled) => ({
      exists: true,
      owned: true,
      enabled,
      ownershipAnchorPath: path.join(paths.watcherReceiptRoot, 'task-ownership-anchor.json'),
      ownershipAnchorShapeValid: true,
      registeredXmlArtifactValid: true,
      semanticContractShapeValid: true,
      watcherArgumentsDigestMatches: true,
      semanticValidation: { accepted: true },
    });
    const receipt = {
      schema: 'squidrun.build1b.main_e28_restoration_task_control.v2',
      ok: true,
      action: 'disable',
      phase: 'committed_verified',
      taskName: 'test-e28-task',
      receiptPath,
      ownershipBefore: ownership(true),
      ownershipImmediateBeforeMutation: ownership(true),
      operation: { exitCode: 0, timedOut: false },
      taskPresenceAfter: { ok: true, exists: true, enabled: false },
      ownershipAfter: ownership(false),
    };
    fs.mkdirSync(paths.watcherReceiptRoot, { recursive: true });
    fs.writeFileSync(receiptPath, JSON.stringify(receipt), 'utf8');
    const context = {
      powershellPath: 'C:\\pwsh.exe',
      registrationScriptPath: paths.registrationScriptPath,
      projectRoot: paths.projectRoot,
      receiptRoot: paths.watcherReceiptRoot,
      sourceIntegrity: { registration: sha256File(paths.registrationScriptPath) },
      runCommand: jest.fn(() => ({ command: command(0), ...command(0), stdout: JSON.stringify(receipt) })),
    };

    expect(defaultDisableTask('test-e28-task', context)).toEqual(expect.objectContaining({
      exitCode: 0,
      verifiedDisabled: true,
      ownershipVerified: true,
    }));
    context.runCommand = jest.fn(() => ({ ...command(0), stdout: JSON.stringify({ ...receipt, ownershipAfter: { owned: false } }) }));
    expect(defaultDisableTask('test-e28-task', context)).toEqual(expect.objectContaining({
      exitCode: 1,
      verifiedDisabled: false,
      ownershipVerified: false,
    }));
  });

  test('default disarm never executes a helper whose registered source hash drifted', () => {
    const registeredSha256 = sha256File(paths.registrationScriptPath);
    fs.appendFileSync(paths.registrationScriptPath, '-drifted', 'utf8');
    const runCommand = jest.fn();

    const result = defaultDisableTask('test-e28-task', {
      registrationScriptPath: paths.registrationScriptPath,
      projectRoot: paths.projectRoot,
      receiptRoot: paths.watcherReceiptRoot,
      powershellPath: 'C:\\pwsh.exe',
      sourceIntegrity: { registration: registeredSha256 },
      runCommand,
    });

    expect(result).toEqual(expect.objectContaining({
      exitCode: 1,
      reason: 'task_control_helper_source_integrity_mismatch',
      ownershipVerified: false,
    }));
    expect(runCommand).not.toHaveBeenCalled();
  });

  test('unparseable watcher lock is conservative during grace and recoverable afterward', () => {
    const lockPath = paths.invocationLockPath;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, '{', 'utf8');
    const nowMs = Date.now();

    const early = acquireInvocationLock({
      lockPath,
      powershellPath: process.execPath,
      nowMs,
      pid: process.pid,
    });
    expect(early.ok).toBe(false);
    expect(early.reason).toBe('watch_lock_unparseable_within_grace');

    const oldTime = new Date(nowMs - LOCK_PARSE_GRACE_MS - 1000);
    fs.utimesSync(lockPath, oldTime, oldTime);
    const recovered = acquireInvocationLock({
      lockPath,
      powershellPath: process.execPath,
      nowMs,
      pid: process.pid,
      getProcessCreationUtcFn: () => '2026-07-18T00:00:00.000Z',
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.staleQuarantine.reason).toBe('unparseable_metadata_after_grace');
    expect(fs.existsSync(recovered.staleQuarantine.path)).toBe(true);
    releaseInvocationLock(recovered);
  });

  test('a live lock is never quarantined when creation identity lookup is unavailable', () => {
    const lockPath = paths.invocationLockPath;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      token: 'live-token',
      pid: 4242,
      processCreationUtc: '2026-07-18T00:00:00.000Z',
    }), 'utf8');

    const result = acquireInvocationLock({
      lockPath,
      powershellPath: 'C:\\pwsh.exe',
      nowMs: Date.now(),
      pid: process.pid,
      isPidAliveFn: () => true,
      getProcessCreationUtcFn: () => null,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('watch_lock_live_identity_unverifiable');
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readdirSync(path.dirname(lockPath)).filter((name) => name.includes('.stale-'))).toHaveLength(0);
  });

  test('top-level quiet cannot substitute for a full sustained-duration proof', () => {
    const runRestore = jest.fn();
    const runSustainedQuiet = jest.fn(() => ({
      command: command(0),
      payload: {
        ...quietPayload(),
        sustainedQuiet: {
          ok: true,
          requiredDurationSeconds: DEFAULT_DEBOUNCE_MS / 1000,
          elapsedSeconds: 0,
        },
      },
    }));

    const { result } = runAt(90_000, { runSustainedQuiet, runRestore });

    expect(result.kind).toBe('sustained_quiet_refusal');
    expect(runRestore).not.toHaveBeenCalled();
  });

  test('source drift during the sustained monitor terminalizes before restore', () => {
    const runRestore = jest.fn();
    const runSustainedQuiet = jest.fn(() => {
      fs.appendFileSync(paths.restoreScriptPath, '-drift-during-watch', 'utf8');
      return {
        command: command(0),
        payload: {
          ...quietPayload(),
          sustainedQuiet: {
            ok: true,
            requiredDurationSeconds: DEFAULT_DEBOUNCE_MS / 1000,
            elapsedSeconds: DEFAULT_DEBOUNCE_MS / 1000,
          },
        },
      };
    });

    const { result } = runAt(91_000, { runSustainedQuiet, runRestore });

    expect(result.kind).toBe('source_integrity_changed_during_quiet_watch');
    expect(runRestore).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(paths.terminalPath, 'utf8')).expectedHead).toBe(EXPECTED_HEAD);
  });

  test('fresh restoration is bound to the registered Git head', () => {
    const runRestore = jest.fn();
    const runPreflight = jest.fn(() => ({ command: command(0), payload: quietPayload('b'.repeat(40)) }));

    const { result } = runAt(92_000, { runPreflight, runRestore });

    expect(result.kind).toBe('expected_head_mismatch');
    expect(runRestore).not.toHaveBeenCalled();
  });

  test('a stale done receipt cannot short-circuit a task registered for another head', () => {
    fs.mkdirSync(path.dirname(paths.donePath), { recursive: true });
    fs.writeFileSync(paths.donePath, JSON.stringify({ ok: true, expectedHead: 'b'.repeat(40) }), 'utf8');

    const { result, runRestore } = runAt(93_000);

    expect(result.kind).toBe('script_completion');
    expect(runRestore).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(paths.donePath, 'utf8')).expectedHead).toBe(EXPECTED_HEAD);
  });

  test('terminal notice repair validates the whole envelope and exposes disarm pending', () => {
    writeTerminalReceipt(93_500);
    fs.mkdirSync(path.dirname(paths.nextSessionNoticePath), { recursive: true });
    fs.writeFileSync(paths.nextSessionNoticePath, JSON.stringify({
      schema: 'squidrun.next_session_notice.v1',
      audience: ['builder'],
      topic: 'wrong-topic',
      status: 'terminal_failure',
    }), 'utf8');

    const { result } = runAt(94_000, { disableTask: jest.fn(() => command(1)) });

    expect(result.kind).toBe('terminal_failure_disarm_pending');
    const notice = JSON.parse(fs.readFileSync(paths.nextSessionNoticePath, 'utf8'));
    expect(notice.topic).toBe('build1b-main-e28-restoration');
    expect(notice.audience).toEqual(['architect', 'builder', 'oracle']);
    expect(notice.terminalPath).toBe(paths.terminalPath);
    expect(notice.expectedHead).toBe(EXPECTED_HEAD);
    expect(notice.restorationReceiptPath).toBeNull();
    expect(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).status).toBe('terminal_failure_disarm_pending');
  });

  test('done notice repair replaces a correct anchor carrying the wrong head and receipt', () => {
    const { done } = writeDoneReceipt(94_500);
    fs.mkdirSync(path.dirname(paths.nextSessionNoticePath), { recursive: true });
    fs.writeFileSync(paths.nextSessionNoticePath, JSON.stringify({
      schema: 'squidrun.next_session_notice.v1',
      audience: ['architect', 'builder', 'oracle'],
      topic: 'build1b-main-e28-restoration',
      status: 'complete',
      createdAt: new Date(94_000).toISOString(),
      message: 'Wrong binding.',
      donePath: paths.donePath,
      expectedHead: 'b'.repeat(40),
      restorationReceiptPath: 'C:\\wrong.json',
    }), 'utf8');

    const { result } = runAt(95_000, {
      runPreflight: jest.fn(() => { throw new Error('must not run'); }),
    });

    expect(result.kind).toBe('already_done_short_circuit');
    const notice = JSON.parse(fs.readFileSync(paths.nextSessionNoticePath, 'utf8'));
    expect(notice.expectedHead).toBe(EXPECTED_HEAD);
    expect(notice.restorationReceiptPath).toBe(done.restorationReceiptPath);
    expect(notice.recoveredFromDoneReceipt).toBe(true);
  });

  test('source drift during the child run blocks an otherwise valid success receipt', () => {
    const runRestore = jest.fn(() => {
      const success = writeSuccessfulRestorationReceipt(96_000);
      fs.appendFileSync(paths.syncModulePath, '-drift-during-restore', 'utf8');
      return { command: command(0), payload: success.payload };
    });

    const { result } = runAt(96_000, { runRestore });

    expect(result.kind).toBe('script_abort_or_failure');
    expect(fs.existsSync(paths.donePath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(paths.terminalPath, 'utf8')).terminal).toBe(true);
  });

  test('reported child payload must match the complete authoritative disk receipt', () => {
    const runRestore = jest.fn(() => {
      const success = writeSuccessfulRestorationReceipt(96_500);
      const forged = JSON.parse(JSON.stringify(success.payload));
      forged.restartState = 'forged_restart_state';
      forged.MR7.originalMissingTopLevelEntries = 1;
      return { command: command(0), payload: forged };
    });

    const { result } = runAt(96_500, { runRestore });

    expect(result.kind).toBe('script_abort_or_failure');
    expect(fs.existsSync(paths.donePath)).toBe(false);
  });

  test('omitting a required MR detail prevents an otherwise plausible success receipt', () => {
    const runRestore = jest.fn(() => {
      const success = writeSuccessfulRestorationReceipt(96_750);
      delete success.payload.MR2.referenceNpmCiExitCode;
      fs.writeFileSync(success.receiptPath, JSON.stringify(success.payload), 'utf8');
      return { command: command(0), payload: success.payload };
    });

    const { result } = runAt(96_750, { runRestore });

    expect(result.kind).toBe('script_abort_or_failure');
    expect(fs.existsSync(paths.donePath)).toBe(false);
  });

  test('MR validator rejects plausible but unbound paths, evidence, process rows, and post-provisional gaps', () => {
    const success = writeSuccessfulRestorationReceipt(96_900);
    success.payload.MR1.retainedCommitsAfterH6Coverage = [];
    delete success.payload.MR1.sourceProvenance.afterProvisionalReceipt;
    delete success.payload.MR1.trackedUiSourceManifest.afterProvisionalReceipt;
    success.payload.MR2.referenceRoot = root;
    success.payload.MR3.protectedPath = path.join(root, 'other-checkout', 'electron', 'dist', 'electron.exe');
    fs.rmSync(success.payload.MR4.fullSuiteMinusCharacterizedEolPair.log, { force: true });
    success.payload.MR5.h6ReceiptValidation.native.sha256 = 'b'.repeat(64);
    delete success.payload.MR5.h6ReceiptValidationAfterProvisionalReceipt;
    success.payload.MR6.initialProjectProcessStartTimes = [{ pid: 1 }];
    success.payload.MR6.finalProjectProcessStartTimes = [{ pid: 1 }];
    delete success.payload.MR6.postProvisionalReceiptQuiet;
    success.payload.MR7.damageCharacterization = 'damage.json';
    fs.writeFileSync(success.receiptPath, JSON.stringify(success.payload), 'utf8');

    const validation = readAndValidateRestorationReceipt(
      success.receiptPath,
      EXPECTED_HEAD,
      paths.restorationReceiptRoot,
      REGISTRATION_EPOCH_MS,
      { nowMs: 96_900, sha256FileFn: evidenceSha256File }
    );

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      'mr1_retained_commits',
      'mr1_source_provenance',
      'mr1_source_manifest',
      'mr2',
      'mr3',
      'mr4',
      'mr5',
      'mr6',
      'mr7',
    ]));
  });

  test('MR2 completed-action journal must map exactly to the bound full plan', () => {
    const success = writeSuccessfulRestorationReceipt(96_950);
    success.payload.MR2.sync.completedActions[0].relativePath = 'different\\path.js';
    fs.writeFileSync(success.receiptPath, JSON.stringify(success.payload), 'utf8');

    const validation = readAndValidateRestorationReceipt(
      success.receiptPath,
      EXPECTED_HEAD,
      paths.restorationReceiptRoot,
      REGISTRATION_EPOCH_MS,
      { nowMs: 96_950, sha256FileFn: evidenceSha256File }
    );

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('mr2');
  });

  test('MR2 reference provenance must declare the LF-normalized lock hash mode', () => {
    const success = writeSuccessfulRestorationReceipt(96_975);
    success.payload.MR2.referenceProvenance.postPlan.lockHashMode = 'raw_bytes';
    fs.writeFileSync(success.receiptPath, JSON.stringify(success.payload), 'utf8');

    const validation = readAndValidateRestorationReceipt(
      success.receiptPath,
      EXPECTED_HEAD,
      paths.restorationReceiptRoot,
      REGISTRATION_EPOCH_MS,
      { nowMs: 96_975, sha256FileFn: evidenceSha256File }
    );

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('mr2');
  });

  test('future-dated restoration evidence is never accepted as current success', () => {
    const success = writeSuccessfulRestorationReceipt(200_000);

    const validation = readAndValidateRestorationReceipt(
      success.receiptPath,
      EXPECTED_HEAD,
      paths.restorationReceiptRoot,
      REGISTRATION_EPOCH_MS,
      { nowMs: 100_000, sha256FileFn: evidenceSha256File }
    );

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('registration_epoch');
  });

  test('a current terminal outranks an older same-head success receipt', () => {
    writeSuccessfulRestorationReceipt(97_000);
    writeTerminalReceipt(98_000);
    const runRestore = jest.fn();

    const { result } = runAt(99_000, { runRestore });

    expect(result.kind).toBe('terminal_failure_short_circuit');
    expect(runRestore).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.donePath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).status).toBe('terminal_failure_disarmed');
  });

  test('a same-task same-head terminal with no epoch cannot be ignored as stale', () => {
    writeSuccessfulRestorationReceipt(97_250);
    writeTerminalReceipt(98_250, { registrationEpochMs: null });

    const { result, runRestore } = runAt(99_250);

    expect(result.kind).toBe('retained_terminal_receipt_invalid');
    expect(runRestore).not.toHaveBeenCalled();
  });

  test('a terminal cannot propagate a non-null unvalidated restoration receipt path', () => {
    writeTerminalReceipt(98_500, { restorationReceiptPath: path.join(root, 'missing-restoration.json') });

    const { result } = runAt(99_500);

    expect(result.kind).toBe('retained_terminal_receipt_invalid');
    expect(JSON.parse(fs.readFileSync(paths.nextSessionNoticePath, 'utf8')).restorationReceiptPath).toBeNull();
  });

  test('an underspecified current done record terminalizes instead of manufacturing success', () => {
    fs.mkdirSync(path.dirname(paths.donePath), { recursive: true });
    fs.writeFileSync(paths.donePath, JSON.stringify({
      schema: 'squidrun.build1b.main_e28_restoration_watch_done.v1',
      ok: true,
      completedAt: new Date(100_000).toISOString(),
      taskName: 'test-e28-task',
      expectedHead: EXPECTED_HEAD,
      registrationEpochMs: REGISTRATION_EPOCH_MS,
      restartState: 'restart_ready_electron_28_3_3',
      restorationReceiptPath: 'C:\\missing.json',
    }), 'utf8');

    const { result } = runAt(101_000);

    expect(result.kind).toBe('retained_done_receipt_invalid');
    expect(fs.existsSync(paths.donePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(paths.terminalPath, 'utf8')).terminal).toBe(true);
  });

  test('exit-zero minimal success payload cannot manufacture restart readiness', () => {
    const { result } = runAt(95_000, {
      runRestore: jest.fn(() => ({ command: command(0), payload: { ok: true } })),
    });

    expect(result.kind).toBe('script_abort_or_failure');
    expect(fs.existsSync(paths.donePath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(paths.terminalPath, 'utf8')).terminal).toBe(true);
  });

  test('new watcher lock refuses acquisition when its own creation identity is unavailable', () => {
    const result = acquireInvocationLock({
      lockPath: paths.invocationLockPath,
      powershellPath: 'C:\\pwsh.exe',
      nowMs: Date.now(),
      pid: process.pid,
      getProcessCreationUtcFn: () => null,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('watch_lock_self_identity_unverifiable');
    expect(fs.existsSync(paths.invocationLockPath)).toBe(false);
  });

  test('live watcher identity mismatch is a conservative refusal, not quarantine', () => {
    const lockPath = paths.invocationLockPath;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      token: 'live-token',
      pid: 4242,
      processCreationUtc: '2026-07-18T00:00:00.000Z',
    }), 'utf8');

    const result = acquireInvocationLock({
      lockPath,
      powershellPath: 'C:\\pwsh.exe',
      nowMs: Date.now(),
      pid: process.pid,
      isPidAliveFn: () => true,
      getProcessCreationUtcFn: () => '2026-07-18T00:00:01.000Z',
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('watch_lock_live_identity_mismatch_conservative_refusal');
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readdirSync(path.dirname(lockPath)).filter((name) => name.includes('.stale-'))).toHaveLength(0);
  });
});
