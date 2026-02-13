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

function createTerminal({ lines, cursorY = 0, baseY = 0, themeForeground, scrollback, cols = 80 } = {}) {
  let onWriteParsedCb = null;
  return {
    cols,
    options: Object.assign(
      {},
      themeForeground ? { theme: { foreground: themeForeground } } : {},
      scrollback != null ? { scrollback } : {},
    ),
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
    registerMarker: jest.fn(() => {
      const disposeCallbacks = [];
      return {
        id: 'marker',
        onDispose: jest.fn((cb) => disposeCallbacks.push(cb)),
        _disposeCallbacks: disposeCallbacks,
      };
    }),
    registerDecoration: jest.fn(() => ({ dispose: jest.fn() })),
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

    // The reset decoration should cover from matchEnd to terminal.cols, not paddedLength or trimmedLength
    const resetDeco = decorations[1];
    expect(resetDeco.foregroundColor).toBe('#f0f0f0');
    expect(resetDeco.x).toBe(matchEnd);
    expect(resetDeco.width).toBe(80 - matchEnd);
  });

  test('disposes stale decorations when line agent color changes', () => {
    // Scenario: line 0 first has an analyst message, then is overwritten with an architect message
    const analystText = '(ANA #1): investigating issue';
    const archText = '(ARCH #2): delegating fix';
    const analystLine = createLine(analystText);
    const archLine = createLine(archText);

    const terminal = createTerminal({
      lines: { 0: analystLine },
      cursorY: 0,
      baseY: 0,
      themeForeground: '#f0f0f0',
    });

    attachAgentColors('1', terminal);

    // First write: analyst message decorated
    terminal.triggerWriteParsed();
    const firstCallCount = terminal.registerDecoration.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Collect decorations created in the first pass
    const firstDecos = terminal.registerDecoration.mock.results
      .slice(0, firstCallCount)
      .map(r => r.value);

    // Overwrite line 0 with architect message — cursor stays at line 0
    terminal.buffer.active.getLine.mockImplementation((y) => y === 0 ? archLine : null);
    // Cursor hasn't advanced — but the content changed.
    // Simulate a new write (e.g. terminal clear + rewrite on same line)
    // Force rescan by resetting baseY+cursorY to trigger the backward-jump path
    terminal.buffer.active.cursorY = 0;
    terminal.buffer.active.baseY = 0;

    // We need lastScannedLine to allow rescanning line 0.
    // The backward-jump detection triggers when (currentLine+1) < lastScannedLine.
    // After first scan, lastScannedLine = 1, currentLine = 0: (0+1) < 1 is false.
    // So the guard returns early. But in real terminal behavior, a clear/reset
    // would set currentLine below lastScannedLine significantly.
    // Simulate a buffer clear: move cursor way back.
    // Not needed for this test — the fix works at the lineDecorations tracking level.
    // The real scenario is the same line being scanned again after a reset.

    // Instead, test the tracking directly: simulate a full rescan by lowering baseY
    // to trigger backward jump
    terminal.buffer.active.baseY = 0;
    terminal.buffer.active.cursorY = 0;
    // Actually we need (currentLine+1) < lastScannedLine. currentLine=0, lastScannedLine=1.
    // 1 < 1 is false. We need lastScannedLine > 1.
    // Advance cursor to line 1 first, then back to 0.
    terminal.buffer.active.cursorY = 1;
    terminal.triggerWriteParsed(); // scan line 1 (empty), lastScannedLine = 2
    terminal.buffer.active.cursorY = 0;
    // Now currentLine=0, lastScannedLine=2. (0+1) < 2 is true → resync to 0.
    terminal.triggerWriteParsed();

    // Old analyst decorations should have been disposed
    for (const d of firstDecos) {
      if (d && d.dispose) {
        expect(d.dispose).toHaveBeenCalled();
      }
    }

    // New architect decorations should have been created
    const allDecos = terminal.registerDecoration.mock.calls.map((call) => call[0]);
    const archDeco = allDecos.find(d => d.foregroundColor === AGENT_COLORS.architect);
    expect(archDeco).toBeDefined();
  });

  test('does NOT create duplicate decorations when cursor stays on same line', () => {
    const text = '(ANA #1): same line, no new output';
    const terminal = createTerminal({
      lines: { 0: createLine(text) },
      cursorY: 0,
      baseY: 0,
    });

    attachAgentColors('5', terminal);

    // First callback — should create decorations
    terminal.triggerWriteParsed();
    const countAfterFirst = terminal.registerDecoration.mock.calls.length;
    expect(countAfterFirst).toBeGreaterThan(0);

    // Second callback with same cursor position — should NOT create more
    terminal.triggerWriteParsed();
    const countAfterSecond = terminal.registerDecoration.mock.calls.length;
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  test('reset decoration covers full terminal width to prevent bleed on appended text', () => {
    // Scenario: tag is written first, then more text appends to the same line.
    // The reset decoration should cover from matchEnd to terminal.cols from the start,
    // so no brief color flash occurs before the rescan.
    const tagOnly = '(ARCH #1): ';
    const terminal = createTerminal({
      lines: { 0: createLine(tagOnly) },
      cursorY: 0,
      baseY: 0,
      cols: 120,
      themeForeground: '#e0e0e0',
    });

    attachAgentColors('1', terminal);
    terminal.triggerWriteParsed();

    const decorations = terminal.registerDecoration.mock.calls.map((call) => call[0]);
    const matchEnd = tagOnly.indexOf('(ARCH #1):') + '(ARCH #1):'.length;

    // Reset decoration should use terminal.cols, not contentLen
    const resetDeco = decorations.find(d => d.foregroundColor === '#e0e0e0');
    expect(resetDeco).toBeDefined();
    expect(resetDeco.x).toBe(matchEnd);
    expect(resetDeco.width).toBe(120 - matchEnd);  // cols - matchEnd, NOT contentLen - matchEnd
  });

  test('disposes stale continuation decorations when layout shifts', () => {
    // Scenario: line 0 has agent tag, line 1 is wrapped continuation.
    // New output arrives on line 2, causing a rescan of lines 1-2.
    // Line 1 is no longer wrapped (content changed) — its old continuation
    // decoration should be disposed, not left to flash briefly.
    const line0 = '(ARCH #1): a message that wraps to the next line';
    const line1 = 'wrapped continuation text';
    const terminal = createTerminal({
      lines: {
        0: createLine(line0, false),
        1: createLine(line1, true),
      },
      cursorY: 1,
      baseY: 0,
      themeForeground: '#d0d0d0',
    });

    attachAgentColors('1', terminal);
    terminal.triggerWriteParsed();

    // Find the continuation decoration (foreground reset on line 1)
    const contDeco = terminal.registerDecoration.mock.results.find((r, i) => {
      const call = terminal.registerDecoration.mock.calls[i][0];
      return call.foregroundColor === '#d0d0d0' && call.x === 0 && call.width === line1.length;
    });
    expect(contDeco).toBeDefined();
    const contDecoObj = contDeco.value;

    // Now simulate new output: line 1 is no longer wrapped, line 2 is new content.
    // Buffer clear triggers full rescan.
    const newLine1 = createLine('new independent line', false); // no longer isWrapped
    const newLine2 = createLine('(DEVOPS #1): new output', false);
    terminal.buffer.active.getLine.mockImplementation((y) => {
      if (y === 0) return createLine(line0, false);
      if (y === 1) return newLine1;
      if (y === 2) return newLine2;
      return null;
    });
    // Move cursor forward then back to trigger backward-jump rescan
    terminal.buffer.active.cursorY = 3;
    terminal.triggerWriteParsed(); // lastScannedLine advances
    terminal.buffer.active.cursorY = 0;
    terminal.triggerWriteParsed(); // backward jump → full rescan

    // The old continuation decoration should have been disposed
    expect(contDecoObj.dispose).toHaveBeenCalled();
  });
});
