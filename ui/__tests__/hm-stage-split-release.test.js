'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildReleaseManifest,
  buildReleasePlan,
  parseArgs,
  renderInstallUpdateScript,
  sanitizeSlug,
} = require('../scripts/hm-stage-split-release');

describe('hm-stage-split-release', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-split-release-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('builds a versioned split-release plan', () => {
    const uiRoot = path.join(tempRoot, 'ui');
    fs.mkdirSync(path.join(uiRoot, 'dist', 'win-unpacked'), { recursive: true });
    fs.writeFileSync(path.join(uiRoot, 'package.json'), JSON.stringify({ version: '9.8.7' }), 'utf8');

    const plan = buildReleasePlan({
      uiRoot,
      instanceName: 'Eun Byeol',
    });

    expect(plan).toEqual(expect.objectContaining({
      schema: 'squidrun.split_release.v1',
      instanceName: 'eun-byeol',
      version: '9.8.7',
      sourceAppDir: path.join(uiRoot, 'dist', 'win-unpacked'),
      outputDir: path.join(uiRoot, 'dist', 'split-releases', 'eun-byeol', 'squidrun-9.8.7'),
      webSocketPort: null,
      dataRootRequiredAtInstall: true,
    }));
    expect(plan.recommendedDataRoot).toBeNull();
    expect(plan.appDir).toBe(path.join(plan.outputDir, 'app'));
  });

  test('records the acknowledged Eunbyeol cutover root as advisory metadata', () => {
    const uiRoot = path.join(tempRoot, 'ui');
    fs.mkdirSync(path.join(uiRoot, 'dist', 'win-unpacked'), { recursive: true });
    fs.writeFileSync(path.join(uiRoot, 'package.json'), JSON.stringify({ version: '9.8.7' }), 'utf8');

    const plan = buildReleasePlan({ uiRoot, instanceName: 'eunbyeol' });

    expect(plan.recommendedDataRoot).toBe('D:\\SquidRun\\Eunbyeol');
    expect(plan.webSocketPort).toBe(9901);
  });

  test('renders install/update script with explicit data-root and main-profile launch contract', () => {
    const script = renderInstallUpdateScript({
      instanceName: 'eunbyeol',
      version: '1.2.3',
    });

    expect(script).toContain('[Parameter(Mandatory=$true)] [string] $DataRoot');
    expect(script).toContain('squidrun-install.json');
    expect(script).toContain('Get-ChildItem Env:TELEGRAM_* -ErrorAction SilentlyContinue | Remove-Item -ErrorAction SilentlyContinue');
    expect(script).toContain('`$env:SQUIDRUN_DATA_ROOT');
    expect(script).toContain('`$env:SQUIDRUN_PROJECT_ROOT');
    expect(script).toContain("`$env:SQUIDRUN_PROFILE = 'main'");
    expect(script).toContain('webSocketPort = 9901');
    expect(script).toContain('settings');
    expect(script).toContain('websocket.json');
    expect(script).toContain('port = 9901');
  });

  test('release manifest records the shared root discovery contract', () => {
    const manifest = buildReleaseManifest({
      instanceName: 'eunbyeol',
      version: '1.2.3',
      appDir: 'D:/release/app',
      installScriptPath: 'D:/release/install-or-update.ps1',
    });

    expect(manifest.dataRootContract).toEqual(expect.objectContaining({
      installTimeParameter: 'DataRoot',
      runtimeEnvOverride: 'SQUIDRUN_DATA_ROOT',
      compatibilityEnv: 'SQUIDRUN_PROJECT_ROOT',
      runtimeProfile: 'main',
      installManifestName: 'squidrun-install.json',
      ownershipScope: 'app_runtime_workspace_state',
      installManifestSecretPolicy: 'pointer_only_no_tokens_or_secrets',
      secretStoragePolicy: 'runtime secrets belong under the data root settings/config, not squidrun-install.json',
      externalDataPolicy: 'external case archives may remain referenced by absolute path at v1 cutover',
    }));
    expect(manifest.dataRootContract.discoveryOrder).toContain('SQUIDRUN_DATA_ROOT');
    expect(manifest.dataRootContract.discoveryOrder).toContain('squidrun-install.json_or_.squidrun-install.json_near_packaged_runtime');
    expect(manifest.dataRootContract.discoveryOrder.indexOf('squidrun-install.json_or_.squidrun-install.json_near_packaged_runtime'))
      .toBeLessThan(manifest.dataRootContract.discoveryOrder.indexOf('git_root_for_dev'));
    expect(manifest.webSocketContract).toEqual(expect.objectContaining({
      runtimeDefaultPort: null,
      mainDevDefaultPort: 9900,
      scopedProfileCompatibilityPort: 9901,
      noSharedPortBetweenConcurrentInstalls: true,
    }));
  });

  test('parses CLI flags', () => {
    expect(parseArgs(['--instance', 'Eun Byeol', '--version', '1.0.0', '--json', '--force'])).toEqual(expect.objectContaining({
      instanceName: 'Eun Byeol',
      version: '1.0.0',
      json: true,
      force: true,
    }));
    expect(parseArgs(['--recommended-data-root', 'D:\\SquidRun\\Eunbyeol', '--websocket-port', '9901'])).toEqual(expect.objectContaining({
      recommendedDataRoot: 'D:\\SquidRun\\Eunbyeol',
      webSocketPort: 9901,
    }));
    expect(sanitizeSlug('Eun Byeol')).toBe('eun-byeol');
  });
});
