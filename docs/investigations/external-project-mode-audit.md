# Investigation Report: External Project Mode Audit

**Date:** 2026-02-16
**Status:** Completed
**Investigator:** ORACLE

## Executive Summary
Audit of the external project mode and state separation architecture. The investigation reveals that while foundational constants for separation exist, the actual implementation is incomplete, leading to "leaky" state where orchestrator data is scattered across project directories, and firmware suppression is currently non-functional.

## 1. State Separation Audit (`state-separation-audit.md`) Review
*   **Accuracy:** The inventory of files in Section 1 is still 100% accurate.
*   **Path Changes:** `ui/config.js` now defines `GLOBAL_STATE_ROOT` (pointing to `%APPDATA%/hivemind`), but most modules still use `resolveCoordPath()`, which defaults to the project root's `.hivemind/` folder.
*   **Implementation Status:** **PARTIAL / REGRESSED.** 
    *   `resolveGlobalPath()` exists in `config.js` but is rarely used by core managers.
    *   `SettingsManager` and `UsageManager` are still reading/writing to the project-local `.hivemind/` directory instead of the global root.

## 2. Firmware Preflight & Suppression Investigation
*   **Mechanism:** `ui/scripts/hm-preflight.js` correctly identifies conflict patterns (role assignments, sign-ins) in project-local `CLAUDE.md`.
*   **Failure Point:** In `ui/modules/main/firmware-manager.js`, the `ensureStartupFirmwareIfEnabled()` function (called at boot) runs the preflight scan but **passes an empty array `[]`** to `ensureFirmwareFiles()` if no options are provided.
*   **Consequence:** Even if `hm-preflight.js` finds conflicts, the suppression lines are never generated in the actual firmware files (`director.md`, `builder.md`, `oracle.md`).
*   **Stakeholder Concern:** Confirmed. Agents currently receive Hivemind protocols via firmware and Project protocols via `CLAUDE.md`, with no active suppression of the latter.

## 3. `operatingMode` Lifecycle Trace
*   **Switching Logic:** In `settings-handlers.js`, switching `operatingMode` to `project` simply sets `firmwareInjectionEnabled = true`.
*   **Startup Bug (High Impact):** Finding #3 in the previous draft was incorrect. The investigation now confirms that at startup, `project-handlers.js` (line 132) reads the `project` field from `state.json` and calls `syncProjectRoot()` **unconditionally**.
*   **Operating Mode Ignored:** The system does **not** check if `operatingMode` is 'developer' before syncing the project root.
*   **CWD Resolution:** Because `activeProjectRoot` is set at startup from the stale `state.json`, `resolvePaneCwd()` in `config.js` returns the external project path (e.g., [private-project]) even when the user intended to be in Hivemind 'developer' mode. This causes agents to spawn in the wrong directory.

## 4. Decoupling Session Assessment
*   **Evidence:** Context snapshots from Session 120 (Feb 12) show work on "Process Isolation Phase 2" (Evidence Ledger to storage worker).
*   **Progress:** We successfully decoupled the *execution* of the ledger but not its *storage location*. The ledger DB still resides in the project-local `.hivemind/` or `workspace/` folders.
*   **Remaining:** 
    1.  Redirect `UsageManager` and `SettingsManager` to `GLOBAL_STATE_ROOT`.
    2.  Fix `FirmwareManager` to actually inject suppression lines.
    3.  Implement a "State Migration" utility to move orchestrator JSONs out of project roots.

## Proposed Architectural Foundation
1.  **Strict Redirection:** Enforce `resolveGlobalPath()` for all "Orchestrator" classified files.
2.  **Preflight Integration:** Update `firmware-manager.js` to always use cached preflight results when generating role files.
3.  **Mode Hardening:** When `operatingMode` is `project`, explicitly block writes to project-local orchestrator files.
