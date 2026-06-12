'use strict';

const fs = require('fs');
const path = require('path');

function resolveRuntimeUiScriptPath(projectRoot, scriptName, options = {}) {
  const fsImpl = options.fs || fs;
  const root = path.resolve(projectRoot || process.cwd());
  const name = String(scriptName || '').replace(/^[\\/]+/, '');
  const candidates = [
    path.join(root, 'ui', 'scripts', name),
    path.join(root, '.squidrun', 'bin', 'runtime', 'ui', 'scripts', name),
  ];
  return candidates.find((candidate) => fsImpl.existsSync(candidate)) || candidates[0];
}

module.exports = {
  resolveRuntimeUiScriptPath,
};
