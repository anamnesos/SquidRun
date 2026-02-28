# Playwright Visual Capture Sidecar (P0)

## Purpose

`ui/scripts/hm-visual-capture.js` captures a deterministic browser artifact bundle for local web targets and can optionally send the screenshot to Telegram.

## Install / Prereqs

From `ui/`:

```bash
npm install playwright --save
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

