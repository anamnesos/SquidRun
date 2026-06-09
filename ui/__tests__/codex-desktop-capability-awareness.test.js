const fs = require('fs');
const os = require('os');
const path = require('path');

describe('codex-desktop-capability-awareness', () => {
  let tempRoot;
  let awareness;
  let cli;

  function writeJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  function createScript(name) {
    const scriptPath = path.join(tempRoot, 'ui', 'scripts', name);
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/usr/bin/env node\n', 'utf8');
    return scriptPath;
  }

  function makeRunner(processRows = []) {
    const runner = (command, args = []) => {
      if (command === 'powershell.exe') {
        return {
          status: 0,
          stdout: JSON.stringify(processRows),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: `unhandled ${command} ${args.join(' ')}` };
    };
    return runner;
  }

  beforeEach(() => {
    jest.resetModules();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-codex-capability-'));
    fs.mkdirSync(path.join(tempRoot, '.squidrun', 'runtime'), { recursive: true });
    createScript('hm-codex-capability-status.js');
    createScript('hm-codex-attention.js');
    createScript('hm-codex-desktop-transport.js');
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      WORKSPACE_PATH: path.join(tempRoot, '.squidrun'),
      PROJECT_ROOT: tempRoot,
      getProjectRoot: () => tempRoot,
      resolveCoordPath: (relPath) => path.join(
        tempRoot,
        '.squidrun',
        String(relPath || '').replace(/^[/\\]+/, '').replace(/[/\\]+/g, path.sep),
      ),
    }));
    awareness = require('../modules/main/codex-desktop-capability-awareness');
    cli = require('../scripts/hm-codex-capability-status');
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    jest.dontMock('../config');
  });

  test('reports Codex process/app-control availability without legacy heartbeat proof', () => {
    writeJson(path.join(tempRoot, '.squidrun', 'operator-registry.json'), {
      instances: [
        {
          id: 'james-main',
        },
      ],
    });
    writeJson(path.join(tempRoot, '.squidrun', 'coord', 'codex-heartbeat.json'), {
      ts: '2026-05-01T00:00:00.000Z',
      status: 'stale_legacy_file_should_not_count',
    });
    writeJson(path.join(tempRoot, '.squidrun', 'runtime', 'codex-attention-bridge', 'index.json'), {
      schema: 'squidrun.codex_attention_bridge.index.v0',
      updated_at: '2026-05-31T20:50:00.000Z',
      active_request_ids: ['codex-attention-live'],
      requests: [
        { id: 'codex-attention-live', status: 'requested' },
        { id: 'codex-attention-done', status: 'completed' },
      ],
    });
    writeJson(path.join(tempRoot, '.squidrun', 'runtime', 'codex-desktop-inbound-transport-report-v0.json'), {
      generated_at: '2026-05-31T20:40:00.000Z',
      status: 'blocked',
      decision: 'no_supported_safe_visible_codex_desktop_inbound_transport',
      can_summon_workspace: true,
      can_inject_visible_message: false,
    });

    const status = awareness.buildCodexDesktopCapabilityStatus({
      projectRoot: tempRoot,
      nowMs: Date.parse('2026-05-31T21:00:00.000Z'),
      runner: makeRunner([
        {
          Id: 300152,
          ProcessName: 'Codex',
          MainWindowTitle: 'Codex',
          Path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe',
          StartTime: '2026-05-31T12:00:00.000Z',
        },
        {
          Id: 975084,
          ProcessName: 'codex',
          MainWindowTitle: '',
          Path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\resources\\codex.exe',
          StartTime: '2026-05-31T12:01:00.000Z',
        },
      ]),
      platform: 'win32',
    });

    expect(status.status).toBe('process_available_not_monitored');
    expect(status.acceptance_context).toEqual(expect.objectContaining({
      user_correction_source: 'telegram-in-808498547',
      decision: 'surface_existing_codex_desktop_computer_use_app_control_and_attention_inbox_routes_not_new_transport',
    }));
    expect(status.availability.codexDesktopProcess).toEqual(expect.objectContaining({
      status: 'available',
      process_count: 2,
      visible_window_count: 1,
      desktop_process_count: 1,
      cli_or_helper_process_count: 1,
    }));
    expect(status.availability.computerUseAppControl).toEqual(expect.objectContaining({
      status: 'known_route',
      source_message_id: 'telegram-in-808498547',
      not_a_heartbeat: true,
    }));
    expect(status.availability.hmCodexCapabilityStatus).toEqual(expect.objectContaining({
      status: 'available',
      command: 'node ui/scripts/hm-codex-capability-status.js status --json',
    }));
    expect(status.freshness.attentionInbox).toEqual(expect.objectContaining({
      status: 'loaded',
      polling_freshness: 'index_loaded',
      active_count: 1,
      completed_count: 1,
      total_count: 2,
    }));
    expect(status.freshness.heartbeat).toBeUndefined();
    expect(status.availability.hmCodexHeartbeatCheck).toBeUndefined();
    expect(awareness.renderCodexDesktopCapabilityMarkdown(status))
      .toContain('Status: available, not monitored (process_available_not_monitored)');
    expect(status.availability.hmCodexDesktopTransport).toEqual(expect.objectContaining({
      status: 'available',
      can_summon_workspace: true,
      visible_injection_proven: false,
    }));
    expect(status.boundaries.join(' ')).toContain('Do not claim local SquidRun can push a visible message');
  });

  test('derives inbox counts from files rather than hardcoded alive', () => {
    writeJson(path.join(tempRoot, '.squidrun', 'operator-registry.json'), {
      instances: [
        {
          id: 'james-main',
        },
      ],
    });
    writeJson(path.join(tempRoot, '.squidrun', 'runtime', 'codex-attention-bridge', 'index.json'), {
      updated_at: '2026-05-31T20:58:00.000Z',
      active_request_ids: [],
      requests: [
        { id: 'done-1', status: 'completed' },
        { id: 'done-2', status: 'completed' },
        { id: 'blocked-1', status: 'blocked' },
      ],
    });

    const status = awareness.buildCodexDesktopCapabilityStatus({
      projectRoot: tempRoot,
      nowMs: Date.parse('2026-05-31T21:00:00.000Z'),
      runner: makeRunner([]),
      platform: 'win32',
    });

    expect(status.status).toBe('routes_discoverable_process_not_running_or_unproven');
    expect(status.availability.codexDesktopProcess).toEqual(expect.objectContaining({
      status: 'not_running',
      process_count: 0,
    }));
    expect(status.freshness.attentionInbox).toEqual(expect.objectContaining({
      active_count: 0,
      completed_count: 2,
      total_count: 3,
    }));
    expect(status.freshness.heartbeat).toBeUndefined();
  });

  test('does not treat an omitted CLI now-ms value as epoch attention freshness', () => {
    writeJson(path.join(tempRoot, '.squidrun', 'operator-registry.json'), {
      instances: [
        {
          id: 'james-main',
        },
      ],
    });
    writeJson(path.join(tempRoot, '.squidrun', 'runtime', 'codex-attention-bridge', 'index.json'), {
      updated_at: '1970-01-01T00:00:00.000Z',
      active_request_ids: [],
      requests: [],
    });

    const status = awareness.buildCodexDesktopCapabilityStatus({
      projectRoot: tempRoot,
      nowMs: null,
      generatedAt: '2026-05-31T21:15:00.000Z',
      runner: makeRunner([]),
      platform: 'win32',
    });

    expect(status.generated_at).toBe('2026-05-31T21:15:00.000Z');
    expect(status.freshness.heartbeat).toBeUndefined();
    expect(status.freshness.attentionInbox.age_minutes).toBeGreaterThan(0);
  });

  test('CLI emits JSON status and markdown without claiming visible injection', () => {
    writeJson(path.join(tempRoot, '.squidrun', 'operator-registry.json'), {
      instances: [
        {
          id: 'james-main',
        },
      ],
    });
    writeJson(path.join(tempRoot, '.squidrun', 'runtime', 'codex-attention-bridge', 'index.json'), {
      updated_at: '2026-05-31T20:58:00.000Z',
      active_request_ids: [],
      requests: [],
    });
    const stdout = { chunks: [], write(chunk) { this.chunks.push(String(chunk)); } };

    expect(cli.main([
      'status',
      '--project-root',
      tempRoot,
      '--now-ms',
      String(Date.parse('2026-05-31T21:00:00.000Z')),
    ], {
      stdout,
      runner: makeRunner([]),
    })).toBe(0);
    const parsed = JSON.parse(stdout.chunks.join(''));
    expect(parsed.schema).toBe(awareness.STATUS_SCHEMA);
    expect(parsed.availability.hmCodexAttention.command).toBe('node ui/scripts/hm-codex-attention.js list --all');
    expect(parsed.availability.hmCodexDesktopTransport.visible_injection_proven).toBe(false);

    const markdown = awareness.renderCodexDesktopCapabilityMarkdown(parsed);
    expect(markdown).toContain('CODEX DESKTOP CAPABILITY');
    expect(markdown).toContain('visible_injection=not_proven');
    expect(markdown).toContain('hm-codex-capability-status');
    expect(markdown).not.toContain('hm-codex-heartbeat-check');
    expect(markdown).not.toContain('Heartbeat:');
  });
});
