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
});
