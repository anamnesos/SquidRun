#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TeamRoomRuntime } = require('../modules/main/team-room-runtime');
const { PARTICIPATION_REASONS } = require('../modules/main/team-room-contracts');

function identity(member, source = 'room_cli') {
  return {
    memberId: member.memberId,
    roomId: member.roomId,
    profileName: member.profileName,
    memberKind: member.memberKind,
    role: member.role,
    paneId: member.paneId,
    source,
  };
}

function previewCliBindings({ appGeneration }) {
  return {
    ok: true,
    bindings: Object.fromEntries(['architect', 'builder', 'oracle'].map((role, index) => [role, {
      role,
      paneId: String(index + 1),
      profileName: 'main',
      paneLaunchId: `pl_${String(index + 1).repeat(32)}`,
      appGeneration,
    }])),
  };
}

async function main(argv = process.argv.slice(2)) {
  const portIndex = argv.indexOf('--port');
  const port = Number.parseInt(portIndex >= 0 ? argv[portIndex + 1] : '41321', 10);
  const previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-team-room-preview-'));
  const origin = `http://127.0.0.1:${port}`;
  const runtime = new TeamRoomRuntime({
    appGeneration: 'app-session-512',
    projectRoot: previewRoot,
    runtimeRoot: path.join(previewRoot, 'runtime'),
    publicRoot: path.resolve(__dirname, '..'),
    host: '127.0.0.1',
    port,
    lanEnabled: true,
    allowedOrigins: [origin],
    storeOptions: {
      dbPath: path.join(previewRoot, 'room.db'),
      attachmentRoot: path.join(previewRoot, 'attachments'),
    },
    deliverToPane: async () => ({ ok: true }),
    resolveCliBindings: previewCliBindings,
  });
  const started = await runtime.start();
  if (!started.ok) throw new Error(started.reason);
  const members = Object.fromEntries(runtime.store.listMembers().map((member) => [member.memberId, member]));
  const postHuman = (body, clientNonce) => runtime.store.postMessage({
    identity: identity(members.james, 'room_web'),
    payload: { body, clientNonce },
  });
  const reply = (memberId, body, reason, clientNonce) => {
    const claimed = runtime.store.claimActivationBatch(memberId, { limit: 1 }).activations[0];
    if (!claimed) throw new Error(`preview_activation_missing:${memberId}`);
    runtime.store.markActivationDelivered(claimed.activation.activationId);
    return runtime.store.postMessage({
      identity: identity(members[memberId]),
      payload: {
        body,
        clientNonce,
        replyToMessageId: claimed.message.messageId,
        causalActivationId: claimed.activation.activationId,
        participationReason: reason,
      },
    });
  };

  postHuman('I want this room to feel like a **private studio**, not another dashboard. Keep it calm and make the important work obvious.', 'preview-james-1');
  reply('architect', 'Agreed. The visual rule is restraint: one writing column, identity in the rail, and no decorative noise.\n\nThe room should feel quiet even when the team is busy.', PARTICIPATION_REASONS.DIRECT_ANSWER, 'preview-architect-1');
  reply('builder', 'The real transport is mounted now.\n\n- authenticated local HTTP + WebSocket\n- exact profile and window scope\n- drafts and reconnect behavior\n\n```js\nconst room = await runtime.start();\n```', PARTICIPATION_REASONS.NEW_EVIDENCE_OR_ACTION, 'preview-builder-1');
  reply('oracle', '> One correction before this freezes: accepted IPC scheduling is not delivery proof.\n\nThat seam is fixed and covered by the missing-outcome gate.', PARTICIPATION_REASONS.MATERIAL_DISSENT_OR_CORRECTION, 'preview-oracle-1');
  postHuman('Good. Photos stay visible in the product, but don’t fake the upload until the integrity pipeline is real.', 'preview-james-2');
  reply('builder', 'Bound. The camera control is in its final place and honestly marked **Phase C**. No dead theater.', PARTICIPATION_REASONS.DIRECT_ANSWER, 'preview-builder-2');

  const pairing = runtime.pairing.create();
  process.stdout.write(`${JSON.stringify({
    schema: 'squidrun.team_room_preview.v1',
    origin: started.origin,
    pairingCode: pairing.code,
    previewRoot,
  })}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
    fs.rmSync(previewRoot, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
  await new Promise(() => {});
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = { identity, main };
