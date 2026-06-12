function stripElectronRunAsNodeVariants(env) {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') {
      delete env[key];
    }
  }
}

function isElectronRuntime(runtime = process) {
  return Boolean(runtime?.versions?.electron);
}

function buildNodeWorkerForkOptions(baseOptions = {}, runtime = process) {
  const options = { ...baseOptions };
  const env = {
    ...(runtime?.env || process.env),
    ...(baseOptions.env || {}),
  };

  stripElectronRunAsNodeVariants(env);

  if (isElectronRuntime(runtime)) {
    env.ELECTRON_RUN_AS_NODE = '1';
    if (!options.execPath && runtime?.execPath) {
      options.execPath = runtime.execPath;
    }
  }

  options.env = env;
  return options;
}

module.exports = {
  buildNodeWorkerForkOptions,
  isElectronRuntime,
  stripElectronRunAsNodeVariants,
};
