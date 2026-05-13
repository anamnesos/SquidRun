'use strict';

const fs = require('fs');
const path = require('path');

describe('Mira product foundation manifest', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const manifestPath = path.join(repoRoot, 'mira', 'import-disposition-manifest.json');
  const readmePath = path.join(repoRoot, 'mira', 'README.md');

  test('locks the first extraction boundary without moving live runtime state', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const readme = fs.readFileSync(readmePath, 'utf8');

    expect(manifest.product_root).toBe('mira/');
    expect(manifest.runtime_decision.v1_core).toBe('node_typescript_local_service');
    expect(manifest.runtime_decision.python_policy).toBe('sidecars_only_when_earned');
    expect(manifest.state_boundary.env_var).toBe('MIRA_STATE_ROOT');
    expect(manifest.state_boundary.must_not_use).toEqual(expect.arrayContaining([
      expect.stringContaining('.squidrun'),
      expect.stringContaining('SquidRun cognitive memory'),
    ]));
    expect(manifest.non_scope).toEqual(expect.arrayContaining([
      'telegram_route_changes',
      'primary_telegram_ownership_changes',
      'new_temporary_ui_surface',
      'runtime_code_move',
      'live_data_copy',
      'live_data_delete',
    ]));
    expect(readme).toContain('Mira is being extracted as a product');
    expect(readme).toContain('No Telegram route work.');
  });

  test('makes preservation and later cleanup mechanical', () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const preservePaths = manifest.preserve_for_reviewed_import.map((entry) => entry.path);
    const deleteLaterPaths = manifest.delete_after_parity.map((entry) => entry.path);
    const foundationPaths = manifest.starts_mira_as_mira.map((entry) => entry.path);

    expect(foundationPaths).toEqual([
      'mira/README.md',
      'mira/import-disposition-manifest.json',
    ]);
    expect(preservePaths).toEqual(expect.arrayContaining([
      'ui/modules/mira-core/',
      'ui/modules/mira-local-text-ui-surface.js',
      'ui/modules/mira-lab-surface.js',
      'workspace/mira-lab/transcripts/',
      'docs/mira-presence-runtime-acceptance-v0.md',
      'docs/mira-north-star-acceptance.md',
    ]));
    expect(deleteLaterPaths).toEqual(expect.arrayContaining([
      'ui/modules/main/mira-lab-window.js',
      'ui/mira-lab.html',
      'ui/mira-lab-renderer.js',
      'ui/styles/mira-lab.css',
      'ui/modules/ipc/mira-lab-handlers.js',
      'ui/modules/tabs/mira-local-text.js',
      'ui/styles/tabs/mira-local-text.css',
    ]));

    for (const entry of manifest.delete_after_parity) {
      expect(entry.disposition).toMatch(/^delete_/);
      expect(entry.notes).toBeTruthy();
    }
  });
});
