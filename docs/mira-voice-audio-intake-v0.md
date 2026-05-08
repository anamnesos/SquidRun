# Mira Voice/Audio Intake v0

Status: Pre-experiment hygiene note; implementation is partially live, but the
A/B voice lab has not run.
Owner: Builder.
Last updated: 2026-05-08.
Source: ORACLE #18 voice/audio intake criteria plus official OpenAI Realtime and
speech-to-text docs checked on 2026-05-08.

This note separates the current SquidRun implementation from the policy and
acceptance criteria for letting James talk to Mira. It is not approval to run a
live OpenAI or microphone experiment.

## Current Implementation

SquidRun now has a local voice broker and two WebRTC client surfaces:

- Desktop voice tab: `ui/modules/tabs/voice-broker.js` with
  `ui/styles/tabs/voice-broker.css`.
- Broker service: `ui/modules/voice-broker.js`.
- Phone browser shell: `ui/modules/phone-voice-client.js`.
- IPC/preload wiring: `ui/modules/ipc/voice-broker-handlers.js`,
  `ui/modules/bridge/preload-api.js`, and `ui/modules/bridge/channel-policy.js`.
- CLI/runtime control: `ui/scripts/hm-voice-broker.js`,
  `ui/scripts/hm-phone-voice.js`, and `ui/scripts/hm-voice-say.js`.
- Mira reply egress: `ui/scripts/hm-send.js` appends voice egress messages for
  the broker to speak through the active Realtime session.

Live local broker endpoints:

| Endpoint | Use |
|---|---|
| `GET /status` and `GET /health` | Broker lifecycle, address, model config, and endpoint contracts. |
| `GET /phone` | Serves the paired phone WebRTC client shell. |
| `GET /v1/voice/phone/config` | Public phone config without server API keys. |
| `POST /v1/voice/phone/pairing` | Local-only phone pairing token creation. |
| `POST /v1/voice/realtime/client-secret` | Desktop Realtime ephemeral key broker. |
| `POST /v1/voice/phone/realtime/client-secret` | Phone Realtime ephemeral key broker, pairing required. |
| `POST /v1/voice/transcripts` | Desktop transcript ingress to the Architect lane. |
| `POST /v1/voice/phone/transcripts` | Phone transcript ingress to the Architect lane, pairing required. |
| `POST /v1/voice/audio-transcriptions` | Desktop bounded-audio transcription fallback. |
| `POST /v1/voice/diagnostics` | Desktop voice diagnostics journal. |
| `POST /v1/voice/phone/diagnostics` | Phone diagnostics journal, pairing required. |
| `GET /v1/voice/egress` and `POST /v1/voice/egress` | Mira/Architect reply queue for spoken playback. |
| `POST /v1/voice/realtime/session` | Contract-only SDP proxy placeholder; returns `501`. |

Upstream OpenAI endpoints used by the broker/client surfaces:

- `POST https://api.openai.com/v1/realtime/client_secrets`
- `POST https://api.openai.com/v1/realtime/calls`
- `POST https://api.openai.com/v1/audio/transcriptions`

Runtime files:

- `.squidrun/runtime/voice-broker.pid`
- `.squidrun/runtime/voice-broker.log`
- `.squidrun/runtime/voice-broker-status.json`
- `.squidrun/runtime/voice-transcripts.jsonl`
- `.squidrun/runtime/voice-diagnostics.jsonl`
- `.squidrun/runtime/voice-phone-pairing.json`

Current behavior:

- The default Realtime session model is `gpt-realtime-2`; the default voice is
  `marin`.
- Realtime live transcription uses `gpt-realtime-whisper`.
- Bounded/upload fallback transcription uses `gpt-4o-transcribe`.
- Realtime 2 session payloads include `reasoning.effort=low`; that field is
  only emitted for the current Realtime 2 default.
- Desktop and phone WebRTC clients request mic permission when the user starts
  or connects a visible session, but audio tracks are armed disabled. Tracks are
  enabled only while the user activates push/hold-to-talk.
- Desktop and phone surfaces visibly disclose that spoken Mira replies use
  AI-generated voice audio.
- Stop closes the data channel, peer connection, recorder, remote audio object,
  and media tracks. Mute disables local audio tracks and clears push-to-talk
  active state.
- Realtime model-generated generic replies are cancelled; Architect/Mira egress
  messages are the only text the voice mouth should speak.

## Official Model/API Fit

| Use Case | Current Fit | Local Default | Notes |
|---|---|---|---|
| Realtime voice conversation | Realtime API over WebRTC with `gpt-realtime-2` | `gpt-realtime-2` | Browser clients use `/v1/realtime/calls` with ephemeral credentials from `/v1/realtime/client_secrets`. |
| Realtime voice output | Realtime voices `marin` or `cedar` | `marin` | Official docs identify `marin` and `cedar` as high-quality Realtime voices. |
| Live input transcription | Realtime audio input transcription | `gpt-realtime-whisper` | Used inside `session.update.audio.input.transcription`. |
| Bounded/file transcription | Audio transcription endpoint | `gpt-4o-transcribe` | Used for fallback chunks or future uploaded clips, not as the live Realtime transcription model. |
| Realtime reasoning latency | Realtime 2 `reasoning.effort` | `low` | Official voice-agent guidance accepts `minimal`, `low`, `medium`, `high`, and `xhigh`, and says Realtime 2 voice agents should start with low effort for most production cases. |

## Policy And Acceptance Criteria

Voice is a standing trust scope with visible state, audit, and revocation. It is
not a hidden always-on listener.

Required defaults:

- Mic off before explicit user action.
- Text-only behavior unless voice is explicitly started.
- Push/hold-to-talk for capture by default.
- Redacted audit only; no durable raw audio by default.
- No TTS outside the active visible voice scope.
- Visible disclosure that spoken replies use AI-generated voice audio.
- One visible app session at most unless James explicitly chooses otherwise.

Capture acceptance:

- No audio track may transmit on connect.
- Desktop and phone sessions may request mic permission on explicit Connect or
  Start, but tracks must remain disabled until push/hold-to-talk.
- Releasing push/hold-to-talk disables tracks again.
- Mute disables tracks and clears push/hold active state.
- Stop/revoke closes streams, peer connections, data channels, recorders, and
  remote audio playback.

Routing acceptance:

- Voice transcripts enter the normal Mira/Architect ingress path.
- Direct pane writes remain disabled.
- Customer-facing, trading, money, auth, deploy, database, memory-promotion, and
  irreversible actions remain blocked from voice alone.
- Wrong profile/window/session, missing pairing, missing endpoint, stale scope,
  hidden/background capture, or missing visible stop/mute fails closed before
  capture or model calls whenever the condition is knowable locally.

Storage/privacy acceptance:

- Raw audio is ephemeral and not durably written by default.
- Transcript retention beyond normal ingress/audit requires explicit scope.
- Audit should include mode, model, endpoint, duration/bytes when available,
  storage choice, and profile/window/session/device/source scope without raw
  private content by default.
- Do not claim audio remains local after it is sent to OpenAI.
- Spoken Mira output must not claim actual consciousness, suffering, fear, love,
  or secret human identity.

## Remaining Blockers

- No live OpenAI or microphone experiment has been run for this lane.
- Restart/readiness approval is still required before the A/B voice lab.
- The `/v1/voice/realtime/session` SDP proxy is still a `501` contract-only
  placeholder; current WebRTC clients post SDP directly to OpenAI with an
  ephemeral key.
- Desktop still asks for microphone permission at visible session start, not at
  the first push-to-talk press. This is acceptable for the current pre-lab lane
  because tracks are disabled until push-to-talk, but a stricter future gate
  could defer `getUserMedia()` until the first hold action.
- Cost/token accounting and data-retention status are not surfaced in the voice
  UI yet.
- Raw audio retention, local transcript retention, diarization, and persistent
  standing voice scope remain out of scope until separately approved.

## Focused Test Contract

The current hygiene lane is covered by focused Jest tests for:

- Realtime 2 broker defaults and `reasoning.effort=low` payload shape.
- Official Realtime 2 reasoning effort enum handling for `minimal`, `low`,
  `medium`, `high`, and `xhigh`.
- Phone public config fallback to `gpt-realtime-2`.
- Phone live transcription model separation from bounded fallback
  transcription.
- Desktop WebRTC tracks armed disabled on connect, enabled only by
  push-to-talk pointer/keyboard hold, disabled again by release/cancel/mute, and
  stopped with Talk visual state cleared by Stop.
- Visible AI-generated voice disclosure on desktop and phone surfaces.
- Broker transcript, diagnostics, egress, pairing, and handler paths.

Focused command:

```powershell
npm test -- --runTestsByPath __tests__/voice-broker.test.js __tests__/phone-voice-client.test.js __tests__/voice-broker-tab.test.js __tests__/hm-voice-broker.test.js __tests__/hm-phone-voice.test.js __tests__/voice-broker-handlers.test.js
```

## Source Refs

- ORACLE #18: local SquidRun voice hygiene criteria and A/B lab blockers.
- OpenAI Realtime guide:
  `https://developers.openai.com/api/docs/guides/realtime`.
- OpenAI Realtime WebRTC guide:
  `https://developers.openai.com/api/docs/guides/realtime-webrtc`.
- OpenAI Realtime conversations guide:
  `https://developers.openai.com/api/docs/guides/realtime-conversations`.
- OpenAI Speech-to-text guide:
  `https://developers.openai.com/api/docs/guides/speech-to-text`.
- OpenAI `gpt-realtime-2` model page:
  `https://developers.openai.com/api/docs/models/gpt-realtime-2`.
