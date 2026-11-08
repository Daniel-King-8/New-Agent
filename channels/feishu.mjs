import fs from 'node:fs';
import path from 'node:path';

export function parseFeishuMessage(data) {
  const message = data?.message;
  const sender = data?.sender;
  if (!message || !sender) return null;
  const chatType = message.chat_type === 'p2p' ? 'private' : 'group';
  const chatId = String(message.chat_id || '');
  const userId = String(sender.sender_id?.open_id || sender.sender_id?.user_id || '');
  if (!chatId || !userId) return null;
  let text = '';
  try {
    const content = JSON.parse(message.content || '{}');
    text = content.text || content.content || '';
    if (Array.isArray(content.content)) {
      text = content.content.map((row) => (Array.isArray(row) ? row.map((cell) => cell.text || '').join('') : '')).join('\n');
    }
  } catch {
    text = String(message.content || '');
  }
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  return {
    channel: 'feishu',
    chatType,
    chatId,
    userId,
    userName: sender.sender_id?.user_id || '',
    text: String(text || '').trim(),
    images: [],
    files: [],
    mentioned: mentions.length > 0,
    messageId: String(message.message_id || ''),
    raw: data
  };
}

export class FeishuChannel {
  constructor({ getConfig, logger, onMessage }) {
    this.getConfig = getConfig;
    this.logger = logger;
    this.onMessage = onMessage;
    this.wsClient = null;
    this.client = null;
    this.running = false;
    this.status = {
      online: false,
      appId: '',
      lastError: '',
      updatedAt: new Date().toISOString()
    };
  }

  get config() {
    return this.getConfig().channels.feishu;
  }

  getStatus() {
    return { ...this.status };
  }

  updateStatus(patch) {
    this.status = { ...this.status, ...patch, updatedAt: new Date().toISOString() };
  }

  async start() {
    if (!this.config.enabled) {
      this.logger.info('飞书通道未启用');
      return;
    }
    if (!this.config.appId || !this.config.appSecret) {
      this.updateStatus({ online: false, lastError: '未配置 App ID / App Secret' });
      return;
    }
    let Lark;
    try {
      Lark = await import('@larksuiteoapi/node-sdk');
    } catch (error) {
      this.updateStatus({ online: false, lastError: `飞书 SDK 未安装: ${error.message}` });
      this.logger.error(`飞书 SDK 加载失败: ${error.message}`);
      return;
    }
    try {
      this.client = new Lark.Client({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        appType: Lark.AppType?.SelfBuild
      });
      const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          const msg = parseFeishuMessage(data);
          if (msg) this.onMessage(msg);
          return { code: 0 };
        }
      });
      this.wsClient = new Lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        loggerLevel: Lark.LoggerLevel?.warn
      });
      this.running = true;
      await this.wsClient.start({ eventDispatcher: dispatcher });
      this.updateStatus({ online: true, appId: this.config.appId, lastError: '' });
      this.logger.info('飞书长连接已启动');
    } catch (error) {
      this.updateStatus({ online: false, lastError: error.message });
      this.logger.error(`飞书启动失败: ${error.message}`);
    }
  }

  stop() {
    this.running = false;
    try {
      this.wsClient?.close?.();
    } catch {
      // ignore
    }
    this.wsClient = null;
    this.updateStatus({ online: false });
  }

  async sendText(target, text) {
    if (!this.client) throw new Error('飞书未连接');
    const result = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: target.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: String(text) })
      }
    });
    return result;
  }

  async sendImage(target, filePath) {
    if (!this.client) throw new Error('飞书未连接');
    const upload = await this.client.im.image.create({
      data: {
        image_type: 'message',
        image: fs.createReadStream(filePath)
      }
    });
    const imageKey = upload?.image_key || upload?.data?.image_key;
    if (!imageKey) throw new Error('飞书图片上传失败');
    return this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: target.chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey })
      }
    });
  }

  async sendFile(target, filePath, name = path.basename(filePath)) {
    if (!this.client) throw new Error('飞书未连接');
    const upload = await this.client.im.file.create({
      data: {
        file_type: 'stream',
        file_name: name,
        file: fs.createReadStream(filePath)
      }
    });
    const fileKey = upload?.file_key || upload?.data?.file_key;
    if (!fileKey) throw new Error('飞书文件上传失败');
    return this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: target.chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey })
      }
    });
  }

  async sendAudio(target, filePath, name = path.basename(filePath)) {
    return this.sendFile(target, filePath, name);
  }
}
