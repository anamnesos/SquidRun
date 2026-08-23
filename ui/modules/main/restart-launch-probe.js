'use strict';

const fs = require('fs');
const path = require('path');

const RESTART_LAUNCH_PROBE_ENV = 'SQUIDRUN_RESTART_LAUNCH_PROBE';
const RESTART_LAUNCH_PROBE_RESULT_ENV = 'SQUIDRUN_RESTART_LAUNCH_PROBE_RESULT';
const RESTART_LAUNCH_PROBE_SCHEMA = 'squidrun.restart_launch_probe.v1';

const RENDERER_SNAPSHOT_SCRIPT = `(() => {
  const bridge = window.squidrun;
  const terminalIds = ['terminal-1', 'terminal-2', 'terminal-3'];
  return {
    readyState: document.readyState,
    title: document.title,
    hasBody: Boolean(document.body),
    terminalCount: terminalIds.filter((id) => Boolean(document.getElementById(id))).length,
    preloadBridgeReady: Boolean(bridge && typeof bridge === 'object'),
    rendererModulesReady: Boolean(bridge && bridge.rendererModules),
    rendererModulesLoadError: bridge?.rendererModulesLoadError?.message || null,
    rendererScriptReady: document.documentElement?.dataset?.squidrunRendererScriptReady === 'true',
  };
})()`;

function isEnabledValue(value) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value || '').trim().toLowerCase());
}

function isRestartLaunchProbe(env = process.env) {
  return isEnabledValue(env?.[RESTART_LAUNCH_PROBE_ENV]);
}

function pathIsInside(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveRestartLaunchProbeResultPath(env = process.env) {
  if (!isRestartLaunchProbe(env)) {
    throw new Error('restart_launch_probe_not_enabled');
  }
  const dataRoot = String(env?.SQUIDRUN_DATA_ROOT || '').trim();
  const resultPath = String(env?.[RESTART_LAUNCH_PROBE_RESULT_ENV] || '').trim();
  if (!dataRoot) throw new Error('restart_launch_probe_data_root_missing');
  if (!resultPath || !path.isAbsolute(resultPath)) {
    throw new Error('restart_launch_probe_result_path_missing_or_relative');
  }
  const allowedRoot = path.join(path.resolve(dataRoot), '.squidrun', 'runtime');
  const resolvedResultPath = path.resolve(resultPath);
  if (!pathIsInside(allowedRoot, resolvedResultPath)) {
    throw new Error('restart_launch_probe_result_path_outside_isolated_root');
  }
  return resolvedResultPath;
}

function writeRestartLaunchProbeResult(payload = {}, options = {}) {
  const fsRef = options.fs || fs;
  const env = options.env || process.env;
  const resultPath = resolveRestartLaunchProbeResultPath(env);
  const result = {
    ...payload,
    schema: RESTART_LAUNCH_PROBE_SCHEMA,
    timestamp: new Date(options.nowMs || Date.now()).toISOString(),
    pid: process.pid,
    profile: String(env.SQUIDRUN_PROFILE || ''),
    dataRoot: path.resolve(env.SQUIDRUN_DATA_ROOT),
  };
  fsRef.mkdirSync(path.dirname(resultPath), { recursive: true });
  const tempPath = `${resultPath}.${process.pid}.tmp`;
  fsRef.writeFileSync(tempPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fsRef.renameSync(tempPath, resultPath);
  return result;
}

function validateRestartLaunchProbeRenderer(snapshot = {}) {
  const failures = [];
  if (snapshot.readyState !== 'complete') failures.push('document_not_complete');
  if (snapshot.title !== 'SquidRun') failures.push('unexpected_document_title');
  if (snapshot.hasBody !== true) failures.push('document_body_missing');
  if (snapshot.terminalCount !== 3) failures.push('terminal_shell_incomplete');
  if (snapshot.preloadBridgeReady !== true) failures.push('preload_bridge_missing');
  if (snapshot.rendererModulesReady !== true) failures.push('renderer_modules_missing');
  if (snapshot.rendererModulesLoadError) failures.push('renderer_modules_load_error');
  if (snapshot.rendererScriptReady !== true) failures.push('renderer_script_marker_missing');
  return {
    ok: failures.length === 0,
    reason: failures[0] || null,
    failures,
  };
}

function makeProbeError(reason, details = {}) {
  const error = new Error(reason);
  error.code = reason;
  error.details = details;
  return error;
}

async function inspectRestartLaunchProbeWindow(windowRef, loadPromise) {
  if (!windowRef || !windowRef.webContents) {
    throw makeProbeError('restart_launch_probe_window_missing');
  }
  const webContents = windowRef.webContents;
  let rejectFatal;
  const fatalPromise = new Promise((_resolve, reject) => {
    rejectFatal = reject;
  });
  const listeners = [];
  const listenOnce = (target, eventName, handler) => {
    if (!target || typeof target.once !== 'function') return;
    target.once(eventName, handler);
    listeners.push({ target, eventName, handler });
  };
  listenOnce(webContents, 'preload-error', (_event, preloadPath, error) => {
    rejectFatal(makeProbeError('restart_launch_probe_preload_error', {
      preloadPath: preloadPath || null,
      error: error?.message || String(error || 'unknown_preload_error'),
    }));
  });
  listenOnce(webContents, 'render-process-gone', (_event, details = {}) => {
    rejectFatal(makeProbeError('restart_launch_probe_renderer_gone', {
      reason: details.reason || null,
      exitCode: details.exitCode ?? null,
    }));
  });
  listenOnce(windowRef, 'closed', () => {
    rejectFatal(makeProbeError('restart_launch_probe_window_closed'));
  });

  try {
    return await Promise.race([
      (async () => {
        await loadPromise;
        if (typeof webContents.executeJavaScript !== 'function') {
          throw makeProbeError('restart_launch_probe_execute_javascript_missing');
        }
        const snapshot = await webContents.executeJavaScript(RENDERER_SNAPSHOT_SCRIPT, true);
        const validation = validateRestartLaunchProbeRenderer(snapshot);
        if (!validation.ok) {
          throw makeProbeError('restart_launch_probe_renderer_invalid', {
            validation,
            snapshot,
          });
        }
        return {
          ok: true,
          stage: 'renderer_ready',
          snapshot,
          visible: typeof windowRef.isVisible === 'function' ? windowRef.isVisible() : null,
          focused: typeof windowRef.isFocused === 'function' ? windowRef.isFocused() : null,
          processIds: [...new Set([
            process.pid,
            ...(
              typeof require('electron').app?.getAppMetrics === 'function'
                ? require('electron').app.getAppMetrics().map((entry) => Number(entry?.pid)).filter(Number.isInteger)
                : []
            ),
          ])],
        };
      })(),
      fatalPromise,
    ]);
  } finally {
    for (const { target, eventName, handler } of listeners) {
      if (typeof target.removeListener === 'function') target.removeListener(eventName, handler);
    }
  }
}

module.exports = {
  RESTART_LAUNCH_PROBE_ENV,
  RESTART_LAUNCH_PROBE_RESULT_ENV,
  RESTART_LAUNCH_PROBE_SCHEMA,
  RENDERER_SNAPSHOT_SCRIPT,
  isRestartLaunchProbe,
  pathIsInside,
  resolveRestartLaunchProbeResultPath,
  writeRestartLaunchProbeResult,
  validateRestartLaunchProbeRenderer,
  inspectRestartLaunchProbeWindow,
};
