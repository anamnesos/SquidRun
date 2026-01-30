/**
 * Backup Manager
 * Automated backups of workspace/config/state with restore points and versioning.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

const DEFAULT_CONFIG = {
  enabled: true,
  intervalMinutes: 60,
  maxBackups: 20,
  maxAgeDays: 30,
  createRestorePoint: true,
  includePaths: [
    'workspace/app-status.json',
    'workspace/shared_context.md',
    'workspace/state.json',
    'workspace/message-state.json',
    'workspace/schedules.json',
    'workspace/build',
    'workspace/memory',
    'workspace/knowledge',
    'workspace/history',
    'ui/settings.json',
    'ui/session-state.json',
    'ui/usage-stats.json',
  ],
  excludePatterns: [
    'node_modules',
    'coverage',
    'backups',
    '.git',
    'workspace/logs',
    'workspace/screenshots',
    'workspace/messages',
    'workspace/triggers',
    'workspace/instances',
    '*.tmp',
  ],
};

const INDEX_FILE = 'index.json';
const META_FILE = 'backup.json';

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    log.warn('Backup', `Failed to read JSON ${filePath}: ${err.message}`);
    return null;
  }
}

function safeWriteJson(filePath, data) {
  try {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    log.error('Backup', `Failed to write JSON ${filePath}: ${err.message}`);
  }
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${regex}$`, 'i');
}

function matchesPattern(relPath, pattern) {
  const normalized = normalizePath(relPath);
  const normalizedPattern = normalizePath(pattern);
  if (!normalizedPattern) return false;
  if (normalizedPattern.includes('*') || normalizedPattern.includes('?')) {
    return wildcardToRegex(normalizedPattern).test(normalized);
  }
  if (normalized === normalizedPattern || normalized.startsWith(`${normalizedPattern}/`)) {
    return true;
  }
  return normalized.split('/').includes(normalizedPattern);
}

function createBackupManager(options = {}) {
  const workspacePath = options.workspacePath;
  const repoRoot = options.repoRoot || path.join(workspacePath, '..');
  const logActivity = options.logActivity || null;

  const backupRoot = path.join(workspacePath, 'backups');
  const configPath = path.join(workspacePath, 'backup-config.json');
  const indexPath = path.join(backupRoot, INDEX_FILE);

  let config = { ...DEFAULT_CONFIG };
  let index = { backups: [] };
  let timer = null;

  function loadConfig() {
    const loaded = safeReadJson(configPath);
    if (loaded && typeof loaded === 'object') {
      config = { ...DEFAULT_CONFIG, ...loaded };
    } else {
      config = { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig() {
    config.lastUpdated = new Date().toISOString();
    safeWriteJson(configPath, config);
  }

  function loadIndex() {
    const loaded = safeReadJson(indexPath);
    if (loaded && Array.isArray(loaded.backups)) {
      index = loaded;
    } else {
      index = { backups: [] };
    }
  }

  function saveIndex() {
    index.lastUpdated = new Date().toISOString();
    safeWriteJson(indexPath, index);
  }

  function getConfig() {
    return { ...config };
  }

  function updateConfig(patch = {}) {
    config = { ...config, ...patch };
    saveConfig();
    restartScheduler();
    return getConfig();
  }

  function listBackups() {
    loadIndex();
    return index.backups.map(item => ({ ...item }));
  }

  function shouldExclude(relPath) {
    const normalized = normalizePath(relPath);
    const patterns = config.excludePatterns || [];
    return patterns.some(pattern => matchesPattern(normalized, pattern));
  }

  function resolveIncludePaths(includePaths) {
    const list = includePaths && includePaths.length ? includePaths : config.includePaths;
    return (list || []).map(entry => {
      const full = path.isAbsolute(entry) ? entry : path.join(repoRoot, entry);
      return { entry, full };
    });
  }

  function formatTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function createId() {
    return crypto.randomBytes(6).toString('hex');
  }

  function copyEntry(sourcePath, relPath, destRoot, records) {
    const normalizedRel = normalizePath(relPath);
    if (shouldExclude(normalizedRel)) return;
    if (!fs.existsSync(sourcePath)) return;
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(sourcePath, { withFileTypes: true });
      entries.forEach(entry => {
        const childSource = path.join(sourcePath, entry.name);
        const childRel = path.join(relPath, entry.name);
        copyEntry(childSource, childRel, destRoot, records);
      });
      return;
    }

    if (!stat.isFile()) return;
    const destPath = path.join(destRoot, relPath);
    ensureDir(path.dirname(destPath));
    fs.copyFileSync(sourcePath, destPath);
    records.push({
      relativePath: normalizePath(relPath),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }

  function createBackup(options = {}) {
    loadConfig();
    ensureDir(backupRoot);
    loadIndex();

    const timestamp = formatTimestamp();
    const id = `${timestamp}-${createId()}`;
    const backupDir = path.join(backupRoot, id);
    const dataDir = path.join(backupDir, 'files');
    ensureDir(dataDir);

    const includePaths = resolveIncludePaths(options.includePaths);
    const records = [];
    let totalSize = 0;

    includePaths.forEach(item => {
      if (!fs.existsSync(item.full)) {
        log.warn('Backup', `Include path missing: ${item.full}`);
        return;
      }
      const relPath = path.isAbsolute(item.full)
        ? path.relative(repoRoot, item.full)
        : item.entry;
      if (relPath.startsWith('..')) {
        log.warn('Backup', `Skipping path outside repo root: ${item.full}`);
        return;
      }
      copyEntry(item.full, relPath, dataDir, records);
    });

    records.forEach(record => {
      totalSize += record.size || 0;
    });

    const metadata = {
      id,
      createdAt: new Date().toISOString(),
      reason: options.reason || 'manual',
      name: options.name || `Backup ${timestamp}`,
      totalSize,
      fileCount: records.length,
      includePaths: includePaths.map(p => p.entry),
      excludePatterns: config.excludePatterns || [],
      records,
    };

    safeWriteJson(path.join(backupDir, META_FILE), metadata);

    index.backups.unshift({
      id,
      createdAt: metadata.createdAt,
      name: metadata.name,
      reason: metadata.reason,
      fileCount: metadata.fileCount,
      totalSize: metadata.totalSize,
    });

    saveIndex();
    pruneBackups();

    if (logActivity) {
      logActivity('backup', null, `Backup created (${metadata.fileCount} files)`, {
        backupId: id,
        size: totalSize,
      });
    }

    config.lastBackupAt = metadata.createdAt;
    saveConfig();
    log.info('Backup', `Created backup ${id} (${metadata.fileCount} files)`);
    return { success: true, backup: metadata };
  }

  function getBackupMeta(backupId) {
    const backupDir = path.join(backupRoot, backupId);
    if (!fs.existsSync(backupDir)) return null;
    return safeReadJson(path.join(backupDir, META_FILE));
  }

  function restoreBackup(backupId, options = {}) {
    loadConfig();
    const metadata = getBackupMeta(backupId);
    if (!metadata) return { success: false, error: 'backup_not_found' };

    if (config.createRestorePoint && options.skipRestorePoint !== true) {
      createBackup({ reason: `pre-restore:${backupId}` });
    }

    const restored = [];
    const backupDir = path.join(backupRoot, backupId, 'files');
    const dryRun = options.dryRun === true;

    metadata.records.forEach(record => {
      const relPath = record.relativePath;
      const sourcePath = path.join(backupDir, relPath);
      const destPath = path.join(repoRoot, relPath);
      if (normalizePath(relPath).startsWith('..')) return;
      if (!path.resolve(destPath).startsWith(path.resolve(repoRoot))) return;
      if (!fs.existsSync(sourcePath)) return;
      if (dryRun) {
        restored.push(destPath);
        return;
      }
      ensureDir(path.dirname(destPath));
      fs.copyFileSync(sourcePath, destPath);
      restored.push(destPath);
    });

    if (logActivity && !dryRun) {
      logActivity('backup', null, `Backup restored (${restored.length} files)`, {
        backupId,
      });
    }

    log.info('Backup', `Restored backup ${backupId} (${restored.length} files)`);
    return { success: true, restored, filesRestored: restored.length, dryRun };
  }

  function deleteBackup(backupId) {
    const backupDir = path.join(backupRoot, backupId);
    if (!fs.existsSync(backupDir)) return { success: false, error: 'not_found' };
    fs.rmSync(backupDir, { recursive: true, force: true });
    loadIndex();
    index.backups = index.backups.filter(item => item.id !== backupId);
    saveIndex();
    log.info('Backup', `Deleted backup ${backupId}`);
    return { success: true };
  }

  function pruneBackups() {
    loadConfig();
    loadIndex();
    const maxBackups = Number(config.maxBackups || 0);
    const maxAgeDays = Number(config.maxAgeDays || 0);
    const now = Date.now();
    let removed = 0;

    if (maxAgeDays > 0) {
      index.backups = index.backups.filter(entry => {
        const created = new Date(entry.createdAt).getTime();
        if (Number.isNaN(created)) return true;
        const ageDays = (now - created) / (24 * 60 * 60 * 1000);
        if (ageDays > maxAgeDays) {
          fs.rmSync(path.join(backupRoot, entry.id), { recursive: true, force: true });
          removed += 1;
          return false;
        }
        return true;
      });
    }

    if (maxBackups > 0 && index.backups.length > maxBackups) {
      const overflow = index.backups.slice(maxBackups);
      overflow.forEach(entry => {
        fs.rmSync(path.join(backupRoot, entry.id), { recursive: true, force: true });
        removed += 1;
      });
      index.backups = index.backups.slice(0, maxBackups);
    }

    if (removed > 0) {
      saveIndex();
      log.info('Backup', `Pruned ${removed} backup(s)`);
    }
    return removed;
  }

  function restartScheduler() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!config.enabled) return;
    const intervalMs = Number(config.intervalMinutes || 0) * 60 * 1000;
    if (!intervalMs) return;
    timer = setInterval(() => {
      try {
        createBackup({ reason: 'scheduled' });
      } catch (err) {
        log.error('Backup', `Scheduled backup failed: ${err.message}`);
      }
    }, intervalMs);
  }

  function init() {
    ensureDir(backupRoot);
    loadConfig();
    loadIndex();
    saveConfig();
    restartScheduler();
  }

  return {
    init,
    getConfig,
    updateConfig,
    listBackups,
    createBackup,
    restoreBackup,
    deleteBackup,
    pruneBackups,
  };
}

module.exports = { createBackupManager };
