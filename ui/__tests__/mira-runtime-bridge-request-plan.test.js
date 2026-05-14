'use strict';

const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const path = require('path');

describe('Mira runtime manual bridge request planner', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const runtimeTsconfig = path.join(repoRoot, 'mira', 'runtime', 'tsconfig.json');
  const tscBin = path.join(repoRoot, 'ui', 'node_modules', 'typescript', 'bin', 'tsc');
  const compiledPlannerPath = path.join(repoRoot, 'mira', 'runtime', 'dist', 'bridge-request-plan.js');
  const compiledPlannerUrl = pathToFileURL(compiledPlannerPath).href;
  const bridgeCliPath = path.join(repoRoot, 'mira', 'bridge', 'send-pane-message.js');

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

  function runPlannerSnippet(source) {
    return JSON.parse(execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      source,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    }));
  }

  test.each([
    ['architect', '1'],
    ['builder', '2'],
    ['oracle', '3'],
  ])('plans a manual bridge request for %s', (targetRole, paneId) => {
    const plan = runPlannerSnippet(`
      import { planManualBridgeRequest } from ${JSON.stringify(compiledPlannerUrl)};
      console.log(JSON.stringify(planManualBridgeRequest({
        targetRole: ${JSON.stringify(targetRole)},
        content: ${JSON.stringify(`(MIRA #1): manual plan for ${targetRole}`)},
        sessionId: 'app-session-373',
        messageId: ${JSON.stringify(`mira-runtime-plan-${targetRole}`)},
        requestId: ${JSON.stringify(`req-runtime-plan-${targetRole}`)},
        evidence: [{
          kind: 'file',
          path: 'mira/bridge/squidrun-adapter-protocol-v0.md',
          summary: 'Manual bridge plan evidence.',
        }],
      })));
    `);

    expect(plan).toEqual(expect.objectContaining({
      ok: true,
      protocol: 'mira.runtime_bridge_request_plan.v0',
      manualExecutionRequired: true,
      runtimeExecutes: false,
      target: {
        role: targetRole,
        paneId,
      },
      envelope: expect.objectContaining({
        protocol: 'mira.hm_send_adapter.v0',
        request_id: `req-runtime-plan-${targetRole}`,
        message_id: `mira-runtime-plan-${targetRole}`,
        session_id: 'app-session-373',
        source: {
          service: 'mira-runtime',
          surface: 'runtime-manual-bridge-planner',
        },
        target: {
          system: 'squidrun',
          role: targetRole,
          pane_id: paneId,
        },
        evidence: [{
          kind: 'file',
          path: 'mira/bridge/squidrun-adapter-protocol-v0.md',
          summary: 'Manual bridge plan evidence.',
        }],
        body: {
          content: `(MIRA #1): manual plan for ${targetRole}`,
        },
      }),
      command: {
        executable: process.execPath,
        args: [
          bridgeCliPath,
          '--target',
          targetRole,
          '--content',
          `(MIRA #1): manual plan for ${targetRole}`,
          '--message-id',
          `mira-runtime-plan-${targetRole}`,
          '--request-id',
          `req-runtime-plan-${targetRole}`,
          '--session-id',
          'app-session-373',
          '--evidence-file',
          'mira/bridge/squidrun-adapter-protocol-v0.md',
        ],
        cwd: repoRoot,
      },
    }));
  });

  test.each([
    'telegram',
    'user',
    'https://example.com/hook',
    '@peer-builder',
    'mira',
    '1',
  ])('refuses non-pane target %s without execution fields', (targetRole) => {
    const result = runPlannerSnippet(`
      import { planManualBridgeRequest } from ${JSON.stringify(compiledPlannerUrl)};
      try {
        planManualBridgeRequest({
          targetRole: ${JSON.stringify(targetRole)},
          content: '(MIRA #2): must not plan',
        });
      } catch (error) {
        console.log(JSON.stringify({
          ok: false,
          code: error.code,
          message: error.message,
          hasCommand: Boolean(error.command),
        }));
      }
    `);

    expect(result).toEqual({
      ok: false,
      code: targetRole === '1' ? 'invalid_pane_target' : 'external_target_refused',
      message: expect.stringContaining('only target SquidRun panes'),
      hasCommand: false,
    });
  });
});
