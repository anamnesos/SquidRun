'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_RELATIVE_PATH,
  READY,
  SCHEMA,
  defaultStaleState,
  deriveStateFromVerifierResult,
  formatStartupStaleMarker,
  isStaleBootstrapState,
  readBootstrapState,
  resolveStatePath,
  writeBootstrapState,
} = require('../modules/mira-lab-verify-bootstrap-state');

function makeTempProject() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-bootstrap-'));
  fs.mkdirSync(path.join(tempRoot, '.squidrun', 'runtime'), { recursive: true });
  return tempRoot;
}

describe('mira-lab-verify-bootstrap-state', () => {
  test('defaults to unknown stale state when the state file is missing', () => {
    const tempRoot = makeTempProject();
    try {
      const state = readBootstrapState({ projectRoot: tempRoot });
      expect(state).toEqual(defaultStaleState());
      expect(isStaleBootstrapState(state)).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('resolveStatePath uses .squidrun/runtime/mira-lab-verify-bootstrap.json under the project root', () => {
    const tempRoot = makeTempProject();
    try {
      const expected = path.join(tempRoot, '.squidrun', DEFAULT_RELATIVE_PATH);
      expect(path.resolve(resolveStatePath({ projectRoot: tempRoot }))).toBe(path.resolve(expected));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('writeBootstrapState round-trips through readBootstrapState with schema enforced', () => {
    const tempRoot = makeTempProject();
    try {
      const writeResult = writeBootstrapState({
        bootstrap_status: READY,
        prompt_path_status: 'complete',
        last_verified_at: '2026-05-10T20:00:00.000Z',
        last_run: { session_id: 'verify-test', all_pass: true, renderer_window_open_ok: true },
      }, { projectRoot: tempRoot });

      expect(writeResult.ok).toBe(true);
      expect(fs.existsSync(writeResult.statePath)).toBe(true);

      const state = readBootstrapState({ projectRoot: tempRoot });
      expect(state).toEqual(expect.objectContaining({
        schema: SCHEMA,
        bootstrap_status: READY,
        prompt_path_status: 'complete',
        last_verified_at: '2026-05-10T20:00:00.000Z',
        last_run: expect.objectContaining({ all_pass: true, renderer_window_open_ok: true }),
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('isStaleBootstrapState returns false only for ready and true for every other status', () => {
    expect(isStaleBootstrapState({ bootstrap_status: 'ready' })).toBe(false);
    expect(isStaleBootstrapState({ bootstrap_status: 'unknown' })).toBe(true);
    expect(isStaleBootstrapState({ bootstrap_status: 'action_not_loaded_in_running_main' })).toBe(true);
    expect(isStaleBootstrapState({ bootstrap_status: 'app_control_unreachable' })).toBe(true);
    expect(isStaleBootstrapState({ bootstrap_status: 'open_failed' })).toBe(true);
    expect(isStaleBootstrapState({ bootstrap_status: '' })).toBe(true);
    expect(isStaleBootstrapState(null)).toBe(true);
  });

  test('deriveStateFromVerifierResult marks prompt_path complete only when every prompt passes', () => {
    const passingResult = {
      session_id: 'verify-x',
      started_at: '2026-05-10T19:00:00.000Z',
      bootstrap_status: 'action_not_loaded_in_running_main',
      renderer_window_open: { attempted: true, ok: false },
      prompts: [
        { decision: 'pass' },
        { decision: 'pass' },
        { decision: 'pass' },
        { decision: 'pass', windows_libuv_teardown_observed: false },
      ],
      all_pass: true,
    };
    const derivedPass = deriveStateFromVerifierResult(passingResult);
    expect(derivedPass.prompt_path_status).toBe('complete');
    expect(derivedPass.bootstrap_status).toBe('action_not_loaded_in_running_main');
    expect(derivedPass.last_run).toEqual(expect.objectContaining({
      session_id: 'verify-x',
      all_pass: true,
      renderer_window_open_ok: false,
    }));

    const partial = {
      ...passingResult,
      prompts: [
        { decision: 'pass' },
        { decision: 'blocked', windows_libuv_teardown_observed: false },
        { decision: 'pass' },
        { decision: 'pass' },
      ],
      all_pass: false,
    };
    const derivedPartial = deriveStateFromVerifierResult(partial);
    expect(derivedPartial.prompt_path_status).toBe('incomplete');
    expect(derivedPartial.last_run.all_pass).toBe(false);
  });

  test('formatStartupStaleMarker returns a concise block when stale, and empty string when ready', () => {
    const staleBlock = formatStartupStaleMarker({
      bootstrap_status: 'action_not_loaded_in_running_main',
      prompt_path_status: 'complete',
      last_verified_at: '2026-05-10T20:00:00.000Z',
    });
    expect(staleBlock).toMatch(/Mira Lab Verifier Bootstrap: stale \(window-open only\)/);
    expect(staleBlock).toMatch(/prompt_path: PASS/);
    expect(staleBlock).toMatch(/hm-mira-lab-verify\.js --session-id verify-post-restart-mira-lab --json/);
    expect(staleBlock).toMatch(/bootstrap_status=ready, renderer_window_open\.ok=true, all_pass=true/);
    expect(staleBlock.split('\n').length).toBeLessThanOrEqual(8);

    expect(formatStartupStaleMarker({ bootstrap_status: 'ready', prompt_path_status: 'complete' })).toBe('');
  });

  test('marker clears once the verifier records bootstrap_status: ready', () => {
    const tempRoot = makeTempProject();
    try {
      writeBootstrapState({
        bootstrap_status: 'action_not_loaded_in_running_main',
        prompt_path_status: 'complete',
      }, { projectRoot: tempRoot });
      const stale = formatStartupStaleMarker(readBootstrapState({ projectRoot: tempRoot }));
      expect(stale).toMatch(/stale \(window-open only\)/);

      writeBootstrapState({
        bootstrap_status: READY,
        prompt_path_status: 'complete',
        last_verified_at: '2026-05-10T20:30:00.000Z',
      }, { projectRoot: tempRoot });
      const cleared = formatStartupStaleMarker(readBootstrapState({ projectRoot: tempRoot }));
      expect(cleared).toBe('');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
