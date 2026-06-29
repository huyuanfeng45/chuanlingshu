const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function normalizeThreadId(threadId) {
  return String(threadId || '').trim();
}

function normalizeSinceMs(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeWatchEntry(entry) {
  if (typeof entry === 'string') {
    return {
      threadId: normalizeThreadId(entry),
      fromEnd: true,
      sinceMs: 0
    };
  }

  if (!entry || typeof entry !== 'object') {
    return {
      threadId: '',
      fromEnd: true,
      sinceMs: 0
    };
  }

  return {
    threadId: normalizeThreadId(entry.threadId),
    fromEnd: entry.fromEnd !== false,
    sinceMs: normalizeSinceMs(entry.sinceMs)
  };
}

function extractTurnId(payload = {}) {
  return payload.internal_chat_message_metadata_passthrough?.turn_id || '';
}

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      return part.text || part.content || '';
    })
    .filter(Boolean)
    .join('\n');
}

function truncateText(value, limit = 1400) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 20)}\n...已截断`;
}

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function summarizeQuestion(question = {}) {
  return String(question.question || question.prompt || question.header || '').trim();
}

function extractChoiceOptions(args = {}) {
  const choices = [];
  const questions = Array.isArray(args.questions) && args.questions.length
    ? args.questions
    : [{
      question: args.question || args.prompt || args.message || '',
      options: args.options || args.choices || []
    }];

  for (const question of questions) {
    const questionText = summarizeQuestion(question);
    const options = Array.isArray(question.options)
      ? question.options
      : Array.isArray(question.choices)
        ? question.choices
        : [];

    for (const option of options) {
      const label = typeof option === 'string'
        ? option
        : String(option.label || option.text || option.value || '').trim();
      if (!label) continue;

      const description = typeof option === 'object'
        ? String(option.description || option.detail || '').trim()
        : '';
      choices.push({
        label,
        value: questionText ? `${questionText}\n${label}` : label,
        description,
        question: questionText
      });
    }
  }

  return choices;
}

function actionRequestId(payload = {}, fallback = '') {
  return payload.call_id || payload.id || fallback;
}

function fileThreadId(filePath) {
  const match = path.basename(filePath).match(UUID_RE);
  return match ? match[1] : '';
}

class CodexSessionWatcher extends EventEmitter {
  constructor({
    sessionsRoot = path.join(os.homedir(), '.codex', 'sessions'),
    pollIntervalMs = 1500
  } = {}) {
    super();
    this.sessionsRoot = sessionsRoot;
    this.pollIntervalMs = pollIntervalMs;
    this.threads = new Map();
    this.timer = null;
    this.polling = false;
    this.lastPollAt = '';
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch((error) => this.emit('error', error));
    }, this.pollIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.poll().catch((error) => this.emit('error', error));
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.polling = false;
    this.threads.clear();
  }

  watchThread(threadId, { fromEnd = true, sinceMs = 0 } = {}) {
    const id = normalizeThreadId(threadId);
    if (!id) return null;

    const replaySinceMs = normalizeSinceMs(sinceMs);
    const existing = this.threads.get(id);
    if (existing) {
      if (!existing.replaySinceMs && replaySinceMs) {
        existing.replaySinceMs = replaySinceMs;
        existing.fromEnd = false;
      }
      return existing.filePath || null;
    }

    const filePath = this.findSessionFile(id);
    const offset = this.initialOffset(filePath, {
      fromEnd,
      sinceMs: replaySinceMs
    });
    this.threads.set(id, {
      threadId: id,
      filePath,
      offset,
      fromEnd: Boolean(fromEnd),
      replaySinceMs,
      waitingForFile: !filePath,
      buffer: '',
      decoder: new StringDecoder('utf8'),
      currentTurnId: '',
      actionRequestIds: new Set()
    });
    return filePath;
  }

  setWatchedThreads(threadIds) {
    const entries = Array.from(threadIds || [])
      .map(normalizeWatchEntry)
      .filter((entry) => entry.threadId);
    const next = new Map(entries.map((entry) => [entry.threadId, entry]));
    for (const threadId of Array.from(this.threads.keys())) {
      if (!next.has(threadId)) this.threads.delete(threadId);
    }
    for (const entry of next.values()) {
      this.watchThread(entry.threadId, {
        fromEnd: entry.fromEnd,
        sinceMs: entry.sinceMs
      });
    }
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      this.lastPollAt = new Date().toISOString();
      for (const state of this.threads.values()) {
        this.pollThread(state);
      }
    } finally {
      this.polling = false;
    }
  }

  pollThread(state) {
    if (!state.filePath || !fs.existsSync(state.filePath)) {
      const filePath = this.findSessionFile(state.threadId);
      if (!filePath) return;
      state.filePath = filePath;
      state.offset = this.initialOffset(filePath, {
        fromEnd: state.waitingForFile ? false : state.fromEnd,
        sinceMs: state.replaySinceMs
      });
      state.waitingForFile = false;
      state.lastFoundAt = new Date().toISOString();
      state.buffer = '';
      state.decoder = new StringDecoder('utf8');
      this.emit('log', {
        type: 'codex.session',
        message: state.replaySinceMs
          ? `已找到 Codex 会话文件并恢复读取：${state.threadId}`
          : `已找到 Codex 会话文件：${state.threadId}`
      });
      return;
    }

    const size = this.fileSize(state.filePath);
    if (size < state.offset) {
      state.offset = 0;
      state.buffer = '';
      state.decoder = new StringDecoder('utf8');
    }
    if (size === state.offset) return;

    const length = size - state.offset;
    const fd = fs.openSync(state.filePath, 'r');
    try {
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, chunk, 0, length, state.offset);
      state.offset += bytesRead;
      state.lastReadAt = new Date().toISOString();
      const text = state.decoder.write(chunk.subarray(0, bytesRead));
      this.processText(state, text);
    } finally {
      fs.closeSync(fd);
    }
  }

  processText(state, text) {
    const combined = `${state.buffer}${text}`;
    const lines = combined.split('\n');
    state.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.processLine(state, trimmed);
    }
  }

  processLine(state, line) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      this.emit('log', {
        type: 'codex.session',
        message: `跳过无法解析的 Codex 会话行：${error.message}`
      });
      return;
    }

    const base = {
      threadId: state.threadId || fileThreadId(state.filePath),
      filePath: state.filePath,
      timestamp: record.timestamp || '',
      timeMs: Date.parse(record.timestamp || '') || Date.now()
    };
    state.lastEventAt = new Date().toISOString();

    if (record.type === 'event_msg') {
      this.processEventMessage(state, base, record.payload || {});
      this.processProgressItem(state, base, record.type, record.payload || {});
      return;
    }

    if (record.type === 'response_item') {
      this.processResponseItem(state, base, record.payload || {});
      this.processActionRequired(state, base, record.payload || {});
      this.processProgressItem(state, base, record.type, record.payload || {});
    }
  }

  processEventMessage(state, base, payload) {
    if (payload.type === 'task_started') {
      state.currentTurnId = payload.turn_id || '';
      this.emit('task-started', {
        ...base,
        turnId: state.currentTurnId
      });
      return;
    }

    if (payload.type === 'user_message') {
      this.emit('user-message', {
        ...base,
        turnId: payload.turn_id || state.currentTurnId || '',
        text: payload.message || ''
      });
      return;
    }

    if (payload.type === 'task_complete') {
      this.emit('task-complete', {
        ...base,
        source: 'task_complete',
        turnId: payload.turn_id || state.currentTurnId || '',
        text: payload.last_agent_message || ''
      });
    }
  }

  processResponseItem(state, base, payload) {
    if (payload.type !== 'message') return;

    if (payload.role === 'user') {
      this.emit('user-message', {
        ...base,
        turnId: extractTurnId(payload) || state.currentTurnId || '',
        text: extractContentText(payload.content)
      });
      return;
    }

    if (payload.role === 'assistant' && payload.phase === 'final_answer') {
      this.emit('final-answer', {
        ...base,
        source: 'final_answer',
        turnId: extractTurnId(payload) || state.currentTurnId || '',
        text: extractContentText(payload.content)
      });
    }
  }

  processProgressItem(state, base, recordType, payload) {
    const progress = this.progressFromPayload(state, recordType, payload);
    if (!progress?.text) return;

    this.emit('progress', {
      ...base,
      turnId: progress.turnId || payload.turn_id || extractTurnId(payload) || state.currentTurnId || '',
      kind: progress.kind || 'progress',
      text: truncateText(progress.text, 1800)
    });
  }

  processActionRequired(state, base, payload) {
    const actionRequired = this.actionRequiredFromPayload(state, payload);
    if (!actionRequired) return;

    const requestId = actionRequired.requestId || `${actionRequired.kind}:${actionRequired.toolName}:${base.timestamp}`;
    if (state.actionRequestIds.has(requestId)) return;
    state.actionRequestIds.add(requestId);
    if (state.actionRequestIds.size > 200) {
      const [oldest] = state.actionRequestIds;
      state.actionRequestIds.delete(oldest);
    }

    this.emit('action-required', {
      ...base,
      ...actionRequired,
      requestId,
      turnId: actionRequired.turnId || state.currentTurnId || ''
    });
  }

  actionRequiredFromPayload(state, payload) {
    if (payload.type !== 'function_call') return null;

    const toolName = payload.name || '';
    const args = parseJsonObject(payload.arguments);
    const turnId = extractTurnId(payload) || state.currentTurnId || '';
    const requestId = actionRequestId(payload, `${toolName}:${payload.arguments || ''}`);

    if (toolName === 'request_user_input') {
      const questions = Array.isArray(args.questions) && args.questions.length
        ? args.questions.map(summarizeQuestion).filter(Boolean)
        : [args.question || args.prompt || args.message || 'Codex 需要你做出选择。'].filter(Boolean);
      const choices = extractChoiceOptions(args);
      return {
        kind: choices.length ? 'choice' : 'input',
        toolName,
        requestId,
        turnId,
        title: choices.length ? 'Codex 需要你选择' : 'Codex 需要你回复',
        message: questions.join('\n\n') || 'Codex 正在等待你的输入。',
        choices
      };
    }

    const requiresApproval = args.sandbox_permissions === 'require_escalated'
      || args.approval === 'required'
      || args.require_approval === true
      || args.requires_approval === true;
    if (toolName === 'exec_command' && requiresApproval) {
      return {
        kind: 'approval',
        toolName,
        requestId,
        turnId,
        title: 'Codex 请求批准执行命令',
        message: args.justification || 'Codex 需要你在界面里批准后才能继续。',
        command: args.cmd || '',
        cwd: args.workdir || ''
      };
    }

    if (requiresApproval) {
      return {
        kind: 'approval',
        toolName,
        requestId,
        turnId,
        title: 'Codex 请求批准操作',
        message: args.justification || `Codex 工具 ${toolName || 'unknown'} 正在等待批准。`
      };
    }

    return null;
  }

  progressFromPayload(state, recordType, payload) {
    if (recordType === 'event_msg') {
      if (payload.type === 'agent_message' && payload.phase === 'commentary' && payload.message) {
        return {
          kind: 'message',
          text: payload.message,
          turnId: state.currentTurnId || payload.turn_id || ''
        };
      }

      if (payload.type === 'patch_apply_end') {
        const files = Object.keys(payload.changes || {});
        const detail = files.length ? `\n${files.slice(0, 5).join('\n')}` : '';
        return {
          kind: 'tool',
          text: `${payload.success === false ? '代码修改失败' : '代码修改完成'}${detail}`,
          turnId: payload.turn_id || state.currentTurnId || ''
        };
      }

      if (payload.type === 'image_generation_end') {
        const saved = payload.saved_path ? `\n${payload.saved_path}` : '';
        return {
          kind: 'tool',
          text: `图片生成${payload.status ? `：${payload.status}` : '完成'}${saved}`,
          turnId: payload.turn_id || state.currentTurnId || ''
        };
      }

      return null;
    }

    if (recordType !== 'response_item') return null;

    if (payload.type === 'function_call') {
      const args = parseJsonObject(payload.arguments);
      if (payload.name === 'exec_command' && args.cmd) {
        return {
          kind: 'tool',
          text: `准备执行命令：\n${args.cmd}`,
          turnId: extractTurnId(payload) || state.currentTurnId || ''
        };
      }
      return {
        kind: 'tool',
        text: `正在调用工具：${payload.name || 'unknown'}`,
        turnId: extractTurnId(payload) || state.currentTurnId || ''
      };
    }

    if (payload.type === 'function_call_output' && payload.output) {
      return {
        kind: 'tool',
        text: `命令/工具输出：\n${truncateText(payload.output, 1200)}`,
        turnId: extractTurnId(payload) || state.currentTurnId || ''
      };
    }

    if (payload.type === 'custom_tool_call') {
      return {
        kind: 'tool',
        text: `正在执行工具：${payload.name || 'custom_tool'}${payload.name === 'apply_patch' ? '\n正在修改项目文件。' : ''}`,
        turnId: extractTurnId(payload) || state.currentTurnId || ''
      };
    }

    if (payload.type === 'custom_tool_call_output' && payload.output) {
      return {
        kind: 'tool',
        text: `工具输出：\n${truncateText(payload.output, 1200)}`,
        turnId: extractTurnId(payload) || state.currentTurnId || ''
      };
    }

    if (payload.type === 'image_generation_call') {
      return {
        kind: 'tool',
        text: `正在生成图片${payload.status ? `：${payload.status}` : ''}`,
        turnId: extractTurnId(payload) || state.currentTurnId || ''
      };
    }

    return null;
  }

  findSessionFile(threadId) {
    if (!fs.existsSync(this.sessionsRoot)) return '';

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
          const stat = fs.statSync(itemPath);
          candidates.push({ itemPath, mtimeMs: stat.mtimeMs });
        } catch {
          // Ignore files that disappear during the scan.
        }
      }
    };

    walk(this.sessionsRoot);
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.itemPath || '';
  }

  fileSize(filePath) {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  initialOffset(filePath, { fromEnd = true, sinceMs = 0 } = {}) {
    if (!filePath) return 0;
    const replaySinceMs = normalizeSinceMs(sinceMs);
    if (replaySinceMs) return this.fileOffsetForTimestamp(filePath, replaySinceMs);
    return fromEnd ? this.fileSize(filePath) : 0;
  }

  fileOffsetForTimestamp(filePath, sinceMs) {
    const replaySinceMs = normalizeSinceMs(sinceMs);
    if (!replaySinceMs) return 0;

    let buffer;
    try {
      buffer = fs.readFileSync(filePath);
    } catch {
      return 0;
    }

    let lineStart = 0;
    for (let index = 0; index <= buffer.length; index += 1) {
      if (index < buffer.length && buffer[index] !== 0x0a) continue;

      const line = buffer.subarray(lineStart, index).toString('utf8').trim();
      if (line) {
        try {
          const record = JSON.parse(line);
          const timeMs = Date.parse(record.timestamp || '');
          if (Number.isFinite(timeMs) && timeMs >= replaySinceMs) {
            return lineStart;
          }
        } catch {
          // Ignore malformed historic lines; normal polling will still log new malformed lines.
        }
      }
      lineStart = index + 1;
    }

    return buffer.length;
  }

  getStatus() {
    const threads = Array.from(this.threads.values()).map((state) => {
      const exists = Boolean(state.filePath && fs.existsSync(state.filePath));
      return {
        threadId: state.threadId,
        filePath: state.filePath || '',
        found: exists,
        offset: state.offset || 0,
        currentTurnId: state.currentTurnId || '',
        waitingForFile: Boolean(state.waitingForFile),
        replaySinceMs: state.replaySinceMs || 0,
        lastFoundAt: state.lastFoundAt || '',
        lastReadAt: state.lastReadAt || '',
        lastEventAt: state.lastEventAt || ''
      };
    });

    return {
      running: Boolean(this.timer),
      polling: this.polling,
      sessionsRoot: this.sessionsRoot,
      pollIntervalMs: this.pollIntervalMs,
      watchedCount: threads.length,
      foundCount: threads.filter((item) => item.found).length,
      lastPollAt: this.lastPollAt,
      threads
    };
  }
}

module.exports = {
  CodexSessionWatcher,
  extractContentText
};
