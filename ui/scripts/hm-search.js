#!/usr/bin/env node
/**
 * hm-search: safer rg wrapper for Windows/PowerShell environments.
 * Usage:
 *   node D:/projects/hivemind/ui/scripts/hm-search.js "pattern" "path" [--glob "*.js"]
 */

const { spawnSync } = require('child_process');

function printUsage() {
  console.log('Usage: node D:/projects/hivemind/ui/scripts/hm-search.js "pattern" "path" [--glob "*.js"] [--regex]');
  console.log('  pattern: text to search for');
  console.log('  path: file or directory to search');
  console.log('  --glob: optional rg glob filter (repeatable)');
  console.log('  --regex: treat pattern as raw regex (default escapes regex metacharacters)');
}

function escapeRegex(input) {
  return input.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
}

function parseArgs(argv) {
  if (argv.length < 2) {
    return { error: 'missing_required_args' };
  }

  const pattern = argv[0];
  const searchPath = argv[1];
  const globs = [];
  let regexMode = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--regex') {
      regexMode = true;
      continue;
    }

    if (arg === '--glob') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        return { error: 'missing_glob_value' };
      }
      globs.push(value);
      i++;
      continue;
    }

    if (arg.startsWith('--glob=')) {
      const value = arg.slice('--glob='.length);
      if (!value) {
        return { error: 'missing_glob_value' };
      }
      globs.push(value);
      continue;
    }

    return { error: `unknown_flag:${arg}` };
  }

  return { pattern, searchPath, globs, regexMode };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    if (parsed.error === 'missing_required_args') {
      printUsage();
    } else if (parsed.error === 'missing_glob_value') {
      console.error('Error: --glob requires a value, e.g. --glob "*.js"');
      printUsage();
    } else {
      console.error(`Error: unknown option '${parsed.error.replace('unknown_flag:', '')}'`);
      printUsage();
    }
    process.exit(1);
  }

  const rgArgs = [
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--regexp',
    parsed.regexMode ? parsed.pattern : escapeRegex(parsed.pattern),
  ];

  for (const glob of parsed.globs) {
    rgArgs.push('--glob', glob);
  }

  rgArgs.push(parsed.searchPath);

  const result = spawnSync('rg', rgArgs, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 1024 * 1024 * 16,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error('Error: ripgrep (rg) is not installed or not available in PATH.');
    } else {
      console.error(`Error running rg: ${result.error.message}`);
    }
    process.exit(2);
  }

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  // rg exits 1 when no matches are found. Treat that as a successful, empty search.
  if (result.status === 1) {
    process.exit(0);
  }

  process.exit(result.status ?? 0);
}

main();
