#!/usr/bin/env node
'use strict';

/**
 * PreToolUse hook: route ad-hoc image/visual analysis to Oracle.
 *
 * Boundary updated 2026-07-03 (ceremony purge, nervous-system-v1): Codex
 * Desktop left the machine July 1 and its attention bridge is retired; the
 * live rule routes ad-hoc image analysis to ORACLE. The LOOK lane
 * (screenshots/captures) stays open for every pane - it is the mandated
 * draw -> capture -> LOOK verification path.
 *
 * Trigger: assistant calls Read tool on a file with an image extension.
 * Action: BLOCK the Read with the Oracle routing instruction.
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

  appendAuditLine(auditPath, 'BLOCKED_AD_HOC_IMAGE_READ', filePath);

  const absoluteFilePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectDir, filePath);
  const safeFilePath = absoluteFilePath.replace(/"/g, '\\"');
  const reason = `IMAGE READ ROUTING (ceremony purge S467 - Codex Desktop left the machine July 1; its attention bridge is retired): ad-hoc image / visual analysis routes to ORACLE, the designated reviewer with vision.

Send the request with the absolute path:
  node ui/scripts/hm-send.js oracle "Visual analysis request from ${role}: read ${safeFilePath} and describe what is visible in plain English. No source inference, no diagnosis."

LOOK-lane captures under .squidrun/screenshots/ and known runtime proof/capture PNG paths are ALLOWED for every pane - they are the mandated visual verification lane (draw -> capture -> LOOK). For non-analysis reads (file existence check, programmatic byte handling), set HM_ALLOW_IMAGE_READ=1 in env for that one call.`;

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
