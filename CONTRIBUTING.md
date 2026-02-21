# Contributing to SquidRun

Thanks for your interest in improving SquidRun.

## Setup

Prerequisites:
- Node.js 18+
- npm

Install:

```bash
git clone <repo-url>
cd <repo-name>/ui
npm install
```

Run:
- Windows (from repo root): `start-squidrun.bat`
- Any platform (from `ui/`): `npm start`

## Pull Request Process

1. Create a branch from `main`.
2. Keep each PR focused on one change.
3. Run lint and tests before opening a PR.
4. Open a PR with a clear summary, testing notes, and screenshots for UI changes.
5. Reference related issues when applicable.

## Code Style and Testing

- Follow the existing JavaScript style and pass ESLint.
- Add or update tests for behavior changes.
- Keep changes small, readable, and documented when needed.
- Do not commit secrets or local `.env` values.

Validation commands:

```bash
cd ui
npm run lint
npm test
```
