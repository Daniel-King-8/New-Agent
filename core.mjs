import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CONVERSATIONS_FILE,
  PENDING_SECRETS_FILE,
  RUNS_DIR,
  TMP_DIR,
  decryptSecret,
  encryptSecret,
  getConfig,
  readJson,
  reloadConfig,
  writeJsonAtomic
} from './config.mjs';
import { createHermesClient } from './hermes.mjs';
import { runOrchestration } from './orchestrator.mjs';
import {
  KIND_LABELS,
  createAgent,
  deleteAgent,
  getAgentInternal,
  listInternalAgents,
  publicAgent,
  validateAgentInput,
  warningsFor
} from './team.mjs';
import { extractSecrets } from './secrets.mjs';
import { QQChannel } from './channels/qq.mjs';
import { TelegramChannel } from './channels/telegram.mjs';
import { FeishuChannel } from './channels/feishu.mjs';

const HELP_TEXT = [
  '团队命令：',
  '/agents — 查看当前团队',
  '/addagent name=画师 kind=image provider=doubao model=doubao-seedream tags=生图,海报 — 新增员工（API Key 先单独发）',
  '/delagent <员工id> — 申请删除员工（需要二次确认）',
  '/confirm — 确认删除',
  '/help — 显示帮助',
  '',
  '也可以直接说：「这是豆包的 API，帮我建一个生图员工，模型 xxx，标签生图」。'
].join('\n');

const PROVIDER_PRESETS = {
  deepseek: { provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com' },
  doubao: { provider: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  ark: { provider: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  claude: { provider: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  anthropic: { provider: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  openai: { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1' },
  moonshot: { provider: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1' },
  kimi: { provider: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1' },
  'edge-tts': { provider: 'edge-tts', baseUrl: '' },
  edge: { provider: 'edge-tts', baseUrl: '' }
};

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix = 'run') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function inferKind(text) {
  const value = String(text || '').toLowerCase();
  if (/生图|出图|画师|图片|海报|插画|绘图|image|配图/.test(value)) return 'image';
  if (/语音|配音|朗读|声音|tts|播客|音频/.test(value)) return 'tts';
  if (/编程|代码|程序员|开发|前端|后端|code|debug|测试/.test(value)) return 'code';
  if (/转写|听写|语音识别|asr/.test(value)) return 'asr';
  if (/视频|剪辑|video/.test(value)) return 'video';
  return 'llm';
}

function inferProvider(text) {
  const value = String(text || '').toLowerCase();
  if (/豆包|doubao|火山|ark|seedream|seedance/.test(value)) return { ...PROVIDER_PRESETS.doubao, name: 'doubao' };
  if (/claude|anthropic/.test(value)) return { ...PROVIDER_PRESETS.anthropic, name: 'anthropic' };
  if (/deepseek|深度求索/.test(value)) return { ...PROVIDER_PRESETS.deepseek, name: 'deepseek' };
  if (/moonshot|kimi/.test(value)) return { ...PROVIDER_PRESETS.kimi, name: 'kimi' };
  if (/openai|chatgpt/.test(value)) return { ...PROVIDER_PRESETS.openai, name: 'openai' };
  if (/edge[- ]?tts/.test(value)) return { ...PROVIDER_PRESETS['edge-tts'], name: 'edge-tts' };
  return { provider: 'openai-compatible', baseUrl: '', name: '' };
}

function inferModel(text) {
  const value = String(text || '');
  const match = value.match(/(?:model|模型)\s*[:：=]\s*([A-Za-z0-9._/:-]+)/i);
  return match ? match[1] : '';
}

function inferTags(text, kind) {
  const value = String(text || '');
  const match = value.match(/标签\s*[:：=]?\s*([^\n。；;]+)/);
  if (match) {
    return match[1].split(/[,，、\s]+/).map((tag) => tag.trim()).filter(Boolean);
  }
  return (kind === 'image' ? ['生图'] : kind === 'tts' ? ['语音'] : kind === 'code' ? ['编程'] : ['文本']);
}

function inferName(text, kind) {
  const value = String(text || '');
  const match = value.match(/(?:名字|名称|叫|名为)\s*[:：=]?\s*([A-Za-z0-9一-龥_-]{2,20})/);
  if (match) return match[1];
  const label = { image: '画师', tts: '配音员', code: '程序员', asr: '听写员', video: '剪辑师', llm: '助理' }[kind] || '员工';
  return `豆包${label}`;
}

function parseArgs(text) {
  const out = {};
  const tokens = String(text || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  for (const token of tokens) {
    const match = token.match(/^([A-Za-z][A-Za-z0-9_-]*)[=:](.*)$/);
    if (!match) continue;
    out[match[1].toLowerCase()] = match[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export class CaptainCore {
  constructor({ logger }) {
    this.logger = logger;
    this.hermes = createHermesClient(logger);
    this.channels = {};
    this.startedAt = 0;
    this.rate = new Map();
    this.pendingDeletes = new Map();
    this.conversations = readJson(CONVERSATIONS_FILE, {});
    this.pendingSecrets = readJson(PENDING_SECRETS_FILE, {});
  }

  async start() {
    const cfg = getConfig();
    this.startedAt = Date.now();
    this.logger.info('Captain core 启动');
    this.channels.qq = new QQChannel({ getConfig, logger: this.logger, onMessage: (msg) => this.handleMessage(msg).catch((error) => this.logger.error('QQ 消息处理失败', error.message)) });
    this.channels.telegram = new TelegramChannel({ getConfig, logger: this.logger, onMessage: (msg) => this.handleMessage(msg).catch((error) => this.logger.error('Telegram 消息处理失败', error.message)) });
    this.channels.feishu = new FeishuChannel({ getConfig, logger: this.logger, onMessage: (msg) => this.handleMessage(msg).catch((error) => this.logger.error('飞书消息处理失败', error.message)) });

    if (cfg.channels.qq.enabled) this.channels.qq.start();
    if (cfg.channels.telegram.enabled) await this.channels.telegram.start();
    if (cfg.channels.feishu.enabled) await this.channels.feishu.start();
  }

  async stop() {
    for (const channel of Object.values(this.channels)) {
      try {
        channel.stop();
      } catch {
        // ignore
      }
    }
    this.channels = {};
  }

  async reload() {
    reloadConfig();
    await this.stop();
    await this.start();
    this.logger.info('配置已重新加载');
  }

  async syncAgentProfileById(id) {
    try {
      const agent = getAgentInternal(id);
      if (!agent) return;
      const result = await this.hermes.syncAgentProfile(agent);
      if (result?.ok) this.logger.info(`Hermes profile 已同步: ${result.profile}`);
      else if (result?.reason) this.logger.info(`跳过 Hermes profile 同步: ${result.reason}`);
    } catch (error) {
      this.logger.warn(`Hermes profile 同步失败 (${id}): ${error.message}`);
    }
  }

  getChannel(name) {
    return this.channels[name] || null;
  }

  isOwner(channelName, userId) {
    const cfg = getConfig();
    const channel = cfg.channels[channelName];
    return Boolean(channel && (channel.owners || []).map(String).includes(String(userId)));
  }

  isAllowed(channelName, msg) {
    const cfg = getConfig();
    const channel = cfg.channels[channelName];
    if (!channel || channel.enabled !== true) return false;
    const owners = (channel.owners || []).map(String);
    const userId = String(msg.userId);
    if (owners.includes(userId)) return true;
    if (msg.chatType === 'private') {
      return (channel.allowUsers || []).map(String).includes(userId);
    }
    const groups = (channel.allowGroups || channel.allowChats || []).map(String);
    if (!groups.includes(String(msg.chatId))) return false;
    const trigger = channel.groupTrigger || 'mention';
    if (trigger === 'mention') return msg.mentioned === true;
    if (trigger === 'prefix') {
      const prefix = channel.commandPrefix || '/';
      return String(msg.text || '').trim().startsWith(prefix);
    }
    return true;
  }

  checkRate(msg) {
    const key = `${msg.channel}:${msg.chatId}:${msg.userId}`;
    const now = Date.now();
    const list = (this.rate.get(key) || []).filter((time) => now - time < 60000);
    if (list.length >= 20) return false;
    list.push(now);
    this.rate.set(key, list);
    return true;
  }

  conversationKey(msg) {
    return `${msg.channel}:${msg.chatId}`;
  }

  getHistory(msg) {
    const key = this.conversationKey(msg);
    return Array.isArray(this.conversations[key]) ? this.conversations[key] : [];
  }

  appendHistory(msg, role, content) {
    const key = this.conversationKey(msg);
    const cfg = getConfig();
    const list = this.conversations[key] || [];
    list.push({ role, content: String(content || ''), at: nowIso() });
    this.conversations[key] = list.slice(-cfg.orchestration.maxHistory);
    writeJsonAtomic(CONVERSATIONS_FILE, this.conversations);
  }

  async sendReply(msg, text) {
    if (msg.channel === 'web') return { ok: true, text };
    const channel = this.getChannel(msg.channel);
    if (!channel) throw new Error(`通道未启用: ${msg.channel}`);
    return channel.sendText({ chatType: msg.chatType, chatId: msg.chatId }, text);
  }

  async handleMessage(msg) {
    const cfg = getConfig();
    const channelCfg = cfg.channels[msg.channel];
    if (!channelCfg?.enabled) return;
    if (!this.isAllowed(msg.channel, msg)) {
      this.logger.debug(`[${msg.channel}] 非白名单消息已忽略 user=${msg.userId} chat=${msg.chatId}`);
      return;
    }
    if (!this.checkRate(msg)) {
      await this.sendReply(msg, '消息太频繁了，请稍后再试。');
      return;
    }

    const { redacted, found } = extractSecrets(msg.text || '');
    if (found.length) {
      msg.text = redacted;
      this.storePendingSecrets(msg, found);
      const result = await this.handleAgentIntent(msg, found);
      if (result) {
        await this.sendReply(msg, result);
      } else {
        await this.sendReply(
          msg,
          `已安全接收 ${found.length} 个密钥（不会发送给模型，已加密保存）。请告诉我要创建什么员工：服务商、模型、用途/标签；也可以直接用 /addagent 命令。`
        );
      }
      return;
    }

    if (await this.handleDeleteCommand(msg)) return;
    if (await this.handleTeamCommand(msg)) return;
    if (await this.handleConfirmation(msg)) return;

    await this.talkToCaptain(msg);
  }

  storePendingSecrets(msg, found) {
    const key = `${msg.channel}:${msg.chatId}:${msg.userId}`;
    this.pendingSecrets[key] = {
      secrets: found.map((item) => ({ enc: encryptSecret(item.value), kind: item.kind })),
      at: nowIso()
    };
    // Clean entries older than 30 minutes.
    for (const [entryKey, entry] of Object.entries(this.pendingSecrets)) {
      if (Date.now() - Date.parse(entry.at) > 30 * 60000) delete this.pendingSecrets[entryKey];
    }
    writeJsonAtomic(PENDING_SECRETS_FILE, this.pendingSecrets);
  }

  takePendingSecret(msg) {
    const key = `${msg.channel}:${msg.chatId}:${msg.userId}`;
    const entry = this.pendingSecrets[key];
    if (!entry) return '';
    delete this.pendingSecrets[key];
    writeJsonAtomic(PENDING_SECRETS_FILE, this.pendingSecrets);
    return decryptSecret(entry.secrets[0]?.enc || '');
  }

  async handleAgentIntent(msg, found) {
    const text = String(msg.text || '');
    if (!/新增|创建|添加|建一个|给我建|帮我建|addagent|agent/i.test(text)) return '';
    if (!this.isOwner(msg.channel, msg.userId) && msg.channel !== 'web') {
      return '只有老板账号可以管理团队。';
    }
    const kind = inferKind(text);
    const providerInfo = inferProvider(text);
    const model = inferModel(text);
    const tags = inferTags(text, kind);
    const name = inferName(text, kind);
    const key = this.takePendingSecret(msg);
    if (!key) return '我还没有拿到 API Key。请把 Key 直接发给我，或先在后台添加。';
    if (!model) {
      return `已收到 Key。请问模型名是什么？例如：/addagent name=${name} kind=${kind} provider=${providerInfo.name || providerInfo.provider} model=你的模型名 tags=${tags.join(',')}`;
    }
    const provider = providerInfo.provider;
    const baseUrl = providerInfo.baseUrl;
    if (!baseUrl) {
      return `已收到 Key，但不确定 base_url。请用 /addagent 命令补全，例如：/addagent name=${name} kind=${kind} provider=${provider} model=${model} tags=${tags.join(',')} baseUrl=...`;
    }
    const result = createAgent({
      name,
      kind,
      provider,
      baseUrl,
      model,
      apiKey: key,
      tags,
      systemPrompt: `你是团队里的${KIND_LABELS[kind] || kind}员工，专门负责${tags.join('、')}相关任务。只输出任务结果，不闲聊。`
    });
    this.syncAgentProfileById(result.agent.id).catch(() => {});
    return [
      `已创建员工「${result.agent.name}」（id=${result.agent.id}，类型=${KIND_LABELS[result.agent.kind]}，标签=${result.agent.tags.join('、')}，模型=${result.agent.model}）。`,
      ...(result.warnings.length ? ['注意：', ...result.warnings.map((item) => `- ${item}`)] : []),
      'API Key 已加密保存，模型不会看到明文。'
    ].join('\n');
  }

  async handleTeamCommand(msg) {
    const text = String(msg.text || '').trim();
    const cfg = getConfig();
    const prefix = cfg.channels[msg.channel]?.commandPrefix || '/';
    if (!text.startsWith(prefix)) return false;
    const [command, ...rest] = text.slice(prefix.length).split(/\s+/);
    const args = parseArgs(rest.join(' '));
    if (command === 'help') {
      await this.sendReply(msg, HELP_TEXT);
      return true;
    }
    if (command === 'agents') {
      const team = listInternalAgents().map((agent) => `- ${agent.name} | id=${agent.id} | ${KIND_LABELS[agent.kind]} | ${agent.tags.join('、') || '无标签'} | ${agent.enabled ? '启用' : '停用'}`);
      await this.sendReply(msg, team.join('\n'));
      return true;
    }
    if (command === 'addagent') {
      if (!this.isOwner(msg.channel, msg.userId) && msg.channel !== 'web') {
        await this.sendReply(msg, '只有老板账号可以新增员工。');
        return true;
      }
      const kind = args.kind || inferKind(text);
      const providerInfo = inferProvider(`${args.provider || ''} ${text}`);
      const key = this.takePendingSecret(msg);
      const agentInput = {
        name: args.name || inferName(text, kind),
        kind,
        provider: args.provider || providerInfo.provider,
        baseUrl: args.baseurl || args.base_url || providerInfo.baseUrl,
        model: args.model || '',
        apiKey: key,
        tags: (args.tags || '').split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean),
        systemPrompt: args.prompt || `你是团队里的${KIND_LABELS[kind] || kind}员工，专门负责${(args.tags || '').split(/[,，、]/).join('、')}相关任务。只输出任务结果，不闲聊。`
      };
      const errors = validateAgentInput(agentInput);
      if (errors.length) {
        await this.sendReply(msg, `参数不完整：${errors.join('；')}\n用法：/addagent name=画师 kind=image provider=doubao model=xxx tags=生图 baseUrl=xxx`);
        return true;
      }
      if (!agentInput.apiKey) {
        await this.sendReply(msg, '缺少 API Key。请先把 Key 单独发给我，再执行 /addagent。');
        return true;
      }
      const result = createAgent(agentInput);
      this.syncAgentProfileById(result.agent.id).catch(() => {});
      await this.sendReply(msg, `已创建员工「${result.agent.name}」（id=${result.agent.id}）。${result.warnings.length ? `\n警告：${result.warnings.join('；')}` : ''}`);
      return true;
    }
    if (command === 'delagent') {
      if (!this.isOwner(msg.channel, msg.userId) && msg.channel !== 'web') {
        await this.sendReply(msg, '只有老板账号可以删除员工。');
        return true;
      }
      const id = args.id || rest[0];
      const agent = id ? getAgentInternal(id) : null;
      if (!agent) {
        await this.sendReply(msg, '员工不存在。用 /agents 查看 id。');
        return true;
      }
      this.pendingDeletes.set(`${msg.channel}:${msg.chatId}:${msg.userId}`, { id: agent.id, name: agent.name, at: nowIso() });
      await this.sendReply(msg, `确认删除员工「${agent.name}」（id=${agent.id}）？回复「确认删除」或 /confirm。`);
      return true;
    }
    if (command === 'confirm') {
      await this.handleConfirmation(msg);
      return true;
    }
    return false;
  }

  async handleDeleteCommand(msg) {
    const text = String(msg.text || '').trim();
    const match = text.match(/^(?:删除|删掉|移除)(?:员工|agent)?\s*[「"]?([A-Za-z0-9一-龥_-]+)[」"]?$/i);
    if (!match) return false;
    if (!this.isOwner(msg.channel, msg.userId) && msg.channel !== 'web') {
      await this.sendReply(msg, '只有老板账号可以删除员工。');
      return true;
    }
    const agent = getAgentInternal(match[1]);
    if (!agent) {
      await this.sendReply(msg, '员工不存在。用 /agents 查看 id。');
      return true;
    }
    this.pendingDeletes.set(`${msg.channel}:${msg.chatId}:${msg.userId}`, { id: agent.id, name: agent.name, at: nowIso() });
    await this.sendReply(msg, `确认删除员工「${agent.name}」（id=${agent.id}）？回复「确认删除」或 /confirm。`);
    return true;
  }

  async handleConfirmation(msg) {
    const text = String(msg.text || '').trim();
    if (!/^(确认删除|确认|confirm)$/i.test(text)) return false;
    const key = `${msg.channel}:${msg.chatId}:${msg.userId}`;
    const pending = this.pendingDeletes.get(key);
    if (!pending) {
      await this.sendReply(msg, '没有待确认的删除操作。');
      return true;
    }
    if (Date.now() - Date.parse(pending.at) > 10 * 60000) {
      this.pendingDeletes.delete(key);
      await this.sendReply(msg, '确认已过期，请重新发起删除。');
      return true;
    }
    this.pendingDeletes.delete(key);
    try {
      const removed = deleteAgent(pending.id);
      this.hermes.deleteAgentProfile(removed).catch((error) => this.logger.warn(`删除 Hermes profile 失败: ${error.message}`));
      await this.sendReply(msg, `已删除员工「${removed.name}」。`);
    } catch (error) {
      await this.sendReply(msg, `删除失败：${error.message}`);
    }
    return true;
  }

  async talkToCaptain(msg) {
    const cfg = getConfig();
    const run = this.createRun(msg);
    this.appendHistory(msg, 'user', msg.text);
    const history = this.getHistory(msg).slice(0, -1);
    const captain = getAgentInternal('captain');
    const engine = cfg.orchestration.engine || 'native';
    const useHermes = engine === 'hermes' || (engine === 'auto' && !captain?.apiKey);
    if (useHermes && !this.hermes.isConfigured()) {
      const reply = '主管还没有配置。请在后台填写主管的 API Key、base_url 和模型，或配置 Hermes 引擎。';
      this.finishRun(run, 'failed', reply, { error: '主管未配置' });
      this.appendHistory(msg, 'assistant', reply);
      await this.sendReply(msg, reply);
      return reply;
    }
    try {
      if (useHermes) {
        const result = await this.hermes.talkToCaptain({
          text: msg.text,
          history,
          channel: msg.channel,
          chatId: msg.chatId,
          metadata: { runId: run.id, userId: msg.userId, userName: msg.userName }
        });
        const reply = result.text || '主管没有返回内容。';
        this.finishRun(run, 'completed', reply, { usage: result.usage, ms: result.ms });
        this.appendHistory(msg, 'assistant', reply);
        await this.sendReply(msg, reply);
        return reply;
      }

      const runDir = path.join(RUNS_DIR, run.id);
      const result = await runOrchestration({
        text: msg.text,
        history,
        runDir,
        logger: this.logger,
        onEvent: (event) => this.updateRunEvent(run.id, event)
      });
      const reply = result.reply || '主管没有返回内容。';
      this.finishRun(run, 'completed', reply, {
        plan: result.plan,
        tasks: result.tasks,
        verification: result.verification,
        files: result.files
      });
      this.appendHistory(msg, 'assistant', reply);
      await this.sendReply(msg, reply);
      await this.sendArtifacts(msg, result.files);
      return reply;
    } catch (error) {
      const reply = `主管调用失败：${error.message}`;
      this.finishRun(run, 'failed', reply, { error: error.message });
      this.appendHistory(msg, 'assistant', reply);
      await this.sendReply(msg, reply);
      return reply;
    }
  }

  updateRunEvent(id, event) {
    const file = path.join(RUNS_DIR, `${id}.json`);
    const run = readJson(file, null);
    if (!run) return;
    run.events = [...(run.events || []), { at: nowIso(), ...event }].slice(-200);
    run.updatedAt = nowIso();
    writeJsonAtomic(file, run);
  }

  async sendArtifacts(msg, files) {
    if (msg.channel === 'web' || !files?.length) return;
    const channel = this.getChannel(msg.channel);
    if (!channel) return;
    const target = { chatType: msg.chatType, chatId: msg.chatId };
    for (const file of files) {
      try {
        const ext = path.extname(file).toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) && channel.sendImage) {
          await channel.sendImage(target, file);
        } else if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) {
          if (channel.sendAudio) await channel.sendAudio(target, file);
          else if (channel.sendRecord) await channel.sendRecord(target, file);
          else if (channel.sendFile) await channel.sendFile(target, file);
        } else if (channel.sendFile) {
          await channel.sendFile(target, file);
        }
      } catch (error) {
        this.logger.warn(`发送产物失败 ${file}: ${error.message}`);
      }
    }
  }

  async handleWebChat(text) {
    const msg = {
      channel: 'web',
      chatType: 'private',
      chatId: 'admin',
      userId: 'admin',
      userName: 'admin',
      text: String(text || ''),
      mentioned: true
    };
    if (!msg.text.trim()) throw new Error('消息为空');
    return this.talkToCaptain(msg);
  }

  createRun(msg) {
    const run = {
      id: newId(),
      channel: msg.channel,
      chatType: msg.chatType,
      chatId: String(msg.chatId),
      userId: String(msg.userId),
      userName: msg.userName || '',
      text: String(msg.text || ''),
      status: 'running',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      reply: '',
      error: '',
      usage: null,
      durationMs: 0
    };
    writeJsonAtomic(path.join(RUNS_DIR, `${run.id}.json`), run);
    return run;
  }

  finishRun(run, status, reply, extra = {}) {
    const updated = {
      ...run,
      ...extra,
      status,
      reply,
      updatedAt: nowIso(),
      durationMs: Date.now() - Date.parse(run.createdAt)
    };
    writeJsonAtomic(path.join(RUNS_DIR, `${run.id}.json`), updated);
    return updated;
  }

  listRuns(limit = 50) {
    try {
      return fs.readdirSync(RUNS_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => readJson(path.join(RUNS_DIR, name), null))
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  getRun(id) {
    return readJson(path.join(RUNS_DIR, `${id}.json`), null);
  }

  async getStatus() {
    const cfg = getConfig();
    const channelStatus = {};
    for (const [name, channel] of Object.entries(this.channels)) {
      channelStatus[name] = channel.getStatus ? channel.getStatus() : { online: false };
    }
    const hermesHealth = await this.hermes.health();
    const runs = this.listRuns(200);
    return {
      version: '0.1.0',
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      channels: channelStatus,
      hermes: hermesHealth,
      team: {
        captain: publicAgent(cfg.team.captain),
        agentCount: cfg.team.agents.length,
        enabledCount: cfg.team.agents.filter((agent) => agent.enabled).length
      },
      runs: {
        total: runs.length,
        running: runs.filter((run) => run.status === 'running').length,
        completed: runs.filter((run) => run.status === 'completed').length,
        failed: runs.filter((run) => run.status === 'failed').length
      },
      config: {
        qqEnabled: cfg.channels.qq.enabled,
        telegramEnabled: cfg.channels.telegram.enabled,
        feishuEnabled: cfg.channels.feishu.enabled
      }
    };
  }
}
