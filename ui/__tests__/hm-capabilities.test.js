const {
  buildManifest,
  searchManifest,
  verifyClaim,
} = require('../scripts/hm-capabilities');

describe('hm-capabilities', () => {
  test('builds a manifest from live hm-* scripts', () => {
    const manifest = buildManifest({ write: false });
    const closeTool = manifest.tools.find((tool) => tool.id === 'hm-defi-close');

    expect(manifest.toolCount).toBeGreaterThan(10);
    expect(closeTool).toBeDefined();
    expect(closeTool.primaryCategory).toBe('trading');
    expect(closeTool.riskLevel).toBe('high');
    expect(closeTool.description.toLowerCase()).toContain('close');
  });

  test('search finds the Hyperliquid close path', () => {
    const manifest = buildManifest({ write: false });
    const result = searchManifest(manifest, 'close hyperliquid position', { limit: 3 });

    expect(result.matchCount).toBeGreaterThan(0);
    expect(result.matches[0].id).toBe('hm-defi-close');
  });

  test('verify flags contradicted negative capability claims', () => {
    const manifest = buildManifest({ write: false });
    const result = verifyClaim(manifest, "we can't close a Hyperliquid position");

    expect(result.negativeClaim).toBe(true);
    expect(result.supported).toBe(true);
    expect(result.contradicted).toBe(true);
    expect(result.matches[0].id).toBe('hm-defi-close');
  });
});
