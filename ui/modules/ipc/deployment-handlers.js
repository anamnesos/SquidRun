/**
 * Deployment Pipeline IPC Handlers (Task #15)
 *
 * Handles build automation, CI/CD integration, and deployment management.
 */

'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');
const deploymentManager = require('../deployment/deployment-manager');

// Active build processes
const activeBuilds = new Map();

/**
 * Send progress update to renderer
 */
function sendProgress(event, data) {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.webContents.send('deployment-progress', data);
    }
  } catch (err) {
    console.error('[DeploymentHandlers] Failed to send progress:', err.message);
  }
}

/**
 * Register deployment IPC handlers
 */
function registerDeploymentHandlers(ctx = {}) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerDeploymentHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  const projectDir = ctx.projectDir || path.join(process.cwd(), '..');

  // Initialize deployment manager
  deploymentManager.initialize(projectDir);

  // Get deployment configuration
  ipcMain.handle('deployment-get-config', async () => {
    try {
      const state = deploymentManager.getState();
      return { success: true, config: state.config };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Save deployment configuration
  ipcMain.handle('deployment-save-config', async (event, { config }) => {
    try {
      const result = deploymentManager.saveConfig(projectDir, config);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get current state
  ipcMain.handle('deployment-get-state', async () => {
    try {
      const state = deploymentManager.getState();
      return { success: true, ...state };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Check deployment readiness
  ipcMain.handle('deployment-check-readiness', async (event, { environment }) => {
    try {
      const result = await deploymentManager.checkDeployReadiness(projectDir, environment);
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get Git info
  ipcMain.handle('deployment-get-git-info', async () => {
    try {
      const result = await deploymentManager.getGitInfo(projectDir);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Start build pipeline
  ipcMain.handle('deployment-start-build', async (event, { environment, options = {} }) => {
    try {
      // Check if a build is already running
      if (activeBuilds.size > 0) {
        return { success: false, error: 'A build is already running' };
      }

      // Get Git info for the build
      const gitInfo = await deploymentManager.getGitInfo(projectDir);

      const buildOptions = {
        ...options,
        commit: gitInfo.success ? gitInfo.commit : null,
        branch: gitInfo.success ? gitInfo.branch : null,
        triggeredBy: options.triggeredBy || 'manual'
      };

      // Start the pipeline asynchronously
      const buildPromise = deploymentManager.runPipeline(
        projectDir,
        environment,
        buildOptions,
        (progress) => {
          sendProgress(event, progress);
        }
      );

      // Track the build
      const build = deploymentManager.getState().currentBuild;
      if (build) {
        activeBuilds.set(build.id, buildPromise);
      }

      // Don't await - let it run in background
      buildPromise.then((result) => {
        if (build) {
          activeBuilds.delete(build.id);
        }
        sendProgress(event, {
          type: 'build_finished',
          success: result.success,
          build: result.build,
          error: result.error
        });
      }).catch((err) => {
        if (build) {
          activeBuilds.delete(build.id);
        }
        sendProgress(event, {
          type: 'build_error',
          error: err.message
        });
      });

      return { success: true, build };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Cancel build
  ipcMain.handle('deployment-cancel-build', async (event, { buildId }) => {
    try {
      const result = deploymentManager.cancelBuild(buildId);
      if (result.success) {
        activeBuilds.delete(buildId);
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get build status
  ipcMain.handle('deployment-get-build', async (event, { buildId }) => {
    try {
      return deploymentManager.getBuildStatus(buildId);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get build history
  ipcMain.handle('deployment-get-history', async (event, { limit = 20 }) => {
    try {
      const builds = deploymentManager.getBuildHistory(limit);
      const deploys = deploymentManager.getDeployHistory(limit);
      return { success: true, builds, deploys };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Deploy to GitHub
  ipcMain.handle('deployment-deploy-github', async (event, { buildId, options = {} }) => {
    try {
      const buildResult = deploymentManager.getBuildStatus(buildId);
      if (!buildResult.success) {
        return { success: false, error: 'Build not found' };
      }

      if (buildResult.build.status !== 'success') {
        return { success: false, error: 'Cannot deploy failed build' };
      }

      const result = await deploymentManager.deployToGitHub(
        projectDir,
        buildResult.build,
        options,
        (progress) => {
          sendProgress(event, progress);
        }
      );

      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get environment list
  ipcMain.handle('deployment-get-environments', async () => {
    try {
      const state = deploymentManager.getState();
      const environments = Object.entries(state.config.environments).map(([key, env]) => ({
        id: key,
        name: env.name,
        autoDeployBranch: env.autoDeployBranch,
        hasPreDeploy: (env.preDeploy || []).length > 0,
        hasPostDeploy: (env.postDeploy || []).length > 0
      }));
      return { success: true, environments };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Add/update environment
  ipcMain.handle('deployment-set-environment', async (event, { id, environment }) => {
    try {
      const state = deploymentManager.getState();
      const config = { ...state.config };
      config.environments = config.environments || {};
      config.environments[id] = environment;

      const result = deploymentManager.saveConfig(projectDir, config);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Remove environment
  ipcMain.handle('deployment-remove-environment', async (event, { id }) => {
    try {
      if (id === 'production' || id === 'development') {
        return { success: false, error: 'Cannot remove default environments' };
      }

      const state = deploymentManager.getState();
      const config = { ...state.config };
      delete config.environments[id];

      const result = deploymentManager.saveConfig(projectDir, config);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get deployment targets
  ipcMain.handle('deployment-get-targets', async () => {
    try {
      const state = deploymentManager.getState();
      const targets = Object.entries(state.config.targets || {}).map(([key, target]) => ({
        id: key,
        name: target.name,
        ...target
      }));
      return { success: true, targets };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Quick build (development)
  ipcMain.handle('deployment-quick-build', async (event) => {
    try {
      const result = await deploymentManager.runPipeline(
        projectDir,
        'development',
        { install: false, package: false },
        (progress) => {
          sendProgress(event, progress);
        }
      );
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Run specific stage
  ipcMain.handle('deployment-run-stage', async (event, { stage, command }) => {
    try {
      const build = deploymentManager.createBuild('manual', { triggeredBy: 'manual' });
      build.status = 'running';
      build.startTime = new Date().toISOString();

      const stageResult = await deploymentManager.runPipeline(
        projectDir,
        'development',
        {
          install: stage === 'install',
          package: stage === 'package',
          customCommand: command
        },
        (progress) => {
          sendProgress(event, progress);
        }
      );

      return stageResult;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Validate deployment config
  ipcMain.handle('deployment-validate-config', async (event, { config }) => {
    try {
      const errors = [];
      const warnings = [];

      // Check environments
      if (!config.environments || Object.keys(config.environments).length === 0) {
        errors.push('At least one environment must be defined');
      }

      // Check each environment
      Object.entries(config.environments || {}).forEach(([key, env]) => {
        if (!env.name) {
          errors.push(`Environment "${key}" is missing a name`);
        }
        if (env.buildCommand && typeof env.buildCommand !== 'string') {
          errors.push(`Environment "${key}" has invalid buildCommand`);
        }
      });

      // Check targets
      if (config.targets) {
        Object.entries(config.targets).forEach(([key, target]) => {
          if (!target.name) {
            warnings.push(`Target "${key}" is missing a name`);
          }
        });
      }

      return {
        success: true,
        valid: errors.length === 0,
        errors,
        warnings
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get build logs
  ipcMain.handle('deployment-get-logs', async (event, { buildId }) => {
    try {
      const result = deploymentManager.getBuildStatus(buildId);
      if (!result.success) {
        return result;
      }

      return {
        success: true,
        logs: result.build.logs || [],
        stages: result.build.stages || []
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Clear build history
  ipcMain.handle('deployment-clear-history', async () => {
    try {
      deploymentManager.saveHistory(projectDir);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  console.log('[DeploymentHandlers] Registered 18 IPC handlers');
}

module.exports = {
  registerDeploymentHandlers
};
