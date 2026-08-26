const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  makeDrainGeneration,
  resolvePaneRuntimeFromCommand,
  writeBacklogHealth,
} = require('../modules/main/telegram-drain-wiring');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-wiring-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe('drain generation', () => {
  test('IT ADOPTS THE PUBLISHED APP GENERATION, so one process has ONE identity', () => {
    // This used to assert the generation varies by pid and time. That was the
    // defect, not the contract: the drain minted `tg-gen-<pid>-<time>` while
    // pane launches, admission rows and receipts all carried the published
    // `app-session-<n>`. Every generation comparison the proof gate made was
    // therefore between two values that could never be equal - an unanswerable
    // check, which is how the channel stayed silent while every layer reported
    // it was correctly waiting.
    expect(makeDrainGeneration(111, 1000, 'app-session-492')).toBe('app-session-492');
    expect(makeDrainGeneration(999, 9999, 'app-session-492')).toBe('app-session-492');
  });

  test('WITHOUT a published generation it falls back, and says so in the value', () => {
    // Still unique per process and time, and named so a reader can tell the
    // fallback from the real thing rather than seeing a plausible id.
    expect(makeDrainGeneration(111, 1000, '')).toBe('tg-gen-unpublished-111-1000');
    expect(makeDrainGeneration(111, 1000, '')).not.toBe(makeDrainGeneration(112, 1000, ''));
    expect(makeDrainGeneration(111, 1000, '')).not.toBe(makeDrainGeneration(111, 1001, ''));
  });
});

describe('pane runtime naming', () => {
  test.each([
    ['codex --yolo', 'codex'],
    ['C:/tools/gemini.exe', 'gemini'],
    ['claude --dangerously-skip-permissions', 'claude'],
    ['CLAUDE', 'claude'],
  ])('%s -> %s', (command, expected) => {
    expect(resolvePaneRuntimeFromCommand(command)).toBe(expected);
  });

  test.each([
    ['an empty command', ''],
    ['whitespace', '   '],
    ['null', null],
    ['undefined', undefined],
    ['an unrecognised shell', 'bash -l'],
  ])('%s is UNKNOWN, never guessed', (_label, command) => {
    // Returning a plausible-but-wrong runtime here would tell the capability
    // probe to ask about a runtime nobody runs, and every route would wedge.
    expect(resolvePaneRuntimeFromCommand(command)).toBeNull();
  });

  test('CODEX WINS over an incidental claude mention in a path', () => {
    expect(resolvePaneRuntimeFromCommand('C:/sample/claude/bin/codex')).toBe('codex');
  });
});

describe('backlog health publication', () => {
  const backlog = { pendingCount: 3, oldestPendingUpdateId: 700100103 };

  test('IT WRITES A READABLE DOCUMENT for another process', () => {
    const statePath = path.join(tempRoot(), 'nested', 'telegram-backlog-health.json');
    const res = writeBacklogHealth({ statePath, routeKey: 'main', backlog, nowMs: 5 });

    expect(res.ok).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(parsed.schema).toBe('telegramBacklogHealth.v0');
    expect(parsed.routes.main).toMatchObject({ pendingCount: 3, observedAtMs: 5 });
  });

  test('ROUTES DO NOT CLOBBER EACH OTHER', () => {
    const statePath = path.join(tempRoot(), 'health.json');
    writeBacklogHealth({ statePath, routeKey: 'main', backlog, nowMs: 1 });
    writeBacklogHealth({ statePath, routeKey: 'client', backlog: { pendingCount: 0 }, nowMs: 2 });

    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(Object.keys(parsed.routes).sort()).toEqual(['client', 'main']);
    expect(parsed.routes.main.pendingCount).toBe(3);
  });

  test('A CORRUPT EXISTING DOCUMENT does not stop this route reporting', () => {
    const statePath = path.join(tempRoot(), 'health.json');
    fs.writeFileSync(statePath, 'not json', 'utf8');

    const res = writeBacklogHealth({ statePath, routeKey: 'main', backlog, nowMs: 3 });

    expect(res.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).routes.main.pendingCount).toBe(3);
  });

  test('A MISSING BACKLOG is refused rather than written as an empty reading', () => {
    const statePath = path.join(tempRoot(), 'health.json');
    expect(writeBacklogHealth({ statePath, routeKey: 'main', backlog: null, nowMs: 1 }).ok).toBe(false);
    expect(writeBacklogHealth({ statePath, routeKey: '', backlog, nowMs: 1 }).ok).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  test('AN UNWRITABLE PATH reports the failure instead of throwing into the drain', () => {
    const dir = tempRoot();
    const statePath = path.join(dir, 'health.json');
    fs.mkdirSync(statePath); // a directory where the file should be
    const res = writeBacklogHealth({ statePath, routeKey: 'main', backlog, nowMs: 1 });
    expect(res.ok).toBe(false);
    expect(typeof res.reason).toBe('string');
  });
});
