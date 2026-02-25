# Devices

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
