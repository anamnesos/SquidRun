const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

function asTrimmedString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function asNullableString(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function createValidationError(message, context = 'validation') {
  const err = new Error(message);
  err.name = 'GitHubServiceValidationError';
  err.reason = 'invalid_input';
  err.context = context;
  return err;
}

function isUnsupportedJsonFlagError(err) {
  const text = `${err?.message || ''}\n${err?.stderr || ''}`.toLowerCase();
  return text.includes('unknown flag: --json') || text.includes('accepts 0 arg');
}

function normalizeMergeMethod(method) {
  const normalized = asTrimmedString(String(method || 'merge')).toLowerCase();
  if (normalized === 'merge' || normalized === 'squash' || normalized === 'rebase') {
    return normalized;
  }
  return null;
}

function normalizePullRequest(pr) {
  const checks = Array.isArray(pr?.statusCheckRollup)
    ? pr.statusCheckRollup.map((entry) => ({
      name: entry?.name || entry?.context || null,
      status: entry?.status || null,
      conclusion: entry?.conclusion || null,
      url: entry?.detailsUrl || entry?.url || null,
    }))
    : [];

  return {
    number: Number.isFinite(pr?.number) ? pr.number : null,
    title: pr?.title ?? null,
    body: pr?.body ?? null,
    state: pr?.state ?? null,
    draft: Boolean(pr?.isDraft),
    url: asNullableString(pr?.url),
    html_url: asNullableString(pr?.url),
    head: asNullableString(pr?.headRefName),
    base: asNullableString(pr?.baseRefName),
    mergeable: pr?.mergeable ?? pr?.mergeStateStatus ?? null,
    author: asNullableString(pr?.author?.login),
    checks,
  };
}

function normalizeIssue(issue) {
  const labels = Array.isArray(issue?.labels)
    ? issue.labels
      .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
      .filter(Boolean)
    : [];
  const assignees = Array.isArray(issue?.assignees)
    ? issue.assignees.map((entry) => asNullableString(entry?.login)).filter(Boolean)
    : [];

  return {
    number: Number.isFinite(issue?.number) ? issue.number : null,
    title: issue?.title ?? null,
    body: issue?.body ?? null,
    state: issue?.state ?? null,
    url: asNullableString(issue?.url),
    html_url: asNullableString(issue?.url),
    author: asNullableString(issue?.author?.login),
    labels,
    assignees,
  };
}

function normalizeErrorReason(err, combinedText = '') {
  if (err && err.code === 'ENOENT') return 'gh_not_installed';

  const lower = String(combinedText || '').toLowerCase();
  if (
    lower.includes('gh auth login')
    || lower.includes('not logged into')
    || lower.includes('authentication required')
    || lower.includes('requires authentication')
    || lower.includes('http 401')
  ) {
    return 'not_authenticated';
  }

  if (
    lower.includes('not a git repository')
    || lower.includes('could not determine repository')
    || lower.includes('no git remotes configured')
  ) {
    return 'not_a_repository';
  }

  return 'gh_command_failed';
}

function toGhError(err, context = 'gh') {
  const stdout = asTrimmedString(err && err.stdout);
  const stderr = asTrimmedString(err && err.stderr);
  const rawMessage = asTrimmedString(err && err.message);
  const combined = `${stderr}\n${stdout}\n${rawMessage}`.trim();
  const reason = normalizeErrorReason(err, combined);

  const message = combined || `GitHub CLI command failed (${context})`;
  const wrapped = new Error(message);
  wrapped.name = 'GitHubServiceError';
  wrapped.reason = reason;
  wrapped.context = context;
  wrapped.stdout = stdout;
  wrapped.stderr = stderr;
  wrapped.exitCode = typeof err?.code === 'number' ? err.code : null;
  wrapped.rawCode = err?.code;
  return wrapped;
}

function execAsync(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: DEFAULT_MAX_BUFFER,
        timeout: DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        ...options,
      },
      (err, stdout, stderr) => {
        if (err) {
          if (err.stdout == null) err.stdout = stdout;
          if (err.stderr == null) err.stderr = stderr;
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function createGitHubService(options = {}) {
  const baseCwd = options.cwd || process.cwd();
  const command = asTrimmedString(options.command) || 'gh';

  async function runGh(args = [], runOptions = {}) {
    const context = runOptions.context || args.join(' ');
    try {
      const result = await execAsync(command, args, {
        cwd: runOptions.cwd || baseCwd,
        timeout: Number.isFinite(runOptions.timeoutMs) ? runOptions.timeoutMs : DEFAULT_TIMEOUT_MS,
        maxBuffer: Number.isFinite(runOptions.maxBuffer) ? runOptions.maxBuffer : DEFAULT_MAX_BUFFER,
      });
      return result;
    } catch (err) {
      throw toGhError(err, context);
    }
  }

  async function runGhJson(args = [], runOptions = {}) {
    const { stdout } = await runGh(args, runOptions);
    const trimmed = asTrimmedString(stdout);
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed);
    } catch (err) {
      const parseError = new Error(`Failed to parse gh JSON output: ${err.message}`);
      parseError.name = 'GitHubServiceParseError';
      parseError.reason = 'invalid_json';
      parseError.stdout = trimmed;
      throw parseError;
    }
  }

  async function getAuthStatus() {
    try {
      await runGh(['auth', 'status', '--hostname', 'github.com'], { context: 'auth-status' });
    } catch (err) {
      if (err.reason === 'gh_not_installed' || err.reason === 'not_authenticated') {
        return {
          authenticated: false,
          reason: err.reason,
          error: err.message,
        };
      }
      return {
        authenticated: false,
        reason: err.reason || 'gh_command_failed',
        error: err.message,
      };
    }

    let viewer = null;
    try {
      viewer = await runGhJson(['api', 'user'], { context: 'auth-user' });
    } catch {
      // auth is already confirmed; user details are best-effort
    }

    return {
      authenticated: true,
      reason: 'ok',
      hostname: 'github.com',
      login: viewer?.login || null,
      url: viewer?.html_url || null,
      name: viewer?.name || null,
    };
  }

  async function getRepo() {
    const repo = await runGhJson(
      ['repo', 'view', '--json', 'name,nameWithOwner,owner,defaultBranchRef,url'],
      { context: 'get-repo' }
    );

    const fullName = asTrimmedString(repo?.nameWithOwner);
    const ownerFromSplit = fullName.includes('/') ? fullName.split('/')[0] : '';
    const repoFromSplit = fullName.includes('/') ? fullName.split('/')[1] : '';

    return {
      owner: asTrimmedString(repo?.owner?.login) || ownerFromSplit || null,
      repo: asTrimmedString(repo?.name) || repoFromSplit || null,
      full_name: fullName || null,
      default_branch: asTrimmedString(repo?.defaultBranchRef?.name) || null,
      url: asTrimmedString(repo?.url) || null,
    };
  }

  async function listPRs(filters = {}) {
    const args = [
      'pr',
      'list',
      '--state',
      asTrimmedString(filters.state || 'open') || 'open',
      '--json',
      'number,title,body,state,isDraft,url,headRefName,baseRefName,mergeStateStatus,mergeable,author',
    ];
    if (asNullableString(filters.head)) args.push('--head', asTrimmedString(filters.head));
    if (asNullableString(filters.base)) args.push('--base', asTrimmedString(filters.base));
    if (Number.isFinite(filters.limit)) args.push('--limit', String(Math.max(1, Math.floor(filters.limit))));

    const list = await runGhJson(args, { context: 'pr-list' });
    return Array.isArray(list) ? list.map(normalizePullRequest) : [];
  }

  async function getPR(numberOrRef) {
    const ref = asNullableString(numberOrRef);
    if (!ref) {
      throw createValidationError('PR number/ref is required', 'pr-get');
    }

    const pr = await runGhJson(
      [
        'pr',
        'view',
        ref,
        '--json',
        'number,title,body,state,isDraft,url,headRefName,baseRefName,mergeStateStatus,mergeable,statusCheckRollup,author',
      ],
      { context: 'pr-get' }
    );
    return normalizePullRequest(pr || {});
  }

  async function createPR(input = {}) {
    const title = asNullableString(input.title);
    if (!title) {
      throw createValidationError('PR title is required', 'pr-create');
    }

    const args = ['pr', 'create', '--title', title, '--body', String(input.body || '')];
    if (asNullableString(input.base)) args.push('--base', asTrimmedString(input.base));
    if (asNullableString(input.head)) args.push('--head', asTrimmedString(input.head));
    if (input.draft === true) args.push('--draft');

    try {
      const created = await runGhJson(
        [...args, '--json', 'number,url'],
        { context: 'pr-create' }
      );
      const ref = created?.number || created?.url;
      if (ref) {
        return getPR(String(ref));
      }
      return {
        number: Number.isFinite(created?.number) ? created.number : null,
        url: asNullableString(created?.url),
        html_url: asNullableString(created?.url),
      };
    } catch (err) {
      if (!isUnsupportedJsonFlagError(err)) {
        throw err;
      }
    }

    const { stdout } = await runGh(args, { context: 'pr-create' });
    const urlMatch = String(stdout || '').match(/https?:\/\/\S+/);
    const fallbackUrl = urlMatch ? urlMatch[0].trim() : null;
    if (!fallbackUrl) {
      return { number: null, url: null, html_url: null };
    }

    try {
      return await getPR(fallbackUrl);
    } catch {
      return { number: null, url: fallbackUrl, html_url: fallbackUrl };
    }
  }

  async function updatePR(numberOrRef, updates = {}) {
    const ref = asNullableString(numberOrRef);
    if (!ref) {
      throw createValidationError('PR number/ref is required', 'pr-update');
    }

    const editArgs = ['pr', 'edit', ref];
    if (asNullableString(updates.title)) editArgs.push('--title', asTrimmedString(updates.title));
    if (typeof updates.body === 'string') editArgs.push('--body', updates.body);
    if (asNullableString(updates.base)) editArgs.push('--base', asTrimmedString(updates.base));

    if (editArgs.length > 3) {
      await runGh(editArgs, { context: 'pr-update' });
    }

    const state = asNullableString(updates.state)?.toLowerCase() || null;
    if (state === 'closed') {
      await runGh(['pr', 'close', ref], { context: 'pr-update-close' });
    } else if (state === 'open') {
      await runGh(['pr', 'reopen', ref], { context: 'pr-update-reopen' });
    } else if (state && state !== 'merged') {
      throw createValidationError(`Unsupported PR state: ${state}`, 'pr-update');
    }

    return getPR(ref);
  }

  async function mergePR(numberOrRef, options = {}) {
    const ref = asNullableString(numberOrRef);
    if (!ref) {
      throw createValidationError('PR number/ref is required', 'pr-merge');
    }

    const method = normalizeMergeMethod(options.method || 'merge');
    if (!method) {
      throw createValidationError('Merge method must be merge, squash, or rebase', 'pr-merge');
    }

    const methodFlag = method === 'merge'
      ? '--merge'
      : method === 'squash'
        ? '--squash'
        : '--rebase';
    const args = ['pr', 'merge', ref, methodFlag];

    if (options.deleteBranch !== false) {
      args.push('--delete-branch');
    }
    if (options.auto === true) {
      args.push('--auto');
    }

    const { stdout } = await runGh(args, { context: 'pr-merge' });
    return {
      merged: true,
      number: Number.isFinite(Number(ref)) ? Number(ref) : null,
      method,
      message: asNullableString(stdout) || 'merged',
    };
  }

  function extractCsvValues(raw) {
    if (Array.isArray(raw)) {
      return raw.map((item) => asTrimmedString(String(item || ''))).filter(Boolean);
    }
    if (typeof raw === 'string') {
      return raw
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
    return [];
  }

  async function listIssues(filters = {}) {
    const args = [
      'issue',
      'list',
      '--state',
      asTrimmedString(filters.state || 'open') || 'open',
      '--json',
      'number,title,body,state,url,labels,assignees,author',
    ];

    const labels = extractCsvValues(filters.labels);
    for (const label of labels) {
      args.push('--label', label);
    }
    if (Number.isFinite(filters.limit)) {
      args.push('--limit', String(Math.max(1, Math.floor(filters.limit))));
    }

    const list = await runGhJson(args, { context: 'issue-list' });
    return Array.isArray(list) ? list.map(normalizeIssue) : [];
  }

  async function getIssue(numberOrRef) {
    const ref = asNullableString(numberOrRef);
    if (!ref) {
      throw createValidationError('Issue number/ref is required', 'issue-get');
    }

    const issue = await runGhJson(
      ['issue', 'view', ref, '--json', 'number,title,body,state,url,labels,assignees,author'],
      { context: 'issue-get' }
    );
    return normalizeIssue(issue || {});
  }

  async function createIssue(input = {}) {
    const title = asNullableString(input.title);
    if (!title) {
      throw createValidationError('Issue title is required', 'issue-create');
    }

    const args = ['issue', 'create', '--title', title, '--body', String(input.body || '')];
    for (const label of extractCsvValues(input.labels)) {
      args.push('--label', label);
    }
    for (const assignee of extractCsvValues(input.assignees)) {
      args.push('--assignee', assignee);
    }

    try {
      const created = await runGhJson(
        [...args, '--json', 'number,url'],
        { context: 'issue-create' }
      );
      const ref = created?.number || created?.url;
      if (ref) {
        return getIssue(String(ref));
      }
      return normalizeIssue(created || {});
    } catch (err) {
      if (!isUnsupportedJsonFlagError(err)) {
        throw err;
      }
    }

    const { stdout } = await runGh(args, { context: 'issue-create' });
    const urlMatch = String(stdout || '').match(/https?:\/\/\S+/);
    const fallbackUrl = urlMatch ? urlMatch[0].trim() : null;
    if (!fallbackUrl) {
      return {
        number: null,
        title,
        body: input.body || '',
        state: 'OPEN',
        url: null,
        html_url: null,
        author: null,
        labels: extractCsvValues(input.labels),
        assignees: extractCsvValues(input.assignees),
      };
    }

    try {
      return await getIssue(fallbackUrl);
    } catch {
      return {
        number: null,
        title,
        body: input.body || '',
        state: 'OPEN',
        url: fallbackUrl,
        html_url: fallbackUrl,
        author: null,
        labels: extractCsvValues(input.labels),
        assignees: extractCsvValues(input.assignees),
      };
    }
  }

  async function closeIssue(numberOrRef) {
    const ref = asNullableString(numberOrRef);
    if (!ref) {
      throw createValidationError('Issue number/ref is required', 'issue-close');
    }

    await runGh(['issue', 'close', ref], { context: 'issue-close' });
    return getIssue(ref);
  }

  async function addIssueComment(numberOrRef, body) {
    const ref = asNullableString(numberOrRef);
    if (!ref) {
      throw createValidationError('Issue number/ref is required', 'issue-comment');
    }
    if (!asNullableString(body)) {
      throw createValidationError('Issue comment body is required', 'issue-comment');
    }

    const args = ['issue', 'comment', ref, '--body', String(body)];
    try {
      const comment = await runGhJson([...args, '--json', 'id,url'], { context: 'issue-comment' });
      return {
        id: comment?.id ?? null,
        url: asNullableString(comment?.url),
      };
    } catch (err) {
      if (!isUnsupportedJsonFlagError(err)) {
        throw err;
      }
    }

    const { stdout } = await runGh(args, { context: 'issue-comment' });
    const urlMatch = String(stdout || '').match(/https?:\/\/\S+/);
    return {
      id: null,
      url: urlMatch ? urlMatch[0].trim() : null,
    };
  }

  async function getChecks(options = {}) {
    const ref = asNullableString(options.ref) || 'HEAD';
    const repo = await getRepo();
    if (!repo?.owner || !repo?.repo) {
      throw createValidationError('Repository metadata is required for checks', 'checks');
    }

    const payload = await runGhJson(
      ['api', `repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}/check-runs`],
      { context: 'checks' }
    );
    const checkRuns = Array.isArray(payload?.check_runs) ? payload.check_runs : [];

    return checkRuns.map((entry) => ({
      name: entry?.name || null,
      status: entry?.status || null,
      conclusion: entry?.conclusion || null,
      url: asNullableString(entry?.html_url) || asNullableString(entry?.url) || null,
    }));
  }

  async function getWorkflowRuns(filters = {}) {
    const args = [
      'run',
      'list',
      '--json',
      'databaseId,name,workflowName,status,conclusion,url,headBranch,headSha,event,createdAt,updatedAt',
    ];
    if (asNullableString(filters.branch)) {
      args.push('--branch', asTrimmedString(filters.branch));
    }
    if (asNullableString(filters.status)) {
      args.push('--status', asTrimmedString(filters.status));
    }
    if (Number.isFinite(filters.limit)) {
      args.push('--limit', String(Math.max(1, Math.floor(filters.limit))));
    }

    const runs = await runGhJson(args, { context: 'runs' });
    return Array.isArray(runs)
      ? runs.map((entry) => ({
        id: Number.isFinite(entry?.databaseId) ? entry.databaseId : null,
        name: entry?.name || null,
        workflow: entry?.workflowName || null,
        status: entry?.status || null,
        conclusion: entry?.conclusion || null,
        url: asNullableString(entry?.url),
        branch: asNullableString(entry?.headBranch),
        sha: asNullableString(entry?.headSha),
        event: asNullableString(entry?.event),
        created_at: asNullableString(entry?.createdAt),
        updated_at: asNullableString(entry?.updatedAt),
      }))
      : [];
  }

  return {
    runGh,
    runGhJson,
    getAuthStatus,
    checkAuth: getAuthStatus,
    getRepo,
    createPR,
    updatePR,
    getPR,
    listPRs,
    mergePR,
    createIssue,
    getIssue,
    listIssues,
    closeIssue,
    addIssueComment,
    getChecks,
    getWorkflowRuns,
  };
}

module.exports = {
  createGitHubService,
  execAsync,
  toGhError,
};
