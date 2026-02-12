const { attachAgentColors, AGENT_COLORS } = require('../modules/terminal/agent-colors');

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

function createLine(text, isWrapped = false, { trimmedLength } = {}) {
  return {
    translateToString: jest.fn().mockReturnValue(text),
    getTrimmedLength: jest.fn().mockReturnValue(trimmedLength != null ? trimmedLength : text.length),
    length: text.length,
    isWrapped,
  };
}

function createTerminal({ lines, cursorY = 0, baseY = 0, themeForeground } = {}) {
  let onWriteParsedCb = null;
  return {
    options: themeForeground ? { theme: { foreground: themeForeground } } : {},
    onWriteParsed: jest.fn((cb) => {
      onWriteParsedCb = cb;
      return { dispose: jest.fn() };
    }),
    buffer: {
      active: {
        baseY,
        cursorY,
        getLine: jest.fn((y) => lines[y] || null),
      },
    },
    registerMarker: jest.fn(() => ({ id: 'marker' })),
    registerDecoration: jest.fn(),
    triggerWriteParsed: () => onWriteParsedCb && onWriteParsedCb(),
  };
}

describe('agent-colors', () => {
  test('adds explicit foreground reset after matched tag', () => {
    const text = '[AGENT MSG] (ANA #12): investigating rendering bug';
    const terminal = createTerminal({
      lines: { 0: createLine(text) },
      themeForeground: '#f5f5f5',
    });

    attachAgentColors('5', terminal);
    terminal.triggerWriteParsed();

    const decorations = terminal.registerDecoration.mock.calls.map((call) => call[0]);
    const matchStart = text.indexOf('(ANA #12):');
    const matchWidth = '(ANA #12):'.length;

    expect(decorations[0]).toMatchObject({
      foregroundColor: AGENT_COLORS.analyst,
      x: matchStart,
      width: matchWidth,
      height: 1,
    });
    expect(decorations[1]).toMatchObject({
      foregroundColor: '#f5f5f5',
      x: matchStart + matchWidth,
      height: 1,
    });
  });

  test('resets wrapped continuation lines for matched messages', () => {
    const line0 = '[AGENT MSG] (ANA #2): long message that wraps';
    const line1 = 'continuation line';
    const terminal = createTerminal({
      lines: {
        0: createLine(line0, false),
        1: createLine(line1, true),
      },
      cursorY: 1,
      themeForeground: '#d0d0d0',
    });

    attachAgentColors('5', terminal);
    terminal.triggerWriteParsed();

    const decorations = terminal.registerDecoration.mock.calls.map((call) => call[0]);
    expect(decorations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          foregroundColor: '#d0d0d0',
          x: 0,
          width: line1.length,
          height: 1,
        }),
      ])
    );
  });

  test('uses fallback foreground when terminal theme color is unavailable', () => {
    const text = '[AGENT MSG] (ANA #3): no theme foreground set';
    const terminal = createTerminal({
      lines: { 0: createLine(text) },
    });

    attachAgentColors('5', terminal);
    terminal.triggerWriteParsed();

    const decorations = terminal.registerDecoration.mock.calls.map((call) => call[0]);
    const resetDecoration = decorations.find((item) => item.x === text.indexOf('(ANA #3):') + '(ANA #3):'.length);
    expect(resetDecoration.foregroundColor).toBe('#e8eaf0');
  });

  test('does not place reset decorations beyond currentLine', () => {
    // Scenario: agent tag on line 0, wrapped line at 1, but cursor is at line 0
    // (simulates cursor moved up while wrapped lines exist below)
    const line0 = '(ANA #5): message that wraps to next row';
    const line1 = 'wrapped beyond cursor';
    const terminal = createTerminal({
      lines: {
        0: createLine(line0, false),
        1: createLine(line1, true),
      },
      cursorY: 0,  // cursor on line 0 — line 1 is beyond currentLine
      baseY: 0,
      themeForeground: '#d0d0d0',
    });

    attachAgentColors('5', terminal);
    terminal.triggerWriteParsed();

    const markerOffsets = terminal.registerMarker.mock.calls.map((call) => call[0]);
    // All markers should be at offset 0 (on line 0). No positive offsets (beyond cursor).
    for (const offset of markerOffsets) {
      expect(offset).toBeLessThanOrEqual(0);
    }
  });

  test('uses trimmed content width instead of full line.length', () => {
    // Line has trailing whitespace — trimmedLength is shorter than line.length
    const text = '(DEVOPS #1): short msg';
    const paddedLength = 80;  // terminal column width with trailing blanks
    const line = createLine(text, false, { trimmedLength: text.length });
    // Override line.length to simulate terminal padding
    line.length = paddedLength;

    const terminal = createTerminal({
      lines: { 0: line },
      cursorY: 0,
      baseY: 0,
      themeForeground: '#f0f0f0',
    });

    attachAgentColors('2', terminal);
    terminal.triggerWriteParsed();

    const decorations = terminal.registerDecoration.mock.calls.map((call) => call[0]);
    const tagMatch = '(DEVOPS #1):';
    const matchEnd = text.indexOf(tagMatch) + tagMatch.length;

    // The color decoration width should be based on trimmed length, not paddedLength
    const colorDeco = decorations[0];
    expect(colorDeco.foregroundColor).toBe(AGENT_COLORS.devops);
    expect(colorDeco.width).toBe(Math.min(tagMatch.length, text.length - text.indexOf(tagMatch)));

    // The reset decoration should cover from matchEnd to trimmed length, not paddedLength
    const resetDeco = decorations[1];
    expect(resetDeco.foregroundColor).toBe('#f0f0f0');
    expect(resetDeco.x).toBe(matchEnd);
    expect(resetDeco.width).toBe(text.length - matchEnd);
  });
});
