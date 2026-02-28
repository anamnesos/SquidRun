# Playwright Capture + Smoke Pipelines (P0-P2)

## Purpose

- `ui/scripts/hm-visual-capture.js` captures a deterministic visual artifact bundle for local web targets and can optionally send the screenshot to Telegram.
- `ui/scripts/hm-smoke-runner.js` runs deterministic autonomous smoke checks and emits structured QA diagnostics for Builder-triggered workflows.

## Install / Prereqs

From `ui/`:

```bash
npm install playwright --save
npm install axe-core --save
npx playwright install chromium
```

## Command

Basic:

```bash
node ui/scripts/hm-visual-capture.js capture --url http://127.0.0.1:3000 --full-page
```

Auto-resolve URL (cache + heuristic ports/framework):

```bash
node ui/scripts/hm-visual-capture.js capture
```

Send screenshot to Telegram:

```bash
node ui/scripts/hm-visual-capture.js capture --url http://127.0.0.1:3000 --send-telegram "Visual smoke"
```

Smoke run with accessibility + link checks:

```bash
node ui/scripts/hm-smoke-runner.js run --route /dashboard --require-selector "#app" --require-text "Dashboard"
```

## Resolution Order

1. Explicit override (`--url`)
2. Cached URL (`.squidrun/state/visual-url-cache.json`)
3. Heuristic candidates from common ports + package/framework hints

## Artifact Output

Per run under:

`workspace/.squidrun/screenshots/visual-captures/<run-id>/`

Includes:

- `current/screenshot.png`
- `meta/trace.zip`
- `meta/console-errors.json`
- `meta/request-failures.json`
- `meta/dom.html`
- `meta/aria-snapshot.json`
- `meta/navigation.json`
- `manifest.json`

Also updates:

- `workspace/.squidrun/screenshots/latest.png`

## Autonomous Smoke Artifact Output (P1/P2)

Per run under:

`workspace/.squidrun/screenshots/smoke-runs/<run-id>/`

Includes:

- `screenshot.png`
- `trace.zip`
- `dom.html`
- `aria-snapshot.json`
- `axe-report.json`
- `dom-summary.json`
- `link-checks.json`
- `diagnostics.json`
- `summary.json`
- `manifest.json`

## P2 Controls

- Disable a11y scan: `--no-axe`
- Disable link validation: `--no-validate-links`
- Tune thresholds:
  - `--axe-max-violations <n>`
  - `--max-broken-links <n>`
  - `--min-body-text-chars <n>`
- Content assertions:
  - `--require-text <snippet>` (repeatable)
  - `--content-case-sensitive`
