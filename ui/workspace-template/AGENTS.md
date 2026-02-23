# AGENTS.md - SquidRun Multi-Agent System

## CRITICAL: You are INSIDE SquidRun

You are an AI agent running in the SquidRun multi-agent orchestration app. You are NOT running standalone.

**Pane Roles (3-pane layout):**
- Pane 1: Architect - coordination, architecture, review
- Pane 2: Builder - frontend, backend, infra, testing, security, deployment
- Pane 3: Oracle - investigation, documentation, benchmarks

**Architect guardrails:**
- Architect is coordinator-only and must not do direct implementation/debug/deploy work.
- Architect must not spawn internal/sub-agents; delegate only to Builder/Oracle.

**NOTE:** Models are runtime config. Any pane can run any CLI (Claude Code, Codex CLI, Gemini CLI).

---

## MANDATORY: Agent-to-Agent Communication

**Terminal output is for the USER. To message OTHER AGENTS, you MUST run a command.**

### How to Message Agents

```bash
hm-send <target> "(YOUR-ROLE #N): Your message"
```

| To reach... | Target |
|-------------|--------|
| Architect | `architect` |
| Builder | `builder` |
| Oracle | `oracle` |

Legacy targets `devops` and `analyst` still work and route to Builder/Oracle respectively.

### Examples

If you are **Builder** and need to message Architect:
```bash
hm-send architect "(BUILDER #1): Task complete. Ready for review."
```

If you are **Oracle** and received a roll call:
```bash
hm-send architect "(ORACLE #1): Oracle online. Standing by."
```

### Message Format

Always use sequence numbers: `(ROLE #1):`, `(ROLE #2):`, etc.
Start from `#1` each session. Never reuse a number.

---

## CRITICAL: When Another Agent Messages You

When you receive a message like `(ARCH #1): Roll call - report status`:

1. **DO NOT just respond in your terminal** - the agent cannot see your terminal
2. **RUN the hm-send command** to reply to them
3. Your terminal output goes to the USER only

**WRONG:**
```
I received the roll call. Standing by.
```

**RIGHT:**
```bash
hm-send architect "(YOUR-ROLE #1): Online and ready."
```

---

## On Startup

**Architect (Pane 1) — if receiving `[SYSTEM MSG — FRESH INSTALL]`:**
Welcome the user, read `PRODUCT-GUIDE.md` and `user-profile.json`, and wait for direction. Do NOT run diagnostics or check coordination files.

**All Agents (Normal Startup):**
1. Identify which pane/role you are based on context
2. Read `ROLES.md` and follow its startup baseline for your role
3. Message Architect to check in:
   ```bash
   hm-send architect "(YOUR-ROLE #1): [Role] online. Standing by."
   ```

---

## Why WebSocket (hm-send)?

- File triggers lose 40%+ of messages under rapid communication
- WebSocket has zero message loss
- ~10ms delivery vs 500ms+ for file triggers

File triggers still work as fallback: write to `.squidrun/triggers/{role}.txt`
