const {
  ENVELOPE_VERSION,
  buildOutboundMessageEnvelope,
  buildCanonicalEnvelopeMetadata,
  buildWebSocketDispatchMessage,
  buildTriggerFallbackDescriptor,
  buildSpecialTargetRequest,
} = require('../modules/comms/message-envelope');

const PROJECT_PATH = '<project-root>';

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
        name: 'squidrun',
        path: PROJECT_PATH,
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
        name: 'squidrun',
        path: PROJECT_PATH,
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
        name: 'squidrun',
        path: PROJECT_PATH,
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

  test('carries typed obligation declarations through every canonical metadata path', () => {
    const envelope = buildOutboundMessageEnvelope({
      message_id: 'hm-obligation-contract',
      session_id: 'app-session-480',
      timestamp_ms: 1784592000000,
      content: '(BUILDER #1): Verdict gate.',
      sender: { role: 'builder' },
      target: { raw: 'oracle', role: 'oracle', pane_id: '3' },
      expects: {
        class: 'verdict',
        staleness_class: 'turn',
        lease_id: 'lease-oracle-1',
      },
      fulfills: {
        obligation_id: `obl_${'a'.repeat(64)}`,
      },
    });

    expect(envelope.expects).toEqual({
      class: 'verdict',
      staleness_class: 'turn',
      lease_id: 'lease-oracle-1',
    });
    expect(envelope.fulfills).toEqual({
      obligation_id: `obl_${'a'.repeat(64)}`,
    });

    const metadata = buildCanonicalEnvelopeMetadata(envelope);
    expect(metadata.expects).toEqual(envelope.expects);
    expect(metadata.fulfills).toEqual(envelope.fulfills);
    expect(metadata.envelope.expects).toEqual(envelope.expects);
    expect(metadata.envelope.fulfills).toEqual(envelope.fulfills);
    expect(buildWebSocketDispatchMessage(envelope).metadata).toEqual(metadata);
    expect(buildTriggerFallbackDescriptor(envelope).metadata).toEqual(metadata);
    expect(buildSpecialTargetRequest(envelope).metadata).toEqual(metadata);
  });
});
