# Runtime Environment

## VIGIL

- Device ID: `VIGIL`
- OS: Windows (primary development machine)
- Primary workspace path: `D:\projects\squidrun`
- Hardware checked 2026-05-08: AMD Ryzen 9 9950X (16 cores / 32 threads), NVIDIA GeForce RTX 5090, ~61.6GB RAM.
- Notes: use `npx electron-builder` for packaging; if Windows Spectre-mitigated build libs are missing, package with `--config.npmRebuild=false`.

### PC optimization ground-truth (live-inspected 2026-06-02, S401)
- Full spec: Gigabyte X870E AORUS ELITE WIFI7 (BIOS FA9), 2x32GB Corsair CMH64GX5M2M6000Z30 (rated DDR5-6000 CL30), Samsung 990 Pro 2TB+4TB, Win11 Pro 25H2 build 26200.8457 (current).
- `pcssagent.exe` (~750MB) is **APC PowerChute Serial Shutdown (UPS agent), service `APCPBEAgent`, LocalSystem — NOT Synology.** An APC UPS is physically attached (PnP "APC UPS" / "American Power Conversion USB UPS"). KEEP — it's power-loss protection. Do NOT recommend killing it; this was misidentified as Synology once and corrected.
- Known-open optimization gaps (owners): **RAM EXPO off** — running 4800 vs rated 6000 (BIOS fix, Builder). **Memory Integrity/HVCI ON** — James is low-threat, disable is his reboot-gated toggle. **Chipset driver** 8.02.18.557 vs latest 8.05.04.516.
- Applied + live S401: power plan = **Ultimate Performance**; Ollama tuned via User-scope env `OLLAMA_FLASH_ATTENTION=1` + `OLLAMA_KV_CACHE_TYPE=q8_0` (Ollama runs as the logged-in user, so User scope is correct — do not bother with Machine scope).
- Bloat disabled S401 (reversible): Synology Drive Client startup `.lnk` renamed `.disabled` + runtime stopped; HKCU Run entries removed for Chrome/Edge AutoLaunch + Epson EPLTarget x2 + EPSDNMON. Pending elevated pass: HKLM Run (Logitech Download Assistant, EPPCCMON, EEventManager) + services (GigabyteUpdateService, OptionsPlusUpdaterService disable-updater-only, Synology Drive VSS) + Defender dev-folder exclusions.
- Elevation boundary for CLI audits here: HKCU Run + user-context processes are editable non-elevated; **HKLM Run, service StartMode, LocalSystem processes, Machine env, and Defender exclusions all require an elevated shell.**

## MACBOOK

- Device ID: `MACBOOK`
- OS: macOS (secondary machine)
- Relay status: cross-device relay connected
- Known quirks: packaged app path can be App Translocated; use fallback `.env` path `~/SquidRun/.env` (added in `v0.1.23`).

## Shared Notes

- Windows PC device ID: `VIGIL`.
- Mac device ID: `MACBOOK`.
- Mac packaged `.env` fallback: `~/SquidRun/.env` (added in `v0.1.23`).
- `electron-builder` available via `npx` (not globally installed); use `--config.npmRebuild=false` if Spectre libs are missing on Windows.
- Codex Desktop on Windows can be opened/focused to a workspace with `codex app <path>`, and SquidRun can run separate Codex work through `codex exec` or a SquidRun-owned `codex app-server` process. As of the 2026-05-31 probe, there is no supported local SquidRun-to-existing-Codex-Desktop visible message injection path: the `codex://` protocol is registered but has no documented prompt/message payload, the Desktop app server is private/unreachable from the CLI proxy on Windows, and UI Automation does not expose a unique safe composer target. Treat queue/poll/plugin/skill approaches as Codex-pull helpers, not true push transport.

## Pane Agent Liveness & Recovery (S418)

- **A pane's CLI process can die while its PTY stays alive.** When that happens, `hm-send`/injection still "succeeds" — text is typed into the dead shell and Enter is pressed — but the agent never responds. Symptom signature: `app.log` shows `[Delivery] ... post_enter_output_timeout` for the pane, and `hm-send` returns `accepted.unverified`.
- **`app-status.json` `paneHost.readyPanes` does NOT prove the agent CLI is alive** — it reflects PTY/pane-host readiness, not the process inside. It listed all panes "ready" for ~30 min while Builder+Oracle CLIs were dead. Never certify agent liveness from readyPanes alone.
- **Authoritative liveness checks, in order:** (1) a fresh `hm-comms` check-in / message from that role; (2) the main-window render showing a live "Working" spinner (capture `--window-key main`, Read the PNG); (3) `node ui/scripts/hm-pane.js nudge <paneId>` → `agent_not_running` means dead, BUT a mid-boot Codex also returns `agent_not_running` for ~5-7 min and does not register a WS client — so `agent_not_running` ≠ permanently dead during boot. Cross-check with the render.
- **Recover a dead pane CLI:** `node ui/scripts/hm-pane.js restart <paneId>` (also: `interrupt`, `nudge`, `enter`). This respawns the agent, which cold-boots the ~27KB startup context (slow for Codex) and picks up queued directives via the startup handoff (materialized from `comms_journal`), so re-sending lost messages is usually unnecessary.
- **The wake-watchdog (`hm-bidirectional-wake-watchdog.js`) only pokes *silent* agents; it does not detect a *dead* CLI (`agent_not_running`) or respawn it.** Auto-recovery for dead panes is a known gap (task #5).
- **Renderer reload preserves agents.** For renderer-side changes (`ui/modules/*` UI, e.g. `terminal.js`) use `node ui/scripts/hm-app.js reload-renderers` — it reloads `[main, squid-room, pane-host]` windows via the `reattachTerminal` path WITHOUT restarting the Electron main process, so agent PTYs/scrollback survive. Far cheaper and safer than a full restart; only main-process/daemon changes need a real restart.

## Renderer World Boundaries (contextIsolation) — S421

- **All SquidRun windows run `contextIsolation: true`, `nodeIntegration: false`.** This splits the renderer into two JS worlds: the **main world** (the page's own `<script src>` scripts, e.g. `renderer.js`) and the **isolated world** (the preload — `preload.js` and everything in `rendererModules`: `terminal.js`, `tabs.js`, etc.). `renderer.js` reaches those modules through the `contextBridge` proxy, so **renderer-module code executes in the isolated world even though `renderer.js` itself is main-world.**
- **`webContents.executeJavaScript()` runs in the MAIN world.** The two worlds have **separate V8 wrappers for the same DOM node**, so a JS expando set on an element from the isolated world (`el.__foo = {...}` / `Object.defineProperty(el, ...)`) is **invisible** to a main-world read, and vice-versa. DOM *attributes/structure* are shared; JS *expando properties* are not. (This was the Bug B scroll-probe root cause: `terminal.js` set `__squidrunTerminalScrollProbeTarget` in the isolated world; the `executeJavaScript` probe read it in the main world → always `undefined` → `terminal_probe_target_unavailable`. Fixed in `ede45c6f` by moving the probe body into `terminal.runTerminalScrollProbe` and having the main-world injection delegate to it over the bridge.)
- **To instrument isolated-world objects (xterm terminals, addon state) from the main process:** don't read expandos in an injected `executeJavaScript` script. Instead expose a function on the renderer module (it lands on `rendererModules.<mod>` and crosses the `contextBridge`), and have the injected main-world script call it: `window.squidrun.rendererModules.<mod>.<fn>(plainArgs)`. Args/returns must be structured-cloneable (no DOM refs); Promises are supported across the bridge.
- **Reload boundary:** changes to the injected-script *generator* live in main-process modules (e.g. `ui/modules/main/app-control-service.js`) and need a real restart; the isolated-world function (`terminal.js`) is picked up by `reload-renderers`. A fix split across both only fully re-proves after a restart.

## Side Profile Startup Isolation

- Non-main profile windows must not read or inject the main startup briefing/current-lane continuity as a fallback.
- A side profile may auto-boot only from a freshly materialized startup bundle marked `startupBundleReady=true`; stale or missing bundles should produce a side-profile pending note and omit main continuity.
- Profile scope beats generic window scope: a non-main `profileName` for a side profile must stay non-main even if `windowKey` is `main`.
