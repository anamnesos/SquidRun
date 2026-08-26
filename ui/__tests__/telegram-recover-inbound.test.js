/**
 * The recovery tool's refusals ARE the feature. Every test here is a case where
 * the easy version writes a disposition it has no business writing.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queue = require('../modules/telegram-inbound-durable-queue');
const spool = require('../modules/main/telegram-ingress-spool');
const { run, DISPOSITION } = require('../scripts/hm-telegram-recover-inbound');

const tempRoots = [];
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-recover-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  while (tempRoots.length) fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
});

function sink() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

function seed(updateIds = [700100102]) {
  const base = tempRoot();
  let dir = null;
  for (const updateId of updateIds) {
    const res = spool.acceptInbound({
      dataRoot: base,
      routeKey: 'main',
      text: `body ${updateId}`,
      from: 'operator',
      metadata: { updateId, chatId: 6543210, messageId: updateId },
      targetProfile: 'main',
      targetWindow: 'main',
      producerAppGeneration: 'app-session-test',
      producerSessionId: 'sess-test',
    });
    dir = res.dir;
  }
  return dir;
}

/** The unresolvable shape: attempted, with no timestamp. */
function wedge(dir, updateId = 700100102) {
  fs.writeFileSync(
    queue.attemptsPath(dir),
    `${JSON.stringify({ updateId, state: 'attempted' })}\n`,
    'utf8'
  );
}

describe('dry run is the default', () => {
  test('WITHOUT --apply it writes nothing at all', () => {
    const dir = seed();
    wedge(dir);
    const out = sink();

    const res = run(['--dir', dir, '--update-id', '700100102'], out);

    expect(res.dryRun).toBe(true);
    expect(out.text()).toContain('DRY RUN');
    expect(fs.existsSync(queue.dispositionsPath(dir))).toBe(false);
  });

  test('THE DRY RUN SHOWS THE MESSAGE TEXT so a human can confirm what they are retiring', () => {
    const dir = seed();
    wedge(dir);
    const out = sink();

    run(['--dir', dir, '--update-id', '700100102'], out);

    expect(out.text()).toContain('body 700100102');
  });
});

describe('refusals', () => {
  test('A DATED ATTEMPT is refused — the drain can still resolve it', () => {
    const dir = seed();
    fs.writeFileSync(
      queue.attemptsPath(dir),
      `${JSON.stringify({ updateId: 700100102, state: 'attempted', atMs: Date.now() })}\n`,
      'utf8'
    );
    const out = sink();

    const res = run(['--dir', dir, '--update-id', '700100102', '--evidence', 'x', '--apply'], out);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/refusing to shortcut/);
    expect(fs.existsSync(queue.dispositionsPath(dir))).toBe(false);
  });

  test('NO ATTEMPT AT ALL is refused — an undelivered message must be delivered, not retired', () => {
    const dir = seed();
    const out = sink();

    const res = run(['--dir', dir, '--update-id', '700100102', '--evidence', 'x', '--apply'], out);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/never shown to anyone/);
  });

  test('--apply WITHOUT --evidence is refused', () => {
    const dir = seed();
    wedge(dir);
    const out = sink();

    const res = run(['--dir', dir, '--update-id', '700100102', '--apply'], out);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/requires --evidence/);
    expect(fs.existsSync(queue.dispositionsPath(dir))).toBe(false);
  });

  test('A RECORD THAT IS NOT PENDING is refused', () => {
    const dir = seed();
    wedge(dir);
    queue.ack(dir, [700100102]);
    const out = sink();

    const res = run(['--dir', dir, '--update-id', '700100102', '--evidence', 'x', '--apply'], out);

    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not pending/);
  });

  test('AN EXISTING DISPOSITION IS NEVER RESTATED', () => {
    const dir = seed();
    wedge(dir);
    queue.appendDisposition(dir, 700100102, DISPOSITION, 'the original reason');
    const before = fs.readFileSync(queue.dispositionsPath(dir), 'utf8');
    const out = sink();

    const res = run(['--dir', dir, '--update-id', '700100102', '--evidence', 'a different reason', '--apply'], out);

    expect(res.ok).toBe(false);
    expect(fs.readFileSync(queue.dispositionsPath(dir), 'utf8')).toBe(before);
  });

  test('A MISSING OR NONSENSE update-id is refused', () => {
    const dir = seed();
    expect(run(['--dir', dir, '--update-id', '0'], sink()).ok).toBe(false);
    expect(run(['--dir', dir, '--update-id', 'abc'], sink()).ok).toBe(false);
    expect(run(['--dir', dir], sink()).ok).toBe(false);
  });

  test('A MISSING DIRECTORY is refused', () => {
    const res = run(['--dir', path.join(os.tmpdir(), 'definitely-not-here'), '--update-id', '1'], sink());
    expect(res.ok).toBe(false);
  });
});

describe('applying', () => {
  test('IT APPENDS ONE DISPOSITION AND TOUCHES NOTHING ELSE', () => {
    const dir = seed([700100102, 700100103]);
    wedge(dir);
    const journalBefore = fs.readFileSync(queue.journalPath(dir), 'utf8');
    const attemptsBefore = fs.readFileSync(queue.attemptsPath(dir), 'utf8');
    const out = sink();

    const res = run([
      '--dir', dir,
      '--update-id', '700100102',
      '--evidence', 'answered as Telegram 22314 / ledger 78453',
      '--apply',
    ], out);

    expect(res.applied).toBe(true);
    // The two files that must never be rewritten are byte-identical.
    expect(fs.readFileSync(queue.journalPath(dir), 'utf8')).toBe(journalBefore);
    expect(fs.readFileSync(queue.attemptsPath(dir), 'utf8')).toBe(attemptsBefore);
    // Exactly one disposition line, carrying its evidence.
    const lines = fs.readFileSync(queue.dispositionsPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      updateId: 700100102,
      disposition: DISPOSITION,
      evidence: 'answered as Telegram 22314 / ledger 78453',
    });
    // Still pending: retirement is the drain's job, not this tool's.
    expect(queue.readPending(dir).map((r) => r.updateId)).toEqual([700100102, 700100103]);
  });

  test('THE EVIDENCE IS STORED VERBATIM, because it is the whole audit trail', () => {
    const dir = seed();
    wedge(dir);
    run(['--dir', dir, '--update-id', '700100102', '--evidence', 'ledger row 78453', '--apply'], sink());

    expect(queue.readDispositions(dir).get(700100102).evidence).toBe('ledger row 78453');
  });
});
