/**
 * Firmware Manager
 * Generates role firmware from workspace/specs/firmware-injection-spec.md
 * and applies CLI-specific firmware plumbing at spawn time.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('../logger');
const { PROJECT_ROOT, COORD_ROOT } = require('../../config');

const SPEC_RELATIVE_PATH = path.join('workspace', 'specs', 'firmware-injection-spec.md');
const FIRMWARE_SUBDIR = 'firmware';
const CODEX_OVERRIDE_FILENAME = 'AGENTS.override.md';

const PANE_ROLE_FILE = {
  '1': 'director',
  '2': 'builder',
  '5': 'oracle',
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
    this.coordRoot = path.resolve(options.coordRoot || COORD_ROOT);
    this.specPath = path.resolve(options.specPath || path.join(this.projectRoot, SPEC_RELATIVE_PATH));
    this.firmwareDir = path.resolve(options.firmwareDir || path.join(this.coordRoot, FIRMWARE_SUBDIR));
    this.codexRulesDir = path.resolve(
      options.codexRulesDir || path.join(os.homedir(), '.codex', 'rules')
    );
    this.codexOverridePath = path.resolve(
      options.codexOverridePath || path.join(this.codexRulesDir, CODEX_OVERRIDE_FILENAME)
    );
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

  buildFirmwarePayloadsFromSpec() {
    const specMarkdown = this.readSpec();
    const sections = extractMarkdownH3Sections(specMarkdown);

    const directive = normalizeDirective(sections.get('2.1 Directive: SYSTEM PRIORITY'));
    const sharedProtocol = extractBulletLines(
      sections.get('2.2 Shared Team Protocol (Include in all roles)')
    );
    const directorProtocol = extractBulletLines(sections.get('3.1 Director (Architect)'));
    const builderProtocol = extractBulletLines(sections.get('3.2 Builder'));
    const oracleProtocol = extractBulletLines(sections.get('3.3 Oracle'));

    if (!directive) {
      throw new Error('Firmware spec missing 2.1 SYSTEM PRIORITY directive');
    }

    const createBody = (roleLabel, roleLines) => {
      const normalizedRoleLines = uniqueNonEmpty(roleLines);
      const normalizedShared = uniqueNonEmpty(sharedProtocol);
      return [
        directive,
        '',
        `# Hivemind Firmware: ${roleLabel}`,
        '',
        '## Team Protocol',
        ...normalizedShared,
        '',
        '## Role Protocol',
        ...normalizedRoleLines,
        '',
      ].join('\n');
    };

    return {
      director: createBody('Director', directorProtocol),
      builder: createBody('Builder', builderProtocol),
      oracle: createBody('Oracle', oracleProtocol),
    };
  }

  ensureFirmwareFiles() {
    const payloads = this.buildFirmwarePayloadsFromSpec();
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

  ensureFirmwareForPane(paneId) {
    const firmwarePath = this.getFirmwarePathForPane(paneId);
    if (!firmwarePath) {
      return { ok: false, reason: 'unknown_pane', firmwarePath: null };
    }
    this.ensureFirmwareFiles();
    return { ok: true, firmwarePath };
  }

  applyCodexOverrideForPane(paneId) {
    const firmwareResult = this.ensureFirmwareForPane(paneId);
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

  ensureStartupFirmwareIfEnabled() {
    if (!this.isEnabled()) {
      return { ok: true, skipped: true, reason: 'disabled' };
    }
    const result = this.ensureFirmwareFiles();
    log.info('Firmware', `Generated firmware files: ${result.files.join(', ')}`);
    return { ...result, skipped: false };
  }
}

module.exports = FirmwareManager;
