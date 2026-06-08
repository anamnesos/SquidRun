# TrustQuote Arm-Set Proposal

> **SUPERSEDED - do not build from this document.** This proposal captured the
> old TrustQuote Lead / Work + Schedule / Money + Documents abstraction and the
> desired/ready/missing scoreboard model. James's current Squid Room authority is
> `memory/project_squidroom_original_definition.md`: real CLI panes, one
> Builder, one Oracle, expandable per-app arm sections, and a single arms count.
> Keep this file only as historical context for the drift it caused.

Status: DRAFT / ITERATIVE-LEAD-RULEBOOK / PENDING-TRUE-UNKNOWNS
Date: 2026-06-06
Source: Joint S406 proposal co-signed by Oracle and Builder
Scope: Proposal only. No TrustQuote app changes, autonomy, customer sends, money movement, scheduling mutation, deploy, or production repair is approved by this document.

Foundation: This proposal builds on the same product foundation as [TrustQuote Room Open Orchestrator](./trustquote-room-open-orchestrator.md): one durable proof chain, current-session identity, readiness state, and explicit missing-capability accounting before any visible "ready" claim.

## Purpose

Define the first lean TrustQuote lead/arm model as a business operating design, grounded in how TrustQuote actually works today and in the permission boundaries needed before any productized autonomy.

The proposal is intentionally draft-status while the Lead rulebook is built incrementally from app history, documented workflow, and James's corrections.

## Requirements-Gathering Model

The Lead and arms must derive from the app's existing history and documented workflow first, then ask James only the genuine judgment-call unknowns.

This is the same evidence-order principle applied to James himself: read before asking. Asking James questions that the schedule, jobs, invoice history, customer records, or documented workflow already answer is not careful; it is noise.

Rulebook growth is iterative, not a one-shot questionnaire:

- First mine current schedule, jobs, quotes, invoices, payments, customers, warranties, notes, owner context, and documented workflows.
- Then apply captured rules.
- Then escalate only the remaining business judgment calls.
- When James corrects the system, persist that correction as a rule and use it in future evidence order.

## Captured Business Rules

These are current James-supplied rules for the Lead rulebook.

1. Paid means James says it is paid, for now.
   - Do not require external proof yet.
   - Payment records and outside proof can support the draft, but James's statement is the current authority.
2. Multi-address customer resolution: today's scheduled appointment location always wins over the saved main address.
   - James scheduled that address.
   - Only stop or flag when there is a genuine schedule-vs-record conflict, such as two current schedule records or an appointment whose address is internally inconsistent.
3. Invoice equals contract.
   - James is a contractor; the invoice doubles as the contract.
   - Doing a job, starting a job, "need an invoice," or "need a proposal" when work is actually starting all point to the same action: create the invoice/contract artifact.
   - A proposal/estimate is a separate path only for people who just want an estimate.
   - This matches the app shape: `jobs` are canonical work/invoice records, while `quotes` are proposals.
   - The Money + Documents arm should not treat "create invoice from completed job" as the core question. For this business, the invoice is the job artifact: create the invoice/contract draft, then James reviews and sends it when ready.

## What TrustQuote Is

TrustQuote is a service-business operations app for plumbing work, not a generic CRM.

The real operating flow is:

1. Schedule or appointment packet.
2. Job context, media, field notes, and materials.
3. Quote, invoice, payment, or approval.
4. Customer/property record, warranty, support, and follow-up history.

The system should therefore split arms by business risk, data lane, and permission boundary, not by every UI feature.

## Real Data Surfaces

TrustQuote's current source surfaces include:

- Firebase Auth for users, roles, and business membership.
- Firestore business-scoped records:
  - customers, properties, and contacts
  - calendar events
  - jobs and active invoices
  - quotes and proposals
  - payments and refunds
  - expenses
  - services and pricebook sections
  - warranties
  - job notes and materials
  - business settings
  - team and user records
  - business notes and owner context
  - approval tokens, pending actions, and action receipts
  - audit logs
  - support conversations and client errors
  - Telegram links and intake
  - Vapi/customer interactions
- Firebase Storage for customer-visible invoice photos and internal job media.
- API and service surfaces for dashboard invoice reads, schedule enrichment, invoice sending, SMS, Stripe payment intent, approvals, Telegram, voice intake, team/admin/support/health, warranties, owner context, and text polish.
- Admin, script, and test surfaces for dry-run/apply repair, field-job completion, data integrity, payments, orphan warranties, browser/API proof, and unit/regression proof.

Current canonical facts:

- `jobs` are the canonical active invoice/job records.
- `quotes` are proposals.
- `invoices` is compatibility/secondary, not the primary active invoice source.
- Schedule truth lives in calendar events, linked through source-event, job, invoice, quote, and linked-job fields.
- Customer truth lives in root customer/property records, where multi-property ambiguity is a real business issue.

## Recommended Arm Count

Day-to-day TrustQuote operating set:

- TrustQuote Lead.
- Work + Schedule arm.
- Money + Documents arm.

Build/fix mode adds one summoned arm:

- Dev/QA arm.

This means:

| Mode | Desired | Ready Today As Product-Native Arms | Missing |
| --- | --- | --- | --- |
| Day-to-day operations | 3 total: Lead + 2 domain arms | 0 | Lead registry, arm manifests, check-ins, read projections, draft tools, approval queue, readiness proof |
| Build/fix mode | 4 total: Lead + 2 domain arms + Dev/QA | Partial human/agent approximation through SquidRun Builder and Oracle | Durable productized Dev/QA role, proof contract, and integration with the same readiness model |

The app already has many data and tooling surfaces. It does not yet have the durable arm registry, least-privilege projections, check-in contract, or per-arm readiness proof needed to call these product-native arms.

## TrustQuote Lead

### Job

The Lead owns:

- TrustQuote manifest and registry.
- Desired, ready, and missing arm status.
- Role and route check-ins.
- Current business rules and business-memory backstop.
- Readiness proof.
- Review of arm output.
- Missing-arm escalation.

The Lead is the thinking mind over durable proof state. It is not another chatty pane and does not need to hold every detail in model memory.

### Data Lane

The Lead reads summaries and proof from every lane:

- Current TrustQuote room readiness proof.
- Arm check-ins.
- Current workstream/projection state.
- Domain arm summaries.
- Approval state.
- Captured business-rule notes and corrections.

### Evidence Order

1. App manifest and registry.
2. Current readiness proof.
3. Arm check-ins.
4. Latest app data proof from the relevant lane.
5. Approval state.
6. Captured business rules and James corrections.
7. Ask James only if the app data and rulebook cannot resolve the remaining judgment call.

### Least-Privilege Tools

The Lead can:

- Read summaries and proofs from each arm.
- Route work to arms.
- Ask arms for evidence.
- Write durable notes, readiness state, and missing-arm status.
- Decide when a draft has enough proof to ask for approval.

The Lead cannot directly:

- Send customer messages.
- Move, create, or cancel appointments.
- Create invoices or quotes.
- Record payments or expenses.
- Delete, archive, refund, or reverse records.
- Run production repair scripts.
- Mutate customer or business records.

### Draft-Vs-Apply Boundary

The Lead may approve routing and request owner/JAMES approval for a draft. It cannot self-apply customer, money, schedule, delete/archive, refund, or repair actions.

## Work + Schedule Arm

### Job

The Work + Schedule arm owns the operational truth around where work is happening, what is scheduled, what is known about the site, and what field context is missing.

### Data Lane

This arm reads:

- Calendar events.
- Appointment packets.
- Job packets.
- Customer/property context.
- Field notes.
- Materials.
- Media metadata.
- Callbacks.
- Multi-day work context.
- Team and assignee information.
- Directory records.
- Owner/business notes.

### Evidence Order

For work, schedule, and address questions:

1. Today's or current appointment.
2. Linked job or appointment packet.
3. Customer/property record.
4. Recent invoice/job history.
5. Owner context or directory.
6. Escalate if conflict remains.

Address rule model:

- If James gives a vague invoice or job prompt and a customer has two addresses, today's scheduled appointment location wins over the saved main customer address.
- If the schedule and customer record disagree, use today's appointment location unless there is a genuine schedule-vs-record conflict.
- If there is a genuine conflict, stop or draft with the exact conflict and ask one focused question. Do not guess.

### Least-Privilege Tools

This arm can:

- Read schedule, customer, job packet, notes/materials, media metadata, directory, and team availability.
- Draft schedule changes.
- Draft job-note updates.
- Draft missing-info prompts.
- Draft customer/address selection recommendations.
- Summarize the current job packet or appointment packet.
- Mine schedule and job history before asking James for operational details.

It should not receive broad arbitrary database write access.

### Draft-Vs-Apply Boundary

Requires Lead plus owner approval:

- Create appointments.
- Move appointments.
- Cancel appointments.
- Complete appointments or jobs.
- Link jobs to events.
- Change customer records.
- Change customer-visible work details.

Requires James-level approval:

- Delete or archive customer/property history.
- Any destructive or irreversible cleanup.

## Money + Documents Arm

### Job

The Money + Documents arm owns money and customer-facing document drafts, while staying approval-gated before any real-world effect.

### Data Lane

This arm reads:

- Jobs and active invoices.
- Quotes and proposals.
- Payments.
- Refunds.
- Expenses.
- Pricebook/services.
- Warranties.
- Invoice emails, SMS, reminders, and approval links.
- Payment intents.
- Business invoice settings and numbering.
- Audit history.

### Evidence Order

For an existing invoice, job, quote, or payment task:

1. Current requested record.
2. Linked appointment/source event for schedule and address truth.
3. Customer/property record.
4. Payments and warranties.
5. Pricebook/services.
6. Business settings.
7. Owner context.
8. Escalate if conflict remains.

For creating an invoice from a calendar appointment:

1. Appointment/source event.
2. Linked job packet.
3. Customer/property record.
4. Recent job/invoice history.
5. Pricebook/service defaults.
6. Payments/warranty context.
7. Business settings.
8. Escalate if conflict remains.

Core rule: active task or object comes first; appointment wins specifically for where/when conflict resolution.

Invoice/contract rule:

- An invoice is the contract artifact for started or starting work.
- Doing a job, starting a job, "need an invoice," or "need a proposal" when work is actually starting should route to invoice/contract creation, not to the proposal path.
- A quote/proposal path is only for someone who wants an estimate before committing to work.
- The arm should derive this from schedule/job context and history before asking James.

### Least-Privilege Tools

This arm can:

- Read invoices, jobs, quotes, payments, warranties, services, and expenses.
- Draft invoice/contract artifacts for actual or starting work.
- Draft estimates/proposals only when the customer is asking for an estimate path.
- Draft quote conversions.
- Draft reminders.
- Draft approval requests.
- Draft payment entries.
- Draft warranty suggestions.
- Draft reconciliation flags.
- Calculate balances and unpaid/paid status from records.
- Suggest pricebook or warranty matches.
- Treat James's statement as the current paid authority while still showing supporting payment records when available.

It should not receive broad arbitrary database write access.

### Draft-Vs-Apply Boundary

Requires explicit owner approval:

- Send invoice emails.
- Send SMS messages.
- Send reminders.
- Send approval links.
- Finalize or send invoice/contract artifacts.
- Record payments.
- Record expenses.
- Convert quotes.
- Change money fields.
- Create payment intents.
- Schedule money-related follow-up.

Requires James-level approval:

- Delete records.
- Archive records.
- Refund.
- Reverse payments.
- Run destructive repair.

Default rule: never customer-facing send by default.

## Dev/QA Arm

### Job

The Dev/QA arm is summoned only when the app itself needs to be built, fixed, tested, or verified. It is not part of daily plumbing operations.

### Data Lane

This arm reads:

- Repository source.
- Tests.
- Browser/UI proof.
- API results.
- Logs.
- Route-owner/workroom proof.
- Regression reports.

### Evidence Order

1. User report.
2. Current UI/API proof.
3. Source/test diff.
4. Live browser/API result.
5. Regression test.
6. Handoff.

### Least-Privilege Tools

This arm can:

- Read repo and app source.
- Run tests.
- Inspect browser/UI/API behavior.
- Draft fixes and proof plans.
- Provide independent verification.

It cannot:

- Mutate production customer records.
- Mutate money records.
- Send customer messages.
- Run customer-impacting production repairs without approval.

### Draft-Vs-Apply Boundary

Code changes go through the existing SquidRun process:

- Builder owns implementation.
- Oracle owns independent verification.
- Architect/Lead owns routing and acceptance.
- Deploy and customer-impacting changes remain approval-gated.

## Lean Rationale

Do not split arms by UI feature.

Separate invoice, payment, customer, calendar, reminder, warranty, media, and pricebook arms would rot and create coordination noise. The real split is money risk and permission boundary:

- Work/schedule can make operational mistakes, but should not touch money.
- Money/documents can draft a lot, but must be gated before customer-facing or payment effects.
- Dev/QA is only needed when the app itself is changing.

Start with Lead plus two operating domain arms. Summon Dev/QA only in build/fix mode.

## Required Missing Pieces

Before this can become product behavior, TrustQuote/SquidRun needs:

- Durable TrustQuote lead registry.
- Arm manifests with data lane, permissions, and current status.
- Arm check-ins and readiness proof.
- Desired, ready, and missing counts surfaced separately.
- Least-privilege read projections per arm.
- Named draft tools per lane.
- Approval-gated apply queue.
- Per-action evidence capture.
- Missing-arm escalation.
- Clear projection from readiness proof into visible UI status.
- A durable rulebook surface that stores mined workflow facts separately from James-supplied judgment rules.
- A "read before asking" check that blocks arms from asking James questions the app history or documented workflow can already answer.

This should generalize from the room-open orchestrator: one product-level path, one authoritative proof artifact, and projections that cannot contradict the latest proof.

## True Unknowns For James

These are not an upfront questionnaire. The Lead should ask them only when the app history and documented workflow do not already answer the current case.

1. When a customer calls from a new address with the same phone number and there is no current appointment to anchor it, is that usually a new property or a correction to the old address?
2. Who besides James is allowed to approve appointment changes, invoice/contract sends, payment recording, or customer contact changes?
3. Which customer photos can appear on invoices by default, and which should stay internal?
4. If a tenant is present but the owner pays, whose name and contact should be on the invoice, reminder, and appointment when history does not already show the pattern?
5. What are James's default warranty rules by service type when the service list/history does not already answer?
6. How should callbacks or warranty calls be priced or labeled differently from new work when history does not already answer?
7. What should happen when a job is partly done across multiple days and the current schedule/job history does not show whether to invoice now or wait?
8. Should expenses and materials be recorded during the job or only after invoice closeout when history does not already show James's habit?
9. Are there customers or job types that should never get polished wording or automatic message drafts?
10. What are the two or three daily questions James wants the Lead to answer without asking him to restate context?

## Recommendation

Start with Lead plus two domain arms for operating TrustQuote. Summon Dev/QA only when the app needs changes.

Every arm should be read-first and draft-first. Customer messages, money, scheduling, deletes, refunds, and repairs stay behind explicit approval.

The first product step is not autonomy. It is durable lead registry, arm check-in/proof, read-only domain summaries, and an approval-gated apply queue.
