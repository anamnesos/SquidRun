const fs = require('fs');
const path = require('path');

const UI_ROOT = path.resolve(__dirname, '..');

const COORD_FILE_HINTS = [
  'app-status.json',
  'shared_context.md',
  'review.json',
  'pipeline.json',
  'activity.json',
  'usage-stats.json',
  'message-state.json',
  'state.json',
  'schedules.json',
];

const COORD_FILE_PATTERN = "app-status\\.json|shared_context\\.md|review\\.json|pipeline\\.json|activity\\.json|usage-stats\\.json|message-state\\.json|state\\.json|schedules\\.json";

const SKIP_FILE_SEGMENTS = [
  '__tests__',
];

function listJsFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

describe('Coord Path Integration', () => {
  test('coordination file paths route through resolveCoordPath', () => {
    const files = listJsFiles(UI_ROOT);
    const offenders = [];

    for (const filePath of files) {
      const rel = path.relative(UI_ROOT, filePath).replace(/\\/g, '/');
      if (SKIP_FILE_SEGMENTS.some((segment) => rel.includes(segment))) continue;

      const source = fs.readFileSync(filePath, 'utf-8');
      const mentionsCoordFile = COORD_FILE_HINTS.some((hint) => source.includes(hint));
      if (!mentionsCoordFile) continue;

      const hasResolver =
        source.includes('resolveCoordPath(')
        || source.includes('resolveCoordFile(')
        || source.includes('resolveGlobalPath(');
      if (hasResolver) continue;

      const usesWorkspaceJoinForCoord =
        new RegExp(`path\\.join\\(\\s*(?:ctx\\.)?WORKSPACE_PATH\\s*,\\s*['"](?:${COORD_FILE_PATTERN})['"]`).test(source)
        || new RegExp(`path\\.join\\(\\s*workspacePath\\s*,\\s*['"](?:${COORD_FILE_PATTERN})['"]`).test(source);

      if (usesWorkspaceJoinForCoord) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });
});
