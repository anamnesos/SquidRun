/**
 * Agent message color indicators for xterm.js terminals
 * Uses xterm.js v6 decoration API to color-code agent message tags
 */

const log = require('../logger');

// Agent role colors (#RRGGBB format required by xterm.js decorations)
const AGENT_COLORS = {
  architect: '#FF9500',  // Orange
  devops:    '#00BCD4',  // Cyan
  analyst:   '#AB47BC',  // Purple
  generic:   '#888888',  // Gray
};

// Patterns to match agent message tags and their colors
// Order matters — first match wins per line
const AGENT_PATTERNS = [
  { pattern: /\(ARCH\s*#\d+\):/,           color: AGENT_COLORS.architect },
  { pattern: /\(DEVOPS\s*#\d+\):/,         color: AGENT_COLORS.devops },
  { pattern: /\(ANA\s*#\d+\):/,            color: AGENT_COLORS.analyst },
  { pattern: /\[MSG from architect\]/i,     color: AGENT_COLORS.architect },
  { pattern: /\[MSG from devops\]/i,        color: AGENT_COLORS.devops },
  { pattern: /\[MSG from analyst\]/i,       color: AGENT_COLORS.analyst },
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
  const lineDecorations = new Map(); // lineNumber → { color, disposables[] }

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

    // Scan from lastScannedLine to currentLine (inclusive)
    for (let y = lastScannedLine; y <= currentLine; y++) {
      const line = buf.getLine(y);
      if (!line) continue;

      const text = line.translateToString(true);
      if (!text) continue;

      for (const { pattern, color } of AGENT_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          // If this line already has decorations with the same color, skip
          const existing = lineDecorations.get(y);
          if (existing && existing.color === color) break;

          // Dispose stale decorations from a previous agent on this line
          if (existing) {
            for (const d of existing.disposables) {
              try { d.dispose(); } catch { /* already disposed */ }
            }
            lineDecorations.delete(y);
          }

          const disposables = [];
          try {
            const offset = y - (buf.baseY + buf.cursorY);
            const marker = terminal.registerMarker(offset);
            if (marker) {
              const contentLen = typeof line.getTrimmedLength === 'function'
                ? line.getTrimmedLength() : line.translateToString(false).length;
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
              // Reset decoration after the colored tag to prevent bleed
              if (matchEnd < contentLen) {
                const resetMarker = terminal.registerMarker(offset);
                if (resetMarker) {
                  const resetDeco = terminal.registerDecoration({
                    marker: resetMarker,
                    foregroundColor: defaultForeground,
                    x: matchEnd,
                    width: contentLen - matchEnd,
                    height: 1,
                    layer: 'top',
                  });
                  if (resetDeco) {
                    resetMarker.onDispose(() => resetDeco.dispose());
                    disposables.push(resetDeco);
                  }
                }
              }

              // Wrapped continuation lines can inherit style runs; explicitly reset them.
              // Constrain to currentLine to avoid placing decorations beyond the cursor.
              let continuationLine = y + 1;
              while (continuationLine <= currentLine) {
                const wrappedLine = buf.getLine(continuationLine);
                if (!wrappedLine || wrappedLine.isWrapped !== true) break;
                const wrappedContentLen = typeof wrappedLine.getTrimmedLength === 'function'
                  ? wrappedLine.getTrimmedLength() : wrappedLine.translateToString(false).length;
                if (wrappedContentLen > 0) {
                  const wrappedOffset = continuationLine - currentLine;
                  const wrappedMarker = terminal.registerMarker(wrappedOffset);
                  if (wrappedMarker) {
                    const wrappedDeco = terminal.registerDecoration({
                      marker: wrappedMarker,
                      foregroundColor: defaultForeground,
                      x: 0,
                      width: wrappedContentLen,
                      height: 1,
                      layer: 'top',
                    });
                    if (wrappedDeco) {
                      wrappedMarker.onDispose(() => wrappedDeco.dispose());
                      disposables.push(wrappedDeco);
                    }
                  }
                }
                continuationLine += 1;
              }

              if (disposables.length > 0) {
                lineDecorations.set(y, { color, disposables });
              }
            }
          } catch (e) {
            log.warn(`AgentColors ${paneId}`, `Decoration failed: ${e.message}`);
          }
          break; // First match wins per line
        }
      }
    }

    lastScannedLine = currentLine + 1;
  });

  log.info(`AgentColors ${paneId}`, 'Agent message color decorations attached');
  return disposable;
}

module.exports = { attachAgentColors, AGENT_COLORS, AGENT_PATTERNS };
