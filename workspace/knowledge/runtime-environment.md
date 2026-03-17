# Runtime Environment

## VIGIL

- Device ID: `VIGIL`
- OS: Windows (primary development machine)
- Primary workspace path: `D:\projects\squidrun`
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
