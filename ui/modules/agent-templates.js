/**
 * Built-in agent templates library
 * Provides curated configurations for common team setups.
 */

const path = require('path');

const BUILTIN_CREATED_AT = '2026-01-30T00:00:00.000Z';
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const GEMINI_INCLUDE_DIR = PROJECT_ROOT.replace(/\\/g, '/');

const DEFAULT_PANE_COMMANDS = {
  '1': 'claude',
  '2': 'codex',
  '5': `gemini --yolo --include-directories "${GEMINI_INCLUDE_DIR}"`,
};

const ALL_CLAUDE = {
  '1': 'claude',
  '2': 'claude',
  '5': 'claude',
};

const ALL_CODEX = {
  '1': 'codex',
  '2': 'codex',
  '5': 'codex',
};

const BUILTIN_TEMPLATES = [
  {
    id: 'builtin-hybrid-default',
    name: 'Hybrid Default (Claude + Codex)',
    description: 'Default split: Claude for lead/review, Codex for execution-heavy panes.',
    tags: ['default', 'hybrid'],
    config: {
      autoSpawn: true,
      autoSync: false,
      agentNotify: true,
      paneCommands: { ...DEFAULT_PANE_COMMANDS },
    },
    paneProjects: {},
  },
  {
    id: 'builtin-all-claude',
    name: 'All Claude (Safe Mode)',
    description: 'All panes use Claude for conservative execution.',
    tags: ['safe', 'review'],
    config: {
      autoSpawn: true,
      autoSync: false,
      agentNotify: true,
      paneCommands: { ...ALL_CLAUDE },
    },
    paneProjects: {},
  },
  {
    id: 'builtin-all-codex',
    name: 'All Codex (Autonomous)',
    description: 'All panes use Codex for maximum throughput.',
    tags: ['autonomous', 'speed'],
    config: {
      autoSpawn: true,
      autoSync: false,
      agentNotify: true,
      paneCommands: { ...ALL_CODEX },
    },
    paneProjects: {},
  },
  {
    id: 'builtin-research-sprint',
    name: 'Research Sprint',
    description: 'High communication mode for rapid research coordination.',
    tags: ['research', 'coordination'],
    config: {
      autoSpawn: true,
      autoSync: true,
      agentNotify: true,
      notifications: true,
      paneCommands: { ...DEFAULT_PANE_COMMANDS },
    },
    paneProjects: {},
  },
  {
    id: 'builtin-review-battle',
    name: 'Review Battle',
    description: 'Reviewer-focused setup with extra alerts enabled.',
    tags: ['review', 'quality'],
    config: {
      autoSpawn: true,
      autoSync: false,
      notifyOnAlerts: true,
      notifyOnCompletions: true,
      paneCommands: { ...DEFAULT_PANE_COMMANDS },
    },
    paneProjects: {},
  },
  {
    id: 'builtin-focus-mode',
    name: 'Focus Mode',
    description: 'Low-noise mode for deep work (notifications + autosync off).',
    tags: ['focus'],
    config: {
      autoSpawn: true,
      autoSync: false,
      notifications: false,
      externalNotificationsEnabled: false,
      paneCommands: { ...DEFAULT_PANE_COMMANDS },
    },
    paneProjects: {},
  },
];

function getBuiltInTemplates() {
  return BUILTIN_TEMPLATES.map(template => ({
    ...template,
    builtIn: true,
    createdAt: template.createdAt || BUILTIN_CREATED_AT,
    updatedAt: template.updatedAt || BUILTIN_CREATED_AT,
  }));
}

module.exports = { getBuiltInTemplates };
