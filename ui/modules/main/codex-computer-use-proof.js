'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const PROOF_ATTESTATION_SCHEMA = 'squidrun.codex_computer_use_post_tool_attestation.v1';
const PROOF_JOURNAL_SCHEMA = 'squidrun.codex_computer_use_post_tool_journal.v1';
const PROOF_PLAN_SCHEMA = 'squidrun.codex_computer_use_list_windows_plan.v2';
const LIST_WINDOWS_PROOF_SCHEMA = 'squidrun.codex_computer_use_list_windows_proof.v1';
const HOOK_TRUST_MANIFEST_SCHEMA = 'squidrun.codex_computer_use_hook_trust.v2';
const CANONICAL_NODE_REPL_TOOL_NAME = 'mcp__node_repl__js';
const DEFAULT_PROOF_TIMEOUT_MS = 90000;
const HOOK_EVENT_NAMES = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
]);

function optionalString(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizePath(value) {
  const text = optionalString(value, '');
  return text ? path.resolve(text) : '';
}

function pathsEqual(left, right, platform = process.platform) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (!a || !b) return false;
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// EXTRACTED, NOT COPIED. This rule is now shared with the v7 section 4 Telegram
// legacy cutover fence, which derives a content-addressed id from it. Two
// canonical encoders agree until one is edited, and the day they disagree two
// subsystems hash the same object to two digests and each looks internally
// consistent - so there is one implementation, in `canonical-json`, and this
// module consumes it. Behaviour here is unchanged; the CUA suites prove that
// rather than this comment.
const { canonicalJson, sha256 } = require('./canonical-json');

function sha256File(filePath, readFile = fs.readFileSync) {
  return sha256(readFile(filePath));
}

function hmacSha256(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function signaturesEqual(left, right) {
  if (!/^[0-9a-f]{64}$/iu.test(String(left || ''))
    || !/^[0-9a-f]{64}$/iu.test(String(right || ''))) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(String(left), 'hex'),
    Buffer.from(String(right), 'hex')
  );
}

function defaultRunFile(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        status: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
        error: error?.message || null,
        stdout: stdout || '',
        stderr: stderr || '',
      });
    });
  });
}

function defaultRunCodex(args, options = {}) {
  const explicit = optionalString(options.codexExecutable || process.env.CODEX_CLI_PATH, null);
  if (explicit) return (options.runFile || defaultRunFile)(explicit, args, options);
  if ((options.platform || process.platform) === 'win32') {
    return (options.runFile || defaultRunFile)(
      process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
      ['/d', '/s', '/c', 'codex.cmd', ...args],
      options
    );
  }
  return (options.runFile || defaultRunFile)('codex', args, options);
}

const CODEX_VENDOR_TARGETS = {
  'linux:x64': {
    packageName: 'codex-linux-x64',
    targetTriple: 'x86_64-unknown-linux-musl',
    binaryName: 'codex',
  },
  'linux:arm64': {
    packageName: 'codex-linux-arm64',
    targetTriple: 'aarch64-unknown-linux-musl',
    binaryName: 'codex',
  },
  'darwin:x64': {
    packageName: 'codex-darwin-x64',
    targetTriple: 'x86_64-apple-darwin',
    binaryName: 'codex',
  },
  'darwin:arm64': {
    packageName: 'codex-darwin-arm64',
    targetTriple: 'aarch64-apple-darwin',
    binaryName: 'codex',
  },
  'win32:x64': {
    packageName: 'codex-win32-x64',
    targetTriple: 'x86_64-pc-windows-msvc',
    binaryName: 'codex.exe',
  },
  'win32:arm64': {
    packageName: 'codex-win32-arm64',
    targetTriple: 'aarch64-pc-windows-msvc',
    binaryName: 'codex.exe',
  },
};

function realpathFile(filePath, options = {}) {
  const realpath = options.realpath
    || fs.realpathSync.native
    || fs.realpathSync;
  return realpath(filePath);
}

function pathIsInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveTrustedCodexExecutable(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const target = CODEX_VENDOR_TARGETS[`${platform}:${arch}`];
  if (!target) {
    return {
      ok: false,
      reason: 'codex_computer_use_executable_not_approved',
      error: `unsupported Codex target ${platform}:${arch}`,
    };
  }

  const exists = options.exists || fs.existsSync;
  const readFile = options.readFile || fs.readFileSync;
  const env = options.env || process.env;
  const packageRoots = [];
  const addPackageRoot = (candidate) => {
    const normalized = normalizePath(candidate);
    if (normalized && !packageRoots.includes(normalized)) packageRoots.push(normalized);
  };
  addPackageRoot(options.codexPackageRoot);
  addPackageRoot(env.CODEX_MANAGED_PACKAGE_ROOT);
  if (platform === 'win32' && env.APPDATA) {
    addPackageRoot(path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex'));
  }
  if (env.npm_config_prefix) {
    addPackageRoot(path.join(
      env.npm_config_prefix,
      platform === 'win32' ? 'node_modules' : path.join('lib', 'node_modules'),
      '@openai',
      'codex'
    ));
  }

  try {
    for (const packageRoot of packageRoots) {
      const packageManifestPath = path.join(packageRoot, 'package.json');
      if (!exists(packageManifestPath)) continue;
      const packageManifest = readJsonFile(packageManifestPath, readFile);
      if (packageManifest.name !== '@openai/codex'
        || !/^\d+\.\d+\.\d+(?:[-+].*)?$/u.test(String(packageManifest.version || ''))) {
        continue;
      }

      const platformRoots = [
        path.join(packageRoot, 'node_modules', '@openai', target.packageName),
        path.join(path.dirname(packageRoot), target.packageName),
      ];
      try {
        platformRoots.unshift(path.dirname(require.resolve(
          `@openai/${target.packageName}/package.json`,
          { paths: [packageRoot] }
        )));
      } catch (_) {
        // Fixed-layout candidates below cover npm installs without resolvable aliases.
      }
      const uniquePlatformRoots = Array.from(new Set(
        platformRoots.map((candidate) => normalizePath(candidate))
      ));
      for (const platformRoot of uniquePlatformRoots) {
        const platformManifestPath = path.join(platformRoot, 'package.json');
        if (!exists(platformManifestPath)) continue;
        const platformManifest = readJsonFile(platformManifestPath, readFile);
        if (platformManifest.name !== '@openai/codex'
          || !String(platformManifest.version || '').startsWith(
            `${packageManifest.version}-`
          )) {
          continue;
        }
        const executablePath = path.join(
          platformRoot,
          'vendor',
          target.targetTriple,
          'bin',
          target.binaryName
        );
        if (!exists(executablePath)) continue;
        const resolvedRoot = realpathFile(platformRoot, options);
        const resolvedPath = realpathFile(executablePath, options);
        if (!pathIsInside(resolvedRoot, resolvedPath)) continue;
        return {
          ok: true,
          reason: 'codex_computer_use_executable_approved',
          path: resolvedPath,
          sha256: sha256File(resolvedPath, readFile),
          packageVersion: packageManifest.version,
          platformPackageVersion: platformManifest.version,
          targetTriple: target.targetTriple,
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'codex_computer_use_executable_not_approved',
      error: error?.message || String(error),
    };
  }

  return {
    ok: false,
    reason: 'codex_computer_use_executable_not_approved',
    error: 'official Codex vendor executable was not found in an approved package layout',
  };
}

function recheckTrustedCodexExecutable(identity, options = {}) {
  const platform = options.platform || process.platform;
  const expectedPath = optionalString(identity?.path, '');
  const expectedSha256 = optionalString(identity?.sha256, '');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!expectedPath
    || !pathApi.isAbsolute(expectedPath)
    || !/^[0-9a-f]{64}$/iu.test(expectedSha256)) {
    return { ok: false, reason: 'codex_computer_use_executable_identity_invalid' };
  }
  try {
    const resolvedPath = realpathFile(expectedPath, options);
    const actualSha256 = sha256File(
      resolvedPath,
      options.readFile || fs.readFileSync
    );
    if (!pathsEqual(resolvedPath, expectedPath, platform)
      || actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      return { ok: false, reason: 'codex_computer_use_executable_drift' };
    }
    return {
      ok: true,
      path: resolvedPath,
      sha256: actualSha256,
    };
  } catch (_) {
    return { ok: false, reason: 'codex_computer_use_executable_drift' };
  }
}

function readJsonFile(filePath, readFile = fs.readFileSync) {
  return JSON.parse(readFile(filePath, 'utf8'));
}

function tokenizeLiteralHookCommand(command, sourceId) {
  const source = optionalString(command, '');
  if (!source || /[\0\r\n]/u.test(source)) {
    throw new Error(`${sourceId}: command hook target is empty or multiline`);
  }
  if (source.includes('$') || source.includes('`') || /%[^%]+%/u.test(source)) {
    throw new Error(`${sourceId}: dynamic command hook target is not trusted`);
  }
  const tokens = [];
  let token = '';
  let quote = null;
  const flush = () => {
    if (!token) return;
    tokens.push(token);
    token = '';
  };
  for (const character of source) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    if (/[;&|<>]/u.test(character)) {
      throw new Error(`${sourceId}: compound command hook target is not trusted`);
    }
    token += character;
  }
  if (quote) throw new Error(`${sourceId}: command hook target has an unterminated quote`);
  flush();
  if (tokens.length === 0) throw new Error(`${sourceId}: command hook target is missing`);
  return tokens;
}

function resolveLiteralCommandHookTarget(command, options = {}) {
  const sourceId = optionalString(options.sourceId, 'command-hook');
  const tokens = tokenizeLiteralHookCommand(command, sourceId);
  const runnerToken = tokens[0];
  const runnerName = path.basename(runnerToken).toLowerCase();
  let targetToken = null;
  let allowedExtensions = null;

  if (['node', 'node.exe'].includes(runnerName)) {
    if (!tokens[1] || tokens[1].startsWith('-')) {
      throw new Error(`${sourceId}: node command hook script target is unresolved`);
    }
    targetToken = tokens[1];
    allowedExtensions = new Set(['.js', '.cjs', '.mjs']);
  } else if (['bash', 'bash.exe', 'sh', 'sh.exe'].includes(runnerName)) {
    if (!tokens[1] || tokens[1].startsWith('-')) {
      throw new Error(`${sourceId}: shell command hook script target is unresolved`);
    }
    targetToken = tokens[1];
    allowedExtensions = new Set(['.sh']);
  } else if ([
    'pwsh',
    'pwsh.exe',
    'powershell',
    'powershell.exe',
  ].includes(runnerName)) {
    let index = 1;
    while (index < tokens.length) {
      const option = tokens[index].toLowerCase();
      if (['-noprofile', '-nologo', '-noninteractive'].includes(option)) {
        index += 1;
        continue;
      }
      if (option === '-executionpolicy') {
        if (!tokens[index + 1] || !/^[a-z]+$/iu.test(tokens[index + 1])) {
          throw new Error(`${sourceId}: PowerShell execution policy is unresolved`);
        }
        index += 2;
        continue;
      }
      if (option === '-file') {
        targetToken = tokens[index + 1] || null;
        break;
      }
      throw new Error(`${sourceId}: PowerShell command hook target is unresolved`);
    }
    allowedExtensions = new Set(['.ps1']);
  } else if ([
    'python',
    'python.exe',
    'python3',
    'python3.exe',
    'py',
    'py.exe',
  ].includes(runnerName)) {
    if (!tokens[1] || tokens[1].startsWith('-')) {
      throw new Error(`${sourceId}: Python command hook script target is unresolved`);
    }
    targetToken = tokens[1];
    allowedExtensions = new Set(['.py']);
  } else if (
    path.isAbsolute(runnerToken)
    || (
      optionalString(options.trustedRoot, null)
      && /^(?:\.[\\/])/u.test(runnerToken)
    )
  ) {
    targetToken = runnerToken;
  } else {
    throw new Error(`${sourceId}: command hook executable target is unresolved`);
  }

  if (!targetToken) {
    throw new Error(`${sourceId}: command hook script target is unresolved`);
  }
  const trustedRoot = normalizePath(options.trustedRoot);
  let targetPath;
  if (path.isAbsolute(targetToken)) {
    targetPath = normalizePath(targetToken);
  } else {
    if (!trustedRoot) {
      throw new Error(
        `${sourceId}: relative command hook target has no trusted source root`
      );
    }
    targetPath = path.resolve(trustedRoot, targetToken);
    const relative = path.relative(trustedRoot, targetPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`${sourceId}: relative command hook target escapes its trusted source root`);
    }
  }
  if (allowedExtensions && !allowedExtensions.has(path.extname(targetPath).toLowerCase())) {
    throw new Error(`${sourceId}: command hook script target has an unexpected extension`);
  }
  const exists = options.exists || fs.existsSync;
  if (!exists(targetPath)) {
    throw new Error(`${sourceId}: command hook target is missing: ${targetPath}`);
  }
  let targetSha256;
  try {
    targetSha256 = sha256File(targetPath, options.readFile || fs.readFileSync);
  } catch (error) {
    throw new Error(
      `${sourceId}: command hook target is unreadable: ${error?.message || String(error)}`
    );
  }
  if (trustedRoot) {
    try {
      const realpath = options.realpath || fs.realpathSync;
      const realRoot = normalizePath(realpath(trustedRoot));
      const realTarget = normalizePath(realpath(targetPath));
      const realRelative = path.relative(realRoot, realTarget);
      if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new Error('target escapes trusted root');
      }
    } catch (error) {
      throw new Error(
        `${sourceId}: relative command hook target cannot be contained: ${
          error?.message || String(error)
        }`
      );
    }
  }
  return {
    path: targetPath,
    sha256: targetSha256,
  };
}

function snapshotCommandHookTargets(commandHooks = [], options = {}) {
  const platform = options.platform || process.platform;
  const targets = new Map();
  for (const commandHook of commandHooks) {
    const sourceId = optionalString(commandHook?.sourceId, options.sourceId || 'command-hook');
    const resolved = resolveLiteralCommandHookTarget(commandHook?.command, {
      ...options,
      sourceId,
    });
    const key = platform === 'win32' ? resolved.path.toLowerCase() : resolved.path;
    targets.set(key, resolved);
  }
  return [...targets.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function validateHooksFile(value, sourceId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${sourceId}: hooks file root must be an object`);
  }
  const rootKeys = Object.keys(value);
  if (rootKeys.some((key) => key !== 'description' && key !== 'hooks')) {
    throw new Error(`${sourceId}: unknown hooks file root field`);
  }
  if (!value.hooks || typeof value.hooks !== 'object' || Array.isArray(value.hooks)) {
    throw new Error(`${sourceId}: hooks object missing`);
  }
  const commandHooks = [];
  for (const [eventName, groups] of Object.entries(value.hooks)) {
    if (!HOOK_EVENT_NAMES.has(eventName) || !Array.isArray(groups)) {
      throw new Error(`${sourceId}: unknown or invalid hook event ${eventName}`);
    }
    for (const [groupIndex, group] of groups.entries()) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        throw new Error(`${sourceId}: invalid matcher group for ${eventName}`);
      }
      for (const [handlerIndex, handler] of group.hooks.entries()) {
        if (!handler || typeof handler !== 'object'
          || !['command', 'prompt', 'agent'].includes(handler.type)) {
          throw new Error(`${sourceId}: invalid hook handler for ${eventName}`);
        }
        if (handler.type === 'command' && !optionalString(handler.command, null)) {
          throw new Error(`${sourceId}: command hook is missing its command`);
        }
        if (handler.type === 'command') {
          commandHooks.push({
            sourceId: `${sourceId}:${eventName}[${groupIndex}].hooks[${handlerIndex}]`,
            command: handler.command,
          });
        }
      }
    }
  }
  return commandHooks;
}

function stripTomlComment(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') return value.slice(0, index).trim();
  }
  return value.trim();
}

function parseTomlLiteralCommand(value, sourceId) {
  const text = stripTomlComment(String(value || '')).trim();
  if (/^"(?:\\.|[^"\\])*"$/u.test(text)) {
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(`${sourceId}: command hook TOML string is invalid`);
    }
  }
  if (/^'[^']*'$/u.test(text)) return text.slice(1, -1);
  throw new Error(`${sourceId}: command hook target must be a literal TOML string`);
}

function extractTomlHookSnapshot(content, sourceId) {
  const definitions = [];
  const enabledState = [];
  const unknownSections = [];
  const commandHooks = [];
  const commandTypeCounts = new Map();
  const commandTargetCounts = new Map();
  let section = '';
  for (const rawLine of String(content || '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[\[?(.+?)\]\]?$/u);
    if (header) {
      section = header[1].trim();
      if (section === 'hooks' || section === 'hooks.state'
        || section.startsWith('hooks.state.')) {
        continue;
      }
      if (section.startsWith('hooks.')) {
        const eventName = section.slice('hooks.'.length).split('.')[0];
        if (!HOOK_EVENT_NAMES.has(eventName)) unknownSections.push(section);
      } else if (/(?:^|\.)hooks(?:\.|$)/iu.test(
        section.replace(/["']/gu, '').replace(/\s+/gu, '')
      )) {
        unknownSections.push(section);
      }
      continue;
    }
    const assignmentIndex = line.indexOf('=');
    const hookGrammarSection = section === 'hooks' || section.startsWith('hooks.');
    if (assignmentIndex > 0 && !hookGrammarSection) {
      const assignmentKey = line
        .slice(0, assignmentIndex)
        .replace(/["']/gu, '')
        .replace(/\s+/gu, '');
      const hookKeySegments = assignmentKey.toLowerCase().split('.');
      const hookSegmentIndex = hookKeySegments.indexOf('hooks');
      const dottedHookAssignment = hookSegmentIndex >= 0
        && hookKeySegments.length > 1;
      const exactHooksAssignment = assignmentKey.toLowerCase() === 'hooks';
      const allowedFeatureToggle = section === 'features'
        && exactHooksAssignment
        && /^(?:true|false)(?:\s*(?:#.*)?)?$/iu.test(
          line.slice(assignmentIndex + 1).trim()
        );
      if (dottedHookAssignment || (exactHooksAssignment && !allowedFeatureToggle)) {
        throw new Error(
          `${sourceId}: hook-like assignment outside recognized hook section grammar`
        );
      }
    }
    const definitionSection = section === 'hooks'
      || (
        section.startsWith('hooks.')
        && section !== 'hooks.state'
        && !section.startsWith('hooks.state.')
      );
    if (definitionSection) {
      const commandAssignment = line.match(/^command\s*=\s*(.+)$/iu);
      if (commandAssignment) {
        commandHooks.push({
          sourceId: `${sourceId}:${section || 'hooks'}:command[${commandHooks.length}]`,
          command: parseTomlLiteralCommand(commandAssignment[1], sourceId),
        });
        commandTargetCounts.set(
          section,
          (commandTargetCounts.get(section) || 0) + 1
        );
      } else if (/(?:^|[,{]\s*)command\s*=/iu.test(line)) {
        throw new Error(`${sourceId}: inline TOML command hook target is unresolved`);
      }
      if (/\btype\s*=\s*["']command["']/iu.test(line)) {
        if (!/^type\s*=\s*["']command["'](?:\s*(?:#.*)?)?$/iu.test(line)) {
          throw new Error(`${sourceId}: inline TOML command hook definition is unresolved`);
        }
        commandTypeCounts.set(section, (commandTypeCounts.get(section) || 0) + 1);
      }
    }
    if (section === 'hooks') {
      definitions.push(`${section}|${line}`);
      continue;
    }
    if (section.startsWith('hooks.state.')) {
      if (/^enabled\s*=/u.test(line)) enabledState.push(`${section}|${line}`);
      continue;
    }
    if (section.startsWith('hooks.')) {
      const eventName = section.slice('hooks.'.length).split('.')[0];
      if (HOOK_EVENT_NAMES.has(eventName)) definitions.push(`${section}|${line}`);
    }
  }
  for (const [commandSection, count] of commandTypeCounts.entries()) {
    if ((commandTargetCounts.get(commandSection) || 0) < count) {
      throw new Error(
        `${sourceId}: command hook definition is missing a literal script target`
      );
    }
  }
  return {
    sourceId,
    definitionsSha256: sha256(canonicalJson(definitions)),
    enabledStateSha256: sha256(canonicalJson(enabledState)),
    definitionsCount: definitions.length,
    enabledStateCount: enabledState.length,
    unknownSections: [...new Set(unknownSections)].sort(),
    commandHooks,
  };
}

function ancestorDirectories(projectRoot) {
  const directories = [];
  let cursor = normalizePath(projectRoot);
  while (cursor) {
    directories.push(cursor);
    const parent = path.dirname(cursor);
    if (!parent || parent === cursor) break;
    cursor = parent;
  }
  return directories.reverse();
}

function buildHookLayerDescriptors(options = {}) {
  const projectRoot = normalizePath(options.projectRoot || process.cwd());
  const codexHome = normalizePath(options.codexHome || path.join(os.homedir(), '.codex'));
  const programData = normalizePath(
    options.programData || process.env.PROGRAMDATA || 'C:\\ProgramData'
  );
  const systemRoot = path.join(programData, 'OpenAI', 'Codex');
  const descriptors = [
    { id: 'system:config.toml', path: path.join(systemRoot, 'config.toml'), kind: 'config' },
    { id: 'system:hooks.json', path: path.join(systemRoot, 'hooks.json'), kind: 'hooks' },
    {
      id: 'system:requirements.toml',
      path: path.join(systemRoot, 'requirements.toml'),
      kind: 'managed',
    },
    {
      id: 'legacy-managed:managed_config.toml',
      path: path.join(codexHome, 'managed_config.toml'),
      kind: 'managed',
    },
    { id: 'user:config.toml', path: path.join(codexHome, 'config.toml'), kind: 'config' },
    { id: 'user:hooks.json', path: path.join(codexHome, 'hooks.json'), kind: 'hooks' },
    { id: 'cwd:config.toml', path: path.join(projectRoot, 'config.toml'), kind: 'config' },
  ];
  ancestorDirectories(projectRoot).forEach((directory, index) => {
    descriptors.push({
      id: `tree:${index}:.codex/config.toml`,
      path: path.join(directory, '.codex', 'config.toml'),
      kind: 'config',
    });
    descriptors.push({
      id: `tree:${index}:.codex/hooks.json`,
      path: path.join(directory, '.codex', 'hooks.json'),
      kind: 'hooks',
    });
  });
  return descriptors;
}

function snapshotHookLayers(options = {}) {
  const exists = options.exists || fs.existsSync;
  const readFile = options.readFile || fs.readFileSync;
  const snapshots = [];
  for (const descriptor of buildHookLayerDescriptors(options)) {
    if (!exists(descriptor.path)) {
      snapshots.push({ id: descriptor.id, present: false });
      continue;
    }
    if (descriptor.kind === 'managed') {
      snapshots.push({
        id: descriptor.id,
        present: true,
        unsupportedManagedSource: true,
        sha256: sha256File(descriptor.path, readFile),
      });
      continue;
    }
    if (descriptor.kind === 'hooks') {
      const parsed = JSON.parse(readFile(descriptor.path, 'utf8'));
      const commandHooks = validateHooksFile(parsed, descriptor.id);
      snapshots.push({
        id: descriptor.id,
        present: true,
        sha256: sha256File(descriptor.path, readFile),
        commandTargets: snapshotCommandHookTargets(commandHooks, {
          ...options,
          sourceId: descriptor.id,
          readFile,
          exists,
        }),
      });
      continue;
    }
    const snapshot = extractTomlHookSnapshot(readFile(descriptor.path, 'utf8'), descriptor.id);
    snapshots.push({
      id: descriptor.id,
      present: true,
      definitionsSha256: snapshot.definitionsSha256,
      enabledStateSha256: snapshot.enabledStateSha256,
      definitionsCount: snapshot.definitionsCount,
      enabledStateCount: snapshot.enabledStateCount,
      unknownSections: snapshot.unknownSections,
      commandTargets: snapshotCommandHookTargets(snapshot.commandHooks, {
        ...options,
        sourceId: descriptor.id,
        readFile,
        exists,
      }),
    });
  }
  return snapshots;
}

function resolvePluginHookPaths(pluginRoot, manifest, exists = fs.existsSync) {
  const active = [];
  const inline = [];
  if (Object.prototype.hasOwnProperty.call(manifest, 'hooks')) {
    const configured = manifest.hooks;
    if (typeof configured === 'string') {
      active.push(configured);
    } else if (Array.isArray(configured) && configured.every((item) => typeof item === 'string')) {
      active.push(...configured);
    } else if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
      inline.push(configured);
    } else if (Array.isArray(configured)
      && configured.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
      inline.push(...configured);
    } else {
      throw new Error('plugin manifest hooks field has an unsupported shape');
    }
  } else {
    const defaultPath = path.join(pluginRoot, 'hooks', 'hooks.json');
    if (exists(defaultPath)) active.push(path.join('hooks', 'hooks.json'));
  }
  return { active, inline };
}

function safePluginRelativePath(pluginRoot, configuredPath) {
  const resolved = path.resolve(pluginRoot, configuredPath);
  const relative = path.relative(pluginRoot, resolved);
  if (!relative || relative === '.') throw new Error('plugin hook path cannot be the plugin root');
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('plugin hook path escapes the plugin root');
  }
  return { resolved, relative: relative.replace(/\\/gu, '/') };
}

function snapshotEnabledPlugins(pluginList, options = {}) {
  const codexHome = normalizePath(options.codexHome || path.join(os.homedir(), '.codex'));
  const exists = options.exists || fs.existsSync;
  const readFile = options.readFile || fs.readFileSync;
  const installed = Array.isArray(pluginList?.installed) ? pluginList.installed : null;
  if (!installed) throw new Error('official plugin list is missing installed plugins');
  const seen = new Set();
  const snapshots = [];
  for (const plugin of installed.filter((entry) => entry?.enabled === true)) {
    const pluginId = optionalString(plugin.pluginId, null);
    const name = optionalString(plugin.name, null);
    const marketplaceName = optionalString(plugin.marketplaceName, null);
    const version = optionalString(plugin.version, null);
    if (!pluginId || !name || !marketplaceName || !version || seen.has(pluginId)) {
      throw new Error('official plugin list contains an invalid or duplicate enabled plugin');
    }
    seen.add(pluginId);
    const pluginRoot = path.join(
      codexHome,
      'plugins',
      'cache',
      marketplaceName,
      name,
      version
    );
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    if (!exists(manifestPath)) {
      throw new Error(`enabled plugin manifest is missing: ${pluginId}`);
    }
    const manifest = readJsonFile(manifestPath, readFile);
    const hookPaths = resolvePluginHookPaths(pluginRoot, manifest, exists);
    const hookSources = [];
    for (const configuredPath of hookPaths.active) {
      const resolved = safePluginRelativePath(pluginRoot, configuredPath);
      if (!exists(resolved.resolved)) {
        throw new Error(`enabled plugin hook source is missing: ${pluginId}:${resolved.relative}`);
      }
      const parsed = readJsonFile(resolved.resolved, readFile);
      const sourceId = `${pluginId}:${resolved.relative}`;
      const commandHooks = validateHooksFile(parsed, sourceId);
      hookSources.push({
        relativePath: resolved.relative,
        sha256: sha256File(resolved.resolved, readFile),
        commandTargets: snapshotCommandHookTargets(commandHooks, {
          ...options,
          sourceId,
          trustedRoot: pluginRoot,
          readFile,
          exists,
        }),
      });
    }
    hookPaths.inline.forEach((hooksFile, index) => {
      const sourceId = `${pluginId}:plugin.json#hooks[${index}]`;
      const commandHooks = validateHooksFile(hooksFile, sourceId);
      hookSources.push({
        relativePath: `plugin.json#hooks[${index}]`,
        sha256: sha256(canonicalJson(hooksFile)),
        commandTargets: snapshotCommandHookTargets(commandHooks, {
          ...options,
          sourceId,
          trustedRoot: pluginRoot,
          readFile,
          exists,
        }),
      });
    });
    const activePaths = new Set(hookSources.map((source) => source.relativePath));
    const extraHookLikeFiles = [];
    for (const relativePath of ['hooks.json', 'hooks/hooks.json']) {
      const candidate = path.join(pluginRoot, ...relativePath.split('/'));
      if (exists(candidate) && !activePaths.has(relativePath)) {
        const parsed = readJsonFile(candidate, readFile);
        validateHooksFile(parsed, `${pluginId}:${relativePath}`);
        extraHookLikeFiles.push({
          relativePath,
          sha256: sha256File(candidate, readFile),
        });
      }
    }
    snapshots.push({
      pluginId,
      version,
      manifestSha256: sha256File(manifestPath, readFile),
      hookSources: hookSources.sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)),
      extraHookLikeFiles: extraHookLikeFiles.sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)),
    });
  }
  return snapshots.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

async function readOfficialPluginList(options = {}) {
  if (options.pluginList) return options.pluginList;
  const result = await (options.runCodex || defaultRunCodex)(
    ['plugin', 'list', '--json'],
    {
      ...options,
      cwd: normalizePath(options.projectRoot || process.cwd()),
      encoding: 'utf8',
      timeout: 30000,
    }
  );
  if (result?.ok !== true) {
    throw new Error(result?.error || result?.stderr || 'official plugin list failed');
  }
  return JSON.parse(result.stdout);
}

async function readCodexVersion(options = {}) {
  if (options.codexVersion) return String(options.codexVersion);
  const result = await (options.runCodex || defaultRunCodex)(
    ['--version'],
    {
      ...options,
      cwd: normalizePath(options.projectRoot || process.cwd()),
      encoding: 'utf8',
      timeout: 10000,
    }
  );
  if (result?.ok !== true) throw new Error(result?.error || 'codex version probe failed');
  const match = String(result.stdout || '').match(/(\d+\.\d+\.\d+)/u);
  if (!match) throw new Error('codex version probe returned an unknown version');
  return match[1];
}

async function auditCodexHookTrust(options = {}) {
  const projectRoot = normalizePath(options.projectRoot || process.cwd());
  const codexHome = normalizePath(options.codexHome || path.join(os.homedir(), '.codex'));
  const manifestPath = normalizePath(
    options.manifestPath
      || path.join(projectRoot, 'ui', 'config', 'codex-computer-use-hook-trust.json')
  );
  try {
    const approved = options.manifest || readJsonFile(
      manifestPath,
      options.readFile || fs.readFileSync
    );
    if (approved.schema !== HOOK_TRUST_MANIFEST_SCHEMA
      || !pathsEqual(approved.projectRoot, projectRoot, options.platform || process.platform)) {
      throw new Error('hook trust manifest schema or project root mismatch');
    }
    const codexVersion = await readCodexVersion(options);
    const pluginList = await readOfficialPluginList(options);
    const snapshot = {
      schema: HOOK_TRUST_MANIFEST_SCHEMA,
      projectRoot,
      codexVersion,
      layers: snapshotHookLayers({ ...options, projectRoot, codexHome }),
      plugins: snapshotEnabledPlugins(pluginList, { ...options, codexHome }),
    };
    const unsupported = snapshot.layers.find((entry) =>
      entry.unsupportedManagedSource === true || entry.unknownSections?.length > 0);
    if (unsupported) {
      throw new Error(`unknown or managed hook source requires review: ${unsupported.id}`);
    }
    const approvedComparable = {
      schema: approved.schema,
      projectRoot: normalizePath(approved.projectRoot),
      codexVersion: approved.codexVersion,
      layers: approved.layers,
      plugins: approved.plugins,
    };
    const actualJson = canonicalJson(snapshot);
    const approvedJson = canonicalJson(approvedComparable);
    if (actualJson !== approvedJson) {
      return {
        ok: false,
        reason: 'codex_hook_trust_manifest_drift',
        manifestPath,
        approvedDigest: sha256(approvedJson),
        actualDigest: sha256(actualJson),
        snapshot,
      };
    }
    return {
      ok: true,
      reason: 'codex_hook_trust_manifest_approved',
      manifestPath,
      digest: sha256(actualJson),
      snapshot,
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'codex_hook_trust_audit_failed',
      error: error?.message || String(error),
      manifestPath,
    };
  }
}

function buildCanonicalListWindowsPlan(options = {}) {
  const clientPath = normalizePath(options.clientPath);
  if (!clientPath) {
    return { ok: false, reason: 'official_computer_use_client_not_found' };
  }
  const clientUrl = pathToFileURL(clientPath).href;
  const snippet = [
    `var { setupComputerUseRuntime } = await import(${JSON.stringify(clientUrl)});`,
    'await setupComputerUseRuntime({ globals: globalThis });',
    "await globalThis.sky.documentation('guidance');",
    'var squidrunComputerUseWindows = await globalThis.sky.list_windows();',
    '({',
    `  schema: ${JSON.stringify(LIST_WINDOWS_PROOF_SCHEMA)},`,
    "  operation: 'list_windows',",
    '  ok: Array.isArray(squidrunComputerUseWindows),',
    "  workingDirectory: String(globalThis.nodeRepl?.cwd || ''),",
    '  windowCount: Array.isArray(squidrunComputerUseWindows) ? squidrunComputerUseWindows.length : null,',
    '})',
  ].join('\n');
  const toolInput = { code: snippet };
  const toolInputJson = JSON.stringify(toolInput);
  return {
    ok: true,
    schema: PROOF_PLAN_SCHEMA,
    operation: 'list_windows',
    clientPath,
    clientSha256: options.clientSha256 || null,
    snippet,
    toolInput,
    toolInputJson,
    toolInputSha256: sha256(toolInputJson),
    prompt: [
      'Use node_repl exactly once now.',
      'The call must contain only the `code` field and its value must be the exact JavaScript below.',
      'Do not call node_repl before it, do not add timeout_ms, and do not call setResponseMeta directly.',
      '',
      '```javascript',
      snippet,
      '```',
    ].join('\n'),
  };
}

async function captureTrackedProofIntegrity(options = {}) {
  const projectRoot = normalizePath(options.projectRoot || process.cwd());
  const files = options.files || {
    verifier: path.join(projectRoot, 'ui', 'modules', 'main', 'codex-computer-use-proof.js'),
    hookScript: path.join(projectRoot, 'ui', 'scripts', 'codex-computer-use-post-tool-proof.js'),
    trustManifest: path.join(projectRoot, 'ui', 'config', 'codex-computer-use-hook-trust.json'),
    standaloneController: path.join(
      projectRoot,
      'ui',
      'modules',
      'main',
      'codex-computer-use-standalone-controller.js'
    ),
    controllerCli: path.join(
      projectRoot,
      'ui',
      'scripts',
      'hm-codex-computer-use-bridge.js'
    ),
    daemonClient: path.join(projectRoot, 'ui', 'daemon-client.js'),
    nativeBridge: path.join(
      projectRoot,
      'ui',
      'modules',
      'main',
      'codex-computer-use-native-bridge.js'
    ),
    addressedSpawnTransaction: path.join(
      projectRoot,
      'ui',
      'modules',
      'main',
      'arm-spawn-transaction.js'
    ),
  };
  const readFile = options.readFile || fs.readFileSync;
  const entries = Object.entries(files).map(([name, filePath]) => ({
    name,
    path: normalizePath(filePath),
    sha256: sha256File(filePath, readFile),
  }));
  if (options.verifyGit !== false) {
    const runFile = options.runFile || defaultRunFile;
    const relativePaths = entries.map((entry) =>
      path.relative(projectRoot, entry.path).replace(/\\/gu, '/'));
    const tracked = await runFile(
      'git',
      ['-C', projectRoot, 'ls-files', '--error-unmatch', '--', ...relativePaths],
      { encoding: 'utf8', timeout: 10000 }
    );
    if (tracked?.ok !== true) throw new Error('proof verifier files are not all tracked');
    const dirty = await runFile(
      'git',
      ['-C', projectRoot, 'status', '--porcelain', '--', ...relativePaths],
      { encoding: 'utf8', timeout: 10000 }
    );
    if (dirty?.ok !== true || String(dirty.stdout || '').trim()) {
      throw new Error('proof verifier files are not clean at the immutable revision');
    }
  }
  return entries;
}

function proofIntegrityMatches(expected, actual) {
  return canonicalJson(expected) === canonicalJson(actual);
}

async function armCodexComputerUseProofClaim(options = {}) {
  const claim = options.claim;
  const projectRoot = normalizePath(options.projectRoot || claim?.projectRoot);
  if (!claim || !claim.claimId || !projectRoot) {
    return { ok: false, reason: 'codex_computer_use_proof_claim_invalid' };
  }
  const clientPath = normalizePath(options.clientPath);
  if (!clientPath) {
    return { ok: false, reason: 'official_computer_use_client_not_found' };
  }
  try {
    const clientSha256 = sha256File(clientPath, options.readFile || fs.readFileSync);
    const hookAudit = await (options.auditHookTrust || auditCodexHookTrust)({
      ...options,
      projectRoot,
    });
    if (hookAudit?.ok !== true) {
      return {
        ok: false,
        reason: hookAudit?.reason || 'codex_hook_trust_audit_failed',
        hookAudit,
      };
    }
    const integrity = await (options.captureIntegrity || captureTrackedProofIntegrity)({
      ...options,
      projectRoot,
    });
    const resolveCodexExecutable = options.resolveCodexExecutable
      || resolveTrustedCodexExecutable;
    const resolvedCodexExecutable = await resolveCodexExecutable({
      ...options,
      projectRoot,
    });
    if (resolvedCodexExecutable?.ok !== true) {
      return {
        ok: false,
        reason: resolvedCodexExecutable?.reason
          || 'codex_computer_use_executable_not_approved',
        executable: resolvedCodexExecutable || null,
      };
    }
    const codexExecutable = {
      path: normalizePath(resolvedCodexExecutable.path),
      sha256: optionalString(resolvedCodexExecutable.sha256, ''),
      packageVersion: optionalString(resolvedCodexExecutable.packageVersion, null),
      platformPackageVersion: optionalString(
        resolvedCodexExecutable.platformPackageVersion,
        null
      ),
      targetTriple: optionalString(resolvedCodexExecutable.targetTriple, null),
    };
    const executableCheck = recheckTrustedCodexExecutable(codexExecutable, options);
    if (executableCheck.ok !== true) {
      return {
        ok: false,
        reason: executableCheck.reason,
        executable: codexExecutable,
      };
    }
    const plan = buildCanonicalListWindowsPlan({
      clientPath,
      clientSha256,
    });
    if (!plan.ok) return plan;
    const proofRoot = (options.makeProofDirectory || ((prefix) =>
      fs.mkdtempSync(prefix)))(path.join(os.tmpdir(), 'squidrun-cua-proof-'));
    const journalPath = path.join(proofRoot, 'post-tool-use.jsonl');
    const secret = (options.randomBytes || crypto.randomBytes)(32).toString('base64url');
    const generationDigest = sha256(canonicalJson(claim.generation));
    claim.proof = {
      state: 'armed',
      failureReason: null,
      secret,
      journalPath,
      hookAuditDigest: hookAudit.digest,
      integrity,
      officialClientPath: clientPath,
      officialClientSha256: clientSha256,
      codexExecutable,
      generationDigest,
      canonicalPlan: plan,
      deadlineAtMs: null,
      consumedAt: null,
    };
    claim.proofSpawnEnv = {
      SQUIDRUN_CUA_PROOF_SECRET: secret,
      SQUIDRUN_CUA_PROOF_JOURNAL: journalPath,
      SQUIDRUN_CUA_PROOF_CLAIM_ID: claim.claimId,
      SQUIDRUN_CUA_PROOF_PANE_ID: String(claim.paneId),
      SQUIDRUN_CUA_PROOF_PROJECT_ROOT: projectRoot,
      SQUIDRUN_CUA_PROOF_GENERATION_DIGEST: generationDigest,
      SQUIDRUN_CUA_PROOF_TOOL_INPUT_B64: Buffer.from(plan.toolInputJson).toString('base64'),
      SQUIDRUN_CUA_PROOF_TOOL_INPUT_SHA256: plan.toolInputSha256,
      SQUIDRUN_CUA_PROOF_CLIENT_PATH: clientPath,
      SQUIDRUN_CUA_PROOF_CLIENT_SHA256: clientSha256,
      SQUIDRUN_CUA_PROOF_INTEGRITY_B64: Buffer.from(canonicalJson(integrity)).toString('base64'),
      SQUIDRUN_CUA_PROOF_HOOK_AUDIT_DIGEST: hookAudit.digest,
    };
    return {
      ok: true,
      reason: 'codex_computer_use_proof_claim_armed',
      claim,
      hookAudit: {
        digest: hookAudit.digest,
        manifestPath: hookAudit.manifestPath,
      },
      integrity,
      codexExecutable,
      plan: {
        schema: plan.schema,
        toolInputSha256: plan.toolInputSha256,
        clientPath,
        clientSha256,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'codex_computer_use_proof_arm_failed',
      error: error?.message || String(error),
    };
  }
}

function quotePowerShellLiteral(value) {
  if (String(value).includes('\0')) throw new Error('command argument contains NUL');
  return `'${String(value).replace(/'/gu, "''")}'`;
}

function parseShellEnvironmentPolicyExcludeOverride(value) {
  const source = String(value || '').trim();
  const match = /^shell_environment_policy\.exclude=\[\s*(?:'([^'\r\n]*)'|"((?:[^"\\\r\n]|\\.)*)")\s*\]$/u
    .exec(source);
  if (!match) {
    return {
      ok: false,
      reason: 'shell_environment_policy_exclude_toml_sequence_required',
    };
  }
  let exclude;
  if (match[1] !== undefined) {
    exclude = match[1];
  } else {
    try {
      exclude = JSON.parse(`"${match[2]}"`);
    } catch (_) {
      return {
        ok: false,
        reason: 'shell_environment_policy_exclude_toml_string_invalid',
      };
    }
  }
  return {
    ok: true,
    reason: 'shell_environment_policy_exclude_toml_sequence_parsed',
    type: 'array',
    exclude: [exclude],
  };
}

function quoteTomlLiteralString(value) {
  const source = String(value);
  if (/['\0\r\n]/u.test(source)) {
    throw new Error('TOML literal string contains an unsupported character');
  }
  return `'${source}'`;
}

function parsePowerShellLiteralArgv(command) {
  const source = String(command || '');
  if (!source.trim() || /[\0\r\n\v\f\u0085\u2028\u2029]/u.test(source)) {
    return { ok: false, reason: 'codex_computer_use_command_syntax_refused' };
  }

  const argv = [];
  let cursor = 0;
  const isSeparator = (character) => character === ' ' || character === '\t';
  const refuse = () => ({
    ok: false,
    reason: 'codex_computer_use_command_syntax_refused',
  });

  while (cursor < source.length) {
    while (cursor < source.length && isSeparator(source[cursor])) cursor += 1;
    if (cursor >= source.length) break;

    const quote = source[cursor];
    let value = '';
    if (quote === "'" || quote === '"') {
      cursor += 1;
      let closed = false;
      while (cursor < source.length) {
        const character = source[cursor];
        if (character === quote) {
          if (quote === "'" && source[cursor + 1] === "'") {
            value += "'";
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        if (quote === '"' && (character === '$' || character === '`')) {
          return refuse();
        }
        value += character;
        cursor += 1;
      }
      if (!closed || (cursor < source.length && !isSeparator(source[cursor]))) {
        return refuse();
      }
    } else {
      while (cursor < source.length && !isSeparator(source[cursor])) {
        const character = source[cursor];
        if (!/[A-Za-z0-9_./:\\=+-]/u.test(character)) {
          return refuse();
        }
        value += character;
        cursor += 1;
      }
    }
    argv.push(value);
  }

  return argv.length > 0
    ? { ok: true, argv, source: source.trim() }
    : refuse();
}

function validateCodexLiteralArgv(argv, platform = process.platform) {
  const executable = String(argv?.[0] || '');
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const executableName = pathApi.basename(executable).toLowerCase();
  const isCodexExecutable = ['codex', 'codex.exe', 'codex.cmd'].includes(executableName);
  const hasPath = /[\\/]/u.test(executable);
  const isBareCodex = !hasPath && executable.toLowerCase() === 'codex';
  if (!isCodexExecutable
    || (hasPath && !pathApi.isAbsolute(executable))
    || (!hasPath && !isBareCodex)) {
    return { ok: false, reason: 'codex_computer_use_command_not_codex' };
  }

  const args = argv.slice(1);
  if (args.includes('--')) {
    return { ok: false, reason: 'codex_computer_use_command_argument_terminator_refused' };
  }
  if (args.some((arg) =>
    /^(?:resume|fork|--resume(?:=.*)?|--continue(?:=.*)?)$/iu.test(arg))) {
    return { ok: false, reason: 'codex_computer_use_bypass_requires_fresh_session' };
  }
  if (args.some((arg) =>
    /^--dangerously-bypass-hook-trust(?:=.*)?$/u.test(arg))) {
    return { ok: false, reason: 'codex_computer_use_bypass_already_present' };
  }
  if (args.some((arg) =>
    /^(?:-c.*|--config(?:=.*)?|-p.*|--profile(?:=.*)?|-C.*|--cd(?:=.*)?|--enable(?:=.*)?|--disable(?:=.*)?)$/u.test(arg))) {
    return { ok: false, reason: 'codex_computer_use_command_configuration_refused' };
  }

  const noValueOptions = new Set([
    '--yolo',
    '--dangerously-bypass-approvals-and-sandbox',
    '--search',
    '--no-alt-screen',
  ]);
  const valueOptions = new Map([
    ['-m', {
      canonical: '--model',
      valid: (value) => /^[A-Za-z0-9._:/+-]+$/u.test(value),
    }],
    ['--model', {
      canonical: '--model',
      valid: (value) => /^[A-Za-z0-9._:/+-]+$/u.test(value),
    }],
    ['-s', {
      canonical: '--sandbox',
      valid: (value) =>
        ['read-only', 'workspace-write', 'danger-full-access'].includes(value),
    }],
    ['--sandbox', {
      canonical: '--sandbox',
      valid: (value) =>
        ['read-only', 'workspace-write', 'danger-full-access'].includes(value),
    }],
    ['-a', {
      canonical: '--ask-for-approval',
      valid: (value) => ['untrusted', 'on-request', 'never'].includes(value),
    }],
    ['--ask-for-approval', {
      canonical: '--ask-for-approval',
      valid: (value) => ['untrusted', 'on-request', 'never'].includes(value),
    }],
  ]);
  const safeArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (noValueOptions.has(arg)) {
      safeArgs.push(arg);
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const optionName = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
    const option = valueOptions.get(optionName);
    if (!option) {
      return {
        ok: false,
        reason: arg.startsWith('-')
          ? 'codex_computer_use_command_option_refused'
          : 'codex_computer_use_command_startup_input_refused',
      };
    }

    const value = equalsIndex > 0 ? arg.slice(equalsIndex + 1) : args[index + 1];
    if (!value || value.startsWith('-') || !option.valid(value)) {
      return { ok: false, reason: 'codex_computer_use_command_option_value_refused' };
    }
    safeArgs.push(option.canonical, value);
    if (equalsIndex < 0) index += 1;
  }

  return {
    ok: true,
    executable,
    args: safeArgs,
    hasPath,
  };
}

function buildCodexComputerUseProofInvocation(command, claim, options = {}) {
  if (!claim?.proof || claim.proof.state !== 'armed') {
    return { ok: false, reason: 'codex_computer_use_proof_not_armed' };
  }
  const parsed = parsePowerShellLiteralArgv(command);
  if (parsed.ok !== true) return parsed;
  const platform = options.platform || claim.platform || process.platform;
  const validated = validateCodexLiteralArgv(
    parsed.argv,
    platform
  );
  if (validated.ok !== true) return validated;
  const executableCheck = recheckTrustedCodexExecutable(
    claim.proof.codexExecutable,
    { ...options, platform }
  );
  if (executableCheck.ok !== true) return executableCheck;
  if (validated.hasPath) {
    let requestedExecutable;
    try {
      requestedExecutable = realpathFile(validated.executable, options);
    } catch (_) {
      return { ok: false, reason: 'codex_computer_use_executable_not_approved' };
    }
    if (!pathsEqual(requestedExecutable, executableCheck.path, platform)) {
      return { ok: false, reason: 'codex_computer_use_executable_not_approved' };
    }
  }

  const hookEntry = claim.proof.integrity.find((entry) => entry.name === 'hookScript');
  if (!hookEntry?.path) {
    return { ok: false, reason: 'codex_computer_use_hook_script_missing' };
  }
  if (/[\s'"]/u.test(hookEntry.path)) {
    return {
      ok: false,
      reason: 'codex_computer_use_hook_script_native_argv_unsafe',
    };
  }
  const hookCommand = `node ${hookEntry.path}`;
  let hookOverride;
  try {
    hookOverride = [
      'hooks.PostToolUse=[',
      `{matcher=${quoteTomlLiteralString('^mcp__node_repl__js$')},hooks=[`,
      `{type=${quoteTomlLiteralString('command')},`,
      `command=${quoteTomlLiteralString(hookCommand)},timeout=15,`,
      `statusMessage=${quoteTomlLiteralString('Verifying Computer Use native bridge')}}`,
      ']}',
      ']',
    ].join('');
  } catch (_) {
    return {
      ok: false,
      reason: 'codex_computer_use_hook_override_toml_literal_unsafe',
    };
  }
  // TOML literal-string quotes survive PowerShell's Windows-native argv
  // serialization. Embedded double quotes do not: PowerShell strips them and
  // Codex then sees a scalar string instead of a TOML sequence.
  const environmentOverride = "shell_environment_policy.exclude=['SQUIDRUN_CUA_*']";
  const parsedEnvironmentOverride = parseShellEnvironmentPolicyExcludeOverride(
    environmentOverride
  );
  if (parsedEnvironmentOverride.ok !== true
    || parsedEnvironmentOverride.type !== 'array'
    || parsedEnvironmentOverride.exclude.length !== 1
    || parsedEnvironmentOverride.exclude[0] !== 'SQUIDRUN_CUA_*') {
    return {
      ok: false,
      reason: parsedEnvironmentOverride.reason
        || 'shell_environment_policy_exclude_toml_sequence_required',
    };
  }
  const serializedExecutable = platform === 'win32'
    ? `& ${quotePowerShellLiteral(executableCheck.path)}`
    : quotePowerShellLiteral(executableCheck.path);
  const serializedCommand = [
    serializedExecutable,
    ...validated.args.map(quotePowerShellLiteral),
  ].join(' ');
  const addedArguments = [
    '--dangerously-bypass-hook-trust',
    '-c',
    quotePowerShellLiteral(hookOverride),
    '-c',
    quotePowerShellLiteral(environmentOverride),
  ].join(' ');
  const invocation = `${serializedCommand} ${addedArguments}`;
  return {
    ok: true,
    reason: 'codex_computer_use_proof_invocation_built',
    command: invocation,
    hookOverride,
    environmentOverride,
    environmentOverrideType: parsedEnvironmentOverride.type,
    addedArguments,
    originalCommand: parsed.source,
    argv: [executableCheck.path, ...validated.args],
    codexExecutableSha256: executableCheck.sha256,
    targetPaneId: String(claim.paneId),
    freshSessionOnly: true,
    bypassHookTrust: true,
    noCustomProtocol: true,
    noHelperSpawn: true,
    platform,
  };
}

function signedAttestationPayload(record) {
  const clone = { ...record };
  delete clone.signature;
  return canonicalJson(clone);
}

function failProofClaim(claim, reason) {
  if (claim?.proof) {
    claim.proof.state = 'failed';
    claim.proof.failureReason = reason;
  }
  return {
    ok: false,
    status: 'blocked',
    reason,
    authoritativeComputerUseReady: false,
  };
}

async function verifyCodexComputerUseProofJournal(claim, options = {}) {
  if (!claim?.proof || !claim.claimId) {
    return failProofClaim(claim, 'codex_computer_use_proof_claim_invalid');
  }
  if (claim.proof.state === 'failed') {
    return failProofClaim(
      claim,
      claim.proof.failureReason || 'codex_computer_use_proof_generation_failed'
    );
  }
  if (claim.proof.state === 'consumed') {
    return failProofClaim(claim, 'codex_computer_use_proof_replay');
  }
  const now = Number(options.now?.() ?? Date.now());
  const deadline = Number(claim.proof.deadlineAtMs);
  if (!Number.isFinite(deadline) || deadline <= 0) {
    return failProofClaim(claim, 'codex_computer_use_proof_plan_not_issued');
  }
  let content;
  try {
    content = (options.readFile || fs.readFileSync)(claim.proof.journalPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && now < deadline) {
      return {
        ok: false,
        status: 'pending',
        reason: 'codex_computer_use_proof_pending',
        authoritativeComputerUseReady: false,
      };
    }
    return failProofClaim(
      claim,
      now >= deadline
        ? 'codex_computer_use_proof_timeout'
        : 'codex_computer_use_proof_journal_unreadable'
    );
  }
  const lines = String(content).split(/\r?\n/u).filter((line) => line.trim());
  if (lines.length !== 1) {
    return failProofClaim(
      claim,
      lines.length > 1
        ? 'codex_computer_use_proof_duplicate_event'
        : 'codex_computer_use_proof_journal_empty'
    );
  }
  let record;
  try {
    record = JSON.parse(lines[0]);
  } catch (_) {
    return failProofClaim(claim, 'codex_computer_use_proof_journal_invalid');
  }
  const expectedSignature = hmacSha256(
    claim.proof.secret,
    signedAttestationPayload(record)
  );
  if (!signaturesEqual(record.signature, expectedSignature)) {
    return failProofClaim(claim, 'codex_computer_use_proof_signature_invalid');
  }
  const expectedPlan = claim.proof.canonicalPlan;
  const identityValues = [
    optionalString(record.sessionId, null),
    optionalString(record.turnId, null),
    optionalString(record.toolUseId, null),
  ];
  if (identityValues.some((value) => !value)) {
    return failProofClaim(claim, 'codex_computer_use_proof_identity_missing');
  }
  const identityKey = identityValues.join(':');
  const consumedIds = options.consumedIds || new Set();
  if (consumedIds.has(identityKey)) {
    return failProofClaim(claim, 'codex_computer_use_proof_identity_replay');
  }
  const expectedIntegrity = claim.proof.integrity;
  let currentIntegrity;
  try {
    currentIntegrity = await (options.captureIntegrity || captureTrackedProofIntegrity)({
      ...options,
      projectRoot: claim.projectRoot,
      files: Object.fromEntries(expectedIntegrity.map((entry) => [entry.name, entry.path])),
      verifyGit: false,
    });
  } catch (_) {
    return failProofClaim(claim, 'codex_computer_use_proof_integrity_unreadable');
  }
  if (!proofIntegrityMatches(expectedIntegrity, currentIntegrity)) {
    return failProofClaim(claim, 'codex_computer_use_proof_integrity_drift');
  }
  if (sha256File(
    claim.proof.officialClientPath,
    options.readFile || fs.readFileSync
  ) !== claim.proof.officialClientSha256) {
    return failProofClaim(claim, 'official_computer_use_client_drift');
  }
  const executableCheck = recheckTrustedCodexExecutable(
    claim.proof.codexExecutable,
    {
      ...options,
      platform: claim.platform || options.platform || process.platform,
    }
  );
  if (executableCheck.ok !== true) {
    return failProofClaim(claim, executableCheck.reason);
  }
  const hookAudit = await (options.auditHookTrust || auditCodexHookTrust)({
    ...options,
    projectRoot: claim.projectRoot,
  });
  if (hookAudit?.ok !== true || hookAudit.digest !== claim.proof.hookAuditDigest) {
    return failProofClaim(claim, 'codex_hook_trust_manifest_drift');
  }
  const transcriptPath = normalizePath(record.transcriptPath);
  const codexHome = normalizePath(options.codexHome || path.join(os.homedir(), '.codex'));
  const transcriptInsideCodexHome = transcriptPath
    && (transcriptPath.toLowerCase() === codexHome.toLowerCase()
      || transcriptPath.toLowerCase().startsWith(`${codexHome.toLowerCase()}${path.sep}`));
  const mismatches = [
    record.schema !== PROOF_ATTESTATION_SCHEMA && 'attestation_schema_mismatch',
    record.claimId !== claim.claimId && 'attestation_claim_mismatch',
    String(record.paneId) !== String(claim.paneId) && 'attestation_pane_mismatch',
    !pathsEqual(record.projectRoot, claim.projectRoot, claim.platform)
      && 'attestation_project_root_mismatch',
    record.generationDigest !== claim.proof.generationDigest
      && 'attestation_generation_mismatch',
    record.toolName !== CANONICAL_NODE_REPL_TOOL_NAME && 'attestation_tool_name_mismatch',
    record.verdict !== 'passed' && (record.reason || 'attestation_refused'),
    record.toolInputSha256 !== expectedPlan.toolInputSha256
      && 'attestation_tool_input_mismatch',
    record.officialClientPath !== claim.proof.officialClientPath
      && 'attestation_client_path_mismatch',
    record.officialClientSha256 !== claim.proof.officialClientSha256
      && 'attestation_client_hash_mismatch',
    record.integrityDigest !== sha256(canonicalJson(expectedIntegrity))
      && 'attestation_integrity_mismatch',
    record.hookAuditDigest !== claim.proof.hookAuditDigest
      && 'attestation_hook_audit_mismatch',
    !pathsEqual(record.cwd, claim.projectRoot, claim.platform) && 'attestation_cwd_mismatch',
    !transcriptInsideCodexHome && 'attestation_transcript_path_invalid',
    !Number.isInteger(record.windowCount) && 'attestation_window_count_invalid',
    record.windowCount < 0 && 'attestation_window_count_invalid',
  ].filter(Boolean);
  if (mismatches.length > 0) return failProofClaim(claim, mismatches[0]);
  consumedIds.add(identityKey);
  claim.proof.state = 'consumed';
  claim.proof.consumedAt = new Date(now).toISOString();
  claim.proof.secret = null;
  return {
    ok: true,
    status: 'passed',
    reason: 'codex_computer_use_list_windows_attested',
    authoritativeComputerUseReady: true,
    claimId: claim.claimId,
    paneId: String(claim.paneId),
    sessionId: record.sessionId,
    turnId: record.turnId,
    toolUseId: record.toolUseId,
    operation: 'list_windows',
    windowCount: record.windowCount,
    officialClientPath: claim.proof.officialClientPath,
    officialClientSha256: claim.proof.officialClientSha256,
  };
}

module.exports = {
  CANONICAL_NODE_REPL_TOOL_NAME,
  DEFAULT_PROOF_TIMEOUT_MS,
  HOOK_TRUST_MANIFEST_SCHEMA,
  LIST_WINDOWS_PROOF_SCHEMA,
  PROOF_ATTESTATION_SCHEMA,
  PROOF_JOURNAL_SCHEMA,
  PROOF_PLAN_SCHEMA,
  armCodexComputerUseProofClaim,
  auditCodexHookTrust,
  buildCanonicalListWindowsPlan,
  buildCodexComputerUseProofInvocation,
  buildHookLayerDescriptors,
  canonicalJson,
  captureTrackedProofIntegrity,
  extractTomlHookSnapshot,
  failProofClaim,
  hmacSha256,
  pathsEqual,
  parseShellEnvironmentPolicyExcludeOverride,
  proofIntegrityMatches,
  recheckTrustedCodexExecutable,
  resolveTrustedCodexExecutable,
  resolveLiteralCommandHookTarget,
  sha256,
  sha256File,
  signaturesEqual,
  snapshotCommandHookTargets,
  snapshotEnabledPlugins,
  snapshotHookLayers,
  validateHooksFile,
  verifyCodexComputerUseProofJournal,
};
