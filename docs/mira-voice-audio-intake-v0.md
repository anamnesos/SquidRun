# Mira Voice/Audio Intake v0

Status: Draft design note.
Owner: Builder.
Source: ORACLE #101 voice/audio intake criteria plus official OpenAI audio docs
checked on 2026-05-07.

This note defines the first safe shape for letting James talk to Mira. It does
not implement microphone access, audio capture, model calls, TTS playback,
Realtime sessions, Telegram prompts, runtime listeners, or storage writes.

## Design Frame

Voice is a standing trust scope with visible state, audit, and revocation. It is
not a sequence of per-utterance unlock popups, and it is not a hidden always-on
listener.

The first product bar is simple:

- James can choose how voice works before any capture begins.
- The current voice state is visible.
- Stop, mute, and revoke are always available while active.
- Missing scope, stale scope, wrong profile/window/session, hidden window, sleep
  state, missing stop control, missing mic grant, or storage mismatch fails
  closed before audio capture or model call.

## Official Model Fit

Use bounded request transcription first.

| Use Case | Default Fit | Notes |
|---|---|---|
| Hold-to-talk or short clip transcription | `gpt-4o-mini-transcribe` | Practical default for low-friction transcription. |
| Higher-accuracy transcription | `gpt-4o-transcribe` | Use when transcription quality matters more than cost/latency. |
| Multi-speaker transcription | `gpt-4o-transcribe-diarize` | Use only when speaker labels are required. |
| Realtime conversation | `gpt-realtime` family through Realtime API | Later explicit mode only; tools/functions/actions disabled in v0. |
| Spoken playback of final text | `gpt-4o-mini-tts` through Speech API | TTS is separate from listening and requires AI voice disclosure. |

Implementation must verify current official limits at build time. Current
criteria from Oracle's official-doc intake:

- uploaded transcription files are limited to documented size and supported
  formats;
- diarization has narrower behavior and chunking requirements, especially for
  longer audio;
- realtime transcription is distinct from speech-to-speech conversation;
- VAD/manual turn mode must be recorded when realtime modes arrive;
- TTS voice/model availability must be bound to the selected model and disclosed
  as AI-generated voice.

## Staged Modes

| Stage | Mode | Capture | Output | Status |
|---|---|---|---|---|
| 0 | Text only | None | Text | Current baseline. |
| 1 | Hold-to-talk transcription | Captures only while pressed | Transcript into normal Mira text path | First recommended build. |
| 2 | Listen-only live captions | Explicit on/off session | Transcript events only | No Mira reply or action. |
| 3 | Text-first voice reply | James speaks; Mira replies in text | Optional spoken playback of final text | TTS remains separate. |
| 4 | Realtime conversation | Explicit start/stop session | Back-and-forth voice/text | Later mode; no tools/actions by default. |

Every mode needs a machine-checkable scope, visible active indicator, stop/mute,
timeout, and transcript destination.

## Standing Trust Scope

The trust scope should be durable enough that James does not have to re-answer
every tiny action, but narrow enough that unsafe work cannot smuggle itself in.

Scope fields:

- `mode`: text, hold-to-talk, listen-only, text-first reply, realtime;
- `profile`, `windowKey`, `session`, `device`, `source_scope`;
- `mic_state`: off, armed, capturing, muted, revoked;
- `transcript_destination`: preview, normal Mira input, private note, none;
- `storage_policy`: redacted audit only, local redacted transcript, raw debug
  clip;
- `tts_policy`: text only, speak selected final replies, realtime spoken reply;
- `trust_duration`: one press, one visible app session, persistent until off;
- `started_at`, `expires_at`, `last_revoked_at`;
- `stop_control_visible`, `mute_control_visible`, `timeout_ms`.

Default values:

- mic off;
- text only;
- redacted audit only;
- no raw audio persistence;
- no TTS;
- one visible app session at most, unless James explicitly chooses otherwise.

## Boundaries

### Network

Network scope is only the documented OpenAI audio call needed by the selected
mode. v0 must not authorize Telegram sends, customer sends, browser actions,
deploys, trades, database writes, memory-sync writes, runtime autonomy, tool
calls, function calls, hidden listeners, or cross-profile routing.

### Storage

Storage defaults closed:

- raw audio is ephemeral and not durably written;
- transcript is transient UI by default;
- audit stores redacted metadata only;
- transcript or clip retention must be a separate explicit local-only scope;
- Growth or memory promotion remains a reviewed separate action.

Any retained transcript/clip must be profile/window/session scoped, deletable,
rollbackable, and barred from raw private, side-profile, or Eunbyeol
reconstruction.

### Privacy

Do not claim audio remains purely local after it is sent to the OpenAI API.

Audit metadata should record:

- endpoint and model;
- mode and selected trust scope;
- duration, approximate bytes, tokens, and cost when available;
- storage choice;
- configured retention, zero-data-retention, or modified-abuse-monitoring
  status when known;
- transcript hash, not raw transcript by default;
- profile/window/session/device/source scope.

Spoken Mira output must not claim actual consciousness, suffering, fear, love, or
secret human identity.

## Revocation

Revocation must be real, not just a UI label.

Stop/revoke must:

- close any active stream or session;
- clear in-memory audio buffers;
- block new model calls under that voice scope;
- mark the scope revoked with timestamp and reason;
- emit a redacted audit event;
- require a fresh active scope before capture resumes.

Fail closed when a scope is missing, stale, revoked, degraded,
review-required, wrong-profile, hidden, asleep, or missing visible stop/mute.

## TTS Separation

Speaking is not listening.

If spoken output is enabled:

- bind TTS model and voice in the scope;
- disclose that the voice is AI-generated;
- speak only already-final text unless realtime mode is explicitly active;
- never speak before the voice scope is active;
- stop playback on revoke;
- keep text-only as the safest default.

## Future Tests And Probes

Default-off:

- no mic stream;
- no audio bytes;
- no network call;
- no file/temp/db writes.

Hold-to-talk:

- no capture before press;
- capture starts only while active;
- release commits or discards;
- raw audio is not persisted.

Listen-only:

- transcript events only;
- no assistant response;
- no tool call, route, send, or action.

Realtime:

- explicit start;
- visible indicator;
- VAD or manual turn mode recorded;
- timeout/revoke closes connection;
- tools/functions disabled.

Storage/privacy:

- no raw audio logs/files by default;
- transcript durable writes blocked without selected scope;
- raw private, side-profile, and Eunbyeol reconstruction rejected.

Routing/isolation:

- wrong profile/window/session rejects before model call;
- hidden/background capture rejects before model call.

TTS:

- model/voice bound;
- AI voice disclosure present;
- no spoken output outside active scope.

Audit/cost:

- mode, model, endpoint, duration, bytes, tokens, hash, storage, and retention
  status recorded without raw content.

## Telegram Choices For James

Ask only when the answer changes durable voice behavior.

1. First voice mode:
   Hold a button to talk (recommended), toggle listening on/off, or full realtime
   conversation.
2. Transcript handling:
   Show transcript first (recommended), send through normal Mira input
   automatically, or keep as private notes only.
3. Storage:
   Redacted audit only (recommended), local redacted transcripts, or short raw
   clip debug retention.
4. Mira speaking:
   Text only (recommended), speak selected final replies, or realtime spoken
   replies.
5. Standing trust duration:
   One button press, one visible app session with stop/mute (recommended), or
   persistent until turned off.

## Source Refs

- ORACLE #101: local SquidRun read-only audio intake criteria.
- OpenAI audio guide: `https://platform.openai.com/docs/guides/audio`.
- OpenAI speech-to-text guide:
  `https://platform.openai.com/docs/guides/speech-to-text`.
- OpenAI realtime transcription guide:
  `https://platform.openai.com/docs/guides/realtime-transcription`.
- OpenAI realtime VAD guide:
  `https://platform.openai.com/docs/guides/realtime-vad`.
- OpenAI `gpt-realtime` model page:
  `https://platform.openai.com/docs/models/gpt-realtime`.
- OpenAI `gpt-4o-mini-transcribe` model page:
  `https://platform.openai.com/docs/models/gpt-4o-mini-transcribe`.
- OpenAI `gpt-4o-transcribe` model page:
  `https://platform.openai.com/docs/models/gpt-4o-transcribe`.
- OpenAI `gpt-4o-transcribe-diarize` model page:
  `https://platform.openai.com/docs/models/gpt-4o-transcribe-diarize`.
- OpenAI text-to-speech guide:
  `https://platform.openai.com/docs/guides/text-to-speech`.
- OpenAI API data controls:
  `https://platform.openai.com/docs/guides/your-data`.
