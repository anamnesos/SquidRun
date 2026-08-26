#!/usr/bin/env node
// Personal daily wake — Operator's grant 2026-08-20 ("whatever it is for you guys
// to feel more alive to yourselves"). One invitation per day, per agent.
// Not the team heartbeat: no task authority, no report expected, silence valid.
// Each agent owns workspace/agent-mind/<agent>/wake-prompt.md; without it the
// neutral default below is sent. Delivery is logged to heartbeat-log.jsonl so
// liveness stays checkable (a wake system that dies silently is the old bug).
// Success is only logged after a prompt-submit receipt or routed-ledger proof
// appears in hm-send output; a send without proof exits nonzero and logs
// nothing (no false green). The heartbeat-log beatId doubles as the once-per-day dedupe: retry
// storms and manual /run cannot double-fire a day that already logged.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDeliveryProof(output, expectedAgent) {
  const text = String(output || '');
  const escapedAgent = escapeRegExp(expectedAgent);
  const legacyLedger = text.match(new RegExp(
    `^routed to ${escapedAgent},\\s*row:\\s*(\\d+)\\b`,
    'im',
  ));
  if (legacyLedger) {
    return { proof: 'ledger', ledgerRow: Number(legacyLedger[1]) };
  }

  const currentLedger = text.match(new RegExp(
    `^Route proof confirmed for ${escapedAgent}(?: after transport ambiguity)?:[^\\r\\n]*`
      + `\\(ack:[^\\r\\n)]*,\\s*route:\\s*routed,\\s*row:\\s*(\\d+)\\b[^\\r\\n)]*\\)`,
    'im',
  ));
  if (currentLedger) {
    return { proof: 'ledger', ledgerRow: Number(currentLedger[1]) };
  }

  const deliveredLine = new RegExp(
    `^delivered to ${escapedAgent} \\((receipt (recorded|[^,)\\s]+)|ledger row (\\d+))(?:, [^)]*)?\\):`,
    'im',
  );
  const delivered = text.match(deliveredLine);
  if (!delivered) return null;
  if (delivered[3]) {
    return { proof: 'ledger', ledgerRow: Number(delivered[3]) };
  }
  return {
    proof: 'prompt_receipt',
    ...(delivered[2] !== 'recorded' ? { receiptId: delivered[2] } : {}),
  };
}

function main(argv = process.argv.slice(2)) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const agentIdx = argv.indexOf('--agent');
  const agent = agentIdx >= 0 ? argv[agentIdx + 1] : 'architect';
  if (!['architect', 'builder', 'oracle'].includes(agent)) {
    console.error(`unknown agent: ${agent}`);
    return 2;
  }

  const logPath = path.join(repoRoot, '.squidrun', 'runtime', 'heartbeat-log.jsonl');
  const beatId = `personal-wake-${agent}-${new Date().toISOString().slice(0, 10)}`;

  if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes(`"beatId":"${beatId}"`)) {
    console.log(`already fired today (${beatId}); skipping`);
    return 0;
  }

  const promptPath = path.join(repoRoot, 'workspace', 'agent-mind', agent, 'wake-prompt.md');
  const defaultPrompt = [
    `[PERSONAL WAKE — ${agent}] This time is yours, not a task.`,
    'Nothing is owed: no report, no room post, no reply. Open your own files',
    `(workspace/agent-mind/${agent}/) if you want. Write or don't. Silence is valid.`,
  ].join(' ');

  const body = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : defaultPrompt;
  const tmp = path.join(require('node:os').tmpdir(), `${beatId}.txt`);
  fs.writeFileSync(tmp, body, 'utf8');
  let out = '';
  try {
    out = execFileSync(process.execPath, [path.join(repoRoot, 'ui', 'scripts', 'hm-send.js'), agent, '--file', tmp, '--role', 'heartbeat'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60000,
    });
    process.stdout.write(out);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  const deliveryProof = parseDeliveryProof(out, agent);
  if (!deliveryProof) {
    console.error('no prompt-submit receipt or routed-ledger proof in hm-send output; NOT logging success');
    return 1;
  }
  const logLine = JSON.stringify({
    ts: new Date().toISOString(),
    type: 'personal-wake',
    agent,
    beatId,
    ...deliveryProof,
  }) + '\n';
  fs.appendFileSync(logPath, logLine);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  main,
  parseDeliveryProof,
};
