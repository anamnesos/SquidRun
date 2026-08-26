'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { parseArgs, runChild } = require('../scripts/hm-hidden-task');

describe('hidden scheduled-task runner', () => {
  test('parses cwd/log options without changing the child command', () => {
    const parsed = parseArgs([
      '--cwd', 'D:\\projects\\squidrun',
      '--append-log', 'D:\\projects\\squidrun\\.squidrun\\runtime\\task.log',
      '--', 'C:\\Program Files\\nodejs\\node.exe', 'job.js', '--flag', 'value',
    ]);
    expect(parsed).toEqual({
      cwd: path.resolve('D:\\projects\\squidrun'),
      appendLog: path.resolve('D:\\projects\\squidrun\\.squidrun\\runtime\\task.log'),
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['job.js', '--flag', 'value'],
    });
  });

  test('rejects an absent child command', () => {
    expect(() => parseArgs(['--cwd', '.'])).toThrow(/missing child command/i);
    expect(() => parseArgs(['--'])).toThrow(/missing child command/i);
  });

  test('forces a hidden, shell-free child and preserves its exit code', async () => {
    const child = new EventEmitter();
    const spawnProcess = jest.fn(() => child);
    const result = runChild({
      cwd: 'D:\\work',
      appendLog: null,
      executable: 'node.exe',
      args: ['job.js'],
    }, { spawnProcess });
    child.emit('exit', 23, null);

    await expect(result).resolves.toBe(23);
    expect(spawnProcess).toHaveBeenCalledWith('node.exe', ['job.js'], expect.objectContaining({
      cwd: 'D:\\work',
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
    }));
  });

  test('uses one append handle for stdout/stderr and closes it after exit', async () => {
    const child = new EventEmitter();
    const openLog = jest.fn(() => 41);
    const closeLog = jest.fn();
    const spawnProcess = jest.fn(() => child);
    const result = runChild({
      cwd: null,
      appendLog: 'D:\\logs\\task.log',
      executable: 'node.exe',
      args: [],
    }, { spawnProcess, openLog, closeLog });
    child.emit('exit', 0, null);

    await expect(result).resolves.toBe(0);
    expect(spawnProcess.mock.calls[0][2].stdio).toEqual(['ignore', 41, 41]);
    expect(closeLog).toHaveBeenCalledWith(41);
  });

  test('VBS launcher hides the child and waits so Scheduler receives its exit code', () => {
    const launcher = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'hm-run-hidden.vbs'),
      'utf8'
    );
    expect(launcher).toContain('shell.Run(command, 0, True)');
    expect(launcher).toContain('WScript.Quit exitCode');
  });

  test('supervisor installer uses the hidden runner instead of a visible cmd action', () => {
    const installer = fs.readFileSync(
      path.join(__dirname, '..', 'scripts', 'install-supervisor-task.ps1'),
      'utf8'
    );
    expect(installer).toContain("$hiddenTaskRunner = Join-Path $PSScriptRoot 'hm-hidden-task.js'");
    expect(installer).toContain("$hiddenLauncher = Join-Path $PSScriptRoot 'hm-run-hidden.vbs'");
    expect(installer).toContain("'--append-log'");
    expect(installer).toContain('-Execute $wscript');
    expect(installer).not.toContain("New-ScheduledTaskAction -Execute 'cmd.exe'");
  });
});
