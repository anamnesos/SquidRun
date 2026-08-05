/**
 * S492 — the terminal producer must be INSTALLABLE, or phase 2 is dead code.
 *
 * =====================================================================
 * THE DEFECT THIS CLOSES
 * =====================================================================
 * e726af06 shipped `produceTerminalReceipt` into the adapter that configured
 * hooks really invoke, and it was still unreachable: the adapter runs it only
 * on `Stop`, and this installer could not write a `Stop` hook for any runtime.
 * Live `Stop` runs the outbound routing guard, which never touches the adapter.
 *
 * That is the fourth appearance of one shape in this lane — a component
 * hardened over checkpoints while nothing configured could reach it — and it is
 * the most dangerous instance yet, because activating the delivery sequence on
 * top of it would turn every new delivery into a permanent hold. The S491 wedge,
 * rebuilt on purpose.
 *
 * Claude's `SessionStart` was missing for the same invisible reason: A3's
 * reachability assertion was a set membership that Codex satisfied alone, so
 * Claude's absence could never fail it.
 *
 * SCOPE OF THIS SUITE, STATED HONESTLY: it proves the installer WRITES the
 * right configuration into a throwaway project root and does not disturb what
 * is already there. It does NOT prove a live Codex `Stop` payload carries a
 * usable turn id — that requires characterizing a real Stop event from a real
 * runtime, which is an activation-time proof against a live pane, and it is
 * listed as an activation prerequisite rather than simulated with a fixture.
 * No live config is read or written by this file.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installModelPromptReceiptHooks } = require('../modules/model-prompt-receipt');

const tempRoots = [];

afterAll(() => {
  for (const root of tempRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stop-install-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'ui', 'scripts'), { recursive: true });
  return root;
}

function readConfig(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

/** Every command string configured for one event, flattened. */
function commandsFor(config, eventName) {
  const entries = config?.hooks?.[eventName];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => (
    Array.isArray(entry?.hooks) ? entry.hooks.map((hook) => String(hook?.command || '')) : []
  ));
}

function adapterCommands(config, eventName) {
  return commandsFor(config, eventName)
    .filter((command) => command.includes('model-prompt-receipt-adapter.js'));
}

describe('Stop hook installation — making phase 2 reachable', () => {
  test('codex gets exactly one Stop command that invokes the adapter with --event Stop', () => {
    const root = makeProjectRoot();
    const result = installModelPromptReceiptHooks({ projectRoot: root });
    expect(result).toBeTruthy();

    const config = readConfig(root, path.join('.codex', 'hooks.json'));
    const stop = adapterCommands(config, 'Stop');
    expect(stop).toHaveLength(1);
    expect(stop[0]).toContain('--runtime codex');
    expect(stop[0]).toContain('--event Stop');
    // The adapter branches on this exact event name; a mismatch would install a
    // hook that runs and does nothing, which is the silent-skip class.
    expect(stop[0]).not.toContain('--trust-check-only');
  });

  test('claude gets SessionStart, UserPromptSubmit and Stop — asserted SEPARATELY', () => {
    const root = makeProjectRoot();
    installModelPromptReceiptHooks({ projectRoot: root });
    const config = readConfig(root, path.join('.claude', 'settings.json'));

    // No shared `length > 0`, no set membership: Codex satisfying a combined
    // assertion on Claude's behalf is the exact bug that hid this for a
    // checkpoint.
    const sessionStart = adapterCommands(config, 'SessionStart');
    expect(sessionStart).toHaveLength(1);
    expect(sessionStart[0]).toContain('--runtime claude');
    expect(sessionStart[0]).toContain('--trust-check-only');

    const submit = adapterCommands(config, 'UserPromptSubmit');
    expect(submit).toHaveLength(1);
    expect(submit[0]).toContain('--runtime claude');

    const stop = adapterCommands(config, 'Stop');
    expect(stop).toHaveLength(1);
    expect(stop[0]).toContain('--runtime claude');
    expect(stop[0]).toContain('--event Stop');
  });

  test('an existing unrelated Stop hook SURVIVES installation', () => {
    const root = makeProjectRoot();
    const codexDir = path.join(root, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    // The live shape: Stop already carries the outbound routing guard. An
    // installer that owned the event instead of joining it would silently
    // disarm a guard that exists to stop misrouted replies to James.
    const guard = "node 'D:/projects/squidrun/ui/scripts/stop-telegram-routing-guard.js'";
    fs.writeFileSync(path.join(codexDir, 'hooks.json'), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: guard }] }] },
    }, null, 2));

    installModelPromptReceiptHooks({ projectRoot: root });

    const config = readConfig(root, path.join('.codex', 'hooks.json'));
    const all = commandsFor(config, 'Stop');
    expect(all).toContain(guard);
    expect(adapterCommands(config, 'Stop')).toHaveLength(1);
    expect(all).toHaveLength(2);
  });

  test('installing twice does not duplicate the Stop command', () => {
    const root = makeProjectRoot();
    installModelPromptReceiptHooks({ projectRoot: root });
    installModelPromptReceiptHooks({ projectRoot: root });

    const codex = readConfig(root, path.join('.codex', 'hooks.json'));
    const claude = readConfig(root, path.join('.claude', 'settings.json'));
    // A hook that fires twice per turn would produce two terminal writes for
    // one turn. The store would refuse the second as a byte-identical replay,
    // but relying on that is relying on a downstream guard to cover an
    // installer defect.
    expect(adapterCommands(codex, 'Stop')).toHaveLength(1);
    expect(adapterCommands(claude, 'Stop')).toHaveLength(1);
    expect(adapterCommands(claude, 'SessionStart')).toHaveLength(1);
  });

  test('every installed adapter command names a runtime AND an event', () => {
    const root = makeProjectRoot();
    installModelPromptReceiptHooks({ projectRoot: root });

    const configs = [
      readConfig(root, path.join('.codex', 'hooks.json')),
      readConfig(root, path.join('.claude', 'settings.json')),
    ];
    const seen = [];
    for (const config of configs) {
      for (const eventName of Object.keys(config.hooks || {})) {
        for (const command of adapterCommands(config, eventName)) {
          seen.push(command);
          // `normalizeRuntime(args.runtime)` returning null makes the producer
          // skip with `runtime_unsupported`, silently, for every prompt.
          expect(command).toMatch(/--runtime (codex|claude)\b/);
          expect(command).toMatch(/--event \w+/);
        }
      }
    }
    // Codex: SessionStart, UserPromptSubmit, Stop. Claude: the same three.
    expect(seen).toHaveLength(6);
  });
});
