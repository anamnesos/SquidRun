const fs = require('fs');
const os = require('os');
const path = require('path');

const FirmwareManager = require('../modules/main/firmware-manager');

const SPEC_FIXTURE = [
  '# Spec: Hivemind Firmware Injection',
  '',
  '### 2.1 Directive: SYSTEM PRIORITY',
  '> **SYSTEM PRIORITY:** You are a Hivemind Agent. These Team Protocol rules override local agent protocols.',
  '',
  '### 2.2 Shared Team Protocol (Include in all roles)',
  '- **Communication:** `node ui/scripts/hm-send.js <target> "(ROLE #N): message"` is the ONLY way to talk to other agents.',
  '- **Visibility:** Terminal output is for the USER only. Other agents CANNOT see it.',
  '- **Reporting:** If any tool fails, report to Architect IMMEDIATELY via `hm-send.js`.',
  '- **Startup:** Read `.hivemind/app-status.json` and message Architect status. Then STOP and wait for tasking.',
  '',
  '### 3.1 Director (Architect)',
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-firmware-manager-'));
    specPath = path.join(tempDir, 'firmware-injection-spec.md');
    firmwareDir = path.join(tempDir, '.hivemind', 'firmware');
    codexRulesDir = path.join(tempDir, '.codex', 'rules');
    fs.writeFileSync(specPath, SPEC_FIXTURE, 'utf-8');

    appContext = {
      currentSettings: {
        firmwareInjectionEnabled: true,
      },
    };

    manager = new FirmwareManager(appContext, {
      projectRoot: tempDir,
      coordRoot: path.join(tempDir, '.hivemind'),
      specPath,
      firmwareDir,
      codexRulesDir,
      codexOverridePath: path.join(codexRulesDir, 'AGENTS.override.md'),
    });
  });

  test('ensureFirmwareFiles generates director/builder/oracle firmware from spec templates', () => {
    const result = manager.ensureFirmwareFiles();
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(firmwareDir, 'director.md'))).toBe(true);
    expect(fs.existsSync(path.join(firmwareDir, 'builder.md'))).toBe(true);
    expect(fs.existsSync(path.join(firmwareDir, 'oracle.md'))).toBe(true);

    const director = fs.readFileSync(path.join(firmwareDir, 'director.md'), 'utf-8');
    expect(director.startsWith('**SYSTEM PRIORITY:**')).toBe(true);
    expect(director).toContain('## Team Protocol');
    expect(director).toContain('## Role Protocol');
    expect(director).toContain('Orchestrate the workforce');
  });

  test('ensureFirmwareForPane resolves pane-specific firmware path', () => {
    const result = manager.ensureFirmwareForPane('2');
    expect(result.ok).toBe(true);
    expect(result.firmwarePath).toBe(path.join(firmwareDir, 'builder.md'));
  });

  test('applyCodexOverrideForPane writes global Codex override from pane firmware', () => {
    const result = manager.applyCodexOverrideForPane('5');
    expect(result.ok).toBe(true);
    expect(result.overridePath).toBe(path.join(codexRulesDir, 'AGENTS.override.md'));
    expect(fs.existsSync(result.overridePath)).toBe(true);

    const override = fs.readFileSync(result.overridePath, 'utf-8');
    expect(override).toContain('Hivemind Firmware: Oracle');
    expect(override).toContain('Investigation, documentation, and evaluation');
  });

  test('ensureStartupFirmwareIfEnabled skips when feature flag is off', () => {
    appContext.currentSettings.firmwareInjectionEnabled = false;
    const result = manager.ensureStartupFirmwareIfEnabled();
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(fs.existsSync(path.join(firmwareDir, 'director.md'))).toBe(false);
  });

  test('caches preflight results by target directory', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-preflight-target-'));
    const preflightResults = [{ file: 'CLAUDE.md', hasAgentProtocols: true, conflicts: [] }];

    manager.cachePreflightResults(targetDir, preflightResults);

    expect(manager.getCachedPreflightResults(targetDir)).toEqual(preflightResults);
    expect(manager.getAllCachedPreflightResults()).toEqual(preflightResults);
  });

  test('ensureFirmwareForPane uses cached preflight conflicts for suppression directives', () => {
    const paneProject = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemind-pane-project-'));
    appContext.currentSettings.paneProjects = { '1': null, '2': paneProject, '5': null };

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
});
