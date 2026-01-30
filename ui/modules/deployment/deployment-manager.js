/**
 * Deployment Manager (Task #15)
 *
 * Handles build automation, deployment pipelines, and CI/CD integration.
 * Supports multiple deployment targets and environments.
 */

'use strict';

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Deployment configuration
const DEFAULT_CONFIG = {
  projectName: 'hivemind',
  version: '0.1.0',
  environments: {
    development: {
      name: 'Development',
      autoDeployBranch: null,
      buildCommand: 'npm run build:dev',
      preDeploy: [],
      postDeploy: []
    },
    staging: {
      name: 'Staging',
      autoDeployBranch: 'develop',
      buildCommand: 'npm run build:staging',
      preDeploy: ['npm run test'],
      postDeploy: ['npm run notify:staging']
    },
    production: {
      name: 'Production',
      autoDeployBranch: 'main',
      buildCommand: 'npm run build:prod',
      preDeploy: ['npm run test', 'npm run lint'],
      postDeploy: ['npm run notify:production']
    }
  },
  targets: {
    electron: {
      name: 'Electron App',
      platforms: ['win32', 'darwin', 'linux'],
      outputDir: 'dist',
      packageCommand: 'npm run package'
    },
    github: {
      name: 'GitHub Release',
      createRelease: true,
      uploadAssets: true,
      draft: false,
      prerelease: false
    }
  }
};

// Build state tracking
const buildState = {
  currentBuild: null,
  buildHistory: [],
  deployHistory: [],
  pipelineRuns: [],
  config: { ...DEFAULT_CONFIG }
};

// Build status enum
const BuildStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

// Pipeline stage enum
const PipelineStage = {
  CHECKOUT: 'checkout',
  INSTALL: 'install',
  LINT: 'lint',
  TEST: 'test',
  BUILD: 'build',
  PACKAGE: 'package',
  DEPLOY: 'deploy',
  NOTIFY: 'notify'
};

/**
 * Initialize deployment manager
 */
function initialize(projectDir) {
  const configPath = path.join(projectDir, 'deploy.config.json');

  // Load existing config if present
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const loaded = JSON.parse(content);
      buildState.config = { ...DEFAULT_CONFIG, ...loaded };
    } catch (err) {
      console.error('[Deploy] Failed to load config:', err.message);
    }
  }

  // Load build history
  const historyPath = path.join(projectDir, '.deploy-history.json');
  if (fs.existsSync(historyPath)) {
    try {
      const content = fs.readFileSync(historyPath, 'utf8');
      const data = JSON.parse(content);
      buildState.buildHistory = data.builds || [];
      buildState.deployHistory = data.deploys || [];
      buildState.pipelineRuns = data.pipelines || [];
    } catch (err) {
      console.error('[Deploy] Failed to load history:', err.message);
    }
  }

  return buildState.config;
}

/**
 * Save deployment history
 */
function saveHistory(projectDir) {
  const historyPath = path.join(projectDir, '.deploy-history.json');
  const data = {
    builds: buildState.buildHistory.slice(-100),
    deploys: buildState.deployHistory.slice(-50),
    pipelines: buildState.pipelineRuns.slice(-50)
  };

  try {
    fs.writeFileSync(historyPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[Deploy] Failed to save history:', err.message);
  }
}

/**
 * Save deployment configuration
 */
function saveConfig(projectDir, config) {
  const configPath = path.join(projectDir, 'deploy.config.json');

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    buildState.config = { ...DEFAULT_CONFIG, ...config };
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Run a shell command with streaming output
 */
function runCommand(command, cwd, onOutput) {
  return new Promise((resolve, reject) => {
    const isWindows = os.platform() === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArg = isWindows ? '/c' : '-c';

    const proc = spawn(shell, [shellArg, command], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (onOutput) onOutput('stdout', text);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (onOutput) onOutput('stderr', text);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, stdout, stderr, code });
      } else {
        reject({ success: false, stdout, stderr, code, error: `Command failed with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      reject({ success: false, error: err.message, stdout, stderr });
    });
  });
}

/**
 * Create a new build
 */
function createBuild(environment, options = {}) {
  const build = {
    id: `build-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    environment,
    status: BuildStatus.PENDING,
    startTime: null,
    endTime: null,
    stages: [],
    logs: [],
    artifacts: [],
    version: buildState.config.version,
    commit: options.commit || null,
    branch: options.branch || null,
    triggeredBy: options.triggeredBy || 'manual',
    options
  };

  buildState.currentBuild = build;
  buildState.buildHistory.unshift(build);

  return build;
}

/**
 * Update build status
 */
function updateBuild(buildId, updates) {
  const build = buildState.buildHistory.find(b => b.id === buildId);
  if (build) {
    Object.assign(build, updates);
  }
  return build;
}

/**
 * Add build log entry
 */
function addBuildLog(buildId, level, message, stage = null) {
  const build = buildState.buildHistory.find(b => b.id === buildId);
  if (build) {
    build.logs.push({
      timestamp: new Date().toISOString(),
      level,
      message,
      stage
    });
  }
}

/**
 * Run a build stage
 */
async function runStage(build, stageName, command, cwd, onProgress) {
  const stage = {
    name: stageName,
    status: BuildStatus.RUNNING,
    startTime: new Date().toISOString(),
    endTime: null,
    output: ''
  };

  build.stages.push(stage);
  addBuildLog(build.id, 'info', `Starting stage: ${stageName}`, stageName);

  if (onProgress) {
    onProgress({ type: 'stage_start', stage: stageName, build });
  }

  try {
    const result = await runCommand(command, cwd, (stream, text) => {
      stage.output += text;
      addBuildLog(build.id, stream === 'stderr' ? 'warn' : 'info', text, stageName);
      if (onProgress) {
        onProgress({ type: 'output', stage: stageName, stream, text });
      }
    });

    stage.status = BuildStatus.SUCCESS;
    stage.endTime = new Date().toISOString();
    addBuildLog(build.id, 'info', `Stage completed: ${stageName}`, stageName);

    if (onProgress) {
      onProgress({ type: 'stage_complete', stage: stageName, status: 'success', build });
    }

    return { success: true, output: result.stdout };
  } catch (err) {
    stage.status = BuildStatus.FAILED;
    stage.endTime = new Date().toISOString();
    stage.error = err.error || err.message;
    addBuildLog(build.id, 'error', `Stage failed: ${stageName} - ${stage.error}`, stageName);

    if (onProgress) {
      onProgress({ type: 'stage_complete', stage: stageName, status: 'failed', error: stage.error, build });
    }

    return { success: false, error: stage.error };
  }
}

/**
 * Run the full build pipeline
 */
async function runPipeline(projectDir, environment, options = {}, onProgress) {
  const envConfig = buildState.config.environments[environment];
  if (!envConfig) {
    return { success: false, error: `Unknown environment: ${environment}` };
  }

  const build = createBuild(environment, options);
  build.status = BuildStatus.RUNNING;
  build.startTime = new Date().toISOString();

  addBuildLog(build.id, 'info', `Starting pipeline for ${environment}`);

  if (onProgress) {
    onProgress({ type: 'pipeline_start', build });
  }

  try {
    // Stage 1: Install dependencies
    if (options.install !== false) {
      const installResult = await runStage(
        build,
        PipelineStage.INSTALL,
        'npm ci',
        projectDir,
        onProgress
      );
      if (!installResult.success) {
        throw new Error(`Install failed: ${installResult.error}`);
      }
    }

    // Stage 2: Pre-deploy commands (lint, test, etc.)
    for (const preCmd of (envConfig.preDeploy || [])) {
      const stageResult = await runStage(
        build,
        preCmd.includes('lint') ? PipelineStage.LINT : PipelineStage.TEST,
        preCmd,
        projectDir,
        onProgress
      );
      if (!stageResult.success && !options.continueOnError) {
        throw new Error(`Pre-deploy command failed: ${preCmd}`);
      }
    }

    // Stage 3: Build
    if (envConfig.buildCommand) {
      const buildResult = await runStage(
        build,
        PipelineStage.BUILD,
        envConfig.buildCommand,
        projectDir,
        onProgress
      );
      if (!buildResult.success) {
        throw new Error(`Build failed: ${buildResult.error}`);
      }
    }

    // Stage 4: Package (if electron target)
    if (options.package && buildState.config.targets.electron) {
      const packageResult = await runStage(
        build,
        PipelineStage.PACKAGE,
        buildState.config.targets.electron.packageCommand || 'npm run package',
        projectDir,
        onProgress
      );
      if (!packageResult.success) {
        throw new Error(`Package failed: ${packageResult.error}`);
      }

      // Collect artifacts
      const outputDir = path.join(projectDir, buildState.config.targets.electron.outputDir || 'dist');
      if (fs.existsSync(outputDir)) {
        const files = fs.readdirSync(outputDir);
        build.artifacts = files.map(f => ({
          name: f,
          path: path.join(outputDir, f),
          size: fs.statSync(path.join(outputDir, f)).size
        }));
      }
    }

    // Stage 5: Post-deploy commands
    for (const postCmd of (envConfig.postDeploy || [])) {
      const stageResult = await runStage(
        build,
        PipelineStage.NOTIFY,
        postCmd,
        projectDir,
        onProgress
      );
      // Post-deploy failures are logged but don't fail the build
      if (!stageResult.success) {
        addBuildLog(build.id, 'warn', `Post-deploy command failed (non-fatal): ${postCmd}`);
      }
    }

    build.status = BuildStatus.SUCCESS;
    build.endTime = new Date().toISOString();
    addBuildLog(build.id, 'info', 'Pipeline completed successfully');

    if (onProgress) {
      onProgress({ type: 'pipeline_complete', status: 'success', build });
    }

    saveHistory(projectDir);
    return { success: true, build };

  } catch (err) {
    build.status = BuildStatus.FAILED;
    build.endTime = new Date().toISOString();
    build.error = err.message;
    addBuildLog(build.id, 'error', `Pipeline failed: ${err.message}`);

    if (onProgress) {
      onProgress({ type: 'pipeline_complete', status: 'failed', error: err.message, build });
    }

    saveHistory(projectDir);
    return { success: false, error: err.message, build };
  }
}

/**
 * Cancel current build
 */
function cancelBuild(buildId) {
  const build = buildState.buildHistory.find(b => b.id === buildId);
  if (build && build.status === BuildStatus.RUNNING) {
    build.status = BuildStatus.CANCELLED;
    build.endTime = new Date().toISOString();
    addBuildLog(build.id, 'warn', 'Build cancelled by user');
    return { success: true };
  }
  return { success: false, error: 'Build not found or not running' };
}

/**
 * Get build status
 */
function getBuildStatus(buildId) {
  const build = buildState.buildHistory.find(b => b.id === buildId);
  if (!build) {
    return { success: false, error: 'Build not found' };
  }
  return { success: true, build };
}

/**
 * Get build history
 */
function getBuildHistory(limit = 20) {
  return buildState.buildHistory.slice(0, limit);
}

/**
 * Get deployment history
 */
function getDeployHistory(limit = 20) {
  return buildState.deployHistory.slice(0, limit);
}

/**
 * Create deployment record
 */
function createDeployment(build, target, options = {}) {
  const deployment = {
    id: `deploy-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    buildId: build.id,
    target,
    environment: build.environment,
    status: BuildStatus.PENDING,
    startTime: new Date().toISOString(),
    endTime: null,
    version: build.version,
    commit: build.commit,
    artifacts: build.artifacts || [],
    options
  };

  buildState.deployHistory.unshift(deployment);
  return deployment;
}

/**
 * Deploy to GitHub Release
 */
async function deployToGitHub(projectDir, build, options = {}, onProgress) {
  const deployment = createDeployment(build, 'github', options);
  deployment.status = BuildStatus.RUNNING;

  try {
    // Check if gh CLI is available
    await runCommand('gh --version', projectDir);

    const version = options.version || build.version || 'v0.0.0';
    const title = options.title || `Release ${version}`;
    const notes = options.notes || `Automated release from build ${build.id}`;
    const prerelease = options.prerelease ? '--prerelease' : '';
    const draft = options.draft ? '--draft' : '';

    // Create release
    let cmd = `gh release create ${version} --title "${title}" --notes "${notes}" ${prerelease} ${draft}`;

    // Add artifacts
    if (build.artifacts && build.artifacts.length > 0) {
      const assetPaths = build.artifacts
        .filter(a => a.path && fs.existsSync(a.path))
        .map(a => `"${a.path}"`)
        .join(' ');
      if (assetPaths) {
        cmd += ` ${assetPaths}`;
      }
    }

    const result = await runCommand(cmd, projectDir, (stream, text) => {
      if (onProgress) {
        onProgress({ type: 'deploy_output', text, deployment });
      }
    });

    deployment.status = BuildStatus.SUCCESS;
    deployment.endTime = new Date().toISOString();
    deployment.releaseUrl = result.stdout.trim();

    return { success: true, deployment };

  } catch (err) {
    deployment.status = BuildStatus.FAILED;
    deployment.endTime = new Date().toISOString();
    deployment.error = err.error || err.message;

    return { success: false, error: deployment.error, deployment };
  }
}

/**
 * Get Git info for current directory
 */
async function getGitInfo(projectDir) {
  try {
    const branch = await runCommand('git rev-parse --abbrev-ref HEAD', projectDir);
    const commit = await runCommand('git rev-parse --short HEAD', projectDir);
    const message = await runCommand('git log -1 --pretty=%B', projectDir);
    const author = await runCommand('git log -1 --pretty=%an', projectDir);
    const dirty = await runCommand('git status --porcelain', projectDir);

    return {
      success: true,
      branch: branch.stdout.trim(),
      commit: commit.stdout.trim(),
      message: message.stdout.trim(),
      author: author.stdout.trim(),
      isDirty: dirty.stdout.trim().length > 0
    };
  } catch (err) {
    return { success: false, error: err.message || 'Git info unavailable' };
  }
}

/**
 * Check if environment is ready for deployment
 */
async function checkDeployReadiness(projectDir, environment) {
  const checks = [];

  // Check 1: Git status
  const gitInfo = await getGitInfo(projectDir);
  checks.push({
    name: 'Git Status',
    passed: gitInfo.success && !gitInfo.isDirty,
    message: gitInfo.isDirty ? 'Working directory has uncommitted changes' : 'Clean working directory',
    warning: gitInfo.isDirty
  });

  // Check 2: Dependencies installed
  const nodeModulesExists = fs.existsSync(path.join(projectDir, 'node_modules'));
  checks.push({
    name: 'Dependencies',
    passed: nodeModulesExists,
    message: nodeModulesExists ? 'node_modules present' : 'Run npm install first'
  });

  // Check 3: Package.json exists
  const packageJsonExists = fs.existsSync(path.join(projectDir, 'package.json'));
  checks.push({
    name: 'Package.json',
    passed: packageJsonExists,
    message: packageJsonExists ? 'package.json found' : 'Missing package.json'
  });

  // Check 4: Build scripts exist
  if (packageJsonExists) {
    try {
      const pkgContent = fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8');
      const pkg = JSON.parse(pkgContent);
      const hasBuildScript = pkg.scripts && (pkg.scripts.build || pkg.scripts['build:prod']);
      checks.push({
        name: 'Build Script',
        passed: hasBuildScript,
        message: hasBuildScript ? 'Build script found' : 'No build script in package.json',
        warning: !hasBuildScript
      });
    } catch (err) {
      checks.push({
        name: 'Build Script',
        passed: false,
        message: 'Failed to parse package.json'
      });
    }
  }

  // Check 5: Environment config exists
  const envConfig = buildState.config.environments[environment];
  checks.push({
    name: 'Environment Config',
    passed: !!envConfig,
    message: envConfig ? `${environment} environment configured` : `Unknown environment: ${environment}`
  });

  const allPassed = checks.every(c => c.passed);
  const hasWarnings = checks.some(c => c.warning);

  return {
    ready: allPassed,
    hasWarnings,
    checks,
    gitInfo: gitInfo.success ? gitInfo : null
  };
}

/**
 * Get current state
 */
function getState() {
  return {
    currentBuild: buildState.currentBuild,
    config: buildState.config,
    recentBuilds: buildState.buildHistory.slice(0, 5),
    recentDeploys: buildState.deployHistory.slice(0, 5)
  };
}

module.exports = {
  initialize,
  saveConfig,
  saveHistory,
  createBuild,
  updateBuild,
  runPipeline,
  cancelBuild,
  getBuildStatus,
  getBuildHistory,
  getDeployHistory,
  createDeployment,
  deployToGitHub,
  getGitInfo,
  checkDeployReadiness,
  getState,
  BuildStatus,
  PipelineStage,
  DEFAULT_CONFIG
};
