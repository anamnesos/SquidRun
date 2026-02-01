const { parseMessageSequence } = require('../modules/triggers');

describe('parseMessageSequence', () => {
  test('should parse standard format correctly', () => {
    const message = '(ANALYST #123): This is a test message.';
    const result = parseMessageSequence(message);
    expect(result).toEqual({
      seq: 123,
      sender: 'analyst',
      content: '(ANALYST): This is a test message.',
    });
  });

  test('should handle roles with hyphens', () => {
    const message = '(WORKER-A #45): Doing work.';
    const result = parseMessageSequence(message);
    expect(result).toEqual({
      seq: 45,
      sender: 'worker-a',
      content: '(WORKER-A): Doing work.',
    });
  });

  test('should fail to parse with extra spacing inside parentheses', () => {
    const message = '(  ARCHITECT   #  1 ):  Spaced out. ';
    const result = parseMessageSequence(message);
    expect(result).toEqual({
      seq: null,
      sender: null,
      content: '(  ARCHITECT   #  1 ):  Spaced out. ',
    });
  });

  test('should parse legacy format without sequence number', () => {
    const message = '(BACKEND): A legacy message.';
    const result = parseMessageSequence(message);
    expect(result).toEqual({
      seq: null,
      sender: 'backend',
      content: '(BACKEND): A legacy message.',
    });
  });

  test('should preserve newlines in content after parsing', () => {
    const message = '(FRONTEND #7):\nHere is a message\non multiple lines.';
    const result = parseMessageSequence(message);
    expect(result).toEqual({
      seq: 7,
      sender: 'frontend',
      content: '(FRONTEND): Here is a message\non multiple lines.',
    });
  });

  test('should return null for sender and seq for plain messages', () => {
    const message = 'This is just a plain message with no format.';
    const result = parseMessageSequence(message);
    expect(result).toEqual({
      seq: null,
      sender: null,
      content: 'This is just a plain message with no format.',
    });
  });

  test('should return null for sender and seq for malformed messages with wrong brackets', () => {
    const message = '[ANALYST #123]: Wrong brackets.';
    const result = parseMessageSequence(message);
    expect(result).toEqual({
      seq: null,
      sender: null,
      content: '[ANALYST #123]: Wrong brackets.',
    });
  });

  test('should not parse role with spaces when hash is missing', () => {
    const message = '(ANALYST 123): Missing hash.';
    const result = parseMessageSequence(message);
    expect(result).toEqual({
      seq: null,
      sender: null,
      content: '(ANALYST 123): Missing hash.',
    });
  });
  
  test('should handle empty message content after the colon', () => {
    const message = '(REVIEWER #99):';
    const result = parseMessageSequence(message);
    expect(result).toEqual({
      seq: 99,
      sender: 'reviewer',
      content: '(REVIEWER): ',
    });
  });

   test('should handle zero as a sequence number', () => {
    const message = '(INFRA #0): Sequence zero.';
    const result = parseMessageSequence(message);
    expect(result).toEqual({
      seq: 0,
      sender: 'infra',
      content: '(INFRA): Sequence zero.',
    });
  });

  test('should not parse a message without a colon', () => {
    const message = '(ANALYST #1)';
    const result = parseMessageSequence(message);
    expect(result).toEqual({
        seq: null,
        sender: null,
        content: '(ANALYST #1)',
    });
  });
});