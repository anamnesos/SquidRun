# Workflows

- Release process: version bump in `ui/package.json`, `npx electron-builder` (`--win` from Windows, `--mac` from Mac), `gh release create`, bump `RELEASE_VERSION` in `squidrun-site/platform-download-button.tsx`, push to deploy.
- Site deployment: `squidrun-site/` is Next.js on Vercel (project: `squidrun-site`, team: `anamnesos`), domains: `squidrun.com` + `www.squidrun.com`. Push to `master` triggers auto-deploy.
- Cross-device messaging: target format is `@<device>-architect` (e.g. `@macbook-architect`). Requires `SQUIDRUN_CROSS_DEVICE=1`, `SQUIDRUN_DEVICE_ID`, `SQUIDRUN_RELAY_URL`, `SQUIDRUN_RELAY_SECRET` in `.env`.
