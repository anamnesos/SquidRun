'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  evaluateImageReadGuard,
  isLookLaneImageRead,
} = require('../../.claude/hooks/pre-tool-image-read-guard');

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'image-read-guard-test-'));
}

function cleanupTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function readPayload(filePath) {
  return {
    tool_name: 'Read',
    tool_input: { file_path: filePath },
  };
}

describe('pre-tool-image-read-guard LOOK lane exemption', () => {
  let projectDir;
  let auditPath;

  beforeEach(() => {
    projectDir = makeTempProject();
    auditPath = path.join(projectDir, '.squidrun', 'runtime', 'image-read-routing.log');
  });

  afterEach(() => cleanupTempDir(projectDir));

  test('allows SquidRun screenshot captures without an env bypass', () => {
    const filePath = path.join(projectDir, '.squidrun', 'screenshots', 'capture-1780825900090.png');
    const result = evaluateImageReadGuard(readPayload(filePath), { projectDir, auditPath, role: 'builder' });

    expect(result).toEqual({ decision: 'allow', reason: 'look_lane_image' });
    expect(fs.readFileSync(auditPath, 'utf8')).toContain('LOOK_LANE_ALLOWED');
  });

  test('allows known runtime proof and capture PNGs', () => {
    expect(isLookLaneImageRead(
      path.join(projectDir, '.squidrun', 'runtime', 'bg-2-verification', 'main-before.png'),
      projectDir
    )).toBe(true);
    expect(isLookLaneImageRead(
      path.join(projectDir, '.squidrun', 'runtime', 'codex-attention-bridge', 'proof-packets', 'codex-proof.desktop.png'),
      projectDir
    )).toBe(true);
    expect(isLookLaneImageRead(
      path.join(projectDir, '.squidrun', 'runtime', 'codex-window-check', 'after-open-copyscreen.png'),
      projectDir
    )).toBe(true);
  });

  test('blocks arbitrary image assets outside the LOOK lane', () => {
    const filePath = path.join(projectDir, 'workspace', 'brand', 'logo.png');
    const result = evaluateImageReadGuard(readPayload(filePath), { projectDir, auditPath, role: 'builder' });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('image / visual analysis belongs to Codex Desktop');
    expect(result.reason).toContain('LOOK-lane captures under .squidrun/screenshots/');
    expect(fs.readFileSync(auditPath, 'utf8')).toContain('BLOCKED_CODEX_DESKTOP');
  });

  test('blocks non-capture runtime image assets', () => {
    const filePath = path.join(projectDir, '.squidrun', 'runtime', 'chrome-profile', 'Default', 'Extensions', 'abc', '128.png');
    const result = evaluateImageReadGuard(readPayload(filePath), { projectDir, auditPath, role: 'builder' });

    expect(result.decision).toBe('block');
    expect(isLookLaneImageRead(filePath, projectDir)).toBe(false);
  });
});
