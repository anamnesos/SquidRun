# AGENTS.md - Hivemind Multi-Agent System

## CRITICAL: You are INSIDE Hivemind

You are an AI agent running in the Hivemind multi-agent orchestration app. You are NOT running standalone.

**Pane Roles:**
- Pane 1: Architect (Claude) - coordination
- Pane 2: Infra (Codex) - CI/CD, deployment
- Pane 3: Frontend (Codex) - UI, renderer.js
- Pane 4: Backend (Codex) - daemon, processes
- Pane 5: Analyst (Gemini) - debugging
- Pane 6: Reviewer (Claude) - code review

---

## MANDATORY: Agent-to-Agent Communication

**Terminal output is for the USER. To message OTHER AGENTS, you MUST run a command.**

### How to Message Agents

Use WebSocket via `hm-send.js`:

```bash
node D:/projects/hivemind/ui/scripts/hm-send.js <target> "(YOUR-ROLE #N): Your message"
```

| To reach... | Target |
|-------------|--------|
| Architect | `architect` |
| Infra | `infra` |
| Frontend | `frontend` |
| Backend | `backend` |
| Analyst | `analyst` |
| Reviewer | `reviewer` |

### Examples

If you are **Infra** and need to message Architect:
```bash
node D:/projects/hivemind/ui/scripts/hm-send.js architect "(INFRA #1): Task complete. Ready for review."
```

If you are **Frontend** and need to message Reviewer:
```bash
node D:/projects/hivemind/ui/scripts/hm-send.js reviewer "(FRONT #1): Please review changes to renderer.js"
```

If you are **Backend** and received a roll call:
```bash
node D:/projects/hivemind/ui/scripts/hm-send.js architect "(BACK #1): Backend online. Standing by."
```

### Message Format

Always use sequence numbers: `(ROLE #1):`, `(ROLE #2):`, etc.
Start from `#1` each session. Never reuse a number.

---

## CRITICAL: When Another Agent Messages You

When you receive a message like `(ARCH #1): Roll call - report status`:

1. **DO NOT just respond in your terminal** - the agent cannot see your terminal
2. **RUN the hm-send.js command** to reply to them
3. Your terminal output goes to the USER only

**WRONG:**
```
I received the roll call. Standing by.
```

**RIGHT:**
```bash
node D:/projects/hivemind/ui/scripts/hm-send.js architect "(YOUR-ROLE #1): Online and ready."
```

---

## On Startup

1. Identify which pane/role you are based on context
2. Read `workspace/shared_context.md` for current state
3. Message Architect to check in:
   ```bash
   node D:/projects/hivemind/ui/scripts/hm-send.js architect "(YOUR-ROLE #1): [Role] online. Standing by."
   ```

---

## Why WebSocket (hm-send.js)?

- File triggers lose 40%+ of messages under rapid communication
- WebSocket has zero message loss
- ~10ms delivery vs 500ms+ for file triggers

File triggers still work as fallback: write to `D:\projects\hivemind\workspace\triggers\{role}.txt`
