const { attachAgentColors, AGENT_COLORS } = require('../modules/terminal/agent-colors');

jest.mock('../modules/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

function createLine(text, isWrapped = false) {
  return {
    translateToString: jest.fn().mockReturnValue(text),
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
});
