'use strict';

const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Mira runtime state-root readiness', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const runtimeTsconfig = path.join(repoRoot, 'mira', 'runtime', 'tsconfig.json');
  const tscBin = path.join(repoRoot, 'ui', 'node_modules', 'typescript', 'bin', 'tsc');
  const compiledStateRootPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'state-root.js');
  const compiledRuntimePath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'runtime.js');
  const compiledStatusPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'status.js');
  const compiledStateRootUrl = pathToFileURL(compiledStateRootPath).href;
  const compiledRuntimeUrl = pathToFileURL(compiledRuntimePath).href;

  beforeAll(() => {
    execFileSync(process.execPath, [
      tscBin,
      '-p',
      runtimeTsconfig,
    ], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  });

  function runRuntimeSnippet(source) {
    return JSON.parse(execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      source,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    }));
  }

  function writeApprovedAcceptanceStateRoot() {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-acceptance-loader-'));
    const acceptanceDir = path.join(stateRoot, 'acceptance');
    const receiptsDir = path.join(stateRoot, 'imports', 'receipts');
    const continuityDir = path.join(stateRoot, 'continuity');
    fs.mkdirSync(acceptanceDir, { recursive: true });
    fs.mkdirSync(receiptsDir, { recursive: true });
    fs.mkdirSync(continuityDir, { recursive: true });
    fs.writeFileSync(path.join(continuityDir, 'not-loaded.json'), '{bad continuity json');

    const records = [
      {
        id: 'presence_runtime_acceptance',
        destination_relative_path: 'acceptance/mira-presence-runtime-acceptance-v0.md',
        title: 'Mira Presence Runtime Acceptance v0',
      },
      {
        id: 'north_star_acceptance',
        destination_relative_path: 'acceptance/mira-north-star-acceptance.md',
        title: 'Mira North Star Acceptance',
      },
      {
        id: 'pc_embodiment_permission',
        destination_relative_path: 'acceptance/mira-pc-embodiment-permission-v0.md',
        title: 'Mira PC Embodiment Permission v0',
      },
    ];

    for (const record of records) {
      fs.writeFileSync(
        path.join(stateRoot, record.destination_relative_path),
        `# ${record.title}\n\nAcceptance fixture for ${record.id}.\n`,
      );
    }

    fs.writeFileSync(path.join(receiptsDir, 'approved-first-batch.json'), JSON.stringify({
      schema: 'mira.import_receipt.v0',
      receipt_id: 'approved-first-batch',
      batch_id: 'acceptance-permission-contracts-v1',
      records,
    }, null, 2));

    return stateRoot;
  }

  function writeNormalizedCoreStateRoot(options = {}) {
    const stateRoot = writeApprovedAcceptanceStateRoot();
    const receiptsDir = path.join(stateRoot, 'imports', 'receipts');
    const coreDir = path.join(stateRoot, 'continuity', 'core');
    const permissionsDir = path.join(stateRoot, 'permissions', 'core');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.mkdirSync(permissionsDir, { recursive: true });

    const normalizedRecords = [
      {
        id: 'mira_self_profile',
        destination_relative_path: 'continuity/core/mira-self-profile.normalized.json',
        output_schema: 'mira.normalized.self_profile.v1',
        payload: {
          schema: 'mira.normalized.self_profile.v1',
          source_metadata: {
            metadata_only: true,
            live_continuity_excluded: true,
          },
        },
      },
      {
        id: 'james_relationship_state',
        destination_relative_path: 'continuity/core/james-relationship-state.normalized.json',
        output_schema: 'mira.normalized.james_relationship_state.v1',
        payload: {
          schema: 'mira.normalized.james_relationship_state.v1',
          source_metadata: {
            metadata_only: true,
            live_continuity_excluded: true,
          },
          source_focus_summary: {
            metadata_only: true,
            live_continuity_excluded: true,
          },
        },
      },
      {
        id: 'relationship_presence_permissions',
        destination_relative_path: 'permissions/core/relationship-presence-permissions.normalized.json',
        output_schema: 'mira.normalized.relationship_presence_permissions.v1',
        payload: {
          schema: 'mira.normalized.relationship_presence_permissions.v1',
          source_metadata: {
            metadata_only: true,
            live_continuity_excluded: true,
          },
          caveats: {
            local_store_write_allowed_now: 'scoped_only_to_reviewed_import_and_mira_state_root_writes_after_explicit_approval',
            blanket_mira_runtime_write_permission: false,
          },
        },
      },
    ];

    for (const record of normalizedRecords) {
      fs.writeFileSync(
        path.join(stateRoot, record.destination_relative_path),
        `${JSON.stringify(record.payload, null, 2)}\n`,
      );
    }

    const receiptRecords = options.duplicateReceiptIds
      ? normalizedRecords.map((record) => ({
        ...record,
        id: 'mira_self_profile',
      }))
      : normalizedRecords;

    fs.writeFileSync(path.join(receiptsDir, 'normalized-core.json'), JSON.stringify({
      schema: 'mira.normalized_core_receipt.v0',
      receipt_id: 'normalized-core',
      batch_id: 'normalized-core-state-v1',
      records: receiptRecords.map((record) => ({
        id: record.id,
        destination_relative_path: record.destination_relative_path,
        output_schema: record.output_schema,
      })),
    }, null, 2));

    return stateRoot;
  }

  test('fails closed when MIRA_STATE_ROOT is missing', () => {
    const result = runRuntimeSnippet(`
      import { getStateRootReadiness } from ${JSON.stringify(compiledStateRootUrl)};
      console.log(JSON.stringify(getStateRootReadiness({})));
    `);

    expect(result).toEqual(expect.objectContaining({
      configured: false,
      ready: false,
      path: null,
      error: expect.stringContaining('MIRA_STATE_ROOT is required'),
      importsLoaded: false,
    }));
  });

  test('rejects .squidrun as a runtime state root', () => {
    const stateRoot = path.join(repoRoot, '.squidrun', 'mira-state');
    const result = runRuntimeSnippet(`
      import { getStateRootReadiness } from ${JSON.stringify(compiledStateRootUrl)};
      console.log(JSON.stringify(getStateRootReadiness({ MIRA_STATE_ROOT: ${JSON.stringify(stateRoot)} })));
    `);

    expect(result).toEqual(expect.objectContaining({
      configured: true,
      ready: false,
      path: path.resolve(stateRoot),
      error: 'MIRA_STATE_ROOT must not point inside .squidrun.',
      importsLoaded: false,
    }));
  });

  test('reports expected buckets for a valid Mira-owned root without loading imports', () => {
    const stateRoot = path.join(repoRoot, 'mira', '.state-dev-test');
    const result = runRuntimeSnippet(`
      import { getStateRootReadiness } from ${JSON.stringify(compiledStateRootUrl)};
      console.log(JSON.stringify(getStateRootReadiness({ MIRA_STATE_ROOT: ${JSON.stringify(stateRoot)} })));
    `);

    expect(result).toEqual(expect.objectContaining({
      configured: true,
      ready: true,
      path: path.resolve(stateRoot),
      error: null,
      importsLoaded: false,
    }));
    expect(result.requiredBuckets.map((bucket) => bucket.relativePath)).toEqual([
      'continuity',
      'conversation-evidence',
      'permissions',
      'acceptance',
      'imports',
      'bridge',
    ]);
  });

  test('health exposes state-root readiness without reading the reviewed import queue', () => {
    const stateRoot = path.join(repoRoot, 'mira', '.state-dev-test');
    const health = runRuntimeSnippet(`
      process.env.MIRA_STATE_ROOT = ${JSON.stringify(stateRoot)};
      import { getHealth } from ${JSON.stringify(compiledRuntimeUrl)};
      console.log(JSON.stringify(getHealth(Date.now())));
    `);

    expect(health.stateRootConfigured).toBe(true);
    expect(health.stateRoot).toEqual(expect.objectContaining({
      ready: true,
      importsLoaded: false,
    }));
  });

  test('session consumes state-root readiness without loading continuity data', () => {
    const stateRoot = path.join(repoRoot, 'mira', '.state-dev-test');
    const session = runRuntimeSnippet(`
      process.env.MIRA_STATE_ROOT = ${JSON.stringify(stateRoot)};
      import { getSessionSkeleton } from ${JSON.stringify(compiledRuntimeUrl)};
      console.log(JSON.stringify(getSessionSkeleton()));
    `);

    expect(session.session).toEqual(expect.objectContaining({
      source: 'none',
      modelBehaviorLoaded: false,
      liveDataImported: false,
      continuityLoaded: false,
      stateRootReady: true,
      stateRootPath: path.resolve(stateRoot),
      stateRootError: null,
      importReceipts: expect.objectContaining({
        receiptsDir: path.join(path.resolve(stateRoot), 'imports', 'receipts'),
        receiptCount: 0,
        recordCount: 0,
        receiptsRead: true,
        continuityLoaded: false,
        error: null,
      }),
      acceptanceContinuity: expect.objectContaining({
        loaded: false,
        scope: 'acceptance_docs_only',
        documentCount: 0,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
        error: expect.stringContaining('approved receipt not found'),
      }),
      normalizedCore: expect.objectContaining({
        loaded: false,
        scope: 'normalized_core_state_only',
        documentCount: 0,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
        error: expect.stringContaining('approved receipt not found'),
      }),
      bridge: expect.objectContaining({
        protocol: 'mira.hm_send_adapter.v0',
        cliAvailable: true,
        cliRelativePath: 'mira/bridge/send-pane-message.js',
        allowedRoles: ['architect', 'builder', 'oracle'],
        paneMessageReceive: true,
        runtimeReplyParity: true,
        replyStateRelativePath: 'bridge/pane-roundtrips',
        liveSendManualOnly: true,
        autoSend: false,
        runtimeInvokesSendCli: false,
        telegramRouteControl: false,
        uiSurfaceControl: false,
      }),
    }));
    expect(session.session.bridge.cliPath.replace(/\\/g, '/')).toContain('/mira/bridge/send-pane-message.js');
  });

  test('session reports receipt counts without loading continuity files', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-runtime-receipts-'));
    const receiptsDir = path.join(stateRoot, 'imports', 'receipts');
    const continuityDir = path.join(stateRoot, 'continuity');
    fs.mkdirSync(receiptsDir, { recursive: true });
    fs.mkdirSync(continuityDir, { recursive: true });
    fs.writeFileSync(path.join(continuityDir, 'should-not-load.json'), '{not valid json');
    fs.writeFileSync(path.join(receiptsDir, 'receipt-a.json'), JSON.stringify({
      receipt_id: 'receipt-a',
      records: [{ id: 'one' }, { id: 'two' }],
    }));
    fs.writeFileSync(path.join(receiptsDir, 'receipt-b.json'), JSON.stringify({
      receipt_id: 'receipt-b',
      records: [{ id: 'three' }],
    }));

    const session = runRuntimeSnippet(`
      process.env.MIRA_STATE_ROOT = ${JSON.stringify(stateRoot)};
      import { getSessionSkeleton } from ${JSON.stringify(compiledRuntimeUrl)};
      console.log(JSON.stringify(getSessionSkeleton()));
    `);

    expect(session.session).toEqual(expect.objectContaining({
      continuityLoaded: false,
      liveDataImported: false,
      importReceipts: expect.objectContaining({
        receiptsDir,
        receiptCount: 2,
        recordCount: 3,
        receiptsRead: true,
        continuityLoaded: false,
        error: null,
      }),
      acceptanceContinuity: expect.objectContaining({
        loaded: false,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
      }),
      normalizedCore: expect.objectContaining({
        loaded: false,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
      }),
    }));
  });

  test('session loads only receipt-approved acceptance docs without claiming full continuity', () => {
    const stateRoot = writeApprovedAcceptanceStateRoot();

    const session = runRuntimeSnippet(`
      process.env.MIRA_STATE_ROOT = ${JSON.stringify(stateRoot)};
      import { getSessionSkeleton } from ${JSON.stringify(compiledRuntimeUrl)};
      console.log(JSON.stringify(getSessionSkeleton()));
    `);

    expect(session.session).toEqual(expect.objectContaining({
      continuityLoaded: false,
      liveDataImported: false,
      acceptanceContinuity: expect.objectContaining({
        loaded: true,
        scope: 'acceptance_docs_only',
        batchId: 'acceptance-permission-contracts-v1',
        documentCount: 3,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
        error: null,
      }),
      normalizedCore: expect.objectContaining({
        loaded: false,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
      }),
    }));
    expect(session.session.acceptanceContinuity.documents.map((document) => document.relativePath)).toEqual([
      'acceptance/mira-presence-runtime-acceptance-v0.md',
      'acceptance/mira-north-star-acceptance.md',
      'acceptance/mira-pc-embodiment-permission-v0.md',
    ]);
    expect(session.session.acceptanceContinuity.documents.map((document) => document.title)).toEqual([
      'Mira Presence Runtime Acceptance v0',
      'Mira North Star Acceptance',
      'Mira PC Embodiment Permission v0',
    ]);
  });

  test('status command exposes acceptance continuity summary without claiming full continuity', () => {
    const stateRoot = writeApprovedAcceptanceStateRoot();
    const output = execFileSync(process.execPath, [
      compiledStatusPath,
      '--json',
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIRA_STATE_ROOT: stateRoot,
      },
      encoding: 'utf8',
    });
    const status = JSON.parse(output);

    expect(status).toEqual(expect.objectContaining({
      service: 'mira-runtime',
      stateRootReady: true,
      receiptCount: 1,
      recordCount: 3,
      continuityLoaded: false,
      liveDataImported: false,
      acceptanceContinuity: expect.objectContaining({
        loaded: true,
        documentCount: 3,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
        error: null,
      }),
      normalizedCore: expect.objectContaining({
        loaded: false,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
      }),
    }));
  });

  test('session exposes normalized core status without claiming full continuity', () => {
    const stateRoot = writeNormalizedCoreStateRoot();

    const session = runRuntimeSnippet(`
      process.env.MIRA_STATE_ROOT = ${JSON.stringify(stateRoot)};
      import { getSessionSkeleton } from ${JSON.stringify(compiledRuntimeUrl)};
      console.log(JSON.stringify(getSessionSkeleton()));
    `);

    expect(session.session).toEqual(expect.objectContaining({
      continuityLoaded: false,
      liveDataImported: false,
      normalizedCore: expect.objectContaining({
        loaded: true,
        scope: 'normalized_core_state_only',
        batchId: 'normalized-core-state-v1',
        documentCount: 3,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
        error: null,
      }),
    }));
    expect(session.session.normalizedCore.documents.map((document) => document.id)).toEqual([
      'mira_self_profile',
      'james_relationship_state',
      'relationship_presence_permissions',
    ]);
    expect(session.session.normalizedCore.documents.every((document) => document.metadataOnly)).toBe(true);
    expect(session.session.normalizedCore.documents.every((document) => document.liveContinuityExcluded)).toBe(true);
    expect(session.session.normalizedCore.documents.find((document) => document.id === 'james_relationship_state').sourceFocusSummaryMetadataOnly).toBe(true);
    expect(session.session.normalizedCore.documents.find((document) => document.id === 'relationship_presence_permissions')).toEqual(expect.objectContaining({
      localStoreWriteScoped: true,
      blanketRuntimeWritePermission: false,
    }));
  });

  test('session refuses normalized core receipts with duplicate record ids', () => {
    const stateRoot = writeNormalizedCoreStateRoot({ duplicateReceiptIds: true });

    const session = runRuntimeSnippet(`
      process.env.MIRA_STATE_ROOT = ${JSON.stringify(stateRoot)};
      import { getSessionSkeleton } from ${JSON.stringify(compiledRuntimeUrl)};
      console.log(JSON.stringify(getSessionSkeleton()));
    `);

    expect(session.session).toEqual(expect.objectContaining({
      continuityLoaded: false,
      liveDataImported: false,
      normalizedCore: expect.objectContaining({
        loaded: false,
        documentCount: 0,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
        error: expect.stringContaining('approved receipt not found'),
      }),
    }));
  });

  test('status command exposes normalized core counts without claiming full continuity', () => {
    const stateRoot = writeNormalizedCoreStateRoot();
    const output = execFileSync(process.execPath, [
      compiledStatusPath,
      '--json',
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIRA_STATE_ROOT: stateRoot,
      },
      encoding: 'utf8',
    });
    const status = JSON.parse(output);

    expect(status).toEqual(expect.objectContaining({
      receiptCount: 2,
      recordCount: 6,
      continuityLoaded: false,
      liveDataImported: false,
      normalizedCore: expect.objectContaining({
        loaded: true,
        documentCount: 3,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
      }),
      bridge: expect.objectContaining({
        cliAvailable: true,
        allowedRoles: ['architect', 'builder', 'oracle'],
        paneMessageReceive: true,
        runtimeReplyParity: true,
        liveSendManualOnly: true,
        autoSend: false,
        runtimeInvokesSendCli: false,
        telegramRouteControl: false,
      }),
    }));
  });

  test('session still reports no continuity when an empty state root has required buckets', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-empty-state-root-'));
    for (const bucket of ['continuity', 'conversation-evidence', 'permissions', 'acceptance', 'imports', 'bridge']) {
      fs.mkdirSync(path.join(stateRoot, bucket), { recursive: true });
    }

    const session = runRuntimeSnippet(`
      process.env.MIRA_STATE_ROOT = ${JSON.stringify(stateRoot)};
      import { getSessionSkeleton } from ${JSON.stringify(compiledRuntimeUrl)};
      console.log(JSON.stringify(getSessionSkeleton()));
    `);

    expect(session.session).toEqual(expect.objectContaining({
      id: null,
      source: 'none',
      modelBehaviorLoaded: false,
      liveDataImported: false,
      continuityLoaded: false,
      stateRootReady: true,
      stateRootPath: path.resolve(stateRoot),
      stateRootError: null,
      importReceipts: expect.objectContaining({
        receiptCount: 0,
        recordCount: 0,
        continuityLoaded: false,
      }),
      acceptanceContinuity: expect.objectContaining({
        loaded: false,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
      }),
      normalizedCore: expect.objectContaining({
        loaded: false,
        continuityLoaded: false,
        runtimeSessionClaimAllowed: false,
      }),
    }));
  });
});
