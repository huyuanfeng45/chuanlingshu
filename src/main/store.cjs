const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { safeStorage } = require('electron');
const { redactString, redactDeep } = require('./redact.cjs');

const CONFIG_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function createDefaultState() {
  return {
    version: CONFIG_VERSION,
    settings: {
      appId: '',
      appSecretEncrypted: '',
      defaultChatId: '',
      allowedSenderIds: '',
      triggerKeywords: '',
      codexBin: 'codex',
      model: 'gpt-5.4',
      summaryIntervalMs: 20000,
      noResponseAlertMs: 300000,
      launchAtLogin: false,
      autoStart: false,
      mirrorExistingThread: true,
      openCodexThreadOnMessage: true,
      deliveryMode: 'appServer',
      restoreClipboardAfterPaste: true,
      permissionGuideSeen: false,
      setupGuideCompleted: false
    },
    runtime: {
      bridgeRunning: false,
      feishuStatus: 'stopped',
      codexStatus: 'stopped',
      watcherStatus: {
        running: false,
        watchedCount: 0,
        foundCount: 0,
        lastPollAt: ''
      },
      lastError: ''
    },
    projects: [],
    activeByChat: {},
    events: []
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class ConfigStore extends EventEmitter {
  constructor(userDataPath) {
    super();
    this.userDataPath = userDataPath;
    this.filePath = path.join(userDataPath, 'bridge-state.json');
    this.state = createDefaultState();
    this.load();
  }

  load() {
    fs.mkdirSync(this.userDataPath, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.save();
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = {
        ...createDefaultState(),
        ...parsed,
        settings: {
          ...createDefaultState().settings,
          ...(parsed.settings || {})
        },
        runtime: {
          ...createDefaultState().runtime,
          ...(parsed.runtime || {}),
          bridgeRunning: false,
          feishuStatus: 'stopped',
          codexStatus: 'stopped'
        },
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        activeByChat: parsed.activeByChat || {},
        events: Array.isArray(parsed.events) ? parsed.events.slice(-200) : []
      };
    } catch (error) {
      const backupPath = `${this.filePath}.broken-${Date.now()}`;
      fs.copyFileSync(this.filePath, backupPath);
      this.state = createDefaultState();
      this.addEvent('system', `配置文件损坏，已备份到 ${backupPath}`);
      this.save();
    }
  }

  save() {
    fs.mkdirSync(this.userDataPath, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    this.emit('changed', this.publicState());
  }

  publicState() {
    const state = clone(this.state);
    state.settings.hasAppSecret = Boolean(state.settings.appSecretEncrypted);
    delete state.settings.appSecretEncrypted;
    return state;
  }

  getSecret() {
    const value = this.state.settings.appSecretEncrypted;
    if (!value) return '';

    if (value.startsWith('safe:')) {
      try {
        const encrypted = Buffer.from(value.slice(5), 'base64');
        return safeStorage.decryptString(encrypted);
      } catch {
        return '';
      }
    }

    if (value.startsWith('plain:')) {
      return Buffer.from(value.slice(6), 'base64').toString('utf8');
    }

    return '';
  }

  setSecret(secret) {
    if (!secret) return;

    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(secret);
      this.state.settings.appSecretEncrypted = `safe:${encrypted.toString('base64')}`;
      return;
    }

    this.state.settings.appSecretEncrypted = `plain:${Buffer.from(secret, 'utf8').toString('base64')}`;
  }

  updateSettings(patch) {
    const next = { ...patch };
    if (typeof next.appSecret === 'string' && next.appSecret.trim()) {
      this.setSecret(next.appSecret.trim());
    }
    delete next.appSecret;

    this.state.settings = {
      ...this.state.settings,
      ...next
    };
    this.save();
  }

  updateRuntime(patch) {
    this.state.runtime = {
      ...this.state.runtime,
      ...patch
    };
    this.save();
  }

  addProject(project) {
    const id = project.id || crypto.randomUUID();
    const createdAt = project.createdAt || nowIso();
    const clean = {
      id,
      alias: String(project.alias || '').trim(),
      cwd: String(project.cwd || '').trim(),
      threadId: String(project.threadId || '').trim(),
      chatId: String(project.chatId || '').trim(),
      model: String(project.model || this.state.settings.model || '').trim(),
      status: project.status || 'idle',
      activeTurnId: project.activeTurnId || '',
      taskQueue: Array.isArray(project.taskQueue) ? project.taskQueue : [],
      lastSummary: project.lastSummary || '',
      lastError: project.lastError || '',
      createdAt,
      updatedAt: nowIso()
    };

    if (!clean.alias) {
      throw new Error('项目别名不能为空');
    }
    if (!clean.cwd) {
      throw new Error('项目目录不能为空');
    }

    const existing = this.state.projects.find((item) => item.alias === clean.alias);
    if (existing) {
      throw new Error(`项目别名已存在：${clean.alias}`);
    }

    this.state.projects.push(clean);
    this.save();
    return clean;
  }

  updateProject(projectId, patch) {
    const project = this.getProject(projectId);
    if (!project) {
      throw new Error('项目不存在');
    }

    Object.assign(project, patch, { updatedAt: nowIso() });
    this.save();
    return project;
  }

  removeProject(projectId) {
    this.state.projects = this.state.projects.filter((project) => project.id !== projectId);
    for (const [chatId, activeProjectId] of Object.entries(this.state.activeByChat)) {
      if (activeProjectId === projectId) {
        delete this.state.activeByChat[chatId];
      }
    }
    this.save();
  }

  getProject(projectIdOrAlias) {
    return this.state.projects.find((project) => project.id === projectIdOrAlias || project.alias === projectIdOrAlias);
  }

  getProjectByThread(threadId) {
    return this.state.projects.find((project) => project.threadId === threadId);
  }

  setActiveProject(chatId, projectId) {
    if (!chatId) {
      throw new Error('Chat ID 不能为空');
    }
    if (!this.getProject(projectId)) {
      throw new Error('项目不存在');
    }
    this.state.activeByChat[chatId] = projectId;
    this.save();
  }

  removeActiveProject(chatId) {
    if (!chatId) {
      throw new Error('Chat ID 不能为空');
    }
    delete this.state.activeByChat[chatId];
    this.save();
  }

  getActiveProject(chatId) {
    const projectId = this.state.activeByChat[chatId];
    if (projectId) return this.getProject(projectId);

    const direct = this.state.projects.find((project) => project.chatId && project.chatId === chatId);
    if (direct) return direct;

    if (this.state.projects.length === 1) return this.state.projects[0];

    return null;
  }

  addEvent(type, message, meta = {}) {
    this.state.events.push({
      id: crypto.randomUUID(),
      type,
      message: redactString(message),
      meta: redactDeep(meta),
      at: nowIso()
    });
    this.state.events = this.state.events.slice(-200);
    this.save();
  }
}

module.exports = {
  ConfigStore,
  nowIso
};
