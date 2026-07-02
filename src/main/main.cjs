const path = require('path');
const https = require('https');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, powerMonitor, powerSaveBlocker, systemPreferences } = require('electron');
const { ConfigStore } = require('./store.cjs');
const { FeishuService } = require('./feishu-service.cjs');
const { CodexService, stringifyError } = require('./codex-service.cjs');
const { BridgeRouter } = require('./router.cjs');
const { redactDeep } = require('./redact.cjs');
const { resolveCodexBin } = require('./codex-bin.cjs');
const { createDesktopInputService } = require('./input-service.cjs');
const { CodexSessionWatcher } = require('./codex-session-watcher.cjs');

let mainWindow = null;
let tray = null;
let store = null;
let feishu = null;
let codex = null;
let router = null;
let desktopInput = null;
let sessionWatcher = null;
let sessionEventQueue = Promise.resolve();
let lastTrayRunning = null;
let taskPowerBlockerId = null;

const APP_DISPLAY_NAME = '传令书';
const USER_DATA_DIR = 'codex-feishu-bridge';
const SESSION_RECOVERY_REPLAY_BUFFER_MS = 60 * 1000;
const PRIVACY_PANES = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
};
const EXTERNAL_LINK_HOSTS = new Set(['open.feishu.cn', 'www.feishu.cn', 'feishu.cn']);
const UPDATE_REPOSITORY = 'huyuanfeng45/chuanlingshu';
const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
const UPDATE_LATEST_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;

function appIconPath() {
  return path.join(__dirname, '..', '..', 'assets', 'app-icon.png');
}

function trayIconPath(running) {
  const fileName = running ? 'tray-icon-running.png' : 'tray-icon-stopped.png';
  return path.join(__dirname, '..', '..', 'assets', fileName);
}

function useStableUserDataPath() {
  app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_DIR));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldStartHidden() {
  if (process.argv.includes('--hidden')) return true;
  try {
    const loginItem = app.getLoginItemSettings({ path: process.execPath });
    return Boolean(loginItem.wasOpenedAtLogin || loginItem.wasOpenedAsHidden);
  } catch {
    return false;
  }
}

function syncLaunchAtLogin(enabled) {
  if (!['darwin', 'win32'].includes(process.platform)) return;

  const settings = {
    openAtLogin: Boolean(enabled),
    path: process.execPath
  };

  if (process.platform === 'darwin') {
    settings.openAsHidden = true;
  }

  app.setLoginItemSettings({
    ...settings,
    args: process.platform === 'win32' ? ['--hidden'] : []
  });
}

function hasAccessibilityPermission() {
  if (process.platform !== 'darwin') return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return false;
  }
}

function screenRecordingStatus() {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

function hasScreenRecordingPermission() {
  return screenRecordingStatus() === 'granted';
}

function permissionStatus() {
  const accessibilityGranted = hasAccessibilityPermission();
  const screenStatus = screenRecordingStatus();
  const screenGranted = screenStatus === 'granted';

  return {
    platform: process.platform,
    supported: process.platform === 'darwin',
    guideSeen: Boolean(store?.state.settings.permissionGuideSeen),
    allGranted: accessibilityGranted && screenGranted,
    accessibility: {
      key: 'accessibility',
      title: '辅助功能',
      granted: accessibilityGranted,
      status: accessibilityGranted ? 'granted' : 'missing',
      detail: accessibilityGranted
        ? '已允许传令书控制 Codex 窗口输入。'
        : '用于把飞书消息粘贴到 Codex 输入框并回车发送。'
    },
    screen: {
      key: 'screen',
      title: '屏幕录制',
      granted: screenGranted,
      status: screenStatus,
      detail: screenGranted
        ? '已允许传令书截取 Codex 窗口状态。'
        : '用于点击任务卡“线程截图”时把 Codex 窗口画面发回飞书。'
    }
  };
}

async function openPrivacyPane(type) {
  const url = PRIVACY_PANES[type];
  if (!url) return false;

  try {
    await shell.openExternal(url);
    return true;
  } catch (error) {
    log('error', `无法打开系统权限设置：${error.message}`);
    return false;
  }
}

async function openAllowedExternalUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('链接格式不正确');
  }

  const allowed = parsed.protocol === 'https:' && (
    EXTERNAL_LINK_HOSTS.has(parsed.hostname)
    || parsed.hostname.endsWith('.open.feishu.cn')
    || parsed.hostname.endsWith('.feishu.cn')
  );
  if (!allowed) {
    throw new Error('只能打开飞书官方链接');
  }

  await shell.openExternal(parsed.toString());
  return true;
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff > 0) return 1;
    if (diff < 0) return -1;
  }

  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `${APP_DISPLAY_NAME}/${app.getVersion()}`
      },
      timeout: 10000
    }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub 返回 ${response.statusCode || '未知状态'}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`GitHub 更新信息解析失败：${error.message}`));
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('检查更新超时'));
    });
    request.on('error', reject);
  });
}

async function checkForUpdates() {
  const currentVersion = app.getVersion();
  const fallback = {
    currentVersion,
    latestVersion: currentVersion,
    hasUpdate: false,
    releaseUrl: UPDATE_RELEASES_URL,
    releasesUrl: UPDATE_RELEASES_URL,
    repository: UPDATE_REPOSITORY
  };

  try {
    const release = await fetchJson(UPDATE_LATEST_API_URL);
    const latestVersion = normalizeVersion(release.tag_name || release.name || currentVersion);

    return {
      ...fallback,
      latestVersion,
      hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
      releaseName: release.name || `v${latestVersion}`,
      publishedAt: release.published_at || '',
      releaseUrl: release.html_url || UPDATE_RELEASES_URL,
      body: release.body || ''
    };
  } catch (error) {
    return {
      ...fallback,
      error: error.message
    };
  }
}

async function runStartupPermissionCheck() {
  if (process.platform !== 'darwin') return;

  await delay(900);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const accessibility = hasAccessibilityPermission();
    const screenRecording = hasScreenRecordingPermission();

    if (accessibility && screenRecording) {
      if (attempt === 0) log('system', '权限自检通过：辅助功能和屏幕录制均已授权');
      return;
    }

    if (!accessibility) {
      if (attempt === 0) {
        log('system', '权限自检：缺少辅助功能权限，已打开系统设置');
        await openPrivacyPane('accessibility');
      }
      await delay(3000);
      continue;
    }

    if (!screenRecording) {
      log('system', `权限自检：缺少屏幕录制权限（${screenRecordingStatus()}），已打开系统设置`);
      await openPrivacyPane('screen');
      return;
    }
  }
}

function makeTrayIcon(running) {
  const image = nativeImage.createFromPath(trayIconPath(Boolean(running)));
  if (!image.isEmpty()) {
    image.setTemplateImage(false);
    return image.resize({ width: 18, height: 18 });
  }

  return nativeImage.createFromPath(appIconPath()).resize({ width: 18, height: 18 });
}

function buildTrayMenu(running) {
  return Menu.buildFromTemplate([
    {
      label: `状态：${running ? '已启动' : '未启动'}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: `显示 ${APP_DISPLAY_NAME}`,
      click: () => {
        mainWindow.show();
      }
    },
    {
      label: '启动桥接',
      click: () => startBridge().catch((error) => log('error', error.message))
    },
    {
      label: '停止桥接',
      click: () => stopBridge().catch((error) => log('error', error.message))
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function updateTrayIcon(running) {
  if (!tray) return;
  const isRunning = Boolean(running);
  if (lastTrayRunning === isRunning) return;
  lastTrayRunning = isRunning;
  tray.setImage(makeTrayIcon(isRunning));
  tray.setToolTip(`${APP_DISPLAY_NAME}：${isRunning ? '已启动' : '未启动'}`);
  tray.setContextMenu(buildTrayMenu(isRunning));
}

function syncTaskPowerBlocker() {
  if (!store) return;
  const shouldBlock = Boolean(
    store.state.runtime.bridgeRunning
    && (store.state.projects || []).some(projectNeedsSessionRecovery)
  );
  const active = taskPowerBlockerId !== null && powerSaveBlocker.isStarted(taskPowerBlockerId);

  if (shouldBlock && !active) {
    taskPowerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    log('system', '检测到 Codex 任务运行中，已临时保持 Mac 唤醒');
    return;
  }

  if (!shouldBlock && taskPowerBlockerId !== null) {
    if (powerSaveBlocker.isStarted(taskPowerBlockerId)) {
      powerSaveBlocker.stop(taskPowerBlockerId);
    }
    taskPowerBlockerId = null;
    log('system', 'Codex 任务已结束，已恢复 Mac 正常睡眠策略');
  }
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function log(type, message, meta = {}) {
  const entry = { type, message, meta, at: new Date().toISOString() };
  if (store) store.addEvent(type, message, meta);
  broadcast('log:entry', entry);
}

function enqueueSessionWatcherEvent(label, handler) {
  sessionEventQueue = sessionEventQueue
    .catch(() => {})
    .then(async () => {
      publishWatcherStatus();
      await handler();
    })
    .catch((error) => {
      log('error', `${label}处理失败：${error.message}`);
    });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 620,
    show: !shouldStartHidden(),
    title: APP_DISPLAY_NAME,
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const running = Boolean(store?.state.runtime.bridgeRunning);
  tray = new Tray(makeTrayIcon(running));
  tray.on('click', () => mainWindow.show());
  updateTrayIcon(running);
}

function configureServices() {
  feishu = new FeishuService();
  desktopInput = createDesktopInputService();
  sessionWatcher = new CodexSessionWatcher();
  codex = new CodexService({
    codexBin: store.state.settings.codexBin || 'codex'
  });
  router = new BridgeRouter({
    store,
    codex,
    feishu,
    desktopInput,
    sessionWatcher,
    openCodexThread: (threadId) => shell.openExternal(`codex://threads/${encodeURIComponent(threadId)}`)
  });

  store.on('changed', (state) => {
    broadcast('state:changed', withAppVersion(state));
    updateTrayIcon(state.runtime?.bridgeRunning);
    syncTaskPowerBlocker();
    if (state.runtime?.bridgeRunning) syncSessionWatcherThreads({ logRecovery: false });
  });
  feishu.on('status', (status) => store.updateRuntime({ feishuStatus: status }));
  feishu.on('message', (message) => {
    log('feishu', `收到飞书消息：${message.text}`, { chatId: message.chatId, senderId: message.senderId });
    router.handleFeishuMessage(message);
  });
  feishu.on('card-action', (action) => {
    log('feishu', `收到飞书卡片操作：${action.actionValue?.action || 'unknown'}`, {
      chatId: action.chatId,
      operatorId: action.operatorId,
      messageId: action.messageId
    });
    router.handleCardAction(action).catch((error) => log('error', error.message));
  });

  codex.on('status', (status) => store.updateRuntime({ codexStatus: status }));
  codex.on('log', (entry) => log(entry.type, entry.message));
  codex.on('error', (error) => {
    store.updateRuntime({ lastError: stringifyError(error) });
    log('error', stringifyError(error));
  });
  codex.on('notification', (message) => {
    router.handleCodexNotification(message).catch((error) => log('error', error.message));
  });
  codex.on('agent-delta', (delta) => {
    router.handleAgentDelta(delta).catch((error) => log('error', error.message));
  });

  sessionWatcher.on('log', (entry) => {
    publishWatcherStatus();
    log(entry.type, entry.message);
  });
  sessionWatcher.on('error', (error) => {
    publishWatcherStatus();
    log('error', `Codex 会话监听失败：${error.message}`);
  });
  sessionWatcher.on('task-started', (event) => {
    enqueueSessionWatcherEvent('Codex 任务开始事件', () => router.handleCodexUiTaskStarted(event));
  });
  sessionWatcher.on('user-message', (event) => {
    enqueueSessionWatcherEvent('Codex 用户消息事件', () => router.handleCodexUiUserMessage(event));
  });
  sessionWatcher.on('progress', (event) => {
    enqueueSessionWatcherEvent('Codex 进展事件', () => router.handleCodexUiProgress(event));
  });
  sessionWatcher.on('action-required', (event) => {
    enqueueSessionWatcherEvent('Codex 等待处理事件', () => router.handleCodexUiActionRequired(event));
  });
  sessionWatcher.on('task-complete', (event) => {
    enqueueSessionWatcherEvent('Codex 任务完成事件', () => router.handleCodexUiTaskComplete(event));
  });
  sessionWatcher.on('final-answer', (event) => {
    enqueueSessionWatcherEvent('Codex 最终回复事件', () => router.handleCodexUiTaskComplete(event));
  });
}

function syncSessionWatcherThreads({ logRecovery = true } = {}) {
  if (!sessionWatcher) return;
  const recoverable = [];
  const entries = store.state.projects
    .filter((project) => project.threadId)
    .map((project) => {
      if (!projectNeedsSessionRecovery(project)) {
        return {
          threadId: project.threadId,
          fromEnd: true
        };
      }

      const sinceMs = projectSessionRecoverySinceMs(project);
      recoverable.push({ project, sinceMs });
      return {
        threadId: project.threadId,
        fromEnd: false,
        sinceMs
      };
    });
  sessionWatcher.setWatchedThreads(entries);

  if (logRecovery && recoverable.length) {
    log('system', `断线恢复：正在重新监听 ${recoverable.length} 个未完成 Codex 任务`, {
      projects: recoverable.map((item) => ({
        alias: item.project.alias,
        threadId: item.project.threadId,
        sinceMs: item.sinceMs
      }))
    });
  }
}

function publishWatcherStatus() {
  if (!store || !sessionWatcher || typeof sessionWatcher.getStatus !== 'function') return;
  const status = sessionWatcher.getStatus();
  const summary = {
    running: Boolean(status.running),
    watchedCount: status.watchedCount || 0,
    foundCount: status.foundCount || 0,
    lastPollAt: status.lastPollAt || ''
  };
  const previous = store.state.runtime.watcherStatus || {};
  if (JSON.stringify(previous) === JSON.stringify(summary)) return;
  store.updateRuntime({ watcherStatus: summary });
}

function getFeishuConfig() {
  return {
    appId: store.state.settings.appId,
    appSecret: store.getSecret()
  };
}

function usesCodexUiMode() {
  return store.state.settings.deliveryMode === 'codexUi';
}

function projectNeedsSessionRecovery(project) {
  if (!project?.threadId) return false;
  if (project.activeTurnId) return true;
  if (['queued', 'running', 'sent-to-codex-ui', 'waiting-input'].includes(project.status)) return true;
  return ['queued', 'running', 'waiting-input'].includes(project.taskCard?.status);
}

function projectSessionRecoverySinceMs(project) {
  const timestamps = [
    project.taskCard?.startedAt,
    project.taskCard?.updatedAt,
    project.updatedAt,
    project.createdAt
  ];
  const parsed = timestamps
    .map((value) => Date.parse(value || ''))
    .find((value) => Number.isFinite(value) && value > 0);
  if (!parsed) return 0;
  return Math.max(0, parsed - SESSION_RECOVERY_REPLAY_BUFFER_MS);
}

function optionalCodexFailure(error) {
  const detail = stringifyError(error);
  if (!usesCodexUiMode()) return detail;
  return [
    'Codex app-server 可选能力不可用。',
    '当前是 Codex 界面输入模式，飞书发任务、粘贴到 Codex App、监听结果回传不依赖 app-server。',
    '受影响的只是“测试 Codex”“查询线程”等辅助能力。',
    `原始错误：${detail}`
  ].join('\n');
}

async function startOptionalCodexAppServer() {
  codex.setCodexBin(store.state.settings.codexBin || 'codex');
  await codex.start();
  if (store.state.settings.codexBin === 'codex' && codex.resolvedCodexBin) {
    store.updateSettings({ codexBin: codex.resolvedCodexBin });
    codex.setCodexBin(codex.resolvedCodexBin);
  }
}

async function startBridge() {
  try {
    const config = getFeishuConfig();
    feishu.configure(config);
    if (usesCodexUiMode()) {
      await codex.stop();
      store.updateRuntime({ codexStatus: 'not-required' });
    } else {
      await startOptionalCodexAppServer();
    }
    syncSessionWatcherThreads();
    sessionWatcher.start();
    publishWatcherStatus();
    await feishu.start();
    store.updateRuntime({
      bridgeRunning: true,
      lastError: ''
    });
    log('system', '桥接服务已启动');
  } catch (error) {
    store.updateRuntime({
      bridgeRunning: false,
      codexStatus: usesCodexUiMode() ? 'not-required' : 'stopped',
      lastError: stringifyError(error)
    });
    log('error', stringifyError(error));
    throw error;
  }
}

async function recoverBridgeAfterResume() {
  if (!store?.state.runtime.bridgeRunning) return;

  await new Promise((resolve) => setTimeout(resolve, 1800));
  try {
    syncSessionWatcherThreads();
    sessionWatcher.start();
    await sessionWatcher.poll();
    publishWatcherStatus();
    feishu.configure(getFeishuConfig());
    await feishu.start();
    if (!usesCodexUiMode()) {
      await startOptionalCodexAppServer();
    } else {
      store.updateRuntime({ codexStatus: 'not-required' });
    }
    store.updateRuntime({ bridgeRunning: true, lastError: '' });
    log('system', 'Mac 唤醒后已恢复飞书连接和 Codex 会话监听');
  } catch (error) {
    store.updateRuntime({ lastError: `唤醒恢复失败：${stringifyError(error)}` });
    log('error', `唤醒恢复失败：${stringifyError(error)}`);
  }
}

async function stopBridge() {
  await feishu.stop();
  await codex.stop();
  if (sessionWatcher) sessionWatcher.stop();
  publishWatcherStatus();
  store.updateRuntime({
    bridgeRunning: false,
    feishuStatus: 'stopped',
    codexStatus: 'stopped'
  });
  log('system', '桥接服务已停止');
}

function withAppVersion(state) {
  return {
    ...state,
    appVersion: app.getVersion()
  };
}

function publicState() {
  return withAppVersion(store.publicState());
}

function registerIpc() {
  ipcMain.handle('state:get', () => publicState());

  ipcMain.handle('settings:save', async (_event, settings) => {
    if (Object.prototype.hasOwnProperty.call(settings, 'launchAtLogin')) {
      syncLaunchAtLogin(settings.launchAtLogin);
    }
    store.updateSettings(settings);
    if (store.state.runtime.bridgeRunning) {
      await startBridge();
    }
    return publicState();
  });

  ipcMain.handle('dialog:chooseDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? '' : result.filePaths[0];
  });

  ipcMain.handle('bridge:start', async () => {
    await startBridge();
    return publicState();
  });

  ipcMain.handle('bridge:stop', async () => {
    await stopBridge();
    return publicState();
  });

  ipcMain.handle('feishu:test', async () => {
    const { defaultChatId } = store.state.settings;
    if (!defaultChatId) throw new Error('请先填写默认飞书 chat_id');
    feishu.configure(getFeishuConfig());
    await feishu.sendText(defaultChatId, `${APP_DISPLAY_NAME} 测试消息：飞书发送能力正常。`);
    return true;
  });

  ipcMain.handle('codex:test', async () => {
    try {
      await startOptionalCodexAppServer();
      const result = await codex.listThreads({ limit: 3 });
      return redactDeep(result);
    } catch (error) {
      throw new Error(optionalCodexFailure(error));
    }
  });

  ipcMain.handle('codex:listThreads', async (_event, query) => {
    try {
      await startOptionalCodexAppServer();
      const result = await codex.listThreads({ query, limit: 20 });
      return redactDeep(result);
    } catch (error) {
      throw new Error(optionalCodexFailure(error));
    }
  });

  ipcMain.handle('codex:resolveBin', () => {
    const resolved = resolveCodexBin(store.state.settings.codexBin || 'codex');
    store.updateSettings({ codexBin: resolved });
    return resolved;
  });

  ipcMain.handle('desktopInput:checkAccessibility', async () => {
    return desktopInput.checkAccessibility();
  });

  ipcMain.handle('permissions:get', () => permissionStatus());

  ipcMain.handle('permissions:open', async (_event, type) => {
    return openPrivacyPane(type);
  });

  ipcMain.handle('permissions:markGuideSeen', () => {
    store.updateSettings({ permissionGuideSeen: true });
    return permissionStatus();
  });

  ipcMain.handle('setupGuide:complete', () => {
    store.updateSettings({ setupGuideCompleted: true });
    return publicState();
  });

  ipcMain.handle('diagnostics:get', async () => {
    return redactDeep(await router.buildDiagnostics());
  });

  ipcMain.handle('projects:add', (_event, project) => {
    const created = store.addProject(project);
    return created;
  });

  ipcMain.handle('projects:update', (_event, projectId, patch) => {
    const updated = store.updateProject(projectId, patch);
    return updated;
  });

  ipcMain.handle('projects:remove', (_event, projectId) => {
    store.removeProject(projectId);
    return true;
  });

  ipcMain.handle('projects:setActive', (_event, chatId, projectId) => {
    store.setActiveProject(chatId || store.state.settings.defaultChatId || 'default', projectId);
    return publicState();
  });

  ipcMain.handle('chatBindings:bind', (_event, chatId, projectId) => {
    store.setActiveProject(chatId, projectId);
    const project = store.getProject(projectId);
    if (project?.threadId && sessionWatcher) {
      sessionWatcher.watchThread(project.threadId, { fromEnd: true });
      sessionWatcher.start();
      publishWatcherStatus();
    }
    return publicState();
  });

  ipcMain.handle('chatBindings:remove', (_event, chatId) => {
    store.removeActiveProject(chatId);
    return publicState();
  });

  ipcMain.handle('projects:sendPrompt', async (_event, projectId, prompt) => {
    await router.sendPromptToProject(projectId, prompt);
    return true;
  });

  ipcMain.handle('projects:sendStatus', async (_event, projectId) => {
    const project = store.getProject(projectId);
    if (!project) throw new Error('项目不存在');
    const chatId = project.chatId || store.state.settings.defaultChatId;
    if (!chatId) throw new Error('项目未绑定飞书 chat_id');
    await router.sendStatusCard(chatId, project);
    return true;
  });

  ipcMain.handle('app:openUserData', async () => {
    await shell.openPath(app.getPath('userData'));
    return true;
  });

  ipcMain.handle('feishu:openLauncher', async () => {
    await shell.openExternal('https://open.feishu.cn/page/launcher?from=backend_oneclick');
    return true;
  });

  ipcMain.handle('app:openExternal', async (_event, url) => {
    return openAllowedExternalUrl(url);
  });

  ipcMain.handle('updates:check', async () => {
    return checkForUpdates();
  });

  ipcMain.handle('updates:openReleases', async () => {
    await shell.openExternal(UPDATE_RELEASES_URL);
    return true;
  });
}

function scheduleAutoStart() {
  setTimeout(() => {
    const enabled = Boolean(store.state.settings.autoStart);
    const hasAppId = Boolean(store.state.settings.appId);
    const hasSecretRecord = Boolean(store.state.settings.appSecretEncrypted);
    log('system', `自动启动检查：autoStart=${enabled} appId=${hasAppId} secret=${hasSecretRecord}`);

    if (!enabled) return;
    if (!hasAppId || !hasSecretRecord) {
      store.updateRuntime({
        bridgeRunning: false,
        lastError: '自动启动失败：缺少飞书 App ID 或 App Secret'
      });
      return;
    }

    startBridge().catch((error) => {
      store.updateRuntime({ lastError: error.message });
      log('error', error.message);
    });
  }, 1000);
}

function registerPowerEvents() {
  powerMonitor.on('suspend', () => {
    if (store?.state.runtime.bridgeRunning) {
      log('system', '电脑即将休眠，桥接将在唤醒后尝试恢复');
    }
  });

  powerMonitor.on('resume', () => {
    recoverBridgeAfterResume().catch((error) => log('error', `唤醒恢复失败：${error.message}`));
  });
}

app.whenReady().then(async () => {
  useStableUserDataPath();
  store = new ConfigStore(app.getPath('userData'));
  try {
    syncLaunchAtLogin(store.state.settings.launchAtLogin);
  } catch (error) {
    log('error', `开机自动启动设置同步失败：${error.message}`);
  }
  configureServices();
  registerIpc();
  registerPowerEvents();
  createWindow();
  createTray();
  scheduleAutoStart();
  runStartupPermissionCheck().catch((error) => log('error', `权限自检失败：${error.message}`));
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.show();
  }
});

app.on('before-quit', async () => {
  app.isQuitting = true;
  if (feishu || codex) {
    await stopBridge().catch(() => {});
  }
});
