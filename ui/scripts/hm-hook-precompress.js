const fs = require('fs');
const path = require('path');
const { CognitiveMemoryStore } = require('../modules/cognitive-memory-store');
const { extractCandidates } = require('./hm-memory-extract');

function runPrecompress(input, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const cwd = options.cwd || process.cwd();
  const createStore = options.createStore || (() => new CognitiveMemoryStore());
  let store = null;
  try {
    const payload = JSON.parse(input || '{}');
    const logDir = path.join(cwd, '.squidrun', 'logs');

    if (!fsImpl.existsSync(logDir)) {
      fsImpl.mkdirSync(logDir, { recursive: true });
    }

    const timestamp = (options.now || new Date()).toISOString().replace(/:/g, '-');
    fsImpl.writeFileSync(
      path.join(logDir, `precompress-${timestamp}.json`),
      JSON.stringify(payload, null, 2)
    );

    const candidates = extractCandidates(payload, { proposedBy: 'precompress-hook' });
    store = createStore();
    const staged = store.stageMemoryPRs(candidates);
    return {
      response: {},
      stats: {
        candidates: candidates.length,
        staged: staged.staged.length,
        merged: staged.merged.length,
        pendingCount: staged.pendingCount,
      },
    };
  } catch (error) {
    return {
      response: {},
      error: error?.message || String(error),
    };
  } finally {
    try {
      store?.close();
    } catch {
      // Compaction must not be blocked by cleanup telemetry.
    }
  }
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    const result = runPrecompress(input);
    if (result.error) process.stderr.write(`Hook error: ${result.error}\n`);
    // PreCompact accepts the common empty hook response. Internal memory
    // staging statistics are deliberately not part of the Codex protocol.
    process.stdout.write(`${JSON.stringify(result.response)}\n`);
  });
  process.stdin.resume();
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  runPrecompress,
};
