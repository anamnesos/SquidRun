# Handoff Corrections
# Authoritative drift guard for session 267-268 cross-checks.
# Created: 2026-04-09
# Maintainer: Oracle / Architect

## Purpose

This file exists to stop the same four drift points from re-entering handoffs as settled facts.

Before any agent:
- summarizes these threads to James or Eunbyeol
- updates `case-operations.md`
- drafts legal/comms guidance based on these threads

check this file first.

Rule:
- If this file says a point is disputed, do not collapse it into a single confident statement.
- Prefer `verified`, `explicitly corrected`, or `needs source verification` language.

## Drift Point 1: Hillstate Mailing Status

Current safe status:
- Revised Hillstate letters with `재발송 사유` were definitely created and sent to Eunbyeol as files.
- Eunbyeol later stated that she sent all 3 online and captured confirmation screenshots.
- However, the canonical trackers were still carrying `ready to send` / `next action is actual mailing`.
- Therefore the authoritative status is:
  `mailing/submission claimed in transcript, but actual postal/e-content completion requires screenshot or receipt verification before we treat the 14-day clock as confirmed.`

Primary citations:
- 2026-04-04T02:59:29.744Z: revised letters updated/sent to Eunbyeol as files.
- 2026-04-04T04:50:28.954Z: Oracle cross-check said next action was actual mailing.
- 2026-04-06T03:38:24.849Z: Eunbyeol said `인터넷으로 다 보냈어. 그리고 신청확인 캡처해놨어`.
- 2026-04-06T03:38:47.475Z: assistant treated 14-day response window as started.

Operational rule:
- Do not say `DELIVERED` or `14-day clock started` unless the screenshot/e-content receipt is checked.

## Drift Point 2: Channel A Status

Current safe status:
- Older transcripts repeatedly treated Channel A as a confirmed April 27 broadcast.
- This was later explicitly corrected.
- Therefore the authoritative status is:
  `Channel A is interested / involved / reviewing, but broadcast is NOT confirmed.`

Primary citations:
- 2026-03-31T08:14:24.640Z: assistant claimed `Channel A confirmed: April 27, 7 PM`.
- 2026-03-31T16:54:43.327Z: assistant repeated `broadcast confirmed (4/27)`.
- 2026-04-08T02:58:23.150Z: complaint draft still included `4/27 방영 확정`.
- 2026-04-08T02:59:32.864Z: assistant stated `Channel A is 검토중, not 방영 확정`.
- 2026-04-08T02:59:56.212Z: explicit correction sent to Eunbyeol: `취재 검토 중`.

Operational rule:
- Do not write `방영 확정`, `broadcast confirmed`, or cite April 27 as settled unless a fresh direct confirmation appears.

## Drift Point 3: Shipping Data / Danggeun Analysis

Current safe status:
- Eunbyeol asked for 10 recommended items, monthly sales counts, and a clean file because text was broken.
- During the same window, the system repeatedly claimed the flood was duplicate and the analysis had already been delivered.
- The authoritative status is:
  `the system claimed completion, but the user-side conversation still showed unmet requests; treat final clean delivery as unverified / likely incomplete.`

Primary citations:
- 2026-04-05T12:10:59.388Z: Eunbyeol asked for 10 items to sell on Danggeun.
- 2026-04-05T12:22:25.748Z: Eunbyeol asked `4월달까지꺼안갔어?`
- 2026-04-05T12:51:03.878Z: Eunbyeol said records likely go back to December and asked for parsing.
- 2026-04-05T13:11:45.569Z: Eunbyeol asked for monthly volume next to results.
- 2026-04-05T13:12:45.491Z: Eunbyeol asked for a file because text was broken.
- 2026-04-05T12:56:21.920Z through 2026-04-05T13:10:02.782Z: assistant repeatedly said `Duplicate`, `analysis already sent`, `full analysis delivered`.
- 2026-04-05T13:10:46.062Z: assistant notes Eunbyeol could not find the real conversation among the duplicate flood.

Operational rule:
- Do not say `already delivered` or `complete` for this thread unless the final user-facing file/output is found and checked.

## Drift Point 4: Seongdong Tax Reply

Current safe status:
- The system initially framed the tax routing as a strong three-way squeeze.
- When the Seongdong reply arrived, a compressed summary (`증거 부족 조사 안 함`) was given after the assistant had already admitted it had not fully read the whole reply.
- The authoritative status is:
  `Seongdong's reply is a threshold/evidence-based refusal to investigate from current materials, not a merits clearance or exoneration.`

Primary citations:
- 2026-04-09T05:41:12.659Z: assistant framed 3-way routing as `완벽한 3방향 포위`.
- 2026-04-09T05:45:50.713Z: assistant said all tax departments were engaged.
- 2026-04-09T08:24:37.021Z and 2026-04-09T08:27:42.326Z: raw response tail with Seongdong contacts posted.
- 2026-04-09T08:25:27.869Z: Eunbyeol posted the Seongdong Tax Section 1 reply.
- 2026-04-09T08:34:09.010Z: assistant admitted it had not fully read the whole reply.
- 2026-04-09T08:36:02.371Z: assistant compressed it to `증거 부족 조사 안 함`.

Operational rule:
- Do not summarize this as `they investigated and cleared it` or `the case is dead`.
- Safe wording:
  `based on current submitted materials, Seongdong would not investigate on suspicion alone and wanted clearer tax-evasion grounds/evidence.`

## Insurance / FSS Note

This is not one of the four drift points, but it is now a separate active lane and should not be buried.

Current safe status:
- Separate Samsung Fire / FSS complaint thread exists.
- FSS complaint was filed and later assigned to investigator 조범준.

Primary citations:
- 2026-04-09T01:08:07.025Z: assistant identifies Samsung Fire/FSS compensation dispute as its own thread.
- 2026-04-09T03:56:00.259Z: assistant says `금감원 교통사고 민원 접수 완료`.
- 2026-04-09T08:22:48.906Z: assistant says investigator assigned: 조범준 선임조사역 (051-606-1713), ~1 month.

## Fast Use

If an agent is about to say:
- `Hillstate letters were delivered`
- `Channel A broadcast is confirmed`
- `Danggeun analysis was already sent`
- `Seongdong rejected because there was no case`

stop and re-check this file first.
