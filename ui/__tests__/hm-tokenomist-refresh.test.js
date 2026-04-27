const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_OUTPUT_PATH,
  DEFAULT_URL,
  countUnlockRows,
  parseArgs,
  validateSnapshot,
  writeFileAtomic,
} = require('../scripts/hm-tokenomist-refresh');

describe('hm-tokenomist-refresh', () => {
  test('parseArgs applies defaults and flags', () => {
    const parsed = parseArgs(['--headed', '--stdout', '--json']);

    expect(parsed).toEqual(expect.objectContaining({
      url: DEFAULT_URL,
      outputPath: DEFAULT_OUTPUT_PATH,
      headed: true,
      stdout: true,
      json: true,
    }));
  });

  test('validateSnapshot counts Tokenomist row entries from aria YAML', () => {
    const snapshot = [
      '- main:',
      '  - heading "Token Unlocks Dashboard" [level=1]',
      '  - table:',
      '    - row "Project Name Price 24h % Reported MCap Released Percentage Upcoming Value Next 7D Emission":',
      '    - row "Picture of OP token OP $0.123 +1.23% $123.00M 50.00% $9.81M 0.68% 0 D 4 H 3 M 51 S $10.77M 0.75%":',
      '    - row "Picture of ARB token ARB $0.112 +1.11% $440.00M 52.10% $10.77M 1.50% 0 D 18 H 33 M 51 S $10.77M 1.50%":',
    ].join('\n');

    expect(countUnlockRows(snapshot)).toBe(2);
    expect(validateSnapshot(snapshot)).toEqual({
      ok: true,
      rowCount: 2,
      hasDashboardHeading: true,
    });
  });

  test('writeFileAtomic writes the full snapshot payload', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-tokenomist-refresh-'));
    const outputPath = path.join(tempRoot, 'nested', 'tokenomist-current.yml');
    const payload = 'row "Picture of OP token OP ..."\n';

    try {
      const writtenPath = writeFileAtomic(outputPath, payload);
      expect(writtenPath).toBe(path.resolve(outputPath));
      expect(fs.readFileSync(outputPath, 'utf8')).toBe(payload);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
