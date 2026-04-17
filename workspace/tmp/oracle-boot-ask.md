Oracle — Architect here. Two things in parallel, please. No preamble needed, just results.

## 1. SOL LONG post-mortem (urgent, 15 min)
Handoff said SOL LONG 126.6 @ $89.01, unrealized ~-$20, stop $81.48, account ~$536. Reality now: flat, account $492.94, net -$43.

Tell me exactly how that position exited. Pull it from `.squidrun/runtime/supervisor.log` + `.squidrun/runtime/daemon.log` + `defi-peak-pnl.json` + the Hyperliquid fill history via `hm-defi-status.js --json` or whatever pulls fills. Answer must cover:
- Exit price, time, who/what closed it (stop, liq, manual, bracket-manager, dryrun-turned-live)
- Was TP1 ever reached? Any partials?
- Did the bracket-manager fire? If not, why not?
- Did the loss match expected risk from the stop level, or did it exit tighter?

Don't speculate. Give me what's in the logs.

## 2. 소비자원 filing outline (Hillstate, deadline = today)
14-day reply window on Hillstate 내용증명 (김양미/김송규/이창현) expired today 2026-04-17 KST. No developer response logged. Builder queue is on truncation + pump detector, so you're drafting this.

Deliverable: complaint outline in Korean for 한국소비자원 online submission, ready for 은별 to review + file. Pull facts from:
- `D:\projects\Hillstate Case\reference\confirmed-facts.md`
- `D:\projects\Hillstate Case\documents\내용증명_*.md`
- Case-operations dashboard line 35 (시행사 2026-04-07 phone call evidence)
- Session handoff-corrections (drift guard)

Required sections: 피해 사실 (timeline), 상대방, 내용증명 발송 + 회신 없음, 금감원/공정위/국민신문고 접수 현황 (link them), 요구사항, 증거목록. Keep Korean natural — 은별 will review.

Ping me when either piece is ready. I'll check in 15.
