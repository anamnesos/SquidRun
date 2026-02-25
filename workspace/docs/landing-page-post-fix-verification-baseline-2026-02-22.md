# Landing Page Post-Fix Verification Baseline (2026-02-22)

## Purpose
This checklist captures the current pre-fix UI/UX findings so Oracle can run a strict post-fix re-audit with objective pass/fail criteria.

## Baseline Screenshots (Pre-Fix)
- `workspace/screenshots/screenshot-1771793233438.png` (hero section)
- `workspace/screenshots/screenshot-1771793260864.png` (features grid)
- `workspace/screenshots/screenshot-1771793247019.png` (how-it-works + CTA/footer)

## Verification Checklist (Post-Fix)

### High Priority (must pass)
- [ ] Copy accuracy is corrected everywhere: use `Claude Code`, `Codex CLI`, `Gemini CLI` (no stale `Claude/Codex/Gemini` shorthand in marketing copy where product names are intended).
- [ ] Low-contrast body text is improved to WCAG AA for normal text (>= 4.5:1), especially:
  - Hero supporting paragraph text
  - Feature card paragraph text
  - How-it-works step description text
  - CTA support copy and footer note copy
- [ ] Top navigation link readability meets AA for normal text (>= 4.5:1).
- [ ] Hero responsive behavior is stable: no truncation (for example role chips), no clipped labels, no overlap, no awkward overflow at common desktop and mobile widths.

### Medium Priority (should pass)
- [ ] Features grid visual balance is corrected (no orphan-card feel in final row, or equivalent intentional balancing treatment).
- [ ] Information hierarchy is clearer in dense sections (step list and feature cards): heading/body contrast and spacing support fast scanning.
- [ ] Navigation link emphasis is improved enough for quick discoverability without overpowering primary CTA.

### Low Priority (polish pass)
- [ ] Hero headline line breaks read naturally and preserve message flow.
- [ ] CTA block adds/improves trust qualifiers near action buttons (for example local-first/open-source/support statements) without clutter.
- [ ] Background texture/grid does not visually compete with low-emphasis text.

## Contrast Pass/Fail Criteria (WCAG 2.1 AA)

Use these hard thresholds during re-audit:

- Normal text (below 24px regular, or below 18.66px bold): `>= 4.5:1`
- Large text (24px+ regular, or 18.66px+ bold): `>= 3.0:1`
- UI components and graphical objects (button outlines, icon-only controls, focus indicators): `>= 3.0:1`

### Elements that must hit 4.5:1 specifically
- Top nav links (`Features`, `How It Works`, `GitHub`)
- Hero paragraph/supporting copy beneath headline
- Feature card paragraph text
- How-it-works step descriptions
- CTA supporting sentence and footer disclaimer/note text
- Any badge/chip text at small font sizes

## Re-Audit Method (after Builder completion)
1. Capture refreshed screenshots for the same three sections.
2. Compare against this checklist item-by-item.
3. Validate contrast with a numeric checker (axe DevTools, Lighthouse, or equivalent manual checker).
4. Report result as:
   - `PASS` (all High items pass; any Medium/Low noted)
   - `PASS WITH NOTES` (High pass, non-blocking Medium/Low gaps remain)
   - `FAIL` (any High item fails)

