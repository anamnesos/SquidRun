/**
 * Output Validation IPC Handlers
 * Channels: validate-output, validate-file, get-validation-patterns
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

function registerOutputValidationHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerOutputValidationHandlers requires ctx.ipcMain');
  }

  const { ipcMain, WORKSPACE_PATH } = ctx;
  const VALIDATION_FILE_PATH = path.join(WORKSPACE_PATH, 'validations.json');

  const INCOMPLETE_PATTERNS = [
    /TODO:/i,
    /FIXME:/i,
    /XXX:/i,
    /HACK:/i,
    /\.\.\.\s*$/,
    /not implemented/i,
    /placeholder/i,
    /coming soon/i,
  ];

  const COMPLETION_INDICATORS = [
    /\u2705/,
    /DONE/i,
    /COMPLETE/i,
    /finished/i,
    /implemented/i,
  ];

  function calculateConfidence(text) {
    let score = 50;

    for (const pattern of INCOMPLETE_PATTERNS) {
      if (pattern.test(text)) {
        score -= 15;
      }
    }

    for (const pattern of COMPLETION_INDICATORS) {
      if (pattern.test(text)) {
        score += 10;
      }
    }

    if (text.length < 50) score -= 20;
    if (text.length > 500) score += 10;

    return Math.max(0, Math.min(100, score));
  }

  ctx.INCOMPLETE_PATTERNS = INCOMPLETE_PATTERNS;
  ctx.calculateConfidence = calculateConfidence;
  ctx.VALIDATION_FILE_PATH = VALIDATION_FILE_PATH;

  function getCanonicalPath(targetPath) {
    if (fs.realpathSync && typeof fs.realpathSync.native === 'function') {
      return fs.realpathSync.native(targetPath);
    }
    return fs.realpathSync(targetPath);
  }

  function isPathWithinBoundary(targetPath, boundaryRoot) {
    const relativePath = path.relative(boundaryRoot, targetPath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  }

  function runValidation(text, options = {}) {
    const issues = [];
    const warnings = [];

    for (const pattern of INCOMPLETE_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        issues.push({
          type: 'incomplete',
          pattern: pattern.toString(),
          match: match[0],
          message: `Found incomplete marker: ${match[0]}`,
        });
      }
    }

    if (options.checkSyntax && options.language === 'javascript') {
      try {
        require('node:vm').compileFunction(text, [], { filename: 'validation-check.js' });
      } catch (err) {
        issues.push({
          type: 'syntax',
          message: `JavaScript syntax error: ${err.message}`,
        });
      }
    }

    if (options.checkJson) {
      try {
        JSON.parse(text);
      } catch (err) {
        issues.push({
          type: 'json',
          message: `JSON parse error: ${err.message}`,
        });
      }
    }

    const confidence = calculateConfidence(text);

    if (confidence < 40) {
      warnings.push({
        type: 'low_confidence',
        message: `Low completion confidence: ${confidence}%`,
      });
    }

    const valid = issues.length === 0;

    log.info('Validation', `${valid ? 'PASS' : 'FAIL'} - Confidence: ${confidence}%, Issues: ${issues.length}`);

    return {
      success: true,
      valid,
      confidence,
      issues,
      warnings,
    };
  }

  ipcMain.handle('validate-output', (event, text, options = {}) => {
    return runValidation(text, options);
  });

  ipcMain.handle('validate-file', async (event, filePath, options = {}) => {
    try {
      const workspaceRoot = path.resolve(WORKSPACE_PATH);
      const absolutePath = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(workspaceRoot, filePath);

      if (!fs.existsSync(absolutePath)) {
        return { success: false, error: 'File not found' };
      }

      const canonicalWorkspaceRoot = getCanonicalPath(workspaceRoot);
      const canonicalFilePath = getCanonicalPath(absolutePath);

      if (!isPathWithinBoundary(canonicalFilePath, canonicalWorkspaceRoot)) {
        return { success: false, error: 'Path outside project boundary' };
      }

      const content = fs.readFileSync(canonicalFilePath, 'utf-8');
      const ext = path.extname(canonicalFilePath).toLowerCase();

      if (ext === '.js' || ext === '.ts') {
        options.checkSyntax = true;
        options.language = 'javascript';
      } else if (ext === '.json') {
        options.checkJson = true;
      }

      const result = runValidation(content, options);
      return { ...result, filePath: canonicalFilePath, extension: ext };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-validation-patterns', () => {
    return {
      incomplete: INCOMPLETE_PATTERNS.map(p => p.toString()),
      completion: COMPLETION_INDICATORS.map(p => p.toString()),
    };
  });
}


function unregisterOutputValidationHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
    ipcMain.removeHandler('validate-output');
    ipcMain.removeHandler('validate-file');
    ipcMain.removeHandler('get-validation-patterns');
}

registerOutputValidationHandlers.unregister = unregisterOutputValidationHandlers;
module.exports = { registerOutputValidationHandlers };
