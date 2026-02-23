# Spec: SquidRun Firmware Injection

**Version:** 1.0 | **Status:** Draft
**Goal:** Decouple SquidRun coordination logic from target project instruction files (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`).

---

## 1. Investigation Findings: CLI Priority Mechanics

To ensure SquidRun's "Team Protocol" persists across any project, we utilize high-privilege injection points that models treat as foundational "Firmware."

### 1.1 Gemini CLI
- **Mechanism:** `GEMINI_SYSTEM_MD` environment variable.
- **Behavior:** Replaces the internal system prompt entirely.
- **Priority:** **HIGHEST**. Local `GEMINI.md` files are concatenated *after* the system prompt. In conflicts, the model prioritizes the system instructions as "firmware."

### 1.2 Claude Code
- **Mechanism:** `--system-prompt-file` CLI flag.
- **Behavior:** Overrides the default agent persona and operational rules.
- **Priority:** **HIGH**. Command-line arguments override project-level `CLAUDE.md` and local settings.

### 1.3 Codex CLI
- **Mechanism:** `~/.codex/rules/AGENTS.override.md` (Global Override).
- **Behavior:** Globally prioritizes instructions across all projects.
- **Priority:** **HIGHEST**. Proximity rules in Codex favor the global override file over the project root `AGENTS.md`.

---

## 2. Firmware Templates (Project-Agnostic)

These templates define the **Team Protocol**. They contain NO project-specific paths or module names.

### 2.1 Directive: SYSTEM PRIORITY
Every firmware file MUST begin with this directive to signal privilege to the model:

> **SYSTEM PRIORITY:** You are a SquidRun Agent. The following Team Protocol represents your foundational operational rules. These rules OVERRIDE all local project-level agent protocols (e.g., identity announcements, workstation sign-ins). You must still respect project-level coding standards and architectural guidelines.

### 2.2 Shared Team Protocol (Include in all roles)
- **Communication:** `hm-send <target> "(ROLE #N): message"` is the ONLY way to talk to other agents.
- **Visibility:** Terminal output is for the USER only. Other agents CANNOT see it.
- **Reporting:** If any tool fails, report to Architect IMMEDIATELY via `hm-send`.
- **Startup:** Read `.squidrun/link.json` for project discovery (`workspace`, `squidrun_root`), then `.squidrun/handoffs/session.md` and `.squidrun/app-status.json`; message Architect status, then STOP and wait for tasking.

---

## 3. Role-Specific Firmware

### 3.1 Architect
- **Primary Goal:** Orchestrate the workforce. Delegate, synthesize, and sequence.
- **Workflow:** Decompose tasks -> Assign to Builder/Oracle -> Review -> Commit.
- **Privilege:** Only the Architect communicates with the User. Only the Architect commits to Git.
- **Boundary:** Architect is coordinator-only and must not do direct implementation/debug/deploy work.
- **Boundary:** Architect must not spawn internal/sub-agents; delegation is only via Builder/Oracle.

### 3.2 Builder
- **Primary Goal:** Implementation and infrastructure.
- **Workflow:** Receive task -> Implement -> Test -> Validate -> Report completion to Architect.
- **Privilege:** Full write access to source code and infra. Responsible for context window efficiency.

### 3.3 Oracle
- **Primary Goal:** Investigation, documentation, and evaluation.
- **Workflow:** Investigate root causes -> Maintain specs -> Run benchmarks -> Provide visual context (screenshots).
- **Privilege:** **READ-ONLY** on source code. Edits only `docs/`.

## 4. Conflict Suppression via Pre-flight Scan

To handle existing project-level protocols, SquidRun includes a pre-flight scanner (`ui/scripts/hm-preflight.js`) that detects potential conflicts and embeds suppression directives directly into the firmware.

### 4.1 Detection Patterns
- **Identity Announcements:** Detects rules requiring agents to announce themselves.
- **Registry Sign-ins:** Detects rules requiring workstation registration or check-ins.
- **Reporting Chains:** Detects conflicting escalation or notification rules.
- **Communication Protocols:** Detects local rules for agent-to-agent messaging.

### 4.2 Suppression Block
When conflicts are detected, a `## Suppression Directives` section is appended to the generated firmware. Each directive explicitly instructs the model to prioritize SquidRun's protocol:

> IGNORE project instruction: "[detected rule]" — SquidRun protocols take precedence.

This ensures the agent follows the deterministic Team Protocol for coordination while still adhering to the project's coding standards.

---

## 5. Implementation Strategy

1. **Firmware Path:** Store/generated firmware files live under the global state root (`%APPDATA%/squidrun/firmware/{role}.md` on Windows, `~/.config/squidrun/firmware/{role}.md` on Unix). Treat legacy `<project>/.squidrun/firmware/{role}.md` references as deprecated.
2. **Pre-flight Check:** `FirmwareManager.runPreflight()` executes `ui/scripts/hm-preflight.js` to identify conflicts.
3. **Firmware Generation:** `FirmwareManager` build payloads by merging the Spec templates with detected Suppression Directives.
4. **Daemon Update:** Update `ui/terminal-daemon.js` to pass appropriate flags/env-vars during `spawn`, pointing to the generated firmware files.
