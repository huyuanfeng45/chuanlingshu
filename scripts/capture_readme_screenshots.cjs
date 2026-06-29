const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const rendererDir = path.join(rootDir, 'src', 'renderer');
const outputDir = path.join(rootDir, 'docs', 'screenshots');
const dashboardPath = path.join(outputDir, 'dashboard.png');
const releaseHistoryPath = path.join(outputDir, 'release-history.png');
const packageJson = require(path.join(rootDir, 'package.json'));

const mockState = {
  appVersion: packageJson.version,
  settings: {
    appId: 'cli_demo_app_id',
    hasAppSecret: true,
    defaultChatId: 'oc_demo_chat_id',
    allowedSenderIds: '',
    triggerKeywords: '传令书',
    codexBin: '/Users/hyf/.local/bin/codex',
    model: 'gpt-5.4',
    deliveryMode: 'desktop',
    summaryIntervalMs: 20000,
    noResponseAlertMs: 300000,
    launchAtLogin: true,
    autoStart: true,
    mirrorExistingThread: true,
    openCodexThreadOnMessage: true,
    restoreClipboardAfterPaste: true,
    setupGuideCompleted: true
  },
  runtime: {
    bridgeRunning: true,
    feishuStatus: 'running',
    codexStatus: 'not-required',
    lastError: '',
    watcherStatus: {
      foundCount: 4,
      watchedCount: 4
    }
  },
  activeByChat: {
    oc_demo_chat_id: '18'
  },
  projects: [
    {
      id: '18',
      alias: '18',
      cwd: '/Users/hyf/Documents/New project 18',
      threadId: '019f0000-0000-7000-8000-demo00000001',
      chatId: '默认 Chat ID',
      status: 'idle',
      taskQueue: [],
      lastSummary: ''
    },
    {
      id: '181',
      alias: '181',
      cwd: '/Users/hyf/Documents/New project 11',
      threadId: '019f0000-0000-7000-8000-demo00000002',
      chatId: 'oc_demo_chat_id',
      status: 'idle',
      taskQueue: [],
      lastSummary: ''
    },
    {
      id: 'ai-report',
      alias: 'AI 报告',
      cwd: '/Users/hyf/Documents/AI Report',
      threadId: '019f0000-0000-7000-8000-demo00000003',
      chatId: '默认 Chat ID',
      status: 'idle',
      taskQueue: [],
      lastSummary: ''
    },
    {
      id: 'new-project-17',
      alias: 'New-project-17',
      cwd: '/Users/hyf/Documents/New project 17',
      threadId: '019f0000-0000-7000-8000-demo00000004',
      chatId: '默认 Chat ID',
      status: 'idle',
      taskQueue: [],
      lastSummary: ''
    }
  ],
  events: [
    {
      at: Date.now() - 60000,
      type: 'update-check',
      message: '已连接 GitHub Releases 更新列表'
    }
  ]
};

function createMockBridge() {
  return {
    getState: async () => mockState,
    saveSettings: async () => mockState,
    chooseDirectory: async () => '',
    startBridge: async () => null,
    stopBridge: async () => null,
    testFeishu: async () => null,
    testCodex: async () => ({ ok: true }),
    resolveCodexBin: async () => '/Users/hyf/.local/bin/codex',
    checkAccessibility: async () => true,
    getPermissions: async () => ({
      supported: true,
      guideSeen: true,
      allGranted: true,
      accessibility: { granted: true, status: 'granted' },
      screen: { granted: true, status: 'granted' }
    }),
    openPermissionSettings: async () => null,
    markPermissionGuideSeen: async () => ({
      supported: true,
      guideSeen: true,
      allGranted: true,
      accessibility: { granted: true, status: 'granted' },
      screen: { granted: true, status: 'granted' }
    }),
    completeSetupGuide: async () => null,
    getDiagnostics: async () => ({}),
    listCodexThreads: async () => [],
    addProject: async () => null,
    updateProject: async () => null,
    removeProject: async () => null,
    setActiveProject: async () => null,
    bindChat: async () => null,
    removeChatBinding: async () => null,
    sendPrompt: async () => null,
    sendStatus: async () => null,
    openUserData: async () => null,
    openFeishuLauncher: async () => null,
    openExternal: async () => null,
    checkForUpdates: async () => ({
      hasUpdate: false,
      currentVersion: packageJson.version,
      latestVersion: packageJson.version
    }),
    openReleases: async () => null,
    onState: () => () => {},
    onLog: () => () => {}
  };
}

if (process.type === 'renderer') {
  window.bridgeApi = createMockBridge();
} else {
  const { app, BrowserWindow } = require('electron');

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function capture(win, targetPath) {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(targetPath, image.toPNG());
  }

  app.whenReady().then(async () => {
    fs.mkdirSync(outputDir, { recursive: true });

    const win = new BrowserWindow({
      width: 1180,
      height: 760,
      show: false,
      backgroundColor: '#f4f6fb',
      webPreferences: {
        preload: __filename,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false
      }
    });

    await win.loadFile(path.join(rendererDir, 'index.html'));
    await wait(700);
    await capture(win, dashboardPath);

    await win.webContents.executeJavaScript(`
      document.querySelector('#releaseNotesModal').hidden = false;
      document.querySelector('#releaseNotesModal').classList.add('show');
      document.querySelector('.release-note-version').setAttribute('open', '');
    `);
    await wait(300);
    await capture(win, releaseHistoryPath);

    await app.quit();
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
}
