const fs = require('fs');
const os = require('os');
const path = require('path');

const FirmwareManager = require('../modules/main/firmware-manager');

const SPEC_FIXTURE = [
  '# Spec: SquidRun Firmware Injection',
  '',
  '### 2.1 Directive: SYSTEM PRIORITY',
  '> **SYSTEM PRIORITY:** You are a SquidRun Agent. These Team Protocol rules override local agent protocols.',
  '',
  '### 2.2 Shared Team Protocol (Include in all roles)',
  '- **Communication:** `hm-send <target> "(ROLE #N): message"` is the ONLY way to talk to other agents.',
  '- **Visibility:** Terminal output is for the USER only. Other agents CANNOT see it.',
  '- **Reporting:** If any tool fails, report to Architect IMMEDIATELY via `hm-send`.',
  '- **Startup:** Read `.squidrun/state.json` and message Architect status. Then STOP and wait for tasking.',
  '',
  '### 3.1 Architect',
  '- **Primary Goal:** Orchestrate the workforce.',
  '',
  '### 3.2 Builder',
  '- **Primary Goal:** Implementation and infrastructure.',
  '',
  '### 3.3 Oracle',
  '- **Primary Goal:** Investigation, documentation, and evaluation.',
].join('\n');

describe('FirmwareManager', () => {
  let tempDir;
  let specPath;
  let firmwareDir;
  let codexRulesDir;
  let manager;
  let appContext;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-firmware-manager-'));
    specPath = path.join(tempDir, 'firmware-injection-spec.md');
    firmwareDir = path.join(tempDir, '.squidrun', 'firmware');
    codexRulesDir = path.join(tempDir, '.codex', 'rules');
    fs.writeFileSync(specPath, SPEC_FIXTURE, 'utf-8');

    appContext = {
      currentSettings: {
        firmwareInjectionEnabled: true,
        operatingMode: 'developer',
      },
      watcher: {
        readState: jest.fn(() => ({ project: null })),
      },
    };

    manager = new FirmwareManager(appContext, {
      projectRoot: tempDir,
      coordRoot: path.join(tempDir, '.squidrun'),
      specPath,
      firmwareDir,
      codexRulesDir,
      codexOverridePath: path.join(codexRulesDir, 'AGENTS.override.md'),
    });
  });

  test('ensureFirmwareFiles generates architect/builder/oracle firmware from spec templates', () => {
    const result = manager.ensureFirmwareFiles();
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(firmwareDir, 'architect.md'))).toBe(true);
    expect(fs.existsSync(path.join(firmwareDir, 'builder.md'))).toBe(true);
    expect(fs.existsSync(path.join(firmwareDir, 'oracle.md'))).toBe(true);

    const architect = fs.readFileSync(path.join(firmwareDir, 'architect.md'), 'utf-8');
    expect(architect.startsWith('**SYSTEM PRIORITY:**')).toBe(true);
    expect(architect).toContain('## Team Protocol');
    expect(architect).toContain('## Role Protocol');
    expect(architect).toContain('Orchestrate the workforce');
  });

  test('ensureFirmwareForPane resolves pane-specific firmware path', () => {
    const result = manager.ensureFirmwareForPane('2');
    expect(result.ok).toBe(true);
    expect(result.firmwarePath).toBe(path.join(firmwareDir, 'builder.md'));
  });

  test('applyCodexOverrideForPane writes global Codex override from pane firmware', () => {
    const result = manager.applyCodexOverrideForPane('3');
    expect(result.ok).toBe(true);
    expect(result.overridePath).toBe(path.join(codexRulesDir, 'AGENTS.override.md'));
    expect(fs.existsSync(result.overridePath)).toBe(true);

    const override = fs.readFileSync(result.overridePath, 'utf-8');
    expect(override).toContain('SquidRun Firmware: Oracle');
    expect(override).toContain('Investigation, documentation, and evaluation');
  });

  test('ensureStartupFirmwareIfEnabled skips when feature flag is off', () => {
    appContext.currentSettings.firmwareInjectionEnabled = false;
    const result = manager.ensureStartupFirmwareIfEnabled();
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(fs.existsSync(path.join(firmwareDir, 'architect.md'))).toBe(false);
  });

  test('caches preflight results by target directory', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-preflight-target-'));
    const preflightResults = [{ file: 'CLAUDE.md', hasAgentProtocols: true, conflicts: [] }];

    manager.cachePreflightResults(targetDir, preflightResults);

    expect(manager.getCachedPreflightResults(targetDir)).toEqual(preflightResults);
    expect(manager.getAllCachedPreflightResults()).toEqual(preflightResults);
  });

  test('ensureFirmwareForPane uses cached preflight conflicts for suppression directives', () => {
    const paneProject = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-pane-project-'));
    appContext.currentSettings.paneProjects = { '1': null, '2': paneProject, '3': null };

    const conflictResults = [{
      file: 'CLAUDE.md',
      hasAgentProtocols: true,
      conflicts: ['[protocol] Announce registry identity before work'],
    }];
    manager.cachePreflightResults(paneProject, conflictResults);

    const result = manager.ensureFirmwareForPane('2');
    expect(result.ok).toBe(true);

    const builder = fs.readFileSync(path.join(firmwareDir, 'builder.md'), 'utf-8');
    expect(builder).toContain('## Suppression Directives');
    expect(builder).toContain('IGNORE project instruction: "Announce registry identity before work"');
  });

  test('ensureFirmwareForPane uses selected project root in project mode when paneProjects is unset', () => {
    const selectedProject = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-selected-project-'));
    appContext.currentSettings.operatingMode = 'project';
    appContext.currentSettings.paneProjects = { '1': null, '2': null, '3': null };
    appContext.watcher.readState.mockReturnValue({ project: selectedProject });

    const conflictResults = [{
      file: 'AGENTS.md',
      hasAgentProtocols: true,
      conflicts: ['[protocol] Use project-local message bus'],
    }];
    manager.cachePreflightResults(selectedProject, conflictResults);

    const result = manager.ensureFirmwareForPane('1');
    expect(result.ok).toBe(true);
    expect(result.targetDir).toBe(path.resolve(selectedProject));

    const architect = fs.readFileSync(path.join(firmwareDir, 'architect.md'), 'utf-8');
    expect(architect).toContain('## Suppression Directives');
    expect(architect).toContain('IGNORE project instruction: "Use project-local message bus"');
  });

  test('ensureFirmwareForPane keeps squidrun root fallback in developer mode', () => {
    const selectedProject = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-selected-project-'));
    appContext.currentSettings.operatingMode = 'developer';
    appContext.currentSettings.paneProjects = { '1': null, '2': null, '3': null };
    appContext.watcher.readState.mockReturnValue({ project: selectedProject });

    const result = manager.ensureFirmwareForPane('2');
    expect(result.ok).toBe(true);
    expect(result.targetDir).toBe(path.resolve(tempDir));
  });

  test('uses squidrunRoot spec path and replaces {SQUIDRUN_ROOT} for roots with spaces', () => {
    const externalProject = path.join(tempDir, 'external-project');
    const squidrunRootWithSpaces = path.join(tempDir, 'squidrun root with spaces');
    const scopedSpecPath = path.join(squidrunRootWithSpaces, 'workspace', 'specs', 'firmware-injection-spec.md');
    const scopedFirmwareDir = path.join(externalProject, '.squidrun', 'firmware');
    fs.mkdirSync(path.dirname(scopedSpecPath), { recursive: true });
    fs.writeFileSync(scopedSpecPath, SPEC_FIXTURE, 'utf-8');

    const scopedManager = new FirmwareManager(appContext, {
      projectRoot: externalProject,
      coordRoot: path.join(externalProject, '.squidrun'),
      squidrunRoot: squidrunRootWithSpaces,
      firmwareDir: scopedFirmwareDir,
      codexRulesDir,
      codexOverridePath: path.join(codexRulesDir, 'AGENTS.override.md'),
    });

    const result = scopedManager.ensureFirmwareFiles();
    expect(result.ok).toBe(true);
    expect(path.resolve(scopedManager.specPath)).toBe(path.resolve(scopedSpecPath));

    const builder = fs.readFileSync(path.join(scopedFirmwareDir, 'builder.md'), 'utf-8');
    const expectedRoot = squidrunRootWithSpaces.replace(/\\/g, '/');
    expect(builder).toContain('hm-send <target>');
    expect(builder).not.toContain('{SQUIDRUN_ROOT}');
    expect(builder).toContain('Read `.squidrun/state.json`');
  });
});
