import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'captain-test-'));
process.env.CAPTAIN_DATA_DIR = dataDir;
process.env.CAPTAIN_MASTER_KEY = 'unit-test-master-key';
process.env.CAPTAIN_TMP = path.join(dataDir, 'tmp');

const { extractSecrets, redactSecrets, maskValue } = await import('../secrets.mjs');
const {
  decryptSecret,
  defaultConfig,
  encryptSecret,
  getConfig,
  hashPassword,
  publicConfig,
  saveConfig,
  verifyPassword
} = await import('../config.mjs');
const { createAgent, deleteAgent, getTeam, updateAgent, warningsFor } = await import('../team.mjs');
const { parseQQEvent } = await import('../channels/qq.mjs');
const { parseTelegramUpdate } = await import('../channels/telegram.mjs');

test('secret extraction redacts keys and keeps them out of text', () => {
  const text = '这是豆包的 key：sk-1234567890abcdefghij，模型 doubao-seedream';
  const result = extractSecrets(text);
  assert.equal(result.found.length, 1);
  assert.match(result.redacted, /\[SECRET:/);
  assert.doesNotMatch(result.redacted, /sk-1234567890abcdefghij/);
  assert.equal(redactSecrets(text), result.redacted);
  assert.equal(maskValue('sk-1234567890abcdefghij'), 'sk-****ghij');
});

test('config encrypts and masks secrets', () => {
  saveConfig({ hermes: { apiKey: 'sk-hermes-secret-123456' }, channels: { qq: { accessToken: 'qq-token-123456' } } });
  const raw = getConfig();
  assert.ok(raw.hermes.apiKey.startsWith('enc:v1:'));
  assert.ok(raw.channels.qq.accessToken.startsWith('enc:v1:'));
  assert.equal(decryptSecret(raw.hermes.apiKey), 'sk-hermes-secret-123456');
  const pub = publicConfig();
  assert.match(pub.hermes.apiKey, /\*\*\*\*/);
  assert.equal(JSON.stringify(pub).includes('sk-hermes-secret-123456'), false);
  // Masked value preserves the encrypted secret.
  saveConfig({ hermes: { apiKey: 'sk-****3456' } });
  assert.equal(decryptSecret(getConfig().hermes.apiKey), 'sk-hermes-secret-123456');
});

test('password hashing roundtrip', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
});

test('team create, update, delete and tag warnings', () => {
  const created = createAgent({
    name: '测试画师',
    kind: 'image',
    provider: 'doubao',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream',
    apiKey: 'sk-image-1234567890',
    tags: ['生图', '海报']
  });
  assert.equal(created.agent.kind, 'image');
  assert.equal(created.agent.apiKey.includes('sk-image-1234567890'), false);
  assert.ok(created.agent.apiKey.includes('****'));
  const warnings = warningsFor('llm', ['生图']);
  assert.equal(warnings.length, 1);
  const updated = updateAgent(created.agent.id, { model: 'doubao-seedream-v2', apiKey: 'sk-****7890' });
  assert.equal(updated.agent.model, 'doubao-seedream-v2');
  deleteAgent(created.agent.id);
  assert.equal(getTeam().agents.length, 0);
});

test('QQ event parsing detects private message and @mention', () => {
  const privateEvent = {
    post_type: 'message',
    message_type: 'private',
    self_id: 999,
    user_id: 123,
    message_id: 1,
    sender: { nickname: 'tester' },
    message: [{ type: 'text', data: { text: '你好' } }]
  };
  const privateMsg = parseQQEvent(privateEvent, 999);
  assert.equal(privateMsg.chatType, 'private');
  assert.equal(privateMsg.text, '你好');
  assert.equal(privateMsg.mentioned, false);

  const groupEvent = {
    post_type: 'message',
    message_type: 'group',
    self_id: 999,
    group_id: 456,
    user_id: 123,
    message_id: 2,
    message: [
      { type: 'at', data: { qq: '999' } },
      { type: 'text', data: { text: ' 帮我画图' } }
    ]
  };
  const groupMsg = parseQQEvent(groupEvent, 999);
  assert.equal(groupMsg.chatType, 'group');
  assert.equal(groupMsg.chatId, '456');
  assert.equal(groupMsg.mentioned, true);
});

test('Telegram update parsing detects private message and group mention', () => {
  const privateUpdate = {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 123, first_name: 'Tester', is_bot: false },
      chat: { id: 123, type: 'private' },
      text: 'hello'
    }
  };
  const privateMsg = parseTelegramUpdate(privateUpdate, { botId: 999, botUsername: 'captain_bot' });
  assert.equal(privateMsg.chatType, 'private');
  assert.equal(privateMsg.text, 'hello');

  const groupUpdate = {
    update_id: 2,
    message: {
      message_id: 11,
      from: { id: 123, first_name: 'Tester', is_bot: false },
      chat: { id: -100, type: 'supergroup' },
      text: '@captain_bot 做图',
      entities: [{ type: 'mention', offset: 0, length: 13 }]
    }
  };
  const groupMsg = parseTelegramUpdate(groupUpdate, { botId: 999, botUsername: 'captain_bot' });
  assert.equal(groupMsg.chatType, 'group');
  assert.equal(groupMsg.mentioned, true);
});

test('default config has mandatory captain and native engine', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.team.captain.id, 'captain');
  assert.equal(cfg.orchestration.engine, 'native');
  const encrypted = encryptSecret('plain');
  assert.ok(encrypted.startsWith('enc:v1:'));
  assert.equal(decryptSecret(encrypted), 'plain');
});
