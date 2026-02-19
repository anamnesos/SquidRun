const makeWebContents = () => ({
  send: jest.fn(),
  on: jest.fn(),
  once: jest.fn(),
  removeListener: jest.fn(),
  openDevTools: jest.fn(),
  executeJavaScript: jest.fn(async () => undefined),
  sendInputEvent: jest.fn(),
});

const focusedWindow = {
  webContents: makeWebContents(),
  isDestroyed: jest.fn(() => false),
  show: jest.fn(),
  hide: jest.fn(),
  close: jest.fn(),
  focus: jest.fn(),
};

const BrowserWindow = jest.fn(() => ({
  ...focusedWindow,
  webContents: makeWebContents(),
}));
BrowserWindow.getFocusedWindow = jest.fn(() => focusedWindow);
BrowserWindow.getAllWindows = jest.fn(() => [focusedWindow]);
BrowserWindow.fromWebContents = jest.fn(() => focusedWindow);

const app = {
  on: jest.fn(),
  once: jest.fn(),
  whenReady: jest.fn(() => Promise.resolve()),
  quit: jest.fn(),
  exit: jest.fn(),
  isPackaged: false,
  getPath: jest.fn((name) => {
    if (name === 'userData') return '/tmp/hivemind-userdata';
    return '/tmp';
  }),
};

module.exports = {
  app,
  BrowserWindow,
  clipboard: {
    readText: jest.fn(() => ''),
    writeText: jest.fn(),
  },
  dialog: {
    showOpenDialog: jest.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: jest.fn(async () => ({ canceled: true, filePath: null })),
    showMessageBox: jest.fn(async () => ({ response: 0 })),
  },
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    removeHandler: jest.fn(),
    removeListener: jest.fn(),
  },
  ipcRenderer: {
    invoke: jest.fn(async () => ({})),
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn(),
    send: jest.fn(),
    sendSync: jest.fn(() => undefined),
  },
  Menu: {
    buildFromTemplate: jest.fn(() => ({})),
    setApplicationMenu: jest.fn(),
  },
  nativeImage: {
    createFromPath: jest.fn(() => ({
      isEmpty: jest.fn(() => false),
    })),
  },
  Notification: jest.fn(() => ({
    show: jest.fn(),
  })),
  powerMonitor: {
    on: jest.fn(),
    removeListener: jest.fn(),
  },
  screen: {
    getPrimaryDisplay: jest.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })),
  },
  session: {
    defaultSession: {
      webRequest: {
        onBeforeSendHeaders: jest.fn(),
        onHeadersReceived: jest.fn(),
      },
    },
  },
  shell: {
    openExternal: jest.fn(async () => undefined),
  },
  Tray: jest.fn(() => ({
    setToolTip: jest.fn(),
    setContextMenu: jest.fn(),
    destroy: jest.fn(),
  })),
};
