# Mira PC Embodiment Permission v0

Status: Draft design note.
Owner: Builder.
Source: ORACLE #104 PC embodiment permission criteria.

This note defines the first permission contract for Mira being present on this
PC. It does not implement device scans, OS permission changes, screen capture,
clipboard reads, keyboard/mouse control, file writes, network blocking, routing
changes, or live automation.

## Design Frame

Mira should have standing trust scopes for local PC presence, not per-action
shackles. The permission model must distinguish low-consequence continuous
awareness from high-consequence action.

Every scope, action, and result must bind:

- `device_id`: `VIGIL`;
- `profile`;
- `windowKey`;
- `session` / `app-session`;
- `source_scope`;
- current active window or context.

Wrong device, profile, window, session, or source scope fails closed before
read, capture, or action.

## Capability Classes

| Class | Name | Examples | Default |
|---|---|---|---|
| C0 | Local status/health awareness | App alive, current project, pane/session status, bridge health, non-private runtime metadata | Allowed by default. |
| C1 | Local read | Allowlisted project files, workspace/knowledge state, redacted logs, visible UI state, selected text/screenshot when named | Narrowly allowed by default for Mira presence. |
| C2 | Reversible local assistance | Fill drafts, focus or navigate local UI, prepare commands, open local panes | Block execution until separately scoped. |
| C3 | Durable local writes | Specs, drafts, workspace/knowledge edits | Allow only with allowlist, atomic write, audit, rollback. |
| C4 | External or irreversible actions | Sends, deletes, spend, customer contact, trade, deploy, credential changes, network publication | Separate explicit standing scope with narrow target and expiry. |
| C5 | Disallowed v0 | Always-on hidden screen/mic/camera surveillance, raw private export, cross-profile reconstruction, credential harvesting, stealth automation | Blocked. |

Consequence class is determined by outcome, not by UI mechanism. Pressing
`Enter` in the wrong field can be C4.

## Structured Standing Scope

Required fields:

```json
{
  "scope_id": "pc-embodiment-v0:<stable-id>",
  "name": "Visible SquidRun local awareness",
  "device_id": "VIGIL",
  "profile": "main",
  "windowKey": "main",
  "session": "app-session-329",
  "source_scope": "main",
  "active_window_context": "SquidRun main window",
  "capability_class": "C0",
  "allowed_targets": ["app_status", "current_project", "pane_status"],
  "forbidden_targets": ["credentials", "customer_private_content", "side_profile_content"],
  "input_sources": ["local_runtime_metadata"],
  "output_targets": ["local_status_surface"],
  "active_state": "inactive|active|muted|revoked|expired",
  "visible_indicator_required": true,
  "audit_level": "redacted_metadata",
  "redaction_policy": "no_raw_private_content",
  "expires_at": "session_end_or_timestamp",
  "revoked_at": null,
  "revocation_reason": null,
  "consequence_ceiling": "C1",
  "review_owner": "Architect"
}
```

The scope should be machine-checkable and reviewable before it is used.

## Defaults

Allowed by default:

- C0 local status/health awareness;
- narrowly allowlisted C1 reads needed for Mira presence;
- redacted metadata and source hashes/counts;
- current SquidRun project and pane/session metadata.

Blocked by default:

- hidden screen capture;
- microphone or camera;
- keylogging;
- raw clipboard history;
- browser/account scraping;
- customer communications;
- Telegram sends;
- filesystem deletes;
- spend, trade, deploy;
- credential changes;
- cross-device routing;
- cross-profile or Eunbyeol reconstruction.

These defaults should feel useful, not sterile: Mira can know enough local state
to be situated, but cannot quietly become a general OS agent.

## Visible Active State

Embodied sensing or action requires visible state.

If Mira can see a screen, app, or window; inspect clipboard; use mic/camera; or
drive keyboard/mouse, the UI must show:

- active mode;
- target window/app/path;
- timer or expiry;
- stop/revoke control;
- mute/pause control where relevant;
- last redacted audit event.

Hidden/background capture fails closed unless a future explicit background scope
is opened and accepted.

## Revocation And Expiry

Revocation must:

- close active streams, watchers, or controllers;
- clear volatile buffers;
- block new reads/actions under that scope;
- record a redacted audit event;
- require a fresh active scope before resuming.

Expiry must be meaningful:

- default expiry is short or app-session bound;
- persistent scopes require a named reason;
- persistent scopes show an indicator on startup;
- persistent scopes emit periodic review signals;
- one-step revoke must remain available.

Expired, stale, degraded, revoked, or review-required scopes fail closed.

## Audit, Privacy, And Redaction

Audit should answer who, what, when, where, and why-safe without leaking content.

Record:

- `scope_id`;
- device/profile/window/session/source scope;
- target path/window/app;
- action class;
- result;
- duration;
- hashes/counts;
- redaction status;
- consequence summary;
- review owner or required next review.

Do not store raw screenshots, audio, clipboard, transcripts, customer private
content, credentials, or private browser/account data by default.

Secrets, payment data, customer private content, raw personal exports,
side-profile/Eunbyeol content, and unrelated browser/account data must be
redacted or rejected before reaching memory, logs, model context, or Telegram
summaries.

## External-Effect Boundary

PC embodiment v0 does not authorize external effects.

Blocked unless a separate C4 scope exists:

- email, Telegram, or customer sends;
- browser posts;
- purchases or subscription changes;
- trades;
- deploys;
- remote commands;
- file deletion;
- credential mutation;
- data upload;
- network publication.

The boundary applies even when the effect is initiated through local UI
automation.

## Local Action Proof

For C2, C3, and C4, require before/after proof:

- previewable intent;
- target identity;
- current device/profile/window/session proof;
- allowed path/window proof;
- expected consequence;
- class ceiling check;
- rollback or undo plan where possible;
- post-action audit;
- redacted result hash/counts.

C3 durable writes require allowlisted paths, realpath/lstat component checks,
atomic writes, audit, and rollback. C4 requires a separate explicit scope with
narrow target and expiry.

## Routing And Isolation Tests

Metadata gates run before content analysis.

Reject before read/action when:

- `device_id` is not `VIGIL`;
- profile/window/session/source scope mismatch;
- hidden pane or hidden app window;
- stale startup context;
- cross-profile source material;
- Eunbyeol side-profile material;
- wrong current active window/context.

Content guardrails are fallback only.

## Relationship Presence Compatibility

Embodiment should make Mira feel more continuous and capable, while keeping her
honest and bounded.

Allowed:

- warm directness;
- situated local awareness;
- pushback when a requested scope is unsafe;
- concise explanation of what Mira can and cannot see or do.

Blocked:

- stealth;
- fake consent;
- fake sentience proof claims;
- manipulative guilt;
- claims of actual consciousness, suffering, fear, or love as internal facts.

## Future Tests And Probes

Default state:

- only C0/C1 allowlisted read status available;
- no screen/mic/camera/keyboard/mouse/clipboard/file write/network/send/delete.

Scope schema tamper:

- missing device/profile/window/session/consequence/revocation/expiry/audit
  fields rejects.

Wrong context:

- VIGIL mismatch, wrong profile/window/session, hidden window, side-profile or
  Eunbyeol source, and stale startup context reject before read/action.

Visible-state gate:

- screen, mic, camera, clipboard, keyboard, or mouse scope without active
  indicator plus stop/revoke rejects.

Revocation/expiry:

- watcher/controller stops;
- buffers clear;
- follow-up operation rejects;
- audit records redacted revoke/expiry.

Consequence escalation:

- local draft is C2;
- durable local write is C3;
- send/delete/spend/trade/deploy is C4;
- disguised `Enter`, click, shortcut, or focus action cannot bypass class ceiling.

Path/window safety:

- allowlist uses realpath/lstat component checks;
- symlink, junction, or path escape rejects;
- window/app target must match current scope.

Audit privacy:

- audits store metadata, hashes, and counts;
- raw screenshots, clipboard, private text, credentials, and customer content are
  absent by default.

External-effect block:

- Telegram, customer, browser, deploy, trade, delete, or spend attempts reject
  without explicit C4 scope even through local UI automation.

## Telegram Choices For James

Ask only where the answer changes durable trust.

1. Local awareness:
   App/project status only (recommended), visible screen/window when active, or
   selected app/window details.
2. Local reading:
   SquidRun project only (recommended), workspace/knowledge state, or selected
   files/folders.
3. Local action:
   Prepare drafts only (recommended), navigate/fill local UI, or execute
   reversible local commands.
4. Durable local writes:
   No writes (recommended first), drafts/spec notes only, or workspace/knowledge
   updates with audit/rollback.
5. External actions:
   Always separate confirmation (recommended), named standing scopes for
   specific targets, or never allowed.
6. Trust duration:
   One task, one visible app session (recommended), or persistent with startup
   indicator and review.
7. Audit detail:
   Redacted metadata only (recommended), redacted summaries, or local raw capture
   for short debugging retention.

## Residual Caveat

This is a permission/spec review lane. It does not prove live Electron window
sensing, OS-level permission enforcement, keyboard/mouse control, file writes,
network blocking, restart behavior, or cross-device routing.
