const path = require('path');

describe('codex-desktop-inbound-transport', () => {
  let transport;
  let cli;

  function makeRunner(overrides = {}) {
    const calls = [];
    const runner = (command, args = []) => {
      const key = `${command} ${args.join(' ')}`.trim();
      calls.push({ command, args, key });
      const value = overrides[key];
      if (typeof value === 'function') return value(command, args);
      if (value) return value;
      if (command === 'powershell.exe') {
        const script = args[args.length - 1] || '';
        if (script.includes('Get-CimInstance Win32_Process')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                ProcessId: 300152,
                Name: 'Codex.exe',
                ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe',
                CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe"',
              },
              {
                ProcessId: 975084,
                Name: 'codex.exe',
                ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\resources\\codex.exe',
                CommandLine: '"C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\resources\\codex.exe" app-server --analytics-default-enabled',
              },
            ]),
            stderr: '',
          };
        }
        if (script.includes('EnumWindows')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { hwnd: '0xB60CFE', pid: 300152, processName: 'Codex', title: 'Codex' },
            ]),
            stderr: '',
          };
        }
        if (script.includes('Get-AppxPackage')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              appxPackagePresent: true,
              packageName: 'OpenAI.Codex',
              packageVersion: '26.527.3686.0',
              installLocation: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.527.3686.0_x64__2p2nqsd0c76g0',
              manifestHasCodexProtocol: true,
              registryPresent: true,
            }),
            stderr: '',
          };
        }
        if (script.includes('Get-NetTCPConnection')) {
          return { status: 0, stdout: '', stderr: '' };
        }
        if (script.includes('UIAutomationClient')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                name: 'Codex',
                controlType: 'ControlType.Window',
                className: 'Chrome_WidgetWin_1',
                automationId: '',
                isKeyboardFocusable: true,
              },
              {
                name: 'Codex',
                controlType: 'ControlType.Document',
                className: 'Chrome_RenderWidgetHostHWND',
                automationId: '',
                isKeyboardFocusable: true,
              },
            ]),
            stderr: '',
          };
        }
      }
      return { status: 1, stdout: '', stderr: `unhandled ${key}` };
    };
    runner.calls = calls;
    return runner;
  }

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../config', () => ({
      ...require('./helpers/mock-config').mockDefaultConfig,
      getProjectRoot: () => 'D:\\projects\\squidrun',
      resolveCoordPath: (relPath) => path.join('D:\\projects\\squidrun', '.squidrun', relPath),
    }));
    transport = require('../modules/main/codex-desktop-inbound-transport');
    cli = require('../scripts/hm-codex-desktop-transport');
  });

  afterEach(() => {
    jest.dontMock('../config');
  });

  test('classifies current Windows Codex Desktop as blocked for visible inbound injection', () => {
    const runner = makeRunner({
      'where.exe codex': {
        status: 0,
        stdout: 'C:\\Users\\James Kim\\AppData\\Roaming\\npm\\codex\r\nC:\\Users\\James Kim\\AppData\\Roaming\\npm\\codex.cmd\r\n',
        stderr: '',
      },
      'codex --version': { status: 0, stdout: 'codex-cli 0.135.0-alpha.2\n', stderr: '' },
      'codex --help': { status: 0, stdout: 'Usage: codex [OPTIONS] [COMMAND]\nCommands: app app-server remote-control exec\n', stderr: '' },
      'codex app --help': { status: 0, stdout: 'Usage: codex app [OPTIONS] [PATH]\nArguments:\n  [PATH] Workspace path to open in Codex Desktop\n', stderr: '' },
      'codex app-server --help': { status: 0, stdout: 'Usage: codex app-server [OPTIONS] [COMMAND]\n--listen <LISTEN>\n', stderr: '' },
      'codex remote-control --help': { status: 0, stdout: 'Usage: codex remote-control [OPTIONS] [COMMAND]\nCommands: start stop\n', stderr: '' },
      'codex app-server daemon version': { status: 1, stdout: '', stderr: 'Error: codex app-server daemon lifecycle is only supported on Unix platforms\n' },
      'codex app-server proxy': { status: 1, stdout: '', stderr: 'Error: failed to connect to socket at C:\\Users\\James Kim\\.codex\\app-server-control\\app-server-control.sock\n' },
    });

    const result = transport.probeCodexDesktopInboundTransport({
      runner,
      now: '2026-05-30T23:30:00.000Z',
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      schema: transport.PROBE_SCHEMA,
      status: 'blocked',
      plain_answer: 'impossible_without_codex_app_support_for_true_visible_desktop_inbound_messages',
      can_inject_visible_message: false,
      can_summon_workspace: true,
    }));
    expect(result.classification.blockers).toEqual(expect.arrayContaining([
      'no_official_codex_desktop_inbound_message_hook_found',
      'codex_app_cli_accepts_workspace_path_not_prompt',
      'codex_remote_control_daemon_lifecycle_unavailable_on_windows_cli',
      'desktop_app_server_private_or_unreachable_from_local_probe',
      'desktop_app_server_has_no_observed_local_tcp_listener',
      'codex_protocol_registered_but_no_documented_prompt_or_message_payload',
      'ui_automation_not_safe:no_unique_prompt_or_composer_control_exposed_to_uia',
      'computer_use_cannot_automate_codex_itself_per_official_docs',
    ]));
    expect(result.evidence.official.capabilities_to_exploit.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      'codex_windows_app',
      'computer_use_windows',
      'remote_connections',
      'automations',
      'app_server_and_codex_exec',
    ]));
  });

  test('summon opens or focuses the workspace but never claims message injection', () => {
    const runner = makeRunner({
      'where.exe codex': { status: 0, stdout: 'C:\\Users\\James Kim\\AppData\\Roaming\\npm\\codex.cmd\n', stderr: '' },
      'codex --version': { status: 0, stdout: 'codex-cli 0.135.0-alpha.2\n', stderr: '' },
      'codex --help': { status: 0, stdout: 'Usage: codex [OPTIONS] [COMMAND]\nCommands: app app-server remote-control exec\n', stderr: '' },
      'codex app --help': { status: 0, stdout: 'Usage: codex app [OPTIONS] [PATH]\n', stderr: '' },
      'codex app-server --help': { status: 0, stdout: 'Usage: codex app-server\n', stderr: '' },
      'codex remote-control --help': { status: 0, stdout: 'Usage: codex remote-control\n', stderr: '' },
      'codex app-server daemon version': { status: 1, stdout: '', stderr: 'Error: codex app-server daemon lifecycle is only supported on Unix platforms\n' },
      'codex app-server proxy': { status: 1, stdout: '', stderr: 'socket unavailable\n' },
      [`codex app ${path.resolve('D:\\projects\\squidrun')}`]: { status: 0, stdout: '', stderr: '' },
    });

    const result = transport.summonCodexDesktop({
      workspace: 'D:\\projects\\squidrun',
    }, { runner });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      status: 'summoned_workspace_no_injection',
      visibleMessageInjected: false,
      canInjectVisibleMessage: false,
      explicitNonClaim: expect.stringContaining('does not inject'),
    }));
    expect(runner.calls.map((call) => call.key)).toContain(`codex app ${path.resolve('D:\\projects\\squidrun')}`);
  });

  test('CLI probe emits deterministic JSON and exits zero for a blocked report', () => {
    const runner = makeRunner({
      'where.exe codex': { status: 0, stdout: 'C:\\Users\\James Kim\\AppData\\Roaming\\npm\\codex.cmd\n', stderr: '' },
      'codex --version': { status: 0, stdout: 'codex-cli 0.135.0-alpha.2\n', stderr: '' },
      'codex --help': { status: 0, stdout: 'Usage: codex [OPTIONS] [COMMAND]\nCommands: app app-server remote-control exec\n', stderr: '' },
      'codex app --help': { status: 0, stdout: 'Usage: codex app [OPTIONS] [PATH]\n', stderr: '' },
      'codex app-server --help': { status: 0, stdout: 'Usage: codex app-server\n', stderr: '' },
      'codex remote-control --help': { status: 0, stdout: 'Usage: codex remote-control\n', stderr: '' },
      'codex app-server daemon version': { status: 1, stdout: '', stderr: 'Error: codex app-server daemon lifecycle is only supported on Unix platforms\n' },
      'codex app-server proxy': { status: 1, stdout: '', stderr: 'socket unavailable\n' },
    });
    const log = [];

    expect(cli.main(['probe', '--now', '2026-05-30T23:35:00.000Z'], {
      runner,
      logger: (line) => log.push(line),
    })).toBe(0);
    const parsed = JSON.parse(log.at(-1));
    expect(parsed).toEqual(expect.objectContaining({
      schema: transport.PROBE_SCHEMA,
      generated_at: '2026-05-30T23:35:00.000Z',
      status: 'blocked',
      can_inject_visible_message: false,
    }));
  });
});
