const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridgeApi', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseDirectory: () => ipcRenderer.invoke('dialog:chooseDirectory'),
  startBridge: () => ipcRenderer.invoke('bridge:start'),
  stopBridge: () => ipcRenderer.invoke('bridge:stop'),
  testFeishu: () => ipcRenderer.invoke('feishu:test'),
  testCodex: () => ipcRenderer.invoke('codex:test'),
  resolveCodexBin: () => ipcRenderer.invoke('codex:resolveBin'),
  checkAccessibility: () => ipcRenderer.invoke('desktopInput:checkAccessibility'),
  getPermissions: () => ipcRenderer.invoke('permissions:get'),
  openPermissionSettings: (type) => ipcRenderer.invoke('permissions:open', type),
  markPermissionGuideSeen: () => ipcRenderer.invoke('permissions:markGuideSeen'),
  completeSetupGuide: () => ipcRenderer.invoke('setupGuide:complete'),
  getDiagnostics: () => ipcRenderer.invoke('diagnostics:get'),
  listCodexThreads: (query) => ipcRenderer.invoke('codex:listThreads', query),
  addProject: (project) => ipcRenderer.invoke('projects:add', project),
  updateProject: (projectId, patch) => ipcRenderer.invoke('projects:update', projectId, patch),
  removeProject: (projectId) => ipcRenderer.invoke('projects:remove', projectId),
  setActiveProject: (chatId, projectId) => ipcRenderer.invoke('projects:setActive', chatId, projectId),
  bindChat: (chatId, projectId) => ipcRenderer.invoke('chatBindings:bind', chatId, projectId),
  removeChatBinding: (chatId) => ipcRenderer.invoke('chatBindings:remove', chatId),
  sendPrompt: (projectId, prompt) => ipcRenderer.invoke('projects:sendPrompt', projectId, prompt),
  sendStatus: (projectId) => ipcRenderer.invoke('projects:sendStatus', projectId),
  openUserData: () => ipcRenderer.invoke('app:openUserData'),
  openFeishuLauncher: () => ipcRenderer.invoke('feishu:openLauncher'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  openReleases: () => ipcRenderer.invoke('updates:openReleases'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },
  onLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('log:entry', listener);
    return () => ipcRenderer.removeListener('log:entry', listener);
  }
});
