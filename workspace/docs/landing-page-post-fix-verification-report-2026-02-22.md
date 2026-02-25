# Landing Page Post-Fix Verification Report (2026-02-22)

## Scope
- Repo: `D:/projects/squidrun-site`
- Commit under review: `74c3445`
- Baseline reference: `workspace/docs/landing-page-post-fix-verification-baseline-2026-02-22.md`

## Validation Runs
- `npm run lint` -> pass
- `npm run build` -> pass
- `axe` full page scan (`http://127.0.0.1:4173`) -> failed on landmark structure
- `axe` `color-contrast` rule only -> pass (`0 violations`)

## Baseline Checklist Result

### High Priority
- [x] Product naming fixed to `Claude Code`, `Codex CLI`, `Gemini CLI`.
- [x] Contrast target validated by automated rule scan (`color-contrast`: 0 violations).
- [x] Top nav readability improved (included in contrast scan pass).
- [x] Hero truncation risk addressed in source (`MetricPill` no longer truncates roles; mobile nav added).

### Medium Priority
- [x] Feature-grid visual imbalance addressed (`Local by Default` card spans full row).
- [x] Information hierarchy improved via text contrast and sizing updates.
- [x] Nav discoverability improved on mobile through explicit menu toggle.

### Low Priority
- [x] Hero line-break flow improved (sentence now continuous in markup).
- [x] CTA trust/support copy present.
- [x] Background-vs-copy contrast improved (automated contrast scan passed).

## Findings To Address Before Push

1. `MEDIUM` - Missing page landmark semantics (`<main>`) trigger accessibility violations.
   - Evidence:
     - `axe` violations: `landmark-one-main` (1), `region` (23)
     - Page root starts with a generic container, not a `<main>` landmark: `D:/projects/squidrun-site/app/page.tsx:41`
   - Why it matters:
     - Screen-reader and landmark navigation experience is degraded.
     - Creates avoidable accessibility debt before deploy.
   - Suggested fix:
     - Wrap primary page content in `<main>` (or apply `role="main"` once), and ensure major content regions are nested within landmark structure.

## Non-Blocking Note
- OG image metadata is now internally consistent with asset dimensions (`960x1440`) in `D:/projects/squidrun-site/app/layout.tsx:38`.
- If social preview optimization is desired later, consider a dedicated wide OG asset (typically ~`1200x630`) for better link-card composition.

## Re-Verification Addendum (Landmark Fix)
- Follow-up commit reviewed: `808da53` (`fix: use main landmark for page root`)
- Change validated: root container switched from `<div>` to `<main>` in `D:/projects/squidrun-site/app/page.tsx`
- Re-run result (`axe` full-page scan on `http://127.0.0.1:4173`): `0 violations`

## Final Verdict
- `READY TO PUSH` from Oracle accessibility verification perspective.
- Note: automated scanning does not replace manual accessibility QA, but the previously blocking landmark issue is resolved.
