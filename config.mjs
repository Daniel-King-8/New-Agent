import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hasMaskMarker, maskValue } from './secrets.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.CAPTAIN_DATA_DIR
  ? path.resolve(process.env.CAPTAIN_DATA_DIR)
  : path.join(ROOT, 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const BACKUP_DIR = path.join(DATA_DIR, 'backup');
export const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');
export const PENDING_SECRETS_FILE = path.join(DATA_DIR, 'pending-secrets.json');
export const MASTER_KEY_FILE = path.join(DATA_DIR, 'master.key');
export const TMP_DIR = process.env.CAPTAIN_TMP
  ? path.resolve(process.env.CAPTAIN_TMP)
  : path.join(DATA_DIR, 'tmp');

const STATIC_SECRET_PATHS = [
  'hermes.apiKey',
  'hermes.bridgeToken',
  'team.captain.apiKey',
  'channels.qq.accessToken',
  'channels.telegram.token',
  'channels.feishu.appSecret'
];

export function defaultConfig() {
  return {
    server: {
      port: Number(process.env.PORT || 8080),
      bind: process.env.BIND || '0.0.0.0',
      internalToken: ''
    },
    auth: {
      username: 'admin',
      passwordHash: '',
      mustChange: false,
      sessionHours: 24
    },
    hermes: {
      enabled: true,
      baseUrl: process.env.HERMES_BASE_URL || 'http://hermes:8642',
      apiKey: process.env.HERMES_API_KEY || '',
      bridgeUrl: process.env.HERMES_DASHBOARD_URL || process.env.HERMES_BRIDGE_URL || 'http://hermes:9119',
      bridgeToken: process.env.HERMES_DASHBOARD_SESSION_TOKEN || process.env.HERMES_BRIDGE_TOKEN || '',
      captainProfile: 'captain',
      runMode: 'auto',
      timeoutMs: 300000
    },
    team: {
      captain: {
        id: 'captain',
        name: '主管',
        kind: 'llm',
        provider: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKey: '',
        tags: ['调度', '验收'],
        systemPrompt: '你是团队主管。你负责理解用户需求、拆解任务、按能力标签把任务派给团队中的员工、验收结果，并只把最终结果汇报给用户。',
        enabled: true,
        maxConcurrency: 3,
        timeoutMs: 300000,
        hermesProfile: 'captain'
      },
      agents: [],
      maxAgents: 30
    },
    channels: {
      qq: {
        enabled: false,
        wsUrl: process.env.NAPCAT_WS_URL || 'ws://napcat:3001',
        accessToken: process.env.NAPCAT_ACCESS_TOKEN || '',
        selfId: 0,
        allowUsers: [],
        allowGroups: [],
        owners: [],
        groupTrigger: 'mention',
        commandPrefix: '/',
        webuiUrl: process.env.NAPCAT_WEBUI_URL || 'http://napcat:6099'
      },
      telegram: {
        enabled: false,
        token: '',
        allowUsers: [],
        allowChats: [],
        owners: [],
        groupTrigger: 'mention'
      },
      feishu: {
        enabled: false,
        appId: '',
        appSecret: '',
        allowUsers: [],
        allowChats: [],
        owners: [],
        groupTrigger: 'mention'
      }
    },
    orchestration: {
      engine: 'native',
      mode: 'auto',
      maxParallel: 3,
      maxTasks: 12,
      retryFailed: 1,
      progress: false,
      askDelivery: true,
      dailyBudgetUsd: 5,
      maxHistory: 40
    },
    logs: {
      keepDays: 7,
      maxSizeMB: 5
    }
  };
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, LOG_DIR, RUNS_DIR, BACKUP_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function clone(value) {
  return structuredClone(value);
}

export function deepMerge(base, patch) {
  if (Array.isArray(patch)) return clone(patch);
  if (!patch || typeof patch !== 'object') return patch;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

export function getPath(obj, dotted) {
  return String(dotted).split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

export function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

export function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
  }
  if (typeof value === 'string') {
    return [...new Set(value.split(/[\n,;，；、]+/).map((v) => v.trim()).filter(Boolean))];
  }
  return [];
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function slugify(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return text || 'agent';
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomPassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, n, r, p, saltB64, hashB64] = String(stored || '').split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p)
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function getMasterKey() {
  ensureDirs();
  if (process.env.CAPTAIN_MASTER_KEY) {
    const raw = process.env.CAPTAIN_MASTER_KEY;
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
    return crypto.createHash('sha256').update(raw).digest();
  }
  if (fs.existsSync(MASTER_KEY_FILE)) {
    const raw = fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
    try {
      const key = Buffer.from(raw, 'base64');
      if (key.length === 32) return key;
    } catch {
      // fall through and regenerate
    }
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(MASTER_KEY_FILE, `${key.toString('base64')}\n`, { mode: 0o600 });
  return key;
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc:v1:');
}

export function encryptSecret(value) {
  if (!value || isEncrypted(value)) return value || '';
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptSecret(value) {
  if (!value || !isEncrypted(value)) return value || '';
  try {
    const [, , ivB64, tagB64, dataB64] = String(value).split(':');
    const key = getMasterKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    return '';
  }
}

export function secretValue(value) {
  return decryptSecret(value);
}

function agentSecretPaths(cfg) {
  const paths = [];
  (cfg?.team?.agents || []).forEach((agent, index) => {
    paths.push(`team.agents.${index}.apiKey`);
  });
  return paths;
}

function allSecretPaths(cfg) {
  return [...STATIC_SECRET_PATHS, ...agentSecretPaths(cfg)];
}

export function encryptSecrets(cfg) {
  for (const dotted of allSecretPaths(cfg)) {
    const value = getPath(cfg, dotted);
    if (value) setPath(cfg, dotted, encryptSecret(value));
  }
  return cfg;
}

export function maskConfig(cfg) {
  const out = clone(cfg);
  for (const dotted of allSecretPaths(out)) {
    const value = getPath(out, dotted);
    if (value) setPath(out, dotted, maskValue(decryptSecret(value)));
  }
  if (out.server) delete out.server.internalToken;
  if (out.auth) delete out.auth.passwordHash;
  return out;
}

function preserveMaskedSecret(currentValue, incomingValue) {
  if (incomingValue === undefined) return currentValue;
  if (hasMaskMarker(incomingValue)) return currentValue;
  return incomingValue;
}

function mergeAgents(currentAgents, patchAgents) {
  if (!Array.isArray(patchAgents)) return currentAgents;
  const currentById = new Map((currentAgents || []).map((agent) => [agent.id, agent]));
  return patchAgents.map((agent) => {
    const current = currentById.get(agent.id) || {};
    const merged = deepMerge(current, agent);
    merged.apiKey = preserveMaskedSecret(current.apiKey, agent.apiKey);
    return merged;
  });
}

export function normalizeAgent(agent, index = 0) {
  const kind = ['llm', 'code', 'image', 'tts', 'asr', 'video'].includes(agent?.kind)
    ? agent.kind
    : 'llm';
  const name = String(agent?.name || `员工${index + 1}`).trim();
  const id = String(agent?.id || `${slugify(name)}-${crypto.randomBytes(2).toString('hex')}`).trim();
  return {
    id,
    name,
    department: String(agent?.department || '').trim(),
    kind,
    provider: String(agent?.provider || 'openai-compatible').trim(),
    baseUrl: String(agent?.baseUrl || '').trim(),
    model: String(agent?.model || '').trim(),
    apiKey: String(agent?.apiKey || ''),
    tags: normalizeStringArray(agent?.tags),
    systemPrompt: String(agent?.systemPrompt || '').trim(),
    enabled: agent?.enabled !== false,
    maxConcurrency: clampNumber(agent?.maxConcurrency, 1, 20, 1),
    timeoutMs: clampNumber(agent?.timeoutMs, 5000, 1800000, 300000),
    hermesProfile: String(agent?.hermesProfile || `agent-${id}`).trim(),
    createdAt: agent?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function normalizeConfig(input) {
  const cfg = deepMerge(defaultConfig(), input || {});
  cfg.server.port = clampNumber(cfg.server.port, 1, 65535, 8080);
  cfg.server.bind = String(cfg.server.bind || '0.0.0.0');
  cfg.auth.sessionHours = clampNumber(cfg.auth.sessionHours, 1, 720, 24);
  cfg.hermes.timeoutMs = clampNumber(cfg.hermes.timeoutMs, 5000, 1800000, 300000);
  cfg.hermes.runMode = ['auto', 'chat', 'runs'].includes(cfg.hermes.runMode) ? cfg.hermes.runMode : 'auto';
  cfg.team.maxAgents = clampNumber(cfg.team.maxAgents, 1, 100, 30);
  cfg.team.captain = normalizeAgent({ ...cfg.team.captain, id: 'captain', name: cfg.team.captain?.name || '主管' }, 0);
  cfg.team.captain.id = 'captain';
  cfg.team.captain.enabled = true;
  cfg.team.captain.hermesProfile = cfg.team.captain.hermesProfile || cfg.hermes.captainProfile || 'captain';
  cfg.team.agents = (cfg.team.agents || []).map((agent, index) => normalizeAgent(agent, index));
  const seen = new Set();
  cfg.team.agents = cfg.team.agents.filter((agent) => {
    if (seen.has(agent.id) || agent.id === 'captain') return false;
    seen.add(agent.id);
    return true;
  });
  cfg.channels.qq.enabled = cfg.channels.qq.enabled === true;
  cfg.channels.qq.selfId = clampNumber(cfg.channels.qq.selfId, 0, Number.MAX_SAFE_INTEGER, 0);
  cfg.channels.qq.allowUsers = normalizeStringArray(cfg.channels.qq.allowUsers);
  cfg.channels.qq.allowGroups = normalizeStringArray(cfg.channels.qq.allowGroups);
  cfg.channels.qq.owners = normalizeStringArray(cfg.channels.qq.owners);
  cfg.channels.qq.groupTrigger = ['mention', 'prefix', 'all'].includes(cfg.channels.qq.groupTrigger)
    ? cfg.channels.qq.groupTrigger
    : 'mention';
  cfg.channels.telegram.enabled = cfg.channels.telegram.enabled === true;
  cfg.channels.telegram.allowUsers = normalizeStringArray(cfg.channels.telegram.allowUsers);
  cfg.channels.telegram.allowChats = normalizeStringArray(cfg.channels.telegram.allowChats);
  cfg.channels.telegram.owners = normalizeStringArray(cfg.channels.telegram.owners);
  cfg.channels.telegram.groupTrigger = ['mention', 'prefix', 'all'].includes(cfg.channels.telegram.groupTrigger)
    ? cfg.channels.telegram.groupTrigger
    : 'mention';
  cfg.channels.feishu.enabled = cfg.channels.feishu.enabled === true;
  cfg.channels.feishu.allowUsers = normalizeStringArray(cfg.channels.feishu.allowUsers);
  cfg.channels.feishu.allowChats = normalizeStringArray(cfg.channels.feishu.allowChats);
  cfg.channels.feishu.owners = normalizeStringArray(cfg.channels.feishu.owners);
  cfg.channels.feishu.groupTrigger = ['mention', 'prefix', 'all'].includes(cfg.channels.feishu.groupTrigger)
    ? cfg.channels.feishu.groupTrigger
    : 'mention';
  cfg.orchestration.engine = ['native', 'hermes', 'auto'].includes(cfg.orchestration.engine)
    ? cfg.orchestration.engine
    : 'native';
  cfg.orchestration.mode = ['auto', 'confirm'].includes(cfg.orchestration.mode)
    ? cfg.orchestration.mode
    : 'auto';
  cfg.orchestration.maxParallel = clampNumber(cfg.orchestration.maxParallel, 1, 20, 3);
  cfg.orchestration.maxTasks = clampNumber(cfg.orchestration.maxTasks, 1, 100, 12);
  cfg.orchestration.retryFailed = clampNumber(cfg.orchestration.retryFailed, 0, 5, 1);
  cfg.orchestration.dailyBudgetUsd = clampNumber(cfg.orchestration.dailyBudgetUsd, 0, 10000, 5);
  cfg.orchestration.maxHistory = clampNumber(cfg.orchestration.maxHistory, 4, 200, 40);
  cfg.logs.keepDays = clampNumber(cfg.logs.keepDays, 1, 365, 7);
  cfg.logs.maxSizeMB = clampNumber(cfg.logs.maxSizeMB, 1, 100, 5);
  return cfg;
}

let cache = null;
let cacheStamp = '';

function stampFor(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

export function atomicWriteFile(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, value, mode = 0o600) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function ensureConfigFile() {
  ensureDirs();
  if (fs.existsSync(CONFIG_FILE)) return;
  const cfg = defaultConfig();
  cfg.server.internalToken = randomToken(24);
  writeJsonAtomic(CONFIG_FILE, normalizeConfig(cfg));
}

export function getConfig(force = false) {
  ensureConfigFile();
  const stamp = stampFor(CONFIG_FILE);
  if (!force && cache && stamp === cacheStamp) return clone(cache);
  const parsed = readJson(CONFIG_FILE, {});
  const cfg = normalizeConfig(parsed);
  cache = cfg;
  cacheStamp = stamp;
  return clone(cfg);
}

export function saveConfig(patch, { merge = true } = {}) {
  const current = getConfig(true);
  let next;
  if (merge) {
    next = deepMerge(current, patch || {});
    if (patch?.team && Array.isArray(patch.team.agents)) {
      next.team.agents = mergeAgents(current.team.agents, patch.team.agents);
    }
    if (patch?.team?.captain && next.team?.captain) {
      next.team.captain.apiKey = preserveMaskedSecret(current.team.captain?.apiKey, patch.team.captain.apiKey);
    }
    if (patch?.hermes) {
      next.hermes.apiKey = preserveMaskedSecret(current.hermes.apiKey, patch.hermes.apiKey);
      next.hermes.bridgeToken = preserveMaskedSecret(current.hermes.bridgeToken, patch.hermes.bridgeToken);
    }
    if (patch?.channels?.qq) {
      next.channels.qq.accessToken = preserveMaskedSecret(current.channels.qq.accessToken, patch.channels.qq.accessToken);
    }
    if (patch?.channels?.telegram) {
      next.channels.telegram.token = preserveMaskedSecret(current.channels.telegram.token, patch.channels.telegram.token);
    }
    if (patch?.channels?.feishu) {
      next.channels.feishu.appSecret = preserveMaskedSecret(current.channels.feishu.appSecret, patch.channels.feishu.appSecret);
    }
    if (!patch?.server?.internalToken) next.server.internalToken = current.server.internalToken;
    if (!patch?.auth?.passwordHash) next.auth.passwordHash = current.auth.passwordHash;
  } else {
    next = normalizeConfig(patch || {});
    next.server.internalToken = current.server.internalToken;
    next.auth.passwordHash = current.auth.passwordHash;
  }
  next = normalizeConfig(next);
  encryptSecrets(next);
  writeJsonAtomic(CONFIG_FILE, next);
  cache = null;
  cacheStamp = '';
  return next;
}

export function reloadConfig() {
  cache = null;
  cacheStamp = '';
  return getConfig(true);
}

export function publicConfig() {
  return maskConfig(getConfig());
}

export function exportConfig({ includeSecrets = false } = {}) {
  const cfg = getConfig();
  if (!includeSecrets) return maskConfig(cfg);
  const out = clone(cfg);
  for (const dotted of allSecretPaths(out)) {
    const value = getPath(out, dotted);
    if (value) setPath(out, dotted, decryptSecret(value));
  }
  return out;
}

export function resolveSecret(dotted) {
  const cfg = getConfig();
  return decryptSecret(getPath(cfg, dotted));
}

export function backupFile(file, label = 'backup') {
  if (!fs.existsSync(file)) return null;
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(BACKUP_DIR, `${stamp}_${label}_${path.basename(file)}`);
  fs.copyFileSync(file, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows may not support chmod; ignore.
  }
  return target;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function cleanupLogs(name, keepDays) {
  try {
    const cutoff = Date.now() - keepDays * 86400000;
    for (const entry of fs.readdirSync(LOG_DIR)) {
      if (!entry.startsWith(`${name}-`) || !entry.endsWith('.log')) continue;
      const full = path.join(LOG_DIR, entry);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch {
    // best-effort
  }
}

export function createLogger(name, { console: toConsole = true } = {}) {
  ensureDirs();
  const file = path.join(LOG_DIR, `${name}.log`);
  const cfg = getConfig();
  const maxBytes = cfg.logs.maxSizeMB * 1024 * 1024;
  const keepDays = cfg.logs.keepDays;
  let currentDay = dayKey(new Date());
  let lastCleanup = 0;

  function rotateIfNeeded() {
    const now = new Date();
    const today = dayKey(now);
    if (today !== currentDay && fs.existsSync(file)) {
      try {
        fs.renameSync(file, path.join(LOG_DIR, `${name}-${currentDay}.log`));
      } catch {
        // ignore
      }
      currentDay = today;
    }
    try {
      if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
        fs.renameSync(file, path.join(LOG_DIR, `${name}-${currentDay}-${Date.now()}.log`));
      }
    } catch {
      // ignore
    }
    if (Date.now() - lastCleanup > 3600000) {
      lastCleanup = Date.now();
      cleanupLogs(name, keepDays);
    }
  }

  function write(level, args) {
    const message = args
      .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
      .join(' ');
    const line = `[${new Date().toISOString()}] [${level}] ${message}`;
    rotateIfNeeded();
    try {
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch {
      // ignore disk errors
    }
    if (toConsole) {
      const stream = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
      stream(line);
    }
  }

  return {
    file,
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
    debug: (...args) => write('DEBUG', args),
    log: (...args) => write('INFO', args)
  };
}
