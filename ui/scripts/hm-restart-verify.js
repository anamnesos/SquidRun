#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { getProjectRoot, resolveCoordPath } = require('../config');
const { appendJsonLine, buildAnomaly, DEFAULT_ANOMALY_PATH } = require('./hm-anomaly');

const DEFAULT_CHECKLIST_PATH = resolveCoordPath('coord/drift-checklist.json');
const DEFAULT_TIMEOUT_MS = 15_000;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    checklistPath: DEFAULT_CHECKLIST_PATH,
    outPath: null,
    sessionId: null,
    json: false,
    send: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) continue;
    if (token === '--json') {
      args.json = true;
      continue;
    }
    if (token === '--no-send') {
      args.send = false;
      continue;
    }
    if (token === '--checklist' && argv[index + 1]) {
      args.checklistPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--out' && argv[index + 1]) {
      args.outPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--session-id' && argv[index + 1]) {
      args.sessionId = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (token === '--timeout-ms' && argv[index + 1]) {
      args.timeoutMs = Number.parseInt(argv[index + 1], 10) || DEFAULT_TIMEOUT_MS;
      index += 1;
    }
  }

  return args;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readSessionId() {
  const status = readJson(resolveCoordPath('app-status.json'), {});
  const session = Number(status?.session);
  return Number.isInteger(session) ? session : null;
}

function defaultOutPath(sessionId) {
  const safeSession = Number.isInteger(sessionId) ? String(sessionId) : String(Date.now());
  return resolveCoordPath(`coord/drift-results-${safeSession}.json`, { forWrite: true });
}

function runVerifyCommand(command, projectRoot, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const stdout = execSync(command, {
      cwd: projectRoot,
      env: { ...process.env, SQUIDRUN_PROJECT_ROOT: projectRoot },
      encoding: 'utf8',
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return {
      ok: true,
      stdout: String(stdout || '').trim(),
      stderr: '',
      exitCode: 0,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || '').trim(),
      stderr: String(error?.stderr || error?.message || '').trim(),
      exitCode: Number.isInteger(error?.status) ? error.status : 1,
    };
  }
}

function compareOutput(stdout, item) {
  const actual = String(stdout || '').trim();
  const expected = String(item.expectedAnswer ?? '').trim();
  const match = String(item.match || 'exact').trim().toLowerCase();

  if (match === 'contains') return actual.includes(expected);
  if (match === 'regex') return new RegExp(expected).test(actual);
  return actual === expected;
}

function truncateForResult(value, maxChars = 4000) {
  const text = String(value || '');
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`, truncated: true };
}

function checkStartupAnomalies(projectRoot, sessionId) {
  const anomalies = [];
  const handoffPath = path.join(projectRoot, '.squidrun', 'handoffs', 'session.md');
  const briefingPath = path.join(projectRoot, '.squidrun', 'handoffs', 'ai-briefing.md');

  if (!fs.existsSync(handoffPath)) {
    anomalies.push({ type: 'missing_session_handoff', severity: 'medium', path: handoffPath });
  } else if (Number.isInteger(sessionId)) {
    const handoff = fs.readFileSync(handoffPath, 'utf8');
    if (!handoff.includes(`app-session-${sessionId}`)) {
      anomalies.push({
        type: 'session_handoff_mismatch',
        severity: 'medium',
        expected: `app-session-${sessionId}`,
        path: handoffPath,
      });
    }
  }

  if (!fs.existsSync(briefingPath)) {
    anomalies.push({ type: 'missing_ai_briefing', severity: 'low', path: briefingPath });
  } else {
    const ageMs = Date.now() - fs.statSync(briefingPath).mtimeMs;
    if (ageMs > 6 * 60 * 60 * 1000) {
      anomalies.push({
        type: 'stale_ai_briefing',
        severity: 'medium',
        ageMinutes: Math.round(ageMs / 60_000),
        path: briefingPath,
      });
    }
  }

  return anomalies;
}

function gradeResults(itemResults) {
  const hardFailed = itemResults.filter((item) => item.severity === 'hard' && item.status !== 'pass');
  const softFailed = itemResults.filter((item) => item.severity !== 'hard' && item.status !== 'pass');
  if (hardFailed.length > 0) return 'hard_fail';
  if (softFailed.length > 0) return 'soft_fail';
  return 'pass';
}

function sendArchitectSignal(projectRoot, resultPath, sessionId, grade) {
  const hmSendPath = path.join(projectRoot, 'ui', 'scripts', 'hm-send.js');
  const relPath = path.relative(projectRoot, resultPath);
  const label = Number.isInteger(sessionId) ? `ARCH ${sessionId}` : 'ARCH';
  const message = `(${label} ONLINE): drift results at ${relPath}; grade=${grade}`;
  try {
    execFileSync(process.execPath, [hmSendPath, 'architect', message, '--role', 'architect', '--timeout', '10000'], {
      cwd: projectRoot,
      env: { ...process.env, SQUIDRUN_PROJECT_ROOT: projectRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const projectRoot = getProjectRoot();
  const checklist = readJson(args.checklistPath);
  if (!checklist || !Array.isArray(checklist.items)) {
    throw new Error(`Invalid drift checklist: ${args.checklistPath}`);
  }

  const sessionId = Number.isInteger(args.sessionId) ? args.sessionId : readSessionId();
  const outPath = args.outPath || defaultOutPath(sessionId);
  const itemResults = checklist.items.map((item) => {
    const commandResult = runVerifyCommand(item.verifyCommand, projectRoot, args.timeoutMs);
    const passed = commandResult.ok && compareOutput(commandResult.stdout, item);
    const actual = truncateForResult(commandResult.stdout);
    return {
      id: item.id,
      severity: item.severity || 'soft',
      status: passed ? 'pass' : 'fail',
      expectedAnswer: item.expectedAnswer ?? '',
      match: item.match || 'exact',
      actualAnswer: actual.text,
      actualAnswerTruncated: actual.truncated,
      verifyCommand: item.verifyCommand,
      exitCode: commandResult.exitCode,
      stderr: commandResult.stderr,
      rationale: item.rationale || '',
    };
  });

  const startupAnomalies = checkStartupAnomalies(projectRoot, sessionId);
  for (const anomaly of startupAnomalies) {
    appendJsonLine(DEFAULT_ANOMALY_PATH, buildAnomaly({
      type: anomaly.type,
      src: 'hm-restart-verify',
      severity: anomaly.severity,
      sessionId,
      details: anomaly,
    }));
  }

  const grade = gradeResults(itemResults);
  const payload = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    projectRoot,
    profile: process.env.SQUIDRUN_PROFILE || 'main',
    sessionId,
    checklistVersion: checklist.checklistVersion || null,
    grade,
    summary: {
      total: itemResults.length,
      passed: itemResults.filter((item) => item.status === 'pass').length,
      failed: itemResults.filter((item) => item.status !== 'pass').length,
      hardFailed: itemResults.filter((item) => item.severity === 'hard' && item.status !== 'pass').length,
      softFailed: itemResults.filter((item) => item.severity !== 'hard' && item.status !== 'pass').length,
    },
    items: itemResults,
    startupAnomalies,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  let signal = null;
  if (args.send) {
    signal = sendArchitectSignal(projectRoot, outPath, sessionId, grade);
    payload.signal = signal;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, outPath, grade, signal }, null, 2)}\n`);
  } else {
    console.log(`Drift verification ${grade}: ${payload.summary.passed}/${payload.summary.total} passed -> ${outPath}`);
  }

  return payload;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('Error:', error?.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  runVerifyCommand,
  compareOutput,
  gradeResults,
  main,
};
