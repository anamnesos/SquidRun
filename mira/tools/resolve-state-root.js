'use strict';

const path = require('path');

function resolveStateRoot(env = process.env) {
  const rawRoot = env.MIRA_STATE_ROOT;
  if (!rawRoot || !rawRoot.trim()) {
    return {
      ok: false,
      error: 'MIRA_STATE_ROOT is required for live Mira runtime state.',
    };
  }

  const resolved = path.resolve(rawRoot);
  const lower = resolved.toLowerCase();

  if (lower.includes(`${path.sep}.squidrun${path.sep}`) || lower.endsWith(`${path.sep}.squidrun`)) {
    return {
      ok: false,
      error: 'MIRA_STATE_ROOT must not point inside .squidrun.',
    };
  }

  return {
    ok: true,
    path: resolved,
  };
}

module.exports = {
  resolveStateRoot,
};
