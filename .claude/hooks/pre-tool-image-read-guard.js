#!/usr/bin/env node
'use strict';

/**
 * PreToolUse hook: route image/visual analysis to Codex Desktop.
 *
 * Current boundary, updated 2026-06-02:
 *   Image / visual analysis belongs to Codex Desktop, not Oracle and not the
 *   Architect pane. Codex Desktop is the actor with desktop/browser vision.
 *
 * Trigger: assistant calls Read tool on a file with an image extension.
 * Action: BLOCK the Read with a deterministic Codex Desktop attention path.
 *
 * Failure mode this prevents:
 *   - Read image -> describe what's visible and inject unsupported inference.
 *   - Bounce to Oracle from a stale 2026-04-29 rule, re-litigating the actor
 *     boundary every session.
 *
 * Bypass: set HM_ALLOW_IMAGE_READ=1 in env when the read is genuinely
 *   needed for non-analysis purposes (e.g., file existence verification,
 *   one-time programmatic check). Logs every bypass for audit.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const AUDIT_PATH = path.join(PROJECT_DIR, '.squidrun', 'runtime', 'image-read-routing.log');
const ROLE = String(process.env.SQUIDRUN_ROLE || process.env.SQUIDRUN_PANE_ROLE || 'agent')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '-') || 'agent';

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif', '.tif', '.tiff',
]);

function normalizePathForMatch(filePath, projectDir = PROJECT_DIR) {
  const absoluteFilePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectDir, filePath);
  return absoluteFilePath.replace(/\\/g, '/').toLowerCase();
}

function isLookLaneImageRead(filePath, projectDir = PROJECT_DIR) {
  const normalized = normalizePathForMatch(filePath, projectDir);
  if (normalized.includes('/.squidrun/screenshots/')) return true;
  if (!normalized.includes('/.squidrun/runtime/')) return false;
  if (!normalized.endsWith('.png')) return false;
  if (normalized.includes('/codex-attention-bridge/proof-packets/')) return true;
  if (/\/bg-[^/]*verification\//.test(normalized)) return true;
  return /(?:capture|screenshot|copyscreen|window|verification|proof)/.test(path.basename(normalized));
}

function appendAuditLine(auditPath, code, filePath) {
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${new Date().toISOString()} ${code} ${filePath}\n`, 'utf8');
  } catch {}
}

function evaluateImageReadGuard(parsed, options = {}) {
  const projectDir = options.projectDir || PROJECT_DIR;
  const auditPath = options.auditPath || AUDIT_PATH;
  const role = options.role || ROLE;
  const toolName = parsed.tool_name || parsed.toolName || '';
  if (toolName !== 'Read') return { decision: 'allow', reason: 'non_read_tool' };

  const input = parsed.tool_input || parsed.toolInput || {};
  const filePath = String(input.file_path || input.filePath || '').trim();
  if (!filePath) return { decision: 'allow', reason: 'missing_file_path' };

  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return { decision: 'allow', reason: 'non_image_file' };

  if (isLookLaneImageRead(filePath, projectDir)) {
    appendAuditLine(auditPath, 'LOOK_LANE_ALLOWED', filePath);
    return { decision: 'allow', reason: 'look_lane_image' };
  }

  // Allow explicit bypass for non-analysis uses.
  if (process.env.HM_ALLOW_IMAGE_READ === '1') {
    appendAuditLine(auditPath, 'BYPASS_USED', filePath);
    return { decision: 'allow', reason: 'explicit_bypass' };
  }

  appendAuditLine(auditPath, 'BLOCKED_CODEX_DESKTOP', filePath);

  const absoluteFilePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectDir, filePath);
  const safeFilePath = absoluteFilePath.replace(/"/g, '\\"');
  const reason = `IMAGE READ ROUTING: image / visual analysis belongs to Codex Desktop, not Oracle and not this pane.

For LIVE UI surfaces/routes, create a proven Codex Desktop attention item with the actual surface target, e.g.:
  node ui/scripts/hm-codex-attention.js create --requested-by ${role} --reason "Image / visual analysis request" --url "http://127.0.0.1:8787/task-audit-preview" --check "Describe what is visible in plain English. No source inference, no diagnosis. If Codex Desktop heartbeat is stale or proof is pending, report that exact state."

For this BARE IMAGE FILE, hm-codex-attention has no image/file target field yet. Use the closest real target plus the absolute file path in --check, and label this file-read-via-check path UNPROVEN:
  node ui/scripts/hm-codex-attention.js create --requested-by ${role} --reason "Image file visual analysis request (UNPROVEN file-read-via-check path)" --target-window main --surface "local-image-file-unproven" --check "UNPROVEN PATH: Codex Desktop is local on this machine, but direct file-path image analysis through hm-codex-attention is not yet proven. Open and read the local image at ${safeFilePath}. Describe what's visible in plain English. No source inference, no diagnosis. If Codex Desktop heartbeat is stale/not_proven or proof remains pending, report that exact state."

If image-file analysis becomes common, add a real image/file target field to the Codex attention bridge schema. Do not fall back to Oracle. LOOK-lane captures under .squidrun/screenshots/ and known runtime proof/capture PNG paths are allowed because they are the mandated visual verification lane. If you need to read another image for non-analysis purposes (file existence check, programmatic byte handling), set HM_ALLOW_IMAGE_READ=1 in env for that one call.`;

  return {
    decision: 'block',
    reason,
  };
}

function runHook() {
  let payload = '';
  process.stdin.on('data', (c) => { payload += c; });
  process.stdin.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(payload); } catch { process.exit(0); }
    const result = evaluateImageReadGuard(parsed);
    if (result.decision !== 'block') {
      process.exit(0);
    }

    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: result.reason,
    }));
    process.exit(0);
  });
}

if (require.main === module) {
  runHook();
}

module.exports = {
  IMAGE_EXTS,
  evaluateImageReadGuard,
  isLookLaneImageRead,
  normalizePathForMatch,
};
