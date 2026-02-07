/**
 * Multi-Project Dashboard - Task #30
 *
 * Manages multiple projects, context switching, and aggregated metrics.
 *
 * Features:
 * - Project registry with metadata
 * - Cross-project metrics aggregation
 * - Activity tracking per project
 * - Project health scoring
 * - Context switching with state preservation
 * - Project comparison
 */

const fs = require('fs');
const path = require('path');

// Project status types
const PROJECT_STATUS = {
  ACTIVE: 'active',
  IDLE: 'idle',
  ARCHIVED: 'archived',
  ERROR: 'error',
};

// Metric types for aggregation
const METRIC_TYPES = {
  COST: 'cost',
  TOKENS: 'tokens',
  REQUESTS: 'requests',
  ERRORS: 'errors',
  TASKS_COMPLETED: 'tasksCompleted',
  AGENT_HOURS: 'agentHours',
};

/**
 * MultiProjectDashboard class
 */
class MultiProjectDashboard {
  constructor(options = {}) {
    this.dataPath = options.dataPath || path.join(process.cwd(), 'workspace', 'memory');
    this.projectsFile = path.join(this.dataPath, '_projects.json');

    // Project registry
    this.projects = new Map();

    // Active project context
    this.activeProjectId = null;

    // Metrics cache
    this.metricsCache = new Map();
    this.metricsCacheTimeout = options.metricsCacheTimeout || 60000; // 1 minute

    // Activity history per project
    this.activityHistory = new Map();
    this.maxActivityPerProject = options.maxActivityPerProject || 100;

    // Initialize
    this._initialize();
  }

  /**
   * Initialize dashboard
   */
  _initialize() {
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath, { recursive: true });
    }

    this._loadProjects();
    console.log('[MultiProjectDashboard] Initialized with', this.projects.size, 'projects');
  }

  /**
   * Load projects from disk
   */
  _loadProjects() {
    try {
      if (fs.existsSync(this.projectsFile)) {
        const data = JSON.parse(fs.readFileSync(this.projectsFile, 'utf8'));

        for (const project of data.projects || []) {
          this.projects.set(project.id, project);
        }

        this.activeProjectId = data.activeProjectId || null;

        // Load activity history
        for (const [projectId, history] of Object.entries(data.activityHistory || {})) {
          this.activityHistory.set(projectId, history);
        }
      }
    } catch (err) {
      console.error('[MultiProjectDashboard] Load error:', err);
    }
  }

  /**
   * Save projects to disk
   */
  _saveProjects() {
    try {
      const data = {
        projects: Array.from(this.projects.values()),
        activeProjectId: this.activeProjectId,
        activityHistory: Object.fromEntries(this.activityHistory),
        savedAt: Date.now(),
      };

      fs.writeFileSync(this.projectsFile, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('[MultiProjectDashboard] Save error:', err);
    }
  }

  // ==================== PROJECT MANAGEMENT ====================

  /**
   * Register a new project
   * @param {string} projectPath - Path to project
   * @param {object} options - Project options
   * @returns {object} - Registered project
   */
  registerProject(projectPath, options = {}) {
    if (!projectPath || !fs.existsSync(projectPath)) {
      throw new Error('Invalid project path');
    }

    // Generate ID from path
    const id = this._generateProjectId(projectPath);

    // Check if already exists
    if (this.projects.has(id)) {
      const existing = this.projects.get(id);
      existing.lastAccessed = Date.now();
      this._saveProjects();
      return existing;
    }

    // Detect project type
    const projectType = this._detectProjectType(projectPath);

    // Create project entry
    const project = {
      id,
      name: options.name || path.basename(projectPath),
      path: projectPath,
      type: projectType,
      status: PROJECT_STATUS.ACTIVE,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      metadata: {
        description: options.description || '',
        tags: options.tags || [],
        color: options.color || this._generateColor(id),
        icon: options.icon || this._getDefaultIcon(projectType),
      },
      metrics: {
        totalCost: 0,
        totalTokens: 0,
        totalRequests: 0,
        totalErrors: 0,
        tasksCompleted: 0,
        agentHours: 0,
        lastActivity: Date.now(),
      },
      settings: {
        autoSwitch: options.autoSwitch !== false,
        trackActivity: options.trackActivity !== false,
        budgetLimit: options.budgetLimit || null,
      },
    };

    this.projects.set(id, project);
    this.activityHistory.set(id, []);
    this._saveProjects();

    return project;
  }

  /**
   * Unregister a project
   * @param {string} projectId - Project ID
   * @returns {boolean}
   */
  unregisterProject(projectId) {
    if (!this.projects.has(projectId)) {
      return false;
    }

    this.projects.delete(projectId);
    this.activityHistory.delete(projectId);
    this.metricsCache.delete(projectId);

    if (this.activeProjectId === projectId) {
      this.activeProjectId = null;
    }

    this._saveProjects();
    return true;
  }

  /**
   * Update project metadata
   * @param {string} projectId - Project ID
   * @param {object} updates - Updates to apply
   * @returns {object|null}
   */
  updateProject(projectId, updates) {
    const project = this.projects.get(projectId);
    if (!project) return null;

    // Apply updates
    if (updates.name) project.name = updates.name;
    if (updates.description) project.metadata.description = updates.description;
    if (updates.tags) project.metadata.tags = updates.tags;
    if (updates.color) project.metadata.color = updates.color;
    if (updates.icon) project.metadata.icon = updates.icon;
    if (updates.status) project.status = updates.status;
    if (updates.settings) Object.assign(project.settings, updates.settings);

    project.lastAccessed = Date.now();
    this._saveProjects();

    return project;
  }

  /**
   * Get a project by ID
   * @param {string} projectId - Project ID
   * @returns {object|null}
   */
  getProject(projectId) {
    return this.projects.get(projectId) || null;
  }

  /**
   * Get project by path
   * @param {string} projectPath - Project path
   * @returns {object|null}
   */
  getProjectByPath(projectPath) {
    const id = this._generateProjectId(projectPath);
    return this.projects.get(id) || null;
  }

  /**
   * Get all projects
   * @param {object} options - Filter options
   * @returns {Array}
   */
  getAllProjects(options = {}) {
    let projects = Array.from(this.projects.values());

    // Filter by status
    if (options.status) {
      projects = projects.filter(p => p.status === options.status);
    }

    // Filter by tag
    if (options.tag) {
      projects = projects.filter(p => p.metadata.tags.includes(options.tag));
    }

    // Filter by type
    if (options.type) {
      projects = projects.filter(p => p.type === options.type);
    }

    // Sort
    const sortBy = options.sortBy || 'lastAccessed';
    const sortDir = options.sortDir || 'desc';

    projects.sort((a, b) => {
      let aVal, bVal;

      switch (sortBy) {
        case 'name':
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
          break;
        case 'cost':
          aVal = a.metrics.totalCost;
          bVal = b.metrics.totalCost;
          break;
        case 'activity':
          aVal = a.metrics.lastActivity;
          bVal = b.metrics.lastActivity;
          break;
        default:
          aVal = a.lastAccessed;
          bVal = b.lastAccessed;
      }

      if (sortDir === 'asc') {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      }
      return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
    });

    return projects;
  }

  // ==================== CONTEXT SWITCHING ====================

  /**
   * Switch to a project context
   * @param {string} projectId - Project ID
   * @returns {object}
   */
  switchProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const previousId = this.activeProjectId;
    this.activeProjectId = projectId;

    project.lastAccessed = Date.now();
    project.status = PROJECT_STATUS.ACTIVE;

    // Mark previous as idle
    if (previousId && previousId !== projectId) {
      const previous = this.projects.get(previousId);
      if (previous) {
        previous.status = PROJECT_STATUS.IDLE;
      }
    }

    this._saveProjects();

    return {
      previous: previousId,
      current: projectId,
      project,
    };
  }

  /**
   * Get the active project
   * @returns {object|null}
   */
  getActiveProject() {
    if (!this.activeProjectId) return null;
    return this.projects.get(this.activeProjectId) || null;
  }

  // ==================== METRICS & AGGREGATION ====================

  /**
   * Record activity for a project
   * @param {string} projectId - Project ID
   * @param {object} activity - Activity data
   */
  recordActivity(projectId, activity) {
    const project = this.projects.get(projectId);
    if (!project) return;

    // Update project metrics
    if (activity.cost) project.metrics.totalCost += activity.cost;
    if (activity.tokens) project.metrics.totalTokens += activity.tokens;
    if (activity.requests) project.metrics.totalRequests += activity.requests;
    if (activity.errors) project.metrics.totalErrors += activity.errors;
    if (activity.taskCompleted) project.metrics.tasksCompleted += 1;
    if (activity.agentHours) project.metrics.agentHours += activity.agentHours;

    project.metrics.lastActivity = Date.now();

    // Add to activity history
    let history = this.activityHistory.get(projectId) || [];
    history.push({
      ...activity,
      timestamp: Date.now(),
    });

    // Trim history
    if (history.length > this.maxActivityPerProject) {
      history = history.slice(-this.maxActivityPerProject);
    }

    this.activityHistory.set(projectId, history);

    // Invalidate cache
    this.metricsCache.delete(projectId);

    this._saveProjects();
  }

  /**
   * Get aggregated metrics across all or selected projects
   * @param {object} options - Aggregation options
   * @returns {object}
   */
  getAggregatedMetrics(options = {}) {
    const projectIds = options.projectIds || Array.from(this.projects.keys());
    const since = options.since || 0;

    const aggregated = {
      totalCost: 0,
      totalTokens: 0,
      totalRequests: 0,
      totalErrors: 0,
      tasksCompleted: 0,
      agentHours: 0,
      projectCount: 0,
      activeProjects: 0,
      byProject: {},
    };

    for (const projectId of projectIds) {
      const project = this.projects.get(projectId);
      if (!project) continue;

      aggregated.projectCount++;
      if (project.status === PROJECT_STATUS.ACTIVE) {
        aggregated.activeProjects++;
      }

      // Filter activity by time if needed
      let metrics = project.metrics;
      if (since > 0) {
        metrics = this._calculateMetricsSince(projectId, since);
      }

      aggregated.totalCost += metrics.totalCost || 0;
      aggregated.totalTokens += metrics.totalTokens || 0;
      aggregated.totalRequests += metrics.totalRequests || 0;
      aggregated.totalErrors += metrics.totalErrors || 0;
      aggregated.tasksCompleted += metrics.tasksCompleted || 0;
      aggregated.agentHours += metrics.agentHours || 0;

      aggregated.byProject[projectId] = {
        name: project.name,
        ...metrics,
      };
    }

    return aggregated;
  }

  /**
   * Calculate metrics since a timestamp
   */
  _calculateMetricsSince(projectId, since) {
    const history = this.activityHistory.get(projectId) || [];
    const filtered = history.filter(a => a.timestamp >= since);

    return filtered.reduce((acc, activity) => {
      if (activity.cost) acc.totalCost += activity.cost;
      if (activity.tokens) acc.totalTokens += activity.tokens;
      if (activity.requests) acc.totalRequests += activity.requests;
      if (activity.errors) acc.totalErrors += activity.errors;
      if (activity.taskCompleted) acc.tasksCompleted += 1;
      if (activity.agentHours) acc.agentHours += activity.agentHours;
      return acc;
    }, {
      totalCost: 0,
      totalTokens: 0,
      totalRequests: 0,
      totalErrors: 0,
      tasksCompleted: 0,
      agentHours: 0,
    });
  }

  /**
   * Get project health score (0-100)
   * @param {string} projectId - Project ID
   * @returns {object}
   */
  getProjectHealth(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return null;

    const metrics = project.metrics;
    const history = this.activityHistory.get(projectId) || [];

    // Calculate health factors
    const factors = {
      errorRate: 0,
      activityLevel: 0,
      budgetStatus: 100,
      taskCompletion: 0,
    };

    // Error rate (lower is better)
    if (metrics.totalRequests > 0) {
      const errorRate = metrics.totalErrors / metrics.totalRequests;
      factors.errorRate = Math.max(0, 100 - (errorRate * 200)); // 50% error = 0 score
    } else {
      factors.errorRate = 100;
    }

    // Activity level (recent activity is better)
    const daysSinceActivity = (Date.now() - metrics.lastActivity) / (24 * 60 * 60 * 1000);
    factors.activityLevel = Math.max(0, 100 - (daysSinceActivity * 10)); // 10 days = 0

    // Budget status
    if (project.settings.budgetLimit && project.settings.budgetLimit > 0) {
      const budgetUsed = metrics.totalCost / project.settings.budgetLimit;
      factors.budgetStatus = Math.max(0, 100 - (budgetUsed * 100));
    }

    // Task completion (based on recent history)
    const recentTasks = history.filter(a => a.taskCompleted && Date.now() - a.timestamp < 7 * 24 * 60 * 60 * 1000);
    factors.taskCompletion = Math.min(100, recentTasks.length * 10);

    // Calculate overall score (weighted average)
    const weights = { errorRate: 0.3, activityLevel: 0.2, budgetStatus: 0.3, taskCompletion: 0.2 };
    const score = Object.entries(factors).reduce((sum, [key, value]) => {
      return sum + (value * (weights[key] || 0.25));
    }, 0);

    return {
      score: Math.round(score),
      factors,
      status: score >= 80 ? 'healthy' : score >= 50 ? 'warning' : 'critical',
    };
  }

  /**
   * Compare two projects
   * @param {string} projectId1 - First project ID
   * @param {string} projectId2 - Second project ID
   * @returns {object}
   */
  compareProjects(projectId1, projectId2) {
    const project1 = this.projects.get(projectId1);
    const project2 = this.projects.get(projectId2);

    if (!project1 || !project2) {
      throw new Error('One or both projects not found');
    }

    const health1 = this.getProjectHealth(projectId1);
    const health2 = this.getProjectHealth(projectId2);

    return {
      project1: {
        id: projectId1,
        name: project1.name,
        metrics: project1.metrics,
        health: health1,
      },
      project2: {
        id: projectId2,
        name: project2.name,
        metrics: project2.metrics,
        health: health2,
      },
      comparison: {
        costDiff: project1.metrics.totalCost - project2.metrics.totalCost,
        tokensDiff: project1.metrics.totalTokens - project2.metrics.totalTokens,
        requestsDiff: project1.metrics.totalRequests - project2.metrics.totalRequests,
        tasksDiff: project1.metrics.tasksCompleted - project2.metrics.tasksCompleted,
        healthDiff: (health1?.score || 0) - (health2?.score || 0),
      },
    };
  }

  /**
   * Get activity timeline across projects
   * @param {object} options - Options
   * @returns {Array}
   */
  getActivityTimeline(options = {}) {
    const limit = options.limit || 50;
    const projectIds = options.projectIds || Array.from(this.projects.keys());
    const since = options.since || 0;

    const allActivity = [];

    for (const projectId of projectIds) {
      const history = this.activityHistory.get(projectId) || [];
      const project = this.projects.get(projectId);

      for (const activity of history) {
        if (activity.timestamp >= since) {
          allActivity.push({
            ...activity,
            projectId,
            projectName: project?.name || 'Unknown',
          });
        }
      }
    }

    // Sort by timestamp descending
    allActivity.sort((a, b) => b.timestamp - a.timestamp);

    return allActivity.slice(0, limit);
  }

  // ==================== UTILITIES ====================

  /**
   * Generate project ID from path
   */
  _generateProjectId(projectPath) {
    const crypto = require('crypto');
    return crypto.createHash('md5').update(projectPath).digest('hex').slice(0, 12);
  }

  /**
   * Detect project type from path
   */
  _detectProjectType(projectPath) {
    try {
      // Check for common project markers
      if (fs.existsSync(path.join(projectPath, 'package.json'))) return 'node';
      if (fs.existsSync(path.join(projectPath, 'Cargo.toml'))) return 'rust';
      if (fs.existsSync(path.join(projectPath, 'go.mod'))) return 'go';
      if (fs.existsSync(path.join(projectPath, 'requirements.txt'))) return 'python';
      if (fs.existsSync(path.join(projectPath, 'pom.xml'))) return 'java';
      if (fs.existsSync(path.join(projectPath, '.csproj'))) return 'dotnet';
      return 'generic';
    } catch {
      return 'generic';
    }
  }

  /**
   * Generate a color for a project
   */
  _generateColor(id) {
    const colors = [
      '#ff2040', '#3a7bff', '#00e676', '#f0a000',
      '#bb86fc', '#ff4088', '#00f0ff', '#ff9040',
    ];
    const hash = id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return colors[hash % colors.length];
  }

  /**
   * Get default icon for project type
   */
  _getDefaultIcon(type) {
    const icons = {
      node: '📦',
      rust: '🦀',
      go: '🐹',
      python: '🐍',
      java: '☕',
      dotnet: '🔷',
      generic: '📁',
    };
    return icons[type] || '📁';
  }

  /**
   * Export dashboard data
   */
  export() {
    return {
      projects: Array.from(this.projects.values()),
      activeProjectId: this.activeProjectId,
      aggregatedMetrics: this.getAggregatedMetrics(),
      exportedAt: Date.now(),
    };
  }

  /**
   * Import dashboard data
   */
  import(data) {
    if (data.projects) {
      for (const project of data.projects) {
        this.projects.set(project.id, project);
      }
    }

    if (data.activeProjectId) {
      this.activeProjectId = data.activeProjectId;
    }

    this._saveProjects();
  }
}

// Singleton instance
let dashboardInstance = null;

/**
 * Create or get the dashboard instance
 */
function getMultiProjectDashboard(options = {}) {
  if (!dashboardInstance) {
    dashboardInstance = new MultiProjectDashboard(options);
  }
  return dashboardInstance;
}

/**
 * Reset dashboard (for testing)
 */
function resetDashboard() {
  dashboardInstance = null;
}

module.exports = {
  MultiProjectDashboard,
  getMultiProjectDashboard,
  resetDashboard,
  PROJECT_STATUS,
  METRIC_TYPES,
};
