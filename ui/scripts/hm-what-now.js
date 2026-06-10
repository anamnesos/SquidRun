#!/usr/bin/env node
/**
 * hm-what-now: Mission Control "what is happening / what should happen next"
 * from live local evidence, instantly.
 *
 * Read-only by construction: builds the same evidence-bundle answer the Mira
 * local text surface uses (live-what-now-answer module) and prints it. No
 * sends, no WebSocket, no writes - this script must never import hm-send or
 * any ws transport (Oracle gate criterion 4).
 *
 * Usage:
 *   node ui/scripts/hm-what-now.js            human block
 *   node ui/scripts/hm-what-now.js --json     machine JSON (v2 answer shape)
 *   options: --session <app-session-N>, --project-root <path>
 */

'use strict';

const path = require('path');

// Keep stdout clean for --json piping: info-level module banners (e.g. the
// EvidenceLedger driver line) mirror to stdout by default. Must run before
// the answer module loads. (Guarded: test harnesses mock the logger.)
const logger = require('../modules/logger');
if (typeof logger.setLevel === 'function') logger.setLevel('warn');

const {
  buildMiraLiveWhatNowAnswerV0,
} = require('../modules/mira-core/live-what-now-answer-v0');

function parseArgs(argv = []) {
  const options = { json: false, sessionId: null, projectRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (token === '--json') options.json = true;
    else if (token === '--session' && argv[i + 1]) { options.sessionId = String(argv[i + 1]); i += 1; }
    else if (token === '--project-root' && argv[i + 1]) { options.projectRoot = String(argv[i + 1]); i += 1; }
    else if (token === '--help' || token === '-h') options.help = true;
  }
  return options;
}

// The human block is the surface James touches first, so it obeys the same
// visible-text constraints as Mira's surface output: evidence lines only -
// no rule recitation, no padding, no apologies, no spec prose.
function buildHumanBlock(answer = {}) {
  if (!answer.ok) {
    return `what-now unavailable: ${answer.decision || 'unknown'}`;
  }
  return answer.answer_text || '';
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: node hm-what-now.js [--json] [--session <id>] [--project-root <path>]\n');
    process.exit(0);
  }
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..', '..'));
  const answer = buildMiraLiveWhatNowAnswerV0({
    promptText: 'what now?',
    ...(options.sessionId ? { metadata: { sessionId: options.sessionId } } : {}),
  }, {
    projectRoot,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ status: answer.ok ? 'ok' : 'unavailable', ...answer }, null, 2)}\n`);
  } else {
    process.stdout.write(`${buildHumanBlock(answer)}\n`);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildHumanBlock,
  parseArgs,
};
