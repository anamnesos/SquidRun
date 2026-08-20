'use strict';

const { buildActivationPrompt } = require('./team-room-contracts');

class TeamRoomDeliveryAdapter {
  constructor(options = {}) {
    if (!options.store) throw new Error('team_room_delivery_store_required');
    if (typeof options.deliverToPane !== 'function') throw new Error('team_room_deliver_to_pane_required');
    this.store = options.store;
    this.deliverToPane = options.deliverToPane;
  }

  async dispatchSafeBoundary(targetMemberId, options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
    const delivered = [];
    const failed = [];
    for (let index = 0; index < limit; index += 1) {
      const claimed = this.store.claimActivationBatch(targetMemberId, {
        roomId: options.roomId,
        profileName: options.profileName,
        limit: 1,
      });
      if (!claimed.ok) return { ok: false, reason: claimed.reason, delivered, failed };
      if (claimed.fused || claimed.activations.length === 0) {
        return { ok: failed.length === 0, fused: claimed.fused, delivered, failed };
      }
      const payload = claimed.activations[0];
      const deliverable = this.store.isActivationDeliverable(payload.activation.activationId);
      if (!deliverable.ok) {
        failed.push({ activationId: payload.activation.activationId, reason: deliverable.reason });
        break;
      }
      const prompt = buildActivationPrompt({
        messageId: payload.message.messageId,
        authorId: payload.message.authorId,
        replyToMessageId: payload.message.replyToMessageId,
        rootMessageId: payload.message.rootMessageId,
        body: payload.message.body,
        attachments: payload.attachments,
      });
      if (!prompt.ok) {
        this.store.markActivationFailed(payload.activation.activationId, prompt.reason);
        failed.push({ activationId: payload.activation.activationId, reason: prompt.reason });
        break;
      }
      try {
        const member = this.store.getMember(
          payload.activation.targetMemberId,
          payload.activation.roomId,
          payload.activation.profileName
        );
        const result = await this.deliverToPane({
          member,
          activation: payload.activation,
          message: payload.message,
          attachments: payload.attachments,
          prompt: prompt.prompt,
          envelope: prompt.envelope,
        });
        if (!result || result.ok !== true) throw new Error(result?.reason || 'pane_delivery_unconfirmed');
        const marked = this.store.markActivationDelivered(payload.activation.activationId);
        if (!marked.ok) throw new Error(marked.reason);
        delivered.push(payload.activation.activationId);
      } catch (err) {
        this.store.markActivationFailed(payload.activation.activationId, err.message);
        failed.push({ activationId: payload.activation.activationId, reason: err.message });
        break;
      }
    }
    return { ok: failed.length === 0, fused: false, delivered, failed };
  }
}

module.exports = { TeamRoomDeliveryAdapter };
