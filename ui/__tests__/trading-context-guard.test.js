'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('trading context guard', () => {
  test('hooks do not inject dead real-money trading orders', () => {
    const hookText = [
      readRepoFile('.claude/hooks/pre-compact-memory.sh'),
      readRepoFile('.claude/hooks/session-start.sh'),
    ].join('\n');

    expect(hookText).not.toMatch(/Run hm-defi-status\.js/i);
    expect(hookText).not.toMatch(/Actively seek trades/i);
    expect(hookText).not.toMatch(/actively sell/i);
    expect(hookText).not.toMatch(/Don't wait for prompts\./i);
    expect(hookText).not.toMatch(/Check positions FIRST/i);
    expect(hookText).toMatch(/Verify a current read-only live state first/);
    expect(hookText).toMatch(/Do not seek, place, close, or modify trades from compaction context alone/);
    expect(hookText).toMatch(/Do not seek, place, close, or modify trades from startup context alone/);
  });

  test('trading operations doc names hm-defi-status only as an absent legacy path', () => {
    const tradingOperations = readRepoFile('workspace/knowledge/trading-operations.md');

    expect(tradingOperations).toMatch(/`ui\/scripts\/hm-defi-status\.js` is absent/);
    expect(tradingOperations).toMatch(/current read-only Hyperliquid status path/);
    expect(tradingOperations).not.toMatch(/If `hm-defi-status` and consultation payloads disagree/);
    expect(tradingOperations).not.toMatch(/override `hm-defi-status`/);
  });
});
