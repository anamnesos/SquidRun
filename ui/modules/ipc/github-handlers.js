/**
 * GitHub IPC Handlers
 * Channels:
 * - github:create-pr
 * - github:build-pr-body
 * - github:update-pr
 * - github:get-pr
 * - github:list-prs
 * - github:merge-pr
 * - github:create-issue
 * - github:get-issue
 * - github:list-issues
 * - github:close-issue
 * - github:comment-issue
 * - github:get-checks
 * - github:get-runs
 * - github:get-repo
 * - github:auth-status
 */

const { createGitHubService } = require('../main/github-service');

const GITHUB_CHANNEL_ACTIONS = new Map([
  ['github:create-pr', 'createPR'],
  ['github:build-pr-body', 'buildPRBody'],
  ['github:update-pr', 'updatePR'],
  ['github:get-pr', 'getPR'],
  ['github:list-prs', 'listPRs'],
  ['github:merge-pr', 'mergePR'],
  ['github:create-issue', 'createIssue'],
  ['github:get-issue', 'getIssue'],
  ['github:list-issues', 'listIssues'],
  ['github:close-issue', 'closeIssue'],
  ['github:comment-issue', 'addIssueComment'],
  ['github:get-checks', 'getChecks'],
  ['github:get-runs', 'getWorkflowRuns'],
  ['github:get-repo', 'getRepo'],
  ['github:auth-status', 'getAuthStatus'],
]);

function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function asNullableString(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAction(action) {
  const raw = asNullableString(action)?.toLowerCase();
  if (!raw) return null;

  if (raw === 'status') return 'status';
  if (raw === 'create-pr' || raw === 'pr.create' || raw === 'pr_create') return 'createPR';
  if (raw === 'build-pr-body' || raw === 'pr.create-auto' || raw === 'pr.build-body' || raw === 'pr_build_body') return 'buildPRBody';
  if (raw === 'update-pr' || raw === 'pr.update' || raw === 'pr_update') return 'updatePR';
  if (raw === 'get-pr' || raw === 'pr.get' || raw === 'pr_get') return 'getPR';
  if (raw === 'list-prs' || raw === 'pr.list' || raw === 'pr_list') return 'listPRs';
  if (raw === 'merge-pr' || raw === 'pr.merge' || raw === 'pr_merge') return 'mergePR';
  if (raw === 'create-issue' || raw === 'issue.create' || raw === 'issue_create') return 'createIssue';
  if (raw === 'get-issue' || raw === 'issue.get' || raw === 'issue_get') return 'getIssue';
  if (raw === 'list-issues' || raw === 'issue.list' || raw === 'issue_list') return 'listIssues';
  if (raw === 'close-issue' || raw === 'issue.close' || raw === 'issue_close') return 'closeIssue';
  if (raw === 'comment-issue' || raw === 'issue.comment' || raw === 'issue_comment') return 'addIssueComment';
  if (raw === 'get-checks' || raw === 'checks') return 'getChecks';
  if (raw === 'get-runs' || raw === 'runs') return 'getWorkflowRuns';
  if (raw === 'get-repo' || raw === 'repo') return 'getRepo';
  if (raw === 'auth-status' || raw === 'auth') return 'getAuthStatus';

  for (const channelAction of GITHUB_CHANNEL_ACTIONS.values()) {
    if (raw === String(channelAction).toLowerCase()) {
      return channelAction;
    }
  }

  return null;
}

function resolveGitHubService(ctx, explicitService = null) {
  if (explicitService) return explicitService;
  if (ctx && ctx.githubService) return ctx.githubService;
  const service = createGitHubService({
    cwd: ctx?.WORKSPACE_PATH || process.cwd(),
  });
  if (ctx) {
    ctx.githubService = service;
  }
  return service;
}

function extractId(payload, candidates = []) {
  for (const key of candidates) {
    const value = asNullableString(payload[key]);
    if (value) return value;
  }
  return null;
}

async function executeGitHubOperation(action, payload = {}, options = {}) {
  const normalizedAction = normalizeAction(action);
  const normalizedPayload = asObject(payload);
  const service = resolveGitHubService(options.ctx || {}, options.githubService || null);

  if (!normalizedAction) {
    return {
      ok: false,
      reason: 'unknown_action',
      action: asNullableString(action) || action || null,
    };
  }

  try {
    switch (normalizedAction) {
      case 'status': {
        const auth = await service.getAuthStatus();
        let repo = null;
        let repoError = null;
        try {
          repo = await service.getRepo();
        } catch (err) {
          repoError = err.message;
        }
        return {
          ok: true,
          action: normalizedAction,
          auth,
          repo,
          repoError,
        };
      }
      case 'createPR':
        return { ok: true, action: normalizedAction, pr: await service.createPR(normalizedPayload) };
      case 'buildPRBody':
        return { ok: true, action: normalizedAction, body: await service.buildPRBody(normalizedPayload) };
      case 'updatePR': {
        const number = extractId(normalizedPayload, ['number', 'prNumber', 'id', 'pullNumber', 'pullRequestNumber']);
        if (!number) return { ok: false, action: normalizedAction, reason: 'missing_pr_number' };
        return { ok: true, action: normalizedAction, pr: await service.updatePR(number, normalizedPayload) };
      }
      case 'getPR': {
        const number = extractId(normalizedPayload, ['number', 'prNumber', 'id', 'pullNumber', 'pullRequestNumber']);
        if (!number) return { ok: false, action: normalizedAction, reason: 'missing_pr_number' };
        return { ok: true, action: normalizedAction, pr: await service.getPR(number) };
      }
      case 'listPRs':
        return { ok: true, action: normalizedAction, items: await service.listPRs(normalizedPayload) };
      case 'mergePR': {
        const number = extractId(normalizedPayload, ['number', 'prNumber', 'id', 'pullNumber', 'pullRequestNumber']);
        if (!number) return { ok: false, action: normalizedAction, reason: 'missing_pr_number' };
        return { ok: true, action: normalizedAction, result: await service.mergePR(number, normalizedPayload) };
      }
      case 'createIssue':
        return { ok: true, action: normalizedAction, issue: await service.createIssue(normalizedPayload) };
      case 'getIssue': {
        const number = extractId(normalizedPayload, ['number', 'issueNumber', 'id']);
        if (!number) return { ok: false, action: normalizedAction, reason: 'missing_issue_number' };
        return { ok: true, action: normalizedAction, issue: await service.getIssue(number) };
      }
      case 'listIssues':
        return { ok: true, action: normalizedAction, items: await service.listIssues(normalizedPayload) };
      case 'closeIssue': {
        const number = extractId(normalizedPayload, ['number', 'issueNumber', 'id']);
        if (!number) return { ok: false, action: normalizedAction, reason: 'missing_issue_number' };
        return { ok: true, action: normalizedAction, issue: await service.closeIssue(number) };
      }
      case 'addIssueComment': {
        const number = extractId(normalizedPayload, ['number', 'issueNumber', 'id']);
        const body = asNullableString(normalizedPayload.body || normalizedPayload.comment || normalizedPayload.message);
        if (!number) return { ok: false, action: normalizedAction, reason: 'missing_issue_number' };
        if (!body) return { ok: false, action: normalizedAction, reason: 'missing_comment_body' };
        return { ok: true, action: normalizedAction, comment: await service.addIssueComment(number, body) };
      }
      case 'getChecks':
        return { ok: true, action: normalizedAction, items: await service.getChecks(normalizedPayload) };
      case 'getWorkflowRuns':
        return { ok: true, action: normalizedAction, items: await service.getWorkflowRuns(normalizedPayload) };
      case 'getRepo':
        return { ok: true, action: normalizedAction, repo: await service.getRepo() };
      case 'getAuthStatus':
        return { ok: true, action: normalizedAction, auth: await service.getAuthStatus() };
      default:
        return { ok: false, action: normalizedAction, reason: 'unknown_action' };
    }
  } catch (err) {
    return {
      ok: false,
      action: normalizedAction,
      reason: err?.reason || 'operation_failed',
      error: err?.message || String(err),
    };
  }
}

function registerGitHubHandlers(ctx) {
  if (!ctx || !ctx.ipcMain) {
    throw new Error('registerGitHubHandlers requires ctx.ipcMain');
  }

  const { ipcMain } = ctx;
  for (const [channel, action] of GITHUB_CHANNEL_ACTIONS.entries()) {
    ipcMain.handle(channel, async (event, payload = {}) =>
      executeGitHubOperation(action, payload, { ctx })
    );
  }
}

function unregisterGitHubHandlers(ctx) {
  const { ipcMain } = ctx || {};
  if (!ipcMain) return;
  for (const channel of GITHUB_CHANNEL_ACTIONS.keys()) {
    ipcMain.removeHandler(channel);
  }
}

registerGitHubHandlers.unregister = unregisterGitHubHandlers;

module.exports = {
  GITHUB_CHANNEL_ACTIONS,
  executeGitHubOperation,
  registerGitHubHandlers,
  unregisterGitHubHandlers,
  normalizeAction,
};
