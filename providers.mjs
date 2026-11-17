import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decryptSecret } from './config.mjs';

const execFileAsync = promisify(execFile);

function base(agent) {
  return String(agent?.baseUrl || '').replace(/\/+$/, '');
}

function key(agent) {
  return decryptSecret(agent?.apiKey || '') || agent?.apiKey || '';
}

function openAiChatUrl(agent) {
  const b = base(agent);
  if (!b) throw new Error('base_url 为空');
  if (b.endsWith('/chat/completions')) return b;
  if (b.endsWith('/v1')) return `${b}/chat/completions`;
  return `${b}/chat/completions`;
}

function anthropicUrl(agent) {
  const b = base(agent);
  if (!b) throw new Error('base_url 为空');
  if (b.endsWith('/messages')) return b;
  if (b.endsWith('/v1')) return `${b}/messages`;
  return `${b}/v1/messages`;
}

function textFromOpenAi(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  }
  return '';
}

function textFromAnthropic(data) {
  const content = data?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part.type === 'text' || part.text).map((part) => part.text || '').join('');
  }
  return '';
}

export async function chat(agent, { messages, temperature = 0.3, maxTokens = 4096, timeoutMs } = {}) {
  const provider = String(agent?.provider || '').toLowerCase();
  const apiKey = key(agent);
  if (!apiKey) throw new Error(`员工 ${agent?.name || ''} 的 API Key 为空`);
  const timeout = timeoutMs || agent?.timeoutMs || 120000;
  const started = Date.now();

  if (provider.includes('anthropic') || base(agent).includes('anthropic')) {
    const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
    const rest = messages.filter((message) => message.role !== 'system');
    const res = await fetch(anthropicUrl(agent), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: agent.model,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: rest.map((message) => ({ role: message.role, content: message.content }))
      }),
      signal: AbortSignal.timeout(timeout)
    });
    const data = await res.json().catch(async () => ({ raw: await res.text() }));
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
    return { text: textFromAnthropic(data), usage: data.usage || null, raw: data, ms: Date.now() - started };
  }

  const res = await fetch(openAiChatUrl(agent), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: agent.model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature,
      max_tokens: maxTokens
    }),
    signal: AbortSignal.timeout(timeout)
  });
  const data = await res.json().catch(async () => ({ raw: await res.text() }));
  if (!res.ok) throw new Error(`OpenAI-compatible HTTP ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return { text: textFromOpenAi(data).trim(), usage: data.usage || null, raw: data, ms: Date.now() - started };
}

function imageUrl(agent) {
  const b = base(agent);
  if (!b) throw new Error('base_url 为空');
  if (b.endsWith('/images/generations')) return b;
  return `${b}/images/generations`;
}

export async function imageGenerate(agent, { prompt, size = '1024x1024', n = 1, timeoutMs } = {}) {
  const provider = String(agent?.provider || '').toLowerCase();
  if (provider.includes('pollinations') || (!key(agent) && provider.includes('free'))) {
    const width = Number(String(size).split('x')[0]) || 1024;
    const height = Number(String(size).split('x')[1]) || 1024;
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&seed=${crypto.randomInt(1, 1e9)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 180000) });
    if (!res.ok) throw new Error(`Pollinations HTTP ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: 'image/jpeg', url };
  }
  const apiKey = key(agent);
  if (!apiKey) throw new Error(`员工 ${agent?.name || ''} 的 API Key 为空`);
  const res = await fetch(imageUrl(agent), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: agent.model,
      prompt,
      n,
      size,
      response_format: 'url'
    }),
    signal: AbortSignal.timeout(timeoutMs || 180000)
  });
  const data = await res.json().catch(async () => ({ raw: await res.text() }));
  if (!res.ok) throw new Error(`Image HTTP ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  const item = data?.data?.[0];
  if (!item) throw new Error('图片接口没有返回 data[0]');
  if (item.b64_json) {
    return { buffer: Buffer.from(item.b64_json, 'base64'), mime: 'image/png', raw: data };
  }
  if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(timeoutMs || 180000) });
    if (!img.ok) throw new Error(`下载生成图片失败 HTTP ${img.status}`);
    return { buffer: Buffer.from(await img.arrayBuffer()), mime: img.headers.get('content-type') || 'image/png', url: item.url, raw: data };
  }
  throw new Error('图片接口返回格式不支持');
}

async function edgeTts(agent, text, voice) {
  const out = path.join(os.tmpdir(), `captain-edge-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.mp3`);
  const python = process.env.EDGE_TTS_PYTHON || 'python3';
  await execFileAsync(python, ['-m', 'edge_tts', '--voice', voice || agent.model || 'zh-CN-XiaoyiNeural', '--text', text, '--write-media', out], {
    timeout: agent?.timeoutMs || 120000
  });
  const buffer = fs.readFileSync(out);
  fs.unlinkSync(out);
  return buffer;
}

async function volcTts(agent, text, voiceId, instruction) {
  const apiKey = key(agent);
  if (!apiKey) throw new Error('TTS API Key 为空');
  const resource = agent.resource || process.env.VOLC_TTS_RESOURCE || 'seed-icl-2.0';
  const url = base(agent) && base(agent).includes('openspeech')
    ? `${base(agent)}/api/v3/tts/unidirectional`
    : 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'x-api-resource-id': resource,
      'x-api-connect-id': crypto.randomUUID(),
      'x-api-request-id': crypto.randomUUID()
    },
    body: JSON.stringify({
      user: { uid: agent.uid || 'captain' },
      req_params: {
        text,
        speaker: voiceId,
        instruction: instruction || '',
        audio_params: { format: 'mp3', sample_rate: 24000 }
      }
    }),
    signal: AbortSignal.timeout(agent?.timeoutMs || 120000)
  });
  if (!res.ok) {
    const textBody = await res.text();
    throw new Error(`Volc TTS HTTP ${res.status}: ${textBody.slice(0, 400)}`);
  }
  const raw = await res.text();
  const chunks = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item.code && item.code !== 0) throw new Error(`Volc TTS code ${item.code}: ${item.message || ''}`);
      if (item.data) chunks.push(Buffer.from(item.data, 'base64'));
    } catch (error) {
      if (error.message.startsWith('Volc TTS code')) throw error;
    }
  }
  if (!chunks.length) throw new Error('Volc TTS 没有返回音频数据');
  return Buffer.concat(chunks);
}

export async function textToSpeech(agent, { text, voiceId, instruction, timeoutMs } = {}) {
  const provider = String(agent?.provider || '').toLowerCase();
  const voice = voiceId || agent.voiceId || agent.model || '';
  if (provider.includes('edge')) {
    return { buffer: await edgeTts(agent, text, voice), mime: 'audio/mpeg', provider: 'edge-tts' };
  }
  if (provider.includes('openai')) {
    const apiKey = key(agent);
    if (!apiKey) throw new Error('TTS API Key 为空');
    const b = base(agent);
    const url = b.endsWith('/audio/speech') ? b : `${b}/audio/speech`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: agent.model, voice: voice || 'alloy', input: text }),
      signal: AbortSignal.timeout(timeoutMs || 120000)
    });
    if (!res.ok) throw new Error(`OpenAI TTS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg', provider: 'openai-tts' };
  }
  return { buffer: await volcTts(agent, text, voice, instruction), mime: 'audio/mpeg', provider: 'volc-tts' };
}

export async function listModels({ provider, baseUrl, apiKey, kind } = {}) {
  const p = String(provider || '').toLowerCase();
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (p.includes('edge')) {
    return { models: [], warning: 'edge-tts 使用音色名，不是模型列表，请手动填写 voice。' };
  }
  if (!apiKey) throw new Error('API Key 为空');
  if (!b) throw new Error('base_url 为空');
  const started = Date.now();

  if (p.includes('anthropic') || b.includes('anthropic')) {
    const url = b.endsWith('/v1') ? `${b}/models` : `${b}/v1/models`;
    const res = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Anthropic 模型列表 HTTP ${res.status}: ${text.slice(0, 300)}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Anthropic 模型列表返回不是 JSON');
    }
    const items = data.data || data.models || [];
    return {
      models: items
        .map((item) => ({
          id: String(item.id || item.model || item.name || ''),
          name: String(item.display_name || item.name || item.id || '')
        }))
        .filter((item) => item.id),
      source: 'live',
      ms: Date.now() - started
    };
  }

  let url = b;
  if (url.endsWith('/chat/completions')) url = url.slice(0, -'/chat/completions'.length);
  if (url.endsWith('/images/generations')) url = url.slice(0, -'/images/generations'.length);
  if (!url.endsWith('/models')) url = `${url}/models`;

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  if (res.status === 404) {
    return {
      models: [],
      source: 'unsupported',
      warning: '该服务商不提供模型列表，请手动填写模型 ID / Endpoint ID。'
    };
  }
  if (!res.ok) throw new Error(`模型列表 HTTP ${res.status}: ${text.slice(0, 300)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('模型列表返回不是 JSON');
  }
  const items = data.data || data.models || data.result?.data || [];
  const models = items
    .map((item) => ({
      id: String(item.id || item.model || item.name || ''),
      name: String(item.display_name || item.name || item.id || '')
    }))
    .filter((item) => item.id);
  return {
    models,
    source: 'live',
    ms: Date.now() - started,
    warning: models.length ? '' : '没有返回模型，请手动填写模型 ID。'
  };
}

export function providerLabel(agent) {
  return `${agent.name || agent.id} (${agent.kind}/${agent.provider})`;
}
