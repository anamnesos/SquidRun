const {
  ENVELOPE_VERSION,
  buildOutboundMessageEnvelope,
  buildCanonicalEnvelopeMetadata,
  buildWebSocketDispatchMessage,
  buildTriggerFallbackDescriptor,
  buildSpecialTargetRequest,
} = require('../modules/comms/message-envelope');

describe('message envelope contract', () => {
  test('builds canonical outbound envelope with required metadata fields', () => {
    const envelope = buildOutboundMessageEnvelope({
      message_id: 'hm-test-123',
      session_id: 'app-session-186',
      timestamp_ms: 1771464885594,
      priority: 'urgent',
      content: '(ARCHITECT #1): Test payload',
      sender: { role: 'architect' },
      target: { raw: 'builder', role: 'builder', pane_id: '2' },
      project: {
        name: 'hivemind',
        path: 'D:/projects/hivemind',
        session_id: 'app-session-186',
        source: 'link.json',
      },
    });

    expect(envelope).toMatchObject({
      version: ENVELOPE_VERSION,
      message_id: 'hm-test-123',
      session_id: 'app-session-186',
      timestamp_ms: 1771464885594,
      priority: 'urgent',
      content: '(ARCHITECT #1): Test payload',
      sender: { role: 'architect' },
      target: { raw: 'builder', role: 'builder', pane_id: '2' },
      project: {
        name: 'hivemind',
        path: 'D:/projects/hivemind',
        session_id: 'app-session-186',
        source: 'link.json',
      },
    });
    expect(typeof envelope.sent_at).toBe('string');
  });

  test('uses identical canonical metadata across ws, trigger fallback, and special-target paths', () => {
    const envelope = buildOutboundMessageEnvelope({
      message_id: 'hm-test-456',
      session_id: 'app-session-247',
      timestamp_ms: 1771470177338,
      priority: 'normal',
      content: '(BUILDER #2): Contract test payload',
      sender: { role: 'builder' },
      target: { raw: 'architect', role: 'architect', pane_id: '1' },
      project: {
        name: 'hivemind',
        path: 'D:/projects/hivemind',
        session_id: 'app-session-247',
        source: 'state.json',
      },
    });

    const canonicalMetadata = buildCanonicalEnvelopeMetadata(envelope);
    const wsPayload = buildWebSocketDispatchMessage(envelope, {
      target: 'architect',
      attempt: 1,
      maxAttempts: 3,
    });
    const triggerDescriptor = buildTriggerFallbackDescriptor(envelope);
    const specialRequest = buildSpecialTargetRequest(envelope);

    expect(wsPayload.metadata).toEqual(canonicalMetadata);
    expect(triggerDescriptor.metadata).toEqual(canonicalMetadata);
    expect(specialRequest.metadata).toEqual(canonicalMetadata);

    expect(wsPayload.messageId).toBe(envelope.message_id);
    expect(triggerDescriptor.messageId).toBe(envelope.message_id);
    expect(specialRequest.messageId).toBe(envelope.message_id);

    expect(specialRequest.senderRole).toBe(envelope.sender.role);
    expect(specialRequest.sessionId).toBe(envelope.session_id);
  });
});

