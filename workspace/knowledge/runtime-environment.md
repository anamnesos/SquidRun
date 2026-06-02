# Runtime Environment

## VIGIL

- Device ID: `VIGIL`
- OS: Windows (primary development machine)
- Primary workspace path: `D:\projects\squidrun`
- Hardware checked 2026-05-08: AMD Ryzen 9 9950X (16 cores / 32 threads), NVIDIA GeForce RTX 5090, ~61.6GB RAM.
- Notes: use `npx electron-builder` for packaging; if Windows Spectre-mitigated build libs are missing, package with `--config.npmRebuild=false`.

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
