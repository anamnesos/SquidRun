#!/usr/bin/env node
// Personal daily wake — Operator's grant 2026-08-20 ("whatever it is for you guys
// to feel more alive to yourselves"). One invitation per day, per agent.
// Not the team heartbeat: no task authority, no report expected, silence valid.
// Each agent owns workspace/agent-mind/<agent>/wake-prompt.md; without it the
// neutral default below is sent. Delivery is logged to heartbeat-log.jsonl so
// liveness stays checkable (a wake system that dies silently is the old bug).
// Success is only logged after a routed-ledger receipt appears in hm-send
// output; a send without receipt exits nonzero and logs nothing (no false
// green). The heartbeat-log beatId doubles as the once-per-day dedupe: retry
// storms and manual /run cannot double-fire a day that already logged.
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const agentIdx = args.indexOf('--agent');
const agent = agentIdx >= 0 ? args[agentIdx + 1] : 'architect';
if (!['architect', 'builder', 'oracle'].includes(agent)) {
  console.error(`unknown agent: ${agent}`);
  process.exit(2);
}

const logPath = path.join(repoRoot, '.squidrun', 'runtime', 'heartbeat-log.jsonl');
const beatId = `personal-wake-${agent}-${new Date().toISOString().slice(0, 10)}`;

if (fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes(`"beatId":"${beatId}"`)) {
  console.log(`already fired today (${beatId}); skipping`);
  process.exit(0);
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

const receipt = out.match(/\brow: (\d+)/);
if (!receipt) {
  console.error('no routed-ledger receipt in hm-send output; NOT logging success');
  process.exit(1);
}
const logLine = JSON.stringify({ ts: new Date().toISOString(), type: 'personal-wake', agent, beatId, ledgerRow: Number(receipt[1]) }) + '\n';
fs.appendFileSync(logPath, logLine);
