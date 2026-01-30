/**
 * AI-Powered Code Review - Task #18
 *
 * Analyzes code diffs using LLM to provide:
 * - Code quality suggestions
 * - Security vulnerability detection
 * - Performance improvement recommendations
 * - Style and best practice feedback
 * - Bug detection
 *
 * Supports multiple analysis backends:
 * 1. Anthropic API (if ANTHROPIC_API_KEY available)
 * 2. Local rule-based analysis (fallback)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Review categories
const CATEGORIES = {
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  BUG: 'bug',
  STYLE: 'style',
  BEST_PRACTICE: 'best_practice',
  DOCUMENTATION: 'documentation',
  COMPLEXITY: 'complexity',
  ERROR_HANDLING: 'error_handling',
};

// Severity levels
const SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
};

// Local analysis patterns (fallback when API unavailable)
const LOCAL_PATTERNS = {
  security: [
    { pattern: /eval\s*\(/gi, message: 'Avoid using eval() - security risk', severity: SEVERITY.CRITICAL },
    { pattern: /innerHTML\s*=/gi, message: 'innerHTML assignment may be XSS vulnerable', severity: SEVERITY.HIGH },
    { pattern: /password|secret|apikey|api_key/gi, message: 'Potential hardcoded credential', severity: SEVERITY.CRITICAL },
    { pattern: /exec\s*\(/gi, message: 'Shell execution may be injection vulnerable', severity: SEVERITY.HIGH },
    { pattern: /dangerouslySetInnerHTML/gi, message: 'dangerouslySetInnerHTML may be XSS vulnerable', severity: SEVERITY.HIGH },
    { pattern: /\.sql\s*=|query\s*\+/gi, message: 'Potential SQL injection vulnerability', severity: SEVERITY.CRITICAL },
  ],
  performance: [
    { pattern: /\.forEach\s*\([^)]*=>/gi, message: 'Consider using for...of for better performance', severity: SEVERITY.LOW },
    { pattern: /JSON\.parse\(JSON\.stringify/gi, message: 'Deep clone via JSON is slow, consider structuredClone()', severity: SEVERITY.MEDIUM },
    { pattern: /new RegExp\(/gi, message: 'Consider using regex literal for better performance', severity: SEVERITY.LOW },
    { pattern: /document\.querySelector.*loop|for.*document\.querySelector/gi, message: 'DOM query in loop - cache the reference', severity: SEVERITY.MEDIUM },
  ],
  bug: [
    { pattern: /===\s*undefined\s*\|\|\s*===\s*null|===\s*null\s*\|\|\s*===\s*undefined/gi, message: 'Use == null for null/undefined check', severity: SEVERITY.LOW },
    { pattern: /catch\s*\(\s*\)\s*\{[\s\S]*?\}/gi, message: 'Empty catch block may hide errors', severity: SEVERITY.MEDIUM },
    { pattern: /console\.(log|error|warn|info)\s*\(/gi, message: 'Remove console statements before production', severity: SEVERITY.LOW },
    { pattern: /TODO|FIXME|HACK|XXX/gi, message: 'Unresolved TODO/FIXME comment', severity: SEVERITY.INFO },
  ],
  style: [
    { pattern: /var\s+/gi, message: 'Prefer const/let over var', severity: SEVERITY.LOW },
    { pattern: /function\s+\w+\s*\([^)]*\)\s*\{/gi, message: 'Consider using arrow functions for consistency', severity: SEVERITY.INFO },
    { pattern: /\t/g, message: 'Mixed tabs and spaces detected', severity: SEVERITY.INFO },
  ],
  errorHandling: [
    { pattern: /\.then\s*\([^)]+\)\s*[^.]*$/gim, message: 'Promise chain missing .catch() handler', severity: SEVERITY.MEDIUM },
    { pattern: /async\s+function[^{]+\{(?![^}]*try)/gi, message: 'Async function without try/catch', severity: SEVERITY.LOW },
    { pattern: /throw\s+['"][^'"]+['"]/gi, message: 'Throw Error objects, not strings', severity: SEVERITY.LOW },
  ],
};

/**
 * Main review class
 */
class CodeReviewer {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
    this.model = options.model || 'claude-3-5-sonnet-20241022';
    this.maxDiffSize = options.maxDiffSize || 50000; // Characters
    this.enabledCategories = options.categories || Object.values(CATEGORIES);
    this.useAI = options.useAI !== false && !!this.apiKey;
  }

  /**
   * Review a git diff
   */
  async reviewDiff(diff, options = {}) {
    const { projectPath, mode = 'all' } = options;

    if (!diff || diff.trim().length === 0) {
      return {
        success: true,
        issues: [],
        summary: 'No changes to review',
        stats: { total: 0, bySeverity: {}, byCategory: {} },
      };
    }

    // Truncate large diffs
    const truncatedDiff = diff.length > this.maxDiffSize
      ? diff.slice(0, this.maxDiffSize) + '\n... [truncated]'
      : diff;

    let issues = [];

    // Run local pattern analysis (always)
    const localIssues = this.runLocalAnalysis(truncatedDiff);
    issues.push(...localIssues);

    // Run AI analysis if available
    if (this.useAI) {
      try {
        const aiIssues = await this.runAIAnalysis(truncatedDiff, options);
        issues.push(...aiIssues);
      } catch (err) {
        console.error('[CodeReview] AI analysis failed:', err.message);
        // Continue with local results only
      }
    }

    // Deduplicate issues
    issues = this.deduplicateIssues(issues);

    // Sort by severity
    issues.sort((a, b) => {
      const order = [SEVERITY.CRITICAL, SEVERITY.HIGH, SEVERITY.MEDIUM, SEVERITY.LOW, SEVERITY.INFO];
      return order.indexOf(a.severity) - order.indexOf(b.severity);
    });

    // Generate stats
    const stats = this.calculateStats(issues);

    // Generate summary
    const summary = this.generateSummary(issues, stats);

    return {
      success: true,
      issues,
      summary,
      stats,
      usedAI: this.useAI,
      truncated: diff.length > this.maxDiffSize,
    };
  }

  /**
   * Run local pattern-based analysis
   */
  runLocalAnalysis(diff) {
    const issues = [];
    const lines = diff.split('\n');

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      // Only analyze added lines (start with +)
      if (!line.startsWith('+') || line.startsWith('+++')) continue;

      const content = line.slice(1); // Remove the + prefix

      // Find current file from diff context
      let currentFile = 'unknown';
      for (let i = lineNum; i >= 0; i--) {
        const match = lines[i].match(/^\+\+\+ b\/(.+)/);
        if (match) {
          currentFile = match[1];
          break;
        }
      }

      // Check each category's patterns
      for (const [category, patterns] of Object.entries(LOCAL_PATTERNS)) {
        for (const rule of patterns) {
          if (rule.pattern.test(content)) {
            issues.push({
              id: `local-${category}-${lineNum}-${Date.now()}`,
              category: this.mapCategory(category),
              severity: rule.severity,
              message: rule.message,
              file: currentFile,
              line: lineNum + 1,
              content: content.trim(),
              source: 'local',
            });
            // Reset regex lastIndex
            rule.pattern.lastIndex = 0;
          }
        }
      }
    }

    return issues;
  }

  /**
   * Run AI-powered analysis using Anthropic API
   */
  async runAIAnalysis(diff, options = {}) {
    if (!this.apiKey) return [];

    const prompt = this.buildReviewPrompt(diff, options);

    try {
      const response = await this.callAnthropicAPI(prompt);
      return this.parseAIResponse(response);
    } catch (err) {
      console.error('[CodeReview] AI call failed:', err);
      return [];
    }
  }

  /**
   * Build the review prompt for AI
   */
  buildReviewPrompt(diff, options = {}) {
    const categories = this.enabledCategories.join(', ');

    return `You are an expert code reviewer. Analyze the following git diff and identify issues.

Focus on these categories: ${categories}

For each issue found, respond with a JSON array of objects with this structure:
{
  "category": "security|performance|bug|style|best_practice|documentation|complexity|error_handling",
  "severity": "critical|high|medium|low|info",
  "message": "Brief description of the issue",
  "file": "filename if identifiable",
  "line": "approximate line number if identifiable",
  "suggestion": "How to fix the issue"
}

Be specific and actionable. Only report real issues, not style preferences unless they affect readability.
Focus on added lines (starting with +).

DIFF:
\`\`\`
${diff}
\`\`\`

Respond with ONLY a JSON array of issues. If no issues found, respond with [].`;
  }

  /**
   * Call Anthropic API
   */
  async callAnthropicAPI(prompt) {
    const https = require('https');

    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      const options = {
        hostname: 'api.anthropic.com',
        port: 443,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 60000,
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(body);
            if (response.error) {
              reject(new Error(response.error.message));
            } else {
              const content = response.content?.[0]?.text || '';
              resolve(content);
            }
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => reject(new Error('API timeout')));
      req.write(data);
      req.end();
    });
  }

  /**
   * Parse AI response into issues
   */
  parseAIResponse(response) {
    try {
      // Extract JSON from response (may be wrapped in markdown code blocks)
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      const issues = JSON.parse(jsonStr.trim());

      if (!Array.isArray(issues)) {
        return [];
      }

      return issues.map((issue, idx) => ({
        id: `ai-${idx}-${Date.now()}`,
        category: issue.category || CATEGORIES.BEST_PRACTICE,
        severity: issue.severity || SEVERITY.MEDIUM,
        message: issue.message || 'Issue detected',
        file: issue.file || 'unknown',
        line: issue.line || null,
        suggestion: issue.suggestion || null,
        source: 'ai',
      }));
    } catch (err) {
      console.error('[CodeReview] Failed to parse AI response:', err);
      return [];
    }
  }

  /**
   * Deduplicate similar issues
   */
  deduplicateIssues(issues) {
    const seen = new Map();

    return issues.filter(issue => {
      const key = `${issue.file}:${issue.line}:${issue.category}:${issue.message.slice(0, 50)}`;
      if (seen.has(key)) {
        // Keep the one with higher severity or more detail
        const existing = seen.get(key);
        if (issue.source === 'ai' && existing.source !== 'ai') {
          seen.set(key, issue);
          return false;
        }
        return false;
      }
      seen.set(key, issue);
      return true;
    });
  }

  /**
   * Map local category names to standard categories
   */
  mapCategory(category) {
    const map = {
      security: CATEGORIES.SECURITY,
      performance: CATEGORIES.PERFORMANCE,
      bug: CATEGORIES.BUG,
      style: CATEGORIES.STYLE,
      errorHandling: CATEGORIES.ERROR_HANDLING,
    };
    return map[category] || CATEGORIES.BEST_PRACTICE;
  }

  /**
   * Calculate review statistics
   */
  calculateStats(issues) {
    const stats = {
      total: issues.length,
      bySeverity: {},
      byCategory: {},
      bySource: { local: 0, ai: 0 },
    };

    for (const issue of issues) {
      stats.bySeverity[issue.severity] = (stats.bySeverity[issue.severity] || 0) + 1;
      stats.byCategory[issue.category] = (stats.byCategory[issue.category] || 0) + 1;
      stats.bySource[issue.source]++;
    }

    return stats;
  }

  /**
   * Generate review summary
   */
  generateSummary(issues, stats) {
    if (issues.length === 0) {
      return 'No issues found. Code looks good!';
    }

    const parts = [];

    if (stats.bySeverity[SEVERITY.CRITICAL]) {
      parts.push(`${stats.bySeverity[SEVERITY.CRITICAL]} critical`);
    }
    if (stats.bySeverity[SEVERITY.HIGH]) {
      parts.push(`${stats.bySeverity[SEVERITY.HIGH]} high`);
    }
    if (stats.bySeverity[SEVERITY.MEDIUM]) {
      parts.push(`${stats.bySeverity[SEVERITY.MEDIUM]} medium`);
    }

    const lowCount = (stats.bySeverity[SEVERITY.LOW] || 0) + (stats.bySeverity[SEVERITY.INFO] || 0);
    if (lowCount > 0) {
      parts.push(`${lowCount} low/info`);
    }

    return `Found ${stats.total} issues: ${parts.join(', ')}`;
  }

  /**
   * Review specific files
   */
  async reviewFiles(files, projectPath) {
    const issues = [];

    for (const file of files) {
      const filePath = path.join(projectPath, file);
      if (!fs.existsSync(filePath)) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Create a pseudo-diff with all lines as additions
        const pseudoDiff = `+++ b/${file}\n` + content.split('\n').map(l => '+' + l).join('\n');
        const result = await this.reviewDiff(pseudoDiff, { projectPath });
        issues.push(...result.issues);
      } catch (err) {
        console.error(`[CodeReview] Failed to review ${file}:`, err);
      }
    }

    const stats = this.calculateStats(issues);
    const summary = this.generateSummary(issues, stats);

    return { success: true, issues, summary, stats };
  }

  /**
   * Get review for a specific commit
   */
  async reviewCommit(commitHash, projectPath) {
    try {
      const diff = execSync(`git show ${commitHash} --format="" --patch`, {
        cwd: projectPath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });

      return this.reviewDiff(diff, { projectPath });
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

/**
 * Create reviewer instance
 */
function createReviewer(options = {}) {
  return new CodeReviewer(options);
}

/**
 * Quick review function
 */
async function quickReview(diff, options = {}) {
  const reviewer = createReviewer(options);
  return reviewer.reviewDiff(diff, options);
}

module.exports = {
  CodeReviewer,
  createReviewer,
  quickReview,
  CATEGORIES,
  SEVERITY,
};
