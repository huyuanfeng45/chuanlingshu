const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const readline = require('readline');
const { buildRuntimePath, resolveCodexBin } = require('./codex-bin.cjs');

function stringifyError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || JSON.stringify(error);
}

function extractThreadId(result) {
  return result?.thread?.id || result?.threadId || result?.id || '';
}

function extractFinalAgentText(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const agentMessages = items
    .filter((item) => item.type === 'agentMessage' && item.text)
    .map((item) => item.text.trim())
    .filter(Boolean);
  return agentMessages.at(-1) || '';
}

class CodexService extends EventEmitter {
  constructor({ codexBin = 'codex' } = {}) {
    super();
    this.codexBin = codexBin;
    this.resolvedCodexBin = '';
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.agentBuffers = new Map();
    this.defaultTimeoutMs = 45000;
  }

  setCodexBin(codexBin) {
    this.codexBin = codexBin || 'codex';
    this.resolvedCodexBin = '';
  }

  async start() {
    if (this.proc && !this.proc.killed) return;

    this.resolvedCodexBin = resolveCodexBin(this.codexBin);
    this.emit('log', {
      type: 'codex',
      message: `using codex binary: ${this.resolvedCodexBin}`
    });

    this.proc = spawn(this.resolvedCodexBin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: buildRuntimePath()
      }
    });

    this.proc.on('exit', (code, signal) => {
      this.initialized = false;
      this.proc = null;
      this.emit('status', 'stopped');
      this.emit('log', {
        type: 'codex',
        message: `codex app-server exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`
      });
      for (const pending of this.pending.values()) {
        pending.reject(new Error('codex app-server 已退出'));
      }
      this.pending.clear();
    });

    this.proc.on('error', (error) => {
      this.initialized = false;
      this.proc = null;
      this.emit('status', 'stopped');
      this.emit('error', error);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      this.handleLine(line);
    });

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) {
        this.emit('log', { type: 'codex.stderr', message: text });
      }
    });

    this.emit('status', 'starting');
    await this.request('initialize', {
      clientInfo: {
        name: 'codex_feishu_bridge',
        title: '传令书',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true
      }
    }, this.defaultTimeoutMs);
    this.notify('initialized', {});
    this.initialized = true;
    this.emit('status', 'running');
  }

  async stop() {
    if (!this.proc) return;
    this.proc.kill();
    this.proc = null;
    this.initialized = false;
    this.emit('status', 'stopped');
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('log', { type: 'codex.raw', message: line });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      this.handleNotification(message);
    }
  }

  handleNotification(message) {
    const { method, params = {} } = message;

    if (method === 'item/agentMessage/delta') {
      const key = `${params.threadId}:${params.turnId}:${params.itemId}`;
      const next = `${this.agentBuffers.get(key) || ''}${params.delta || ''}`;
      this.agentBuffers.set(key, next);
      this.emit('agent-delta', { ...params, text: next });
    }

    if (method === 'turn/completed') {
      const finalText = extractFinalAgentText(params.turn);
      message.params = { ...params, finalText };
      this.emit('turn-completed', message.params);
    }

    this.emit('notification', message);
  }

  send(message) {
    if (!this.proc || this.proc.killed) {
      throw new Error('codex app-server 未运行');
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = this.defaultTimeoutMs) {
    const id = this.nextId++;
    const message = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this.send(message);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  async ensureStarted() {
    if (!this.initialized) {
      await this.start();
    }
  }

  async listThreads({ query = '', cwd = '', limit = 10 } = {}) {
    await this.ensureStarted();
    const params = {
      archived: false,
      limit,
      searchTerm: query || null,
      sortDirection: 'desc',
      sortKey: 'updated_at',
      useStateDbOnly: false
    };

    if (cwd) {
      params.cwd = [cwd];
    }

    return this.request('thread/list', params);
  }

  async startThread({ cwd, model }) {
    await this.ensureStarted();
    const result = await this.request('thread/start', {
      cwd: cwd || null,
      model: model || null,
      threadSource: 'codex_feishu_bridge'
    });
    const threadId = extractThreadId(result);
    if (!threadId) {
      throw new Error(`Codex 未返回 threadId：${JSON.stringify(result)}`);
    }
    return threadId;
  }

  async resumeThread({ threadId, cwd, model }) {
    await this.ensureStarted();
    const result = await this.request('thread/resume', {
      threadId,
      cwd: cwd || null,
      model: model || null
    });
    return extractThreadId(result) || threadId;
  }

  async startTurn({ threadId, prompt, cwd, model }) {
    await this.ensureStarted();
    return this.request('turn/start', {
      threadId,
      cwd: cwd || null,
      model: model || null,
      input: [
        {
          type: 'text',
          text: prompt
        }
      ]
    });
  }

  async steerTurn({ threadId, turnId, prompt }) {
    await this.ensureStarted();
    return this.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [
        {
          type: 'text',
          text: prompt
        }
      ]
    });
  }

  async interruptTurn({ threadId, turnId }) {
    await this.ensureStarted();
    return this.request('turn/interrupt', {
      threadId,
      turnId
    });
  }
}

module.exports = {
  CodexService,
  stringifyError,
  extractFinalAgentText
};
