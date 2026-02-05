/**
 * Projects Tab Module
 * Handles project selection and switching
 */

const { ipcRenderer } = require('electron');
const log = require('../logger');

let recentProjects = [];
let currentProjectPath = null;

function getProjectName(projectPath) {
  if (!projectPath) return 'No project selected';
  const parts = projectPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || projectPath;
}

function renderProjectsList(updateStatusFn) {
  const listEl = document.getElementById('projectsList');
  if (!listEl) return;

  if (recentProjects.length === 0) {
    listEl.innerHTML = '<div class="projects-empty">No recent projects</div>';
    return;
  }

  listEl.innerHTML = recentProjects.map(project => {
    const isActive = project.path === currentProjectPath;
    return `
      <div class="project-item ${isActive ? 'active' : ''}" data-path="${project.path}">
        <div class="project-item-info">
          <div class="project-item-name">${getProjectName(project.path)}</div>
          <div class="project-item-path" title="${project.path}">${project.path}</div>
        </div>
        <button class="project-item-remove" data-path="${project.path}" title="Remove from list">X</button>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.project-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (e.target.classList.contains('project-item-remove')) return;

      const projectPath = item.dataset.path;
      if (projectPath === currentProjectPath) return;

      if (updateStatusFn) updateStatusFn(`Switching to ${getProjectName(projectPath)}...`);

      try {
        await ipcRenderer.invoke('switch-project', projectPath);
        currentProjectPath = projectPath;
        renderProjectsList(updateStatusFn);
        if (updateStatusFn) updateStatusFn(`Switched to ${getProjectName(projectPath)}`);
      } catch (err) {
        if (updateStatusFn) updateStatusFn(`Failed to switch: ${err.message}`);
      }
    });
  });

  listEl.querySelectorAll('.project-item-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const projectPath = btn.dataset.path;

      try {
        await ipcRenderer.invoke('remove-recent-project', projectPath);
        recentProjects = recentProjects.filter(p => p.path !== projectPath);
        renderProjectsList(updateStatusFn);
        if (updateStatusFn) updateStatusFn(`Removed ${getProjectName(projectPath)} from recent`);
      } catch (err) {
        if (updateStatusFn) updateStatusFn(`Failed to remove: ${err.message}`);
      }
    });
  });
}

async function loadRecentProjects(updateStatusFn) {
  try {
    const result = await ipcRenderer.invoke('get-recent-projects');
    if (result && result.success) {
      recentProjects = result.projects || [];
    } else if (Array.isArray(result)) {
      recentProjects = result;
    }

    const currentProject = await ipcRenderer.invoke('get-project');
    currentProjectPath = currentProject;

    renderProjectsList(updateStatusFn);
  } catch (err) {
    log.error('Projects', 'Error loading recent projects', err);
  }
}

async function addCurrentProject(updateStatusFn) {
  try {
    const result = await ipcRenderer.invoke('select-project');
    if (result.success) {
      currentProjectPath = result.path;
      await loadRecentProjects(updateStatusFn);
      if (updateStatusFn) updateStatusFn(`Added project: ${getProjectName(result.path)}`);
    }
  } catch (err) {
    if (updateStatusFn) updateStatusFn(`Failed to add project: ${err.message}`);
  }
}

function setupProjectsTab(updateStatusFn) {
  const refreshBtn = document.getElementById('refreshProjectsBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadRecentProjects(updateStatusFn));
  }

  const addBtn = document.getElementById('addProjectBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => addCurrentProject(updateStatusFn));
  }

  ipcRenderer.on('project-changed', (event, projectPath) => {
    currentProjectPath = projectPath;
    loadRecentProjects(updateStatusFn);
  });

  loadRecentProjects(updateStatusFn);
}

module.exports = {
  setupProjectsTab,
  loadRecentProjects,
  getProjectName
};
