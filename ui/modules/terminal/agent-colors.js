/**
 * Agent message color indicators for xterm.js terminals
 * Uses xterm.js v6 decoration API to color-code agent message tags
 */

const log = require('../logger');

// Agent role colors (#RRGGBB format required by xterm.js decorations)
const AGENT_COLORS = {
  architect: '#FF9500',  // Orange
  builder:   '#00BCD4',  // Cyan
  oracle:    '#AB47BC',  // Purple
  generic:   '#888888',  // Gray
};

// Patterns to match agent message tags and their colors
// Order matters — first match wins per line
const AGENT_PATTERNS = [
  { pattern: /\(ARCH\s*#\d+\):/,           color: AGENT_COLORS.architect },
  { pattern: /\(BUILDER\s*#\d+\):/,        color: AGENT_COLORS.builder },
  { pattern: /\(ORACLE\s*#\d+\):/,         color: AGENT_COLORS.oracle },
  { pattern: /\[MSG from architect\]/i,     color: AGENT_COLORS.architect },
  { pattern: /\[MSG from builder\]/i,       color: AGENT_COLORS.builder },
  { pattern: /\[MSG from oracle\]/i,        color: AGENT_COLORS.oracle },
  { pattern: /\[AGENT MSG[^\]]*\]/,         color: AGENT_COLORS.generic },
];

const DEFAULT_FOREGROUND = '#e8eaf0';

/**
 * Attach agent message color decorations to a terminal instance.
 * Listens for new writes and scans new lines for agent message patterns,
 * applying foreground color decorations to matching tags.
 *
 * @param {string} paneId - The pane identifier
 * @param {import('@xterm/xterm').Terminal} terminal - The xterm Terminal instance
 * @returns {import('@xterm/xterm').IDisposable} Disposable to detach the listener
 */
function attachAgentColors(paneId, terminal) {
  if (!terminal.onWriteParsed) {
    log.warn(`AgentColors ${paneId}`, 'onWriteParsed not available, skipping');
    return { dispose: () => {} };
  }

  let lastScannedLine = 0;
  // Track decorations per absolute line so we can dispose stale ones on rescan
  const lineDecorations = new Map(); // lineNumber → { color, disposables[], continuationLines[] }

  /**
   * Dispose all tracked decorations for a given line and remove from the map.
   */
  function disposeLineDecorations(lineNum) {
    const entry = lineDecorations.get(lineNum);
    if (!entry) return;
    for (const d of entry.disposables) {
      try { d.dispose(); } catch { /* already disposed */ }
    }
    // Also dispose any continuation-line entries that were tracked under this origin
    if (entry.continuationLines) {
      for (const contLine of entry.continuationLines) {
        const contEntry = lineDecorations.get(contLine);
        if (contEntry && contEntry.originLine === lineNum) {
          for (const d of contEntry.disposables) {
            try { d.dispose(); } catch { /* already disposed */ }
          }
          lineDecorations.delete(contLine);
        }
      }
    }
    lineDecorations.delete(lineNum);
  }

  /**
   * Ensure wrapped continuation lines have reset decorations to prevent color bleed.
   */
  function updateContinuationLines(originLineNum, currentLineNum, entry, defaultForeground) {
    const buf = terminal.buffer?.active;
    if (!buf) return;

    let continuationLine = originLineNum + 1;
    while (continuationLine <= currentLineNum) {
      const wrappedLine = buf.getLine(continuationLine);
      if (!wrappedLine || wrappedLine.isWrapped !== true) break;

      // Skip if already decorated for this origin
      const existingCont = lineDecorations.get(continuationLine);
      if (existingCont && existingCont.originLine === originLineNum) {
        continuationLine++;
        continue;
      }

      // Dispose any stale decorations from a different origin or previous state
      if (existingCont) {
        for (const d of existingCont.disposables) {
          try { d.dispose(); } catch { /* already disposed */ }
        }
        lineDecorations.delete(continuationLine);
      }

      const wrappedOffset = continuationLine - (buf.baseY + buf.cursorY);
      const wrappedMarker = terminal.registerMarker(wrappedOffset);
      if (wrappedMarker) {
        const wrappedDeco = terminal.registerDecoration({
          marker: wrappedMarker,
          foregroundColor: defaultForeground,
          x: 0,
          width: terminal.cols || 80,
          height: 1,
          layer: 'top',
        });
        if (wrappedDeco) {
          wrappedMarker.onDispose(() => wrappedDeco.dispose());
          lineDecorations.set(continuationLine, {
            color: '_continuation',
            originLine: originLineNum,
            disposables: [wrappedDeco],
          });
          if (entry.continuationLines && !entry.continuationLines.includes(continuationLine)) {
            entry.continuationLines.push(continuationLine);
          }
        }
      }
      continuationLine += 1;
    }
  }

  const disposable = terminal.onWriteParsed(() => {
    const buf = terminal.buffer?.active;
    if (!buf) return;
    const currentLine = buf.baseY + buf.cursorY;
    const defaultForeground = terminal?.options?.theme?.foreground || DEFAULT_FOREGROUND;

    // Nothing new to scan — only reset on true backward jump (clear/reset),
    // not when cursor stays on the same line between callbacks
    if ((currentLine + 1) < lastScannedLine) {
      // Buffer was cleared or reset — dispose all tracked decorations and resync
      for (const entry of lineDecorations.values()) {
        for (const d of entry.disposables) {
          try { d.dispose(); } catch { /* already disposed */ }
        }
      }
      lastScannedLine = 0;
      lineDecorations.clear();
    }
    if (currentLine < lastScannedLine) return;

    // Evict tracked lines that have scrolled out of the scrollback buffer
    const minLine = buf.baseY - (terminal.options?.scrollback || 1000);
    for (const ln of lineDecorations.keys()) {
      if (ln < minLine) lineDecorations.delete(ln);
    }

    // Determine scan start, backing up to the nearest non-wrapped line
    // to ensure we always find the agent tag for wrapped messages.
    let scanStart = lastScannedLine;
    while (scanStart > 0) {
      const line = buf.getLine(scanStart);
      if (!line || !line.isWrapped) break;
      scanStart--;
    }

    // Scan from scanStart to currentLine (inclusive)
    for (let y = scanStart; y <= currentLine; y++) {
      const line = buf.getLine(y);
      if (!line) continue;

      // If this line is a continuation line that already has decorations
      // from a previous origin, dispose them — the origin will re-apply if needed
      const existingCont = lineDecorations.get(y);
      if (existingCont && existingCont.originLine != null) {
        for (const d of existingCont.disposables) {
          try { d.dispose(); } catch { /* already disposed */ }
        }
        lineDecorations.delete(y);
      }

      const text = line.translateToString(true);
      if (!text) continue;

      for (const { pattern, color } of AGENT_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          // If this line already has decorations with the same color and
          // content hasn't grown, check for new continuation lines but skip re-decorating origin.
          const existing = lineDecorations.get(y);
          const contentLen = typeof line.getTrimmedLength === 'function'
            ? line.getTrimmedLength() : line.translateToString(false).length;

          if (existing && existing.color === color && contentLen <= existing.contentLen) {
            updateContinuationLines(y, currentLine, existing, defaultForeground);
            break;
          } else if (existing) {
            // Dispose stale decorations (different agent or content grew)
            disposeLineDecorations(y);
          }

          const disposables = [];
          const continuationLines = [];
          try {
            const offset = y - (buf.baseY + buf.cursorY);
            const marker = terminal.registerMarker(offset);
            if (marker) {
              const matchEnd = match.index + match[0].length;
              const deco = terminal.registerDecoration({
                marker,
                foregroundColor: color,
                x: match.index,
                width: Math.min(match[0].length, contentLen - match.index),
                height: 1,
                layer: 'top',
              });
              // Tie decoration lifetime to marker — when line scrolls off
              // scrollback buffer, xterm disposes the marker which cleans up the decoration.
              if (deco) {
                marker.onDispose(() => deco.dispose());
                disposables.push(deco);
              }
              // Reset decoration after the colored tag to prevent bleed.
              // Use terminal.cols for width so future appends are covered
              // without needing a rescan (prevents brief color flash).
              const resetMarker = terminal.registerMarker(offset);
              if (resetMarker) {
                const cols = terminal.cols || 80;
                const resetWidth = cols - matchEnd;
                if (resetWidth > 0) {
                  const resetDeco = terminal.registerDecoration({
                    marker: resetMarker,
                    foregroundColor: defaultForeground,
                    x: matchEnd,
                    width: resetWidth,
                    height: 1,
                    layer: 'top',
                  });
                  if (resetDeco) {
                    resetMarker.onDispose(() => resetDeco.dispose());
                    disposables.push(resetDeco);
                  }
                }
              }

              const entry = { color, disposables, continuationLines, contentLen };
              lineDecorations.set(y, entry);
              updateContinuationLines(y, currentLine, entry, defaultForeground);
            }
          } catch (e) {
            log.warn(`AgentColors ${paneId}`, `Decoration failed: ${e.message}`);
          }
          break; // First match wins per line
        }
      }
    }

    lastScannedLine = currentLine;
  });

  log.info(`AgentColors ${paneId}`, 'Agent message color decorations attached');
  return disposable;
}

module.exports = { attachAgentColors, AGENT_COLORS, AGENT_PATTERNS };
