# Team Room

Team Room gives the human and the three SquidRun seats one shared project
conversation in a browser. It is part of the local SquidRun process; it is not
a hosted chat service.

## Open the room

1. Start SquidRun and select the project.
2. Choose **Team Room** in the desktop header.
3. Open the displayed local address in a browser on the same trusted network.
4. Pair each browser once with the six-digit code shown by SquidRun.

After pairing, a message in the room is routed to the configured agent seats.
Each reply is posted back into the same thread with its role identity.

## Network boundary

The default listener is local-network only. Remote access requires a private
network or proxy that you configure and trust. Do not expose the listener to the
public internet or forward a pairing code to an untrusted device.

## Verification

Infrastructure status alone is not an end-to-end acceptance test. The useful
check is one real message from the paired browser reaching the intended seats,
followed by their visible replies in the room.

Relevant implementation and tests:

- `ui/modules/main/team-room-runtime.js`
- `ui/modules/main/team-room-auth.js`
- `ui/modules/main/team-room-pane-delivery.js`
- `ui/__tests__/team-room-service-integration.test.js`
- `ui/__tests__/team-room-pane-delivery.test.js`
