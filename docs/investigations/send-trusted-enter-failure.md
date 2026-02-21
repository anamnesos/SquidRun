# Investigation Report: Intermittent `sendTrustedEnter` Failure

**Date:** 2026-02-16
**Status:** Completed
**Investigator:** ORACLE

## Executive Summary
Investigation into SquidRun's #1 bug: intermittent failure of `sendTrustedEnter` after PTY writes. The symptom is text appearing in a pane's input area without the Enter key firing, requiring manual intervention.

The investigation identified a primary race condition in the bypass mechanism used to allow programmatic Enter events through xterm's input lock, combined with potential focus-loss issues during the native event dispatch.

## Core Findings

### 1. `_squidrunBypass` Race Condition (High Certainty)
The system uses a `_squidrunBypass` flag on the terminal instance to allow synthetic Enter events to bypass the input lock in `attachCustomKeyEventHandler` (in `ui/modules/terminal.js`).

*   **Failure Mode:** The flag is cleared too early.
*   **Location A (`ui/modules/terminal/injection.js`):** `sendEnterToPane` clears the flag in a `finally` block or via a 50ms `setTimeout`. If the IPC call to `send-trusted-enter` takes longer than the timeout or if the event processing in the renderer is delayed, the flag is `false` by the time the event arrives.
*   **Location B (`ui/modules/terminal/recovery.js`):** `aggressiveNudge` clears the flag after a fixed **250ms** delay. Under system load, 250ms may be insufficient for the round-trip IPC and event dispatch.

### 2. Focus Sensitivity in `sendInputEvent`
The `send-trusted-enter` handler in `ui/modules/ipc/pty-handlers.js` uses Electron's `webContents.sendInputEvent`.

*   **Failure Mode:** If the `mainWindow` or `webContents` loses focus between the PTY write and the Enter dispatch, the native event may be discarded or routed incorrectly by the OS.
*   **Finding:** While `pty-handlers.js` calls `ctx.mainWindow.focus()`, it does not verify focus state immediately before the `char` and `keyUp` events.

### 3. Verification Logic False Positives
`doSendToPane` in `ui/modules/terminal/injection.js` has verification logic (`verifySubmitAccepted`) that checks for output transitions.

*   **Finding:** In logs, we see `Submit acceptance verified via output_transition_prompt_unavailable`. This means the system *thinks* it succeeded because *any* output happened (possibly a background pulse or echo), even if the Enter didn't actually submit the command.

## Proposed Fixes

1.  **Synchronize Bypass State:** Modify `sendEnterToPane` to only clear `_squidrunBypass` *after* the `sendTrustedEnter` promise resolves, with a slightly longer safety buffer (e.g., 500ms).
2.  **Increase Recovery Delays:** Increase the `aggressiveNudge` bypass window from 250ms to **500ms** or **1000ms**.
3.  **Strengthen Focus Guard:** In `pty-handlers.js`, ensure `webContents.focus()` is called and add a small delay (10ms) before `sendInputEvent` to ensure the OS has registered the focus shift.
4.  **Refine Verification:** Update `isMeaningfulActivity` to better distinguish between "Enter-induced command output" and "CLI idle animations/spinners".

## Evidence
*   **App Log (Line 2271):** `[WARN] [doSendToPane 2] Submit acceptance check failed on attempt 2/2; signal=no_acceptance_signal outputTransition=no promptTransition=no`
*   **Code Trace:** `ui/modules/terminal/injection.js:172` (Early clear in finally) vs `ui/modules/terminal.js:1628` (Bypass check).
