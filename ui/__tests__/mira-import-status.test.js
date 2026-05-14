'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { applyReviewedImport } = require('../../mira/tools/execute-reviewed-import');
const { getImportStatus } = require('../../mira/tools/import-status');

describe('Mira import status', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const reportPath = path.join('mira', 'imports', 'reports', 'first-batch-dry-run-v1.json');

  function writeApprovalMarker(dir) {
    const markerPath = path.join(dir, 'approval.json');
    fs.writeFileSync(markerPath, JSON.stringify({
      schema: 'mira.import_approval_marker.v0',
      approval_id: 'status-test-approval',
      approved_at: '2026-05-14T00:00:00.000Z',
      approved_by: 'architect',
      batch_id: 'acceptance-permission-contracts-v1',
      report_id: 'first-batch-dry-run-v1',
      report_path: reportPath,
      approved_record_ids: [
        'presence_runtime_acceptance',
        'north_star_acceptance',
        'pc_embodiment_permission',
      ],
      approval_scope: 'copy_only',
      mutation_limits: {
        copy_allowed: true,
        move_allowed: false,
        delete_allowed: false,
        queue_mutation_allowed: false,
        report_mutation_allowed: false,
        runtime_load_allowed: false,
      },
    }, null, 2));
    return markerPath;
  }

  test('reports no receipts without loading continuity data', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-import-status-empty-'));
    const status = getImportStatus({ env: { MIRA_STATE_ROOT: stateRoot } });

    expect(status).toEqual(expect.objectContaining({
      ok: true,
      state_root: path.resolve(stateRoot),
      receipt_count: 0,
      record_count: 0,
      continuity_loaded: false,
    }));
    expect(status.receipts).toEqual([]);
  });

  test('reports receipt counts from temp state root receipts only', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-import-status-receipt-'));
    const approvalPath = writeApprovalMarker(fs.mkdtempSync(path.join(os.tmpdir(), 'mira-import-status-approval-')));
    const result = applyReviewedImport({
      reportPath,
      approvalPath,
      env: { MIRA_STATE_ROOT: stateRoot },
      receiptId: 'status-test-receipt',
      now: new Date('2026-05-14T11:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    const status = getImportStatus({ env: { MIRA_STATE_ROOT: stateRoot } });

    expect(status).toEqual(expect.objectContaining({
      ok: true,
      receipt_count: 1,
      record_count: 3,
      continuity_loaded: false,
    }));
    expect(status.receipts[0]).toEqual(expect.objectContaining({
      receipt_id: 'status-test-receipt',
      batch_id: 'acceptance-permission-contracts-v1',
      report_id: 'first-batch-dry-run-v1',
      copied_at: '2026-05-14T11:00:00.000Z',
      record_count: 3,
    }));
    expect(status.receipts[0].mutation_flags).toEqual(expect.objectContaining({
      copied: true,
      queue_mutated: false,
      status_mutated: false,
    }));
  });

  test('cli emits JSON status without touching continuity files', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-import-status-cli-'));
    const output = execFileSync(process.execPath, [
      path.join(repoRoot, 'mira', 'tools', 'import-status.js'),
      '--json',
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIRA_STATE_ROOT: stateRoot,
      },
      encoding: 'utf8',
    });
    const status = JSON.parse(output);

    expect(status.ok).toBe(true);
    expect(status.receipt_count).toBe(0);
    expect(status.record_count).toBe(0);
    expect(status.continuity_loaded).toBe(false);
  });
});
