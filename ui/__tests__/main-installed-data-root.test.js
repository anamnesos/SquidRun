'use strict';

const fs = require('fs');
const path = require('path');

describe('main.js installed data root startup ordering', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  test('pins installed Electron userData before taking the single-instance lock', () => {
    const userDataIndex = mainSource.indexOf('const installedUserData = applyInstalledElectronUserDataPath(app, installedDataRoot);');
    const lockIndex = mainSource.indexOf('app.requestSingleInstanceLock');

    expect(userDataIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(userDataIndex).toBeLessThan(lockIndex);
  });

  test('lets explicit data roots override inherited project roots at startup', () => {
    const explicitIndex = mainSource.indexOf('} else if (explicitDataRoot?.path) {');
    const inheritedIndex = mainSource.indexOf('} else if (!process.env.SQUIDRUN_PROJECT_ROOT');

    expect(explicitIndex).toBeGreaterThanOrEqual(0);
    expect(inheritedIndex).toBeGreaterThanOrEqual(0);
    expect(explicitIndex).toBeLessThan(inheritedIndex);
  });

  test('promotes pinned installed roots into SQUIDRUN_DATA_ROOT before loading config consumers', () => {
    const dataRootPromotionIndex = mainSource.indexOf('process.env.SQUIDRUN_DATA_ROOT = pinnedInstalledDataRoot.path;');
    const configRequireIndex = mainSource.indexOf("const { resolveCoordPath } = require('./config');");

    expect(dataRootPromotionIndex).toBeGreaterThanOrEqual(0);
    expect(configRequireIndex).toBeGreaterThanOrEqual(0);
    expect(dataRootPromotionIndex).toBeLessThan(configRequireIndex);
  });

  test('uses pinned installed roots as SQUIDRUN_PROJECT_ROOT even when an inherited project root exists', () => {
    const pinnedProjectRootIndex = mainSource.indexOf('process.env.SQUIDRUN_PROJECT_ROOT = pinnedInstalledDataRoot.path;');
    const inheritedGuardIndex = mainSource.indexOf('} else if (!process.env.SQUIDRUN_PROJECT_ROOT');
    const configRequireIndex = mainSource.indexOf("const { resolveCoordPath } = require('./config');");

    expect(pinnedProjectRootIndex).toBeGreaterThanOrEqual(0);
    expect(inheritedGuardIndex).toBeGreaterThanOrEqual(0);
    expect(configRequireIndex).toBeGreaterThanOrEqual(0);
    expect(pinnedProjectRootIndex).toBeLessThan(inheritedGuardIndex);
    expect(pinnedProjectRootIndex).toBeLessThan(configRequireIndex);
  });
});
