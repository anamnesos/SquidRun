# TrustQuote Calendar History Dive - 2026-04-27

Read-only history summary for:
- `D:/projects/TrustQuote/app/calendar/page.tsx`
- `D:/projects/TrustQuote/app/components/calendar/*`

Scope:
- Plain English.
- Calendar focus only.
- No recommendations yet.
- Stripe-related paths were not inspected.

## Short Version

The calendar has been a pain because it is not just a calendar.

It is a calendar, a mobile schedule, a job editor, a drag/drop board, a day planner, a materials checklist, a team assignment tool, and a notes surface all sharing the same page. Every time one of those pieces changed, it affected the others.

The history shows five recurring pressure points:

1. Mobile layout kept breaking at awkward screen widths.
2. Drag/drop and resize were hard to keep reliable.
3. The create/edit modal kept reopening, resetting, or losing fields.
4. Materials attached to jobs were easy to orphan or duplicate when jobs moved.
5. Multi-day jobs needed special handling to look right and update safely.

## Commit Activity Snapshot

Calendar-related commits by month from git history:

- 2025-07: 15 commits
- 2025-08: 75 commits
- 2025-09: 39 commits
- 2025-10: 52 commits
- 2025-11: 32 commits
- 2025-12: 5 commits
- 2026-02: 2 commits

Plain-English read:

The calendar had its biggest churn from August through November 2025. That is when it moved from "basic scheduling screen" toward the current heavy-duty version with mobile views, drag/drop, materials, team assignment, and a redesigned month/day experience. After December, calendar work slowed down and shifted more toward polish, dark mode, and cleanup.

## Most Recent Calendar Work

- `2f9140b5` on 2026-02-16: dark mode redesign touched the calendar page and most calendar components.
- `ce092b36` on 2026-02-16: audit/refactor pass removed browser dialogs and improved mobile UX, accessibility, and performance.
- `08748b74` / `18327568` on 2025-12-07: replaced native browser confirmation dialogs with the styled app confirmation flow and updated EventCard tests.
- `e3606b4e` on 2025-12-01: sharp-corner UI pass plus a materials sync fix.
- `f5e8abcf` on 2025-12-01: hydration error fix involving invoice/quote edit behavior.

Plain-English read:

The last meaningful calendar work was not a full rebuild. It was polish and stabilization: dark mode, replacing rough browser dialogs, mobile UX, accessibility, and a materials sync fix.

## Last Major Refactor Period

The big refactor period was late October through early November 2025.

Key commits:

- `996b96e1` on 2025-10-31: extracted team loading out of DayView.
- `6995fcaf` on 2025-10-31: completed EventCrudService migration.
- `61bc7491` on 2025-10-31: created EventCard component scaffold.
- `ba40e20a` on 2025-10-31: extracted EventMaterialsSection from DayView.
- `92b8c8f1` on 2025-10-31: integrated EventCard into DayView, reducing DayView size.
- `8b2ead13` on 2025-10-31: optimized EventCard and added tests.
- `8e3c42a0` on 2025-10-31: added EventMaterialsSection tests and memoization.
- `c6c6f847` on 2025-11-01: extracted customer and team components.
- `21e69730` on 2025-11-02: integrated more CreateEventDropdown extractions.

Plain-English read:

The calendar used to have too much packed into a few giant components. Late October/early November was the cleanup push: pull out event cards, materials sections, team loading, customer/team fields, and CRUD service behavior so changes could be tested in smaller pieces.

## Pain Point 1 - Mobile Calendar Kept Fighting The Layout

Commit pattern:

- `39078bd4` on 2025-11-04: mobile calendar redesign, replacing infinite scroll with month view.
- `d4f71038` on 2025-11-04: remove max-height so all 30 days show.
- `1313b3ad` on 2025-11-04: month navigation updates both selected date and display.
- `27226b13` on 2025-11-04: remove duplicate month header.
- `3f644f69` on 2025-11-04: Add Event button not working due event bubbling.
- `c7fe9af0` on 2025-11-04: complete mobile calendar redesign with month view.
- `388f3d04`, `c5b578aa`, `4bc78835`, `ff9412ea` on 2025-11-04: sticky mobile header fixes, z-index/background fixes, Safari compatibility.

Earlier mobile width churn:

- `e1a558d9` on 2025-10-01: tried enforcing 860px min width with horizontal scroll.
- `3d898f02` on 2025-10-01: changed that to stacking DayView below calendar.
- `48595337`, `db5a445f`, `89fcf19c`, `7af5fbd4`, `15a7204a`, `7c146475`, `5e011d0c`, `c5792332`, `24f3a924`, and `df4455f6` on 2025-10-01: repeated fixes around the 768-860px tablet/mobile boundary.

Plain-English read:

The calendar struggled because phones and small tablets need a different layout than desktop. The app tried horizontal scroll, stacking, one-pane mode, special 860px rules, sticky headers, and month redesigns. Each fixed one screen size while risking another.

## Pain Point 2 - Drag/Drop And Resize Were Hard To Trust

Commit pattern:

- `22a08a6e` on 2025-09-02: resolved week-view drag-and-drop issues.
- `42c4efb2` on 2025-09-02: selection highlighting was blocking week interactions.
- `8de25312` on 2025-09-02: removed selection highlighting that blocked drops.
- `f42569ff` on 2025-09-02: corrected dropped-event date calculation.
- `aa951faf` on 2025-09-02: corrected time display.
- `82e46b52` on 2025-09-03: critical fix to prevent materials from being orphaned when an event is resized.
- `9e2a2d76` on 2025-10-02: simplified drop handler for reliable cross-month dragging.
- `efa24c0c` on 2025-10-31: added drag/drop and time-editing tests.

Plain-English read:

Moving a job on a calendar sounds simple, but here it also changes the day view, job materials, time windows, multi-day display, and saved Firestore data. The hard part was making the visual move and the saved job data agree every time.

## Pain Point 3 - Create/Edit Modal State Was Fragile

Commit pattern:

- `85a6e436` on 2025-08-19: passed create form state from page to adapter.
- `6bd468df` on 2025-08-19: properly extracted form fields from hook state.
- `59a01288` on 2025-08-19: normalized form keys and improved event creation.
- `04f6ffd1` and `ff213478` on 2025-10-30: autocomplete city/state/zip fixes.
- `bfad7b1c` on 2025-11-02: restored modal container structure.
- `778f299d` on 2025-11-10: restored missing date picker in create event modal.
- `23321042` on 2025-11-07: prevented modal from reopening after event creation.
- `dbc30a3e` on 2025-11-10: fixed modal persistence and form reset regression.
- `73975230` on 2025-11-10: second attempt at modal persistence and incomplete form reset.

Plain-English read:

The modal is where users create and edit jobs. It carries customer name, phone, address, service type, date, time, amount, materials, team assignment, and notes. The history shows repeated bugs where fields reset, date pickers disappeared, or the modal reopened when it should not.

## Pain Point 4 - Materials And Notes Were Coupled To Calendar Movement

Commit pattern:

- `6122d353` on 2025-08-22: fixed materials system by separating event vs day materials.
- `561baaae` on 2025-09-11: added per-event material add flow in Day/Week.
- `84f23545` on 2025-09-11: reflected checked state in expand panel.
- `363b5fa2` on 2025-09-11: added quantity support with low-clutter UI.
- `5ad538f2` on 2025-09-11: reverted quantity support.
- `82e46b52` on 2025-09-03: critical fix to prevent materials orphaning when resized.
- `e3606b4e` on 2025-12-01: fixed a materials sync error.

Plain-English read:

Materials made the calendar more valuable, but also more delicate. A job is not just a block on a date; it can carry parts/materials. If the job moves, stretches, splits, or deletes, the materials have to follow correctly.

## Pain Point 5 - Multi-Day Jobs Needed Their Own Rules

Commit pattern:

- `f156c8dc` on 2025-09-11: fixed week-view multi-day display.
- `0220c737` on 2025-10-01: split multi-day events into one-day segments for dayGrid and added styling guards.
- `d59d7dcd` on 2025-10-01: corrected resizer visibility for split segments.
- `2181a6c4` on 2025-10-01: enforced vertical stacking lanes and strict event order.
- `a6985a47` on 2025-10-01: recomputed layout when selected day changes to prevent event chip overlap.
- `9699eebe` on 2025-10-01: auto-converted legacy start/end to `dates[]` when deleting a segment.
- `7e611e25` on 2025-10-01: added `dates[]` model support and per-day segment delete with materials cleanup.

Plain-English read:

Multi-day jobs are not just "one longer block." They need to look continuous, avoid overlapping other jobs, allow the right resize handles, and sometimes allow one day of the job to be changed without breaking the rest.

## Pain Point 6 - Team Assignment Had Sticky State Bugs

Commit pattern:

- `dab35be5` on 2025-09-09: showed team dropdown with existing members and made workers view-only.
- `32400498` on 2025-09-09: kept team dropdown open on first click and broadened team source.
- `ebdedfd5` on 2025-09-09: persisted assignees in create form and stabilized dropdown.
- `d2cac553` on 2025-09-09: made assignee selection stick immediately.
- `c188f5f2` on 2025-09-09: prevented assignee reset by removing prop-sync effect.
- `8b0fcc98` on 2025-09-09: allowed admins to assign via business membership claims fallback.

Plain-English read:

Team assignment needed to work for owners, admins, and workers. The hard part was keeping the dropdown open, keeping selected workers selected, and making permissions match the business membership model.

## Why It Has Been Brittle

In plain English:

- The page has too many jobs.
- Desktop and mobile do not behave the same.
- A calendar event is connected to customers, materials, notes, team members, invoices, and Firestore records.
- Dragging a job is both a visual action and a data rewrite.
- Old events and new events did not always use the same data shape.
- FullCalendar behavior, custom DayView behavior, and TrustQuote's own job/material rules all meet in the same place.

This is why fixes often came in clusters: one change would repair the visible issue, then expose the next edge case.

## Current Read From History

The calendar looks past the worst churn. The hottest period was August-November 2025. Since December, the commits are more about polish, dark mode, dialogs, and smaller stability fixes.

The brittle areas, based on history alone, are:

- mobile month/day layout
- create/edit modal state
- drag/drop and resize
- materials sync when events move
- multi-day event rendering
- team assignment state

No next-change recommendation included here by request.
