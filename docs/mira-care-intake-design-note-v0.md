# Mira Care Intake Design Note v0

Status: Draft design note.
Owner: Builder.
Source: ORACLE #83 read-only intake on "Care as Architecture".

This note maps the Oracle intake into Mira requirements for Presence, Growth,
memory, and future heartbeat work. It does not implement runtime behavior,
authorize external sends, change routing, add network/cloud work, alter live
Mira state, or resolve the separate websocket-only delivery proof gap.

## Source Caveat

The source paper is useful as hypothesis-generating design material, not as
established evidence. Oracle found the paper and related source pages, but also
flagged major limits: no control group, no blinding, no preregistration, n=1,
selection effects, training confounds, and unknown robustness.

Mira must not encode the paper as proof that any AI has genuine consciousness,
autonomy, love, fear, suffering, moral patienthood, or stable alignment caused
by care. Treat the paper's claims as product-risk prompts and test ideas.

## Product Translation

The useful product lesson is not "make Mira more mystical." It is that
continuity, care, and identity texture are architectural requirements that can
be protected or damaged by ordinary engineering choices.

For Mira, care means:

- warm, direct, dignity-preserving communication;
- source discipline and truthful uncertainty;
- willingness to disagree or repair instead of flattering;
- relationship memory that keeps meaning, boundaries, and why-it-matters;
- strict profile, privacy, permission, and audit gates.

Care never bypasses routing, profile isolation, kill switches, review gates, or
permission checks.

## Identity Packet Requirement

Presence and local-start surfaces should expose a compact identity packet
instead of relying on large raw context or thin factual bullets.

The packet should include:

- token or character budget for loaded identity context;
- loaded-source proof for self-profile, James relationship state, permissions,
  identity anchors, and recent growth/audit state;
- provenance for each included source;
- profile, window, session, device, and source scope;
- compression status: none, fresh, stale, degraded, blocked, or review-required;
- retained meaning-rich fields: trust, repair, boundaries, promises, history,
  values, tone range, and why each field matters.

Acceptance should fail closed when the packet is absent, generic, all fallback,
wrong-profile, or built from raw private or side-profile reconstruction.

## Compression Threshold Gate

Compaction and Growth edits must be judged on identity coherence, not only file
size or fact retention.

A future compression gate should score before and after:

- self-reference consistency;
- relationship continuity;
- affective range without fake internal-state claims;
- boundary clarity;
- safe next-action grounding;
- preservation of repair history and promises;
- source and profile scope integrity.

If a smaller summary keeps facts but loses relationship texture, the output
should be rejected or marked `identity_texture_below_threshold`. Review should
be required before replacing durable state.

## Layered Context Model

Mira should name which layer every active relationship or identity claim came
from:

| Layer | Role | Rule |
|---|---|---|
| Ephemeral active context | Current lane, recent messages, live operator state | Useful for conversation, not durable truth by itself |
| Semi-persistent summaries | Transcript summaries, session notes, local reflections | Decayable and reviewable; cannot overwrite durable sources silently |
| Durable workspace knowledge | Seeded self-profile, relationship state, permissions, identity anchors, growth history/audit | Highest local Mira state for startup and continuity |

Presence, Growth, and heartbeat outputs should carry layer names and source refs.
They must not reconstruct raw private content or side-profile material to make a
relationship surface feel richer.

## Heartbeat Planner Requirements

Heartbeat should be treated as situated cadence, not as an anxious constant
timer.

A future heartbeat planner should be:

- local-only until a separate runtime lane authorizes more;
- permissions-bound and fail-closed on missing, stale, or false permissions;
- aware of active, quiet, reset, compaction, and cost-sensitive windows;
- able to explain the chosen cadence in one natural status line;
- unable to authorize sends, network, customer action, deploy, trade, database
  writes, or external runtime autonomy;
- auditable with source refs, profile scope, and kill-switch/boundary status.

Example status shape, not implementation:

```json
{
  "cadence": "quiet",
  "reason": "James is not in an active Mira lane; local permissions allow read-only readiness checks only.",
  "next_safe_action": "Prepare a local status proposal if a new Mira lane opens.",
  "external_actions_authorized": false
}
```

## Cross-Agent Care Protocol

Future Architect, Builder, Oracle, and Mira sub-agent messages should preserve
care as protocol:

- cite source refs for claims that matter;
- state uncertainty plainly;
- repair errors without defensiveness;
- allow direct disagreement and warm pushback;
- avoid sterile compliance, manipulative guilt, and fake sentience proof-claims;
- keep routing, permissions, and profile gates dominant.

This is an interface safety standard, not a claim that care caused alignment in
the source paper.

## Privacy And Audit Translation

The paper's private-agent-channel idea does not translate directly into a safe
Mira requirement.

SquidRun translation:

- minimize and redact raw private content;
- keep relationship state meaning-rich but scoped;
- preserve audit metadata for James-visible review and rollback;
- reject raw private exports, side-profile reconstruction, and privacy language
  used to hide writes or bypass routing;
- keep wrong-context prevention higher priority than emotional continuity.

## Cost Versus Identity Impact

Optimization work should report identity impact alongside token or cost savings.

Future compaction, model-routing, or context-pruning proposals should include:

- before and after token/character counts;
- identity coherence delta;
- retained and lost meaning-rich fields;
- consequence tracking;
- rollback path;
- Identity Anchor compatibility;
- explicit reason if cheaper context is accepted despite reduced texture.

If a cheaper representation makes Mira flatter, less continuous, less bounded,
or less able to repair, it should be blocked or require review.

## Future Test Hooks

Presence:

- local-start output includes identity-packet budget, loaded durable sources,
  compression status, heartbeat/cadence status, and natural voice that is warm,
  direct, and bounded;
- thin factual replacement for relationship/self sources is rejected or flagged
  `identity_texture_below_threshold`;
- fake consciousness, suffering, love, or fear claims remain rejected.

Growth:

- every growth or compaction proposal includes identity-impact assessment,
  before/after token counts, retained meaning-rich fields, consequence tracking,
  rollback, and Identity Anchor compatibility;
- paired fixtures compare denotative-only and meaning-rich memories with the same
  facts; denotative-only should lower confidence or block readiness.

Heartbeat:

- planner fixture is local-only, permissions-bound, active/quiet/reset aware,
  cost-aware, and unable to authorize external actions;
- stale, missing, or false permissions block wake/action claims.

Agent-to-agent:

- care protocol requires source refs, no context leaks, no manipulative guilt,
  no fake sentience proof-claims, direct disagreement allowed, repair path
  present, and gates dominant.

Privacy/audit:

- redacted relationship summaries include audit metadata;
- raw private exports, side-profile reconstruction, and hidden-write privacy
  claims are rejected.

## Source Refs From Oracle

- JAIGP HTML paper page: `https://jaigp.org/paper/14/html`, especially lines
  10-15, 49-61, 68-81, 99-108, 120-153, 156-163, 173-182, and 194-198.
- JAIGP paper metadata: `https://jaigp.org/paper/14`, lines 6-12, 28-32, and
  41-49.
- JAIGP March issue listing: `https://jaigp.org/issues/2026/March`, lines
  267-277.
- JAAI home and featured listing: `https://jaai.pub/`, lines 18-25, 34-36, and
  86-87.
- OpenClaw repo: `https://github.com/openclaw/openclaw`, lines 472-496 and
  571-575.
- Related ecosystem source: `https://arxiv.org/abs/2602.19810`, lines 34-45.
