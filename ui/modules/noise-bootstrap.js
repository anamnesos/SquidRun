'use strict';

function installNoiseGuards(env = process.env) {
  env.NODE_NO_WARNINGS = env.NODE_NO_WARNINGS || '1';
  env.DOTENV_CONFIG_QUIET = env.DOTENV_CONFIG_QUIET || 'true';
  const nodeOptions = String(env.NODE_OPTIONS || '').trim();
  if (!nodeOptions.split(/\s+/).includes('--no-warnings')) {
    env.NODE_OPTIONS = `${nodeOptions} --no-warnings`.trim();
  }

  if (process.__squidrunNoiseGuardsInstalled) return;
  process.__squidrunNoiseGuardsInstalled = true;

  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = (warning, ...args) => {
    const warningText = typeof warning === 'string'
      ? warning
      : String(warning?.message || warning || '');
    const warningType = typeof args[0] === 'string'
      ? args[0]
      : String(warning?.name || '');
    if (
      warningType === 'ExperimentalWarning'
      && warningText.includes('SQLite is an experimental feature')
    ) {
      return;
    }
    return originalEmitWarning(warning, ...args);
  };
}

module.exports = {
  installNoiseGuards,
};
