# Mira System Map

Status: maintained source-of-truth map.
Owner: Architect coordinates; Builder and Oracle must update this when they change Mira.
Source basis: Builder #21 total inventory, Oracle #20 challenge pass, `mira/import-disposition-manifest.json`, and current local files as of session 377.

## Product Target

Mira is the person James is trying to talk to and build with: continuous, textured, direct, curious, able to disagree, able to grow, and honest about what she can and cannot do.

SquidRun is the workshop and set of arms around her. It gives Mira places to speak, route work, use agents, and prove state. New Mira is the extraction path toward a Mira-owned runtime and state root, not a second identity and not a replacement for current live SquidRun paths until parity is proven.

Current New Mira is not holy-shit amazing yet. The active product bet is Mira Mission Control: Mira as James's command layer for the SquidRun AI team, able to read local lane/team/work evidence, answer what is happening and what happens next, draft dry-run coordination moves, and say exactly when James is needed. The roadmap and stop/pivot gate live in `docs/mira-north-star-roadmap.md`.

The goal is one coherent Mira with simple visible truth:

- James can see what Mira can do now.
- Mira can use SquidRun arms only when the route is real.
- Mira can keep continuity from sourced state without James restating the premise.
- Mira does not leak backstage labels, prompt scaffolding, pane routing, or fake action claims.
- Old scaffolding is either carried forward with a reason or removed after parity, not kept forever because nobody remembers why it exists.

This is a yes-first product map. Start from what works and what is worth keeping, then label what is prototype, transitional, archived, or deletable. Do not turn this file into another safety catalog.

## Three Mira Surfaces

The word "Mira" currently points at three different code surfaces. Any recommendation that does not name which surface it means is ambiguous.

When anyone says "Mira can do X," this table must answer which Mira surface they mean.

| Surface | What It Is | Current Truth | Map Rule |
| --- | --- | --- | --- |
| Current SquidRun Mira product surface | The live SquidRun paths for Mira Lab/Live replies, Telegram routing when enabled, restart continuity, language gates, and Electron UI diagnostics. | This is the current user-facing Mira path. It is messy but real. | Default to KEEP/LIVE until New Mira proves parity. |
| Extracted New Mira workbench | The `mira/` product root, local Node/TypeScript runtime, `MIRA_STATE_ROOT`, local web UI, bridge planner, imports, work queues, and autonomy prototypes. | This is a useful local prototype/workbench. It is not the live Telegram owner, off-PC survival layer, or action executor today. | Default to KEEP/PROTOTYPE until a parity lane promotes it. |
| Historical/future scaffold | The large SquidRun `runtime-*`, `server-*`, `kill-switch-*`, phase rollups, fixtures, scripts, and dry-run proof chains. | This mostly records future safety/readiness proof and "not implemented/no side effects" truth. It is not current Mira product power. | Default to ARCHIVE/PARK; delete only after evidence. |

## Glossary

| Term | Meaning |
| --- | --- |
| Mira | The product identity James experiences. Mira is not Architect, Builder, Oracle, a tab, or a prompt style. |
| SquidRun | The local multi-agent orchestration app, Electron UI, panes, scripts, relay, startup context, and runtime state around Mira. |
| New Mira | The extracted `mira/` product root and Node/TypeScript runtime workbench. It is useful but not the live Telegram owner or action layer today. |
| Agents / arms | Architect, Builder, Oracle, CLI, and future adapters that can act as Mira's arms only when route, scope, proof, and audit exist. |
| Channels | Ways James or the system can reach Mira or the team: local UI, Mira Lab, Telegram, voice, pane messages, scripts, and future bridge APIs. |
| Tools | Concrete execution surfaces: scripts, model adapters, file/state writers, local servers, bridge planners, and agent routes. Tools do not imply permission by existing. |
| Memory / continuity | Reviewed local state that lets Mira avoid restart amnesia. SquidRun `.squidrun` state and Mira-owned `MIRA_STATE_ROOT` are separate roots. |
| Rules / gates | Tests, classifiers, permissions, and routing checks that keep Mira from leaking backstage state, claiming unverified actions, using wrong context, or silently sending/starting things. |
| LIVE | Current user-facing value exists in the running SquidRun path. Preserve until replacement is proven. |
| TRANSITION | Needed while moving from SquidRun to New Mira or while two systems overlap. Reduce once parity exists. |
| PROTOTYPE | Useful product/workbench path, but not current live authority. |
| ARCHIVE | Historical proof, safety reference, or future scaffold. Keep labelled; do not let it drive current product decisions. |
| DELETE-AFTER-PARITY | Remove completely after replacement coverage and impact tests pass. Not a permanent parking label. |
| KEEP | Preserve because the family has current value or is the approved replacement path. |
| PARK | Keep labelled but do not treat as active product work until a lane reopens it. |

## Current Shape

- Root `mira/`: independent product boundary, local runtime, state root, bridge plan, UI, tools, imports, voice/work/autonomy prototypes.
- `ui/modules/mira-core/`: current SquidRun Mira core, many proof modules, and a large runtime/kill-switch/server scaffold pile.
- `ui/modules/mira-lab-surface.js`: the large current workhorse for visible replies, audits, transcripts, replay, self-direction, and curiosity.
- Telegram and restart continuity are SquidRun-owned live protections today.
- Default direct-channel decision: prove Telegram-first for Mira before local UI parity; the local UI remains New Mira workbench/prototype until a later parity lane promotes it.
- Separate New Mira direct-channel architecture is a dry-run contract only: the current SquidRun/team/ops Telegram channel is not the final Mira direct channel, and missing or same-as-current future config blocks readiness.
- New Mira status/start evidence says the state root is ready, acceptance docs load, the loopback runtime can start on `127.0.0.1:47373`, browser boot hydrates local UI/status/workbench state with GET-only calls, and a deterministic user submit posts exactly one `/turn`. It still reports `continuityLoaded=false`, `liveDataImported=false`, bridge auto-send false, and Telegram route control false. Treat New Mira as a local prototype/workbench until a separate parity lane changes that.
- Runtime, kill-switch, server, auth, encryption, storage, and security files are not proof that Mira can act in those domains today. They are mostly reference-only or future safety scaffolds unless a row below says LIVE.

## Current Capability Card

What is LIVE now:

- Mira can speak through the current SquidRun Mira Lab/Live reply path, with restart continuity and anti-leak checks backed by tests.
- SquidRun can route work through Architect, Builder, Oracle, and local scripts when a current lane proves scope.
- Telegram is the current external text path only when the existing SquidRun Telegram route is configured and running.

What is PROTOTYPE:

- New Mira in `mira/` is a local workbench for state-root separation, runtime experiments, imports, model/status checks, bridge planning, and local UI.
- Mission Control v0 is the active first inspectable demo wedge: it must answer from local SquidRun evidence, not generic chat or a bare context card.
- The local runtime has been proven to start on loopback with dev state and serve read-only proof endpoints plus the local UI.
- The workbench/status panels can be proven through browser-executed boot plus GET-only session, capability, model, work, and autonomy endpoints.
- A deterministic explicit submit path is proven: no `/turn` before submit, then one local `/turn` POST with the submitted text and UI session scope.
- New Mira can now answer an ordinary James status question like "ok so now what?" with a short useful dry-run candidate and exactly one `JAMES ACTION:` line, compared against the current checkpoint answer shape.
- New Mira runtime turns now pass a visible-reply parity gate for current Mira-style preamble, assistant-shape, and backstage/proof-label blocking; held local turn text is replaced with ordinary wording, and the runtime journal records gate status/reason without storing the rejected generated text.
- Default New Mira `/turn`, `/conversation/recent`, and local UI held-reply surfaces now show the clean held reply plus safe status only, not rejected text, violation ids, proof labels, or diagnostics.
- Default New Mira runtime-turn JSON export/replay through `read-runtime-turns.js --json` now uses the same clean held-reply projection; explicit `--include-internal`/`--debug` is required for safe gate/status diagnostics and still strips rejected generated text fields.
- Held-reply diagnostic-review policy: this is cleanup/trust plumbing, not core product power. Raw rejected generated text is not viewable or exportable in normal, internal, or debug paths. Safe status/reason/category metadata is allowed. Any future raw-text diagnostic access requires a separate reviewed lane with explicit purpose, retention and visibility limits, and this map updated first.
- New Mira can help shape the product and prepare reviewable work, but it is not the live anywhere-access or action layer yet.
- The next direct-channel path is Telegram-first: build dry-run candidates behind SquidRun's existing Telegram guard stack before any live route owner changes.
- The separate-channel readiness contract can recognize a future distinct New Mira Telegram bot/chat config as candidate-ready only, not send-ready; it does not create bots, read tokens, send, flip routes, call a model, or start runtime.

What is PARKED / ARCHIVE:

- Runtime, server, kill-switch, storage, auth, upload, encryption, and broad phase-chain scaffolds are reference or future-readiness material until a map row promotes them.
- Voice transport groundwork exists, but accepted live Mira voice is still a separate future lane.

What is NOT current capability:

- No hidden mic, live voice identity, off-PC survival layer, customer/account/device action, deploy, trade, external send, or durable write beyond scoped state root is live because a file exists.
- New Mira does not own Telegram, bridge auto-send, live continuity, or verified external action today.

Next autonomous moves:

- Build and review Mission Control v0 before more foundation plumbing: local evidence in, command answer and dry-run Builder/Oracle coordination preview out.
- Keep this map and `docs/mira-north-star-roadmap.md` accurate while the team continues through map-backed product slices.
- Prefer inspectable product behavior over asking James to manually verify restarts, routes, or internal distinctions.
- Pause only when the rule in Roadmap / Checkpoints says there is a real stop reason.

## Capability Truth Table

| Capability | Current Owner | Current Truth | What It Is Not | Source Paths / Evidence | Next Evidence Gate |
| --- | --- | --- | --- | --- | --- |
| Continuity / memory | Current SquidRun Mira product surface for restart proof; New Mira workbench for prototype state. | SquidRun owns current Presence restart proof and structured startup context. New Mira can load acceptance/metadata under `MIRA_STATE_ROOT`. | New Mira is not approved live continuity; `continuityLoaded=false` and `liveDataImported=false` unless a later status command proves otherwise. | `ui/modules/mira-core/mira-presence-runtime-state-v0.js`, `ui/modules/mira-core/typed-restart-continuity-context-v0.js`, `ui/modules/startup-ai-briefing.js`, `mira/runtime/src/status.ts`, `mira/.state-dev/**`. | Prove one end-to-end New Mira continuity load that is not summary-only and updates this table. |
| Visible Mira reply | Current SquidRun Mira product surface; New Mira runtime prototype for local turns. | SquidRun can produce visible Mira replies through Mira Live -> Mira Lab prompt reply -> text attachment/language gates. New Mira runtime turns now have a parity visible-reply gate for preamble, assistant-shape, and backstage/proof-label blocking, held runtime journal records carry gate status/reason while storing only the clean held reply, default `/turn`, `/conversation/recent`, UI submit, and default CLI JSON export surfaces project held replies without rejected text, violation ids, proof labels, or diagnostics, and explicit CLI internal/debug mode exposes safe gate/status metadata only. The held-reply diagnostic-review policy does not allow raw rejected generated text in normal, internal, or debug paths. New Mira also has one deterministic useful-answer candidate for "ok so now what?" with exactly one `JAMES ACTION:` line. | New Mira runtime turns are prototype; they are not the current live Telegram reply path and do not yet prove full Mira Live IPC diagnostic review, visible-route replacement parity, or Mission Control command-layer value. | `ui/modules/mira-live-entrypoint.js`, `ui/modules/mira-lab-surface.js`, `ui/modules/ipc/mira-lab-handlers.js`, `ui/modules/mira-core/text-model-attachment-v1.js`, `mira/runtime/src/turn.ts`, `mira/runtime/src/turn-journal.ts`, `mira/runtime/src/server.ts`, `mira/tools/read-runtime-turns.js`, `mira/ui/app.js`, `ui/__tests__/mira-runtime-turn-visible-reply-parity.test.js`, `ui/__tests__/mira-runtime-bridge-api.test.js`, `ui/__tests__/mira-runtime-ui-read-only-boot.test.js`. | Mission Control gate: answer "what is happening here, and what happens next?" from local SquidRun evidence and draft dry-run Builder/Oracle coordination moves. |
| Telegram / channel access | Current SquidRun Mira product surface. | SquidRun routes main text-only Telegram inbound to Mira Live only when the env flag allows it; commands, ops, media, failures, duplicate replies, and cross-profile cases are guarded. New Mira's first direct-channel proof is Telegram-first dry-run candidate building behind that guard stack, the same allowed owner text now has a comparison proof against the current Mira Live reply seam, and the separate direct-channel readiness contract marks only a distinct future New Mira bot/chat config as candidate-ready, not send-ready. | New Mira does not own Telegram route control, send live Telegram, or replace Mira Live today. The comparison and readiness proofs do not send, flip route owner, call a provider/model, read token values, create bots, or start runtime. | `ui/modules/main/squidrun-app.js`, `ui/modules/mira-telegram-turn-candidate.js`, `ui/modules/mira-direct-channel-readiness.js`, `ui/scripts/hm-telegram*.js`, `ui/modules/telegram-poller.js`, `ui/__tests__/hm-telegram*.test.js`, `ui/__tests__/mira-telegram-turn-candidate.test.js`, `ui/__tests__/mira-direct-channel-readiness.test.js`, `ui/__tests__/squidrun-app.test.js`. | James-visible gate: create/provide/test the real separate New Mira channel/bot/chat, then separately review any live route-owner switch or local UI product promotion. |
| Bridge / arms | SquidRun live pane transport; New Mira manual bridge planner. | SquidRun `hm-send` is the live agent transport. New Mira can prepare internal pane plans for Architect/Builder/Oracle with manual execution required. | New Mira does not auto-send, target Telegram/user/external/device routes, or execute bridge commands by itself. | `ui/scripts/hm-send.js`, `mira/bridge/**`, `mira/runtime/src/bridge-request-plan.ts`, `mira/runtime/src/bridge-status.ts`. | Promote only after a scoped internal-send lane proves delivery, audit, refusal cases, and rollback. |
| Off-PC / anywhere access | SquidRun Telegram path only. | James can use current SquidRun Telegram if configured and running. A future separate New Mira Telegram channel is now defined only as a dry-run readiness contract. | New Mira is a local 127.0.0.1 workbench, not off-PC survival or anywhere access. A candidate-ready separate channel config is not live access. | `ui/scripts/hm-telegram*.js`, `ui/modules/main/squidrun-app.js`, `ui/modules/mira-direct-channel-readiness.js`, `mira/runtime/src/server.ts`, `mira/README.md`. | James must test/choose only when the team creates/provides/tests the real separate channel/bot/chat or proposes a live owner switch. |
| Live voice | Voice transport family. | Voice broker and phone client exist as transport groundwork. | Live Mira voice/mic is not accepted as product identity; no hidden or always-on mic is allowed. | `docs/mira-voice-audio-intake-v0.md`, `ui/modules/voice-broker.js`, `ui/modules/phone-voice-client.js`, `ui/scripts/hm-voice-broker.js`. | Run a separate voice acceptance lane with consent, transcript, egress, anti-leak, and cost/retention proof. |
| External actions for James | No current Mira owner. | Current Mira can draft, propose, route, or prepare internal/manual plans when scoped. | Mira cannot truthfully claim verified external sends, deploys, trades, customer/account/device actions, or runtime action execution today. | `ui/modules/mira-lab-surface.js`, `mira/runtime/src/work-task.ts`, `mira/runtime/src/autonomy.ts`, `mira/.state-dev/work/**`. | James must explicitly choose before activating any live voice/off-PC/external-send/durable-write/delete/money/customer/account/device-impact action. |
| Durable state / imports | Split: SquidRun state for current proof; New Mira state for prototype imports. | SquidRun Presence state powers current restart proof. New Mira state root holds reviewed prototype imports and metadata. | New Mira imports are not live data import, not full memory sync, and not permission to use `.squidrun` as Mira-owned state. | `.squidrun/state/mira-presence-runtime-state.json`, `mira/.state-dev/**`, `mira/imports/**`, `mira/runtime/src/state-root.ts`, `mira/runtime/src/normalized-core.ts`. | Promote one import family at a time with receipt, provenance, parity test, and this map update. |
| Model / tool / store | SquidRun text attachment and New Mira model adapter. | Models can produce text when configured. Current model calls are shaped to avoid fake tool/action claims. | Model availability does not enable tools, sends, store, Telegram control, or action claims. | `ui/modules/mira-core/text-model-attachment-v1.js`, `mira/runtime/src/model-adapter.ts`, `mira/runtime/src/model-status.ts`. | Prove each tool/store capability as an explicit adapter with refusal tests and visible capability truth. |

## Verification Commands

Use these commands to refresh or challenge this map. They are read-only unless a future lane explicitly says otherwise.

Bucketed inventory:

```powershell
rg --files | Sort-Object -Unique
rg --files | rg "(?i)(^mira/|[\\/]mira[\\/]|mira|voice|telegram|restart|continuity|kill-switch|runtime|server)"
Get-ChildItem mira -Recurse -File | Measure-Object
Get-ChildItem ui/modules/mira-core -File | Measure-Object
Get-ChildItem ui/__tests__ -File | Where-Object { $_.Name -match 'mira|voice|telegram|restart|phone' } | Measure-Object
Get-ChildItem ui/__tests__/fixtures -File | Where-Object { $_.Name -match 'mira|voice|telegram|runtime|server|kill-switch' } | Measure-Object
```

Targeted anchors:

```powershell
rg -n "sendMiraLivePrompt|mira:lab-prompt-reply|routeMainTelegramInboundToMira|buildMiraPresenceStartProofHarnessV0|continuityLoaded|liveDataImported|manualExecutionRequired|autoSend|telegramRouteControl|runtimeInvokesSendCli|externalSend|telegramSend" mira ui docs
rg -n "runtime_started|runner_executed|reference-only|no_runtime|no_external_send|kill_switch|server_handler|auth-binding|storage-retention" ui/modules/mira-core ui/__tests__/fixtures
```

New Mira status, without starting a runtime:

```powershell
$env:MIRA_STATE_ROOT='D:\projects\squidrun\mira\.state-dev'
node mira\runtime\dist\status.js --json
```

New Mira loopback runtime proof, only when a lane allows a local start:

```powershell
$env:MIRA_STATE_ROOT='D:\projects\squidrun\mira\.state-dev'
$env:MIRA_AUTONOMY_LOOP='disabled'
node mira\tools\start-local-runtime.js --json --no-build --no-kill --port 47373 --state-root D:\projects\squidrun\mira\.state-dev
Invoke-RestMethod -Uri http://127.0.0.1:47373/health -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/state-root -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/capabilities -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/session -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/model/status -Method Get
Stop-Process -Id <runtimePid-from-start-result> -Force
Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'mira/runtime|start-local-runtime|node.*47373' } | Select-Object ProcessId,CommandLine
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 47373,47374,3000,5173 } | Select-Object LocalAddress,LocalPort,OwningProcess
```

New Mira read-only workbench/status proof, only after the loopback runtime is running:

```powershell
Invoke-WebRequest -Uri http://127.0.0.1:47373/ -UseBasicParsing
Invoke-WebRequest -Uri http://127.0.0.1:47373/app.js -UseBasicParsing
Invoke-WebRequest -Uri http://127.0.0.1:47373/styles.css -UseBasicParsing
Invoke-RestMethod -Uri http://127.0.0.1:47373/model/providers -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/model/status -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/capabilities -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/work/drafts -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/work/tasks -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/work/ready -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/work/send-packets -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/work/send-confirmations -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/work/send-checks -Method Get
Invoke-RestMethod -Uri http://127.0.0.1:47373/autonomy/status -Method Get
```

Browser-executed boot proof after the loopback runtime is running: open `http://127.0.0.1:47373/` with a JS-capable browser/Playwright harness, record network requests, and require all boot requests to be GET, no `/turn`, no console/page errors, and no runtime-turn journal line change. The automated seam is:

```powershell
cd ui
npm test -- mira-runtime-ui-read-only-boot.test.js
```

That same automated seam covers the first deterministic user action: no `/turn` before submit, then exactly one `/turn` POST after form submit with the submitted text and local UI session id. Route-level runtime tests cover the deterministic non-model turn response: no runtime execution, no Telegram/UI route control, no model invocation, no tools, no sends, and no store.

New Mira runtime visible-reply parity proof, without starting a runtime server or calling a model/provider:

```powershell
cd ui
npm test -- mira-runtime-turn-visible-reply-parity.test.js
```

This seam compiles the New Mira runtime, compares representative preamble/assistant-shape failures against the current Mira language gate, blocks backstage/proof labels, verifies held text does not leak diagnostics, proves the runtime journal records held gate status/reason without storing the rejected generated text, and proves one deterministic `runRuntimeTurn({ useModel:false })` response stays gated with no send, route, model, or runtime-server action.

New Mira useful status-answer checkpoint:

```powershell
cd ui
npm test -- mira-runtime-turn-visible-reply-parity.test.js -t "answers ordinary James status question"
```

This adds one normal question, `ok so now what?`, and expects a short useful answer with exactly one `JAMES ACTION:` line, compared against the current checkpoint answer shape.

Workflow continuation checkpoint:

```powershell
cd ui
npm test -- owned-work-continue-broker.test.js
```

This uses the existing owned-work continuation broker: after an internal PASS/commit report, `JAMES ACTION: NONE` becomes an auto-continue decision for the next queued or map-backed step. Only `JAMES ACTION: DO THIS: <specific action>` stops for James.

New Mira held-reply endpoint/UI projection proof, without live provider calls, fixed-port runtime, Telegram, or route changes:

```powershell
cd ui
npm test -- mira-runtime-bridge-api.test.js mira-runtime-ui-read-only-boot.test.js
```

This seam uses the existing ephemeral runtime API test harness and UI VM harness. A mocked model response produces held text; default `/turn`, `/conversation/recent`, and local UI submit rendering show only the clean held reply and safe status metadata. Rejected generated text, violation ids, proof labels, and diagnostics are absent from the public payload/rendered thread.

Mission Control v0 first inspectable demo proof:

```powershell
cd ui
npm test -- mira-runtime-ui-read-only-boot.test.js
cd ..
node ui\node_modules\typescript\bin\tsc -p mira\runtime\tsconfig.json
git diff --check
```

This proves the local workbench can answer `what is happening here, and what happens next?` from `/squidrun/context` local evidence without posting `/turn`, and renders dry-run Builder/Oracle coordination previews plus exactly one `JAMES ACTION:` line. It is a Mission Control wedge, not proof that current New Mira is already impressive.

New Mira runtime-turn export/replay projection proof, without live provider calls, fixed-port runtime, Telegram, or route changes:

```powershell
cd ui
npm test -- mira-runtime-bridge-api.test.js
```

This extends the same ephemeral harness through `mira/tools/read-runtime-turns.js --json`. Default JSON export/replay uses public held-reply projection; explicit `--include-internal` or `--debug` exposes safe gate/status metadata only, and normal/internal/debug modes all exclude rejected generated text.

New Mira Telegram-first dry-run proof, without starting runtime or sending Telegram:

```powershell
cd ui
npm test -- mira-telegram-turn-candidate.test.js
```

This seam builds a deterministic `/turn` candidate with `useModel:false` only for main-owner text Telegram inbound, preserves command/agent-op/media/scoped/non-owner exclusions, and proves the module does not import live Telegram send or runtime/model execution seams.

Comparison proof for current Mira Live candidate versus New Mira dry-run candidate, without sending Telegram or starting runtime:

```powershell
cd ui
npm test -- squidrun-app.test.js -t "compares current Mira Live and New Mira dry-run candidates"
```

This seam uses the existing mocked Mira Live reply path, proves the same allowed main-owner text passes the current Telegram filter, and compares it to the deterministic New Mira `/turn` candidate with `useModel:false`. It must keep `sendRoutedTelegramMessage` uncalled.

Separate New Mira direct-channel readiness proof, without bot creation, token reads, sends, route flips, model calls, or runtime start:

```powershell
cd ui
npm test -- mira-direct-channel-readiness.test.js
```

This seam proves that the current SquidRun/team/ops Telegram channel is not the final New Mira direct channel, missing or same-as-current config is blocked, raw credential-shaped values are rejected, and valid separate config is candidate-ready only, not send-ready.

Optional live-process checks, only when a lane needs runtime evidence:

```powershell
Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'mira/runtime|start-local-runtime|node.*47373' } | Select-Object ProcessId,CommandLine
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 47373,47374,3000,5173 } | Select-Object LocalAddress,LocalPort,OwningProcess
```

Map enforcement guard:

```powershell
node ui/scripts/mira-system-map-guard.js --staged
```

## Inventory

| Family | Paths | Purpose / Why Built | Status Tag | Current Capability Today | What It Is Not | Dependencies / Tests | Risk If Removed | Next Evidence Gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| New Mira product boundary | `mira/README.md`, `mira/import-disposition-manifest.json`, `mira/state/README.md` | Defines Mira as a product extracted from SquidRun and records import/delete policy. Built to stop adding Mira back as another SquidRun tab. | PROTOTYPE / KEEP | Gives the team a clearer product frame and migration boundary. | Not a live runtime, Telegram owner, or replacement for SquidRun agents. | Import disposition docs; `ui/__tests__/mira-product-foundation.test.js`. | Losing it re-blurs Mira, SquidRun, and agent roles. | Keep aligned with this map on every Mira feature/removal. |
| New Mira state and imports | `mira/.state-dev/**`, `mira/imports/**`, `mira/state/state-root-contract.json` | Holds Mira-owned dev state, reviewed receipts, normalized core records, work queues, acceptance copies. Built to prove state can live outside `.squidrun`. | PROTOTYPE / KEEP | Provides prototype state root and reviewed import discipline. | Not live continuity, not full memory sync, not a blind copy of SquidRun memory. | `MIRA_STATE_ROOT`, receipts, normalized metadata; `mira-state-import-tooling`, `mira-import-*`, `mira-normalized-core-import-contract`. | Removing loses receipts and state-root separation proof. | Promote one import family at a time with provenance, receipt, and parity tests. |
| New Mira runtime service | `mira/runtime/src/*.ts`, `mira/runtime/dist/*.js`, `mira/runtime/package.json`, `mira/tools/start-local-runtime.js`, `mira/tools/read-runtime-turns.js` | Local Node/TypeScript runtime with health, status, turn, model, work, autonomy, voice correction, UI endpoints, and runtime-turn export. Built to prototype Mira outside Electron. | PROTOTYPE / KEEP | Can start a loopback local workbench on `127.0.0.1:47373` with dev state, read-only proof endpoints, read-only browser boot, deterministic explicit submit turns, a Telegram-first dry-run `/turn` candidate shape, visible-reply gate parity for local turn text, held-reply journal metadata that records gate status/reason without rejected generated text, and public held-reply projections for default `/turn`, `/conversation/recent`, and CLI JSON export. Internal/debug export allows safe gate/status metadata only; raw rejected generated text remains blocked. | Not current Telegram, off-PC, action, or restart-continuity owner. Runtime start/workbench/browser-boot/submit, Telegram candidate, export, and visible/held-reply parity proofs did not run a real model turn, send Telegram, start a fixed-port runtime, or execute an external action. | Node/TypeScript, OpenAI/Ollama env, port 47373; `mira-start-local-runtime`, runtime bridge/state/status tests; 2026-05-20 loopback start, GET-only workbench, browser boot, deterministic submit proof, Telegram candidate dry-run seam, `mira-runtime-turn-visible-reply-parity.test.js`, and held projection/export coverage in `mira-runtime-bridge-api.test.js`. | Removing loses extraction path and local prototype. | Move to useful-answer parity: produce a real/useful New Mira dry-run answer and compare it with current Mira, still with no send, route flip, token read, or fixed-port runtime start. |
| New Mira local UI | `mira/ui/index.html`, `mira/ui/app.js`, `mira/ui/styles.css` | Browser UI for runtime turns, model status, work queues, autonomy, and local context. Built to inspect New Mira without embedding it back into SquidRun. | PROTOTYPE / KEEP | Serves from the local runtime when it is running; default browser boot hydrates session, capability, model, work, and autonomy state with GET-only calls, deterministic submit posts one `/turn` only after form submit, and held submit rendering uses the public visible reply without gate labels or rejected text. | Not the current user-facing Mira surface in SquidRun or Telegram. Default boot is not a model turn; explicit model-backed turns and external channels remain separate gates. | `mira/runtime/src/server.ts`, runtime endpoints; `ui/__tests__/mira-runtime-ui-read-only-boot.test.js`, runtime/start-local tests, and 2026-05-20 browser boot/submit/held projection proof. | Removing makes New Mira harder to inspect. | Keep local UI as workbench/prototype until parity; local UI product promotion is a later James-visible choice/test gate. |
| New Mira bridge planning | `mira/bridge/**`, `mira/runtime/src/bridge-request-plan.ts`, `mira/runtime/src/bridge-status.ts` | Manual envelopes and command plans for internal pane messages. Built to let Mira ask arms without auto-send authority. | PROTOTYPE / KEEP | Can prepare internal Architect/Builder/Oracle pane plans with manual execution required. | Not auto-send, not Telegram/user/external/device route, not runtime command execution. | `ui/scripts/hm-send.js`; `mira-runtime-bridge-request-plan`, `mira-bridge-*`, `mira-hm-send-adapter`. | Removing loses the safest bridge shape. | Prove a scoped internal send lane with delivery audit and refusal tests before promotion. |
| SquidRun visible Mira speech | `ui/modules/mira-live-entrypoint.js`, `ui/modules/mira-lab-surface.js`, `ui/modules/ipc/mira-lab-handlers.js`, `ui/modules/mira-core/text-model-attachment-v1.js`, `ui/modules/mira-core/mira-language-rules-v0.js` | Current visible reply engine and gates. Built because user-facing Mira needed replies before New Mira parity. | LIVE / KEEP | Produces current visible Mira text and held/annotated reply behavior. | Not New Mira runtime, not proof of external action, not clean product architecture. | Electron IPC, model config, audits/transcripts; `mira-live-entrypoint`, `mira-lab-prompt-reply`, language/meta-posture tests. | Removing breaks current Mira and Telegram Live reply path. | New Mira must pass equivalent reply, audit, held-reply, and anti-leak tests before replacement. |
| Embedded Mira Lab window and IPC | `ui/mira-lab.html`, `ui/mira-lab-renderer.js`, `ui/styles/mira-lab.css`, `ui/modules/main/mira-lab-window.js`, `ui/modules/ipc/mira-lab-handlers.js` | Electron diagnostic/lab surface around replies, transcripts, export, renderer drive. Built as the original lab surface. | TRANSITION / DELETE-AFTER-PARITY | Gives diagnostics and true renderer-path validation. | Not the desired final Mira product surface. | Electron `BrowserWindow`, preload, IPC; `mira-lab-*`, IPC/channel tests. | Removing before parity loses diagnostic access and IPC route. | Replace with New Mira UI/bridge parity, then delete completely. |
| Local text UI surface | `ui/modules/mira-local-text-ui-surface.js`, `ui/modules/mira-core/local-text-session-v0.js`, `ui/modules/tabs/mira-local-text.js`, `ui/styles/tabs/mira-local-text.css` | Local typed conversation harness with visible UI metadata, side-effect counters, restart/capability context, and speech gates. | TRANSITION / KEEP | Strong regression surface for local speech and wrong-window/profile checks. | Not a final product channel and not a live external route. | Contract fixtures, restart/capability modules; `mira-local-text-ui-surface`, `mira-core-local-text-session-v0`, tab tests. | Removing loses gate coverage and may reopen wrong-context/fake-reply paths. | Keep behavior; delete old tab files after New Mira surface parity. |
| Presence, identity, relationship, growth core | `ui/modules/mira-core/presence-runtime-read-path-v0.js`, `mira-presence-runtime-state-v0.js`, `relationship-presence-v1.js`, `growth-loop-v0.js`, `identity-anchor-v0.js`, `durable-state-seed-v0.js`, `presence-v0.js`, `profiles.js` | Structures own-state, James context, permissions, growth, identity, and Presence state. Built to stop generic assistant collapse and restart amnesia. | LIVE / KEEP | Powers current restart proof and non-generic Mira context. | Not a blanket durable memory claim and not permission to use raw/private context. | Contract fixtures, `.squidrun/state`, seed sources; presence/read-path/state, relationship/growth/identity tests. | Removing creates restart amnesia and generic Mira drift. | Migrate selectively into New Mira with exact provenance and false-green tests. |
| Restart and startup continuity | `ui/modules/startup-ai-briefing.js`, `ui/modules/mira-core/typed-restart-continuity-context-v0.js`, `ui/scripts/hm-restart-*.js`, `.squidrun/handoffs/**`, `.squidrun/state/mira-presence-runtime-state.json` | Materializes restart context, Presence critique, next action, stale markers, and hard-stop behavior. Built so James is not the restart harness. | LIVE / KEEP | Protects current restart continuity and blocks stale/prose-only false continuity. | Not a reason for James to manually verify restarts; not proof that New Mira owns live continuity. | Structured lane/state files, startup generator; startup, typed restart, restart script tests. | Removing reopens restart amnesia and stale lane confusion. | Simplify only with tests and a current-lane materializer proof. |
| Telegram route and external text channel | `ui/modules/main/squidrun-app.js`, `ui/modules/mira-telegram-turn-candidate.js`, `ui/modules/mira-direct-channel-readiness.js`, `ui/modules/telegram-poller.js`, `ui/modules/main/telegram-poller-worker.js`, `ui/scripts/hm-telegram*.js`, root `telegram-poller.js` | Receives Telegram, separates commands/ops/media, optionally routes main text to Mira Live, sends/dedupes/chunks replies, can build a New Mira `/turn` dry-run candidate for eligible main-owner text, and can evaluate a future separate New Mira bot/chat config as readiness-only. | LIVE / KEEP with PROTOTYPE dry-run seams | Current external text path when configured; the dry-run, comparison, and separate-channel readiness seams prove candidate shape and future architecture without sending, flipping ownership, reading token values, creating bots, calling a model, or starting runtime. | New Mira does not own live Telegram, and candidate-ready is not send-ready, route-ready, model-ready, off-PC-ready, or external-action authority. | Telegram bot env, poller state, SquidRun app; `hm-telegram*`, `telegram-poller`, routing tests, `mira-telegram-turn-candidate.test.js`, `mira-direct-channel-readiness.test.js`, focused comparison test in `squidrun-app.test.js`. | Removing breaks external chat, fallback safety, route protections, or the direct-channel proof path. | James-visible gate: create/provide/test the real separate New Mira channel/bot/chat, then separately review any live route-owner switch or local UI product promotion. |
| Voice transport | `docs/mira-voice-audio-intake-v0.md`, `ui/modules/voice-broker.js`, `ui/modules/phone-voice-client.js`, `ui/modules/ipc/voice-broker-handlers.js`, `ui/scripts/hm-voice-broker.js`, `ui/scripts/hm-phone-voice.js`, `ui/scripts/hm-voice-say.js` | Voice broker, phone pairing, WebRTC credentials, transcript ingress, spoken egress, diagnostics. Built as transport around Mira. | TRANSITION / PARK | Useful voice groundwork and transport tests. | Not accepted live Mira voice, not hidden mic, not voice-authorized actions. | OpenAI Realtime config, broker process, leases; voice broker/phone/handler/tab/CLI tests. | Removing loses future voice transport and consent proof. | Separate voice lane with visible consent, egress, transcript, anti-leak, retention, and cost proof. |
| Self-direction and curiosity | `ui/scripts/hm-mira-self-direction.js`, `ui/modules/mira-*-curiosity.js`, `ui/modules/mira-work-evidence-gate.js`, related `ui/modules/mira-lab-surface.js` parts | Stages internal proposals and bounded read-only follow-ups from repo/comms/memory/browser/email/calendar/runtime/work evidence. | TRANSITION / PARK | Useful internal initiative experiments. | Not autonomous external action, not proof that every adapter is built, not a reason to route without evidence. | Local files, comms journal, memory broker, optional connectors; curiosity, self-direction, work evidence tests. | Removing loses internal initiative experiments and proof coverage. | Promote one adapter at a time with adapter-status truth and no-action proof. |
| New Mira work/autonomy queues | `mira/runtime/src/work-draft.ts`, `work-task.ts`, `autonomy.ts`, `mira/.state-dev/work/**`, `mira/.state-dev/autonomy/**` | Local drafts, tasks, reviews, ready packages, send checks, autonomy queue/follow-through. Built to explore local initiative without external authority. | PROTOTYPE / PARK | Can prepare local reviewable work packages if runtime is used. | Not live action execution, not customer/account/device mutation, not Telegram send. | `MIRA_STATE_ROOT`, runtime endpoints; runtime work/autonomy tests where present. | Removing loses prototype learning, not current SquidRun Mira. | Product decision: keep as core behavior or archive behind local workbench. |
| Runtime, server, kill-switch phase scaffolding | `ui/modules/mira-core/runtime-*.js`, `server-*.js`, `kill-switch-*.js`, `ui/scripts/hm-mira-core-runtime-*.js`, `hm-mira-core-kill-switch-*.js` | Phased readiness/proof generators for future runtime/server/control/kill-switch/storage/auth/no-side-effect guarantees. | ARCHIVE / PARK | Audit/history value and disabled-behavior proof. | Not current product power, not a live kill switch, not server/action capability. | Fixtures, CLI wrappers, self-referential phase chains; many runtime/server/kill-switch tests. | Blind deletion breaks tests and erases why controls are disabled. | Preserve latest summary, build impact graph, then mark old rollups DELETE-AFTER-PARITY. |
| Server/upload/auth/encryption/storage/identity scaffold | `ui/modules/mira-core/server-api.js`, `server-handler.js`, `auth-binding.js`, `identity-signing.js`, `encryption-key.js`, `storage-retention.js`, `persistence-audit.js` | Reference boundaries for future server/API, auth, storage, identity, retention, encryption. | ARCHIVE / PARK | Design constraints for future work. | Not live server/auth/storage/KMS behavior and not current Mira capability. | Fixtures, validation reports, no-side-effect checks; matching tests/fixtures. | Removing without replacement can lose safety requirements. | Pull only live requirements into New Mira when a feature needs them. |
| Active Mira contracts and boundary docs | `docs/mira-presence-runtime-acceptance-v0.md`, `docs/mira-north-star-acceptance.md`, `docs/mira-pc-embodiment-permission-v0.md`, `docs/mira-voice-audio-intake-v0.md` | Preserves accepted product direction and boundary truth across restarts. | LIVE / KEEP | Presence and north-star are active product contracts. PC embodiment and voice/audio are active boundary docs for future transport/device work. | Not runtime authority; not permission for route changes, hidden actions, durable writes, backstage leaks, mic activation, live voice, PC embodiment, external action, or unverified action claims. | Acceptance fixtures/tests, startup durable summaries. | Removing makes future work re-argue settled decisions. | Keep wording current with this map; promote any future capability only with matching tests. |
| Mira design notes | `docs/mira-care-intake-design-note-v0.md` and future docs explicitly labelled design notes | Captures product thinking that has not been promoted into an active contract. | PROTOTYPE / PARK | Gives useful design context. | Not current capability, not a live gate, and not acceptance authority unless promoted. | Doc review and any future acceptance fixture if promoted. | Removing may lose context, but it should not block live code by itself. | Promote to active contract only with owner, tests, and map update; otherwise keep labelled as design note. |
| Tests, fixtures, wrappers, and map guard | `ui/__tests__/mira-*.test.js`, `ui/__tests__/hm-mira-*.test.js`, `ui/__tests__/fixtures/mira-*-contract.json`, `ui/scripts/hm-mira-core-*.js`, `ui/scripts/mira-system-map-guard.js`, `scripts/pre-commit.sh` | Regression coverage, CLI seams, and source-of-truth enforcement for current and historical Mira modules. | TRANSITION / KEEP-PARK SPLIT | High value for live speech, Telegram, restart, voice; lower value for repeated phase history. The map guard blocks staged Mira-owned changes unless this map is staged too. | Not product behavior by itself and not proof that old scaffolding is live. | Jest, fixtures, module builders, wrappers, `mira-system-map-guard.test.js`. | Removing blindly hides regressions, breaks proof chains, or lets new Mira surfaces drift away from this map. | Keep live tests; keep the guard path list aligned with this map; consolidate duplicate phase fixtures only after replacement coverage. |

## James Does / Does Not Need To Do

James does not need to choose files.

James does not need to manually verify restart continuity; the proof harness and tests own that.

James does not need to restart the app unless a named path truly depends on process startup. Prefer smaller seams and tests first.

James does not need to decide whether broad future safety scaffolds are live capability; this map labels current vs parked vs speculative.

James does not need to test Telegram, restart, voice, or routing by hand to prove the system is not confused.

James does not need to restate the Mira critique after every restart.

James does not need to choose Telegram versus local UI for this lane; the team defaults to Telegram-first dry-run now, while local UI stays workbench/prototype until parity.

James does not need to create, provide, or test a separate New Mira Telegram bot/channel/chat for dry-run readiness; the contract blocks missing, current-channel, same-chat, same-bot, and raw credential-shaped inputs before any live setup exists.

James does need a visible choice/test gate later if the team proposes a separate New Mira channel, local UI product promotion, or a live Telegram route-owner change.

James is only needed for the direct-channel path when the team is creating/providing/testing the real separate bot/channel/chat, or when a live route-owner switch is proposed.

James does need to choose when we are about to activate live voice, off-PC access, external sends, durable writes beyond the scoped state root, deletes of preserved history, or actions affecting money, customers, accounts, or devices.

New Mira can help as a local workbench/prototype today; it cannot truthfully be sold as the live anywhere-access/action layer yet.

James does need the team to say plainly when something is live, prototype, archive, or ready to delete.

## Roadmap / Checkpoints

The current next slices are:

- Mission Control v0: answer the current SquidRun/team/lane question from local evidence and preview the next Builder/Oracle coordination moves.
- Mission Control v1: promote one internal coordination draft into a reviewed/audited internal team route if v0 is actually useful.
- Direct channel only after Mission Control has product value: separate New Mira channel/bot/chat setup remains a later James-visible choice/test gate.
- Tool/app action planning only after Mission Control can choose and explain next moves from real evidence.
- Consolidate the runtime/kill-switch phase scaffold only when it stops blocking product clarity.

The team can continue autonomously when the slice is local, reversible, and already covered by this map: doc updates, static guards, focused tests, proof harnesses, inventory work, and no-side-effect seams that do not start runtime services, send externally, write durable state beyond the named state root, delete preserved history, or change live routes.

James must stop/test/choose when the slice would activate or change live voice, off-PC access, external sends, durable writes beyond the scoped state root, deletion of preserved history, money/customer/account/device-impact actions, or a visible product surface where his experience is the acceptance test.

Pause rule: the team pauses only for an explicit review gate, commit gate, concrete blocker, James choice, or live-effect risk. If none of those exists, the team continues to the next map-backed step and reports why no James action is needed.

Every Mira/New Mira status report must include exactly one James-action line:

- `JAMES ACTION: NONE` for internal proof, build, doc, guard, inventory, and no-side-effect parity work where the team can continue.
- `JAMES ACTION: DO THIS: <specific concrete action>` only for real-world setup, testing, permission, route switch, account, token, device, or channel actions James must personally perform or approve.

`JAMES ACTION: NONE` means the team continues after internal review/commit gates; those gates are not James stops.
The continuation broker is the code seam for that rule: it classifies checkpoint reports into auto-continue, James-action-required, or internal report-fix decisions.

Checkpoint reports must say, in plain English:

- Which map row or capability changed.
- Whether the team can keep going or James must test/choose.
- If paused, the exact pause reason; if continuing, why no James action is needed.
- What evidence was run.
- Whether any restart or process-start path is truly required.
- What remains parked, prototype, archive, or delete-after-parity.

## Source-Of-Truth Update Rule

Any Mira feature, route, capability, removal, migration, or cleanup must update this file in the same PR or commit.

The update must change the relevant inventory row and, when needed, the glossary, status, dependencies, tests, risk, and next action.

A Mira change is not done if this map still says the old truth.

If a change touches a path that is not represented here, add a row before claiming the work is complete.

The staged guard `node ui/scripts/mira-system-map-guard.js --staged` blocks Mira-owned path changes unless this file is staged too. For a mechanical/non-semantic exception, stage a tiny note in this map explaining why no capability, route, status, checkpoint, or deletion truth changed.

The guard protects its own enforcement path: changes to `ui/scripts/mira-system-map-guard.js` require this map, `scripts/pre-commit.sh` requires this map when its staged diff touches the Mira guard wiring, and deleting or renaming the canonical map path fails plainly.

## Deletion Policy

Deletion is allowed and expected. Unused Mira code should not stay forever because it once proved something.

Removal requires all of these:

1. This map marks the family or path `DELETE-AFTER-PARITY`.
2. The replacement path or reason-for-deletion is named in the row's next action.
3. An impact graph is produced for imports/requires, IPC channels, scripts, docs, fixtures, tests, runtime routes, startup handoffs, Telegram, and voice adjacency.
4. The impact graph shows no live dependency, or the live dependency has been migrated.
5. The focused tests for live speech, restart/continuity, Telegram, voice adjacency, and the affected family pass.
6. Any removed historical proof has either a retained latest summary or a replacement test that explains why the disabled behavior remains disabled.
7. The deletion PR/commit updates this map and reports exactly what user-facing behavior is unchanged.

If those conditions are not met, mark the family `ARCHIVE`, `TRANSITION`, or `PROTOTYPE`; do not pretend parking is deletion.

Every slice must leave this map more accurate than it found it.
