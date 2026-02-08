const { parseMessageSequence } = require('../modules/triggers');

describe('parseMessageSequence prefix handling', () => {
  const AGENT_MESSAGE_PREFIX = '[AGENT MSG - reply via hm-send.js] ';

  test('prefixed message parses correctly after strip', () => {
    const message = `${AGENT_MESSAGE_PREFIX}(ANALYST #123): This is a test message.`;
    const result = parseMessageSequence(message);
    expect(result.seq).toBe(123);
    expect(result.sender).toBe('analyst');
    expect(result.content).toBe('(ANALYST): This is a test message.');
  });

  test('prefixed message without sequence number parses sender', () => {
    const message = `${AGENT_MESSAGE_PREFIX}(DEVOPS): Status update.`;
    const result = parseMessageSequence(message);
    expect(result.seq).toBeNull();
    expect(result.sender).toBe('devops');
    expect(result.content).toBe('(DEVOPS): Status update.');
  });

  test('standard message still parses correctly', () => {
    const message = '(ANALYST #123): This is a test message.';
    const result = parseMessageSequence(message);
    expect(result.seq).toBe(123);
    expect(result.sender).toBe('analyst');
  });

  test('non-agent message passes through unchanged', () => {
    const message = 'Just a regular message with no prefix.';
    const result = parseMessageSequence(message);
    expect(result.seq).toBeNull();
    expect(result.sender).toBeNull();
    expect(result.content).toBe(message);
  });
});
