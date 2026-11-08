import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captain-it-'));
process.env.CAPTAIN_DATA_DIR = dataDir;
process.env.CAPTAIN_MASTER_KEY = 'integration-test-master-key';
process.env.CAPTAIN_TMP = path.join(dataDir, 'tmp');

function jsonReply(res, content, usage = { prompt_tokens: 10, completion_tokens: 20 }) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'mock',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage
  }));
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const joined = (body.messages || []).map((message) => message.content || '').join('\n');
    if (joined.includes('用户需求：你好')) {
      jsonReply(res, JSON.stringify({ mode: 'chat', reply: '你好，我是主管。' }));
      return;
    }
    if (joined.includes('只输出 JSON') || (joined.includes('JSON 结构') && joined.includes('tasks'))) {
      jsonReply(res, JSON.stringify({
        goal: '测试目标',
        tasks: [
          {
            id: 't1',
            title: '资料整理',
            instruction: '整理一段介绍',
            kind: 'llm',
            requiredTags: ['文本'],
            dependsOn: [],
            deliverable: '一段文字',
            acceptance: '完整'
          },
          {
            id: 't2',
            title: '整合输出',
            instruction: '整合上游资料',
            kind: 'llm',
            requiredTags: ['文本'],
            dependsOn: ['t1'],
            deliverable: '最终结果',
            acceptance: '包含上游内容'
          }
        ]
      }));
      return;
    }
    if (joined.includes('验收') && joined.includes('JSON')) {
      jsonReply(res, JSON.stringify({ pass: true, issues: [], summary: '全部通过' }));
      return;
    }
    if (joined.includes('最终回复')) {
      jsonReply(res, '最终结果：已完成。');
      return;
    }
    jsonReply(res, '员工产出：这是模拟内容。');
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

const { saveConfig } = await import('../config.mjs');
const { runOrchestration } = await import('../orchestrator.mjs');

saveConfig({
  team: {
    captain: {
      id: 'captain',
      name: '主管',
      kind: 'llm',
      provider: 'openai-compatible',
      baseUrl,
      model: 'mock',
      apiKey: 'sk-test-captain-1234567890',
      tags: ['调度', '验收']
    },
    agents: [
      {
        id: 'writer',
        name: '写手',
        kind: 'llm',
        provider: 'openai-compatible',
        baseUrl,
        model: 'mock',
        apiKey: 'sk-test-worker-1234567890',
        tags: ['文本', '写作']
      }
    ]
  },
  orchestration: { engine: 'native', maxParallel: 2, retryFailed: 0 }
});

test('native orchestrator plans, executes dependencies, verifies and reports', async () => {
  const logger = { info() {}, warn() {}, error() {} };
  const result = await runOrchestration({
    text: '帮我写一份测试介绍',
    history: [],
    runDir: path.join(dataDir, 'run-test'),
    logger,
    onEvent: () => {}
  });

  assert.equal(result.plan.tasks.length, 2);
  assert.equal(result.tasks.length, 2);
  assert.ok(result.tasks.every((task) => task.status === 'done'));
  assert.equal(result.tasks[0].text.includes('员工产出'), true);
  assert.equal(result.verification.pass, true);
  assert.match(result.reply, /最终结果/);
});

test('simple greeting bypasses the task DAG and answers directly', async () => {
  const logger = { info() {}, warn() {}, error() {} };
  const result = await runOrchestration({
    text: '你好',
    history: [],
    runDir: path.join(dataDir, 'run-chat'),
    logger,
    onEvent: () => {}
  });

  assert.equal(result.plan.mode, 'chat');
  assert.equal(result.tasks.length, 0);
  assert.match(result.reply, /你好/);
  assert.equal(result.files.length, 0);
});

test.after(() => {
  server.close();
});
