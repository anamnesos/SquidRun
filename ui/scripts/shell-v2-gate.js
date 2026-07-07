#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const UI_ROOT = path.join(PROJECT_ROOT, 'ui');
const PROFILE = 'shellv2qa';
const HIDDEN_WAIT_MS = 20000;
const SWITCHES = 12;
const ATTACH_TIMEOUT_MS = 60000;
const PANE_TICKS = Object.freeze({
  '2': 'builder',
  '3': 'oracle',
  'trustquote-lead': 'trustquote-lead',
  'trustquote-schedule-dispatch': 'trustquote-schedule-dispatch',
  'trustquote-app': 'trustquote-app',
  'trustquote-invoice': 'trustquote-invoice',
});
const TRUSTQUOTE_ARM_PANE_IDS = Object.freeze(
  Object.keys(PANE_TICKS).filter((paneId) => paneId.startsWith('trustquote-'))
);

function parseArgs(argv) {
  const options = {
    keepOpen: false,
    headed: false,
    cdpPort: 9527,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--keep-open') options.keepOpen = true;
    else if (token === '--headed') options.headed = true;
    else if (token === '--cdp-port') {
      options.cdpPort = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    }
  }
  if (!Number.isInteger(options.cdpPort) || options.cdpPort <= 0) options.cdpPort = 9527;
  return options;
}

function usage() {
  console.log('Usage: node ui/scripts/shell-v2-gate.js [--keep-open] [--cdp-port <port>]');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFileIfPresent(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  } catch {
    return null;
  }
}

function getGitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

function sha256File(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (_) {
    return null;
  }
}

function buffersEqual(left, right) {
  if (left === null && right === null) return true;
  if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right)) return false;
  return left.equals(right);
}

function readPidValue(filePath) {
  const raw = readFileIfPresent(filePath);
  if (!raw) return null;
  const text = raw.toString('utf8').trim();
  if (!text) return null;
  const direct = Number.parseInt(text, 10);
  if (Number.isInteger(direct) && direct > 0) return direct;
  try {
    const parsed = JSON.parse(text);
    const pid = Number.parseInt(parsed?.pid, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

function killPidTree(pid) {
  const normalized = Number.parseInt(pid, 10);
  if (!Number.isInteger(normalized) || normalized <= 0) return false;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(normalized), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return result.status === 0;
  }
  try {
    process.kill(normalized, 'SIGTERM');
    return true;
  } catch (_) {
    return false;
  }
}

async function closeBrowserFast(browser, timeoutMs = 1500) {
  if (!browser) return;
  const close = typeof browser.close === 'function'
    ? browser.close()
    : Promise.resolve();
  await Promise.race([close, sleep(timeoutMs)]).catch(() => {});
}

async function disconnectBrowserFast(browser, timeoutMs = 1000) {
  if (!browser) return;
  if (typeof browser.disconnect === 'function') {
    await Promise.race([Promise.resolve(browser.disconnect()), sleep(timeoutMs)]).catch(() => {});
    return;
  }
  await closeBrowserFast(browser, timeoutMs);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function quoteArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function writeTickHarness(dataRoot) {
  const scriptPath = path.join(dataRoot, 'tick-harness.js');
  fs.writeFileSync(scriptPath, [
    "'use strict';",
    "const label = String(process.argv[2] || process.env.SQUIDRUN_ROLE || 'pane').toLowerCase();",
    'let tick = 0;',
    "console.log(`${label} model tick-harness ready`);",
    "function emit() { tick += 1; console.log(`${label} tick ${tick}`); }",
    'emit();',
    'setInterval(emit, 1000);',
    '',
  ].join('\n'), 'utf8');
  return scriptPath;
}

function buildTickCommand(scriptPath, label) {
  return `& ${quoteArg(process.execPath)} ${quoteArg(scriptPath)} ${quoteArg(label)}`;
}

function writeQaSettings(dataRoot, tickScriptPath) {
  const settingsDir = path.join(dataRoot, '.squidrun', `settings-${PROFILE}`);
  ensureDir(settingsDir);
  const paneCommands = {};
  for (const [paneId, label] of Object.entries(PANE_TICKS)) {
    paneCommands[paneId] = buildTickCommand(tickScriptPath, label);
  }
  paneCommands['1'] = buildTickCommand(tickScriptPath, 'mira');
  const payload = {
    autoSpawn: true,
    autoSync: false,
    notifications: false,
    externalNotificationsEnabled: false,
    notifyOnAlerts: false,
    notifyOnCompletions: false,
    devTools: false,
    shellV2Enabled: true,
    agentNotify: false,
    watcherEnabled: false,
    allowAllPermissions: false,
    autonomyConsentGiven: true,
    autonomyConsentChoice: 'enabled',
    autonomyConsentUpdatedAt: new Date().toISOString(),
    costAlertEnabled: false,
    dryRun: false,
    hiddenPaneHostsEnabled: false,
    operatingMode: 'developer',
    firmwareInjectionEnabled: false,
    localModelEnabled: false,
    paneProjects: { '1': PROJECT_ROOT, '2': PROJECT_ROOT, '3': PROJECT_ROOT },
    paneCommands,
    templates: [],
    voiceInputEnabled: false,
    voiceAutoSend: false,
    userName: 'Shell V2 QA',
    userExperienceLevel: 'advanced',
    userPreferredStyle: 'direct',
    freshPaneSessionOnNextSpawn: {},
  };
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(payload, null, 2), 'utf8');
}

function writeQaProfile(dataRoot) {
  const profile = {
    name: 'Shell V2 QA',
    experience_level: 'expert',
    communication_style: 'terse',
    domain_expertise: 'SquidRun shell verification',
    notes: 'Generated by shell-v2-gate.js for isolated throwaway verification.',
  };
  fs.writeFileSync(path.join(dataRoot, 'user-profile.json'), JSON.stringify(profile, null, 2), 'utf8');
  const onboardingDir = path.join(dataRoot, '.squidrun');
  ensureDir(onboardingDir);
  fs.writeFileSync(path.join(onboardingDir, 'onboarding-state.json'), JSON.stringify({
    onboarding_complete: true,
    completed_at: new Date().toISOString(),
    user_name: profile.name,
    workspace_path: dataRoot,
    configured_features: ['auto-spawn', 'autonomy-consent', 'autonomy-enabled'],
  }, null, 2), 'utf8');
}

function readPlaywright() {
  try {
    return require('playwright-core');
  } catch (_) {
    return require('playwright');
  }
}

function resolveElectronPath() {
  const electronPath = require('electron');
  if (typeof electronPath !== 'string' || !electronPath) {
    throw new Error('electron package did not resolve to an executable path');
  }
  return electronPath;
}

function launchThrowaway({ dataRoot, cdpPort, keepOpen = false }) {
  const env = {
    ...process.env,
    SQUIDRUN_SHELL_V2: '1',
    SQUIDRUN_PROFILE: PROFILE,
    SQUIDRUN_DATA_ROOT: dataRoot,
    SQUIDRUN_CDP_PORT: String(cdpPort),
    SQUIDRUN_SKIP_STARTUP_INJECTION: '1',
    ELECTRON_ENABLE_LOGGING: '1',
  };
  const child = spawn(resolveElectronPath(), [UI_ROOT, '--profile', PROFILE], {
    cwd: PROJECT_ROOT,
    env,
    detached: keepOpen === true,
    stdio: keepOpen === true ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (keepOpen === true) child.unref();
  return child;
}

async function waitForFile(filePath, timeoutMs = ATTACH_TIMEOUT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) return filePath;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function connectToThrowaway(cdpPort) {
  const playwright = readPlaywright();
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < ATTACH_TIMEOUT_MS) {
    try {
      const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 3000 });
      return browser;
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  throw new Error(`Failed to connect over CDP: ${lastError?.message || 'timeout'}`);
}

async function findRendererPage(browser) {
  const started = Date.now();
  while (Date.now() - started < ATTACH_TIMEOUT_MS) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (/index\.html/.test(page.url())) return page;
      }
    }
    await sleep(250);
  }
  throw new Error('No renderer index.html page found over CDP');
}

function makeRecorder() {
  const checks = [];
  return {
    record(id, ok, detail, data = null) {
      const status = ok ? 'PASS' : 'FAIL';
      checks.push({ id, status, ok, detail, data });
      console.log(`${id}: ${status} ${detail}`);
    },
    checks,
  };
}

function contiguous(seq) {
  return Array.isArray(seq) && seq.every((value, index) => index === 0 || value === seq[index - 1] + 1);
}

function hasContiguousRun(entry, minLength = 3) {
  return Array.isArray(entry?.seq)
    && entry.seq.length >= minLength
    && contiguous(entry.seq);
}

async function readTicks(page) {
  return page.evaluate(async (paneTicks) => {
    function bestContiguousRun(values) {
      let best = [];
      let current = [];
      for (const value of values) {
        if (!Number.isFinite(value)) continue;
        if (current.length === 0 || value === current[current.length - 1] + 1) {
          current.push(value);
        } else if (value === current[current.length - 1]) {
          continue;
        } else {
          current = [value];
        }
        const bestLast = best.length ? best[best.length - 1] : -Infinity;
        const currentLast = current[current.length - 1];
        if (current.length > best.length || (current.length === best.length && currentLast > bestLast)) {
          best = current.slice();
        }
      }
      return best.slice(-12);
    }

    let snapshot = null;
    try {
      const snapshotFn = window?.squidrun?.daemon?.terminalSnapshot
        || window?.squidrunAPI?.daemon?.terminalSnapshot;
      if (typeof snapshotFn === 'function') {
        const result = await snapshotFn({ timeoutMs: 1500 });
        if (result?.ok && Array.isArray(result.terminals)) {
          snapshot = result;
        }
      }
    } catch (_) {
      snapshot = null;
    }
    const snapshotByPane = new Map((snapshot?.terminals || []).map((terminal) => [String(terminal.paneId), terminal]));
    const out = {};
    for (const [paneId, label] of Object.entries(paneTicks)) {
      const terminal = document.getElementById(`terminal-${paneId}`);
      const xterm = terminal?.querySelector?.('.xterm') || terminal;
      const snapshotText = snapshotByPane.get(String(paneId))?.scrollback || '';
      const domText = xterm?.innerText || xterm?.textContent || '';
      const text = snapshotText || domText;
      const matches = [...text.matchAll(new RegExp(`${label} tick (\\d+)`, 'g'))].map((match) => Number(match[1]));
      const seq = bestContiguousRun(matches);
      const rect = xterm?.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
      out[paneId] = {
        label,
        source: snapshotText ? 'snapshot' : 'dom',
        last: matches.length ? Math.max(...matches) : null,
        seq,
        rawSeq: matches.slice(-12),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      };
    }
    out.xtermCount = document.querySelectorAll('.xterm').length;
    out.snapshotOk = snapshot?.ok === true;
    return out;
  }, PANE_TICKS);
}

async function waitForInitialTicks(page) {
  await page.waitForFunction(async (paneTicks) => {
    let snapshotByPane = new Map();
    try {
      const snapshotFn = window?.squidrun?.daemon?.terminalSnapshot
        || window?.squidrunAPI?.daemon?.terminalSnapshot;
      if (typeof snapshotFn === 'function') {
        const result = await snapshotFn({ timeoutMs: 1500 });
        if (result?.ok && Array.isArray(result.terminals)) {
          snapshotByPane = new Map(result.terminals.map((terminal) => [String(terminal.paneId), terminal]));
        }
      }
    } catch (_) {
      snapshotByPane = new Map();
    }
    for (const [paneId, label] of Object.entries(paneTicks)) {
      const terminal = document.getElementById(`terminal-${paneId}`);
      const snapshotText = snapshotByPane.get(String(paneId))?.scrollback || '';
      const domText = terminal?.innerText || terminal?.textContent || '';
      const text = snapshotText || domText;
      if (!new RegExp(`${label} tick \\d+`, 'g').test(text)) return false;
    }
    return true;
  }, PANE_TICKS, { timeout: 60000 });
}

async function waitForTickBaseline(page, timeoutMs = 30000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await readTicks(page);
    const ready = Object.keys(PANE_TICKS).every((paneId) => {
      const value = last?.[paneId]?.last;
      return Number.isFinite(value) && value >= 2 && hasContiguousRun(last[paneId], 2);
    });
    if (ready) return last;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for stable tick baseline: ${JSON.stringify(last)}`);
}

async function clickTab(page, tabId) {
  await page.click(`[data-shell-v2-tab="${tabId}"]`);
  await page.waitForFunction((id) => document.body?.dataset?.shellV2ActiveTab === id, tabId, { timeout: 5000 });
}

async function setTrustQuoteArmExpanded(page, expanded) {
  await page.evaluate((targetExpanded) => {
    const section = document.getElementById('shellV2TrustQuoteSection');
    const currentlyExpanded = section?.dataset?.shellV2Expanded === 'true';
    if (section && currentlyExpanded !== targetExpanded) {
      section.querySelector?.('.shell-v2-arm-section-toggle')?.click();
    }
  }, expanded);
  await page.waitForFunction((targetExpanded) => {
    const section = document.getElementById('shellV2TrustQuoteSection');
    const panel = section?.querySelector?.('.shell-v2-arm-panes');
    const sectionStateOk = section?.dataset?.shellV2Expanded === (targetExpanded ? 'true' : 'false');
    const panelStateOk = targetExpanded
      ? panel?.hidden === false && window.getComputedStyle(panel).display !== 'none'
      : panel?.hidden === true && window.getComputedStyle(panel).display === 'none';
    return sectionStateOk && panelStateOk;
  }, expanded, { timeout: 5000 });
}

async function readTrustQuoteArmPaint(page) {
  return page.evaluate((paneIds) => {
    const out = {};
    for (const paneId of paneIds) {
      const terminal = document.getElementById(`terminal-${paneId}`);
      const xterm = terminal?.querySelector?.('.xterm') || terminal;
      const rows = [...(xterm?.querySelectorAll?.('.xterm-rows > div') || [])];
      const rowTexts = rows.map((row) => String(row?.innerText || row?.textContent || ''));
      const paintedRows = rowTexts.filter((text) => /\S/.test(text)).length;
      const rect = xterm?.getBoundingClientRect?.() || { x: 0, y: 0, width: 0, height: 0 };
      const style = xterm ? window.getComputedStyle(xterm) : null;
      out[paneId] = {
        found: Boolean(xterm),
        rowCount: rows.length,
        paintedRows,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        display: style?.display || '',
        visibility: style?.visibility || '',
        sample: rowTexts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160),
      };
    }
    return out;
  }, TRUSTQUOTE_ARM_PANE_IDS);
}

async function waitForTrustQuoteArmPaint(page, timeoutMs = 15000) {
  const started = Date.now();
  let paint = null;
  while (Date.now() - started < timeoutMs) {
    paint = await readTrustQuoteArmPaint(page);
    const ok = TRUSTQUOTE_ARM_PANE_IDS.every((paneId) => {
      const entry = paint?.[paneId];
      return entry?.found === true
        && entry.paintedRows > 0
        && entry.rect?.w > 20
        && entry.rect?.h > 20
        && entry.display !== 'none'
        && entry.visibility !== 'hidden';
    });
    if (ok) return { ok: true, paint };
    await sleep(250);
  }
  return { ok: false, paint };
}

async function readLeadReportLine(page) {
  return page.evaluate(() => {
    const report = document.querySelector('[data-shell-v2-lead-report="trustquote-lead"]')
      || document.getElementById('shellV2TrustQuoteLeadReport');
    const rect = report?.getBoundingClientRect?.() || { width: 0, height: 0 };
    const style = report ? window.getComputedStyle(report) : null;
    return {
      found: Boolean(report),
      id: report?.id || '',
      dataTarget: report?.dataset?.shellV2LeadReport || '',
      text: report?.textContent || '',
      hidden: report?.hidden === true || style?.display === 'none' || style?.visibility === 'hidden',
      placeholder: report?.dataset?.placeholder === 'true' || report?.getAttribute?.('data-placeholder') === 'true',
      rect: {
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    };
  });
}

async function capturePhase2Screenshots(page, runId) {
  const screenshotDir = path.join(PROJECT_ROOT, '.squidrun', 'coord', 'shell-v2-phase2', runId);
  ensureDir(screenshotDir);
  const screenshots = {};
  const capture = async (name) => {
    const filePath = path.join(screenshotDir, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    screenshots[name] = filePath;
  };

  await clickTab(page, 'mira');
  await page.waitForTimeout(250);
  await capture('phase2-mira');

  await clickTab(page, 'squid-room');
  await setTrustQuoteArmExpanded(page, true);
  await page.waitForTimeout(250);
  await capture('phase2-squid-room-expanded');

  await setTrustQuoteArmExpanded(page, false);
  await page.waitForTimeout(250);
  await capture('phase2-squid-room-collapsed');

  await clickTab(page, 'today');
  await page.waitForTimeout(250);
  await capture('phase2-today');

  return screenshots;
}

function buildPhase3TodayRows(nowMs = Date.now()) {
  const day = new Date(nowMs);
  day.setHours(10, 10, 0, 0);
  const base = day.getTime();
  return [
    {
      messageId: 'phase3-today-team',
      sessionId: 'app-session-902',
      senderRole: 'architect',
      targetRole: 'builder',
      channel: 'ws',
      direction: 'outbound',
      sentAtMs: base,
      brokeredAtMs: base + 10,
      rawBody: '[TASK] (Architect): Today populated row from the QA ledger.',
      status: 'routed',
      ackStatus: 'delivered',
      attempt: 1,
      metadata: {},
    },
    {
      messageId: 'phase3-today-james',
      sessionId: 'app-session-902',
      senderRole: 'user',
      targetRole: 'architect',
      channel: 'telegram',
      direction: 'inbound',
      sentAtMs: base - 60000,
      brokeredAtMs: base - 59980,
      rawBody: '[FYI] FULL MSG AT .squidrun/coord/full-agent-messages/phase3-today-james.txt',
      status: 'acked',
      ackStatus: 'telegram_reply_requirement_satisfied',
      attempt: 1,
      metadata: {
        materializedFullPayload: true,
        materializedFullPayloadPath: '.squidrun/coord/full-agent-messages/phase3-today-james.txt',
      },
    },
    {
      messageId: 'phase3-today-system',
      sessionId: 'app-session-901',
      senderRole: 'system',
      targetRole: 'builder',
      channel: 'ws',
      direction: 'outbound',
      sentAtMs: base - 120000,
      brokeredAtMs: base - 119980,
      rawBody: '[SYS] Deliberate failed row for status accent verification.',
      status: 'failed',
      ackStatus: 'n/a',
      errorCode: 'qa_intentional_failed_status',
      attempt: 2,
      metadata: {},
    },
  ];
}

function writePhase3FullMessageFixture(dataRoot) {
  const fullDir = path.join(dataRoot, '.squidrun', 'coord', 'full-agent-messages');
  ensureDir(fullDir);
  const filePath = path.join(fullDir, 'phase3-today-james.txt');
  const body = [
    'SQUIDRUN FULL AGENT MESSAGE',
    `createdAt: ${new Date().toISOString()}`,
    'messageId: phase3-today-james',
    'bytesUtf8: 91',
    '',
    '--- FULL MESSAGE START ---',
    '[FYI] James: this is the materialized QA payload for the Today tab.',
    '--- FULL MESSAGE END ---',
    '',
  ].join('\n');
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

async function seedPhase3TodayRows(page, dataRoot) {
  writePhase3FullMessageFixture(dataRoot);
  const rows = buildPhase3TodayRows();
  return page.evaluate(async (seedRows) => {
    const bridge = window.squidrunAPI || window.squidrun || {};
    const invoke = typeof bridge.invoke === 'function'
      ? bridge.invoke.bind(bridge)
      : (typeof bridge.ipc?.invoke === 'function' ? bridge.ipc.invoke.bind(bridge.ipc) : null);
    if (!invoke) return { ok: false, reason: 'bridge_unavailable' };
    const results = [];
    for (const row of seedRows) {
      results.push(await invoke('evidence-ledger:upsert-comms-journal', row));
    }
    const controller = window.__squidrunShellV2 || document.body?.__squidrunShellV2Controller;
    if (controller && typeof controller.refreshToday === 'function') {
      await controller.refreshToday({ preserveScroll: false });
    }
    return {
      ok: results.every((result) => result?.ok !== false),
      results,
    };
  }, rows);
}

async function readTodayGateState(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.shell-v2-today-row')];
    const chips = [...document.querySelectorAll('.shell-v2-today-chip')].map((chip) => ({
      filter: chip.dataset.todayFilter || '',
      text: chip.textContent || '',
      active: chip.classList.contains('active'),
    }));
    return {
      rowCount: rows.length,
      emptyVisible: Boolean(document.querySelector('.shell-v2-today-empty')),
      expandedCount: document.querySelectorAll('.shell-v2-today-row.is-expanded').length,
      failedAccentCount: document.querySelectorAll('.shell-v2-today-status.is-failed').length,
      fullMeta: document.querySelector('.shell-v2-today-full-meta')?.textContent || '',
      rawExpanded: document.querySelector('.shell-v2-today-raw')?.textContent || '',
      chips,
      activeFilter: chips.find((chip) => chip.active)?.filter || '',
      bodyText: document.body?.innerText || '',
    };
  });
}

async function waitForTodayRowCount(page, count) {
  await page.waitForFunction((expected) => (
    document.querySelectorAll('.shell-v2-today-row').length >= expected
  ), count, { timeout: 10000 });
}

async function capturePhase3TodayScreenshots(page, runId, recorder, dataRoot) {
  const screenshotDir = path.join(PROJECT_ROOT, '.squidrun', 'coord', 'shell-v2-phase3', runId);
  ensureDir(screenshotDir);
  const screenshots = {};
  const capture = async (name) => {
    const filePath = path.join(screenshotDir, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    screenshots[name] = filePath;
  };

  await clickTab(page, 'today');
  await page.waitForSelector('#shellV2TodayRoot', { timeout: 10000 });
  await page.waitForTimeout(300);
  await capture('phase3-today-empty');
  const emptyState = await readTodayGateState(page);
  recorder.record('T1', emptyState.rowCount === 0 && emptyState.emptyVisible === true, 'Today empty state captured', emptyState);

  const seed = await seedPhase3TodayRows(page, dataRoot);
  recorder.record('T2', seed.ok === true, 'seeded real QA comms_journal rows via IPC', seed);
  await waitForTodayRowCount(page, 3);
  await page.waitForTimeout(250);
  await capture('phase3-today-populated');
  const populatedState = await readTodayGateState(page);
  recorder.record(
    'T3',
    populatedState.rowCount >= 3
      && populatedState.failedAccentCount === 1
      && populatedState.chips.some((chip) => chip.filter === 'james' && /James\s+1/.test(chip.text)),
    'Today populated rows/counts/status accent verified',
    populatedState
  );

  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.shell-v2-today-row')]
      .find((candidate) => /James|FULL MSG AT|phase3-today-james/i.test(candidate.innerText || candidate.textContent || ''));
    row?.querySelector?.('.shell-v2-today-summary')?.click();
  });
  await page.waitForSelector('.shell-v2-today-row.is-expanded', { timeout: 5000 });
  await page.evaluate(() => document.querySelector('.shell-v2-today-full-btn')?.click());
  await page.waitForSelector('.shell-v2-today-full-meta', { timeout: 5000 });
  await page.waitForTimeout(250);
  await capture('phase3-today-expanded-row');
  const expandedState = await readTodayGateState(page);
  recorder.record(
    'T4',
    expandedState.expandedCount >= 1
      && /sha\s+[a-f0-9]{12}/i.test(expandedState.fullMeta)
      && /FULL MSG AT/.test(expandedState.rawExpanded),
    'Today expanded row and lazy full-file read verified',
    expandedState
  );

  await page.click('[data-today-filter="james"]');
  await page.waitForFunction(() => (
    document.querySelectorAll('.shell-v2-today-row').length === 1
      && document.querySelector('[data-today-filter="james"]')?.classList.contains('active')
  ), null, { timeout: 5000 });
  await page.waitForTimeout(250);
  await capture('phase3-today-chips-filtered');
  const filteredState = await readTodayGateState(page);
  recorder.record(
    'T5',
    filteredState.rowCount === 1 && filteredState.activeFilter === 'james',
    'Today James chip filter verified',
    filteredState
  );

  return screenshots;
}

function mirrorScreenshots(screenshots = {}) {
  const mirrorDir = path.join(PROJECT_ROOT, '.squidrun', 'screenshots', 'shell-v2');
  ensureDir(mirrorDir);
  const mirrors = {};
  for (const [name, source] of Object.entries(screenshots)) {
    if (!source || !fs.existsSync(source)) continue;
    const mirror = path.join(mirrorDir, `${name}.png`);
    fs.copyFileSync(source, mirror);
    const sourceSha256 = sha256File(source);
    const mirrorSha256 = sha256File(mirror);
    mirrors[name] = {
      source,
      mirror,
      sourceSha256,
      mirrorSha256,
      byteCopy: Boolean(sourceSha256 && sourceSha256 === mirrorSha256),
    };
  }
  return mirrors;
}

async function runAssertions({ page, sharedPortBefore, sharedPortPath, recorder }) {
  const url = new URL(page.url());
  if (url.searchParams.get('profileName') !== PROFILE) {
    throw new Error(`Refusing to probe non-QA renderer: ${page.url()}`);
  }
  await page.waitForSelector('body.shell-v2-enabled', { timeout: 30000 });
  await clickTab(page, 'squid-room');
  await waitForInitialTicks(page);

  const e1 = await page.evaluate(() => {
    const core = document.getElementById('shellV2CoreStrip');
    const stations = [...(core?.querySelectorAll('.side-panes-container > .pane') || [])]
      .filter((pane) => ['2', '3'].includes(String(pane.dataset?.paneId || '')));
    return {
      expandCount: stations.reduce((sum, pane) => sum + pane.querySelectorAll('.pane-action-btn.expand-btn').length, 0),
      visibleControlCounts: stations.map((pane) => {
        const controls = [...pane.querySelectorAll('.pane-header button, .pane-header [role=button], .pane-header summary')];
        return controls.filter((control) => (
          !control.closest?.('.shell-v2-station-menu-panel, .squid-room-pane-menu-panel')
          && Boolean(control.offsetWidth || control.offsetHeight)
        )).length;
      }),
      stationCount: stations.length,
    };
  });
  recorder.record(
    'E1',
    e1.stationCount === 2 && e1.expandCount === 0 && e1.visibleControlCounts.every((count) => count <= 3),
    `expandCount=${e1.expandCount} visibleControls=${e1.visibleControlCounts.join('/')}`,
    e1
  );

  const e2Tabs = [];
  for (const tabId of ['mira', 'squid-room', 'today']) {
    await clickTab(page, tabId);
    e2Tabs.push(await page.evaluate((activeTab) => {
      const bars = [...document.querySelectorAll('.shell-v2-bottom-bar')];
      const bar = bars[0] || null;
      const style = bar ? getComputedStyle(bar) : null;
      const rect = bar?.getBoundingClientRect?.() || { height: 0 };
      return {
        activeTab,
        barCount: bars.length,
        display: style?.display || '',
        height: rect.height,
        staleShortcut: /Ctrl\+1-4 to focus pane/i.test(bar?.textContent || ''),
      };
    }, tabId));
  }
  let keyOwnerOk = true;
  const keyResults = [];
  for (const [key, expectedTab] of [['1', 'mira'], ['2', 'squid-room'], ['3', 'today']]) {
    await page.keyboard.press(`Control+${key}`);
    await page.waitForTimeout(150);
    const result = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        activeTab: document.body?.dataset?.shellV2ActiveTab || '',
        paneFocused: Boolean(active?.closest?.('.pane-terminal, .xterm, .xterm-helper-textarea')),
        activeTag: active?.tagName || '',
        activeId: active?.id || '',
      };
    });
    result.key = key;
    keyResults.push(result);
    if (result.activeTab !== expectedTab || result.paneFocused) keyOwnerOk = false;
  }
  const e2BarsOk = e2Tabs.every((entry) => entry.barCount === 1 && entry.display !== 'none' && entry.height > 0 && !entry.staleShortcut);
  recorder.record('E2', e2BarsOk && keyOwnerOk, `bars=${e2BarsOk} keyOwner=${keyOwnerOk}`, { e2Tabs, keyResults });

  await clickTab(page, 'squid-room');
  await page.evaluate(() => {
    window.__shellV2Gate = { tagged: new WeakSet() };
    document.querySelectorAll('.xterm').forEach((element) => window.__shellV2Gate.tagged.add(element));
  });
  const baseline = await waitForTickBaseline(page);
  const started = Date.now();
  await clickTab(page, 'mira');
  await sleep(HIDDEN_WAIT_MS);
  await clickTab(page, 'squid-room');
  await page.waitForTimeout(600);
  const afterHidden = await readTicks(page);
  const elapsed = (Date.now() - started) / 1000;
  const tickContinuity = Object.keys(PANE_TICKS).every((paneId) => {
    const before = baseline[paneId]?.last;
    const after = afterHidden[paneId]?.last;
    if (!Number.isFinite(before) || !Number.isFinite(after)) return false;
    const delta = after - before;
    return delta >= elapsed - 5 && delta <= elapsed + 5 && hasContiguousRun(afterHidden[paneId]);
  });
  recorder.record('C2', tickContinuity, `hidden=${elapsed.toFixed(1)}s`, { baseline, afterHidden });

  for (let i = 0; i < SWITCHES; i += 1) {
    await clickTab(page, 'mira');
    await page.waitForTimeout(120);
    await clickTab(page, 'squid-room');
    await page.waitForTimeout(200);
  }
  const identity = await page.evaluate(() => {
    const elements = [...document.querySelectorAll('.xterm')];
    return {
      count: elements.length,
      survived: elements.map((element) => window.__shellV2Gate.tagged.has(element)),
    };
  });
  recorder.record(
    'C4',
    identity.count === baseline.xtermCount && identity.survived.every(Boolean),
    `xterms=${identity.count} survived=${identity.survived.filter(Boolean).length}`,
    identity
  );

  const post = await readTicks(page);
  const c1 = Object.keys(PANE_TICKS).every((paneId) => {
    const previous = afterHidden[paneId]?.last;
    const current = post[paneId]?.last;
    return Number.isFinite(previous) && Number.isFinite(current) && current >= previous && hasContiguousRun(post[paneId]);
  });
  recorder.record('C1', c1, 'ticks still advancing after switch churn', post);

  const c3 = ['2', '3'].every((paneId) => post[paneId].rect.w > 100 && post[paneId].rect.h > 60);
  recorder.record('C3', c3, `builder=${JSON.stringify(post['2'].rect)} oracle=${JSON.stringify(post['3'].rect)}`, post);

  const c5 = await page.evaluate(() => {
    const readState = () => {
      const core = document.getElementById('shellV2CoreStrip');
      return {
        bodyOn: document.body.dataset.shellV2CoreExpanded === 'true',
        bodyOff: document.body.dataset.shellV2CoreExpanded === 'false',
        classOn: core?.classList?.contains('shell-v2-core-expanded') === true,
        classOff: core?.classList?.contains('shell-v2-core-expanded') === false,
      };
    };
    const dispatchToggle = (expanded) => {
      let event;
      if (typeof CustomEvent === 'function') {
        event = new CustomEvent('shell-v2-toggle-core-expanded', {
          bubbles: true,
          detail: { expanded },
        });
      } else {
        event = document.createEvent('CustomEvent');
        event.initCustomEvent('shell-v2-toggle-core-expanded', true, false, { expanded });
      }
      document.dispatchEvent(event);
      return readState();
    };
    const controller = window.__squidrunShellV2
      || document.defaultView?.__squidrunShellV2
      || document.body?.__squidrunShellV2Controller;
    if (controller && typeof controller.toggleCoreExpanded === 'function') {
      const on = controller.toggleCoreExpanded(true);
      const onState = readState();
      const off = controller.toggleCoreExpanded(false);
      const offState = readState();
      return {
        ok: on === true && off === false && onState.bodyOn && onState.classOn && offState.bodyOff && offState.classOff,
        method: 'controller',
        on,
        off,
        onState,
        offState,
      };
    }
    const onState = dispatchToggle(true);
    const offState = dispatchToggle(false);
    return {
      ok: onState.bodyOn && onState.classOn && offState.bodyOff && offState.classOff,
      method: 'event',
      onState,
      offState,
    };
  });
  recorder.record('C5', c5.ok === true, c5.ok ? 'container expand toggled' : (c5.reason || 'container expand failed'), c5);

  const e4 = await page.evaluate(() => {
    const builder = document.querySelector('#terminal-2 .xterm') || document.getElementById('terminal-2');
    const oracle = document.querySelector('#terminal-3 .xterm') || document.getElementById('terminal-3');
    const b = builder?.getBoundingClientRect?.() || { y: 0 };
    const o = oracle?.getBoundingClientRect?.() || { y: 9999 };
    return { builderY: Math.round(b.y), oracleY: Math.round(o.y), delta: Math.abs(b.y - o.y) };
  });
  recorder.record('E4', e4.delta < 20, `builder.y=${e4.builderY} oracle.y=${e4.oracleY}`, e4);

  const sharedPortAfter = readFileIfPresent(sharedPortPath);
  recorder.record('E3', buffersEqual(sharedPortBefore, sharedPortAfter), 'shared cdp-port.json byte-compare unchanged', {
    sharedPortPath,
    beforeBytes: sharedPortBefore ? sharedPortBefore.length : 0,
    afterBytes: sharedPortAfter ? sharedPortAfter.length : 0,
  });

  const e5Ok = recorder.checks
    .filter((check) => ['C1', 'C2', 'C3', 'C4', 'C5'].includes(check.id))
    .every((check) => check.ok);
  recorder.record('E5', e5Ok, 'C1-C5 regression criteria');

  await setTrustQuoteArmExpanded(page, false);
  await page.waitForTimeout(250);
  await setTrustQuoteArmExpanded(page, true);
  const armPaint = await waitForTrustQuoteArmPaint(page);
  recorder.record(
    'E6a',
    armPaint.ok === true,
    `paintedRows=${TRUSTQUOTE_ARM_PANE_IDS.map((paneId) => armPaint.paint?.[paneId]?.paintedRows || 0).join('/')}`,
    armPaint.paint
  );

  const leadReport = await readLeadReportLine(page);
  recorder.record(
    'E6b',
    leadReport.found === true
      && leadReport.dataTarget === 'trustquote-lead'
      && leadReport.placeholder !== true,
    `found=${leadReport.found} dataTarget=${leadReport.dataTarget || 'none'} textBytes=${Buffer.byteLength(leadReport.text || '', 'utf8')}`,
    leadReport
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const runId = `shell-v2-gate-${Date.now()}`;
  const dataRoot = path.join(PROJECT_ROOT, '.squidrun', 'tmp', runId);
  ensureDir(dataRoot);
  const gitHead = getGitHead();
  const tickScript = writeTickHarness(dataRoot);
  writeQaSettings(dataRoot, tickScript);
  writeQaProfile(dataRoot);

  const sharedPortPath = path.join(PROJECT_ROOT, '.squidrun', 'runtime', 'cdp-port.json');
  const sharedPortBefore = readFileIfPresent(sharedPortPath);
  const qaPortPath = path.join(dataRoot, '.squidrun', `runtime-${PROFILE}`, 'cdp-port.json');
  const verdictPath = path.join(dataRoot, 'shell-v2-gate-verdict.json');
  const recorder = makeRecorder();

  let child = null;
  let browser = null;
  let screenshots = {};
  let screenshotMirrors = {};
  try {
    child = launchThrowaway({ dataRoot, cdpPort: options.cdpPort, keepOpen: options.keepOpen });
    child.stdout?.on?.('data', (chunk) => process.stdout.write(`[electron] ${chunk}`));
    child.stderr?.on?.('data', (chunk) => process.stderr.write(`[electron] ${chunk}`));
    await waitForFile(qaPortPath);
    browser = await connectToThrowaway(options.cdpPort);
    const page = await findRendererPage(browser);
    await runAssertions({ page, sharedPortBefore, sharedPortPath, recorder });
    screenshots = {
      ...await capturePhase2Screenshots(page, runId),
      ...await capturePhase3TodayScreenshots(page, runId, recorder, dataRoot),
    };
    screenshotMirrors = mirrorScreenshots(screenshots);
    const mirrorOk = Object.keys(screenshots).length > 0
      && Object.keys(screenshots).every((name) => screenshotMirrors[name]?.byteCopy === true);
    if (!mirrorOk) {
      recorder.record('GATE', false, 'screenshot mirror byte-copy failed', { screenshots, screenshotMirrors });
    }
  } catch (err) {
    recorder.record('GATE', false, err?.message || String(err));
  } finally {
    const ok = recorder.checks.length > 0 && recorder.checks.every((check) => check.ok);
    const verdict = {
      ok,
      profile: PROFILE,
      gitHead,
      keepOpen: options.keepOpen === true,
      dataRoot,
      qaPortPath,
      sharedPortPath,
      screenshots,
      screenshotMirrors,
      checks: recorder.checks,
      wroteAt: new Date().toISOString(),
    };
    fs.writeFileSync(verdictPath, JSON.stringify(verdict, null, 2), 'utf8');
    console.log(`VERDICT_JSON ${verdictPath}`);
    if (!options.keepOpen) {
      await closeBrowserFast(browser);
      const daemonPid = readPidValue(path.join(dataRoot, '.squidrun', `runtime-${PROFILE}`, 'daemon.pid'));
      const supervisorPid = readPidValue(path.join(dataRoot, '.squidrun', `runtime-${PROFILE}`, 'supervisor.pid'));
      for (const pid of [child?.pid, daemonPid, supervisorPid]) {
        killPidTree(pid);
      }
      if (child && !child.killed) child.kill();
    } else {
      console.log(`KEEP_OPEN pid=${child?.pid || ''} cdp=http://127.0.0.1:${options.cdpPort}`);
      await disconnectBrowserFast(browser);
    }
    if (!ok) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
