const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { stripMarkdownForText } = require('./feishu-service.cjs');

const MAX_RESULT_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_RESULT_UPLOAD_FILES = 5;
const MAX_RESULT_IMAGE_BYTES = 10 * 1024 * 1024;
const PENDING_ATTACHMENT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_NO_RESPONSE_ALERT_MS = 5 * 60 * 1000;
const WATCH_REPLAY_WINDOW_MS = 30 * 60 * 1000;
const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESULT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.ico']);
const RESULT_UPLOAD_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.ico', '.svg',
  '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.csv', '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt',
  '.txt', '.log', '.html', '.htm', '.mp4', '.mov', '.webm', '.mp3', '.wav'
]);
const SOURCE_CODE_EXTENSIONS = new Set([
  '.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.css', '.scss', '.less',
  '.py', '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.php',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.sh', '.zsh', '.bash',
  '.yaml', '.yml', '.toml', '.lock', '.md'
]);

function escapeMarkdown(text) {
  return String(text || '').replace(/([*_`])/g, '\\$1');
}

function truncate(text, limit = 1800) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 20)}\n...已截断`;
}

function displayTime(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatDurationMs(ms) {
  const totalSeconds = Math.max(1, Math.round(Number(ms || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;

  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

function taskQueue(project) {
  return Array.isArray(project?.taskQueue) ? project.taskQueue : [];
}

function projectIsBusy(project) {
  if (!project) return false;
  if (project.activeTurnId) return true;
  if (['queued', 'running', 'sent-to-codex-ui', 'waiting-input'].includes(project.status)) return true;
  return ['queued', 'running', 'waiting-input'].includes(project.taskCard?.status);
}

function taskStatusText(status) {
  const labels = {
    queued: '已发送，等待处理',
    running: '处理中',
    'waiting-input': '等待你处理',
    'sent-to-codex-ui': '已粘贴到 Codex 界面',
    completed: '已完成',
    failed: '失败'
  };
  return labels[status] || status || '处理中';
}

function taskTemplate(status) {
  if (status === 'completed') return 'carmine';
  if (status === 'failed') return 'red';
  if (status === 'waiting-input') return 'orange';
  return 'blue';
}

function taskCardTitle(project) {
  return `Codex 任务：${project.alias}`;
}

function normalizeActionRequired(value) {
  if (!value || typeof value !== 'object') return null;
  const choices = Array.isArray(value.choices)
    ? value.choices.map((choice) => {
      if (typeof choice === 'string') {
        return {
          label: truncate(choice, 40),
          value: truncate(choice, 500),
          description: '',
          question: ''
        };
      }
      return {
        label: truncate(choice?.label || choice?.text || choice?.value || '', 40),
        value: truncate(choice?.value || choice?.label || choice?.text || '', 500),
        description: truncate(choice?.description || '', 160),
        question: truncate(choice?.question || '', 300)
      };
    }).filter((choice) => choice.label && choice.value)
    : [];

  return {
    kind: value.kind || 'input',
    title: truncate(value.title || 'Codex 需要你处理', 120),
    message: truncate(value.message || '', 900),
    command: truncate(value.command || '', 1200),
    cwd: truncate(value.cwd || '', 500),
    toolName: truncate(value.toolName || '', 80),
    requestId: truncate(value.requestId || '', 180),
    choices
  };
}

function actionRequiredMarkdown(actionRequired) {
  if (!actionRequired) return '';

  const lines = [
    '**需要你处理**：',
    escapeMarkdown(actionRequired.title || 'Codex 正在等待你处理')
  ];

  if (actionRequired.kind === 'approval') {
    lines.push('请打开 Codex 线程，在界面里点击批准或拒绝。');
  } else if (actionRequired.kind === 'choice') {
    lines.push('可以直接点击下面的选项按钮，也可以在飞书里手动回复。');
  } else {
    lines.push('可以在飞书里直接回复，传令书会继续发送到当前 Codex 线程。');
  }

  if (actionRequired.message) {
    lines.push('', '**说明**：', escapeMarkdown(actionRequired.message));
  }

  if (actionRequired.cwd) {
    lines.push('', `**目录**：${escapeMarkdown(actionRequired.cwd)}`);
  }

  if (actionRequired.command) {
    lines.push('', '**命令**：', '```text', truncate(actionRequired.command, 1200), '```');
  }

  if (actionRequired.choices?.length) {
    lines.push('', '**可选项**：');
    for (const choice of actionRequired.choices.slice(0, 8)) {
      const detail = choice.description ? `：${choice.description}` : '';
      lines.push(`- ${escapeMarkdown(choice.label)}${escapeMarkdown(detail)}`);
    }
  }

  return lines.join('\n');
}

function taskCardMarkdown(project, task) {
  const queue = taskQueue(project);
  const lines = [
    `**状态**：${escapeMarkdown(taskStatusText(task.status))}`,
    `**项目**：${escapeMarkdown(project.alias)}`,
    `**线程**：${escapeMarkdown(task.threadId || project.threadId || '未绑定')}`,
    queue.length ? `**队列**：后面还有 ${queue.length} 条` : '',
    task.turnId ? `**Turn**：${escapeMarkdown(task.turnId)}` : '',
    task.startedAt ? `**开始时间**：${escapeMarkdown(displayTime(task.startedAt))}` : '',
    task.updatedAt ? `**更新时间**：${escapeMarkdown(displayTime(task.updatedAt))}` : ''
  ].filter(Boolean);

  if (queue.length) {
    lines.push('', '**队首**：', escapeMarkdown(truncate(queue[0].prompt, 300)));
  }

  if (task.prompt) {
    lines.push('', '**任务**：', escapeMarkdown(truncate(task.prompt, 700)));
  }

  if (task.summary) {
    lines.push('', '**当前进展**：', truncate(task.summary, 1400));
  }

  const actionRequired = normalizeActionRequired(task.actionRequired);
  if (actionRequired) {
    lines.push('', actionRequiredMarkdown(actionRequired));
  }

  if (task.result) {
    lines.push('', '**结果**：', truncate(task.result, 3200));
  }

  if (task.error) {
    lines.push('', '**错误**：', escapeMarkdown(truncate(task.error, 1200)));
  }

  return lines.join('\n');
}

function taskCardActions(project, task) {
  const queue = taskQueue(project);
  const busy = projectIsBusy(project);
  const actionRequired = normalizeActionRequired(task.actionRequired);
  const base = {
    projectId: project.id,
    threadId: task.threadId || project.threadId || ''
  };
  const actions = [];

  if (actionRequired?.kind === 'choice' && actionRequired.choices.length) {
    for (const choice of actionRequired.choices.slice(0, 5)) {
      actions.push({
        text: choice.label,
        action: 'codex_choice_reply',
        type: actions.length === 0 ? 'primary' : 'default',
        value: {
          ...base,
          choiceValue: choice.value,
          actionRequestId: actionRequired.requestId || ''
        }
      });
    }
  }

  actions.push({
    text: actionRequired?.kind === 'approval' ? '打开线程处理' : '刷新状态',
    action: actionRequired?.kind === 'approval' && base.threadId ? 'open_thread' : 'task_status',
    type: actionRequired?.kind === 'choice' && actionRequired.choices.length ? 'default' : 'primary',
    value: base
  });

  if (base.threadId && actionRequired?.kind !== 'approval') {
    actions.push({
      text: '打开线程',
      action: 'open_thread',
      value: base
    });
  }

  if (actionRequired) {
    return actions;
  }

  if (queue.length && project.activeTurnId) {
    actions.push({
      text: '追加队首',
      action: 'queue_append_next',
      value: base
    });
  }

  if (queue.length && !busy) {
    actions.push({
      text: '运行队首',
      action: 'queue_run_next',
      type: 'primary',
      value: base
    });
  }

  if (queue.length) {
    actions.push({
      text: '清空队列',
      action: 'queue_clear',
      type: 'danger',
      value: base
    });
  }

  if (task.prompt && ['completed', 'failed'].includes(task.status)) {
    actions.push({
      text: '重新发送',
      action: 'task_retry',
      value: base
    });
  }

  return actions;
}

function cardPlainText(content) {
  return {
    tag: 'plain_text',
    content
  };
}

function bridgeActionValue(action, value = {}) {
  return {
    bridge: 'codex-feishu-bridge',
    action,
    ...value
  };
}

function projectLine(project, active = false) {
  const marker = active ? '→ ' : '';
  const thread = project.threadId ? project.threadId : '未创建';
  const queue = taskQueue(project).length ? ` | 队列 ${taskQueue(project).length}` : '';
  return `${marker}${project.alias} | ${project.status || 'idle'}${queue} | ${thread} | ${project.cwd}`;
}

function threadArray(result) {
  const threads = result?.data || result?.threads || result?.items || result?.sessions || [];
  return Array.isArray(threads) ? threads : [];
}

function parseAllowedSenderIds(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTriggerKeywords(value) {
  return String(value || '')
    .split(/[,\s,，;；\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeMessageText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function consumeTriggerKeyword(value, triggerKeywords) {
  const text = normalizeMessageText(value);
  const keywords = parseTriggerKeywords(triggerKeywords);
  if (!keywords.length) {
    return { matched: true, text, keyword: '' };
  }

  const lowerText = text.toLocaleLowerCase();
  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLocaleLowerCase();
    if (!lowerKeyword || !lowerText.startsWith(lowerKeyword)) continue;

    const rest = text.slice(keyword.length).replace(/^[\s:：,，.。-]+/, '').trim();
    return { matched: true, text: rest, keyword };
  }

  return { matched: false, text, keyword: '' };
}

function parseBareCodexThreadId(value) {
  const text = normalizeMessageText(value)
    .replace(/^<|>$/g, '')
    .trim();
  const match = text.match(/^(?:codex:\/\/threads\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?.*)?$/i);
  return match ? match[1] : '';
}

function parseLeadingCodexThreadId(value) {
  const text = normalizeMessageText(value)
    .replace(/^</, '')
    .trim();
  const match = text.match(/^(?:codex:\/\/threads\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?[^>\s]*)?>?(?=\s|$|[，,。.:：])/i);
  return match ? match[1] : '';
}

function threadIdFromThread(thread) {
  return thread?.id || thread?.threadId || thread?.sessionId || '';
}

function threadTitle(thread) {
  return thread?.name || thread?.title || thread?.summary || '';
}

function normalizeActionValue(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function dateFolderName(value = Date.now()) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function safePathSegment(value, fallback = 'attachment') {
  const name = String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+$/, '')
    .slice(0, 120);
  return name || fallback;
}

function attachmentTypeLabel(type) {
  if (type === 'image') return '图片';
  if (type === 'file') return '文件';
  return '附件';
}

function isInlineCodexUiImageAttachment(attachment) {
  if (!attachment?.path) return false;
  if (attachment.type === 'image') return true;
  return RESULT_IMAGE_EXTENSIONS.has(path.extname(attachment.path || '').toLowerCase());
}

function attachmentBaseName(attachment, index) {
  const fallback = `${attachment.type || 'attachment'}-${attachment.fileKey || index + 1}`;
  const name = path.basename(attachment.fileName || fallback);
  const safe = safePathSegment(name, `attachment-${index + 1}`);
  if (path.extname(safe)) return safe;
  return `${safe}${attachment.type === 'image' ? '.png' : '.bin'}`;
}

function formatBytes(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function isResultImagePath(filePath) {
  return RESULT_IMAGE_EXTENSIONS.has(path.extname(filePath || '').toLowerCase());
}

function isInsidePath(childPath, rootPath) {
  if (!childPath || !rootPath) return false;
  const child = path.resolve(childPath);
  const root = path.resolve(rootPath);
  return child === root || child.startsWith(`${root}${path.sep}`);
}

function stripPathDecorations(value) {
  return decodeURIComponent(String(value || ''))
    .trim()
    .replace(/^["'`<({\[]+/, '')
    .replace(/[>"'`.,;，。；：:!！?)\]}]+$/g, '')
    .trim();
}

function resolveExistingFilePath(value) {
  const raw = stripPathDecorations(value).replace(/^file:\/\//, '');
  if (!raw.startsWith('/')) return '';

  const candidates = [raw];
  const lineSuffix = raw.match(/^(.+):\d+(?::\d+)?$/);
  if (lineSuffix) candidates.push(lineSuffix[1]);

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return path.resolve(candidate);
    } catch {
      // Try trimming trailing explanation text below.
    }
  }

  for (let end = raw.length - 1; end > 0; end -= 1) {
    const candidate = stripPathDecorations(raw.slice(0, end));
    if (!candidate || !candidate.startsWith('/')) continue;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return path.resolve(candidate);
    } catch {
      // Keep walking back until a real file boundary is found.
    }
  }

  return '';
}

function hasResultUploadHint(context) {
  return /结果文件|产物|输出|导出|已生成|生成了|保存到|已保存|报告|截图|压缩包|saved to|generated|output|artifact|exported|created at|written to/i
    .test(String(context || ''));
}

function shouldUploadResultPath(filePath, context) {
  const ext = path.extname(filePath).toLowerCase();
  if (SOURCE_CODE_EXTENSIONS.has(ext)) return false;
  if (RESULT_UPLOAD_EXTENSIONS.has(ext)) return true;
  return hasResultUploadHint(context);
}

function collectPathCandidates(text) {
  const value = String(text || '');
  const candidates = [];
  const patterns = [
    /\[[^\]]*]\((file:\/\/\/[^)\n]+|\/[^)\n]+)\)/g,
    /`(file:\/\/\/[^`\n]+|\/[^`\n]+)`/g,
    /<(file:\/\/\/[^>\n]+|\/[^>\n]+)>/g
  ];

  for (const line of value.split('\n')) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        candidates.push({
          value: match[1],
          context: line
        });
      }
    }

    const start = line.indexOf('/');
    if (start >= 0) {
      candidates.push({
        value: line.slice(start),
        context: line
      });
    }
  }

  return candidates;
}

class BridgeRouter extends EventEmitter {
  constructor({ store, codex, feishu, desktopInput, sessionWatcher, openCodexThread }) {
    super();
    this.store = store;
    this.codex = codex;
    this.feishu = feishu;
    this.desktopInput = desktopInput;
    this.sessionWatcher = sessionWatcher;
    this.openCodexThread = openCodexThread;
    this.lastProgressSentAt = new Map();
    this.lastProgressText = new Map();
    this.uiPendingByThread = new Map();
    this.pendingPromptByThread = new Map();
    this.pendingAttachmentsByRoute = new Map();
    this.noResponseWatches = new Map();
    this.uploadedResultFileKeys = new Set();
  }

  async handleFeishuMessage(message) {
    const allowed = parseAllowedSenderIds(this.store.state.settings.allowedSenderIds);
    if (allowed.length && !allowed.includes(message.senderId)) {
      await this.safeSendText(message.chatId, '你不在允许控制 Codex 的用户列表里。');
      return;
    }

    const rawText = message.text.trim();
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    if (!rawText && !attachments.length) return;

    try {
      let text = rawText;
      if (!attachments.length && text.startsWith('/')) {
        await this.handleCommand(message, text);
        return;
      }

      const directThreadId = attachments.length ? '' : parseBareCodexThreadId(text);
      if (directThreadId) {
        await this.bindChatToThreadId(message.chatId, directThreadId);
        return;
      }

      const leadingThreadId = attachments.length ? '' : parseLeadingCodexThreadId(text);
      if (leadingThreadId) {
        await this.safeSendText(message.chatId, [
          `检测到消息开头是 Codex 会话 ID：${leadingThreadId}`,
          '为了避免把内容发到旧绑定线程，传令书没有继续投递这条消息。',
          '',
          '如果要把当前群切换到这个会话，请只发送这一整个会话 ID，或发送：',
          `/bind-thread ${leadingThreadId}`,
          '',
          '如果这只是普通说明，请删掉开头的会话 ID 后重新发送。'
        ].join('\n'));
        return;
      }

      const project = this.store.getActiveProject(message.chatId);
      if (!project) {
        await this.safeSendText(message.chatId, '还没有选中项目。先发送 /list 查看项目，再用 /use 项目别名 选择。');
        return;
      }

      const triggerResult = consumeTriggerKeyword(text, this.store.state.settings.triggerKeywords);
      if (!triggerResult.matched) {
        this.store.addEvent('system', '已忽略未包含触发词的群消息', {
          chatId: message.chatId,
          triggerKeywords: this.store.state.settings.triggerKeywords || ''
        });
        return;
      }
      text = triggerResult.text;
      if (!text && !attachments.length) {
        await this.safeSendText(message.chatId, '收到触发词了，请在后面写要发给 Codex 的内容。');
        return;
      }

      if (attachments.length) {
        await this.handleAttachmentMessage(message, project, text);
        return;
      }

      const pendingAttachments = this.takePendingAttachments(message.chatId, project.id);
      if (pendingAttachments) {
        await this.sendAttachmentPrompt(project, message.chatId, pendingAttachments.attachments, text, {
          sourceMessageId: message.messageId || pendingAttachments.sourceMessageIds[0] || ''
        });
        return;
      }

      await this.sendPromptToProject(project.id, text, message.chatId, {
        sourceMessageId: message.messageId
      });
    } catch (error) {
      this.store.addEvent('error', error.message, { source: 'feishu-message' });
      await this.safeSendText(message.chatId, `处理失败：${error.message}`);
    }
  }

  async handleAttachmentMessage(message, project, note = '') {
    if (typeof this.feishu.downloadMessageResource !== 'function') {
      throw new Error('当前飞书服务不支持附件下载，请更新应用后重试');
    }

    const savedAttachments = await this.saveMessageAttachments(message, project);
    const pending = this.takePendingAttachments(message.chatId, project.id);
    const attachments = [
      ...(pending?.attachments || []),
      ...savedAttachments
    ];
    const sourceMessageIds = [
      ...(pending?.sourceMessageIds || []),
      message.messageId
    ].filter(Boolean);

    if (normalizeMessageText(note)) {
      await this.sendAttachmentPrompt(project, message.chatId, attachments, note, {
        sourceMessageId: message.messageId || sourceMessageIds[0] || ''
      });
      return;
    }

    this.holdPendingAttachments(message.chatId, project, attachments, sourceMessageIds);
    await this.safeSendText(message.chatId, [
      `已收到 ${this.attachmentBatchLabel(attachments)}，先不发送给 Codex。`,
      '请直接再发一条文字说明，我会把附件和文字合并成同一条任务。',
      '如果只想发送附件本身，可以发 /send-attachments；如果发错了，发 /cancel-attachments。'
    ].join('\n'));
  }

  async sendAttachmentPrompt(project, chatId, attachments, note = '', options = {}) {
    const inlineImages = this.shouldPasteAttachmentsIntoCodexUi(project)
      ? attachments.filter(isInlineCodexUiImageAttachment)
      : [];
    const prompt = this.buildAttachmentPrompt(project, attachments, note, {
      inlineImageCount: inlineImages.length
    });
    await this.sendPromptToProject(project.id, prompt, chatId, {
      sourceMessageId: options.sourceMessageId || '',
      attachments: inlineImages
    });
  }

  shouldPasteAttachmentsIntoCodexUi(project) {
    return Boolean(
      project?.threadId
      && this.store.state.settings.deliveryMode === 'codexUi'
      && this.desktopInput
      && typeof this.desktopInput.pasteRichIntoCodex === 'function'
    );
  }

  pendingAttachmentKey(chatId, projectId) {
    return `${chatId || ''}:${projectId || ''}`;
  }

  getPendingAttachments(chatId, projectId) {
    return this.pendingAttachmentsByRoute.get(this.pendingAttachmentKey(chatId, projectId)) || null;
  }

  clearPendingAttachments(chatId, projectId) {
    const key = this.pendingAttachmentKey(chatId, projectId);
    const pending = this.pendingAttachmentsByRoute.get(key);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pendingAttachmentsByRoute.delete(key);
    return pending || null;
  }

  takePendingAttachments(chatId, projectId) {
    const pending = this.clearPendingAttachments(chatId, projectId);
    if (!pending?.attachments?.length) return null;
    return pending;
  }

  holdPendingAttachments(chatId, project, attachments, sourceMessageIds = []) {
    const key = this.pendingAttachmentKey(chatId, project.id);
    const previous = this.clearPendingAttachments(chatId, project.id);
    const pending = {
      key,
      chatId,
      projectId: project.id,
      projectAlias: project.alias,
      attachments: [
        ...(previous?.attachments || []),
        ...(attachments || [])
      ],
      sourceMessageIds: [
        ...(previous?.sourceMessageIds || []),
        ...(sourceMessageIds || [])
      ].filter(Boolean),
      createdAt: previous?.createdAt || Date.now(),
      updatedAt: Date.now(),
      timer: null
    };

    pending.timer = setTimeout(() => {
      this.expirePendingAttachments(key).catch((error) => {
        this.store.addEvent('error', `附件暂存过期处理失败：${error.message}`, { project: project.alias });
      });
    }, PENDING_ATTACHMENT_TTL_MS);
    if (typeof pending.timer.unref === 'function') pending.timer.unref();

    this.pendingAttachmentsByRoute.set(key, pending);
    return pending;
  }

  async expirePendingAttachments(key) {
    const pending = this.pendingAttachmentsByRoute.get(key);
    if (!pending) return;
    this.pendingAttachmentsByRoute.delete(key);
    this.store.addEvent('system', `附件暂存已过期：${this.attachmentBatchLabel(pending.attachments)}`, {
      project: pending.projectAlias,
      chatId: pending.chatId
    });
    await this.safeSendText(pending.chatId, `附件等待文字说明超过 5 分钟，已取消暂存：${this.attachmentBatchLabel(pending.attachments)}。`);
  }

  attachmentBatchLabel(attachments = []) {
    const images = attachments.filter((item) => item.type === 'image').length;
    const files = attachments.filter((item) => item.type === 'file').length;
    const parts = [];
    if (images) parts.push(`${images} 张图片`);
    if (files) parts.push(`${files} 个文件`);
    return parts.length ? parts.join('、') : `${attachments.length || 0} 个附件`;
  }

  async saveMessageAttachments(message, project) {
    const attachments = (message.attachments || []).filter((attachment) => (
      attachment?.fileKey && ['image', 'file'].includes(attachment.type)
    ));
    if (!attachments.length) {
      throw new Error('这条飞书消息里没有可下载的图片或文件附件');
    }

    const targetDir = this.attachmentTargetDir(project);
    fs.mkdirSync(targetDir, { recursive: true });

    const saved = [];
    for (const [index, attachment] of attachments.entries()) {
      const buffer = await this.feishu.downloadMessageResource(message.messageId, attachment);
      const unique = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${attachmentBaseName(attachment, index)}`;
      const filePath = path.join(targetDir, unique);
      fs.writeFileSync(filePath, buffer);
      saved.push({
        ...attachment,
        fileName: attachment.fileName || attachmentBaseName(attachment, index),
        path: filePath,
        size: buffer.length
      });
    }

    this.store.addEvent('system', `已保存飞书附件 ${saved.length} 个`, {
      project: project.alias,
      files: saved.map((item) => item.path)
    });
    return saved;
  }

  attachmentTargetDir(project) {
    const base = this.store.userDataPath || process.cwd();
    const projectName = safePathSegment(project.alias || project.id || 'project', 'project');
    return path.join(base, 'feishu-attachments', dateFolderName(), projectName);
  }

  buildAttachmentPrompt(project, attachments, note = '', options = {}) {
    const inlineImageCount = Number(options.inlineImageCount || 0);
    const pathAttachments = inlineImageCount
      ? attachments.filter((attachment) => !isInlineCodexUiImageAttachment(attachment))
      : attachments;
    if (inlineImageCount && !pathAttachments.length) {
      return String(note || '').trim();
    }

    const lines = [
      inlineImageCount
        ? `我在飞书里发送了 ${inlineImageCount} 张图片，图片已经作为 Codex 聊天框附件插入。`
        : '我在飞书里发送了附件，请你基于这些本地文件继续处理。',
      '',
      `项目：${project.alias}`
    ];

    if (inlineImageCount) {
      lines.push('', '图片：已随本条消息一起粘贴到聊天框。');
    }

    if (pathAttachments.length) {
      lines.push(
        '',
        inlineImageCount ? '其他附件：' : '附件：',
        ...pathAttachments.map((attachment, index) => (
          `${index + 1}. ${attachmentTypeLabel(attachment.type)}：${attachment.fileName || attachment.fileKey}\n   路径：${attachment.path}\n   大小：${formatBytes(attachment.size)}`
        ))
      );
    }

    if (note) {
      lines.push('', '我的补充说明：', note);
    } else {
      lines.push(
        '',
        inlineImageCount
          ? '没有额外说明时，请先查看图片内容，并给出你建议的下一步。'
          : '没有额外说明时，请先检查附件内容，并给出你建议的下一步。'
      );
    }

    return lines.join('\n');
  }

  findResultFiles(project, finalText, options = {}) {
    const seen = new Set();
    const files = [];
    const skipped = [];
    const imageOnly = Boolean(options.imageOnly);
    const allowExternalImages = options.allowExternalImages !== false;
    const allowedRoots = [
      project.cwd,
      this.store.userDataPath || ''
    ].filter(Boolean);
    const inputAttachmentRoot = this.store.userDataPath
      ? path.join(this.store.userDataPath, 'feishu-attachments')
      : '';

    for (const candidate of collectPathCandidates(finalText)) {
      const filePath = resolveExistingFilePath(candidate.value);
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);

      if (!shouldUploadResultPath(filePath, candidate.context)) {
        continue;
      }

      const isImage = isResultImagePath(filePath);
      if (imageOnly && !isImage) {
        continue;
      }

      if (!allowedRoots.some((root) => isInsidePath(filePath, root)) && !(allowExternalImages && isImage)) {
        skipped.push({ path: filePath, reason: '不在项目目录内' });
        continue;
      }

      if (inputAttachmentRoot && isInsidePath(filePath, inputAttachmentRoot)) {
        skipped.push({ path: filePath, reason: '这是飞书输入附件，避免重复回传' });
        continue;
      }

      const stat = fs.statSync(filePath);
      if (stat.size <= 0) {
        skipped.push({ path: filePath, reason: '空文件' });
        continue;
      }

      if (stat.size > MAX_RESULT_UPLOAD_BYTES) {
        skipped.push({ path: filePath, reason: `超过 ${formatBytes(MAX_RESULT_UPLOAD_BYTES)}` });
        continue;
      }

      if (files.length >= MAX_RESULT_UPLOAD_FILES) {
        skipped.push({ path: filePath, reason: `超过最多 ${MAX_RESULT_UPLOAD_FILES} 个文件的回传限制` });
        continue;
      }

      files.push({
        path: filePath,
        fileName: path.basename(filePath),
        size: stat.size
      });
    }

    return { files, skipped };
  }

  async uploadResultFilesFromFinalText(project, chatId, finalText, options = {}) {
    const canSendFile = typeof this.feishu.sendFile === 'function';
    const canSendImage = typeof this.feishu.sendImage === 'function';
    if (!canSendFile && !canSendImage) return null;

    const { files: foundFiles, skipped } = this.findResultFiles(project, finalText, options);
    const files = [];
    const dedupePrefix = options.dedupeKeyPrefix || `${project.id || project.alias || 'project'}:`;
    for (const file of foundFiles) {
      const uploadKey = `${dedupePrefix}${file.path}`;
      if (options.dedupe !== false && this.uploadedResultFileKeys.has(uploadKey)) continue;
      files.push({
        ...file,
        uploadKey
      });
    }
    if (!files.length && !skipped.length) return null;

    const uploaded = [];
    const failed = [];
    for (const file of files) {
      try {
        const isImage = isResultImagePath(file.path);
        if (isImage && canSendImage && file.size <= MAX_RESULT_IMAGE_BYTES) {
          try {
            const result = await this.sendResultImage(chatId, file.path, {
              replyToMessageId: options.replyToMessageId || '',
              replyInThread: true
            });
            uploaded.push({
              ...file,
              kind: 'image',
              messageId: result?.messageId || '',
              imageKey: result?.imageKey || ''
            });
            if (file.uploadKey) this.rememberUploadedResultFile(file.uploadKey);
          } catch (imageError) {
            if (!canSendFile) throw imageError;
            const result = await this.sendResultFile(chatId, file.path, {
              replyToMessageId: options.replyToMessageId || '',
              replyInThread: true
            });
            uploaded.push({
              ...file,
              kind: 'image-file',
              messageId: result?.messageId || '',
              fileKey: result?.fileKey || '',
              note: `图片消息发送失败，已按文件回传：${imageError.message}`
            });
            if (file.uploadKey) this.rememberUploadedResultFile(file.uploadKey);
          }
          continue;
        }

        if (!canSendFile) {
          throw new Error(isImage && file.size > MAX_RESULT_IMAGE_BYTES
            ? `图片超过飞书图片消息 ${formatBytes(MAX_RESULT_IMAGE_BYTES)} 限制，且没有文件回传能力`
            : '当前飞书服务不支持文件回传');
        }

        const result = await this.sendResultFile(chatId, file.path, {
          replyToMessageId: options.replyToMessageId || '',
          replyInThread: true
        });
        uploaded.push({
          ...file,
          kind: isImage ? 'image-file' : 'file',
          messageId: result?.messageId || '',
          fileKey: result?.fileKey || '',
          note: isImage && file.size > MAX_RESULT_IMAGE_BYTES ? '图片超过飞书图片消息限制，已按文件回传' : ''
        });
        if (file.uploadKey) this.rememberUploadedResultFile(file.uploadKey);
      } catch (error) {
        failed.push({
          ...file,
          kind: isResultImagePath(file.path) ? 'image' : 'file',
          error: error.message
        });
      }
    }

    if (uploaded.length) {
      const imageCount = uploaded.filter((item) => item.kind === 'image').length;
      const fileCount = uploaded.length - imageCount;
      this.store.addEvent('system', `已回传 Codex 结果：图片 ${imageCount} 张，文件 ${fileCount} 个`, {
        project: project.alias,
        files: uploaded.map((item) => item.path)
      });
    }
    if (failed.length) {
      this.store.addEvent('error', `Codex 结果文件回传失败 ${failed.length} 个`, {
        project: project.alias,
        files: failed
      });
    }

    const lines = [];
    if (uploaded.length) {
      const images = uploaded.filter((file) => file.kind === 'image');
      const files = uploaded.filter((file) => file.kind !== 'image');
      if (images.length) {
        lines.push('已回传结果图片：');
        lines.push(...images.map((file) => `- ${escapeMarkdown(file.fileName)} (${formatBytes(file.size)})`));
      }
      if (files.length) {
        lines.push('已回传结果文件：');
        lines.push(...files.map((file) => `- ${escapeMarkdown(file.fileName)} (${formatBytes(file.size)})${file.note ? `：${escapeMarkdown(file.note)}` : ''}`));
      }
    }
    if (failed.length) {
      lines.push('回传失败：');
      lines.push(...failed.map((file) => `- ${escapeMarkdown(file.fileName)}：${escapeMarkdown(file.error)}`));
    }
    if (skipped.length) {
      lines.push('未回传：');
      lines.push(...skipped.slice(0, 5).map((file) => `- ${escapeMarkdown(path.basename(file.path))}：${escapeMarkdown(file.reason)}`));
    }

    return {
      uploaded,
      failed,
      skipped,
      summary: lines.join('\n')
    };
  }

  async sendResultImage(chatId, filePath, options = {}) {
    try {
      return await this.feishu.sendImage(chatId, filePath, options);
    } catch (error) {
      if (!options.replyToMessageId) throw error;
      this.store.addEvent('error', `飞书图片回复失败，改为普通图片消息：${error.message}`, { chatId });
      return this.feishu.sendImage(chatId, filePath, {
        ...options,
        replyToMessageId: '',
        replyInThread: false
      });
    }
  }

  async sendResultFile(chatId, filePath, options = {}) {
    try {
      return await this.feishu.sendFile(chatId, filePath, options);
    } catch (error) {
      if (!options.replyToMessageId) throw error;
      this.store.addEvent('error', `飞书文件回复失败，改为普通文件消息：${error.message}`, { chatId });
      return this.feishu.sendFile(chatId, filePath, {
        ...options,
        replyToMessageId: '',
        replyInThread: false
      });
    }
  }

  rememberUploadedResultFile(uploadKey) {
    if (!uploadKey) return;
    this.uploadedResultFileKeys.add(uploadKey);
    if (this.uploadedResultFileKeys.size <= 500) return;
    const [oldest] = this.uploadedResultFileKeys;
    this.uploadedResultFileKeys.delete(oldest);
  }

  async attachResultFilesToTaskCard(project, chatId, task, finalText, patch = {}) {
    const result = await this.uploadResultFilesFromFinalText(project, chatId, finalText, {
      replyToMessageId: task?.messageId || '',
      allowExternalImages: true
    });
    if (!result?.summary) return;

    await this.upsertTaskCard(project, chatId, {
      status: patch.status,
      threadId: patch.threadId,
      turnId: patch.turnId,
      summary: result.summary
    });
  }

  finalResultMarkdown(project, finalText, patch = {}) {
    const status = patch.status || 'completed';
    const lines = [
      `**状态**：${status === 'failed' ? '失败' : '已完成'}`,
      `**项目**：${escapeMarkdown(project.alias)}`,
      patch.threadId ? `**线程**：${escapeMarkdown(patch.threadId)}` : '',
      patch.turnId ? `**Turn**：${escapeMarkdown(patch.turnId)}` : '',
      '',
      '**回复**：',
      truncate(finalText || patch.error || '任务已结束。', 4200)
    ].filter(Boolean);

    return lines.join('\n');
  }

  async sendFinalResultCard(project, chatId, finalText, patch = {}) {
    const status = patch.status || 'completed';
    const title = status === 'failed' ? `Codex 失败：${project.alias}` : `Codex 回复：${project.alias}`;
    const markdown = this.finalResultMarkdown(project, finalText, patch);
    const template = status === 'failed' ? 'red' : 'carmine';
    const actions = [];

    if (patch.threadId || project.threadId) {
      actions.push({
        text: '打开线程',
        action: 'open_thread',
        value: {
          projectId: project.id,
          threadId: patch.threadId || project.threadId
        }
      });
    }

    if (typeof this.feishu.sendCard === 'function') {
      try {
        const result = await this.feishu.sendCard(chatId, title, markdown, template, { actions });
        return {
          messageId: result?.messageId || '',
          title,
          markdown
        };
      } catch (error) {
        this.store.addEvent('error', `飞书最终结果卡发送失败，将降级为文本：${error.message}`, { chatId });
      }
    }

    await this.safeSendText(chatId, `${title}\n\n${stripMarkdownForText(markdown)}`);
    return {
      messageId: '',
      title,
      markdown
    };
  }

  createQueueEntry(prompt, chatId, options = {}) {
    return {
      id: crypto.randomUUID(),
      prompt: normalizeMessageText(prompt),
      chatId,
      sourceMessageId: options.sourceMessageId || '',
      senderId: options.senderId || '',
      attachments: Array.isArray(options.attachments) ? options.attachments : [],
      createdAt: new Date().toISOString()
    };
  }

  queueSummary(queue, prefix = '已加入项目队列。') {
    const lines = [
      prefix,
      `队列剩余：${queue.length} 条`
    ];

    if (queue[0]?.prompt) {
      lines.push('', `队首：\n${truncate(queue[0].prompt, 500)}`);
    }

    return lines.join('\n');
  }

  async enqueuePrompt(project, prompt, chatId, options = {}) {
    const latest = this.store.getProject(project.id) || project;
    const entry = this.createQueueEntry(prompt, chatId, options);
    const queue = [...taskQueue(latest), entry];
    this.store.updateProject(latest.id, {
      taskQueue: queue,
      lastSummary: this.queueSummary(queue)
    });

    await this.upsertTaskCard(this.store.getProject(latest.id) || latest, chatId, {
      status: latest.taskCard?.status || latest.status || 'running',
      threadId: latest.threadId || latest.taskCard?.threadId || '',
      turnId: latest.activeTurnId || latest.taskCard?.turnId || '',
      summary: this.queueSummary(queue, `新消息已入队，排在第 ${queue.length} 位。`),
      result: '',
      error: ''
    });

    return entry;
  }

  async clearProjectQueue(chatId, project) {
    const latest = this.store.getProject(project.id) || project;
    const count = taskQueue(latest).length;
    if (!count) {
      await this.safeSendText(chatId, '当前项目队列是空的。');
      return;
    }

    this.store.updateProject(latest.id, {
      taskQueue: [],
      lastSummary: `已清空队列：${count} 条`
    });
    await this.upsertTaskCard(this.store.getProject(latest.id) || latest, chatId, {
      status: latest.taskCard?.status || latest.status || 'running',
      threadId: latest.threadId || latest.taskCard?.threadId || '',
      turnId: latest.activeTurnId || latest.taskCard?.turnId || '',
      summary: `已清空队列：${count} 条`,
      result: '',
      error: ''
    });
  }

  async appendNextQueuedTaskToCurrent(chatId, project) {
    const latest = this.store.getProject(project.id) || project;
    const queue = taskQueue(latest);
    if (!queue.length) {
      await this.safeSendText(chatId, '当前项目队列是空的。');
      return;
    }
    if (!latest.activeTurnId) {
      await this.safeSendText(chatId, '当前没有正在运行的 Codex turn，不能追加队首。');
      return;
    }

    const [entry, ...rest] = queue;
    this.store.updateProject(latest.id, { taskQueue: rest });
    try {
      await this.sendPromptToProject(latest.id, entry.prompt, entry.chatId || chatId, {
        sourceMessageId: entry.sourceMessageId,
        appendToActive: true,
        queueIfBusy: false,
        attachments: entry.attachments || []
      });
    } catch (error) {
      this.store.updateProject(latest.id, { taskQueue: [entry, ...rest] });
      throw error;
    }
  }

  async runNextQueuedTaskFromCard(chatId, project) {
    const latest = this.store.getProject(project.id) || project;
    if (projectIsBusy(latest)) {
      await this.safeSendText(chatId, '当前项目还在处理中，队首会在当前任务结束后自动运行。');
      return;
    }

    const started = await this.drainProjectQueue(latest.id, chatId);
    if (!started) {
      await this.safeSendText(chatId, '当前项目队列是空的。');
    }
  }

  async drainProjectQueue(projectId, chatIdOverride = '') {
    const latest = this.store.getProject(projectId);
    if (!latest || projectIsBusy(latest)) return false;

    const queue = taskQueue(latest);
    if (!queue.length) return false;

    const [entry, ...rest] = queue;
    this.store.updateProject(latest.id, {
      taskQueue: rest,
      lastSummary: this.queueSummary(rest, '开始处理队首任务。')
    });

    try {
      await this.sendPromptToProject(latest.id, entry.prompt, entry.chatId || chatIdOverride || latest.chatId, {
        sourceMessageId: entry.sourceMessageId,
        queueIfBusy: false,
        fromQueue: true,
        attachments: entry.attachments || []
      });
      return true;
    } catch (error) {
      this.store.updateProject(latest.id, {
        taskQueue: [entry, ...rest],
        status: 'failed',
        lastError: error.message,
        lastSummary: `队列任务启动失败：${error.message}`
      });
      await this.safeSendText(entry.chatId || chatIdOverride || latest.chatId, `队列任务启动失败：${error.message}`);
      return false;
    }
  }

  async handleCardAction(action) {
    const allowed = parseAllowedSenderIds(this.store.state.settings.allowedSenderIds);
    if (allowed.length && !allowed.includes(action.operatorId)) {
      await this.safeSendText(action.chatId, '你不在允许控制 Codex 的用户列表里。');
      return;
    }

    const value = normalizeActionValue(action.actionValue);
    if (value.bridge !== 'codex-feishu-bridge') return;

    if (value.action === 'panel_refresh') {
      await this.sendPanelCard(action.chatId, action.messageId);
      return;
    }

    if (value.action === 'panel_select_project') {
      await this.selectProjectFromPanel(action.chatId, action.messageId, action.actionOption || value.projectId || '');
      return;
    }

    if (value.action === 'panel_status') {
      await this.sendActiveProjectStatus(action.chatId);
      return;
    }

    if (value.action === 'panel_diag') {
      await this.sendDiagnosticCard(action.chatId);
      return;
    }

    const project = this.findProjectForCardAction(value.projectId, action.messageId);
    if (!project) {
      await this.safeSendText(action.chatId, '没有找到这张任务卡对应的项目。可以发送 /list 查看当前项目。');
      return;
    }

    switch (value.action) {
      case 'task_status':
        await this.refreshTaskCard(action.chatId, project);
        return;
      case 'task_retry':
        await this.retryTaskFromCard(action.chatId, project, action.messageId);
        return;
      case 'queue_clear':
        await this.clearProjectQueue(action.chatId, project);
        return;
      case 'queue_append_next':
        await this.appendNextQueuedTaskToCurrent(action.chatId, project);
        return;
      case 'queue_run_next':
        await this.runNextQueuedTaskFromCard(action.chatId, project);
        return;
      case 'open_thread':
        await this.openThreadFromCard(action.chatId, project, value.threadId || project.threadId || '');
        return;
      case 'codex_choice_reply':
        await this.replyToCodexChoice(action.chatId, project, value.choiceValue || '', action.messageId);
        return;
      default:
        await this.safeSendText(action.chatId, `暂不支持这个卡片操作：${value.action || 'unknown'}`);
    }
  }

  findProjectForCardAction(projectId, messageId) {
    if (projectId) {
      const project = this.store.getProject(projectId);
      if (project) return project;
    }

    return this.store.state.projects.find((project) => project.taskCard?.messageId === messageId) || null;
  }

  async refreshTaskCard(chatId, project) {
    const latest = this.store.getProject(project.id) || project;
    if (latest.taskCard?.messageId) {
      await this.upsertTaskCard(latest, chatId, {
        status: latest.taskCard.status || latest.status || 'running',
        threadId: latest.taskCard.threadId || latest.threadId || '',
        turnId: latest.activeTurnId || latest.taskCard.turnId || '',
        summary: latest.taskCard.summary || latest.lastSummary || '状态已刷新。',
        result: latest.taskCard.result || '',
        error: latest.lastError || latest.taskCard.error || ''
      });
      await this.sendCodexThreadScreenshot(chatId, latest);
      return;
    }

    await this.sendStatusCard(chatId, latest);
    await this.sendCodexThreadScreenshot(chatId, latest);
  }

  async replyToCodexChoice(chatId, project, choiceValue, sourceMessageId = '') {
    const reply = normalizeMessageText(choiceValue);
    if (!reply) {
      await this.safeSendText(chatId, '这个选项内容为空，不能发送给 Codex。');
      return;
    }

    const latest = this.store.getProject(project.id) || project;
    await this.sendPromptToProject(latest.id, reply, chatId, {
      appendToActive: Boolean(latest.activeTurnId),
      queueIfBusy: false,
      sourceMessageId: sourceMessageId || latest.taskCard?.sourceMessageId || ''
    });
  }

  async sendCodexThreadScreenshot(chatId, project) {
    const threadId = project.taskCard?.threadId || project.threadId || '';
    if (!threadId) {
      await this.safeSendText(chatId, '这张任务卡没有绑定 Codex 线程，暂时不能截图。');
      return;
    }
    if (!this.desktopInput || typeof this.desktopInput.captureCodexThread !== 'function') {
      await this.safeSendText(chatId, '当前版本没有初始化 Codex 窗口截图能力。');
      return;
    }
    if (typeof this.openCodexThread !== 'function') {
      await this.safeSendText(chatId, '缺少打开 Codex 线程的能力，暂时不能截图。');
      return;
    }

    const projectName = safePathSegment(project.alias || project.id || 'project', 'project');
    const outputDir = path.join(
      this.store.userDataPath || process.cwd(),
      'codex-screenshots',
      dateFolderName(),
      projectName
    );

    try {
      const screenshot = await this.desktopInput.captureCodexThread({
        threadId,
        openCodexThread: this.openCodexThread,
        outputDir
      });

      if (typeof this.feishu.sendImage === 'function') {
        await this.feishu.sendImage(chatId, screenshot.filePath);
      } else {
        await this.feishu.sendFile(chatId, screenshot.filePath, {
          fileName: path.basename(screenshot.filePath)
        });
      }

      this.store.addEvent('system', `已发送 Codex 线程截图：${path.basename(screenshot.filePath)}`, {
        project: project.alias,
        threadId,
        size: screenshot.size
      });
    } catch (error) {
      this.store.addEvent('error', `Codex 线程截图发送失败：${error.message}`, {
        project: project.alias,
        threadId
      });
      await this.safeSendText(chatId, [
        '状态已刷新，但 Codex 窗口截图发送失败。',
        error.message
      ].join('\n'));
    }
  }

  async retryTaskFromCard(chatId, project, sourceMessageId) {
    const latest = this.store.getProject(project.id) || project;
    const prompt = latest.taskCard?.prompt || '';
    if (!prompt) {
      await this.safeSendText(chatId, '这张任务卡没有保存可重新发送的任务内容。');
      return;
    }
    if (projectIsBusy(latest)) {
      await this.safeSendText(chatId, '当前项目还有任务在处理中，暂时不能重新发送。');
      return;
    }

    await this.sendPromptToProject(latest.id, prompt, chatId, {
      sourceMessageId
    });
  }

  async openThreadFromCard(chatId, project, threadId) {
    const latest = this.store.getProject(project.id) || project;
    if (!threadId) {
      await this.safeSendText(chatId, '这张任务卡没有绑定 Codex 线程。');
      return;
    }

    await this.focusCodexThread({ ...latest, threadId }, chatId);
    await this.safeSendText(chatId, `已尝试在本机打开 Codex 线程：${threadId}`);
  }

  async selectProjectFromPanel(chatId, panelMessageId, projectId) {
    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) {
      await this.safeSendText(chatId, '没有选中项目。');
      return;
    }

    const project = this.store.getProject(normalizedProjectId);
    if (!project) {
      await this.safeSendText(chatId, '选择的项目不存在，可能已经被删除。');
      await this.sendPanelCard(chatId, panelMessageId);
      return;
    }

    this.store.setActiveProject(chatId, project.id);
    if (!project.chatId) {
      this.store.updateProject(project.id, { chatId });
    }
    if (project.threadId) {
      this.watchCodexUiThread(project.threadId);
    }

    await this.sendPanelCard(chatId, panelMessageId);
  }

  async sendActiveProjectStatus(chatId) {
    const project = this.store.getActiveProject(chatId);
    if (!project) {
      await this.safeSendText(chatId, '当前飞书会话还没有选中项目。可以发送 /panel 选择项目。');
      return;
    }

    await this.sendStatusCard(chatId, project);
  }

  async handleCommand(message, text) {
    const [command, ...parts] = text.split(/\s+/);
    const chatId = message.chatId;

    switch (command.toLowerCase()) {
      case '/help':
      case '/start':
        await this.safeSendText(chatId, this.helpText());
        return;
      case '/panel':
      case '/control':
        await this.sendPanelCard(chatId);
        return;
      case '/list':
        await this.sendProjectList(chatId);
        return;
      case '/use':
        await this.useProject(chatId, parts[0]);
        return;
      case '/status':
        await this.sendProjectStatus(chatId, parts[0]);
        return;
      case '/watch':
      case '/看':
        await this.watchExistingTaskFromCommand(chatId, parts.join(' '));
        return;
      case '/diag':
        await this.sendDiagnosticCard(chatId, parts[0]);
        return;
      case '/queue':
        await this.sendQueueStatus(chatId, parts[0]);
        return;
      case '/clear-queue':
        await this.clearQueueFromCommand(chatId, parts[0]);
        return;
      case '/send-attachments':
        await this.sendPendingAttachmentsFromCommand(chatId, parts.join(' '));
        return;
      case '/cancel-attachments':
        await this.cancelPendingAttachmentsFromCommand(chatId);
        return;
      case '/where':
        await this.sendCurrentRoute(chatId);
        return;
      case '/bind-chat':
      case '/bind-group':
        await this.bindChat(chatId, parts[0], parts[1]);
        return;
      case '/unbind-chat':
      case '/unbind-group':
        await this.unbindChat(chatId, parts[0]);
        return;
      case '/add':
        await this.addProjectFromCommand(chatId, parts);
        return;
      case '/bind':
      case '/mirror':
        await this.bindThread(chatId, parts[0], parts[1]);
        return;
      case '/bind-thread':
        await this.bindChatToThreadId(chatId, parts[0]);
        return;
      case '/attach-latest':
        await this.attachLatestThread(chatId, parts[0], parts.slice(1).join(' '));
        return;
      case '/threads':
        await this.sendThreadList(chatId, parts.join(' '));
        return;
      case '/whoami':
        await this.safeSendText(chatId, `chat_id: ${chatId}\nsender_id: ${message.senderId || 'unknown'}`);
        return;
      case '/mode':
        await this.setDeliveryMode(chatId, parts[0]);
        return;
      default:
        await this.safeSendText(chatId, `未知命令：${command}\n\n${this.helpText()}`);
    }
  }

  helpText() {
    return [
      '传令书命令：',
      '/panel 打开飞书控制面板',
      '/list 查看项目',
      '/use 项目别名 切换当前项目',
      '/status [项目别名] 查看状态',
      '/watch [项目别名或线程ID] 接管电脑端已经开始的 Codex 任务',
      '/看 [项目别名或线程ID] 同 /watch',
      '/diag [项目别名] 查看诊断',
      '/queue [项目别名] 查看队列',
      '/clear-queue [项目别名] 清空队列',
      '/send-attachments 立即发送暂存附件',
      '/cancel-attachments 取消暂存附件',
      '/where 查看当前飞书会话绑定到哪个 Codex 线程',
      '/bind-chat 项目别名 [chat_id] 绑定当前群/指定群到项目',
      '/unbind-chat [chat_id] 解除当前群/指定群绑定',
      '/add 项目别名 /absolute/workspace/path 添加项目',
      '/bind 项目别名 thread_id 绑定已有 Codex 线程',
      '/bind-thread thread_id 用线程 ID 直接绑定当前群',
      '/mirror 项目别名 thread_id 同 /bind，用于镜像 Codex 界面线程',
      '/attach-latest 项目别名 [搜索词] 绑定该项目目录下最近的 Codex 线程',
      '/threads [搜索词] 查询本机 Codex 线程',
      '/whoami 显示 chat_id 和 sender_id',
      '/mode ui 使用 Codex 界面输入模式',
      '/mode appserver 使用 app-server 投递模式',
      '',
      '选中并绑定现有线程后，直接发送普通消息、图片或文件即可转发到同一个 Codex 线程。',
      '新群第一次可以直接发送 Codex 会话 ID，传令书会自动把这个群绑定到该线程。',
      '如果任务是在电脑 Codex 里手动开始的，离开前在群里发送 /watch 或 /看，可以补一张任务卡继续观察进度。',
      '单独发送图片或文件时，会先暂存；再发一条文字说明后，会和附件合并发送给 Codex。',
      'Codex 界面输入模式下，同群同线程的新消息会直接继续发送；app-server 模式下，同一项目忙碌时才会进入队列。',
      '群聊里如果没有开通“获取群组中所有消息”权限，请先 @ 机器人再发送命令或消息。'
    ].join('\n');
  }

  buildPanelCard(chatId) {
    const projects = this.store.state.projects || [];
    const active = this.store.getActiveProject(chatId);
    const activeThread = active?.threadId || '';
    const activeStatus = active?.status || 'idle';
    const activeQueue = taskQueue(active).length;
    const watcherStatus = this.store.state.runtime?.watcherStatus || {};
    const codexStatus = this.store.state.runtime?.codexStatus || 'stopped';
    const binding = this.store.state.activeByChat?.[chatId] || '';
    const markdown = [
      `**飞书会话**：${escapeMarkdown(chatId)}`,
      `**项目数量**：${projects.length}`,
      `**Codex 状态**：${codexStatus === 'not-required' ? '界面模式无需 app-server' : escapeMarkdown(codexStatus)}`,
      `**会话监听**：${watcherStatus.foundCount || 0}/${watcherStatus.watchedCount || 0} 个线程已找到日志`,
      `**当前项目**：${active ? escapeMarkdown(active.alias) : '未选择'}`,
      active ? `**项目状态**：${escapeMarkdown(activeStatus)}` : '',
      active ? `**项目队列**：${activeQueue} 条` : '',
      active ? `**目录**：${escapeMarkdown(active.cwd)}` : '',
      active ? `**线程**：${escapeMarkdown(activeThread || '未绑定')}` : '',
      binding ? `**绑定方式**：当前会话已绑定项目` : '',
      '',
      projects.length
        ? '在下拉菜单里选择项目后，这个飞书会话会切换到对应项目。'
        : '还没有项目。可以在 Mac App 里添加，或发送 `/add 项目别名 /absolute/path`。'
    ].filter(Boolean).join('\n');

    const extraElements = [];
    if (projects.length) {
      extraElements.push({
        tag: 'action',
        layout: 'flow',
        actions: [
          {
            tag: 'select_static',
            placeholder: cardPlainText('选择项目'),
            initial_option: active?.id || undefined,
            option: projects.slice(0, 50).map((project) => ({
              text: cardPlainText(project.alias),
              value: project.id
            })),
            value: bridgeActionValue('panel_select_project')
          }
        ]
      });
    }

    const actions = [
      {
        text: '刷新面板',
        action: 'panel_refresh',
        type: 'primary'
      },
      {
        text: '诊断',
        action: 'panel_diag'
      }
    ];

    if (active) {
      actions.push({
        text: '当前状态',
        action: 'panel_status',
        value: { projectId: active.id }
      });
    }

    if (activeThread) {
      actions.push({
        text: '打开线程',
        action: 'open_thread',
        value: { projectId: active.id, threadId: activeThread }
      });
    }

    return {
      title: 'Codex 控制面板',
      markdown,
      template: active?.status === 'running' ? 'blue' : 'green',
      options: {
        extraElements,
        actions
      }
    };
  }

  async sendPanelCard(chatId, messageId = '') {
    const panel = this.buildPanelCard(chatId);

    if (messageId && typeof this.feishu.updateCard === 'function') {
      try {
        await this.feishu.updateCard(messageId, panel.title, panel.markdown, panel.template, panel.options);
        return;
      } catch (error) {
        this.store.addEvent('error', `飞书控制面板更新失败，将新发面板：${error.message}`, {
          chatId,
          messageId
        });
      }
    }

    await this.safeSendMarkdownCard(chatId, panel.title, panel.markdown, panel.template, panel.options);
  }

  async sendProjectList(chatId) {
    const active = this.store.getActiveProject(chatId);
    if (!this.store.state.projects.length) {
      await this.safeSendText(chatId, '还没有项目。可以在 Mac App 里添加，或发送 /add 项目别名 /absolute/path。');
      return;
    }

    const lines = this.store.state.projects.map((project) => projectLine(project, active?.id === project.id));
    await this.safeSendText(chatId, `项目列表：\n${lines.join('\n')}`);
  }

  async useProject(chatId, alias) {
    if (!alias) {
      await this.safeSendText(chatId, '用法：/use 项目别名');
      return;
    }

    const project = this.store.getProject(alias);
    if (!project) {
      await this.safeSendText(chatId, `找不到项目：${alias}`);
      return;
    }

    this.store.setActiveProject(chatId, project.id);
    if (!project.chatId) {
      this.store.updateProject(project.id, { chatId });
    }
    await this.safeSendText(chatId, `已切换到项目：${project.alias}`);
  }

  async sendProjectStatus(chatId, alias) {
    const project = alias ? this.store.getProject(alias) : this.store.getActiveProject(chatId);
    if (!project) {
      await this.safeSendText(chatId, '没有找到项目。');
      return;
    }
    await this.sendStatusCard(chatId, project);
  }

  async watchExistingTaskFromCommand(chatId, target = '') {
    const project = await this.resolveWatchProject(chatId, target);
    if (!project) return;

    if (!project.threadId) {
      await this.safeSendText(chatId, [
        `项目 ${project.alias} 还没有绑定 Codex 线程。`,
        '请发送 `/threads` 查询线程后用 `/bind 项目别名 thread_id` 绑定，',
        '或直接发送 `/watch thread_id` / `/看 thread_id` 精确接管。'
      ].join('\n'));
      return;
    }

    this.store.setActiveProject(chatId, project.id);
    if (!project.chatId) {
      this.store.updateProject(project.id, { chatId });
    }

    const latestBefore = this.store.getProject(project.id) || project;
    const sinceMs = Date.now() - WATCH_REPLAY_WINDOW_MS;
    this.watchCodexUiThread(latestBefore.threadId, {
      fromEnd: false,
      sinceMs,
      forceReplay: true
    });

    const turnId = latestBefore.activeTurnId || latestBefore.taskCard?.turnId || '';
    this.addCodexUiPending(latestBefore.threadId, {
      requestId: `watch:${latestBefore.threadId}:${Date.now()}`,
      projectId: latestBefore.id,
      projectAlias: latestBefore.alias,
      threadId: latestBefore.threadId,
      chatId,
      prompt: latestBefore.taskCard?.prompt || '电脑端已开始的 Codex 任务',
      sourceMessageId: '',
      sentAt: sinceMs,
      turnId,
      userMessageSeen: true,
      watchOnly: true
    });

    this.store.updateProject(latestBefore.id, {
      status: 'running',
      activeTurnId: turnId,
      chatId: latestBefore.chatId || chatId,
      lastError: '',
      lastSummary: '已从飞书接管电脑端正在运行的 Codex 任务。'
    });
    const latest = this.store.getProject(latestBefore.id) || latestBefore;
    await this.upsertTaskCard(latest, chatId, {
      reset: ['completed', 'failed'].includes(latestBefore.taskCard?.status),
      status: 'running',
      threadId: latest.threadId,
      turnId,
      prompt: latestBefore.taskCard?.prompt || '电脑端已开始的 Codex 任务',
      summary: [
        '已接管电脑端 Codex 任务，后续进展会继续更新到这张卡片。',
        `正在回放最近 ${Math.round(WATCH_REPLAY_WINDOW_MS / 60000)} 分钟的会话日志，随后会持续监听新进展。`
      ].join('\n'),
      result: '',
      error: '',
      actionRequired: null
    });

    if (typeof this.sessionWatcher?.poll === 'function') {
      await this.sessionWatcher.poll().catch((error) => {
        this.store.addEvent('error', `接管后立即读取 Codex 日志失败：${error.message}`, {
          project: latest.alias,
          threadId: latest.threadId
        });
      });
    }
  }

  async resolveWatchProject(chatId, target = '') {
    const raw = normalizeMessageText(target);
    const threadId = parseBareCodexThreadId(raw) || parseLeadingCodexThreadId(raw);
    if (threadId) {
      return this.resolveWatchProjectByThread(chatId, threadId);
    }

    if (raw) {
      const project = this.store.getProject(raw);
      if (!project) {
        await this.safeSendText(chatId, `找不到项目或线程：${raw}\n用法：/watch [项目别名或线程ID]，中文命令也可以用 /看。`);
        return null;
      }
      return project;
    }

    const project = this.store.getActiveProject(chatId);
    if (!project) {
      await this.safeSendText(chatId, [
        '当前飞书会话还没有选中项目。',
        '可以先发送 `/list` 和 `/use 项目别名`，',
        '或者直接发送 `/watch thread_id` / `/看 thread_id`。'
      ].join('\n'));
      return null;
    }
    return project;
  }

  async resolveWatchProjectByThread(chatId, threadId) {
    let project = this.store.getProjectByThread(threadId);
    let info = null;
    let lookupError = null;

    if (!project) {
      try {
        info = await this.resolveCodexThreadInfo(threadId);
      } catch (error) {
        lookupError = error;
        this.store.addEvent('error', `接管任务查询 Codex 线程失败：${error.message}`, { threadId });
      }

      project = this.findProjectForThreadInfo(info);
      if (project) {
        this.store.updateProject(project.id, {
          threadId,
          chatId: project.chatId || chatId
        });
        project = this.store.getProject(project.id);
      }
    }

    if (!project && info?.cwd) {
      project = this.createProjectForThreadInfo(info, chatId);
    }

    if (!project && (this.store.state.projects || []).length === 1) {
      project = this.store.state.projects[0];
      this.store.updateProject(project.id, {
        threadId,
        chatId: project.chatId || chatId
      });
      project = this.store.getProject(project.id);
    }

    if (!project) {
      await this.safeSendText(chatId, [
        `还不能接管这个 Codex 线程：${threadId}`,
        lookupError ? `线程查询失败：${lookupError.message}` : '没有在已有项目里找到这个线程，也没有从本机 session 日志里拿到项目目录。',
        '',
        '可以先明确绑定：',
        '/list 查看项目别名',
        `/bind 项目别名 ${threadId}`,
        '',
        '绑定后再发送 `/watch` 或 `/看`。'
      ].join('\n'));
      return null;
    }

    this.store.setActiveProject(chatId, project.id);
    if (!project.chatId || project.threadId !== threadId) {
      this.store.updateProject(project.id, {
        threadId,
        chatId: project.chatId || chatId
      });
      project = this.store.getProject(project.id);
    }
    return project;
  }

  async sendQueueStatus(chatId, alias) {
    const project = alias ? this.store.getProject(alias) : this.store.getActiveProject(chatId);
    if (!project) {
      await this.safeSendText(chatId, '没有找到项目。');
      return;
    }

    const queue = taskQueue(project);
    if (!queue.length) {
      await this.safeSendText(chatId, `项目 ${project.alias} 当前没有排队任务。`);
      return;
    }

    const lines = queue.slice(0, 10).map((entry, index) => (
      `${index + 1}. ${displayTime(entry.createdAt)} | ${truncate(entry.prompt, 240)}`
    ));
    await this.safeSendMarkdownCard(chatId, `Codex 队列：${project.alias}`, [
      `**项目**：${escapeMarkdown(project.alias)}`,
      `**队列数量**：${queue.length}`,
      '',
      lines.map(escapeMarkdown).join('\n')
    ].join('\n'), projectIsBusy(project) ? 'blue' : 'green');
  }

  async clearQueueFromCommand(chatId, alias) {
    const project = alias ? this.store.getProject(alias) : this.store.getActiveProject(chatId);
    if (!project) {
      await this.safeSendText(chatId, '没有找到项目。');
      return;
    }
    await this.clearProjectQueue(chatId, project);
  }

  async sendPendingAttachmentsFromCommand(chatId, note = '') {
    const project = this.store.getActiveProject(chatId);
    if (!project) {
      await this.safeSendText(chatId, '没有找到当前项目。');
      return;
    }

    const pending = this.takePendingAttachments(chatId, project.id);
    if (!pending) {
      await this.safeSendText(chatId, '当前没有暂存附件。');
      return;
    }

    await this.sendAttachmentPrompt(project, chatId, pending.attachments, normalizeMessageText(note), {
      sourceMessageId: pending.sourceMessageIds[0] || ''
    });
  }

  async cancelPendingAttachmentsFromCommand(chatId) {
    const project = this.store.getActiveProject(chatId);
    if (!project) {
      await this.safeSendText(chatId, '没有找到当前项目。');
      return;
    }

    const pending = this.clearPendingAttachments(chatId, project.id);
    if (!pending) {
      await this.safeSendText(chatId, '当前没有暂存附件。');
      return;
    }

    await this.safeSendText(chatId, `已取消暂存附件：${this.attachmentBatchLabel(pending.attachments)}。`);
  }

  async buildDiagnostics(chatId = '', alias = '') {
    const project = alias
      ? this.store.getProject(alias)
      : (chatId ? this.store.getActiveProject(chatId) : null);
    const watcher = typeof this.sessionWatcher?.getStatus === 'function'
      ? this.sessionWatcher.getStatus()
      : { running: false, threads: [] };
    const accessibility = this.desktopInput?.checkAccessibility
      ? await this.desktopInput.checkAccessibility().catch(() => false)
      : null;
    const runtime = this.store.state.runtime || {};
    const settings = this.store.state.settings || {};
    const attachmentRoot = this.store.userDataPath
      ? path.join(this.store.userDataPath, 'feishu-attachments')
      : '';

    return {
      chatId,
      deliveryMode: settings.deliveryMode || 'appServer',
      bridgeRunning: Boolean(runtime.bridgeRunning),
      feishuStatus: runtime.feishuStatus || 'stopped',
      codexStatus: runtime.codexStatus || 'stopped',
      accessibility,
      lastError: runtime.lastError || '',
      attachmentRoot,
      project: project ? {
        id: project.id,
        alias: project.alias,
        cwd: project.cwd,
        status: project.status || 'idle',
        threadId: project.threadId || '',
        queueLength: taskQueue(project).length,
        activeTurnId: project.activeTurnId || '',
        taskCardStatus: project.taskCard?.status || ''
      } : null,
      watcher
    };
  }

  diagnosticMarkdown(diag) {
    const projectThread = diag.project?.threadId || '';
    const watcherThreads = Array.isArray(diag.watcher?.threads) ? diag.watcher.threads : [];
    const matched = projectThread
      ? watcherThreads.find((item) => item.threadId === projectThread)
      : null;
    const threadLines = watcherThreads.slice(0, 8).map((item) => (
      `- ${item.threadId}: ${item.found ? '已找到日志' : '等待日志'}${item.lastReadAt ? `，上次读取 ${displayTime(item.lastReadAt)}` : ''}`
    ));

    return [
      `**桥接运行**：${diag.bridgeRunning ? '运行中' : '未启动'}`,
      `**飞书长连接**：${escapeMarkdown(diag.feishuStatus)}`,
      `**投递模式**：${escapeMarkdown(this.deliveryModeLabel())}`,
      `**Codex 状态**：${diag.codexStatus === 'not-required' ? '界面模式无需 app-server' : escapeMarkdown(diag.codexStatus)}`,
      `**辅助功能**：${diag.accessibility === null ? '未检查' : diag.accessibility ? '正常' : '未授权'}`,
      `**Session Watcher**：${diag.watcher?.running ? '运行中' : '未运行'}，${diag.watcher?.foundCount || 0}/${diag.watcher?.watchedCount || 0} 个线程已找到日志`,
      diag.watcher?.lastPollAt ? `**最近扫描**：${escapeMarkdown(displayTime(diag.watcher.lastPollAt))}` : '',
      '',
      diag.project ? [
        '**当前项目**：',
        `项目：${escapeMarkdown(diag.project.alias)}`,
        `状态：${escapeMarkdown(diag.project.status)}`,
        `队列：${diag.project.queueLength} 条`,
        `线程：${escapeMarkdown(projectThread || '未绑定')}`,
        `线程日志：${matched ? (matched.found ? '已找到' : '等待出现') : projectThread ? '未监听' : '无'}`
      ].join('\n') : '**当前项目**：未选择',
      '',
      `**附件目录**：${escapeMarkdown(diag.attachmentRoot || '未设置')}`,
      diag.lastError ? `**最近错误**：\n${escapeMarkdown(truncate(diag.lastError, 1200))}` : '**最近错误**：无',
      threadLines.length ? `\n**监听线程**：\n${threadLines.map(escapeMarkdown).join('\n')}` : ''
    ].filter(Boolean).join('\n');
  }

  async sendDiagnosticCard(chatId, alias = '') {
    const diag = await this.buildDiagnostics(chatId, alias);
    const template = diag.lastError || diag.accessibility === false ? 'red' : 'green';
    await this.safeSendMarkdownCard(chatId, 'Codex 界面模式诊断', this.diagnosticMarkdown(diag), template);
  }

  async sendCurrentRoute(chatId) {
    const project = this.store.getActiveProject(chatId);
    if (!project) {
      await this.safeSendText(chatId, '当前飞书会话还没有选中项目。先用 /list 和 /use 项目别名。');
      return;
    }

    await this.safeSendText(chatId, [
      `当前飞书会话：${chatId}`,
      `当前项目：${project.alias}`,
      `目录：${project.cwd}`,
      `Codex 线程：${project.threadId || '未绑定'}`,
      `状态：${project.status || 'idle'}`,
      `投递模式：${this.deliveryModeLabel()}`,
      '',
      project.threadId
        ? '普通消息会发送到这个 Codex 线程。'
        : '还没有绑定 Codex 界面线程。先发 /threads 查线程，再发 /bind 项目别名 thread_id。'
    ].join('\n'));
  }

  async addProjectFromCommand(chatId, parts) {
    const alias = parts[0];
    const cwd = parts.slice(1).join(' ');
    if (!alias || !cwd) {
      await this.safeSendText(chatId, '用法：/add 项目别名 /absolute/workspace/path');
      return;
    }

    const project = this.store.addProject({
      alias,
      cwd: path.resolve(cwd),
      chatId
    });
    this.store.setActiveProject(chatId, project.id);
    await this.safeSendText(chatId, `已添加并选中项目：${project.alias}`);
  }

  async bindChat(chatId, alias, targetChatId = '') {
    if (!alias) {
      await this.safeSendText(chatId, '用法：/bind-chat 项目别名 [chat_id]\n不填 chat_id 时绑定当前飞书群/会话。');
      return;
    }

    const project = this.store.getProject(alias);
    if (!project) {
      await this.safeSendText(chatId, `找不到项目：${alias}`);
      return;
    }

    const bindChatId = String(targetChatId || chatId || '').trim();
    if (!bindChatId) {
      await this.safeSendText(chatId, '没有可绑定的 chat_id。可以先发送 /whoami 查看当前 chat_id。');
      return;
    }

    this.store.setActiveProject(bindChatId, project.id);
    if (!project.chatId) {
      this.store.updateProject(project.id, { chatId: bindChatId });
    }
    if (project.threadId) {
      this.watchCodexUiThread(project.threadId);
    }

    await this.safeSendText(chatId, [
      `已绑定飞书会话到项目：${project.alias}`,
      `chat_id: ${bindChatId}`,
      `thread_id: ${project.threadId || '未绑定'}`
    ].join('\n'));
  }

  async unbindChat(chatId, targetChatId = '') {
    const bindChatId = String(targetChatId || chatId || '').trim();
    if (!bindChatId) {
      await this.safeSendText(chatId, '用法：/unbind-chat [chat_id]');
      return;
    }

    this.store.removeActiveProject(bindChatId);
    await this.safeSendText(chatId, `已解除飞书会话绑定：${bindChatId}`);
  }

  hasExplicitChatBinding(chatId) {
    if (!chatId) return false;
    const projectId = this.store.state.activeByChat?.[chatId] || '';
    if (projectId && this.store.getProject(projectId)) return true;
    return (this.store.state.projects || []).some((project) => project.chatId === chatId);
  }

  uniqueProjectAlias(base) {
    const cleanBase = safePathSegment(base, 'Codex线程')
      .replace(/\s+/g, '-')
      .slice(0, 40) || 'Codex线程';
    let alias = cleanBase;
    let index = 2;
    while (this.store.getProject(alias)) {
      alias = `${cleanBase}-${index}`;
      index += 1;
    }
    return alias;
  }

  threadCwd(thread) {
    return thread?.cwd
      || thread?.workingDirectory
      || thread?.workspace?.cwd
      || thread?.project?.cwd
      || thread?.metadata?.cwd
      || '';
  }

  async resolveCodexThreadInfo(threadId) {
    let thread = null;
    let listError = null;
    try {
      const result = await this.codex.listThreads({
        query: threadId,
        limit: 20
      });
      thread = threadArray(result).find((item) => threadIdFromThread(item) === threadId) || null;
    } catch (error) {
      listError = error;
    }

    const sessionInfo = await this.resolveCodexThreadInfoFromSession(threadId);
    if (!thread && !sessionInfo) {
      if (listError) throw listError;
      return null;
    }

    return {
      threadId,
      title: threadTitle(thread) || sessionInfo?.title || '',
      cwd: this.threadCwd(thread) || sessionInfo?.cwd || '',
      source: this.threadCwd(thread) ? 'codex-list' : sessionInfo?.source || 'codex-list',
      raw: thread || sessionInfo?.raw || null,
      sessionFile: sessionInfo?.filePath || ''
    };
  }

  async resolveCodexThreadInfoFromSession(threadId) {
    const filePath = this.findCodexSessionFile(threadId);
    if (!filePath) return null;

    const meta = await this.readCodexSessionMeta(filePath).catch((error) => ({
      error: error.message
    }));
    const payload = meta?.payload || {};
    const cwd = payload.cwd || '';
    const title = payload.thread_name || payload.threadName || payload.title || '';
    return {
      threadId,
      title,
      cwd,
      filePath,
      source: 'session-log',
      raw: meta
    };
  }

  findCodexSessionFile(threadId) {
    if (!threadId) return '';
    if (typeof this.sessionWatcher?.findSessionFile === 'function') {
      const filePath = this.sessionWatcher.findSessionFile(threadId);
      if (filePath) return filePath;
    }

    const sessionsRoot = path.join(process.env.HOME || '', '.codex', 'sessions');
    if (!sessionsRoot || !fs.existsSync(sessionsRoot)) return '';

    const candidates = [];
    const walk = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const itemPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(itemPath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.jsonl') || !entry.name.includes(threadId)) continue;
        try {
          candidates.push({
            filePath: itemPath,
            mtimeMs: fs.statSync(itemPath).mtimeMs
          });
        } catch {
          // Session files may move while Codex is writing; ignore stale entries.
        }
      }
    };

    walk(sessionsRoot);
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.filePath || '';
  }

  readCodexSessionMeta(filePath) {
    return new Promise((resolve, reject) => {
      if (!filePath) {
        resolve(null);
        return;
      }

      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity
      });
      let settled = false;
      let scanned = 0;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        rl.close();
        stream.destroy();
        resolve(value);
      };

      stream.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });

      rl.on('line', (line) => {
        scanned += 1;
        if (!line.trim()) return;
        try {
          const record = JSON.parse(line);
          if (record.type === 'session_meta') {
            finish(record);
            return;
          }
        } catch {
          // Keep scanning a small prefix for session metadata.
        }

        if (scanned >= 50) {
          finish(null);
        }
      });

      rl.on('close', () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      });
    });
  }

  findProjectForThreadInfo(info) {
    if (!info?.cwd) return null;
    const cwd = path.resolve(info.cwd);
    const projects = (this.store.state.projects || []).filter((project) => (
      project.cwd && path.resolve(project.cwd) === cwd
    ));
    return projects.find((project) => project.threadId === info.threadId)
      || projects.find((project) => !project.threadId)
      || null;
  }

  createProjectForThreadInfo(info, chatId) {
    if (!info?.cwd) return null;
    const alias = this.uniqueProjectAlias(info.title || path.basename(info.cwd) || `线程-${info.threadId.slice(0, 8)}`);
    return this.store.addProject({
      alias,
      cwd: path.resolve(info.cwd),
      threadId: info.threadId,
      chatId
    });
  }

  async bindChatToThreadId(chatId, value) {
    const threadId = parseBareCodexThreadId(value) || String(value || '').trim();
    if (!CODEX_THREAD_ID_RE.test(threadId)) {
      await this.safeSendText(chatId, '请发送有效的 Codex 会话 ID，例如：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
      return;
    }

    let project = this.store.getProjectByThread(threadId);
    let info = null;
    let lookupError = null;

    if (!project) {
      try {
        info = await this.resolveCodexThreadInfo(threadId);
      } catch (error) {
        lookupError = error;
        this.store.addEvent('error', `自动绑定查询 Codex 线程失败：${error.message}`, { threadId });
      }

      project = this.findProjectForThreadInfo(info);
      if (project) {
        this.store.updateProject(project.id, {
          threadId,
          chatId: project.chatId || chatId
        });
        project = this.store.getProject(project.id);
      }
    }

    if (!project && info?.cwd) {
      project = this.createProjectForThreadInfo(info, chatId);
    }

    if (!project && (this.store.state.projects || []).length === 1) {
      project = this.store.state.projects[0];
      this.store.updateProject(project.id, {
        threadId,
        chatId: project.chatId || chatId
      });
      project = this.store.getProject(project.id);
    }

    if (!project) {
      await this.safeSendText(chatId, [
        `还不能只凭这个线程 ID 自动完成绑定：${threadId}`,
        lookupError ? `线程查询失败：${lookupError.message}` : '没有在已有项目里找到这个线程，也没有从 Codex 线程列表或本机 session 日志里拿到项目目录。',
        '',
        '可以用旧方式明确绑定：',
        '/list 查看项目别名',
        `/bind 项目别名 ${threadId}`
      ].join('\n'));
      return;
    }

    this.store.setActiveProject(chatId, project.id);
    if (!project.chatId) {
      this.store.updateProject(project.id, { chatId });
      project = this.store.getProject(project.id);
    }
    if (project.threadId !== threadId) {
      this.store.updateProject(project.id, { threadId });
      project = this.store.getProject(project.id);
    }
    this.watchCodexUiThread(threadId);

    await this.safeSendText(chatId, [
      `已自动绑定当前飞书群到 Codex 线程：${project.alias}`,
      `thread_id: ${threadId}`,
      `目录：${project.cwd}`,
      '',
      '之后这个群里的普通消息会直接发送到这个 Codex 线程。'
    ].join('\n'));
  }

  async bindThread(chatId, alias, threadId) {
    if (!alias || !threadId) {
      await this.safeSendText(chatId, '用法：/bind 项目别名 thread_id');
      return;
    }

    const project = this.store.getProject(alias);
    if (!project) {
      await this.safeSendText(chatId, `找不到项目：${alias}`);
      return;
    }

    this.store.updateProject(project.id, { threadId, chatId: project.chatId || chatId });
    this.watchCodexUiThread(threadId);
    this.store.setActiveProject(chatId, project.id);
    await this.safeSendText(chatId, `已镜像绑定 ${alias} -> ${threadId}\n之后普通消息会发送到这个 Codex 线程。`);
  }

  async attachLatestThread(chatId, alias, query) {
    if (!alias) {
      await this.safeSendText(chatId, '用法：/attach-latest 项目别名 [搜索词]');
      return;
    }

    const project = this.store.getProject(alias);
    if (!project) {
      await this.safeSendText(chatId, `找不到项目：${alias}`);
      return;
    }

    let result;
    try {
      result = await this.codex.listThreads({
        query: query || '',
        cwd: project.cwd,
        limit: 10
      });
    } catch (error) {
      await this.safeSendText(chatId, this.optionalCodexAppServerMessage(error));
      return;
    }
    const threads = threadArray(result);
    if (!threads.length) {
      await this.safeSendText(chatId, `没有查到 ${project.cwd} 下的 Codex 线程。可以先在 Codex App 打开该项目线程，或用 /threads 查看全部。`);
      return;
    }

    const thread = threads[0];
    const threadId = thread.id || thread.threadId || thread.sessionId;
    if (!threadId) {
      await this.safeSendText(chatId, '查到了线程，但没有可绑定的 thread_id。请用 /threads 查看原始列表。');
      return;
    }

    this.store.updateProject(project.id, { threadId, chatId: project.chatId || chatId });
    this.watchCodexUiThread(threadId);
    this.store.setActiveProject(chatId, project.id);
    await this.safeSendText(chatId, [
      `已绑定最近线程：${project.alias}`,
      `thread_id: ${threadId}`,
      `标题：${thread.name || thread.title || '未命名'}`,
      '',
      '之后普通消息会发送到这个 Codex 界面线程。'
    ].join('\n'));
  }

  async sendThreadList(chatId, query) {
    let result;
    try {
      result = await this.codex.listThreads({ query, limit: 10 });
    } catch (error) {
      await this.safeSendText(chatId, this.optionalCodexAppServerMessage(error));
      return;
    }
    const threads = threadArray(result);
    if (!Array.isArray(threads) || !threads.length) {
      await this.safeSendText(chatId, '没有查到 Codex 线程。');
      return;
    }

    const lines = threads.slice(0, 10).map((thread) => {
      const id = thread.id || thread.threadId || thread.sessionId || '';
      const title = thread.name || thread.title || '未命名';
      const cwd = thread.cwd || '';
      return `${id} | ${title}${cwd ? ` | ${cwd}` : ''}`;
    });
    await this.safeSendText(chatId, [
      '最近 Codex 线程：',
      lines.join('\n'),
      '',
      '绑定示例：/bind 飞书 thread_id',
      '或：/attach-latest 飞书'
    ].join('\n'));
  }

  async setDeliveryMode(chatId, mode) {
    const normalized = String(mode || '').toLowerCase();
    if (!['ui', 'codexui', 'desktop', 'appserver', 'app-server'].includes(normalized)) {
      await this.safeSendText(chatId, '用法：/mode ui 或 /mode appserver');
      return;
    }

    const deliveryMode = ['ui', 'codexui', 'desktop'].includes(normalized) ? 'codexUi' : 'appServer';
    this.store.updateSettings({ deliveryMode });
    await this.safeSendText(chatId, `已切换投递模式：${this.deliveryModeLabel()}`);
  }

  noResponseAlertMs() {
    const configured = Number(this.store.state.settings.noResponseAlertMs);
    if (configured === 0) return 0;
    if (!Number.isFinite(configured) || configured < 0) return DEFAULT_NO_RESPONSE_ALERT_MS;
    return Math.max(30000, configured);
  }

  noResponseWatchKey(threadId, requestId) {
    return `${threadId || 'unknown'}:${requestId || 'default'}`;
  }

  scheduleNoResponseWatch({ project, chatId, threadId, requestId, prompt, sourceMessageId = '', mode = '' }) {
    const alertMs = this.noResponseAlertMs();
    if (!alertMs || !project || !chatId || !threadId) return;

    const key = this.noResponseWatchKey(threadId, requestId);
    this.cancelNoResponseWatch(key);

    const state = {
      key,
      projectId: project.id,
      projectAlias: project.alias,
      chatId,
      threadId,
      requestId: requestId || '',
      prompt: normalizeMessageText(prompt),
      sourceMessageId,
      mode,
      startedAt: Date.now(),
      alertMs
    };

    const timer = setTimeout(() => {
      this.fireNoResponseAlert(key).catch((error) => {
        this.store.addEvent('error', `Codex 无反应提醒发送失败：${error.message}`, { threadId, requestId });
      });
    }, alertMs);
    if (typeof timer.unref === 'function') timer.unref();

    state.timer = timer;
    this.noResponseWatches.set(key, state);
  }

  cancelNoResponseWatch(key) {
    const state = this.noResponseWatches.get(key);
    if (!state) return;
    clearTimeout(state.timer);
    this.noResponseWatches.delete(key);
  }

  cancelNoResponseWatchByRequest(threadId, requestId) {
    this.cancelNoResponseWatch(this.noResponseWatchKey(threadId, requestId));
  }

  markCodexReaction(threadId) {
    if (!threadId) return;
    for (const [key, state] of Array.from(this.noResponseWatches.entries())) {
      if (state.threadId === threadId) {
        this.cancelNoResponseWatch(key);
      }
    }
  }

  async fireNoResponseAlert(key) {
    const state = this.noResponseWatches.get(key);
    if (!state) return;

    clearTimeout(state.timer);
    this.noResponseWatches.delete(key);

    const duration = formatDurationMs(state.alertMs);
    const project = this.store.getProject(state.projectId);
    const alias = project?.alias || state.projectAlias || '未命名项目';
    const source = state.mode === 'codexUi' ? 'Codex 界面输入模式' : 'app-server 模式';
    const summary = [
      `已超过 ${duration} 没有检测到 Codex 的可见反应。`,
      '我还没有看到任务开始、处理中说明、命令执行或工具输出。',
      '可以点任务卡里的“刷新状态”查看截图，或到 Mac 上确认 Codex 窗口是否需要手动介入。'
    ].join('\n');

    this.store.addEvent('error', `Codex 超过 ${duration} 没有可见反应`, {
      project: alias,
      threadId: state.threadId,
      source
    });

    if (project) {
      await this.upsertTaskCard(project, state.chatId, {
        status: project.taskCard?.status || 'queued',
        threadId: state.threadId,
        prompt: project.taskCard?.prompt || state.prompt,
        summary,
        result: '',
        error: '',
        sourceMessageId: state.sourceMessageId || project.taskCard?.sourceMessageId || ''
      });
    }

    await this.safeSendText(state.chatId, [
      `Codex 已超过 ${duration} 没有可见反应。`,
      `项目：${alias}`,
      `线程：${state.threadId}`,
      `模式：${source}`,
      '',
      '我已经把任务发出，但还没有检测到任务开始、思考/处理进度、命令执行或工具输出。',
      '你可以点任务卡里的“刷新状态”看截图，或到 Mac 上确认 Codex 窗口是否卡住。'
    ].join('\n'));
  }

  async sendPromptToProject(projectId, prompt, chatIdOverride = '', options = {}) {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error('项目不存在');

    const chatId = chatIdOverride || project.chatId || this.store.state.settings.defaultChatId;
    if (!chatId) throw new Error('项目还没有绑定飞书 chat_id');

    const bypassBusyQueue = this.shouldBypassBusyQueue(project, options);
    if (bypassBusyQueue) {
      options = {
        ...options,
        queueIfBusy: false,
        followUpDuringBusy: true
      };
    }

    if (projectIsBusy(project) && !options.appendToActive && options.queueIfBusy !== false) {
      await this.enqueuePrompt(project, prompt, chatId, options);
      return;
    }

    let threadId = project.threadId;
    if (!threadId) {
      if (this.store.state.settings.deliveryMode === 'codexUi' || this.store.state.settings.mirrorExistingThread !== false) {
        await this.safeSendText(chatId, [
          `项目 ${project.alias} 还没有绑定 Codex 界面线程。`,
          '',
          this.store.state.settings.deliveryMode === 'codexUi'
            ? '当前是 Codex 界面输入模式，必须绑定一个真实 Codex App 线程。'
            : '为了让飞书内容和 Codex App 界面完全匹配，镜像模式不会自动新建隐藏线程。',
          '',
          '请先发送：',
          `/threads ${project.alias}`,
          '然后选择你要镜像的 thread_id：',
          `/bind ${project.alias} thread_id`,
          '',
          '也可以直接绑定该目录最近线程：',
          `/attach-latest ${project.alias}`
        ].join('\n'));
        return;
      }

      threadId = await this.codex.startThread({
        cwd: project.cwd,
        model: project.model || this.store.state.settings.model
      });
      this.store.updateProject(project.id, { threadId, status: 'idle' });
    } else {
      await this.focusCodexThread(project, chatId);
      if (this.store.state.settings.deliveryMode === 'codexUi') {
        await this.sendPromptViaCodexUi(project, prompt, chatId, options);
        return;
      }
      await this.codex.resumeThread({
        threadId,
        cwd: project.cwd,
        model: project.model || this.store.state.settings.model
      });
    }

    const updated = this.store.getProject(project.id);
    if (updated.activeTurnId) {
      if (!options.appendToActive) {
        if (options.queueIfBusy === false) {
          await this.enqueuePrompt(updated, prompt, chatId, options);
          return;
        }
        await this.enqueuePrompt(updated, prompt, chatId, options);
        return;
      }

      await this.codex.steerTurn({
        threadId,
        turnId: updated.activeTurnId,
        prompt
      });
      this.store.updateProject(project.id, {
        status: 'running',
        lastError: ''
      });
      await this.upsertTaskCard(project, chatId, {
        status: 'running',
        threadId,
        turnId: updated.activeTurnId,
        prompt: project.taskCard?.prompt || prompt,
        summary: `已收到追加指令：\n${truncate(prompt, 1000)}`,
        result: '',
        error: '',
        sourceMessageId: options.sourceMessageId || project.taskCard?.sourceMessageId || ''
      });
    } else {
      const requestId = crypto.randomUUID();
      this.pendingPromptByThread.set(threadId, {
        requestId,
        prompt,
        chatId,
        sourceMessageId: options.sourceMessageId || '',
        sentAt: Date.now()
      });
      this.store.updateProject(project.id, {
        status: 'queued',
        lastError: ''
      });
      await this.upsertTaskCard(project, chatId, {
        reset: true,
        status: 'queued',
        threadId,
        turnId: '',
        prompt,
        summary: options.fromQueue ? '已从队列发送给 Codex，等待开始处理。' : '已发送给 Codex，等待开始处理。',
        result: '',
        error: '',
        sourceMessageId: options.sourceMessageId || ''
      });
      this.scheduleNoResponseWatch({
        project,
        chatId,
        threadId,
        requestId,
        prompt,
        sourceMessageId: options.sourceMessageId || '',
        mode: 'appServer'
      });
      try {
        await this.codex.startTurn({
          threadId,
          prompt,
          cwd: project.cwd,
          model: project.model || this.store.state.settings.model
        });
      } catch (error) {
        this.cancelNoResponseWatchByRequest(threadId, requestId);
        throw error;
      }
    }
  }

  async sendPromptViaCodexUi(project, prompt, chatId, options = {}) {
    if (!this.desktopInput) {
      throw new Error('Codex 界面输入服务未初始化');
    }

    const inlineImages = Array.isArray(options.attachments)
      ? options.attachments.filter(isInlineCodexUiImageAttachment)
      : [];
    const pending = this.createCodexUiPending(project, prompt, chatId, options);
    const receivedSummary = options.followUpDuringBusy
      ? inlineImages.length
        ? `已收到补充消息和 ${inlineImages.length} 张图片，准备发送到当前 Codex 线程。`
        : '已收到补充消息，准备发送到当前 Codex 线程。'
      : options.fromQueue
        ? inlineImages.length
          ? `已从队列取出 ${inlineImages.length} 张图片，准备通过 Codex 界面发送。`
          : '已从队列取出，准备通过 Codex 界面发送。'
        : inlineImages.length
          ? `已收到任务和 ${inlineImages.length} 张图片，准备通过 Codex 界面发送。`
          : '已收到任务，准备通过 Codex 界面发送。';
    await this.upsertTaskCard(project, chatId, {
      reset: true,
      status: 'queued',
      threadId: project.threadId,
      prompt,
      summary: receivedSummary,
      result: '',
      error: '',
      sourceMessageId: options.sourceMessageId || ''
    });

    try {
      const inputPayload = {
        text: prompt,
        threadId: project.threadId,
        openCodexThread: this.openCodexThread,
        restoreClipboard: this.store.state.settings.restoreClipboardAfterPaste !== false,
        onStep: (step) => this.updateCodexUiDeliveryStep(project, chatId, pending, step)
      };
      if (inlineImages.length && typeof this.desktopInput.pasteRichIntoCodex === 'function') {
        await this.desktopInput.pasteRichIntoCodex({
          ...inputPayload,
          imagePaths: inlineImages.map((attachment) => attachment.path)
        });
      } else {
        await this.desktopInput.pasteIntoCodex(inputPayload);
      }
    } catch (error) {
      this.removeCodexUiPending(project.threadId, pending.requestId);
      throw error;
    }

    this.store.updateProject(project.id, {
      status: 'sent-to-codex-ui',
      lastSummary: `已通过 Codex 界面输入模式发送：${truncate(prompt, 600)}`
    });
    const sentSummary = options.followUpDuringBusy
      ? inlineImages.length
        ? '已把图片和补充消息粘贴到当前 Codex 线程，等待 Codex 回复。'
        : '已粘贴补充消息到当前 Codex 线程，等待 Codex 回复。'
      : options.fromQueue
        ? inlineImages.length
          ? '已从队列把图片和文字粘贴到 Codex 界面，等待 Codex 记录任务开始。'
          : '已从队列粘贴到 Codex 界面，等待 Codex 记录任务开始。'
        : inlineImages.length
          ? '已把图片和文字粘贴到 Codex 界面，等待 Codex 记录任务开始。'
          : '已粘贴到 Codex 界面，等待 Codex 记录任务开始。';
    await this.upsertTaskCard(project, chatId, {
      status: 'queued',
      threadId: project.threadId,
      prompt,
      summary: sentSummary,
      result: '',
      error: '',
      sourceMessageId: options.sourceMessageId || ''
    });
    this.scheduleNoResponseWatch({
      project,
      chatId,
      threadId: project.threadId,
      requestId: pending.requestId,
      prompt,
      sourceMessageId: options.sourceMessageId || '',
      mode: 'codexUi'
    });
  }

  async updateCodexUiDeliveryStep(project, chatId, pending, step) {
    const latest = this.store.getProject(project.id) || project;
    if (!this.hasCodexUiPending(pending.threadId, pending.requestId)) return;

    await this.upsertTaskCard(latest, chatId, {
      status: 'queued',
      threadId: pending.threadId,
      prompt: pending.prompt,
      summary: step?.message || '正在通过 Codex 界面发送。',
      result: '',
      error: '',
      sourceMessageId: pending.sourceMessageId || latest.taskCard?.sourceMessageId || ''
    });
  }

  createCodexUiPending(project, prompt, chatId, options = {}) {
    this.watchCodexUiThread(project.threadId);
    const pending = {
      requestId: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      projectId: project.id,
      projectAlias: project.alias,
      threadId: project.threadId,
      chatId,
      prompt: normalizeMessageText(prompt),
      sourceMessageId: options.sourceMessageId || '',
      attachments: Array.isArray(options.attachments) ? options.attachments : [],
      sentAt: Date.now(),
      turnId: '',
      userMessageSeen: false
    };
    this.addCodexUiPending(project.threadId, pending);
    return pending;
  }

  shouldBypassBusyQueue(project, options = {}) {
    if (!projectIsBusy(project)) return false;
    if (options.appendToActive || options.fromQueue || options.queueIfBusy === false) return false;
    if (this.store.state.settings.deliveryMode !== 'codexUi') return false;
    return Boolean(project.threadId);
  }

  getCodexUiPendingList(threadId) {
    const value = this.uiPendingByThread.get(threadId);
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  setCodexUiPendingList(threadId, list) {
    const pending = Array.isArray(list) ? list.filter(Boolean) : [];
    if (!pending.length) {
      this.uiPendingByThread.delete(threadId);
      return;
    }
    this.uiPendingByThread.set(threadId, pending);
  }

  addCodexUiPending(threadId, pending) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const list = this.getCodexUiPendingList(threadId)
      .filter((item) => Number(item.sentAt || 0) >= cutoff);
    list.push(pending);
    this.setCodexUiPendingList(threadId, list);
  }

  removeCodexUiPending(threadId, requestId) {
    const id = typeof requestId === 'object' ? requestId?.requestId : requestId;
    if (id) this.cancelNoResponseWatchByRequest(threadId, id);
    const list = this.getCodexUiPendingList(threadId)
      .filter((item) => item.requestId !== id);
    this.setCodexUiPendingList(threadId, list);
  }

  hasCodexUiPending(threadId, requestId) {
    return this.getCodexUiPendingList(threadId).some((item) => item.requestId === requestId);
  }

  codexUiPendingCandidates(event) {
    return this.getCodexUiPendingList(event.threadId)
      .filter((pending) => !event.timeMs || event.timeMs >= Number(pending.sentAt || 0) - 15000);
  }

  findCodexUiPendingForUserMessage(event, actual) {
    return this.codexUiPendingCandidates(event)
      .find((pending) => !pending.userMessageSeen && actual === pending.prompt) || null;
  }

  findCodexUiPendingForTaskStarted(event) {
    const candidates = this.codexUiPendingCandidates(event);
    return candidates.find((pending) => !pending.turnId && !pending.userMessageSeen)
      || candidates.find((pending) => !pending.turnId)
      || null;
  }

  findCodexUiPendingForCompletion(event) {
    const candidates = this.codexUiPendingCandidates(event).filter((pending) => pending.userMessageSeen);
    if (event.turnId) {
      const byTurn = candidates.find((pending) => pending.turnId === event.turnId);
      if (byTurn) return byTurn;
    }
    return candidates[0] || null;
  }

  shouldRecoverCodexUiEvent(project, event) {
    if (!project || !projectIsBusy(project)) return false;

    const task = project.taskCard || {};
    if (['completed', 'failed'].includes(task.status)) return false;

    const startedMs = Date.parse(task.startedAt || project.updatedAt || project.createdAt || '') || 0;
    if (startedMs && event.timeMs && event.timeMs < startedMs - 15000) return false;

    const knownTurnId = task.turnId || project.activeTurnId || '';
    if (knownTurnId && event.turnId && knownTurnId !== event.turnId) return false;

    return true;
  }

  recoveredCodexUiPending(project, event) {
    const task = project.taskCard || {};
    return {
      recovered: true,
      requestId: `recovery:${event.threadId}:${event.turnId || task.turnId || project.activeTurnId || 'latest'}`,
      projectId: project.id,
      projectAlias: project.alias,
      threadId: event.threadId,
      chatId: task.chatId || project.chatId || this.store.state.settings.defaultChatId || '',
      prompt: normalizeMessageText(task.prompt || ''),
      sourceMessageId: task.sourceMessageId || '',
      sentAt: Date.parse(task.startedAt || project.updatedAt || project.createdAt || '') || 0,
      turnId: event.turnId || task.turnId || project.activeTurnId || '',
      userMessageSeen: true
    };
  }

  watchCodexUiThread(threadId, options = {}) {
    if (!threadId || !this.sessionWatcher) return;
    const sinceMs = Number(options.sinceMs || 0);
    this.sessionWatcher.watchThread(threadId, {
      fromEnd: sinceMs ? false : options.fromEnd !== false,
      sinceMs,
      forceReplay: options.forceReplay === true
    });
    this.sessionWatcher.start();
  }

  async focusCodexThread(project, chatId = '') {
    if (this.store.state.settings.openCodexThreadOnMessage === false) return;
    if (!project.threadId || typeof this.openCodexThread !== 'function') return;

    try {
      await this.openCodexThread(project.threadId);
      this.store.addEvent('system', `已打开 Codex 线程：${project.threadId}`, { project: project.alias });
    } catch (error) {
      this.store.addEvent('error', `打开 Codex 线程失败：${error.message}`, { threadId: project.threadId });
      if (chatId) {
        await this.safeSendText(chatId, `已收到消息，但打开 Codex 界面线程失败：${error.message}`);
      }
    }
  }

  responseChatId(project, ...candidates) {
    return candidates
      .map((item) => String(item || '').trim())
      .find(Boolean)
      || String(project?.taskCard?.chatId || '').trim()
      || String(project?.chatId || '').trim()
      || String(this.store.state.settings.defaultChatId || '').trim();
  }

  async handleCodexNotification(message) {
    const { method, params = {} } = message;
    const threadId = params.threadId;
    if (!threadId) return;

    const project = this.store.getProjectByThread(threadId);
    if (!project) return;

    if (['turn/started', 'turn/plan/updated', 'item/started', 'item/completed', 'turn/completed'].includes(method)) {
      this.markCodexReaction(threadId);
    }

    if (method === 'turn/started') {
      const turnId = params.turn?.id || '';
      const pending = this.pendingPromptByThread.get(threadId) || {};
      const chatId = this.responseChatId(project, pending.chatId);
      if (!chatId) return;
      this.store.updateProject(project.id, {
        status: 'running',
        activeTurnId: turnId,
        lastError: ''
      });
      await this.upsertTaskCard(project, chatId, {
        reset: project.taskCard?.status === 'completed' || project.taskCard?.status === 'failed',
        status: 'running',
        threadId,
        turnId,
        prompt: pending.prompt || project.taskCard?.prompt || '',
        summary: 'Codex 已开始处理。',
        result: '',
        error: '',
        sourceMessageId: pending.sourceMessageId || project.taskCard?.sourceMessageId || ''
      });
      this.pendingPromptByThread.delete(threadId);
      return;
    }

    if (method === 'turn/plan/updated') {
      const chatId = this.responseChatId(project);
      if (!chatId) return;
      const plan = (params.plan || [])
        .map((item) => `${item.status || '-'} ${item.step || ''}`.trim())
        .filter(Boolean)
        .join('\n');
      if (plan) {
        this.store.updateProject(project.id, { lastSummary: truncate(plan, 1200) });
        await this.upsertTaskCard(project, chatId, {
          status: 'running',
          threadId,
          turnId: project.activeTurnId || project.taskCard?.turnId || '',
          summary: `当前计划：\n${plan}`
        });
      }
      return;
    }

    if (method === 'item/started' && params.item?.type === 'commandExecution') {
      const chatId = this.responseChatId(project);
      if (!chatId) return;
      await this.upsertTaskCard(project, chatId, {
        status: 'running',
        threadId,
        turnId: project.activeTurnId || project.taskCard?.turnId || '',
        summary: `正在执行命令：\n${params.item.command}`
      });
      return;
    }

    if (method === 'item/completed' && params.item?.type === 'commandExecution') {
      const chatId = this.responseChatId(project);
      if (!chatId) return;
      const item = params.item;
      if (item.exitCode && item.exitCode !== 0) {
        await this.upsertTaskCard(project, chatId, {
          status: 'running',
          threadId,
          turnId: project.activeTurnId || project.taskCard?.turnId || '',
          summary: `命令返回非零退出码：exit ${item.exitCode}\n${truncate(item.aggregatedOutput, 1200)}`
        });
      }
      return;
    }

    if (method === 'turn/completed') {
      const chatId = this.responseChatId(project);
      if (!chatId) return;
      const status = params.turn?.status || 'completed';
      const error = params.turn?.error ? JSON.stringify(params.turn.error) : '';
      this.store.updateProject(project.id, {
        status,
        activeTurnId: '',
        lastError: error,
        lastSummary: truncate(params.finalText || this.store.getProject(project.id)?.lastSummary || '', 1600)
      });
      const finalText = params.finalText || (error ? `任务结束但有错误：${error}` : '任务已结束。');
      const taskPatch = {
        status: error || status === 'failed' ? 'failed' : 'completed',
        threadId,
        turnId: params.turn?.id || project.taskCard?.turnId || '',
        summary: '',
        result: finalText,
        error,
        actionRequired: null
      };
      const task = await this.upsertTaskCard(project, chatId, taskPatch);
      const resultCard = await this.sendFinalResultCard(project, chatId, finalText, taskPatch);
      if (!error && taskPatch.status === 'completed') {
        await this.attachResultFilesToTaskCard(project, chatId, resultCard?.messageId ? resultCard : task, finalText, taskPatch);
      }
      await this.drainProjectQueue(project.id, chatId);
    }
  }

  async handleAgentDelta(delta) {
    const project = this.store.getProjectByThread(delta.threadId);
    if (!project) return;
    this.markCodexReaction(delta.threadId);

    const interval = Number(this.store.state.settings.summaryIntervalMs || 20000);
    const key = `${delta.threadId}:${delta.turnId}`;
    const now = Date.now();
    const lastAt = this.lastProgressSentAt.get(key) || 0;
    const lastText = this.lastProgressText.get(key) || '';
    const text = truncate(delta.text, 1600);

    this.store.updateProject(project.id, {
      status: 'running',
      lastSummary: text
    });

    if (now - lastAt < interval || text === lastText || text.length < 80) return;

    const chatId = this.responseChatId(project);
    if (!chatId) return;

    this.lastProgressSentAt.set(key, now);
    this.lastProgressText.set(key, text);
    await this.upsertTaskCard(project, chatId, {
      status: 'running',
      threadId: delta.threadId,
      turnId: delta.turnId,
      summary: text
    });
  }

  async handleCodexUiUserMessage(event) {
    const actual = normalizeMessageText(event.text);
    const pending = this.findCodexUiPendingForUserMessage(event, actual);
    if (!pending) return;

    if (actual !== pending.prompt) return;

    pending.turnId = event.turnId || pending.turnId;
    pending.userMessageSeen = true;

    const project = this.store.getProject(pending.projectId);
    if (!project) return;

    this.store.updateProject(project.id, {
      status: 'running',
      activeTurnId: pending.turnId || project.activeTurnId || '',
      lastError: ''
    });
    await this.upsertTaskCard(project, this.responseChatId(project, pending.chatId), {
      status: 'running',
      threadId: event.threadId,
      turnId: pending.turnId || project.activeTurnId || '',
      prompt: pending.prompt,
      summary: '已监听到 Codex 用户消息，等待最终回复。',
      result: '',
      error: '',
      actionRequired: null,
      sourceMessageId: pending.sourceMessageId || project.taskCard?.sourceMessageId || ''
    });
  }

  async handleCodexUiTaskStarted(event) {
    this.markCodexReaction(event.threadId);
    let pending = this.findCodexUiPendingForTaskStarted(event);
    let project = pending
      ? this.store.getProject(pending.projectId)
      : this.store.getProjectByThread(event.threadId);
    if (!pending) {
      if (!this.shouldRecoverCodexUiEvent(project, event)) return;
      pending = this.recoveredCodexUiPending(project, event);
    }
    if (!project) return;

    pending.turnId = event.turnId || pending.turnId;
    project = this.store.getProject(project.id) || project;
    if (!project) return;

    this.store.updateProject(project.id, {
      status: 'running',
      activeTurnId: pending.turnId || project.activeTurnId || '',
      lastError: ''
    });
    await this.upsertTaskCard(project, this.responseChatId(project, pending.chatId), {
      status: 'running',
      threadId: event.threadId,
      turnId: pending.turnId || project.activeTurnId || '',
      prompt: pending.prompt,
      summary: pending.recovered ? '断线恢复：已重新监听到 Codex 任务开始。' : '已监听到 Codex 任务开始。',
      result: '',
      error: '',
      actionRequired: null,
      sourceMessageId: pending.sourceMessageId || project.taskCard?.sourceMessageId || ''
    });
  }

  async handleCodexUiProgress(event) {
    const project = this.store.getProjectByThread(event.threadId);
    if (!project) return;
    this.markCodexReaction(event.threadId);

    const pending = this.findCodexUiPendingForProgress(event);
    if (!pending && !projectIsBusy(project)) return;

    const chatId = this.responseChatId(project, pending?.chatId);
    if (!chatId) return;

    const interval = Number(this.store.state.settings.summaryIntervalMs || 20000);
    const key = `${event.threadId}:${event.turnId || pending?.requestId || 'ui-progress'}`;
    const now = Date.now();
    const lastAt = this.lastProgressSentAt.get(key) || 0;
    const text = truncate(this.codexUiProgressText(event), 1600);
    const lastText = this.lastProgressText.get(key) || '';

    this.store.updateProject(project.id, {
      status: 'running',
      activeTurnId: event.turnId || pending?.turnId || project.activeTurnId || '',
      lastError: '',
      lastSummary: text
    });

    await this.uploadResultImagesFromProgress(this.store.getProject(project.id) || project, chatId, event.text || text, event);

    if (!text || text === lastText || (lastAt && now - lastAt < interval)) return;

    this.lastProgressSentAt.set(key, now);
    this.lastProgressText.set(key, text);
    await this.upsertTaskCard(this.store.getProject(project.id) || project, chatId, {
      status: 'running',
      threadId: event.threadId,
      turnId: event.turnId || pending?.turnId || project.activeTurnId || '',
      prompt: pending?.prompt || project.taskCard?.prompt || '',
      summary: text,
      result: '',
      error: '',
      actionRequired: null,
      sourceMessageId: pending?.sourceMessageId || project.taskCard?.sourceMessageId || ''
    });
  }

  async uploadResultImagesFromProgress(project, chatId, text, event = {}) {
    if (!project || !chatId || !text) return;
    try {
      await this.uploadResultFilesFromFinalText(project, chatId, text, {
        replyToMessageId: project.taskCard?.messageId || '',
        imageOnly: true,
        allowExternalImages: true,
        dedupeKeyPrefix: `${project.id || project.alias || event.threadId || 'project'}:`
      });
    } catch (error) {
      this.store.addEvent('error', `Codex 结果图片回传失败：${error.message}`, {
        project: project.alias,
        threadId: event.threadId || project.threadId || ''
      });
    }
  }

  findCodexUiPendingForProgress(event) {
    const candidates = this.codexUiPendingCandidates(event);
    if (event.turnId) {
      const byTurn = candidates.find((pending) => pending.turnId === event.turnId);
      if (byTurn) return byTurn;
    }
    return candidates.find((pending) => pending.userMessageSeen)
      || candidates[0]
      || null;
  }

  codexUiProgressText(event) {
    const label = event.kind === 'tool' ? '工具进展' : '处理中';
    const time = displayTime(event.timestamp || Date.now());
    return [
      `${label}${time ? `（${time}）` : ''}：`,
      event.text || 'Codex 正在处理。'
    ].join('\n');
  }

  async handleCodexUiActionRequired(event) {
    const project = this.store.getProjectByThread(event.threadId);
    if (!project) return;
    this.markCodexReaction(event.threadId);

    const pending = this.findCodexUiPendingForProgress(event);
    if (!pending && !this.shouldRecoverCodexUiEvent(project, event)) return;

    const chatId = this.responseChatId(project, pending?.chatId);
    if (!chatId) return;

    const actionRequired = {
      kind: event.kind || 'input',
      title: event.title || 'Codex 需要你处理',
      message: event.message || '',
      command: event.command || '',
      cwd: event.cwd || '',
      toolName: event.toolName || '',
      requestId: event.requestId || '',
      choices: Array.isArray(event.choices) ? event.choices : []
    };

    this.store.updateProject(project.id, {
      status: 'waiting-input',
      activeTurnId: event.turnId || pending?.turnId || project.activeTurnId || '',
      lastError: '',
      lastSummary: truncate(actionRequired.message || actionRequired.title, 1200)
    });

    await this.upsertTaskCard(this.store.getProject(project.id) || project, chatId, {
      status: 'waiting-input',
      threadId: event.threadId,
      turnId: event.turnId || pending?.turnId || project.activeTurnId || '',
      prompt: pending?.prompt || project.taskCard?.prompt || '',
      summary: 'Codex 正在等待你处理。',
      result: '',
      error: '',
      sourceMessageId: pending?.sourceMessageId || project.taskCard?.sourceMessageId || '',
      actionRequired
    });
  }

  async handleCodexUiTaskComplete(event) {
    this.markCodexReaction(event.threadId);
    let pending = this.findCodexUiPendingForCompletion(event);
    let project = pending
      ? this.store.getProject(pending.projectId)
      : this.store.getProjectByThread(event.threadId);
    if (!pending) {
      if (!this.shouldRecoverCodexUiEvent(project, event)) return;
      pending = this.recoveredCodexUiPending(project, event);
    }
    if (!pending) return;
    if (!pending.userMessageSeen) return;
    if (pending.turnId && event.turnId && pending.turnId !== event.turnId) return;

    project = this.store.getProject(pending.projectId);
    if (!project) {
      this.removeCodexUiPending(event.threadId, pending.requestId);
      return;
    }

    const finalText = event.text || '任务已结束。';
    this.removeCodexUiPending(event.threadId, pending.requestId);
    const remainingPending = this.getCodexUiPendingList(event.threadId)
      .find((item) => item.userMessageSeen)
      || null;
    this.store.updateProject(project.id, {
      status: remainingPending ? 'running' : 'completed',
      activeTurnId: remainingPending?.turnId || '',
      lastError: '',
      lastSummary: truncate(finalText, 1600)
    });

    const chatId = this.responseChatId(project, pending.chatId);
    if (!chatId) return;

    const taskPatch = {
      status: 'completed',
      threadId: event.threadId,
      turnId: event.turnId || project.taskCard?.turnId || '',
      summary: '',
      result: finalText,
      actionRequired: null
    };
    const task = await this.upsertTaskCard(project, chatId, taskPatch);
    const resultCard = await this.sendFinalResultCard(project, chatId, finalText, taskPatch);
    await this.attachResultFilesToTaskCard(project, chatId, resultCard?.messageId ? resultCard : task, finalText, taskPatch);
    if (remainingPending) {
      await this.upsertTaskCard(this.store.getProject(project.id) || project, chatId, {
        status: 'running',
        threadId: event.threadId,
        turnId: remainingPending.turnId || '',
        prompt: remainingPending.prompt,
        summary: '上一条回复已回传，当前线程还有后续消息在等待 Codex 回复。',
        result: '',
        error: '',
        sourceMessageId: remainingPending.sourceMessageId || ''
      });
    }
    await this.drainProjectQueue(project.id, chatId);
  }

  async upsertTaskCard(project, chatId, patch = {}) {
    if (!chatId) return null;

    const latest = this.store.getProject(project.id) || project;
    const previous = patch.reset ? {} : (latest.taskCard || {});
    const now = new Date().toISOString();
    const fromPatch = (key, fallback = '') => (
      Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : fallback
    );
    const hasActionRequiredPatch = Object.prototype.hasOwnProperty.call(patch, 'actionRequired');
    const chatChanged = Boolean(previous.chatId && previous.chatId !== chatId);
    const task = {
      ...previous,
      ...patch,
      status: patch.status || previous.status || 'running',
      chatId,
      threadId: patch.threadId || previous.threadId || latest.threadId || '',
      turnId: patch.turnId || previous.turnId || latest.activeTurnId || '',
      prompt: truncate(fromPatch('prompt', previous.prompt || ''), 1200),
      summary: truncate(fromPatch('summary', previous.summary || ''), 2200),
      result: truncate(fromPatch('result', previous.result || ''), 4200),
      error: truncate(fromPatch('error', previous.error || ''), 1400),
      actionRequired: hasActionRequiredPatch
        ? normalizeActionRequired(patch.actionRequired)
        : normalizeActionRequired(previous.actionRequired),
      sourceMessageId: patch.sourceMessageId || previous.sourceMessageId || '',
      startedAt: previous.startedAt || now,
      updatedAt: now
    };
    if (task.status !== 'waiting-input' && !hasActionRequiredPatch) {
      task.actionRequired = null;
    }
    if (chatChanged) {
      task.messageId = '';
    }
    delete task.reset;

    const title = taskCardTitle(latest);
    const markdown = taskCardMarkdown(latest, task);
    const template = taskTemplate(task.status);
    const cardOptions = {
      actions: taskCardActions(latest, task)
    };

    if (task.messageId && typeof this.feishu.updateCard === 'function') {
      try {
        await this.feishu.updateCard(task.messageId, title, markdown, template, cardOptions);
        this.store.updateProject(latest.id, { taskCard: task });
        return task;
      } catch (error) {
        this.store.addEvent('error', `飞书任务卡更新失败，将新发卡片：${error.message}`, {
          chatId,
          messageId: task.messageId
        });
        task.messageId = '';
      }
    }

    if (typeof this.feishu.sendCard === 'function') {
      try {
        const result = await this.feishu.sendCard(chatId, title, markdown, template, {
          ...cardOptions,
          replyToMessageId: (previous.messageId || chatChanged) ? '' : task.sourceMessageId
        });
        task.messageId = result?.messageId || '';
        this.store.updateProject(latest.id, { taskCard: task });
        return task;
      } catch (error) {
        this.store.addEvent('error', `飞书任务卡发送失败，将降级为文本：${error.message}`, { chatId });
      }
    }

    this.store.updateProject(latest.id, { taskCard: task });
    await this.safeSendText(chatId, `${title}\n\n${stripMarkdownForText(markdown)}`);
    return task;
  }

  async sendStatusCard(chatId, project) {
    const markdown = [
      `**项目**：${escapeMarkdown(project.alias)}`,
      `**状态**：${escapeMarkdown(project.status || 'idle')}`,
      `**目录**：${escapeMarkdown(project.cwd)}`,
      `**线程**：${escapeMarkdown(project.threadId || '未创建')}`,
      `**队列**：${taskQueue(project).length} 条`,
      `**镜像模式**：${this.store.state.settings.mirrorExistingThread !== false ? '开启' : '关闭'}`,
      `**投递模式**：${this.deliveryModeLabel()}`,
      project.lastSummary ? `\n**最近摘要**：\n${escapeMarkdown(truncate(project.lastSummary, 1200))}` : ''
    ].filter(Boolean).join('\n');

    await this.safeSendMarkdownCard(chatId, `Codex 项目：${project.alias}`, markdown, project.status === 'running' ? 'blue' : 'green');
  }

  async safeSendText(chatId, text) {
    try {
      await this.feishu.sendText(chatId, text);
    } catch (error) {
      this.store.addEvent('error', `飞书发送失败：${error.message}`, { chatId });
    }
  }

  async safeSendMarkdownCard(chatId, title, markdown, template = 'blue', options = {}) {
    if (typeof this.feishu.sendCard !== 'function') {
      await this.safeSendText(chatId, `${title}\n\n${stripMarkdownForText(markdown)}`);
      return;
    }

    try {
      await this.feishu.sendCard(chatId, title, markdown, template, options);
    } catch (error) {
      this.store.addEvent('error', `飞书卡片发送失败：${error.message}`, { chatId });
      await this.safeSendText(chatId, `${title}\n\n${stripMarkdownForText(markdown)}`);
    }
  }

  deliveryModeLabel() {
    return this.store.state.settings.deliveryMode === 'codexUi' ? 'Codex 界面输入' : 'app-server';
  }

  optionalCodexAppServerMessage(error) {
    const detail = error?.message || String(error || 'unknown');
    if (this.store.state.settings.deliveryMode !== 'codexUi') {
      return `Codex app-server 不可用：${detail}`;
    }

    return [
      'Codex app-server 可选能力不可用。',
      '当前是 Codex 界面输入模式，飞书发任务、粘贴到 Codex App、监听结果回传不依赖 app-server。',
      '受影响的是 `/threads`、`/attach-latest` 这类线程查询辅助功能。',
      '你仍然可以在 Codex App 打开目标线程后，用 `/bind 项目别名 thread_id` 手动绑定。',
      '',
      `原始错误：${detail}`
    ].join('\n');
  }
}

module.exports = {
  BridgeRouter
};
