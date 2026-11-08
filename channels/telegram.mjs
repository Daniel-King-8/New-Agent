import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function parseTelegramUpdate(update, { botUsername = '', botId = 0 } = {}) {
  const message = update?.message || update?.edited_message;
  if (!message) return null;
  const chat = message.chat || {};
  const from = message.from || {};
  if (String(from.id) === String(botId)) return null;
  const chatType = chat.type === 'private' ? 'private' : 'group';
  const text = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];
  let mentioned = false;
  for (const entity of entities) {
    if (entity.type === 'mention') {
      const mention = text.slice(entity.offset, entity.offset + entity.length).trim();
      if (botUsername && mention.toLowerCase() === `@${botUsername}`.toLowerCase()) mentioned = true;
    }
    if (entity.type === 'text_mention' && String(entity.user?.id) === String(botId)) mentioned = true;
  }
  if (String(message.reply_to_message?.from?.id) === String(botId)) mentioned = true;
  const photos = message.photo || [];
  const images = photos.length
    ? [{ fileId: photos[photos.length - 1].file_id, width: photos[photos.length - 1].width, height: photos[photos.length - 1].height }]
    : [];
  const files = [];
  if (message.document) files.push({ fileId: message.document.file_id, name: message.document.file_name || 'document' });
  if (message.voice) files.push({ fileId: message.voice.file_id, name: 'voice.ogg' });
  if (message.audio) files.push({ fileId: message.audio.file_id, name: message.audio.file_name || 'audio.mp3' });
  if (!text && !images.length && !files.length) return null;
  return {
    channel: 'telegram',
    chatType,
    chatId: String(chat.id),
    userId: String(from.id || ''),
    userName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || '',
    text,
    images,
    files,
    mentioned,
    messageId: String(message.message_id || ''),
    raw: update
  };
}

export class TelegramChannel {
  constructor({ getConfig, logger, onMessage }) {
    this.getConfig = getConfig;
    this.logger = logger;
    this.onMessage = onMessage;
    this.running = false;
    this.abort = null;
    this.offset = 0;
    this.botUsername = '';
    this.botId = 0;
    this.status = {
      online: false,
      botUsername: '',
      lastError: '',
      updatedAt: new Date().toISOString()
    };
  }

  get config() {
    return this.getConfig().channels.telegram;
  }

  getStatus() {
    return { ...this.status };
  }

  updateStatus(patch) {
    this.status = { ...this.status, ...patch, updatedAt: new Date().toISOString() };
  }

  apiUrl(method) {
    return `https://api.telegram.org/bot${this.config.token}/${method}`;
  }

  async api(method, body, { timeoutMs = 60000 } = {}) {
    const res = await fetch(this.apiUrl(method), {
      method: 'POST',
      headers: body instanceof FormData ? undefined : { 'content-type': 'application/json' },
      body: body instanceof FormData ? body : JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(`Telegram ${method} 失败: ${data.description || res.status}`);
    }
    return data.result;
  }

  async start() {
    if (!this.config.enabled) {
      this.logger.info('Telegram 通道未启用');
      return;
    }
    if (!this.config.token) {
      this.updateStatus({ online: false, lastError: '未配置 Bot Token' });
      this.logger.warn('Telegram 未配置 Bot Token');
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    try {
      const me = await this.api('getMe', {});
      this.botId = me.id;
      this.botUsername = me.username || '';
      this.updateStatus({ online: true, botUsername: this.botUsername, lastError: '' });
      this.logger.info(`Telegram Bot 已连接: @${this.botUsername}`);
      this.pollLoop();
    } catch (error) {
      this.updateStatus({ online: false, lastError: error.message });
      this.logger.error(`Telegram 启动失败: ${error.message}`);
    }
  }

  stop() {
    this.running = false;
    if (this.abort) this.abort.abort();
    this.abort = null;
    this.updateStatus({ online: false });
  }

  async pollLoop() {
    while (this.running) {
      try {
        const result = await this.api('getUpdates', {
          offset: this.offset,
          timeout: 50,
          allowed_updates: ['message', 'edited_message']
        }, { timeoutMs: 65000 });
        for (const update of result || []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const message = parseTelegramUpdate(update, { botUsername: this.botUsername, botId: this.botId });
          if (message) {
            message.attachments = [];
            await this.downloadAttachments(message);
            this.onMessage(message);
          }
        }
      } catch (error) {
        if (!this.running) break;
        this.updateStatus({ online: false, lastError: error.message });
        this.logger.warn(`Telegram 轮询失败: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  async downloadAttachments(message) {
    const items = [
      ...(message.images || []).map((item) => ({ ...item, kind: 'image' })),
      ...(message.files || []).map((item) => ({ ...item, kind: 'file' }))
    ];
    for (const item of items.slice(0, 3)) {
      try {
        const file = await this.api('getFile', { file_id: item.fileId });
        const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) continue;
        const buffer = Buffer.from(await res.arrayBuffer());
        const dir = path.join(this.getConfig().server?.dataDir || '', 'tmp');
        // The app's data dir is resolved by config.mjs; keep downloads in the OS temp
        // directory and let the core logger record the path.
        const target = path.join(process.env.CAPTAIN_TMP || path.join(process.cwd(), 'data', 'tmp'), `tg-${crypto.randomBytes(4).toString('hex')}-${item.name || 'file'}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);
        message.attachments.push({ kind: item.kind, path: target, name: item.name || path.basename(target) });
      } catch (error) {
        this.logger.warn(`Telegram 下载附件失败: ${error.message}`);
      }
    }
  }

  async sendText(target, text) {
    return this.api('sendMessage', {
      chat_id: target.chatId,
      text: String(text),
      disable_web_page_preview: true
    });
  }

  async sendPhoto(target, filePath, caption = '') {
    const form = new FormData();
    form.append('chat_id', String(target.chatId));
    if (caption) form.append('caption', String(caption).slice(0, 1024));
    form.append('photo', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    return this.api('sendPhoto', form);
  }

  async sendDocument(target, filePath, caption = '') {
    const form = new FormData();
    form.append('chat_id', String(target.chatId));
    if (caption) form.append('caption', String(caption).slice(0, 1024));
    form.append('document', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    return this.api('sendDocument', form);
  }

  async sendAudio(target, filePath, caption = '') {
    const form = new FormData();
    form.append('chat_id', String(target.chatId));
    if (caption) form.append('caption', String(caption).slice(0, 1024));
    form.append('audio', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
    return this.api('sendAudio', form);
  }
}
