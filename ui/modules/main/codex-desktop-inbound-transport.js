'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  getProjectRoot,
  resolveCoordPath,
} = require('../../config');

const PROBE_SCHEMA = 'squidrun.codex_desktop_inbound_transport.probe.v0';
const DEFAULT_REPORT_RELATIVE_PATH = path.join('runtime', 'codex-desktop-inbound-transport-report-v0.json');

const OFFICIAL_SOURCE_REFS = Object.freeze({
  releaseNotes: 'https://help.openai.com/en/articles/6825453-chatgpt-release-notes',
  computerUse: 'https://developers.openai.com/codex/app/computer-use',
  remoteConnections: 'https://developers.openai.com/codex/remote-connections',
  appServer: 'https://developers.openai.com/codex/app-server',
  windowsApp: 'https://developers.openai.com/codex/app/windows',
  appFeatures: 'https://developers.openai.com/codex/app/features',
  automations: 'https://developers.openai.com/codex/app/automations',
  browser: 'https://developers.openai.com/codex/app/browser',
  chromeExtension: 'https://developers.openai.com/codex/app/chrome-extension',
  nonInteractive: 'https://developers.openai.com/codex/noninteractive',
  plugins: 'https://developers.openai.com/codex/plugins',
  skills: 'https://developers.openai.com/codex/skills',
});

function toOptionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function asIso(value, fallbackMs = Date.now()) {
  if (value instanceof Date) return value.toISOString();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric).toISOString();
  const text = toOptionalString(value, null);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function normalizePathForMetadata(value) {
  return toOptionalString(value, '')?.replace(/\\/g, '/') || '';
}

function truncateText(value, maxLength = 2400) {
  const text = toOptionalString(value, '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...<truncated:${text.length - maxLength}>`;
}

function parseJson(value, fallback = null) {
  const text = toOptionalString(value, null);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function splitLines(value) {
  return toOptionalString(value, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function defaultRunner(command, args = [], options = {}) {
  const useWindowsCommandShim = process.platform === 'win32' && command === 'codex';
  const spawnCommand = useWindowsCommandShim ? 'cmd.exe' : command;
  const spawnArgs = useWindowsCommandShim ? ['/d', '/s', '/c', command, ...args] : args;
  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 5000,
    windowsHide: true,
    input: options.input,
    env: options.env || process.env,
  });
  return {
    command,
    args,
    status: typeof result.status === 'number' ? result.status : null,
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? (result.error.message || String(result.error)) : null,
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

function run(runner, command, args = [], options = {}) {
  try {
    const result = (runner || defaultRunner)(command, args, options) || {};
    return {
      ok: result.status === 0 && !result.error,
      command,
      args,
    status: typeof result.status === 'number' ? result.status : null,
    signal: result.signal || null,
    stdout: truncateText(result.stdout),
    stderr: truncateText(result.stderr),
    rawStdout: result.stdout || '',
    rawStderr: result.stderr || '',
    error: result.error || null,
    timedOut: result.timedOut === true,
  };
  } catch (err) {
    return {
      ok: false,
      command,
      args,
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: err.message || String(err),
      timedOut: false,
    };
  }
}

function runPowerShell(runner, script, options = {}) {
  return run(runner, 'powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], { timeoutMs: options.timeoutMs || 5000 });
}

function summarizeCommand(result = {}) {
  return {
    ok: result.ok === true,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
    timedOut: result.timedOut === true,
  };
}

function detectCodexCli(runner) {
  const where = run(runner, 'where.exe', ['codex'], { timeoutMs: 3000 });
  const version = run(runner, 'codex', ['--version'], { timeoutMs: 5000 });
  const help = run(runner, 'codex', ['--help'], { timeoutMs: 5000 });
  const appHelp = run(runner, 'codex', ['app', '--help'], { timeoutMs: 5000 });
  const appServerHelp = run(runner, 'codex', ['app-server', '--help'], { timeoutMs: 5000 });
  const remoteControlHelp = run(runner, 'codex', ['remote-control', '--help'], { timeoutMs: 5000 });
  const codexPaths = splitLines(where.stdout);
  const appHelpText = `${appHelp.stdout}\n${appHelp.stderr}`;
  return {
    present: where.ok || version.ok || help.ok,
    paths: codexPaths,
    version: splitLines(version.stdout || version.stderr)[0] || null,
    commands: {
      app: {
        present: appHelp.ok,
        acceptsWorkspacePath: /\bcodex app\b[\s\S]*\[PATH\]/i.test(appHelpText),
        documentedPromptArgument: /\bprompt\b/i.test(appHelpText),
        help: summarizeCommand(appHelp),
      },
      appServer: {
        present: appServerHelp.ok,
        help: summarizeCommand(appServerHelp),
      },
      remoteControl: {
        present: remoteControlHelp.ok,
        help: summarizeCommand(remoteControlHelp),
      },
    },
    raw: {
      where: summarizeCommand(where),
      version: summarizeCommand(version),
      help: summarizeCommand(help),
    },
  };
}

function detectDesktopProcesses(runner) {
  if (process.platform !== 'win32') {
    return { supported: false, reason: 'non_windows_host', processes: [] };
  }
  const script = `
$rows = Get-CimInstance Win32_Process -Filter "Name = 'Codex.exe' OR Name = 'codex.exe'" |
  Select-Object ProcessId, Name, ExecutablePath, CommandLine
$rows | ConvertTo-Json -Depth 4
`;
  const result = runPowerShell(runner, script, { timeoutMs: 10000 });
  const parsed = parseJson(result.rawStdout || result.stdout, []);
  const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  const processes = rows.map((row) => ({
    pid: row.ProcessId || row.processId || null,
    name: row.Name || row.name || null,
    executablePath: row.ExecutablePath || row.executablePath || null,
    commandLine: row.CommandLine || row.commandLine || null,
  }));
  return {
    supported: true,
    present: processes.length > 0,
    desktopAppRunning: processes.some((processInfo) => String(processInfo.name || '').toLowerCase() === 'codex.exe'
      && !String(processInfo.commandLine || '').toLowerCase().includes('app-server')),
    privateDesktopAppServerRunning: processes.some((processInfo) => String(processInfo.commandLine || '').includes('app-server')
      && !String(processInfo.commandLine || '').includes('--listen')),
    processes,
    raw: summarizeCommand(result),
  };
}

function detectDesktopWindows(runner) {
  if (process.platform !== 'win32') {
    return { supported: false, reason: 'non_windows_host', windows: [] };
  }
  const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinEnumCodexProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$out = New-Object System.Collections.Generic.List[object]
$callback = [WinEnumCodexProbe+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [WinEnumCodexProbe]::IsWindowVisible($hWnd)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][WinEnumCodexProbe]::GetWindowText($hWnd, $sb, $sb.Capacity)
  $title = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  [uint32]$windowPid = 0
  [void][WinEnumCodexProbe]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
  $proc = Get-Process -Id $windowPid -ErrorAction SilentlyContinue
  if ($title -match 'Codex' -or $proc.ProcessName -match 'Codex') {
    $out.Add([pscustomobject]@{
      hwnd = ('0x{0:X}' -f $hWnd.ToInt64())
      pid = [int]$windowPid
      processName = $proc.ProcessName
      title = $title
    })
  }
  return $true
}
[void][WinEnumCodexProbe]::EnumWindows($callback, [IntPtr]::Zero)
$out | ConvertTo-Json -Depth 4
`;
  const result = runPowerShell(runner, script, { timeoutMs: 6000 });
  const parsed = parseJson(result.rawStdout || result.stdout, []);
  const windows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  return {
    supported: true,
    present: windows.length > 0,
    codexWindowPresent: windows.some((entry) => String(entry.processName || '').toLowerCase() === 'codex'
      || String(entry.title || '').toLowerCase().includes('codex')),
    windows,
    raw: summarizeCommand(result),
  };
}

function detectProtocolHandler(runner) {
  if (process.platform !== 'win32') {
    return { supported: false, reason: 'non_windows_host' };
  }
  const script = `
$pkg = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue
$manifest = $null
$manifestHasCodexProtocol = $false
if ($pkg -and $pkg.InstallLocation) {
  $manifest = Join-Path $pkg.InstallLocation 'AppxManifest.xml'
  if (Test-Path $manifest) {
    $manifestHasCodexProtocol = [bool](Select-String -Path $manifest -Pattern 'uap:Protocol.+Name="codex"|uap:Protocol.+Name=''codex''' -Quiet)
  }
}
$registryPresent = Test-Path 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\codex'
[pscustomobject]@{
  appxPackagePresent = [bool]$pkg
  packageName = $pkg.Name
  packageVersion = $pkg.Version.ToString()
  installLocation = $pkg.InstallLocation
  manifestPath = $manifest
  manifestHasCodexProtocol = $manifestHasCodexProtocol
  registryPresent = $registryPresent
} | ConvertTo-Json -Depth 4
`;
  const result = runPowerShell(runner, script, { timeoutMs: 6000 });
  const parsed = parseJson(result.rawStdout || result.stdout, null);
  return {
    supported: true,
    registered: Boolean(parsed?.manifestHasCodexProtocol || parsed?.registryPresent),
    documentedMessageInjection: false,
    observedPurpose: 'launch_or_focus_codex_app_workspace',
    ...parsed,
    raw: summarizeCommand(result),
  };
}

function detectNetworkListeners(runner, processes = {}) {
  if (process.platform !== 'win32') {
    return { supported: false, reason: 'non_windows_host', listeningTcp: [] };
  }
  const appServerPids = (processes.processes || [])
    .filter((processInfo) => String(processInfo.commandLine || '').includes('app-server'))
    .map((processInfo) => Number(processInfo.pid))
    .filter(Number.isFinite);
  if (appServerPids.length === 0) {
    return { supported: true, appServerPids, listeningTcp: [], raw: null };
  }
  const pidLiteral = appServerPids.join(',');
  const script = `
$pids = @(${pidLiteral})
$rows = Get-NetTCPConnection -ErrorAction SilentlyContinue |
  Where-Object { $pids -contains $_.OwningProcess -and $_.State -eq 'Listen' } |
  Select-Object LocalAddress, LocalPort, State, OwningProcess
$rows | ConvertTo-Json -Depth 4
`;
  const result = runPowerShell(runner, script, { timeoutMs: 6000 });
  const parsed = parseJson(result.rawStdout || result.stdout, []);
  const listeningTcp = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  return {
    supported: true,
    appServerPids,
    listeningTcp,
    hasLocalTcpListener: listeningTcp.length > 0,
    raw: summarizeCommand(result),
  };
}

function detectAppServerAccess(runner) {
  const daemonVersion = run(runner, 'codex', ['app-server', 'daemon', 'version'], { timeoutMs: 5000 });
  const proxy = run(runner, 'codex', ['app-server', 'proxy'], { timeoutMs: 2500 });
  const daemonText = `${daemonVersion.stdout}\n${daemonVersion.stderr}\n${daemonVersion.error || ''}`;
  const proxyText = `${proxy.stdout}\n${proxy.stderr}\n${proxy.error || ''}`;
  return {
    protocolSupportsTurnsAndThreads: true,
    standaloneAppServerAvailable: true,
    desktopAppServerAccessible: proxy.ok,
    daemonLifecycleSupportedHere: !/only supported on Unix platforms/i.test(daemonText),
    daemonVersion: summarizeCommand(daemonVersion),
    proxy: summarizeCommand(proxy),
    observedBlockers: [
      ...(/only supported on Unix platforms/i.test(daemonText)
        ? ['remote_control_daemon_lifecycle_unavailable_on_windows_cli']
        : []),
      ...(proxy.ok ? [] : [`desktop_app_server_proxy_unavailable:${truncateText(proxyText, 220)}`]),
    ],
  };
}

function detectUiAutomation(runner, windows = {}) {
  if (process.platform !== 'win32') {
    return { supported: false, reason: 'non_windows_host', safePromptTarget: false };
  }
  const codexWindow = (windows.windows || []).find((entry) => String(entry.processName || '').toLowerCase() === 'codex'
    || String(entry.title || '').toLowerCase().includes('codex'));
  if (!codexWindow?.hwnd) {
    return {
      supported: true,
      safePromptTarget: false,
      reason: 'codex_window_not_found',
      controls: [],
    };
  }
  const hwnd = String(codexWindow.hwnd);
  const script = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${hwnd})
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$controls = New-Object System.Collections.Generic.List[object]
function Walk($el, $depth) {
  if ($null -eq $el -or $depth -gt 4) { return }
  $controls.Add([pscustomobject]@{
    name = $el.Current.Name
    controlType = $el.Current.ControlType.ProgrammaticName
    className = $el.Current.ClassName
    automationId = $el.Current.AutomationId
    isKeyboardFocusable = $el.Current.IsKeyboardFocusable
    hasKeyboardFocus = $el.Current.HasKeyboardFocus
  })
  $child = $walker.GetFirstChild($el)
  while ($null -ne $child) {
    Walk $child ($depth + 1)
    $child = $walker.GetNextSibling($child)
  }
}
Walk $root 0
$controls | ConvertTo-Json -Depth 5
`;
  const result = runPowerShell(runner, script, { timeoutMs: 7000 });
  const parsed = parseJson(result.rawStdout || result.stdout, []);
  const controls = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  const promptCandidates = controls.filter((control) => {
    const type = String(control.controlType || '').toLowerCase();
    const name = String(control.name || '').toLowerCase();
    return type.includes('edit') || name.includes('message') || name.includes('prompt') || name.includes('composer');
  });
  return {
    supported: true,
    hwnd,
    safePromptTarget: promptCandidates.length === 1,
    reason: promptCandidates.length === 1
      ? 'single_prompt_like_uia_control_found'
      : 'no_unique_prompt_or_composer_control_exposed_to_uia',
    promptCandidates,
    controls: controls.slice(0, 40),
    raw: summarizeCommand(result),
  };
}

function buildOfficialCapabilityStudy() {
  return {
    source_refs: OFFICIAL_SOURCE_REFS,
    verdict: {
      inbound_message_hook: 'not_documented',
      practicalAnswer: 'impossible_without_codex_app_support_for_true_visible_desktop_inbound_messages',
      nuance: 'Codex can be controlled from another signed-in Codex/ChatGPT client via Remote connections, and SquidRun can run its own Codex process via codex exec or app-server. Neither is the same as a local SquidRun action injecting a visible message into the already-running Codex Desktop window.',
    },
    capabilities_to_exploit: [
      {
        id: 'codex_windows_app',
        useForSquidRun: 'Parallel agent threads, worktrees, reviewable diffs, Git workflows, integrated terminal, browser previews, plugins, skills, and native Windows/PowerShell sandboxed work.',
        limits: 'It is a Codex-owned command center, not a generic local IPC inbox for SquidRun.',
      },
      {
        id: 'computer_use_windows',
        useForSquidRun: 'Visual/browser/desktop QA where file output or Playwright is not enough, especially foreground flows James wants Codex to inspect directly.',
        limits: 'On Windows it takes over the foreground desktop, requires visible target apps, and official guidance says Computer Use cannot automate Codex itself.',
      },
      {
        id: 'remote_connections',
        useForSquidRun: 'James or Codex on phone/Mac can continue/start Codex work against this Windows host with the host files, tools, plugins, browser setup, approvals, and screenshots.',
        limits: 'It is account/workspace authenticated Codex-client remote access, not a documented localhost API SquidRun can call to post into the app.',
      },
      {
        id: 'automations',
        useForSquidRun: 'Recurring Codex-side review/triage loops, especially with skills and worktrees.',
        limits: 'Good for Codex waking itself on a schedule; lame as a summon transport because it only works after Codex is already configured to wake/poll.',
      },
      {
        id: 'in_app_browser_and_chrome_extension',
        useForSquidRun: 'Use in-app browser for localhost/file/public preview and comments; use Chrome extension only when signed-in browser state is required.',
        limits: 'The in-app browser is not for authenticated user Chrome state; Chrome extension has higher privacy/approval risk.',
      },
      {
        id: 'app_server_and_codex_exec',
        useForSquidRun: 'Build first-class machine integrations when SquidRun wants Codex-like work as a subprocess or embedded client with structured events.',
        limits: 'This starts/controls a Codex app-server process; it does not attach to the visible Desktop app unless Codex exposes that specific bridge.',
      },
      {
        id: 'plugins_and_skills',
        useForSquidRun: 'Expose SquidRun state and repeatable QA/reporting workflows to Codex as tools/instructions.',
        limits: 'They are pull/invocation surfaces inside Codex, not push notification channels into an idle desktop app.',
      },
    ],
    workflow_changes: [
      'Treat Codex Desktop as the high-fidelity eyes/operator lane for browser, desktop UI, worktree diff review, and Codex-owned long-running work.',
      'Do not make Codex Desktop the primary task ledger or inbound bus for SquidRun unless OpenAI exposes an official inbound message/deep-link/API.',
      'Use SquidRun typed work-items/attention bridge for durable coordination, and add a Codex-consumable plugin/MCP/CLI surface if Codex should pull structured state.',
      'Use codex exec or SquidRun-owned app-server for non-interactive machine jobs where visible Desktop continuity is not required.',
      'For visible summon today, open/focus Codex to the workspace and make the request visible in SquidRun; require James/Codex to send the actual Codex prompt until a supported inbound hook exists.',
    ],
  };
}

function classifyInboundTransport(evidence = {}) {
  const blockers = [];
  if (evidence.official?.verdict?.inbound_message_hook !== 'documented') {
    blockers.push('no_official_codex_desktop_inbound_message_hook_found');
  }
  if (!evidence.codexCli?.commands?.app?.documentedPromptArgument) {
    blockers.push('codex_app_cli_accepts_workspace_path_not_prompt');
  }
  if (evidence.appServer?.daemonLifecycleSupportedHere === false) {
    blockers.push('codex_remote_control_daemon_lifecycle_unavailable_on_windows_cli');
  }
  if (evidence.appServer?.desktopAppServerAccessible !== true) {
    blockers.push('desktop_app_server_private_or_unreachable_from_local_probe');
  }
  if (evidence.network?.hasLocalTcpListener !== true) {
    blockers.push('desktop_app_server_has_no_observed_local_tcp_listener');
  }
  if (evidence.protocol?.registered && evidence.protocol.documentedMessageInjection !== true) {
    blockers.push('codex_protocol_registered_but_no_documented_prompt_or_message_payload');
  }
  if (evidence.uiAutomation?.safePromptTarget !== true) {
    blockers.push(`ui_automation_not_safe:${evidence.uiAutomation?.reason || 'unknown'}`);
  }
  blockers.push('computer_use_cannot_automate_codex_itself_per_official_docs');

  const canSummonWorkspace = Boolean(evidence.codexCli?.present
    && evidence.codexCli?.commands?.app?.present
    && evidence.codexCli?.commands?.app?.acceptsWorkspacePath);

  return {
    status: 'blocked',
    decision: 'no_supported_safe_visible_codex_desktop_inbound_transport',
    plainAnswer: 'impossible_without_codex_app_support_for_true_visible_desktop_inbound_messages',
    canInjectVisibleMessage: false,
    visibleMessageProofAvailable: false,
    canSummonWorkspace,
    possibleNow: [
      'open_or_focus_codex_desktop_workspace_with_codex_app_path',
      'run_separate_codex_non_interactively_with_codex_exec',
      'run_squidrun_owned_codex_app_server_client',
      'connect_to_this_host_from_authorized_codex_clients_when_remote_connections_are_enabled',
    ],
    possibleOnlyWithCodexSideHelperOrAutomation: [
      'codex_thread_automation_or_skill_that_polls_a_squidrun_surface',
      'codex_plugin_or_mcp_tool_that_codex_invokes_from_inside_a_thread',
    ],
    impossibleWithoutCodexAppSupport: [
      'local_squidrun_push_into_existing_visible_codex_desktop_thread',
      'safe_blind_ui_typing_into_codex_composer',
      'using_codex_computer_use_to_control_codex_itself',
    ],
    blockers: Array.from(new Set(blockers)),
    leastBadFallback: {
      id: 'codex_app_workspace_summon_plus_codex_pull_surface',
      description: 'Focus/open Codex Desktop at the target workspace with codex app <path>, keep the structured request in SquidRun, and let Codex pull it through a plugin/MCP/CLI/browser surface or have James paste/send it. This is a summon/focus fallback, not a message injection.',
      noQueueOnlyClaim: true,
    },
  };
}

function probeCodexDesktopInboundTransport(options = {}) {
  const runner = options.runner || defaultRunner;
  const nowIso = asIso(options.now);
  const codexCli = detectCodexCli(runner);
  const processes = detectDesktopProcesses(runner);
  const windows = detectDesktopWindows(runner);
  const protocol = detectProtocolHandler(runner);
  const network = detectNetworkListeners(runner, processes);
  const appServer = detectAppServerAccess(runner);
  const uiAutomation = detectUiAutomation(runner, windows);
  const official = buildOfficialCapabilityStudy();
  const evidence = {
    official,
    codexCli,
    processes,
    windows,
    protocol,
    network,
    appServer,
    uiAutomation,
  };
  const classification = classifyInboundTransport(evidence);
  return {
    ok: false,
    schema: PROBE_SCHEMA,
    version: 1,
    generated_at: nowIso,
    status: classification.status,
    decision: classification.decision,
    plain_answer: classification.plainAnswer,
    can_inject_visible_message: classification.canInjectVisibleMessage,
    can_summon_workspace: classification.canSummonWorkspace,
    official_source_refs: OFFICIAL_SOURCE_REFS,
    classification,
    evidence,
  };
}

function resolveReportPath(options = {}) {
  if (toOptionalString(options.outPath, null)) return path.resolve(options.outPath);
  if (typeof resolveCoordPath === 'function') {
    return resolveCoordPath(DEFAULT_REPORT_RELATIVE_PATH, { forWrite: true });
  }
  return path.join(getProjectRoot(), '.squidrun', DEFAULT_REPORT_RELATIVE_PATH);
}

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath, payload) {
  ensureDirForFile(filePath);
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
  return filePath;
}

function writeProbeReport(payload, options = {}) {
  const reportPath = resolveReportPath(options);
  writeJsonAtomic(reportPath, payload);
  return {
    ok: true,
    report_path: normalizePathForMetadata(reportPath),
  };
}

function summonCodexDesktop(input = {}, options = {}) {
  const runner = options.runner || defaultRunner;
  const workspace = path.resolve(toOptionalString(input.workspace || input.path || options.workspace, process.cwd()));
  const probe = input.probe || probeCodexDesktopInboundTransport({ ...options, runner });
  const dryRun = input.dryRun === true || options.dryRun === true;

  if (!probe.classification?.canSummonWorkspace) {
    return {
      ok: false,
      schema: PROBE_SCHEMA,
      status: 'blocked',
      decision: 'codex_workspace_summon_unavailable',
      reason: 'codex_app_cli_unavailable_or_no_workspace_path_support',
      visibleMessageInjected: false,
      canInjectVisibleMessage: false,
      probe,
    };
  }

  const command = ['app', workspace];
  const result = dryRun
    ? { ok: true, status: 0, stdout: '', stderr: '', error: null, dryRun: true }
    : run(runner, 'codex', command, { timeoutMs: 7000 });

  return {
    ok: result.ok === true,
    schema: PROBE_SCHEMA,
    status: result.ok === true ? 'summoned_workspace_no_injection' : 'blocked',
    decision: result.ok === true
      ? (dryRun ? 'codex_workspace_focus_dry_run_available' : 'codex_workspace_focus_attempted')
      : 'codex_workspace_focus_failed',
    workspace: normalizePathForMetadata(workspace),
    dryRun,
    command: {
      executable: 'codex',
      args: command,
      result: summarizeCommand(result),
    },
    visibleMessageInjected: false,
    canInjectVisibleMessage: false,
    explicitNonClaim: 'This command opens or focuses a Codex workspace only. It does not inject a visible message into Codex Desktop.',
    leastBadFallback: probe.classification?.leastBadFallback || null,
  };
}

module.exports = {
  DEFAULT_REPORT_RELATIVE_PATH,
  OFFICIAL_SOURCE_REFS,
  PROBE_SCHEMA,
  buildOfficialCapabilityStudy,
  classifyInboundTransport,
  defaultRunner,
  probeCodexDesktopInboundTransport,
  resolveReportPath,
  summonCodexDesktop,
  writeProbeReport,
};
