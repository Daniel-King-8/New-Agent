import fs from 'node:fs';
import crypto from 'node:crypto';
import WebSocket from 'ws';

export function parseQQEvent(event, configuredSelfId = 0) {
  if (!event || event.post_type !== 'message') return null;
  if (!['private', 'group'].includes(event.message_type)) return null;
  const selfId = event.self_id || configuredSelfId;
  if (String(event.user_id) === String(selfId)) return null;
  const userId = String(event.user_id || '');
  const groupId = event.group_id ? String(event.group_id) : '';
  if (!userId) return null;
  const segments = Array.isArray(event.message) ? event.message : [];
  const text = segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => segment.data?.text || '')
    .join('')
    .trim();
  const images = segments
    .filter((segment) => segment.type === 'image')
    .map((segment) => ({ url: segment.data?.url || '', file: segment.data?.file || '' }))
    .filter((image) => image.url || image.file);
  const mentioned = segments.some(
    (segment) => segment.type === 'at' && String(segment.data?.qq) === String(selfId)
  );
  return {
    channel: 'qq',
    chatType: event.message_type,
    chatId: groupId || userId,
    userId,
    userName: event.sender?.card || event.sender?.nickname || '',
    text,
    images,
    mentioned,
    messageId: String(event.message_id || ''),
    raw: event
  };
}

function targetParams(target) {
  return target.chatType === 'group'
    ? { group_id: Number(target.chatId) }
    : { user_id: Number(target.chatId) };
}

export class QQChannel {
  constructor({ getConfig, logger, onMessage }) {
    this.getConfig = getConfig;
    this.logger = logger;
    this.onMessage = onMessage;
    this.ws = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.backoffMs = 2000;
    this.pending = new Map();
    this.status = {
      online: false,
      selfId: 0,
      nickname: '',
      lastError: '',
      updatedAt: new Date().toISOString()
    };
  }

  get config() {
    return this.getConfig().channels.qq;
  }

  getStatus() {
    return { ...this.status, updatedAt: this.status.updatedAt || new Date().toISOString() };
  }

  updateStatus(patch) {
    this.status = { ...this.status, ...patch, updatedAt: new Date().toISOString() };
  }

  start() {
    if (!this.config.enabled) {
      this.logger.info('QQ 通道未启用');
      return;
    }
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.updateStatus({ online: false });
  }

  connect() {
    if (this.closed) return;
    const cfg = this.config;
    const headers = cfg.accessToken ? { authorization: `Bearer ${cfg.accessToken}` } : {};
    this.logger.info(`连接 NapCat: ${cfg.wsUrl}`);
    let ws;
    try {
      ws = new WebSocket(cfg.wsUrl, { headers });
    } catch (error) {
      this.updateStatus({ online: false, lastError: error.message });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', async () => {
      this.backoffMs = 2000;
      this.updateStatus({ online: true, lastError: '' });
      this.logger.info('NapCat 已连接');
      try {
        const info = await this.request('get_login_info', {}, 8000);
        const data = info?.data || {};
        if (data.user_id) {
          this.updateStatus({ selfId: data.user_id, nickname: data.nickname || '' });
          this.logger.info(`QQ 登录账号: ${data.nickname || ''} (${data.user_id})`);
        }
      } catch (error) {
        this.logger.warn(`获取 QQ 登录信息失败: ${error.message}`);
      }
    });

    ws.on('message', (buffer) => {
      let data;
      try {
        data = JSON.parse(buffer.toString());
      } catch {
        return;
      }
      if (data.echo && this.pending.has(data.echo)) {
        const pending = this.pending.get(data.echo);
        this.pending.delete(data.echo);
        clearTimeout(pending.timer);
        if (data.retcode && data.retcode !== 0) {
          pending.reject(new Error(data.message || `OneBot retcode ${data.retcode}`));
        } else {
          pending.resolve(data);
        }
        return;
      }
      if (data.post_type === 'message') {
        const message = parseQQEvent(data, this.status.selfId || this.config.selfId);
        if (message) this.onMessage(message);
      }
    });

    ws.on('close', (code, reason) => {
      this.updateStatus({ online: false, lastError: `连接关闭 ${code} ${reason || ''}`.trim() });
      this.logger.warn(`NapCat 连接关闭: ${code}`);
      this.scheduleReconnect();
    });

    ws.on('error', (error) => {
      this.updateStatus({ online: false, lastError: error.message });
      this.logger.error(`NapCat 连接错误: ${error.message}`);
    });
  }

  scheduleReconnect() {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(60000, this.backoffMs * 2);
    this.logger.info(`NapCat ${Math.round(delay / 1000)}s 后重连`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  request(action, params = {}, timeoutMs = 15000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('NapCat 未连接'));
    }
    const echo = `captain-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const payload = { action, params, echo };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot ${action} 超时`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(echo);
          reject(error);
        }
      });
    });
  }

  async sendText(target, text) {
    const action = target.chatType === 'group' ? 'send_group_msg' : 'send_private_msg';
    return this.request(action, {
      ...targetParams(target),
      message: [{ type: 'text', data: { text: String(text) } }]
    });
  }

  async sendImage(target, filePath) {
    const buffer = fs.readFileSync(filePath);
    const action = target.chatType === 'group' ? 'send_group_msg' : 'send_private_msg';
    return this.request(action, {
      ...targetParams(target),
      message: [{ type: 'image', data: { file: `base64://${buffer.toString('base64')}` } }]
    });
  }

  async sendRecord(target, filePath) {
    const buffer = fs.readFileSync(filePath);
    const action = target.chatType === 'group' ? 'send_group_msg' : 'send_private_msg';
    return this.request(action, {
      ...targetParams(target),
      message: [{ type: 'record', data: { file: `base64://${buffer.toString('base64')}` } }]
    });
  }

  async sendFile(target, filePath, name = 'file') {
    const buffer = fs.readFileSync(filePath);
    if (target.chatType === 'group') {
      return this.request('upload_group_file', {
        group_id: Number(target.chatId),
        file: `base64://${buffer.toString('base64')}`,
        name
      }, 60000);
    }
    return this.request('upload_private_file', {
      user_id: Number(target.chatId),
      file: `base64://${buffer.toString('base64')}`,
      name
    }, 60000);
  }
}
