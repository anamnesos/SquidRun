const {
  fileKind,
  groupFor,
  parseArgs,
  renderInventoryMarkdown,
} = require('../scripts/hm-codebase-index');

describe('hm-codebase-index', () => {
  test('parses CLI options', () => {
    expect(parseArgs(['--check', '--output', 'docs/custom.md', '--json'])).toMatchObject({
      check: true,
      json: true,
      output: 'docs/custom.md',
      errors: [],
    });
  });

  test('classifies important SquidRun paths', () => {
    expect(groupFor('ui/modules/voice-broker.js')).toBe('ui/modules');
    expect(groupFor('ui/__tests__/voice-broker.test.js')).toBe('ui/__tests__');
    expect(groupFor('workspace/knowledge/workflows.md')).toBe('workspace/knowledge');
    expect(groupFor('AGENTS.md')).toBe('root');

    expect(fileKind('ui/modules/voice-broker.js')).toBe('source');
    expect(fileKind('ui/__tests__/voice-broker.test.js')).toBe('test');
    expect(fileKind('docs/codebase-index.md')).toBe('doc');
    expect(fileKind('ui/styles/base.css')).toBe('asset');
  });

  test('renders deterministic Markdown inventory without volatile Git state', () => {
    const markdown = renderInventoryMarkdown({
      sourceCommand: 'git ls-files --cached --others --exclude-standard',
      git: { branch: 'main', head: 'abc1234' },
      totalFiles: 2,
      groups: { root: 1, 'ui/scripts': 1 },
      kinds: { doc: 1, script: 1 },
      statuses: { '??': 1, 'clean/tracked': 1 },
      files: [
        { path: 'AGENTS.md', group: 'root', kind: 'doc', status: '  ', bytes: 100 },
        { path: 'ui/scripts/hm-codebase-index.js', group: 'ui/scripts', kind: 'script', status: '??', bytes: 200 },
      ],
    });

    expect(markdown).toContain('# Codebase Index');
    expect(markdown).toContain('committed Markdown omits volatile commit identity, branch name, and working-tree status');
    expect(markdown).toContain('Verify freshness: `node ui/scripts/hm-codebase-index.js --check`');
    expect(markdown).not.toContain('Git HEAD');
    expect(markdown).not.toContain('Git branch');
    expect(markdown).not.toContain('Summary By Status');
    expect(markdown).not.toContain('| Path | Kind | Status | Bytes |');
    expect(markdown).toContain('| `AGENTS.md` | doc | 100 |');
    expect(markdown).toContain('| `ui/scripts/hm-codebase-index.js` | script | 200 |');
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown.endsWith('\n\n')).toBe(false);
  });
});
