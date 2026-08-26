'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const controller = require('../modules/main/codex-computer-use-standalone-controller');

const PROJECT_ROOT = 'D:\\projects\\squidrun';
const PIPE_PATH = '\\\\.\\pipe\\squidrun-terminal';
const CLIENT_PATH =
  'C:\\Users\\Example User\\.codex\\plugins\\cache\\openai-bundled\\computer-use\\26.721.41059\\scripts\\computer-use-client.mjs';

function generation(paneId) {
  return {
    schema: 'squidrun.codex_computer_use_pipe_generation.v1',
    pipePath:
      '\\\\.\\pipe\\codex-computer-use-f214874c-b61b-4d31-ba3a-e2618aa80e34',
    configPath: 'C:\\Users\\Example User\\.codex\\config.toml',
    projectRoot: PROJECT_ROOT,
    paneId,
    profile: 'main',
  };
}

function daemonIdentity(overrides = {}) {
  return {
    schema: `${controller.STANDALONE_CONTROLLER_SCHEMA}.daemon_identity`,
    pid: 43596,
    createdAt: '2026-07-29T21:12:35.079Z',
    scriptPath: path.join(PROJECT_ROOT, 'ui', 'terminal-daemon.js'),
    pipePath: PIPE_PATH,
    executablePath: 'C:\\Program Files\\SquidRun\\electron.exe',
    commandLineSha256: 'a'.repeat(64),
    daemonPidPath: path.join(PROJECT_ROOT, '.squidrun', 'runtime', 'daemon.pid'),
    projectRoot: PROJECT_ROOT,
    profile: 'main',
    ...overrides,
  };
}

function protectedTerminals() {
  return [
    {
      paneId: '1',
      pid: 51001,
      alive: true,
      createdAt: 1001,
      mode: 'pty-command',
      cwd: PROJECT_ROOT,
    },
    {
      paneId: '2',
      pid: 51002,
      alive: true,
      createdAt: 1002,
      mode: 'pty-command',
      cwd: PROJECT_ROOT,
    },
    {
      paneId: '3',
      pid: 51003,
      alive: true,
      createdAt: 1003,
      mode: 'pty-command',
      cwd: PROJECT_ROOT,
    },
  ];
}

class FakeDaemonClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.connected = false;
    this.pipePath = options.pipePath || PIPE_PATH;
    this.terminals = protectedTerminals();
    this.connectExisting = jest.fn(async () => {
      this.connected = true;
      return true;
    });
    this.spawnAddressed = jest.fn(async (input) => {
      const spawnLeaseId = 'lease-cua-1';
      const pid = 51999;
      const terminal = {
        paneId: input.paneId,
        pid,
        alive: true,
        createdAt: 2001,
        mode: 'pty-command',
        cwd: input.cwd,
        durableAddress: input.durableAddress,
        spawnLeaseId,
      };
      this.terminals.push(terminal);
      return {
        ok: true,
        status: 'spawned',
        durableAddress: input.durableAddress,
        spawnLeaseId,
        terminal,
        receipt: {
          schema: 'squidrun.arm_spawn_receipt.v0',
          eventClass: 'arm.spawn.started',
          status: 'spawned',
          paneId: input.paneId,
          pid,
          durableAddress: input.durableAddress,
          spawnLeaseId,
          sourceMessageId: input.sourceMessageId,
          expectedResponseClass: input.expectedResponseClass,
          owner: input.owner,
          recoveryEvent: input.recoveryEvent,
        },
      };
    });
    this.killAddressed = jest.fn(async (input) => {
      this.terminals = this.terminals.filter((terminal) =>
        !(terminal.paneId === input.paneId
          && terminal.spawnLeaseId === input.spawnLeaseId));
      return {
        ok: true,
        status: 'killed',
        paneId: input.paneId,
        durableAddress: input.durableAddress,
        spawnLeaseId: input.spawnLeaseId,
      };
    });
    this.writeAndWaitAck = jest.fn(async () => ({
      success: true,
      status: 'accepted',
    }));
    this.disconnect = jest.fn(() => {
      this.connected = false;
    });
  }
}

function createHarness(overrides = {}) {
  let uuidIndex = 0;
  let nowMs = 1000;
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ];
  const daemonClient = overrides.daemonClient || new FakeDaemonClient();
  const probeDaemonIdentity = overrides.probeDaemonIdentity
    || jest.fn(async () => ({ ok: true, identity: daemonIdentity() }));
  const confirmGeneration = overrides.confirmGeneration
    || jest.fn(async (expected) => ({
      ok: true,
      reason: 'computer_use_pipe_generation_confirmed',
      bridge: {
        pipeReady: true,
        projectRoot: PROJECT_ROOT,
        paneId: expected.paneId,
        profile: 'main',
        generation: expected,
      },
    }));
  const dependencies = {
    randomUUID: jest.fn(() => ids[uuidIndex++] || crypto.randomUUID()),
    now: () => nowMs,
    sleep: jest.fn(async (ms) => {
      nowMs += Number(ms) || 0;
    }),
    probeDaemonIdentity,
    createDaemonClient: jest.fn(() => daemonClient),
    requestTerminalSnapshot: jest.fn(async (client) => ({
      ok: true,
      terminals: client.terminals.map((terminal) => ({ ...terminal })),
    })),
    prepareBridge: jest.fn(async (input) => ({
      ok: true,
      generation: generation(input.paneId),
      browserPipeSnapshot: {
        before: { ok: true, pipes: ['\\\\.\\pipe\\codex-browser-live'] },
        after: { ok: true, pipes: ['\\\\.\\pipe\\codex-browser-live'] },
        reSnapshotted: true,
      },
      bridge: {
        pipeReady: true,
        projectRoot: PROJECT_ROOT,
        paneId: input.paneId,
        profile: 'main',
        config: {
          codexHome: 'C:\\Users\\Example User\\.codex',
        },
      },
    })),
    resolveClientPath: jest.fn(() => CLIENT_PATH),
    armProofClaim: jest.fn(async ({ claim }) => {
      claim.proof = {
        state: 'armed',
        journalPath: 'C:\\Temp\\squidrun-cua-proof-test\\post-tool-use.jsonl',
        canonicalPlan: {
          toolInputSha256: 'b'.repeat(64),
        },
      };
      claim.proofSpawnEnv = {
        SQUIDRUN_CUA_PROOF_SECRET: 'server-only-secret',
        SQUIDRUN_CUA_PROOF_CLAIM_ID: claim.claimId,
      };
      return { ok: true };
    }),
    confirmGeneration,
    buildProofInvocation: jest.fn(() => ({
      ok: true,
      command:
        "codex --yolo --dangerously-bypass-hook-trust -c 'hooks.PostToolUse=[]'",
    })),
    createStartupLatch: jest.fn(() => {
      let generationIdentity = null;
      return {
        bindGeneration: jest.fn((identity) => {
          generationIdentity = { ...identity };
          return {
            ok: true,
            reason: 'standalone_verifier_generation_bound',
          };
        }),
        beginCleanup: jest.fn(),
        evidence: jest.fn(() => ({
          generation: generationIdentity,
          failure: null,
          outputBytes: 42,
          outputSha256: 'd'.repeat(64),
          outputTail: 'Codex ready',
        })),
        getFailure: jest.fn(() => null),
        waitForFailure: jest.fn(() => new Promise(() => {})),
        wait: jest.fn(async () => ({
          ok: true,
          reason: 'standalone_verifier_startup_output_observed',
          outputBytes: 42,
        })),
        dispose: jest.fn(),
      };
    }),
    buildVerification: jest.fn(() => ({
      ok: true,
      prompt: 'EXACT CANONICAL LIST_WINDOWS PROMPT',
      toolInputSha256: 'b'.repeat(64),
    })),
    verifyJournal: jest.fn(async () => ({
      ok: true,
      status: 'passed',
      reason: 'codex_computer_use_list_windows_attested',
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolUseId: 'tool-1',
      operation: 'list_windows',
      windowCount: 4,
      officialClientPath: CLIENT_PATH,
      officialClientSha256: 'c'.repeat(64),
    })),
    snapshotBrowserPipes: jest.fn(async () => ({
      ok: true,
      pipes: ['\\\\.\\pipe\\codex-browser-live'],
    })),
    cleanupProofArtifacts: jest.fn(() => ({
      ok: true,
      reason: 'proof_artifacts_removed',
    })),
    ...overrides,
  };
  return {
    daemonClient,
    dependencies,
    probeDaemonIdentity,
    confirmGeneration,
  };
}

function activationInput(overrides = {}) {
  return {
    platform: 'win32',
    profile: 'main',
    projectRoot: PROJECT_ROOT,
    workspace: PROJECT_ROOT,
    launchOwner: true,
    executeCurrentSessionProof: true,
    proofTimeoutMs: 1000,
    pollIntervalMs: 25,
    enterDelayMs: 0,
    ...overrides,
  };
}

function attachRealStartupMonitor(harness, options = {}) {
  const originalSpawn = harness.daemonClient.spawnAddressed.getMockImplementation();
  const startupOutput = options.startupOutput || 'Codex ready\r\n';
  const schedule = options.schedule || setImmediate;
  harness.dependencies.createStartupLatch = jest.fn((client, paneId, latchOptions) =>
    controller.createPaneStartupOutputLatch(client, paneId, latchOptions));
  harness.daemonClient.spawnAddressed.mockImplementation(async (input) => {
    const result = await originalSpawn(input);
    schedule(() => {
      harness.daemonClient.emit('data', input.paneId, startupOutput);
      options.afterOutput?.(input, result);
    });
    return result;
  });
}

describe('standalone current-session Computer Use controller', () => {
  test('uses only a fresh spawnAddressed verifier and preserves panes 1, 2, and 3', async () => {
    const harness = createHarness();

    const result = await controller.runStandaloneCodexComputerUseProof(
      activationInput(),
      harness.dependencies
    );

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'passed',
      reason: 'current_session_computer_use_list_windows_proved',
      authoritativeComputerUseReady: true,
      cleanup: expect.objectContaining({
        targetAbsent: true,
        protectedTerminalsPreserved: true,
        daemonPreserved: true,
        browserPipesPreserved: true,
      }),
    }));
    expect(result.claim.paneId).toBe(
      'cua-verifier-11111111-1111-4111-8111-111111111111'
    );
    expect(['1', '2', '3']).not.toContain(result.claim.paneId);
    expect(harness.daemonClient.connectExisting).toHaveBeenCalledTimes(1);
    expect(harness.daemonClient.spawnAddressed).toHaveBeenCalledTimes(1);
    expect(harness.daemonClient.spawnAndWait).toBeUndefined();
    expect(harness.daemonClient.killAddressed).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: result.claim.paneId,
        spawnLeaseId: 'lease-cua-1',
      }),
      expect.any(Object)
    );
    expect(result.invariants.protectedTerminalPidsBefore).toEqual([
      expect.objectContaining({ paneId: '1', pid: 51001 }),
      expect.objectContaining({ paneId: '2', pid: 51002 }),
      expect.objectContaining({ paneId: '3', pid: 51003 }),
    ]);
    expect(result.invariants.protectedTerminalPidsAfter).toEqual(
      result.invariants.protectedTerminalPidsBefore
    );
  });

  test('binds the exact fresh Oracle command, proof env, prompt, and submit event', async () => {
    const harness = createHarness();
    const result = await controller.runStandaloneCodexComputerUseProof(
      activationInput(),
      harness.dependencies
    );

    expect(result.ok).toBe(true);
    expect(harness.dependencies.buildProofInvocation).toHaveBeenCalledWith(
      controller.EXACT_ORACLE_COMMAND,
      expect.objectContaining({
        paneId: expect.stringMatching(/^cua-verifier-/u),
        commandAuthorizedAt: expect.any(String),
      }),
      { platform: 'win32' }
    );
    const spawn = harness.daemonClient.spawnAddressed.mock.calls[0][0];
    expect(spawn).toEqual(expect.objectContaining({
      durableAddress: expect.stringMatching(/^arm:\/\/main\//u),
      dryRun: false,
      mode: 'pty-command',
      env: expect.objectContaining({
        SQUIDRUN_ROLE: 'Oracle',
        SQUIDRUN_PROFILE: 'main',
        SQUIDRUN_PROJECT_ROOT: PROJECT_ROOT,
        SQUIDRUN_CUA_PROOF_SECRET: 'server-only-secret',
      }),
      options: {
        paneCommand:
          "codex --yolo --dangerously-bypass-hook-trust -c 'hooks.PostToolUse=[]'",
        spawnCommandOnCreate: true,
      },
    }));
    expect(harness.daemonClient.writeAndWaitAck.mock.calls[0][1]).toBe(
      'EXACT CANONICAL LIST_WINDOWS PROMPT'
    );
    expect(harness.daemonClient.writeAndWaitAck.mock.calls[1][1]).toBe('\r');
  });

  test('fails immediately on config-error output before settle and returns captured output', async () => {
    const harness = createHarness();
    attachRealStartupMonitor(harness, {
      startupOutput: [
        'Error loading config.toml: invalid shell environment policy in session-flags: ',
        'invalid type: string "[SQUIDRUN_CUA_*]", expected a sequence ',
        'in shell_environment_policy\r\n',
      ].join(''),
      schedule: queueMicrotask,
      afterOutput: (input, result) => {
        const target = result.terminal;
        harness.daemonClient.emit('exit', input.paneId, 1, {
          ...target,
          alive: false,
        });
      },
    });

    const result = await controller.runStandaloneCodexComputerUseProof(
      activationInput({
        startupSettleMs: 25,
        startupOutputTimeoutMs: 500,
      }),
      harness.dependencies
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'standalone_verifier_fatal_startup_output',
      verifierLifecycle: expect.objectContaining({
        outputBytes: expect.any(Number),
        outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        outputTail: expect.stringContaining('Error loading config.toml:'),
      }),
      cleanup: expect.objectContaining({
        addressedGenerationAbsent: true,
        targetAbsent: true,
      }),
    }));
    expect(harness.daemonClient.writeAndWaitAck).not.toHaveBeenCalled();
    expect(harness.dependencies.verifyJournal).not.toHaveBeenCalled();
  });

  test('keeps fatal-output monitoring after startup settle and stops before the poll delay', async () => {
    const harness = createHarness();
    attachRealStartupMonitor(harness);
    harness.dependencies.verifyJournal = jest.fn(async () => {
      const target = harness.daemonClient.terminals.find((terminal) =>
        terminal.paneId.startsWith('cua-verifier-'));
      harness.daemonClient.emit(
        'data',
        target.paneId,
        'Error loading config.toml: late fatal startup output\r\n'
      );
      return {
        ok: false,
        status: 'pending',
        reason: 'codex_computer_use_proof_pending',
      };
    });

    const result = await controller.runStandaloneCodexComputerUseProof(
      activationInput({
        startupSettleMs: 25,
        startupOutputTimeoutMs: 500,
      }),
      harness.dependencies
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'standalone_verifier_fatal_startup_output',
      verifierLifecycle: expect.objectContaining({
        outputTail: expect.stringContaining('late fatal startup output'),
      }),
    }));
    expect(harness.dependencies.verifyJournal).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.sleep).not.toHaveBeenCalledWith(25);
  });

  test('stops on exact target exit during proof and reports a same-pane fallback separately', async () => {
    const harness = createHarness();
    attachRealStartupMonitor(harness);
    harness.daemonClient.killAddressed.mockImplementation(async (input) => ({
      ok: false,
      status: 'not_found',
      reason: 'address_lease_not_found',
      paneId: input.paneId,
      durableAddress: input.durableAddress,
      spawnLeaseId: input.spawnLeaseId,
    }));
    harness.dependencies.verifyJournal = jest.fn(async () => {
      const target = harness.daemonClient.terminals.find((terminal) =>
        terminal.paneId.startsWith('cua-verifier-'));
      target.alive = false;
      harness.daemonClient.emit('exit', target.paneId, 1, {
        ...target,
        alive: false,
      });
      harness.daemonClient.terminals = [
        ...protectedTerminals(),
        {
          paneId: target.paneId,
          pid: 62001,
          alive: true,
          createdAt: 3001,
          mode: 'pty-command',
          cwd: path.join(PROJECT_ROOT, 'ui'),
          durableAddress: null,
          spawnLeaseId: null,
        },
      ];
      return {
        ok: false,
        status: 'pending',
        reason: 'codex_computer_use_proof_pending',
      };
    });

    const result = await controller.runStandaloneCodexComputerUseProof(
      activationInput({
        startupSettleMs: 25,
        startupOutputTimeoutMs: 500,
      }),
      harness.dependencies
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'standalone_verifier_generation_exited',
      verifierLifecycle: expect.objectContaining({
        exitCode: 1,
        exit: expect.objectContaining({
          pid: 51999,
          spawnLeaseId: 'lease-cua-1',
        }),
      }),
      cleanup: expect.objectContaining({
        addressedGenerationAbsent: true,
        targetAbsent: true,
        paneIdAbsent: false,
        samePaneSuccessor: expect.objectContaining({
          pid: 62001,
          durableAddress: null,
          spawnLeaseId: null,
        }),
      }),
    }));
    expect(harness.daemonClient.killAddressed).toHaveBeenCalledWith(
      expect.objectContaining({
        paneId: expect.stringMatching(/^cua-verifier-/u),
        spawnLeaseId: 'lease-cua-1',
      }),
      expect.any(Object)
    );
    expect(harness.daemonClient.terminals).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: 62001, alive: true }),
    ]));
    expect(harness.dependencies.verifyJournal).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.sleep).not.toHaveBeenCalledWith(25);
  });

  test('stops a pending proof when the existing daemon disconnects', async () => {
    const harness = createHarness();
    attachRealStartupMonitor(harness);
    harness.dependencies.verifyJournal = jest.fn(async () => ({
      ok: false,
      status: 'pending',
      reason: 'codex_computer_use_proof_pending',
    }));
    harness.dependencies.sleep = jest.fn(async (ms) => {
      if (ms === 25) harness.daemonClient.emit('disconnected');
    });

    const result = await controller.runStandaloneCodexComputerUseProof(
      activationInput({
        pollIntervalMs: 25,
        startupSettleMs: 25,
        startupOutputTimeoutMs: 500,
      }),
      harness.dependencies
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'standalone_verifier_daemon_disconnected',
      verifierLifecycle: expect.objectContaining({
        outputTail: expect.stringContaining('Codex ready'),
      }),
    }));
    expect(harness.dependencies.verifyJournal).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.sleep).toHaveBeenCalledWith(25);
  });

  test('requires explicit activation, owner-launch authority, main profile, and exact command', async () => {
    const harness = createHarness();

    await expect(controller.runStandaloneCodexComputerUseProof(
      activationInput({ executeCurrentSessionProof: false }),
      harness.dependencies
    )).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'explicit_current_session_proof_authorization_required',
    }));
    await expect(controller.runStandaloneCodexComputerUseProof(
      activationInput({ launchOwner: false }),
      harness.dependencies
    )).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'explicit_codex_desktop_owner_launch_required',
    }));
    await expect(controller.runStandaloneCodexComputerUseProof(
      activationInput({ profile: 'client' }),
      harness.dependencies
    )).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'standalone_controller_non_main_profile_refused',
    }));
    await expect(controller.runStandaloneCodexComputerUseProof(
      activationInput({ command: 'codex resume stale-session' }),
      harness.dependencies
    )).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'standalone_controller_exact_fresh_oracle_command_required',
    }));
    expect(harness.dependencies.createDaemonClient).not.toHaveBeenCalled();
  });

  test('fails closed when the existing daemon pipe is absent and never calls connect()', async () => {
    const daemonClient = new FakeDaemonClient();
    daemonClient.connectExisting.mockResolvedValue(false);
    daemonClient.connect = jest.fn();
    const harness = createHarness({ daemonClient });

    const result = await controller.runStandaloneCodexComputerUseProof(
      activationInput(),
      harness.dependencies
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'existing_daemon_pipe_connect_failed',
    }));
    expect(daemonClient.connectExisting).toHaveBeenCalledTimes(1);
    expect(daemonClient.connect).not.toHaveBeenCalled();
    expect(daemonClient.spawnAddressed).not.toHaveBeenCalled();
  });

  test('cleans only the exact lease when the pipe generation changes after spawn', async () => {
    let confirmCount = 0;
    const confirmGeneration = jest.fn(async (expected) => {
      confirmCount += 1;
      if (confirmCount === 2) {
        return {
          ok: false,
          reason: 'computer_use_pipe_generation_changed',
        };
      }
      return {
        ok: true,
        bridge: {
          pipeReady: true,
          projectRoot: PROJECT_ROOT,
          paneId: expected.paneId,
          profile: 'main',
        },
      };
    });
    const harness = createHarness({ confirmGeneration });

    const result = await controller.runStandaloneCodexComputerUseProof(
      activationInput(),
      harness.dependencies
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'computer_use_pipe_generation_changed',
      cleanup: expect.objectContaining({
        targetAbsent: true,
        protectedTerminalsPreserved: true,
      }),
    }));
    expect(harness.daemonClient.killAddressed).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnLeaseId: 'lease-cua-1',
        paneId: expect.stringMatching(/^cua-verifier-/u),
      }),
      expect.any(Object)
    );
  });

  test('fails permanently on proof timeout and still drains its verifier lease', async () => {
    let verificationCount = 0;
    const verifyJournal = jest.fn(async () => {
      verificationCount += 1;
      return verificationCount === 1
        ? {
            ok: false,
            status: 'pending',
            reason: 'codex_computer_use_proof_pending',
          }
        : {
            ok: false,
            status: 'blocked',
            reason: 'codex_computer_use_proof_timeout',
          };
    });
    const harness = createHarness({ verifyJournal });

    const result = await controller.runStandaloneCodexComputerUseProof(
      activationInput({ pollIntervalMs: 1000 }),
      harness.dependencies
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'codex_computer_use_proof_timeout',
      authoritativeComputerUseReady: false,
      cleanup: expect.objectContaining({
        targetAbsent: true,
        protectedTerminalsPreserved: true,
      }),
    }));
    expect(harness.daemonClient.killAddressed).toHaveBeenCalledTimes(1);
  });

  test('refuses success when a protected pane PID changes', async () => {
    let snapshotCount = 0;
    const harness = createHarness();
    harness.dependencies.requestTerminalSnapshot = jest.fn(async (client) => {
      snapshotCount += 1;
      const terminals = client.terminals.map((terminal) => ({ ...terminal }));
      if (snapshotCount >= 2) {
        const pane3 = terminals.find((terminal) => terminal.paneId === '3');
        pane3.pid = 61003;
      }
      return { ok: true, terminals };
    });

    const result = await controller.runStandaloneCodexComputerUseProof(
      activationInput(),
      harness.dependencies
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'standalone_controller_cleanup_or_invariant_failed',
      originalReason: 'protected_terminal_pid_invariant_changed_after_spawn',
      cleanup: expect.objectContaining({
        protectedTerminalsPreserved: false,
      }),
    }));
    expect(harness.daemonClient.killAddressed).toHaveBeenCalledTimes(1);
  });

  test('refuses success when lease-safe cleanup cannot remove the exact verifier', async () => {
    const daemonClient = new FakeDaemonClient();
    daemonClient.killAddressed.mockImplementation(async (input) => ({
      ok: false,
      status: 'stale_generation',
      reason: 'spawn_lease_mismatch',
      paneId: input.paneId,
      activeSpawnLeaseId: 'lease-cua-newer',
    }));
    const harness = createHarness({ daemonClient });

    const result = await controller.runStandaloneCodexComputerUseProof(
      activationInput(),
      harness.dependencies
    );

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'standalone_controller_cleanup_or_invariant_failed',
      originalReason: 'current_session_computer_use_list_windows_proved',
      cleanup: expect.objectContaining({
        targetAbsent: false,
      }),
    }));
  });

  test('refuses wrapper mentions and Client-root daemon scripts', async () => {
    const exactScript = path.join(PROJECT_ROOT, 'ui', 'terminal-daemon.js');
    const base = {
      platform: 'win32',
      profile: 'main',
      projectRoot: PROJECT_ROOT,
      workspace: PROJECT_ROOT,
      pipePath: PIPE_PATH,
    };
    const readFile = () => '43596';
    const query = (commandLine) => async () => ({
      ok: true,
      process: {
        ProcessId: 43596,
        CreationDate: '2026-07-29T21:12:35.079Z',
        ExecutablePath: 'C:\\Program Files\\nodejs\\node.exe',
        CommandLine: commandLine,
      },
    });

    await expect(controller.probeExistingMainDaemonIdentity(base, {
      readFile,
      queryProcess: query(
        `node.exe wrapper.js --probe "${exactScript}" --dry-run`
      ),
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'existing_daemon_exact_script_identity_mismatch',
    }));
    await expect(controller.probeExistingMainDaemonIdentity(base, {
      readFile,
      queryProcess: query(
        'node.exe "D:\\SquidRun\\Client\\workspace\\ui\\terminal-daemon.js"'
      ),
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: 'existing_daemon_exact_script_identity_mismatch',
    }));
    await expect(controller.probeExistingMainDaemonIdentity(base, {
      readFile,
      queryProcess: query(`node.exe "${exactScript}"`),
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      reason: 'existing_main_daemon_identity_confirmed',
    }));
  });

  test('the tracked controller has no legacy spawn, helper spawn, or custom pipe protocol path', () => {
    const source = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'modules',
        'main',
        'codex-computer-use-standalone-controller.js'
      ),
      'utf8'
    );

    expect(source).not.toContain('spawnAndWait');
    expect(source).not.toContain('codex-computer-use.exe');
    expect(source).not.toContain("daemonClient.connect()");
    expect(source).not.toContain("action: 'spawn'");
    expect(source).toContain('spawnAddressed');
    expect(source).toContain('connectExisting');
  });
});
