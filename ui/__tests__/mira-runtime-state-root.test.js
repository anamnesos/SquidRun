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
    }));
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
    }));
  });

  test('session still reports no continuity when an empty state root has required buckets', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-empty-state-root-'));
    for (const bucket of ['continuity', 'conversation-evidence', 'permissions', 'acceptance', 'imports']) {
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
    }));
  });
});
