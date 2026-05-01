const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendBulletToSection,
  parseArgs,
  parseIds,
  resolvePromotionTarget,
} = require('../scripts/hm-memory-promote');

describe('memory promotion helpers', () => {
  let tempDir;
  let workspaceDir;
  let knowledgeDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-memory-promote-'));
    workspaceDir = tempDir;
    knowledgeDir = path.join(workspaceDir, 'workspace', 'knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.writeFileSync(path.join(knowledgeDir, 'user-context.md'), '# User Context\n\n## Observed Preferences\n\n');
    fs.writeFileSync(path.join(knowledgeDir, 'workflows.md'), '# Workflows\n\n');
    fs.writeFileSync(path.join(workspaceDir, 'ARCHITECTURE.md'), '# Architecture\n\n');
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('appendBulletToSection deduplicates repeated statements', () => {
    const target = path.join(knowledgeDir, 'user-context.md');
    const first = appendBulletToSection(target, '## Observed Preferences', 'The user prefers direct execution.');
    const second = appendBulletToSection(target, '## Observed Preferences', 'The user prefers direct execution.');

    expect(first.added).toBe(true);
    expect(second.alreadyPresent).toBe(true);
    const content = fs.readFileSync(target, 'utf8');
    expect(content.match(/The user prefers direct execution\./g)).toHaveLength(1);
  });

  test('resolvePromotionTarget maps shared memory classes to expected files', () => {
    const preference = resolvePromotionTarget({ memory_class: 'user_preference' }, workspaceDir);
    const workflow = resolvePromotionTarget({ memory_class: 'procedural_rule' }, workspaceDir);
    const architecture = resolvePromotionTarget({ memory_class: 'architecture_decision' }, workspaceDir);

    expect(preference.filePath).toBe(path.join(knowledgeDir, 'user-context.md'));
    expect(workflow.filePath).toBe(path.join(knowledgeDir, 'workflows.md'));
    expect(architecture.filePath).toBe(path.join(workspaceDir, 'ARCHITECTURE.md'));
  });

  test('cli helpers parse ids and workspace flags', () => {
    expect(parseIds('a,b,a')).toEqual(['a', 'b']);

    const parsed = parseArgs([
      'approve',
      '--ids', 'cand-1,cand-2',
      '--workspace-root', 'D:/tmp/project',
      '--reviewer', 'architect',
    ]);
    expect(parsed.positional[0]).toBe('approve');
    expect(parsed.flags.ids).toBe('cand-1,cand-2');
    expect(parsed.flags['workspace-root']).toBe('D:/tmp/project');
    expect(parsed.flags.reviewer).toBe('architect');
  });
});
