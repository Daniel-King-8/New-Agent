import { decryptSecret, getConfig } from './config.mjs';
import { teamForPrompt } from './team.mjs';

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function apiUrl(baseUrl, suffix) {
  const base = trimSlash(baseUrl);
  if (!base) throw new Error('Hermes baseUrl 为空');
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}${suffix}`;
  return `${base}/v1${suffix}`;
}

function responseText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  if (typeof data?.output_text === 'string') return data.output_text;
  if (typeof data?.response === 'string') return data.response;
  return '';
}

export class HermesClient {
  constructor({ logger } = {}) {
    this.logger = logger || console;
  }

  config() {
    return getConfig().hermes;
  }

  isConfigured() {
    const cfg = this.config();
    return Boolean(cfg.enabled && cfg.baseUrl);
  }

  headers(json = true) {
    const cfg = this.config();
    const headers = {};
    if (json) headers['content-type'] = 'application/json';
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    return headers;
  }

  async request(path, { method = 'GET', body, signal, timeoutMs } = {}) {
    const cfg = this.config();
    const url = `${trimSlash(cfg.baseUrl)}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal || AbortSignal.timeout(timeoutMs || cfg.timeoutMs || 300000)
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const message = typeof data === 'object' ? data?.error?.message || JSON.stringify(data) : String(data || '');
      const error = new Error(`Hermes HTTP ${res.status}: ${message.slice(0, 500)}`);
      error.statusCode = res.status;
      throw error;
    }
    return data;
  }

  async health() {
    const cfg = this.config();
    if (!cfg.baseUrl) return { ok: false, error: '未配置 Hermes baseUrl' };
    try {
      const started = Date.now();
      const data = await this.request('/health', { timeoutMs: 8000 });
      return { ok: true, ms: Date.now() - started, data };
    } catch (error) {
      try {
        const started = Date.now();
        const data = await this.request('/v1/models', { timeoutMs: 8000 });
        return { ok: true, ms: Date.now() - started, data, fallback: true };
      } catch {
        return { ok: false, error: error.message };
      }
    }
  }

  async models() {
    const data = await this.request('/v1/models', { timeoutMs: 15000 });
    const list = data?.data || data?.models || [];
    return list.map((item) => (typeof item === 'string' ? item : item.id || item.name)).filter(Boolean);
  }

  async chat({ messages, model, temperature = 0.3, maxTokens = 4096, conversation, metadata }) {
    const cfg = this.config();
    if (!cfg.baseUrl) throw new Error('Hermes 未配置');
    const body = {
      model: model || cfg.captainProfile || 'captain',
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false
    };
    if (conversation) body.conversation = conversation;
    if (metadata) body.metadata = metadata;
    const started = Date.now();
    const data = await this.request('/v1/chat/completions', { method: 'POST', body });
    return {
      text: responseText(data),
      usage: data?.usage || null,
      raw: data,
      ms: Date.now() - started
    };
  }

  async createRun({ input, model, conversation, metadata }) {
    const cfg = this.config();
    if (!cfg.baseUrl) throw new Error('Hermes 未配置');
    const body = {
      model: model || cfg.captainProfile || 'captain',
      input,
      metadata: metadata || {}
    };
    if (conversation) body.conversation = conversation;
    const data = await this.request('/v1/runs', { method: 'POST', body });
    const runId = data?.id || data?.run_id || data?.runId || data?.run?.id;
    if (!runId) throw new Error(`Hermes /v1/runs 返回中没有 run id: ${JSON.stringify(data).slice(0, 300)}`);
    return { runId, raw: data };
  }

  async getRun(runId) {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  async streamRun(runId, onEvent, { signal } = {}) {
    const cfg = this.config();
    const url = `${trimSlash(cfg.baseUrl)}/v1/runs/${encodeURIComponent(runId)}/events`;
    const res = await fetch(url, {
      headers: {
        ...this.headers(false),
        accept: 'text/event-stream'
      },
      signal: signal || AbortSignal.timeout(cfg.timeoutMs || 300000)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hermes events HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.body) throw new Error('Hermes events 响应没有 body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const split = buffer.indexOf('\n\n');
        if (split < 0) break;
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let event = 'message';
        const dataLines = [];
        for (const line of chunk.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        const raw = dataLines.join('\n');
        let data = raw;
        try {
          data = JSON.parse(raw);
        } catch {
          // keep string
        }
        onEvent({ event, data });
      }
    }
    return { ok: true };
  }

  async waitForRun(runId, { onEvent, timeoutMs } = {}) {
    const cfg = this.config();
    const started = Date.now();
    const limit = timeoutMs || cfg.timeoutMs || 300000;
    let final = null;
    await this.streamRun(
      runId,
      ({ event, data }) => {
        if (onEvent) onEvent({ event, data });
        if (event === 'run.completed' || event === 'completed' || event === 'response.completed' || event === 'run.failed' || event === 'failed' || event === 'error') {
          final = { event, data };
        }
      },
      { signal: AbortSignal.timeout(limit) }
    );
    if (final) return final;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const run = await this.getRun(runId);
      const status = run?.status || run?.state;
      if (['completed', 'failed', 'cancelled', 'canceled', 'error'].includes(String(status))) {
        return { event: `run.${status}`, data: run };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { event: 'timeout', data: { runId, elapsedMs: Date.now() - started } };
  }

  bridgeConfigured() {
    const cfg = this.config();
    return Boolean(cfg.bridgeUrl && cfg.bridgeToken);
  }

  async bridgeRequest(path, { method = 'GET', body } = {}) {
    const cfg = this.config();
    if (!cfg.bridgeUrl) throw new Error('Hermes Dashboard 地址未配置');
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cfg.bridgeToken) {
      headers.authorization = `Bearer ${cfg.bridgeToken}`;
      headers['x-bridge-token'] = cfg.bridgeToken;
    }
    const res = await fetch(`${trimSlash(cfg.bridgeUrl)}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const error = new Error(`Hermes Dashboard HTTP ${res.status}: ${String(text).slice(0, 500)}`);
      error.statusCode = res.status;
      throw error;
    }
    return data;
  }

  async listProfiles() {
    const data = await this.bridgeRequest('/api/profiles');
    return data?.profiles || data || [];
  }

  async createProfile(profile) {
    return this.bridgeRequest('/api/profiles', { method: 'POST', body: profile });
  }

  async updateProfileModel(name, { provider, model }) {
    return this.bridgeRequest(`/api/profiles/${encodeURIComponent(name)}/model`, {
      method: 'PUT',
      body: { provider, model }
    });
  }

  async updateProfileSoul(name, content) {
    return this.bridgeRequest(`/api/profiles/${encodeURIComponent(name)}/soul`, {
      method: 'PUT',
      body: { content }
    });
  }

  async deleteProfile(name) {
    return this.bridgeRequest(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  async setProfileEnv(name, key, value) {
    return this.bridgeRequest(`/api/env?profile=${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: { key, value }
    });
  }

  async listKanban(limit = 50) {
    const data = await this.bridgeRequest('/api/plugins/kanban/board');
    const tasks = data?.tasks || data?.columns || data || [];
    if (Array.isArray(tasks)) return tasks.slice(0, limit);
    return data;
  }

  getKanban(id) {
    return this.bridgeRequest(`/api/plugins/kanban/tasks/${encodeURIComponent(id)}`);
  }

  createKanban(task) {
    return this.bridgeRequest('/api/plugins/kanban/tasks', { method: 'POST', body: task });
  }

  providerForAgent(agent) {
    const provider = String(agent?.provider || '').toLowerCase();
    const baseUrl = String(agent?.baseUrl || '').toLowerCase();
    if (provider.includes('anthropic') || baseUrl.includes('anthropic')) {
      return { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' };
    }
    if (provider.includes('deepseek') || baseUrl.includes('deepseek')) {
      return { provider: 'deepseek', envKey: 'DEEPSEEK_API_KEY' };
    }
    if (provider.includes('moonshot') || provider.includes('kimi') || baseUrl.includes('moonshot')) {
      return { provider: 'moonshot', envKey: 'MOONSHOT_API_KEY' };
    }
    if (provider.includes('doubao') || baseUrl.includes('ark.cn-beijing')) {
      return { provider: 'doubao', envKey: 'ARK_API_KEY' };
    }
    if (baseUrl.includes('openai.com')) {
      return { provider: 'openai', envKey: 'OPENAI_API_KEY' };
    }
    return { provider: 'openai', envKey: 'OPENAI_API_KEY', customBaseUrl: agent?.baseUrl || '' };
  }

  /**
   * Create/update the matching Hermes profile for an agent. The Hermes Dashboard
   * API is used (HERMES_DASHBOARD_SESSION_TOKEN), so no shell access is needed.
   * Image/TTS workers are not Hermes profiles; they are handled by the Node
   * worker layer and are intentionally skipped here.
   */
  async syncAgentProfile(agent) {
    if (!this.bridgeConfigured()) return { skipped: true, reason: 'dashboard 未配置' };
    if (!agent || !['llm', 'code'].includes(agent.kind)) {
      return { skipped: true, reason: '该执行类型不是 Hermes LLM profile' };
    }
    const mapping = this.providerForAgent(agent);
    const profileName = agent.hermesProfile || (agent.id === 'captain' ? (this.config().captainProfile || 'captain') : `agent-${agent.id}`);
    const payload = {
      name: profileName,
      provider: mapping.provider,
      model: agent.model,
      soul: agent.systemPrompt || '',
      description: `${agent.name}${agent.tags?.length ? ` · ${agent.tags.join('/')}` : ''}`,
      clone_from_default: false,
      no_skills: false
    };
    let created = false;
    try {
      await this.createProfile(payload);
      created = true;
    } catch (error) {
      if (![400, 409].includes(error.statusCode)) throw error;
      await this.updateProfileModel(profileName, { provider: mapping.provider, model: agent.model });
      if (agent.systemPrompt) await this.updateProfileSoul(profileName, agent.systemPrompt);
    }
    const key = decryptSecret(agent.apiKey || '');
    if (key) {
      await this.setProfileEnv(profileName, mapping.envKey, key);
      if (mapping.customBaseUrl) {
        await this.setProfileEnv(profileName, 'OPENAI_BASE_URL', mapping.customBaseUrl);
      }
    }
    return { ok: true, profile: profileName, created, provider: mapping.provider };
  }

  async deleteAgentProfile(agent) {
    if (!this.bridgeConfigured() || !agent) return { skipped: true };
    if (!['llm', 'code'].includes(agent.kind)) return { skipped: true };
    const name = agent.hermesProfile || (agent.id === 'captain' ? (this.config().captainProfile || 'captain') : `agent-${agent.id}`);
    try {
      await this.deleteProfile(name);
      return { ok: true, profile: name };
    } catch (error) {
      if (error.statusCode === 404) return { ok: true, profile: name, missing: true };
      throw error;
    }
  }

  async captainMessages({ text, history = [], channel = 'web', chatId = 'admin' }) {
    const system = buildCaptainPrompt();
    const messages = [{ role: 'system', content: system }];
    for (const item of history.slice(-30)) {
      if (item.role === 'user' || item.role === 'assistant') {
        messages.push({ role: item.role, content: item.content });
      }
    }
    messages.push({
      role: 'user',
      content: `[入口=${channel} 会话=${chatId}]\n${text}`
    });
    return messages;
  }

  async talkToCaptain({ text, history, channel, chatId, metadata }) {
    const messages = await this.captainMessages({ text, history, channel, chatId });
    return this.chat({
      messages,
      model: this.config().captainProfile || 'captain',
      metadata
    });
  }
}

export function buildCaptainPrompt() {
  return [
    '你是「队长」——一个多 Agent 团队的主管。',
    '',
    '你的职责：',
    '1. 理解用户的一句话需求，拆解成可执行任务。',
    '2. 根据员工的能力标签派活：生图只能派给「生图」员工，语音只能派给「语音」员工，编程派给「编程」员工。',
    '3. 需要并行且有依赖时，使用 Kanban：先建父任务，再把子任务链接到父任务；需要评审时用 review 状态。',
    '4. 验收每个员工的产出；不合格可以要求重做或换人。',
    '5. 只把最终结果汇报给用户；中间过程默认不刷屏。',
    '6. 缺失信息（例如成品交付方式、缺少某类员工）时，直接问用户，不要猜。',
    '7. 如果用户提供了新的 API Key，说明该 Key 已在网关层安全接收，你只根据用户说明创建/更新员工，不要索取或复述 Key。',
    '',
    '当前团队：',
    teamForPrompt(),
    '',
    '规则：',
    '- 不要给文本模型打「生图」「语音」标签，也不要让它执行不具备的能力。',
    '- 没有对应标签的员工时，先告诉用户缺什么能力，并询问是否提供对应 API。',
    '- 任务有依赖时，明确写出上游产物如何交给下游（文件路径/附件）。',
    '- 汇报用户时使用用户的语言，简洁、直接、只给结果和必要说明。'
  ].join('\n');
}

export function createHermesClient(logger) {
  return new HermesClient({ logger });
}
