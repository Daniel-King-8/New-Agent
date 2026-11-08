import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfig } from './config.mjs';
import { getAgentInternal, teamForPrompt } from './team.mjs';
import { chat, imageGenerate, textToSpeech } from './providers.mjs';

function extractJson(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON');
  return JSON.parse(body.slice(start, end + 1));
}

function normalizeTask(task, index) {
  const kind = ['llm', 'code', 'image', 'tts', 'asr', 'video'].includes(task.kind) ? task.kind : 'llm';
  return {
    id: String(task.id || `t${index + 1}`),
    title: String(task.title || `任务 ${index + 1}`),
    instruction: String(task.instruction || task.title || ''),
    kind,
    requiredTags: Array.isArray(task.requiredTags) ? task.requiredTags.map(String) : [],
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
    deliverable: String(task.deliverable || ''),
    acceptance: String(task.acceptance || '')
  };
}

function chooseAgent(task) {
  const agents = getConfig().team.agents.filter((agent) => agent.enabled && agent.kind === task.kind);
  if (!agents.length) {
    throw new Error(`没有 kind=${task.kind} 的员工，无法执行「${task.title}」。请先添加对应员工。`);
  }
  const byTags = agents.filter((agent) => task.requiredTags.every((tag) => agent.tags.includes(tag)));
  if (task.requiredTags.length && !byTags.length) {
    throw new Error(`没有同时具备标签「${task.requiredTags.join('、')}」的 ${task.kind} 员工。`);
  }
  return (byTags[0] || agents[0]);
}

function artifactExt(mime) {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  return 'bin';
}

function saveArtifact(runDir, taskId, buffer, mime) {
  const dir = path.join(runDir, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${taskId}-${crypto.randomBytes(3).toString('hex')}.${artifactExt(mime)}`);
  fs.writeFileSync(file, buffer);
  return file;
}

function upstreamText(upstreamResults) {
  if (!upstreamResults?.length) return '无';
  return upstreamResults.map((item) => [
    `## ${item.taskId} · ${item.agentName}`,
    item.text || '',
    ...(item.files || []).map((file) => `[文件] ${file}`)
  ].join('\n')).join('\n\n');
}

async function planTask({ captain, text, history }) {
  const cfg = getConfig();
  const system = [
    '你是多 Agent 团队的主管。根据用户需求拆解任务，只输出 JSON，不要输出任何解释。',
    'JSON 结构：',
    '{"goal":"一句话目标","tasks":[{"id":"t1","title":"任务名","instruction":"详细指令","kind":"llm|code|image|tts","requiredTags":["标签"],"dependsOn":[],"deliverable":"交付物","acceptance":"验收标准"}]}',
    '规则：',
    `- 最多 ${cfg.orchestration.maxTasks} 个任务。`,
    '- 能并行的任务不要互相依赖；有依赖必须写 dependsOn。',
    '- 生图任务 kind=image，必须带「生图」类标签；语音任务 kind=tts，必须带「语音」类标签；编程任务 kind=code。',
    '- 不要创建团队里没有对应能力的任务；缺能力时在 goal 里说明，不要硬派。',
    '- 最后整合类任务通常是 code 或 llm，依赖前面所有产物。',
    '',
    '当前团队：',
    teamForPrompt()
  ].join('\n');
  const messages = [{ role: 'system', content: system }];
  for (const item of (history || []).slice(-12)) {
    if (item.role === 'user' || item.role === 'assistant') messages.push({ role: item.role, content: item.content });
  }
  messages.push({ role: 'user', content: `用户需求：${text}` });
  const result = await chat(captain, { messages, temperature: 0.2, maxTokens: 4000, timeoutMs: 180000 });
  let plan;
  try {
    plan = extractJson(result.text);
  } catch (error) {
    throw new Error(`主管返回的计划不是有效 JSON：${error.message}\n${String(result.text).slice(0, 500)}`);
  }
  const tasks = (plan.tasks || []).map(normalizeTask).slice(0, cfg.orchestration.maxTasks);
  if (!tasks.length) throw new Error('主管没有拆出任何任务');
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.filter((dep) => ids.has(dep) && dep !== task.id);
  }
  return {
    goal: String(plan.goal || text),
    tasks,
    usage: result.usage,
    raw: result.text
  };
}

async function runTask({ task, agent, upstream, runDir }) {
  const started = Date.now();
  const system = [
    agent.systemPrompt || `你是团队里的${agent.kind}员工。`,
    '',
    `你的任务：${task.title}`,
    `交付物：${task.deliverable || '按任务要求产出'}`,
    `验收标准：${task.acceptance || '内容完整、可直接使用'}`,
    '',
    '上游产物：',
    upstreamText(upstream)
  ].join('\n');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: task.instruction }
  ];

  if (task.kind === 'image') {
    const result = await imageGenerate(agent, {
      prompt: task.instruction,
      size: task.size || '1024x1024',
      timeoutMs: agent.timeoutMs || 180000
    });
    const file = saveArtifact(runDir, task.id, result.buffer, result.mime);
    return {
      taskId: task.id,
      agentId: agent.id,
      agentName: agent.name,
      kind: task.kind,
      text: `已生成图片：${file}`,
      files: [file],
      usage: null,
      ms: Date.now() - started
    };
  }

  if (task.kind === 'tts') {
    const result = await textToSpeech(agent, {
      text: task.instruction,
      voiceId: agent.voiceId || agent.model,
      instruction: agent.instruction || '',
      timeoutMs: agent.timeoutMs || 180000
    });
    const file = saveArtifact(runDir, task.id, result.buffer, result.mime);
    return {
      taskId: task.id,
      agentId: agent.id,
      agentName: agent.name,
      kind: task.kind,
      text: `已生成语音：${file}`,
      files: [file],
      usage: null,
      ms: Date.now() - started
    };
  }

  const result = await chat(agent, {
    messages,
    temperature: 0.4,
    maxTokens: 8000,
    timeoutMs: agent.timeoutMs || 300000
  });
  return {
    taskId: task.id,
    agentId: agent.id,
    agentName: agent.name,
    kind: task.kind,
    text: result.text || '',
    files: [],
    usage: result.usage,
    ms: Date.now() - started
  };
}

async function runDag({ tasks, runDir, maxParallel, retryFailed, onEvent }) {
  const cfg = getConfig();
  const state = new Map(tasks.map((task) => [task.id, { task, status: 'pending', result: null, error: '', attempts: 0 }]));
  const results = [];
  const limit = Math.max(1, Math.min(maxParallel || cfg.orchestration.maxParallel || 3, 10));

  while (true) {
    const pending = [...state.values()].filter((item) => item.status === 'pending');
    if (!pending.length) break;
    const ready = pending.filter((item) => item.task.dependsOn.every((dep) => state.get(dep)?.status === 'done'));
    if (!ready.length) {
      for (const item of pending) {
        item.status = 'blocked';
        item.error = '依赖任务失败或无法满足';
        onEvent?.({ type: 'task', taskId: item.task.id, status: 'blocked', error: item.error });
      }
      break;
    }
    const wave = ready.slice(0, limit);
    await Promise.all(wave.map(async (item) => {
      item.status = 'running';
      onEvent?.({ type: 'task', taskId: item.task.id, status: 'running' });
      const upstream = item.task.dependsOn.map((dep) => state.get(dep)?.result).filter(Boolean);
      let lastError = null;
      for (let attempt = 0; attempt <= retryFailed; attempt += 1) {
        item.attempts = attempt + 1;
        try {
          const agent = chooseAgent(item.task);
          item.result = await runTask({ task: item.task, agent, upstream, runDir });
          item.status = 'done';
          item.error = '';
          results.push(item.result);
          onEvent?.({ type: 'task', taskId: item.task.id, status: 'done', result: item.result });
          return;
        } catch (error) {
          lastError = error;
          if (attempt < retryFailed) {
            await new Promise((resolve) => setTimeout(resolve, 800));
          }
        }
      }
      item.status = 'failed';
      item.error = lastError?.message || '未知错误';
      onEvent?.({ type: 'task', taskId: item.task.id, status: 'failed', error: item.error });
    }));
  }
  return { results, state: [...state.values()] };
}

async function verifyResults({ captain, goal, taskStates }) {
  const rows = taskStates.map((item) => ({
    taskId: item.task.id,
    title: item.task.title,
    kind: item.task.kind,
    agent: item.result?.agentName || '',
    acceptance: item.task.acceptance,
    status: item.status,
    output: item.result?.text || item.error || '',
    files: item.result?.files || []
  }));
  const prompt = [
    '你是主管，请验收以下任务结果。只输出 JSON。',
    'JSON 结构：{"pass":true,"issues":[{"taskId":"t1","reason":"..."}],"summary":"..."}',
    '验收标准：交付物是否满足任务要求、是否完整、是否能直接使用。文件存在即视为有效产物。',
    `总目标：${goal}`,
    '任务结果：',
    JSON.stringify(rows, null, 2)
  ].join('\n');
  try {
    const result = await chat(captain, {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 2500,
      timeoutMs: 120000
    });
    const parsed = extractJson(result.text);
    return {
      pass: parsed.pass !== false,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      summary: String(parsed.summary || ''),
      raw: result.text
    };
  } catch (error) {
    const failed = rows.filter((row) => row.status !== 'done');
    return {
      pass: failed.length === 0,
      issues: failed.map((row) => ({ taskId: row.taskId, reason: row.output || '任务失败' })),
      summary: `验收模型不可用，按任务执行状态判定：${error.message}`,
      fallback: true
    };
  }
}

async function reportResults({ captain, goal, taskStates }) {
  const rows = taskStates.map((item) => ({
    taskId: item.task.id,
    title: item.task.title,
    agent: item.result?.agentName || '',
    status: item.status,
    output: item.result?.text || item.error || '',
    files: item.result?.files || []
  }));
  const prompt = [
    '你是主管。请根据以下任务结果，给用户写一条最终回复。',
    '要求：用用户的语言；简洁直接；只讲结果和必要说明；保留文件路径；不要提内部编排细节。',
    `总目标：${goal}`,
    '任务结果：',
    JSON.stringify(rows, null, 2)
  ].join('\n');
  try {
    const result = await chat(captain, {
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens: 3000,
      timeoutMs: 120000
    });
    return result.text || fallbackReport(goal, taskStates);
  } catch {
    return fallbackReport(goal, taskStates);
  }
}

function fallbackReport(goal, taskStates) {
  const lines = [`目标：${goal}`, ''];
  for (const item of taskStates) {
    lines.push(`【${item.task.title}】${item.result?.agentName || ''}`);
    lines.push(item.result?.text || item.error || '无输出');
    for (const file of item.result?.files || []) lines.push(`文件：${file}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export async function runOrchestration({ text, history = [], runDir, logger, onEvent }) {
  const cfg = getConfig();
  const captain = getAgentInternal('captain');
  if (!captain?.model) throw new Error('主管未配置模型');
  if (!captain?.apiKey) throw new Error('主管未配置 API Key');
  fs.mkdirSync(runDir, { recursive: true });

  logger?.info('主管开始拆解任务');
  const plan = await planTask({ captain, text, history });
  onEvent?.({ type: 'plan', plan });
  logger?.info(`主管拆出 ${plan.tasks.length} 个任务`);

  const maxParallel = cfg.orchestration.maxParallel || 3;
  const retryFailed = cfg.orchestration.retryFailed || 0;
  const executed = await runDag({ tasks: plan.tasks, runDir, maxParallel, retryFailed, onEvent });

  let verification = await verifyResults({ captain, goal: plan.goal, taskStates: executed.state });
  let taskStates = executed.state;

  if (!verification.pass && verification.issues.length) {
    logger?.warn(`验收未通过：${verification.issues.map((issue) => `${issue.taskId}: ${issue.reason}`).join('；')}`);
    const retryIds = new Set(verification.issues.map((issue) => issue.taskId));
    const retryTasks = plan.tasks.filter((task) => retryIds.has(task.id));
    if (retryTasks.length) {
      const retry = await runDag({ tasks: retryTasks, runDir, maxParallel: 1, retryFailed: 0, onEvent });
      const retryById = new Map(retry.results.map((result) => [result.taskId, result]));
      taskStates = taskStates.map((item) => {
        if (retryById.has(item.task.id)) {
          return { ...item, status: 'done', result: retryById.get(item.task.id), error: '' };
        }
        return item;
      });
      verification = await verifyResults({ captain, goal: plan.goal, taskStates });
    }
  }

  const reply = await reportResults({ captain, goal: plan.goal, taskStates });
  const files = [...new Set(taskStates.flatMap((item) => item.result?.files || []))];
  return {
    reply,
    plan,
    tasks: taskStates.map((item) => ({
      id: item.task.id,
      title: item.task.title,
      kind: item.task.kind,
      status: item.status,
      agent: item.result?.agentName || '',
      agentId: item.result?.agentId || '',
      text: item.result?.text || '',
      error: item.error || '',
      files: item.result?.files || [],
      attempts: item.attempts
    })),
    verification,
    files
  };
}
