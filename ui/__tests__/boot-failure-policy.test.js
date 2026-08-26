'use strict';

const fs = require('fs');
const path = require('path');

const { createBootFailurePolicy } = require('../modules/main/boot-failure-policy');

describe('boot failure policy', () => {
  function fixture() {
    const app = { exit: jest.fn() };
    const dialog = { showErrorBox: jest.fn() };
    const log = { error: jest.fn() };
    const breadcrumb = jest.fn();
    const policy = createBootFailurePolicy({ app, dialog, log, breadcrumb, processRef: {} });
    return { app, dialog, log, breadcrumb, policy };
  }

  test('shows a native error and exits once when boot throws before init completes', () => {
    const { app, dialog, breadcrumb, policy } = fixture();

    const first = policy.handleUncaughtException(new Error('missing startup module'));
    const duplicate = policy.handleUnhandledRejection(new Error('secondary failure'));

    expect(first).toEqual(expect.objectContaining({ fatal: true, duplicate: false }));
    expect(duplicate).toEqual(expect.objectContaining({ fatal: true, duplicate: true }));
    expect(dialog.showErrorBox).toHaveBeenCalledTimes(1);
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'SquidRun could not start',
      expect.stringContaining('missing startup module')
    );
    expect(app.exit).toHaveBeenCalledTimes(1);
    expect(app.exit).toHaveBeenCalledWith(1);
    expect(breadcrumb).toHaveBeenCalledWith('main:boot-fatal', expect.objectContaining({
      stage: 'uncaught_exception',
      error: 'missing startup module',
    }));
  });

  test('init rejection is fatal and releases the single-instance process', () => {
    const { app, policy } = fixture();

    const result = policy.handleInitFailure(new Error('window creation failed'));

    expect(result).toEqual(expect.objectContaining({ fatal: true, stage: 'app_init' }));
    expect(app.exit).toHaveBeenCalledWith(1);
  });

  test('keeps post-boot runtime errors log-only', () => {
    const { app, dialog, log, policy } = fixture();
    policy.markBootComplete();

    const result = policy.handleUncaughtException(new Error('late runtime error'));

    expect(result).toEqual(expect.objectContaining({ fatal: false }));
    expect(log.error).toHaveBeenCalledWith('[Main] Uncaught exception:', 'late runtime error');
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
  });

  test('main wires the policy before optional startup modules and marks boot complete only after init', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const policyInstall = source.indexOf('createBootFailurePolicy({');
    const optionalModuleLoad = source.indexOf("require('./modules/noise-bootstrap')");
    const awaitInit = source.indexOf('await squidrunApp.init();');
    const markComplete = source.indexOf('bootFailurePolicy.markBootComplete();');

    expect(policyInstall).toBeGreaterThan(-1);
    expect(optionalModuleLoad).toBeGreaterThan(policyInstall);
    expect(awaitInit).toBeGreaterThan(optionalModuleLoad);
    expect(markComplete).toBeGreaterThan(awaitInit);
    expect(source).toContain('bootFailurePolicy.handleInitFailure(err)');
  });
});
