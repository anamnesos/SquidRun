# SquidRun Cross-Device Architecture (As-Built)

This document outlines the architecture for cross-device agent coordination in SquidRun. It enables two separate SquidRun instances on different machines to communicate via a central relay, specifically focusing on Architect-to-Architect coordination.

---

## 1. Component Map

### 1.1 Relay Server (`relay/server.js`)
A minimal WebSocket server that acts as a message broker between devices.
- **Responsibilities:** Device registration, connection management, message routing, and acknowledgment (ACK) handling.
- **State:** Purely in-memory; no persistence of messages or client lists across restarts.

### 1.2 Bridge Client (`ui/modules/bridge-client.js`)
The bridge layer within the SquidRun app that communicates with the Relay Server.
- **Responsibilities:** Managing the WebSocket connection to the relay, authenticating via shared secret, sending outbound messages to other devices, and receiving inbound messages.
- **Features:** Automatic reconnection with exponential backoff, message ACK tracking with timeouts.

### 1.3 Cross-Device Target Parser (`ui/modules/cross-device-target.js`)
Utility for identifying and validating cross-device message targets.
- **Responsibilities:** Normalizing device IDs and parsing the `@DEVICE-arch` target syntax.
- **Enforcement:** Restricts cross-device communication to the `architect` role only.

### 1.4 App Integration (`ui/modules/main/squidrun-app.js`)
The central coordinator within the SquidRun daemon.
- **Responsibilities:** Initializing the Bridge Client, routing local WebSocket messages to the bridge, and injecting inbound bridge messages into the local Architect pane.
- **Logging:** Records inbound and outbound bridge messages in the `comms_journal` (Evidence Ledger).

### 1.5 CLI Routing (`ui/scripts/hm-send.js`)
The command-line tool used by agents to send messages.
- **Responsibilities:** Detecting `@DEVICE-arch` targets, disabling local trigger-file fallbacks for cross-device sends, and dispatching messages to the local app's WebSocket bus.

---

## 2. Message Flow

### 2.1 Outbound Flow (Local Agent -> Remote Architect)
1. **Agent Call:** An agent runs `node hm-send.js @REMOTE-arch "Message"`.
2. **Parser Detection:** `hm-send.js` uses `cross-device-target.js` to identify the target as a bridge target.
3. **Local Dispatch:** `hm-send.js` sends the message to the local SquidRun daemon via the standard WebSocket bus (`port 9900`).
4. **Bridge Routing:** `squidrun-app.js` receives the message, identifies the `@REMOTE-arch` target, and hands it to `bridge-client.js`.
5. **Relay Transmission:** The `bridge-client.js` sends an `xsend` frame to the Relay Server.
6. **Relay Delivery:** The Relay Server finds the socket for `REMOTE` and sends an `xdeliver` frame.
7. **ACK Chain:** The remote device ACKs back to the relay, which forwards it to the sender's bridge client, fulfilling the local `hm-send` request.

### 2.2 Inbound Flow (Remote Architect -> Local Architect)
1. **Relay Receipt:** The Relay Server receives an `xsend` targeting the local `deviceId`.
2. **Bridge Receipt:** The local `bridge-client.js` receives an `xdeliver` frame from the relay.
3. **App Handling:** The `bridge-client.js` triggers the `onMessage` callback in `squidrun-app.js`.
4. **Journaling:** `squidrun-app.js` records the inbound message in the Evidence Ledger.
5. **Pane Injection:** The message is formatted as `[Bridge from DEVICE]: Message` and injected directly into the Architect (Pane 1) PTY via `triggers.sendDirectMessage`.
6. **ACK:** The `bridge-client.js` sends an `xack` back to the relay to confirm receipt.

---

## 3. Configuration & Environment Variables

### 3.1 Relay Server Env Vars
- `RELAY_SHARED_SECRET`: (Required) The password required for devices to register.
- `PORT`: (Default: `8788`) The port the relay listens on.
- `HOST`: (Default: `0.0.0.0`) The host interface.
- `RELAY_PENDING_TTL_MS`: (Default: `20000`) Timeout for pending message ACKs.

### 3.2 SquidRun App Env Vars
- `SQUIDRUN_CROSS_DEVICE`: Set to `1` to enable the bridge.
- `SQUIDRUN_DEVICE_ID`: (Required) A unique alphanumeric ID for this machine (e.g., `LAPTOP-01`).
- `SQUIDRUN_RELAY_URL`: (Required) The `ws://` or `wss://` URL of the relay server.
- `SQUIDRUN_RELAY_SECRET`: (Required) Must match the relay's `RELAY_SHARED_SECRET`.

---

## 4. Security Model

- **Shared Secret Authentication:** Devices must provide the correct `SQUIDRUN_RELAY_SECRET` to register with the relay. Connections without a valid secret are closed immediately.
- **Device ID Binding:** The relay binds each socket to a specific `deviceId` during registration. It prevents "spoofing" by ensuring the `fromDevice` field in messages matches the socket's registered ID.
- **Architect-Only Gating:** The target parser only accepts `@DEVICE-arch` (or `@DEVICE-architect`). This prevents remote agents from directly messaging local Builders or Oracles, ensuring the Architect remains the single point of coordination.
- **No Persistence:** Messages are transient and never stored on the relay server's disk, minimizing the impact of a relay server breach.
- **Trusted Relay Model:** Communication currently relies on the security of the relay server and the shared secret. Traffic is not end-to-end encrypted (E2EE) beyond the transport layer (TLS if `wss://` is used).

---

## 5. Known Gaps & Future Hardening

Based on initial audits, the following gaps exist:
1. **No Automated Tests:** Cross-device flows lack comprehensive integration tests.
2. **No Redaction:** Inbound/outbound messages (especially screenshots or logs) are not automatically scrubbed for secrets.
3. **No Device Allowlist:** The relay accepts any device with the shared secret; there is no secondary allowlist of approved `deviceIds`.
4. **Relay Role Enforcement:** While the local app enforces Arch-to-Arch, the relay server itself does not currently validate the `fromRole` or `targetRole` fields.
5. **Inbound Replay Guard:** No mechanism to prevent replaying a valid captured bridge frame.
6. **UI Visibility:** No status indicator in the SquidRun UI to show if the relay is connected or if a bridge message was successfully sent/received.
