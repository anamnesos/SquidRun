# SquidRun Relay (Phase 1 MVP)

Minimal WebSocket relay for cross-device SquidRun Architect-to-Architect messaging.

## Env Vars

- `RELAY_SHARED_SECRET` (required)
- `PORT` (default: `8788`)
- `HOST` (default: `0.0.0.0`)
- `RELAY_PENDING_TTL_MS` (default: `20000`)

## Run

```bash
cd relay
npm install
npm start
```

## Frames

- `register`: `{ type, deviceId, sharedSecret }`
- `xsend`: `{ type, messageId, fromDevice, toDevice, content, fromRole? }`
- `xdeliver`: relay -> target device
- `xack`: target -> relay -> sender

This is an in-memory MVP relay. No persistence.
