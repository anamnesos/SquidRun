'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIRA_PROGRESS_PROOF_INPUTS_SCHEMA,
  VISIBLE_PRESENCE_A0_PROOF_KEY,
  readDefaultProgressProofInputs,
  resolveDefaultProgressProofPath,
  writeVisiblePresenceProofArtifact,
} = require('../modules/mira-core/mira-progress-proof-inputs-v0');

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'squidrun-mira-proof-inputs-'));
}

function head(overrides = {}) {
  return {
    present: true,
    source_kind: 'provided_head_metadata',
    full_sha: 'abcdef1234567890abcdef1234567890abcdef12',
    short_sha: 'abcdef12',
    committed_at: '2026-05-25T17:59:17.000Z',
    subject: 'Update Mira system map for progress accounting',
    ...overrides,
  };
}

function cleanWorktree(overrides = {}) {
  return {
    present: true,
    source_kind: 'provided_worktree_metadata',
    clean: true,
    dirty_count: 0,
    summary: {
      dirty_count: 0,
      staged_count: 0,
      unstaged_count: 0,
      untracked_count: 0,
      by_code: {},
    },
    status_sha256: 'sha256:clean',
    ...overrides,
  };
}

function dirtyWorktree(overrides = {}) {
  return {
    present: true,
    source_kind: 'provided_worktree_metadata',
    clean: false,
    dirty_count: 2,
    summary: {
      dirty_count: 2,
      staged_count: 0,
      unstaged_count: 1,
      untracked_count: 1,
      by_code: {
        ' M': 1,
        '??': 1,
      },
    },
    status_sha256: 'sha256:dirty',
    ...overrides,
  };
}

describe('mira progress proof inputs v0', () => {
  test('missing default proof file supplies no proof inputs', () => {
    const root = makeRoot();
    try {
      const read = readDefaultProgressProofInputs({ projectRoot: root, head: head() });

      expect(read.present).toBe(false);
      expect(read.status).toBe('missing');
      expect(read.inputSignals).toEqual({});
      expect(read.warnings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('writer records the focused visible Presence harness with current HEAD metadata', () => {
    const root = makeRoot();
    try {
      const result = writeVisiblePresenceProofArtifact({
        projectRoot: root,
        head: head(),
        worktreeState: cleanWorktree(),
        nowMs: Date.parse('2026-05-26T02:40:00.000Z'),
        runner: () => ({
          ok: true,
          exitCode: 0,
          stdout: 'PASS ui/__tests__/mira-presence-runtime-acceptance.test.js',
          stderr: '',
        }),
      });

      expect(result.ok).toBe(true);
      expect(result.proofPath).toBe(resolveDefaultProgressProofPath(root));
      const artifact = JSON.parse(fs.readFileSync(result.proofPath, 'utf8'));
      expect(artifact.schema).toBe(MIRA_PROGRESS_PROOF_INPUTS_SCHEMA);
      expect(artifact.head.short_sha).toBe('abcdef12');
      expect(artifact.worktree).toEqual(expect.objectContaining({
        clean: true,
        dirty_count: 0,
        status_sha256: 'sha256:clean',
      }));
      expect(artifact.proofs[VISIBLE_PRESENCE_A0_PROOF_KEY]).toEqual(expect.objectContaining({
        status: 'PASS',
        proof_key: VISIBLE_PRESENCE_A0_PROOF_KEY,
        head: expect.objectContaining({ short_sha: 'abcdef12' }),
      }));
      expect(artifact.canonical_hash).toMatch(/^sha256:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fresh artifact materializes PASS, while mismatched HEAD materializes STALE', () => {
    const root = makeRoot();
    try {
      writeVisiblePresenceProofArtifact({
        projectRoot: root,
        head: head(),
        worktreeState: cleanWorktree(),
        runner: () => ({ ok: true, exitCode: 0, stdout: 'PASS', stderr: '' }),
      });

      const fresh = readDefaultProgressProofInputs({
        projectRoot: root,
        head: head(),
        worktreeState: cleanWorktree(),
      });
      expect(fresh.present).toBe(true);
      expect(fresh.inputSignals.proofs[VISIBLE_PRESENCE_A0_PROOF_KEY]).toEqual(expect.objectContaining({
        status: 'PASS',
        reason: 'visible Presence/A0 acceptance harness passed',
      }));

      const stale = readDefaultProgressProofInputs({
        projectRoot: root,
        head: head({
          full_sha: '9999999999999999999999999999999999999999',
          short_sha: '99999999',
          subject: 'Later source commit',
        }),
        worktreeState: cleanWorktree(),
      });
      expect(stale.inputSignals.proofs[VISIBLE_PRESENCE_A0_PROOF_KEY]).toEqual(expect.objectContaining({
        status: 'STALE',
        reason: 'proof_head_mismatch',
      }));
      expect(stale.warnings).toContain('proof_head_mismatch');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('dirty-at-write artifact does not materialize PASS', () => {
    const root = makeRoot();
    try {
      writeVisiblePresenceProofArtifact({
        projectRoot: root,
        head: head(),
        worktreeState: dirtyWorktree(),
        runner: () => ({ ok: true, exitCode: 0, stdout: 'PASS', stderr: '' }),
      });

      const read = readDefaultProgressProofInputs({
        projectRoot: root,
        head: head(),
        worktreeState: cleanWorktree(),
      });

      expect(read.inputSignals.proofs[VISIBLE_PRESENCE_A0_PROOF_KEY]).toEqual(expect.objectContaining({
        status: 'STALE',
        reason: 'proof_worktree_dirty',
        artifact_worktree: expect.objectContaining({
          clean: false,
          dirty_count: 2,
        }),
      }));
      expect(read.warnings).toContain('proof_worktree_dirty');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('clean artifact does not materialize PASS when current worktree is dirty', () => {
    const root = makeRoot();
    try {
      writeVisiblePresenceProofArtifact({
        projectRoot: root,
        head: head(),
        worktreeState: cleanWorktree(),
        runner: () => ({ ok: true, exitCode: 0, stdout: 'PASS', stderr: '' }),
      });

      const read = readDefaultProgressProofInputs({
        projectRoot: root,
        head: head(),
        worktreeState: dirtyWorktree(),
      });

      expect(read.inputSignals.proofs[VISIBLE_PRESENCE_A0_PROOF_KEY]).toEqual(expect.objectContaining({
        status: 'STALE',
        reason: 'current_worktree_dirty',
        current_worktree: expect.objectContaining({
          clean: false,
          dirty_count: 2,
        }),
      }));
      expect(read.warnings).toContain('current_worktree_dirty');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
