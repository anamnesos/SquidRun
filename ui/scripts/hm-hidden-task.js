'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const USAGE = [
  'Usage:',
  '  node hm-hidden-task.js [--cwd <path>] [--append-log <path>] -- <executable> [arguments...]',
].join('\n');

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error(`missing child command\n${USAGE}`);
  }

  const options = { cwd: null, appendLog: null };
  for (let index = 0; index < separator; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if ((option !== '--cwd' && option !== '--append-log') || !value) {
      throw new Error(`invalid option: ${option || '<empty>'}\n${USAGE}`);
    }
    if (option === '--cwd') options.cwd = path.resolve(value);
    if (option === '--append-log') options.appendLog = path.resolve(value);
    index += 1;
  }

  return {
    ...options,
    executable: argv[separator + 1],
    args: argv.slice(separator + 2),
  };
}

async function runChild(options, dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess || spawn;
  const openLog = dependencies.openLog || ((logPath) => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    return fs.openSync(logPath, 'a');
  });
  const closeLog = dependencies.closeLog || ((fd) => fs.closeSync(fd));

  let logFd = null;
  try {
    if (options.appendLog) logFd = openLog(options.appendLog);
    const stdio = logFd === null ? ['ignore', 'ignore', 'ignore'] : ['ignore', logFd, logFd];
    const child = spawnProcess(options.executable, options.args, {
      cwd: options.cwd || undefined,
      env: process.env,
      windowsHide: true,
      shell: false,
      stdio,
    });

    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (Number.isInteger(code)) {
          resolve(code);
          return;
        }
        reject(new Error(`child exited without a code${signal ? ` (${signal})` : ''}`));
      });
    });
  } finally {
    if (logFd !== null) closeLog(logFd);
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.exitCode = await runChild(options);
  } catch (error) {
    process.stderr.write(`[hm-hidden-task] ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  USAGE,
  parseArgs,
  runChild,
};
