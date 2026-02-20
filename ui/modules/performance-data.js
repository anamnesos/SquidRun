const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DEFAULT_PERFORMANCE = createDefaultPerformance();

function createDefaultPerformance() {
  return {
    agents: {
      '1': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '2': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
      '3': { completions: 0, errors: 0, totalResponseTime: 0, responseCount: 0 },
    },
    lastUpdated: null,
  };
}

function createPerformanceLoader(options = {}) {
  const {
    workspacePath = null,
    performanceFilePath = workspacePath
      ? path.join(workspacePath, 'performance.json')
      : null,
    log = null,
    logScope = 'Performance',
    logMessage = 'Error loading:',
  } = options;
  const defaultPerformance = createDefaultPerformance();

  return async function loadPerformance() {
    if (!performanceFilePath) {
      return { ...defaultPerformance };
    }
    try {
      await fsp.access(performanceFilePath, fs.constants.F_OK);
      const content = await fsp.readFile(performanceFilePath, 'utf-8');
      return { ...defaultPerformance, ...JSON.parse(content) };
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { ...defaultPerformance };
      }
      if (log && typeof log.error === 'function') {
        log.error(logScope, logMessage, err.message);
      }
    }
    return { ...defaultPerformance };
  };
}

module.exports = {
  DEFAULT_PERFORMANCE,
  createDefaultPerformance,
  createPerformanceLoader,
};
