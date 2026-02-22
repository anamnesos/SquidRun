const fs = require('fs');
const path = require('path');
const config = require('../../config');

const EDITABLE_FIELDS = Object.freeze([
  'name',
  'experience_level',
  'communication_style',
  'domain_expertise',
  'notes',
]);

const DEFAULT_SCHEMA = Object.freeze({
  experience_level: Object.freeze({
    beginner: 'Learning to code - explain concepts, avoid jargon, confirm before destructive actions',
    tinkerer: 'Builds real things but not formally trained - explain architecture decisions, skip basics, use plain language',
    developer: 'Junior dev, knows fundamentals - use technical terms freely, explain only non-obvious tradeoffs',
    expert: 'Pro dev - be terse, skip explanations unless asked, assume deep knowledge',
  }),
  communication_style: Object.freeze({
    detailed: 'Explain what you are doing and why',
    balanced: 'Brief context, focus on action',
    terse: 'Just do it, minimal commentary',
  }),
});

function cloneDefaultSchema() {
  return JSON.parse(JSON.stringify(DEFAULT_SCHEMA));
}

function isObjectLike(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeEditableValue(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function toProfileInput(payload) {
  return isObjectLike(payload) ? payload : {};
}

function resolveProjectRoot(ctx) {
  const contextRoot = typeof ctx?.PROJECT_ROOT === 'string' ? ctx.PROJECT_ROOT.trim() : '';
  if (contextRoot) return path.resolve(contextRoot);

  if (typeof config.getProjectRoot === 'function') {
    const dynamicRoot = config.getProjectRoot();
    if (typeof dynamicRoot === 'string' && dynamicRoot.trim()) {
      return path.resolve(dynamicRoot);
    }
  }

  const configRoot = typeof config.PROJECT_ROOT === 'string' ? config.PROJECT_ROOT.trim() : '';
  if (configRoot) return path.resolve(configRoot);

  const workspacePath = typeof ctx?.WORKSPACE_PATH === 'string' && ctx.WORKSPACE_PATH.trim()
    ? ctx.WORKSPACE_PATH
    : config.WORKSPACE_PATH;

  return path.resolve(path.join(workspacePath || process.cwd(), '..'));
}

function resolveUserProfilePath(ctx) {
  return path.join(resolveProjectRoot(ctx), 'workspace', 'user-profile.json');
}

function readProfileFile(profilePath) {
  if (!fs.existsSync(profilePath)) {
    return { exists: false, data: null };
  }

  try {
    const raw = fs.readFileSync(profilePath, 'utf-8');
    if (!String(raw || '').trim()) {
      return { exists: true, data: {} };
    }
    const parsed = JSON.parse(raw);
    return {
      exists: true,
      data: isObjectLike(parsed) ? parsed : {},
    };
  } catch (err) {
    return {
      exists: true,
      error: `Failed to read user profile: ${err.message}`,
    };
  }
}

function buildProfileResponse(source) {
  const input = isObjectLike(source) ? source : {};
  const profile = {};

  for (const field of EDITABLE_FIELDS) {
    profile[field] = normalizeEditableValue(input[field]);
  }

  profile.schema = hasOwn(input, 'schema') && input.schema !== undefined
    ? input.schema
    : cloneDefaultSchema();

  return profile;
}

function mergeEditableFields(current, updates) {
  const merged = {};
  const currentData = isObjectLike(current) ? current : {};
  const incomingData = toProfileInput(updates);

  for (const field of EDITABLE_FIELDS) {
    if (hasOwn(incomingData, field)) {
      merged[field] = normalizeEditableValue(incomingData[field]);
      continue;
    }
    if (hasOwn(currentData, field)) {
      merged[field] = normalizeEditableValue(currentData[field]);
      continue;
    }
    merged[field] = '';
  }

  return merged;
}

function buildSavedProfile(existingProfile, updates) {
  const incomingData = toProfileInput(updates);
  const existingData = isObjectLike(existingProfile) ? existingProfile : null;
  const profile = mergeEditableFields(existingData, incomingData);

  if (existingData) {
    if (hasOwn(existingData, 'schema')) {
      profile.schema = existingData.schema;
    }
    return profile;
  }

  if (hasOwn(incomingData, 'schema') && incomingData.schema !== undefined) {
    profile.schema = incomingData.schema;
  } else {
    profile.schema = cloneDefaultSchema();
  }

  return profile;
}

function saveProfileFile(profilePath, profile) {
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, 'utf-8');
}

function registerUserProfileHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerUserProfileHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;

  ipcMain.handle('get-user-profile', () => {
    const profilePath = resolveUserProfilePath(ctx);
    const readResult = readProfileFile(profilePath);
    if (readResult.error) {
      return {
        success: false,
        error: readResult.error,
      };
    }
    return {
      success: true,
      profile: buildProfileResponse(readResult.data),
      path: profilePath,
    };
  });

  ipcMain.handle('save-user-profile', (_event, payload = {}) => {
    const profilePath = resolveUserProfilePath(ctx);
    const readResult = readProfileFile(profilePath);
    if (readResult.error) {
      return {
        success: false,
        error: readResult.error,
      };
    }

    const nextProfile = buildSavedProfile(readResult.data, payload);
    try {
      saveProfileFile(profilePath, nextProfile);
    } catch (err) {
      return {
        success: false,
        error: `Failed to save user profile: ${err.message}`,
      };
    }

    return {
      success: true,
      profile: buildProfileResponse(nextProfile),
      path: profilePath,
    };
  });
}

function unregisterUserProfileHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
  ipcMain.removeHandler('get-user-profile');
  ipcMain.removeHandler('save-user-profile');
}

registerUserProfileHandlers.unregister = unregisterUserProfileHandlers;

module.exports = {
  registerUserProfileHandlers,
};
