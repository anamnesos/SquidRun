# Workflows

- Release process: version bump in `ui/package.json`, `npx electron-builder` (`--win` from Windows, `--mac` from Mac), `gh release create`, bump `RELEASE_VERSION` in `squidrun-site/platform-download-button.tsx`, push to deploy.
- GitHub Releases are immutable in this repo once published. Do not create an empty release and then upload assets. Use one atomic command that creates the release with all files attached (for example: `gh release create vX.Y.Z <all-artifact-paths> --title "vX.Y.Z" --generate-notes`).
- Site deployment: `squidrun-site/` is Next.js on Vercel (project: `squidrun-site`, team: `anamnesos`), domains: `squidrun.com` + `www.squidrun.com`. Push to `master` triggers auto-deploy.
- Cross-device messaging: target format is `@<device>-architect` (e.g. `@macbook-architect`). Requires `SQUIDRUN_CROSS_DEVICE=1`, `SQUIDRUN_DEVICE_ID`, `SQUIDRUN_RELAY_URL`, `SQUIDRUN_RELAY_SECRET` in `.env`.
