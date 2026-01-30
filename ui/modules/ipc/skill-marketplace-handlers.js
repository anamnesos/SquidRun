/**
 * Agent Skill Marketplace IPC Handlers
 * Channels:
 *  - skill-marketplace-list
 *  - skill-marketplace-get
 *  - skill-marketplace-publish
 *  - skill-marketplace-install
 *  - skill-marketplace-uninstall
 *  - skill-marketplace-delete
 *  - skill-marketplace-export
 *  - skill-marketplace-import
 *  - skill-marketplace-assign
 *  - skill-marketplace-unassign
 *  - skill-marketplace-assignments
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');
const { getBuiltInSkills } = require('../agent-skills');

const STATE_VERSION = 1;

function registerSkillMarketplaceHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerSkillMarketplaceHandlers requires ctx.ipcMain');
  }

  const { ipcMain, WORKSPACE_PATH } = ctx;
  const skillsDir = path.join(WORKSPACE_PATH, 'memory');
  const skillsFile = path.join(skillsDir, 'skill-marketplace.json');

  function ensureDir() {
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
  }

  function loadStore() {
    ensureDir();
    if (!fs.existsSync(skillsFile)) {
      return { version: STATE_VERSION, skills: [], installed: {}, assignments: {} };
    }
    try {
      const raw = fs.readFileSync(skillsFile, 'utf-8');
      const data = JSON.parse(raw);
      return {
        version: STATE_VERSION,
        skills: Array.isArray(data.skills) ? data.skills : [],
        installed: data.installed && typeof data.installed === 'object' ? data.installed : {},
        assignments: data.assignments && typeof data.assignments === 'object' ? data.assignments : {},
      };
    } catch (err) {
      log.error('SkillMarketplace', 'Failed to load marketplace store:', err.message);
      return { version: STATE_VERSION, skills: [], installed: {}, assignments: {} };
    }
  }

  function saveStore(store) {
    ensureDir();
    try {
      const payload = { ...store, version: STATE_VERSION };
      const tempPath = `${skillsFile}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tempPath, skillsFile);
    } catch (err) {
      log.error('SkillMarketplace', 'Failed to save marketplace store:', err.message);
    }
  }

  function normalizeArray(value) {
    if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
    if (value === undefined || value === null) return [];
    return [String(value)];
  }

  function normalizeSkillInput(input) {
    let payload = input;
    if (typeof payload === 'string') {
      payload = { name: payload };
    }
    payload = payload || {};

    const now = new Date().toISOString();
    const name = String(payload.name || payload.title || 'Untitled Skill').trim();
    const id =
      payload.id ||
      `skill-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

    return {
      id,
      name,
      description: String(payload.description || ''),
      category: String(payload.category || 'General'),
      tags: normalizeArray(payload.tags),
      capabilities: normalizeArray(payload.capabilities || payload.skills),
      version: String(payload.version || '1.0.0'),
      author: String(payload.author || payload.publisher || 'User'),
      metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
      published: Boolean(payload.published),
      createdAt: payload.createdAt || now,
      updatedAt: now,
      source: payload.source || 'user',
    };
  }

  function getBuiltInIds() {
    return new Set(getBuiltInSkills().map(skill => skill.id));
  }

  function getAllSkills(store) {
    const builtIns = getBuiltInSkills().map(skill => ({
      ...skill,
      source: 'builtin',
      published: true,
    }));
    const combined = [...builtIns];
    const seen = new Set(builtIns.map(skill => skill.id));
    store.skills.forEach(skill => {
      if (seen.has(skill.id)) return;
      seen.add(skill.id);
      combined.push({
        ...skill,
        source: skill.source || 'user',
        published: skill.published === true,
      });
    });
    return combined;
  }

  function withStatus(skills, store) {
    return skills.map(skill => {
      const installedEntry = store.installed?.[skill.id];
      return {
        ...skill,
        installed: Boolean(installedEntry),
        installedAt: installedEntry?.installedAt || null,
        installSource: installedEntry?.source || null,
      };
    });
  }

  function findSkill(skillId, store) {
    if (!skillId) return null;
    const id = String(skillId);
    const all = getAllSkills(store);
    return all.find(skill => skill.id === id || skill.name === id) || null;
  }

  function sendEvent(channel, payload) {
    const mainWindow = ctx.mainWindow;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  }

  ipcMain.handle('skill-marketplace-list', (event, filters = {}) => {
    const store = loadStore();
    let skills = withStatus(getAllSkills(store), store);

    if (filters.search) {
      const query = String(filters.search).toLowerCase();
      skills = skills.filter(skill => {
        const haystack = [
          skill.name,
          skill.description,
          skill.category,
          ...(skill.tags || []),
          ...(skill.capabilities || []),
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(query);
      });
    }

    if (filters.installed === true) {
      skills = skills.filter(skill => skill.installed);
    }
    if (filters.published === true) {
      skills = skills.filter(skill => skill.published);
    }
    if (filters.category) {
      const category = String(filters.category).toLowerCase();
      skills = skills.filter(skill => String(skill.category || '').toLowerCase() === category);
    }
    if (filters.tag) {
      const tag = String(filters.tag).toLowerCase();
      skills = skills.filter(skill => (skill.tags || []).some(t => String(t).toLowerCase() === tag));
    }

    return { success: true, skills };
  });

  ipcMain.handle('skill-marketplace-get', (event, skillId) => {
    const store = loadStore();
    const id = typeof skillId === 'object' && skillId ? skillId.skillId || skillId.id : skillId;
    const skill = findSkill(id, store);
    if (!skill) return { success: false, error: 'Skill not found' };
    return { success: true, skill: withStatus([skill], store)[0] };
  });

  ipcMain.handle('skill-marketplace-publish', (event, payload = {}, options = {}) => {
    const store = loadStore();
    const builtInIds = getBuiltInIds();
    const input = normalizeSkillInput(payload.skill || payload);
    if (builtInIds.has(input.id)) {
      return { success: false, error: 'Cannot override built-in skill' };
    }

    const now = new Date().toISOString();
    const existingIndex = store.skills.findIndex(
      skill => skill.id === input.id || skill.name === input.name,
    );
    const record = {
      ...(existingIndex >= 0 ? store.skills[existingIndex] : {}),
      ...input,
      published: true,
      source: input.source || 'user',
      createdAt:
        existingIndex >= 0
          ? store.skills[existingIndex].createdAt || input.createdAt
          : input.createdAt || now,
      updatedAt: now,
    };

    if (existingIndex >= 0) {
      store.skills[existingIndex] = record;
    } else {
      store.skills.push(record);
    }

    if (options.install !== false) {
      store.installed[record.id] = {
        installedAt: now,
        source: record.source || 'publish',
      };
    }

    saveStore(store);
    log.info('SkillMarketplace', `Published skill: ${record.name}`);
    sendEvent('skill-marketplace-updated', { action: 'publish', skill: record });
    return { success: true, skill: withStatus([record], store)[0] };
  });

  ipcMain.handle('skill-marketplace-install', (event, skillId, options = {}) => {
    const store = loadStore();
    const id = typeof skillId === 'object' && skillId ? skillId.skillId || skillId.id : skillId;
    const installOptions = typeof skillId === 'object' && skillId ? skillId : options;
    const skill = findSkill(id, store);
    if (!skill) return { success: false, error: 'Skill not found' };
    const now = new Date().toISOString();
    store.installed[skill.id] = {
      installedAt: now,
      source: skill.source || installOptions.source || 'install',
    };
    saveStore(store);
    log.info('SkillMarketplace', `Installed skill: ${skill.name}`);
    sendEvent('skill-marketplace-updated', { action: 'install', skillId: skill.id });
    return { success: true, skill: withStatus([skill], store)[0] };
  });

  ipcMain.handle('skill-marketplace-uninstall', (event, skillId) => {
    const store = loadStore();
    const id = typeof skillId === 'object' && skillId ? skillId.skillId || skillId.id : skillId;
    const skill = findSkill(id, store);
    if (!skill) return { success: false, error: 'Skill not found' };
    delete store.installed[skill.id];
    saveStore(store);
    log.info('SkillMarketplace', `Uninstalled skill: ${skill.name}`);
    sendEvent('skill-marketplace-updated', { action: 'uninstall', skillId: skill.id });
    return { success: true };
  });

  ipcMain.handle('skill-marketplace-delete', (event, skillId) => {
    const store = loadStore();
    const builtInIds = getBuiltInIds();
    const id =
      typeof skillId === 'object' && skillId ? skillId.skillId || skillId.id : skillId;
    const idString = String(id || '');
    if (!idString) return { success: false, error: 'skillId required' };
    if (builtInIds.has(idString)) {
      return { success: false, error: 'Cannot delete built-in skill' };
    }
    const index = store.skills.findIndex(skill => skill.id === idString || skill.name === idString);
    if (index < 0) return { success: false, error: 'Skill not found' };
    const removed = store.skills.splice(index, 1)[0];
    delete store.installed[removed.id];
    Object.keys(store.assignments || {}).forEach(agentId => {
      store.assignments[agentId] = (store.assignments[agentId] || []).filter(
        skill => skill !== removed.id,
      );
    });
    saveStore(store);
    log.info('SkillMarketplace', `Deleted skill: ${removed.name}`);
    sendEvent('skill-marketplace-updated', { action: 'delete', skillId: removed.id });
    return { success: true };
  });

  ipcMain.handle('skill-marketplace-export', async (event, payload = {}) => {
    const store = loadStore();
    const includeBuiltIns = payload.includeBuiltIns === true;
    const skillId = payload.skillId || payload.id;
    let skills;
    if (skillId) {
      const skill = findSkill(skillId, store);
      if (!skill) return { success: false, error: 'Skill not found' };
      skills = [skill];
    } else {
      const all = getAllSkills(store);
      skills = includeBuiltIns ? all : store.skills;
    }

    const json = JSON.stringify({ skills }, null, 2);

    if (payload.useDialog && ctx.dialog) {
      const result = await ctx.dialog.showSaveDialog(ctx.mainWindow, {
        title: 'Export Skill Marketplace',
        defaultPath: 'agent-skills.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }
      fs.writeFileSync(result.filePath, json, 'utf-8');
      return { success: true, filePath: result.filePath, skills };
    }

    if (payload.filePath) {
      fs.writeFileSync(payload.filePath, json, 'utf-8');
      return { success: true, filePath: payload.filePath, skills };
    }

    return { success: true, skills, json };
  });

  function normalizeImportPayload(payload) {
    let data = payload;
    if (typeof data === 'string') {
      data = JSON.parse(data);
    }
    if (data && data.skills && Array.isArray(data.skills)) {
      return data.skills;
    }
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') return [data];
    return [];
  }

  ipcMain.handle('skill-marketplace-import', async (event, payload = {}) => {
    try {
      let input = payload;
      if (payload.useDialog && ctx.dialog) {
        const result = await ctx.dialog.showOpenDialog(ctx.mainWindow, {
          title: 'Import Skill Marketplace',
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths?.[0]) {
          return { success: false, canceled: true };
        }
        input = fs.readFileSync(result.filePaths[0], 'utf-8');
      }

      const items = normalizeImportPayload(payload.data || payload.json || input);
      const store = loadStore();
      const builtInIds = getBuiltInIds();
      const imported = [];
      const now = new Date().toISOString();

      items.forEach(item => {
        const record = normalizeSkillInput(item);
        if (builtInIds.has(record.id)) return;
        const index = store.skills.findIndex(
          skill => skill.id === record.id || skill.name === record.name,
        );
        const merged = {
          ...(index >= 0 ? store.skills[index] : {}),
          ...record,
          source: record.source || 'imported',
          createdAt: record.createdAt || now,
          updatedAt: now,
        };
        if (index >= 0) store.skills[index] = merged;
        else store.skills.push(merged);
        if (payload.install === true) {
          store.installed[merged.id] = { installedAt: now, source: merged.source || 'import' };
        }
        imported.push(merged);
      });

      saveStore(store);
      sendEvent('skill-marketplace-updated', { action: 'import', count: imported.length });
      return { success: true, imported, count: imported.length };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('skill-marketplace-assign', (event, payload = {}) => {
    const agentId = String(payload.agentId || '');
    if (!agentId) return { success: false, error: 'agentId required' };

    const store = loadStore();
    const skillIds = normalizeArray(payload.skillIds || payload.skillId);
    const autoInstall = payload.autoInstall !== false;
    const replace = payload.replace === true;

    const assignments = replace ? [] : [...(store.assignments[agentId] || [])];
    skillIds.forEach(skillId => {
      const skill = findSkill(skillId, store);
      if (!skill) return;
      if (!assignments.includes(skill.id)) assignments.push(skill.id);
      if (autoInstall && !store.installed[skill.id]) {
        store.installed[skill.id] = {
          installedAt: new Date().toISOString(),
          source: skill.source || 'assign',
        };
      }
    });

    store.assignments[agentId] = assignments;
    saveStore(store);
    sendEvent('skill-marketplace-assignments', { agentId, assignments });
    return { success: true, assignments };
  });

  ipcMain.handle('skill-marketplace-unassign', (event, payload = {}) => {
    const agentId = String(payload.agentId || '');
    if (!agentId) return { success: false, error: 'agentId required' };
    const store = loadStore();
    if (!store.assignments[agentId]) {
      return { success: true, assignments: [] };
    }
    const skillIds = normalizeArray(payload.skillIds || payload.skillId);
    if (skillIds.length === 0) {
      store.assignments[agentId] = [];
    } else {
      store.assignments[agentId] = store.assignments[agentId].filter(
        skill => !skillIds.includes(skill),
      );
    }
    saveStore(store);
    sendEvent('skill-marketplace-assignments', {
      agentId,
      assignments: store.assignments[agentId],
    });
    return { success: true, assignments: store.assignments[agentId] };
  });

  ipcMain.handle('skill-marketplace-assignments', () => {
    const store = loadStore();
    return { success: true, assignments: store.assignments || {} };
  });
}

module.exports = { registerSkillMarketplaceHandlers };
