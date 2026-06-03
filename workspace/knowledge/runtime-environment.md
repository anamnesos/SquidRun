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

## Side Profile Startup Isolation

- Non-main profile windows must not read or inject the main startup briefing/current-lane continuity as a fallback.
- A side profile may auto-boot only from a freshly materialized startup bundle marked `startupBundleReady=true`; stale or missing bundles should produce a side-profile pending note and omit main continuity.
- Profile scope beats generic window scope: a non-main `profileName` for a side profile must stay non-main even if `windowKey` is `main`.
