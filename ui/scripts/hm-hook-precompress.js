const fs = require('fs');
const path = require('path');
const { CognitiveMemoryStore } = require('../modules/cognitive-memory-store');
const { extractCandidates } = require('./hm-memory-extract');

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input || '{}');
    const logDir = path.join(process.cwd(), '.squidrun', 'logs');

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/:/g, '-');
    fs.writeFileSync(
      path.join(logDir, `precompress-${timestamp}.json`),
      JSON.stringify(payload, null, 2)
    );

    const candidates = extractCandidates(payload, { proposedBy: 'precompress-hook' });
    const store = new CognitiveMemoryStore();
    const staged = store.stageMemoryPRs(candidates);
    store.close();

    console.log(JSON.stringify({
      status: 'success',
      handled: true,
      candidates: candidates.length,
      staged: staged.staged.length,
      merged: staged.merged.length,
      pendingCount: staged.pendingCount,
    }));
  } catch (error) {
    console.error(`Hook error: ${error.message}`);
    console.log(JSON.stringify({ status: 'error', message: error.message }));
  }
});
