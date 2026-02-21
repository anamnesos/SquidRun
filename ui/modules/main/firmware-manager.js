/**
 * Firmware Manager
 * Generates role firmware from workspace/specs/firmware-injection-spec.md
 * and applies CLI-specific firmware plumbing at spawn time.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('../logger');
const { PROJECT_ROOT, COORD_ROOT, getSquidrunRoot, getProjectRoot, resolveGlobalPath } = require('../../config');
const { execFileSync } = require('child_process');

const SPEC_RELATIVE_PATH = path.join('workspace', 'specs', 'firmware-injection-spec.md');
const FIRMWARE_SUBDIR = 'firmware';
const CODEX_OVERRIDE_FILENAME = 'AGENTS.override.md';
const PREFLIGHT_SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'hm-preflight.js');
const TEMPLATE_PLACEHOLDERS = Object.freeze({
  SQUIDRUN_ROOT: '{SQUIDRUN_ROOT}',
});

const PANE_ROLE_FILE = {
  '1': 'architect',
  '2': 'builder',
  '3': 'oracle',
};

function extractMarkdownH3Sections(markdown) {
  const sections = new Map();
  const lines = String(markdown || '').split(/\r?\n/);
  let currentTitle = null;
  let buffer = [];

  function flush() {
    if (!currentTitle) return;
    sections.set(currentTitle, buffer.join('\n').trim());
  }

  for (const line of lines) {
    const heading = line.match(/^###\s+(.+)\s*$/);
    if (heading) {
      flush();
      currentTitle = heading[1].trim();
      buffer = [];
      continue;
    }
    if (currentTitle) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function normalizeDirective(sectionBody) {
  const lines = String(sectionBody || '').split(/\r?\n/);
  const quoted = lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('>'))
    .map((line) => line.replace(/^>\s?/, '').trim())
    .filter(Boolean);
  return quoted.join(' ');
}

function extractBulletLines(sectionBody) {
  const lines = String(sectionBody || '').split(/\r?\n/);
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
}

function uniqueNonEmpty(lines) {
  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    const value = String(line || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

class FirmwareManager {
  constructor(appContext, options = {}) {
    this.ctx = appContext;
    this.projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
    this.squidrunRoot = path.resolve(
      options.squidrunRoot
      || (typeof getSquidrunRoot === 'function'
        ? getSquidrunRoot()
        : PROJECT_ROOT)
    );
    this.coordRoot = path.resolve(options.coordRoot || COORD_ROOT);
    this.specPath = path.resolve(options.specPath || path.join(this.squidrunRoot, SPEC_RELATIVE_PATH));
    this.firmwareDir = path.resolve(
      options.firmwareDir
      || (
        typeof resolveGlobalPath === 'function'
          ? resolveGlobalPath(FIRMWARE_SUBDIR, { forWrite: true })
          : path.join(this.coordRoot, FIRMWARE_SUBDIR)
      )
    );
    this.codexRulesDir = path.resolve(
      options.codexRulesDir || path.join(os.homedir(), '.codex', 'rules')
    );
    this.codexOverridePath = path.resolve(
      options.codexOverridePath || path.join(this.codexRulesDir, CODEX_OVERRIDE_FILENAME)
    );
  }

  normalizeTargetDir(targetDir) {
    if (typeof targetDir !== 'string') return null;
    const trimmed = targetDir.trim();
    if (!trimmed) return null;
    return path.resolve(trimmed);
  }

  ensurePreflightCache() {
    if (!this.ctx || typeof this.ctx !== 'object') return {};
    if (!this.ctx.preflightScanResults || typeof this.ctx.preflightScanResults !== 'object' || Array.isArray(this.ctx.preflightScanResults)) {
      this.ctx.preflightScanResults = {};
    }
    return this.ctx.preflightScanResults;
  }

  cachePreflightResults(targetDir, results) {
    const normalizedTarget = this.normalizeTargetDir(targetDir) || this.projectRoot;
    const cache = this.ensurePreflightCache();
    cache[normalizedTarget] = Array.isArray(results) ? results : [];
    return cache[normalizedTarget];
  }

  getCachedPreflightResults(targetDir) {
    const normalizedTarget = this.normalizeTargetDir(targetDir);
    if (!normalizedTarget) return [];
    const cache = this.ensurePreflightCache();
    return Array.isArray(cache[normalizedTarget]) ? cache[normalizedTarget] : [];
  }

  getAllCachedPreflightResults() {
    const cache = this.ensurePreflightCache();
    const combined = [];
    Object.values(cache).forEach((value) => {
      if (Array.isArray(value)) {
        combined.push(...value);
      }
    });
    return combined;
  }

  hasConflicts(preflightResults = []) {
    if (!Array.isArray(preflightResults)) return false;
    return preflightResults.some((result) => (
      result
      && result.hasAgentProtocols === true
      && Array.isArray(result.conflicts)
      && result.conflicts.length > 0
    ));
  }

  getOperatingMode() {
    return String(this.ctx?.currentSettings?.operatingMode || '').trim().toLowerCase();
  }

  getSelectedProjectRoot() {
    if (this.getOperatingMode() === 'developer') {
      return null;
    }

    try {
      const state = this.ctx?.watcher?.readState?.();
      const projectFromState = this.normalizeTargetDir(state?.project);
      if (projectFromState) return projectFromState;
    } catch (_) {
      // Fallback to config project root when watcher state is unavailable.
    }

    if (typeof getProjectRoot === 'function') {
      return this.normalizeTargetDir(getProjectRoot());
    }

    return null;
  }

  resolveTargetDirForPane(paneId) {
    const paneProjects = this.ctx?.currentSettings?.paneProjects;
    if (paneProjects && typeof paneProjects === 'object') {
      const paneProjectPath = paneProjects[String(paneId)];
      const normalized = this.normalizeTargetDir(paneProjectPath);
      if (normalized) return normalized;
    }

    const selectedProjectRoot = this.getSelectedProjectRoot();
    if (selectedProjectRoot) return selectedProjectRoot;

    return this.projectRoot;
  }

  isEnabled() {
    return this.ctx?.currentSettings?.firmwareInjectionEnabled === true;
  }

  getFirmwareRoleKey(paneId) {
    return PANE_ROLE_FILE[String(paneId)] || null;
  }

  getFirmwarePathForPane(paneId) {
    const roleKey = this.getFirmwareRoleKey(paneId);
    if (!roleKey) return null;
    return path.join(this.firmwareDir, `${roleKey}.md`);
  }

  readSpec() {
    if (!fs.existsSync(this.specPath)) {
      throw new Error(`Firmware spec not found: ${this.specPath}`);
    }
    return fs.readFileSync(this.specPath, 'utf-8');
  }

  runPreflight(targetDir = this.projectRoot, options = {}) {
    const normalizedTarget = this.normalizeTargetDir(targetDir) || this.projectRoot;
    const shouldCache = options.cache !== false;
    try {
      const output = execFileSync('node', [PREFLIGHT_SCRIPT_PATH, normalizedTarget], {
        encoding: 'utf-8',
      });
      const parsed = JSON.parse(output);
      const results = Array.isArray(parsed) ? parsed : [];
      if (shouldCache) {
        this.cachePreflightResults(normalizedTarget, results);
      }
      return results;
    } catch (err) {
      log.warn('Firmware', `Pre-flight scan failed: ${err.message}`);
      if (shouldCache) {
        this.cachePreflightResults(normalizedTarget, []);
      }
      return [];
    }
  }

  getFirmwareTemplateValues() {
    return {
      SQUIDRUN_ROOT: String(this.squidrunRoot || '').replace(/\\/g, '/'),
    };
  }

  applyFirmwareTemplate(line, templateValues = {}) {
    let rendered = String(line || '');
    Object.entries(templateValues).forEach(([key, value]) => {
      const placeholder = `{${key}}`;
      rendered = rendered.split(placeholder).join(String(value || ''));
    });
    return rendered;
  }

  assertNoUnresolvedFirmwareTemplate(body) {
    const unresolved = String(body || '').match(/\{[A-Z][A-Z0-9_]*\}/g) || [];
    const uniqueUnresolved = [...new Set(unresolved)];
    if (uniqueUnresolved.length > 0) {
      throw new Error(`Firmware template placeholder not resolved: ${uniqueUnresolved.join(', ')}`);
    }
  }

  buildFirmwarePayloadsFromSpec(preflightResults = []) {
    const specMarkdown = this.readSpec();
    const sections = extractMarkdownH3Sections(specMarkdown);
    const templateValues = this.getFirmwareTemplateValues();

    const directive = this.applyFirmwareTemplate(
      normalizeDirective(sections.get('2.1 Directive: SYSTEM PRIORITY')),
      templateValues
    );
    const sharedProtocol = extractBulletLines(
      sections.get('2.2 Shared Team Protocol (Include in all roles)')
    ).map((line) => this.applyFirmwareTemplate(line, templateValues));
    const architectProtocol = extractBulletLines(
      sections.get('3.1 Architect')
      || sections.get('3.1 Director (Architect)')
      || sections.get('3.1 Director')
    )
      .map((line) => this.applyFirmwareTemplate(line, templateValues));
    const builderProtocol = extractBulletLines(sections.get('3.2 Builder'))
      .map((line) => this.applyFirmwareTemplate(line, templateValues));
    const oracleProtocol = extractBulletLines(sections.get('3.3 Oracle'))
      .map((line) => this.applyFirmwareTemplate(line, templateValues));

    if (!directive) {
      throw new Error('Firmware spec missing 2.1 SYSTEM PRIORITY directive');
    }

    const suppressionLines = [];
    if (Array.isArray(preflightResults) && preflightResults.length > 0) {
      preflightResults.forEach((res) => {
        if (res.hasAgentProtocols && Array.isArray(res.conflicts)) {
          res.conflicts.forEach((conflict) => {
            // Extract the description part from "[category] description"
            const description = conflict.replace(/^\[[^\]]+\]\s*/, '').trim();
            if (description) {
              suppressionLines.push(
                `IGNORE project instruction: "${description}" — SquidRun protocols take precedence.`
              );
            }
          });
        }
      });
    }

    const createBody = (roleLabel, roleLines) => {
      const normalizedRoleLines = uniqueNonEmpty(roleLines);
      const normalizedShared = uniqueNonEmpty(sharedProtocol);
      const normalizedSuppression = uniqueNonEmpty(suppressionLines);

      const parts = [
        directive,
        '',
        `# SquidRun Firmware: ${roleLabel}`,
        '',
        '## Team Protocol',
        ...normalizedShared,
        '',
        '## Role Protocol',
        ...normalizedRoleLines,
      ];

      if (normalizedSuppression.length > 0) {
        parts.push('', '## Suppression Directives', ...normalizedSuppression);
      }

      parts.push('');
      const body = parts.join('\n');
      this.assertNoUnresolvedFirmwareTemplate(body);
      return body;
    };

    const architectBody = createBody('Architect', architectProtocol);
    return {
      architect: architectBody,
      director: architectBody, // Legacy alias for compatibility.
      builder: createBody('Builder', builderProtocol),
      oracle: createBody('Oracle', oracleProtocol),
    };
  }

  ensureFirmwareFiles(preflightResults = []) {
    const payloads = this.buildFirmwarePayloadsFromSpec(preflightResults);
    fs.mkdirSync(this.firmwareDir, { recursive: true });

    const results = [];
    for (const [role, body] of Object.entries(payloads)) {
      const filePath = path.join(this.firmwareDir, `${role}.md`);
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
      if (existing !== body) {
        fs.writeFileSync(filePath, body, 'utf-8');
      }
      results.push(filePath);
    }

    return {
      ok: true,
      specPath: this.specPath,
      firmwareDir: this.firmwareDir,
      files: results,
    };
  }

  ensureFirmwareForPane(paneId, options = {}) {
    const firmwarePath = this.getFirmwarePathForPane(paneId);
    if (!firmwarePath) {
      return { ok: false, reason: 'unknown_pane', firmwarePath: null };
    }

    const targetDir = this.normalizeTargetDir(options.targetDir) || this.resolveTargetDirForPane(paneId);
    let preflightResults = [];
    if (Array.isArray(options.preflightResults)) {
      preflightResults = options.preflightResults;
      this.cachePreflightResults(targetDir, preflightResults);
    } else if (options.preflight === true) {
      preflightResults = this.runPreflight(targetDir, { cache: true });
    } else {
      preflightResults = this.getCachedPreflightResults(targetDir);
    }
    this.ensureFirmwareFiles(preflightResults);
    return { ok: true, firmwarePath, targetDir };
  }

  applyCodexOverrideForPane(paneId, options = {}) {
    const firmwareResult = this.ensureFirmwareForPane(paneId, options);
    if (!firmwareResult.ok || !firmwareResult.firmwarePath) {
      return { ok: false, reason: firmwareResult.reason || 'firmware_unavailable' };
    }

    const firmwareContent = fs.readFileSync(firmwareResult.firmwarePath, 'utf-8');
    fs.mkdirSync(this.codexRulesDir, { recursive: true });
    fs.writeFileSync(this.codexOverridePath, firmwareContent, 'utf-8');

    return {
      ok: true,
      overridePath: this.codexOverridePath,
      sourceFirmwarePath: firmwareResult.firmwarePath,
    };
  }

  ensureStartupFirmwareIfEnabled(options = {}) {
    if (!this.isEnabled()) {
      return { ok: true, skipped: true, reason: 'disabled' };
    }
    const preflightResults = options.preflight === true ? this.runPreflight() : [];
    const result = this.ensureFirmwareFiles(preflightResults);
    log.info('Firmware', `Generated firmware files: ${result.files.join(', ')}`);
    return { ...result, skipped: false };
  }
}

module.exports = FirmwareManager;
