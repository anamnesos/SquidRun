#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_ROOT = __dirname;
const UI_ROOT = path.resolve(SCRIPT_ROOT, '..');
const PROJECT_ROOT = path.resolve(UI_ROOT, '..');
const DEFAULT_INSTANCE_NAME = 'eunbyeol';
const RELEASE_SCHEMA = 'squidrun.split_release.v1';
const DEFAULT_RECOMMENDED_DATA_ROOTS = Object.freeze({
  eunbyeol: 'D:\\SquidRun\\Eunbyeol',
});

function usage() {
  return [
    'Usage: node ui/scripts/hm-stage-split-release.js [options]',
    '',
    'Options:',
    '  --instance <name>       Installed instance name (default: eunbyeol)',
    '  --version <version>     Release version (default: ui/package.json version)',
    '  --source-app <path>     Packaged app dir (default: ui/dist/win-unpacked)',
    '  --output-dir <path>     Release output dir (default: ui/dist/split-releases/<instance>/squidrun-<version>)',
    '  --recommended-data-root <path>  Advisory cutover root recorded in release manifest',
    '  --force                 Allow overwriting files in the staged app directory',
    '  --json                  Print machine-readable result',
    '  --help                  Show this help',
    '',
    'The generated install-or-update.ps1 requires -InstallRoot and -DataRoot at cutover time.',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    instanceName: DEFAULT_INSTANCE_NAME,
    version: null,
    sourceAppDir: null,
    outputDir: null,
    recommendedDataRoot: null,
    force: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (token === '--force') {
      parsed.force = true;
      continue;
    }
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    const readValue = (name) => {
      const next = argv[index + 1];
      if (next === undefined || String(next).startsWith('--')) {
        throw new Error(`${name} requires a value`);
      }
      index += 1;
      return String(next);
    };
    if (token === '--instance' || token === '--instance-name') {
      parsed.instanceName = readValue(token);
      continue;
    }
    if (token === '--version') {
      parsed.version = readValue(token);
      continue;
    }
    if (token === '--source-app') {
      parsed.sourceAppDir = readValue(token);
      continue;
    }
    if (token === '--output-dir') {
      parsed.outputDir = readValue(token);
      continue;
    }
    if (token === '--recommended-data-root') {
      parsed.recommendedDataRoot = readValue(token);
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }

  return parsed;
}

function sanitizeSlug(value, fallback = DEFAULT_INSTANCE_NAME) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function readPackageVersion(uiRoot = UI_ROOT) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(uiRoot, 'package.json'), 'utf8'));
  const version = String(packageJson.version || '').trim();
  if (!version) throw new Error('ui/package.json is missing version');
  return version;
}

function buildReleasePlan(options = {}) {
  const instanceName = sanitizeSlug(options.instanceName || DEFAULT_INSTANCE_NAME);
  const version = String(options.version || readPackageVersion(options.uiRoot || UI_ROOT)).trim();
  if (!version) throw new Error('version is required');

  const uiRoot = path.resolve(options.uiRoot || UI_ROOT);
  const sourceAppDir = path.resolve(options.sourceAppDir || path.join(uiRoot, 'dist', 'win-unpacked'));
  const outputDir = path.resolve(
    options.outputDir
    || path.join(uiRoot, 'dist', 'split-releases', instanceName, `squidrun-${version}`)
  );
  const appDir = path.join(outputDir, 'app');
  const installScriptPath = path.join(outputDir, 'install-or-update.ps1');
  const manifestPath = path.join(outputDir, 'release-manifest.json');
  const recommendedDataRoot = options.recommendedDataRoot
    ? path.resolve(options.recommendedDataRoot)
    : (DEFAULT_RECOMMENDED_DATA_ROOTS[instanceName] || null);

  return {
    schema: RELEASE_SCHEMA,
    instanceName,
    version,
    sourceAppDir,
    outputDir,
    appDir,
    installScriptPath,
    manifestPath,
    recommendedDataRoot,
    dataRootRequiredAtInstall: true,
  };
}

function escapePowerShellSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

function renderInstallUpdateScript(plan) {
  const version = escapePowerShellSingleQuoted(plan.version);
  const defaultInstanceName = escapePowerShellSingleQuoted(plan.instanceName);
  return [
    'param(',
    '  [Parameter(Mandatory=$true)] [string] $InstallRoot,',
    '  [Parameter(Mandatory=$true)] [string] $DataRoot,',
    `  [string] $InstanceName = '${defaultInstanceName}',`,
    '  [string] $ShortcutPath = ""',
    ')',
    '',
    '$ErrorActionPreference = "Stop"',
    `$Version = '${version}'`,
    '$ReleaseRoot = Split-Path -Parent $MyInvocation.MyCommand.Path',
    '$SourceAppDir = Join-Path $ReleaseRoot "app"',
    'if (-not (Test-Path -LiteralPath $SourceAppDir)) { throw "Missing staged app directory: $SourceAppDir" }',
    '',
    '$InstallRootFull = [System.IO.Path]::GetFullPath($InstallRoot)',
    '$DataRootFull = [System.IO.Path]::GetFullPath($DataRoot)',
    '$VersionRoot = Join-Path (Join-Path $InstallRootFull "versions") $Version',
    'if (Test-Path -LiteralPath $VersionRoot) { throw "Version root already exists: $VersionRoot. Pick a new version or remove it deliberately." }',
    '',
    'New-Item -ItemType Directory -Force -Path $VersionRoot | Out-Null',
    'New-Item -ItemType Directory -Force -Path (Join-Path $DataRootFull ".squidrun") | Out-Null',
    'Copy-Item -Path (Join-Path $SourceAppDir "*") -Destination $VersionRoot -Recurse -Force',
    '',
    '$InstallManifest = [ordered]@{',
    '  schema = "squidrun.install.v1"',
    '  instanceName = $InstanceName',
    '  profile = "main"',
    '  version = $Version',
    '  dataRoot = $DataRootFull',
    '  generatedAt = (Get-Date).ToUniversalTime().ToString("o")',
    '}',
    '$InstallManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $VersionRoot "squidrun-install.json") -Encoding UTF8',
    '',
    '$ExePath = Join-Path $VersionRoot "SquidRun.exe"',
    'if (-not (Test-Path -LiteralPath $ExePath)) { throw "Missing SquidRun.exe in version root: $ExePath" }',
    '$LauncherPath = Join-Path $InstallRootFull ("Launch-" + $InstanceName + "-SquidRun.ps1")',
    '$Launcher = @(',
    "  \"`$env:SQUIDRUN_DATA_ROOT = '\" + $DataRootFull.Replace(\"'\", \"''\") + \"'\"",
    "  \"`$env:SQUIDRUN_PROJECT_ROOT = '\" + $DataRootFull.Replace(\"'\", \"''\") + \"'\"",
    "  \"`$env:SQUIDRUN_PROFILE = 'main'\"",
    "  \"Start-Process -FilePath '\" + $ExePath.Replace(\"'\", \"''\") + \"' -WorkingDirectory '\" + $VersionRoot.Replace(\"'\", \"''\") + \"'\"",
    ') -join [Environment]::NewLine',
    '$Launcher | Set-Content -LiteralPath $LauncherPath -Encoding UTF8',
    '',
    'if (-not $ShortcutPath) {',
    '  $ShortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) ("SquidRun-" + $InstanceName + ".lnk")',
    '}',
    '$ShortcutParent = Split-Path -Parent $ShortcutPath',
    'if ($ShortcutParent) { New-Item -ItemType Directory -Force -Path $ShortcutParent | Out-Null }',
    '$WshShell = New-Object -ComObject WScript.Shell',
    '$Shortcut = $WshShell.CreateShortcut($ShortcutPath)',
    '$Shortcut.TargetPath = "powershell.exe"',
    '$Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"" + $LauncherPath + "`""',
    '$Shortcut.WorkingDirectory = $InstallRootFull',
    '$Shortcut.Description = "Launch SquidRun " + $InstanceName',
    '$Shortcut.Save()',
    '',
    '[ordered]@{',
    '  ok = $true',
    '  version = $Version',
    '  instanceName = $InstanceName',
    '  installRoot = $InstallRootFull',
    '  dataRoot = $DataRootFull',
    '  versionRoot = $VersionRoot',
    '  launcherPath = $LauncherPath',
    '  shortcutPath = $ShortcutPath',
    '} | ConvertTo-Json -Depth 8',
    '',
  ].join('\r\n');
}

function buildReleaseManifest(plan) {
  return {
    schema: RELEASE_SCHEMA,
    instanceName: plan.instanceName,
    version: plan.version,
    generatedAt: new Date().toISOString(),
    appDir: plan.appDir,
    installScript: plan.installScriptPath,
    dataRootContract: {
      installTimeParameter: 'DataRoot',
      runtimeEnvOverride: 'SQUIDRUN_DATA_ROOT',
      compatibilityEnv: 'SQUIDRUN_PROJECT_ROOT',
      runtimeProfile: 'main',
      installManifestName: 'squidrun-install.json',
      recommendedDataRoot: plan.recommendedDataRoot || null,
      ownershipScope: 'app_runtime_workspace_state',
      installManifestSecretPolicy: 'pointer_only_no_tokens_or_secrets',
      secretStoragePolicy: 'runtime secrets belong under the data root settings/config, not squidrun-install.json',
      externalDataPolicy: 'external case archives may remain referenced by absolute path at v1 cutover',
      discoveryOrder: [
        'legacy_non_main_profile_project_root',
        'SQUIDRUN_DATA_ROOT',
        'SQUIDRUN_WORKSPACE_ROOT',
        'SQUIDRUN_PROJECT_ROOT',
        'git_root_for_dev',
        'squidrun-install.json_or_.squidrun-install.json_near_packaged_runtime',
        '%USERPROFILE%/SquidRun_default',
      ],
    },
  };
}

function stageRelease(plan, options = {}) {
  if (!fs.existsSync(plan.sourceAppDir)) {
    throw new Error(`Packaged app source not found: ${plan.sourceAppDir}. Run npm run package:win from ui/ first.`);
  }

  if (fs.existsSync(plan.appDir) && options.force !== true) {
    throw new Error(`Staged app already exists: ${plan.appDir}. Use --force to overwrite files.`);
  }

  fs.mkdirSync(plan.outputDir, { recursive: true });
  fs.cpSync(plan.sourceAppDir, plan.appDir, {
    recursive: true,
    force: options.force === true,
  });
  fs.writeFileSync(plan.installScriptPath, renderInstallUpdateScript(plan), 'utf8');
  fs.writeFileSync(plan.manifestPath, `${JSON.stringify(buildReleaseManifest(plan), null, 2)}\n`, 'utf8');

  return {
    ok: true,
    plan,
  };
}

function main() {
  try {
    const args = parseArgs();
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const plan = buildReleasePlan(args);
    const result = stageRelease(plan, { force: args.force });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Staged split release ${plan.instanceName} ${plan.version}\n`);
      process.stdout.write(`- App: ${plan.appDir}\n`);
      process.stdout.write(`- Install/update: ${plan.installScriptPath}\n`);
      process.stdout.write(`- Manifest: ${plan.manifestPath}\n`);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReleaseManifest,
  buildReleasePlan,
  parseArgs,
  renderInstallUpdateScript,
  sanitizeSlug,
  stageRelease,
};
