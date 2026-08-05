#!/usr/bin/env node
/**
 * ONE-SHOT RECOVERY for a Telegram inbound record that can never be resolved
 * automatically.
 *
 * THE ONLY CASE THIS IS FOR. A record was delivered and consumed — the user saw
 * it and was answered — but its durable attempt was written before attempts
 * carried timestamps, so no receipt can ever be ordered against it. The drain
 * is correct to hold it forever, and correct to refuse to send it again. Only a
 * human who can point at the answer can break that tie.
 *
 * Update 808499316 is exactly this: answered as Telegram 22314 / ledger 78453.
 * Re-delivering it would duplicate real business work in front of a customer.
 *
 * WHAT IT WILL NOT DO, BY CONSTRUCTION:
 *   - it never delivers, injects, or sends anything, to anyone;
 *   - it never edits the inbound journal, and never deletes a line anywhere;
 *   - it never touches the attempt latch;
 *   - it refuses to write a disposition without stated evidence.
 *
 * It appends ONE line to the terminal-disposition sidecar. The drain overlays
 * that at read time and retires the record without delivery on its next pass.
 * The journal is left byte-for-byte intact, so the record and the reason it was
 * retired both stay auditable forever.
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --apply.
 *
 *   node ui/scripts/hm-telegram-recover-inbound.js --dir <spool-dir> --update-id 808499316
 *   node ui/scripts/hm-telegram-recover-inbound.js --dir <spool-dir> --update-id 808499316 \
 *        --evidence "answered as Telegram 22314 / ledger 78453" --apply
 */
const fs = require('node:fs');
const path = require('node:path');

const queue = require('../modules/telegram-inbound-durable-queue');

const DISPOSITION = 'consumed_verified_out_of_band';

function parseArgs(argv) {
  const args = { apply: false, updateId: null, dir: null, evidence: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--apply') args.apply = true;
    else if (token === '--update-id') args.updateId = Number(argv[++i]);
    else if (token === '--dir') args.dir = argv[++i];
    else if (token === '--evidence') args.evidence = argv[++i];
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

/**
 * A REFUSAL IS A RETURN VALUE, NOT A MUTATION OF THE HOST PROCESS.
 *
 * This used to set `process.exitCode = 1` here. `run` is imported directly by
 * ui/__tests__/telegram-recover-inbound.test.js, so every refusal case - and
 * refusing correctly is most of what this script is FOR - poisoned the exit
 * code of whatever process was running the tests. Jest then printed a fully
 * green summary, 11/11 passing, and exited 1.
 *
 * That is how it broke the pre-commit gate: the gate's per-file loop saw a
 * non-zero status from a suite that had just reported PASS, stopped there, and
 * never ran the remaining staged file - which looked exactly like the LAST file
 * failing silently. A library that edits global process state reaches places it
 * was never meant to, and the damage shows up somewhere unrelated.
 *
 * The exit code now belongs to the CLI entrypoint, which is the only context
 * that has any business setting one.
 */
function fail(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  return { ok: false, reason: message };
}

function run(argv = process.argv.slice(2), out = process.stdout) {
  const args = parseArgs(argv);
  if (args.help) {
    out.write(`${__filename}\n  --dir <spool-dir> --update-id <n> [--evidence "<why>"] [--apply]\n`);
    return { ok: true, help: true };
  }

  if (!Number.isSafeInteger(args.updateId) || args.updateId <= 0) {
    return fail('--update-id must be a positive integer');
  }
  if (!args.dir || !fs.existsSync(args.dir)) {
    return fail(`--dir must be an existing spool directory (got ${args.dir || 'nothing'})`);
  }

  // THE RECORD MUST STILL BE PENDING. Recovering something already retired
  // would write a disposition for a message nobody is waiting on, which is
  // noise in the one journal that has to stay trustworthy.
  let pending;
  try {
    pending = queue.readPending(args.dir);
  } catch (err) {
    return fail(`cannot read the queue: ${err.message}`);
  }
  const record = pending.find((entry) => Number(entry.updateId) === args.updateId);
  if (!record) {
    return fail(`update ${args.updateId} is not pending in ${args.dir}; nothing to recover`);
  }

  // AN EXISTING DISPOSITION IS NEVER OVERWRITTEN. Re-classifying a retirement
  // after the fact is exactly the silent rewrite this sidecar exists to prevent.
  let dispositions;
  try {
    dispositions = queue.readDispositions(args.dir);
  } catch (err) {
    return fail(`cannot read the disposition sidecar: ${err.message}`);
  }
  if (dispositions.has(args.updateId)) {
    return fail(`update ${args.updateId} already has a recorded disposition; refusing to restate it`);
  }

  // THE ATTEMPT MUST BE THE UNRESOLVABLE SHAPE. If the attempt carries a
  // timestamp then the automatic path CAN still resolve it once proof lands,
  // and a human shortcut here would retire something that was never confirmed.
  let attempts;
  try {
    attempts = queue.readAttemptRecords(args.dir);
  } catch (err) {
    return fail(`cannot read the attempt latch: ${err.message}`);
  }
  const attempt = attempts.get(args.updateId);
  if (!attempt) {
    return fail(`update ${args.updateId} has no recorded delivery attempt, so it was never shown to anyone; it must be delivered, not retired`);
  }
  if (attempt.state !== 'attempted') {
    return fail(`update ${args.updateId} is in state '${attempt.state}', which the drain can resolve on its own`);
  }
  if (attempt.atMs !== null) {
    return fail(`update ${args.updateId} has a dated attempt (${new Date(attempt.atMs).toISOString()}), so proof can still resolve it automatically; refusing to shortcut`);
  }

  const preview = {
    dir: path.resolve(args.dir),
    updateId: args.updateId,
    disposition: DISPOSITION,
    text: String(record.text || '').slice(0, 120),
    receivedAtMs: record.receivedAtMs ?? null,
    evidence: args.evidence || null,
  };

  if (!args.apply) {
    out.write('DRY RUN — nothing written.\n');
    out.write(`${JSON.stringify(preview, null, 2)}\n`);
    out.write('\nRe-run with --evidence "<why this was already consumed>" --apply to record it.\n');
    return { ok: true, dryRun: true, preview };
  }

  if (!args.evidence || !String(args.evidence).trim()) {
    return fail('--apply requires --evidence stating how this message was confirmed consumed');
  }

  let result;
  try {
    result = queue.appendDisposition(args.dir, args.updateId, DISPOSITION, String(args.evidence).trim(), Date.now());
  } catch (err) {
    return fail(`disposition write failed: ${err.message}`);
  }

  out.write(`RECORDED ${DISPOSITION} for update ${args.updateId}.\n`);
  out.write('The inbound journal was NOT modified. Nothing was delivered.\n');
  out.write('The next drain pass will retire it without re-injection and release the records behind it.\n');
  return { ok: true, applied: true, result, preview };
}

// THE ENTRYPOINT OWNS THE EXIT CODE, derived from the returned result.
if (require.main === module) {
  const result = run();
  if (!result || result.ok !== true) process.exitCode = 1;
}

module.exports = { run, parseArgs, DISPOSITION };
