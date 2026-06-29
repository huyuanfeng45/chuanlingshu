const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { redactString } = require('./redact.cjs');

const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

function compactText(value, limit = 3600) {
  const text = redactString(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 40)}\n\n...内容过长，已截断`;
}

function plainHeadingText(value) {
  return String(value || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+#+\s*$/, '')
    .trim();
}

function formatMarkdownForCard(value) {
  const text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return '';

  let fenceMarker = '';
  const lines = text.split('\n').map((line) => {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const marker = fence[1][0];
      if (!fenceMarker) {
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        fenceMarker = '';
      }
      return line;
    }

    if (fenceMarker) return line;

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const headingText = plainHeadingText(heading[2]);
      return headingText ? `**${headingText}**` : '';
    }

    const checkbox = line.match(/^(\s*[-*+]\s+)\[( |x|X)\]\s+(.*)$/);
    if (checkbox) {
      const state = checkbox[2].trim() ? '已完成：' : '待处理：';
      return `${checkbox[1]}${state}${checkbox[3]}`;
    }

    return line;
  });

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripMarkdownForText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^(\s*[-*+]\s+)\[( |x|X)\]\s+/gm, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function plainText(content) {
  return {
    tag: 'plain_text',
    content
  };
}

function buildActionButton({ text, action, type = 'default', value = {} }) {
  return {
    tag: 'button',
    text: plainText(text),
    type,
    value: {
      bridge: 'codex-feishu-bridge',
      action,
      ...value
    }
  };
}

function buildMarkdownCard(title, markdown, template = 'blue', options = {}) {
  const elements = [
    {
      tag: 'markdown',
      content: compactText(formatMarkdownForCard(markdown))
    }
  ];

  if (Array.isArray(options.extraElements) && options.extraElements.length) {
    elements.push(...options.extraElements);
  }

  if (Array.isArray(options.actions) && options.actions.length) {
    elements.push({
      tag: 'action',
      layout: options.actions.length >= 3 ? 'trisection' : options.actions.length === 2 ? 'bisected' : 'flow',
      actions: options.actions.map(buildActionButton)
    });
  }

  return {
    config: {
      wide_screen_mode: true,
      update_multi: true
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: compactText(title, 120)
      }
    },
    elements
  };
}

function messageResult(response) {
  return {
    messageId: response?.data?.message_id || '',
    raw: response
  };
}

function uploadFileType(filePath) {
  const ext = path.extname(filePath || '').toLowerCase().replace(/^\./, '');
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'xls';
  if (['ppt', 'pptx'].includes(ext)) return 'ppt';
  if (ext === 'mp4') return 'mp4';
  if (ext === 'opus') return 'opus';
  return 'stream';
}

function readableToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function parseMessageContent(content) {
  if (!content) return {};
  if (typeof content === 'object') return content;

  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : { text: String(parsed || '') };
  } catch {
    return { text: String(content || '') };
  }
}

function normalizeMessageAttachments(messageType, parsed) {
  const type = String(messageType || '').toLowerCase();
  const attachments = [];

  if (type === 'image' && parsed.image_key) {
    attachments.push({
      type: 'image',
      fileKey: parsed.image_key,
      fileName: parsed.file_name || ''
    });
  }

  if (type === 'file' && parsed.file_key) {
    attachments.push({
      type: 'file',
      fileKey: parsed.file_key,
      fileName: parsed.file_name || parsed.name || ''
    });
  }

  return attachments;
}

function normalizeFeishuCardAction(data) {
  const event = data.event || data;
  const messageId = event.context?.open_message_id || event.open_message_id || '';
  const chatId = event.context?.open_chat_id || event.open_chat_id || '';
  const operator = event.operator || {};
  const action = event.action || {};
  const userId = typeof event.user_id === 'string' ? event.user_id : event.user_id?.user_id;

  return {
    messageId,
    chatId,
    operatorId: operator.open_id || event.open_id || operator.user_id || userId || operator.union_id || '',
    operatorName: operator.name || event.name || '',
    actionTag: action.tag || '',
    actionName: action.name || '',
    actionOption: action.option || '',
    actionValue: action.value || {},
    raw: data
  };
}

function mentionTokens(message) {
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  return mentions
    .flatMap((mention) => [
      mention.key,
      mention.name,
      mention.id?.open_id,
      mention.id?.user_id,
      mention.id?.union_id
    ])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function stripLeadingMentions(text, message) {
  let value = String(text || '').trim();
  value = value.replace(/^(?:<at\b[^>]*>.*?<\/at>\s*)+/i, '').trim();

  const tokens = mentionTokens(message).sort((a, b) => b.length - a.length);
  let changed = true;
  while (changed) {
    changed = false;
    for (const token of tokens) {
      const candidates = [token, `@${token}`];
      for (const candidate of candidates) {
        if (candidate && value.startsWith(candidate)) {
          value = value.slice(candidate.length).trim();
          changed = true;
        }
      }
    }
  }

  return value;
}

function normalizeFeishuMessage(data) {
  const event = data.event || data;
  const message = event.message || data.message || {};
  const sender = event.sender || data.sender || {};
  const parsed = parseMessageContent(message.content || '');
  const messageType = message.message_type || message.messageType || '';
  const content = parsed.text || parsed.content || '';

  return {
    chatId: message.chat_id || message.chatId || '',
    messageId: message.message_id || message.messageId || '',
    messageType,
    text: stripLeadingMentions(content, message),
    attachments: normalizeMessageAttachments(messageType, parsed),
    senderId: sender.sender_id?.open_id || sender.sender_id?.union_id || sender.sender_id?.user_id || '',
    senderType: sender.sender_type || '',
    raw: data
  };
}

class FeishuService extends EventEmitter {
  constructor() {
    super();
    this.lark = null;
    this.client = null;
    this.wsClient = null;
    this.status = 'stopped';
  }

  requireSdk() {
    if (!this.lark) {
      this.lark = require('@larksuiteoapi/node-sdk');
    }
    return this.lark;
  }

  configure({ appId, appSecret }) {
    if (!appId || !appSecret) {
      throw new Error('请先配置飞书 App ID 和 App Secret');
    }

    const Lark = this.requireSdk();
    const baseConfig = {
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.warn
    };

    this.client = new Lark.Client(baseConfig);
    this.baseConfig = baseConfig;
  }

  async start() {
    if (!this.baseConfig || !this.client) {
      throw new Error('飞书服务还没有配置');
    }

    await this.stop();

    const Lark = this.requireSdk();
    this.wsClient = new Lark.WSClient(this.baseConfig);
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const message = normalizeFeishuMessage(data);
        if (!message.chatId || (!message.text && !message.attachments.length)) return;
        this.emit('message', message);
      },
      'card.action.trigger': async (data) => {
        const action = normalizeFeishuCardAction(data);
        if (!action.chatId || !action.messageId || !action.operatorId) return;
        this.emit('card-action', action);
      }
    });

    this.wsClient.start({ eventDispatcher: dispatcher });
    this.status = 'running';
    this.emit('status', this.status);
  }

  async stop() {
    if (this.wsClient) {
      if (typeof this.wsClient.stop === 'function') {
        await this.wsClient.stop();
      } else if (typeof this.wsClient.close === 'function') {
        await this.wsClient.close();
      }
    }
    this.wsClient = null;
    this.status = 'stopped';
    this.emit('status', this.status);
  }

  async sendText(chatId, text) {
    if (!this.client) {
      throw new Error('飞书 Client 未初始化');
    }

    const response = await this.client.im.v1.message.create({
      params: {
        receive_id_type: 'chat_id'
      },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text: compactText(text) }),
        msg_type: 'text'
      }
    });
    return messageResult(response);
  }

  async sendCard(chatId, title, markdown, template = 'blue', options = {}) {
    if (!this.client) {
      throw new Error('飞书 Client 未初始化');
    }

    const card = buildMarkdownCard(title, markdown, template, options);
    if (options.replyToMessageId) {
      const response = await this.client.im.v1.message.reply({
        path: {
          message_id: options.replyToMessageId
        },
        data: {
          content: JSON.stringify(card),
          msg_type: 'interactive',
          reply_in_thread: Boolean(options.replyInThread)
        }
      });
      return messageResult(response);
    }

    const response = await this.client.im.v1.message.create({
      params: {
        receive_id_type: 'chat_id'
      },
      data: {
        receive_id: chatId,
        content: JSON.stringify(card),
        msg_type: 'interactive'
      }
    });
    return messageResult(response);
  }

  async updateCard(messageId, title, markdown, template = 'blue', options = {}) {
    if (!this.client) {
      throw new Error('飞书 Client 未初始化');
    }
    if (!messageId) {
      throw new Error('缺少要更新的飞书 message_id');
    }

    const card = buildMarkdownCard(title, markdown, template, options);
    await this.client.im.v1.message.patch({
      path: {
        message_id: messageId
      },
      data: {
        content: JSON.stringify(card)
      }
    });
  }

  async uploadFile(filePath, options = {}) {
    if (!this.client) {
      throw new Error('飞书 Client 未初始化');
    }
    if (!filePath) {
      throw new Error('缺少要上传的文件路径');
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error('只能上传普通文件');
    }
    if (stat.size <= 0) {
      throw new Error('飞书不支持上传空文件');
    }

    const fileName = options.fileName || path.basename(filePath);
    const response = await this.client.im.v1.file.create({
      data: {
        file_type: options.fileType || uploadFileType(filePath),
        file_name: fileName,
        file: fs.createReadStream(filePath)
      }
    });
    const fileKey = response?.file_key || response?.data?.file_key || '';
    if (!fileKey) {
      throw new Error('飞书文件上传没有返回 file_key');
    }

    return {
      fileKey,
      fileName,
      size: stat.size,
      raw: response
    };
  }

  async uploadImage(filePath, options = {}) {
    if (!this.client) {
      throw new Error('飞书 Client 未初始化');
    }
    if (!filePath) {
      throw new Error('缺少要上传的图片路径');
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error('只能上传普通图片文件');
    }
    if (stat.size <= 0) {
      throw new Error('飞书不支持上传空图片');
    }
    if (stat.size > MAX_IMAGE_UPLOAD_BYTES) {
      throw new Error('飞书图片上传大小不能超过 10MB');
    }

    const response = await this.client.im.v1.image.create({
      data: {
        image_type: options.imageType || 'message',
        image: fs.createReadStream(filePath)
      }
    });
    const imageKey = response?.image_key || response?.data?.image_key || '';
    if (!imageKey) {
      throw new Error('飞书图片上传没有返回 image_key');
    }

    return {
      imageKey,
      fileName: options.fileName || path.basename(filePath),
      size: stat.size,
      raw: response
    };
  }

  async sendFile(chatId, filePath, options = {}) {
    if (!this.client) {
      throw new Error('飞书 Client 未初始化');
    }
    if (!chatId) {
      throw new Error('缺少飞书 chat_id');
    }

    const uploaded = await this.uploadFile(filePath, options);
    const payload = {
      content: JSON.stringify({ file_key: uploaded.fileKey }),
      msg_type: 'file'
    };

    if (options.replyToMessageId) {
      const response = await this.client.im.v1.message.reply({
        path: {
          message_id: options.replyToMessageId
        },
        data: {
          ...payload,
          reply_in_thread: Boolean(options.replyInThread)
        }
      });
      return {
        ...messageResult(response),
        ...uploaded
      };
    }

    const response = await this.client.im.v1.message.create({
      params: {
        receive_id_type: 'chat_id'
      },
      data: {
        receive_id: chatId,
        ...payload
      }
    });
    return {
      ...messageResult(response),
      ...uploaded
    };
  }

  async sendImage(chatId, filePath, options = {}) {
    if (!this.client) {
      throw new Error('飞书 Client 未初始化');
    }
    if (!chatId) {
      throw new Error('缺少飞书 chat_id');
    }

    const uploaded = await this.uploadImage(filePath, options);
    const payload = {
      content: JSON.stringify({ image_key: uploaded.imageKey }),
      msg_type: 'image'
    };

    if (options.replyToMessageId) {
      const response = await this.client.im.v1.message.reply({
        path: {
          message_id: options.replyToMessageId
        },
        data: {
          ...payload,
          reply_in_thread: Boolean(options.replyInThread)
        }
      });
      return {
        ...messageResult(response),
        ...uploaded
      };
    }

    const response = await this.client.im.v1.message.create({
      params: {
        receive_id_type: 'chat_id'
      },
      data: {
        receive_id: chatId,
        ...payload
      }
    });
    return {
      ...messageResult(response),
      ...uploaded
    };
  }

  async downloadMessageResource(messageId, attachment) {
    if (!this.client) {
      throw new Error('飞书 Client 未初始化');
    }
    if (!messageId) {
      throw new Error('缺少附件所在的飞书 message_id');
    }
    if (!attachment?.fileKey) {
      throw new Error('缺少附件 file_key');
    }

    const type = attachment.type === 'image' ? 'image' : 'file';
    const response = await this.client.im.v1.messageResource.get({
      params: {
        type
      },
      path: {
        message_id: messageId,
        file_key: attachment.fileKey
      }
    });

    if (Buffer.isBuffer(response)) return response;
    if (response instanceof Uint8Array) return Buffer.from(response);
    if (typeof response?.getReadableStream === 'function') {
      return readableToBuffer(response.getReadableStream());
    }
    if (Buffer.isBuffer(response?.data)) return response.data;
    if (response?.data instanceof Uint8Array) return Buffer.from(response.data);

    throw new Error('飞书附件下载返回了无法识别的数据类型');
  }
}

module.exports = {
  FeishuService,
  buildMarkdownCard,
  normalizeFeishuMessage,
  normalizeFeishuCardAction,
  stripLeadingMentions,
  formatMarkdownForCard,
  stripMarkdownForText
};
