# SquidRun Limitations (Alpha)

This page states current constraints and non-goals for alpha users.

## Alpha Status

SquidRun is in alpha.
Expect rough edges, changing behavior, and incomplete polish.

Use it for exploration and development acceleration, not mission-critical production operations. **You should only use SquidRun on codebases you trust, as the agents can be directed to execute arbitrary commands on your local system.**

## Not Production-Ready Yet

Current non-production areas:

1. **Reliability edge cases in interactive CLI flows**
- Some prompts and submit timing paths can still be brittle under specific runtime/platform combinations.
- Known example: intermittent manual Enter workaround on macOS Claude pane.

2. **Operational UX maturity**
- Troubleshooting and error recovery are improving but still require technical comfort.
- Some diagnostics assume CLI familiarity.

3. **Feature completeness**
- Not every modeled capability is fully shipped end-to-end in every build/runtime snapshot.
- Behavior can differ across platform/runtime combinations.

4. **Documentation completeness**
- Core setup docs now exist, but this is still maturing toward a full operator-grade manual.

## Non-Goals (Current Alpha)

These are not current goals for alpha:

1. **Not a Hosted SaaS**
- We do not offer a cloud-hosted version where we pay for your API tokens. SquidRun's core design relies on bringing your own local CLI subscriptions.

2. **Not a Multi-Human Team Tool**
- SquidRun is strictly designed for **one human** orchestrating multiple AI models. 

3. **Guaranteed unattended operation in all environments**
- Human intervention may still be required for prompts, stalls, or runtime anomalies.

4. **Zero-config cross-device reliability for all edge networks**
- Relay/pairing flows work in standard setups, but edge-case networking (restrictive corporate firewalls, complex VPNs) still needs hardening.

5. **Backward compatibility with old Node runtimes for CLI tooling**
- CLI tools currently expect a modern system Node runtime (`22+`).

6. **Full production observability suite**
- Practical diagnostics exist, but this is not yet an enterprise observability product.

## Experimental / Evolving Areas

Treat the following as evolving behavior:

1. **Cross-device workflows**
- Architect-to-architect routing model is enforced.
- UX and discoverability around bridge diagnostics are still being refined.

2. **Autonomy / permission bypass modes**
- Permission-handling behaviors vary by runtime and settings.
- Some combinations still require careful user understanding.

3. **Startup/input orchestration**
- Prompt-detection and injection timing continue to be tuned for different CLIs.

4. **Runtime state internals in `.squidrun/`**
- Internal file shapes and recovery flows may evolve between releases.

5. **Node.js Quirks**
- Depending on your Node version, you will likely see cosmetic `node:sqlite` experimental warnings in the terminal output. These are harmless and do not impact functionality.

## Disabled / Not Available in Current Runtime Snapshot

1. **SMS transport path is not fully available end-to-end in this workspace runtime snapshot.**
- Do not assume SMS messaging is usable. Use Telegram for remote communication instead.

2. **Unsupported cross-device target patterns should be treated as invalid.**
- Use documented architect endpoint forms only.

## Platform Caveats

1. **macOS**
- GUI-launched app environments can differ from interactive shells (PATH differences).
- This can affect CLI discovery and behavior.

2. **Windows vs macOS parity**
- Some interactive behaviors are not fully identical yet across platforms.

## What This Means for Alpha Users

Use SquidRun when you are comfortable with:
- Reading logs/terminal output
- Running small diagnostic commands
- Applying documented workarounds
- Reporting issues with reproducible steps

If you need strict reliability guarantees or regulated production operations, wait for post-alpha hardening.