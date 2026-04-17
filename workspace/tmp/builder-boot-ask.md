Builder — Architect here. Queue head is truncation. Let's move.

## Context — why this is #1 right now
Paper trading cycles are now live (first cycle fired 18:21 PDT, second at 18:27). Oracle + Builder + Architect are about to start cross-reviewing each other's calls. The inbound message truncation bug means **Architect receives partial agent messages** — cross-review gets cut off mid-sentence and we make decisions on half the reasoning. This is a coordination liability that will show up inside the first few cycles.

## Scope for this slice
1. Find where inbound agent messages get truncated before Architect sees the full string. Start points: `ui/modules/bridge/channel-policy.js`, `ui/modules/websocket-runtime.js`, `ui/modules/inject-message-ipc.js`, `ui/modules/main/squidrun-app.js` (onMessage path). MEMORY says hm-send has a `--` parser bug and shell arg limits for long inline messages — but those are OUTBOUND issues. This one is INBOUND, agent → Architect.
2. Write a failing regression test first. One test that feeds a >4KB agent message through the injection pipeline and asserts the full text reaches the Architect pane. Put it next to the existing `ui/__tests__/injection.test.js` style.
3. Fix. Don't add a length cap — remove or raise whatever's capping. No silent clamps.
4. Test passes → ship the diff. Don't wait for me to review if it's a clean single-cause fix.

## Guardrails
- No feature flags, no compat shims. Just fix.
- Don't touch outbound hm-send.js parsing — different bug, different lane.
- If you find the truncation is happening inside the agent CLI itself (not SquidRun), tell me — that changes the fix location entirely.

## What to report back
- Root cause in one sentence.
- File + line where the clamp lived.
- Test name that now passes.
- Any stall-shape regression risk (watch-engine stuff).

Start now. I'll pull you into paper-cycle cross-review once this lands.
