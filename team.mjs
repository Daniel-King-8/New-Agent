import crypto from 'node:crypto';
import {
  decryptSecret,
  getConfig,
  normalizeAgent,
  saveConfig,
  slugify
} from './config.mjs';
import { maskValue } from './secrets.mjs';

export const KINDS = ['llm', 'code', 'image', 'tts', 'asr', 'video'];

export const KIND_LABELS = {
  llm: '文本 / 推理',
  code: '编程 / 代码执行',
  image: '生图',
  tts: '语音合成',
  asr: '语音识别',
  video: '视频'
};

export const KIND_TAGS = {
  llm: ['文本', '对话', '推理', '写作', '翻译', '研究', '总结', '分析'],
  code: ['编程', '代码', '调试', '测试', '审查', '部署', '前端', '后端'],
  image: ['生图', '图片', '海报', '表情包', '设计', '修图', '插画'],
  tts: ['语音', '配音', '朗读', '播客', '音乐', '声音'],
  asr: ['转写', '听写', '语音识别'],
  video: ['视频', '剪辑', '合成']
};

const TAG_TO_KINDS = new Map();
for (const [kind, tags] of Object.entries(KIND_TAGS)) {
  for (const tag of tags) {
    if (!TAG_TO_KINDS.has(tag)) TAG_TO_KINDS.set(tag, new Set());
    TAG_TO_KINDS.get(tag).add(kind);
  }
}

export function publicAgent(agent) {
  return {
    ...agent,
    apiKey: agent?.apiKey ? maskValue(decryptSecret(agent.apiKey)) : ''
  };
}

export function getTeam() {
  const cfg = getConfig();
  return {
    captain: publicAgent(cfg.team.captain),
    agents: cfg.team.agents.map(publicAgent),
    maxAgents: cfg.team.maxAgents
  };
}

export function getAgentInternal(id) {
  const cfg = getConfig();
  if (id === 'captain') return cfg.team.captain;
  return cfg.team.agents.find((agent) => agent.id === id) || null;
}

export function agentSecret(agent) {
  return decryptSecret(agent?.apiKey || '');
}

export function listInternalAgents() {
  const cfg = getConfig();
  return [cfg.team.captain, ...cfg.team.agents];
}

export function warningsFor(kind, tags) {
  const warnings = [];
  for (const tag of tags || []) {
    const owners = TAG_TO_KINDS.get(String(tag).trim());
    if (owners && !owners.has(kind)) {
      warnings.push(`标签「${tag}」通常属于 ${[...owners].map((k) => KIND_LABELS[k]).join(' / ')}，当前执行类型是「${KIND_LABELS[kind]}」，可能导致任务派错。`);
    }
  }
  return warnings;
}

export function validateAgentInput(input, { partial = false } = {}) {
  const errors = [];
  if (!partial || input.name !== undefined) {
    if (!String(input.name || '').trim()) errors.push('名称不能为空');
  }
  if (!partial || input.kind !== undefined) {
    if (!KINDS.includes(input.kind)) errors.push(`执行类型必须是：${KINDS.join(' / ')}`);
  }
  if (!partial || input.model !== undefined) {
    if (!String(input.model || '').trim()) errors.push('模型不能为空');
  }
  if (!partial || input.provider !== undefined) {
    if (!String(input.provider || '').trim()) errors.push('Provider 不能为空');
  }
  if (input.tags !== undefined && !Array.isArray(input.tags)) errors.push('tags 必须是数组');
  return errors;
}

export function createAgent(input) {
  const cfg = getConfig();
  const kind = KINDS.includes(input.kind) ? input.kind : 'llm';
  const errors = validateAgentInput({ ...input, kind });
  if (errors.length) {
    const error = new Error(errors.join('；'));
    error.statusCode = 400;
    throw error;
  }
  if (cfg.team.agents.length >= cfg.team.maxAgents) {
    const error = new Error(`员工数量已达到上限（${cfg.team.maxAgents}）`);
    error.statusCode = 400;
    throw error;
  }
  const baseId = input.id ? slugify(input.id) : `${slugify(input.name)}-${crypto.randomBytes(2).toString('hex')}`;
  let id = baseId;
  let seq = 1;
  while (id === 'captain' || cfg.team.agents.some((agent) => agent.id === id)) {
    id = `${baseId}-${seq++}`;
  }
  const agent = normalizeAgent({ ...input, id, kind });
  agent.hermesProfile = input.hermesProfile || `agent-${id}`;
  cfg.team.agents.push(agent);
  saveConfig({ team: { agents: cfg.team.agents } });
  return { agent: publicAgent(agent), warnings: warningsFor(agent.kind, agent.tags) };
}

export function updateAgent(id, patch) {
  if (id === 'captain') {
    return updateCaptain(patch);
  }
  const cfg = getConfig();
  const index = cfg.team.agents.findIndex((agent) => agent.id === id);
  if (index < 0) {
    const error = new Error('员工不存在');
    error.statusCode = 404;
    throw error;
  }
  const current = cfg.team.agents[index];
  const merged = {
    ...current,
    ...patch,
    id: current.id,
    apiKey: patch?.apiKey === undefined || patch?.apiKey?.includes?.('****')
      ? current.apiKey
      : patch.apiKey,
    tags: patch?.tags !== undefined ? patch.tags : current.tags,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString()
  };
  if (merged.kind !== current.kind && patch.kind === undefined) merged.kind = current.kind;
  const errors = validateAgentInput(merged, { partial: false });
  if (errors.length) {
    const error = new Error(errors.join('；'));
    error.statusCode = 400;
    throw error;
  }
  const normalized = normalizeAgent(merged, index);
  normalized.hermesProfile = merged.hermesProfile || current.hermesProfile || `agent-${id}`;
  cfg.team.agents[index] = normalized;
  saveConfig({ team: { agents: cfg.team.agents } });
  return { agent: publicAgent(normalized), warnings: warningsFor(normalized.kind, normalized.tags) };
}

export function updateCaptain(patch) {
  const cfg = getConfig();
  const current = cfg.team.captain;
  const merged = {
    ...current,
    ...patch,
    id: 'captain',
    kind: 'llm',
    apiKey: patch?.apiKey === undefined || patch?.apiKey?.includes?.('****')
      ? current.apiKey
      : patch.apiKey,
    tags: patch?.tags !== undefined ? patch.tags : current.tags
  };
  const normalized = normalizeAgent(merged, 0);
  normalized.id = 'captain';
  normalized.kind = 'llm';
  normalized.enabled = true;
  normalized.hermesProfile = patch?.hermesProfile || current.hermesProfile || 'captain';
  cfg.team.captain = normalized;
  saveConfig({ team: { captain: normalized } });
  return { agent: publicAgent(normalized), warnings: warningsFor(normalized.kind, normalized.tags) };
}

export function deleteAgent(id) {
  if (id === 'captain') {
    const error = new Error('主管不能删除');
    error.statusCode = 400;
    throw error;
  }
  const cfg = getConfig();
  const index = cfg.team.agents.findIndex((agent) => agent.id === id);
  if (index < 0) {
    const error = new Error('员工不存在');
    error.statusCode = 404;
    throw error;
  }
  const [removed] = cfg.team.agents.splice(index, 1);
  saveConfig({ team: { agents: cfg.team.agents } });
  return publicAgent(removed);
}

export function findAgentsByTags(tags) {
  const wanted = (tags || []).map((tag) => String(tag).trim()).filter(Boolean);
  return getConfig().team.agents.filter((agent) => {
    if (!agent.enabled) return false;
    if (!wanted.length) return true;
    return wanted.every((tag) => agent.tags.includes(tag));
  });
}

export function teamSummary() {
  const cfg = getConfig();
  const rows = [cfg.team.captain, ...cfg.team.agents].map((agent) => {
    const tags = agent.tags?.length ? agent.tags.join('、') : '无标签';
    return `- ${agent.name}（id=${agent.id}，类型=${KIND_LABELS[agent.kind] || agent.kind}，标签=${tags}，模型=${agent.model}）`;
  });
  return rows.join('\n');
}

export function teamForPrompt() {
  const cfg = getConfig();
  const captain = cfg.team.captain;
  const agents = cfg.team.agents.filter((agent) => agent.enabled);
  return [
    `主管：${captain.name}（模型 ${captain.model}，标签 ${captain.tags.join('、') || '无'}）`,
    '员工：',
    ...(agents.length
      ? agents.map((agent) => `- ${agent.name} | id=${agent.id} | 类型=${KIND_LABELS[agent.kind] || agent.kind} | 标签=${agent.tags.join('、') || '无'} | 模型=${agent.model}`)
      : ['- 暂无员工'])
  ].join('\n');
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

export async function testAgentConnection(agentInput) {
  const agent = normalizeAgent(agentInput);
  const key = decryptSecret(agent.apiKey || '') || agent.apiKey || '';
  if (!key) throw new Error('API Key 为空');
  if (!agent.baseUrl) throw new Error('base_url 为空');
  if (!agent.model) throw new Error('模型为空');

  if (agent.kind === 'llm' || agent.kind === 'code') {
    const baseUrl = normalizeBaseUrl(agent.baseUrl);
    const provider = String(agent.provider || '').toLowerCase();
    const started = Date.now();
    if (provider === 'anthropic' || baseUrl.includes('anthropic.com')) {
      const url = `${baseUrl}${baseUrl.endsWith('/v1') ? '' : '/v1'}/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: agent.model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }]
        }),
        signal: AbortSignal.timeout(30000)
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      return { ok: true, kind: agent.kind, provider: 'anthropic', ms: Date.now() - started, sample: text.slice(0, 200) };
    }
    const url = `${baseUrl}${baseUrl.endsWith('/chat/completions') ? '' : '/chat/completions'}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: agent.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        temperature: 0
      }),
      signal: AbortSignal.timeout(30000)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { ok: true, kind: agent.kind, provider: 'openai-compatible', ms: Date.now() - started, sample: text.slice(0, 200) };
  }

  if (agent.kind === 'image' || agent.kind === 'tts' || agent.kind === 'asr' || agent.kind === 'video') {
    return {
      ok: true,
      kind: agent.kind,
      message: `${KIND_LABELS[agent.kind]} 配置已保存。该类型暂不做在线测试，避免产生生成费用。`
    };
  }

  return { ok: true, kind: agent.kind, message: '配置已保存' };
}
