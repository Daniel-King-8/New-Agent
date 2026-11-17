import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR,
  LOG_DIR,
  decryptSecret,
  exportConfig,
  getConfig,
  hashPassword,
  publicConfig,
  randomPassword,
  randomToken,
  saveConfig,
  verifyPassword
} from './config.mjs';
import {
  createAgent,
  deleteAgent,
  getAgentInternal,
  getTeam,
  testAgentConnection,
  updateAgent,
  updateCaptain
} from './team.mjs';
import { listModels } from './providers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(ROOT, 'web', 'admin');
const COOKIE_NAME = 'captain_admin';
const SESSION_TTL_MS = 24 * 3600 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}

function fail(res, status, error) {
  sendJson(res, status, { ok: false, error: String(error || 'error') });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON 格式错误'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function setCookie(res, token) {
  res.setHeader('set-cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearCookie(res) {
  res.setHeader('set-cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'"
  );
}

function serveStatic(res, filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(WEB_ROOT))) {
      fail(res, 404, 'Not found');
      return;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      fail(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=300'
    });
    res.end(fs.readFileSync(resolved));
  } catch {
    fail(res, 404, 'Not found');
  }
}

function readLogs(service, lines = 200, query = '') {
  const allowed = new Set(['core', 'admin']);
  if (!allowed.has(service)) service = 'core';
  const files = [];
  try {
    for (const entry of fs.readdirSync(LOG_DIR)) {
      if (entry === `${service}.log` || entry.startsWith(`${service}-`)) {
        const full = path.join(LOG_DIR, entry);
        files.push({ full, mtime: fs.statSync(full).mtimeMs });
      }
    }
  } catch {
    return [];
  }
  files.sort((a, b) => a.mtime - b.mtime);
  let collected = [];
  for (const file of files) {
    try {
      collected = collected.concat(fs.readFileSync(file.full, 'utf8').split(/\r?\n/).filter(Boolean));
    } catch {
      // ignore
    }
  }
  if (query) {
    const q = String(query).toLowerCase();
    collected = collected.filter((line) => line.toLowerCase().includes(q));
  }
  return collected.slice(-Math.min(2000, Math.max(10, Number(lines) || 200)));
}

async function proxyNapcat(req, res) {
  const cfg = getConfig().channels.qq;
  if (!cfg.webuiUrl) return fail(res, 400, '未配置 NapCat WebUI 地址');
  const incoming = new URL(req.url, 'http://localhost');
  const suffix = incoming.pathname.replace(/^\/napcat/, '') || '/';
  const target = new URL(suffix + incoming.search, cfg.webuiUrl);
  try {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (['host', 'content-length', 'connection', 'accept-encoding'].includes(key.toLowerCase())) continue;
      headers[key] = value;
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise((resolve) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
    const upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual' });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseHeaders = {};
    for (const [key, value] of upstream.headers.entries()) {
      if (['content-encoding', 'content-length', 'transfer-encoding'].includes(key.toLowerCase())) continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstream.status, responseHeaders);
    res.end(buffer);
  } catch (error) {
    fail(res, 502, `NapCat WebUI 代理失败: ${error.message}`);
  }
}

export function createAdminApp({ core, logger }) {
  const sessions = new Map();
  const loginFailures = new Map();

  function ensureAdminPassword() {
    const cfg = getConfig();
    if (cfg.auth.passwordHash) return null;
    const password = randomPassword(16);
    saveConfig({ auth: { passwordHash: hashPassword(password), mustChange: true } });
    logger.warn('==============================================');
    logger.warn(`初始后台密码: ${password}`);
    logger.warn('请登录后立即修改密码。');
    logger.warn('==============================================');
    return password;
  }

  function validSession(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return { token, ...session };
  }

  function requireAuth(req, res) {
    const session = validSession(req);
    if (!session) {
      fail(res, 401, '未登录');
      return null;
    }
    return session;
  }

  function loginBlocked(ip) {
    const entry = loginFailures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.first > 10 * 60000) {
      loginFailures.delete(ip);
      return false;
    }
    return entry.count >= 5;
  }

  function noteLoginFailure(ip) {
    const entry = loginFailures.get(ip);
    if (!entry || Date.now() - entry.first > 10 * 60000) {
      loginFailures.set(ip, { count: 1, first: Date.now() });
    } else {
      entry.count += 1;
    }
  }

  function routeApi(req, res, url) {
    return (async () => {
      const method = req.method || 'GET';
      const pathname = url.pathname;

      if (method === 'POST' && pathname === '/api/login') {
        const ip = clientIp(req);
        if (loginBlocked(ip)) return fail(res, 429, '尝试次数过多，请 10 分钟后再试');
        const body = await readBody(req);
        const cfg = getConfig();
        if (!cfg.auth.passwordHash) {
          ensureAdminPassword();
          return fail(res, 401, '已生成初始密码，请查看容器日志');
        }
        if (!verifyPassword(body?.password || '', cfg.auth.passwordHash)) {
          noteLoginFailure(ip);
          return fail(res, 401, '密码错误');
        }
        loginFailures.delete(ip);
        const token = randomToken(32);
        sessions.set(token, { username: cfg.auth.username || 'admin', expiresAt: Date.now() + SESSION_TTL_MS });
        setCookie(res, token);
        return ok(res, { authenticated: true, mustChange: cfg.auth.mustChange === true });
      }

      if (method === 'POST' && pathname === '/api/logout') {
        const token = parseCookies(req)[COOKIE_NAME];
        if (token) sessions.delete(token);
        clearCookie(res);
        return ok(res, { authenticated: false });
      }

      if (method === 'GET' && pathname === '/api/session') {
        const session = validSession(req);
        return ok(res, {
          authenticated: Boolean(session),
          username: session?.username || '',
          mustChange: getConfig().auth.mustChange === true
        });
      }

      if (method === 'GET' && pathname === '/healthz') {
        return ok(res, { ok: true, service: 'captain-admin' });
      }

      if (method === 'GET' && pathname === '/api/status') {
        if (!requireAuth(req, res)) return;
        const status = await core.getStatus();
        return ok(res, status);
      }

      if (method === 'GET' && pathname === '/api/config') {
        if (!requireAuth(req, res)) return;
        return ok(res, publicConfig());
      }

      if (method === 'PUT' && pathname === '/api/config') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const patch = { ...(body || {}) };
        delete patch.auth;
        delete patch.server;
        delete patch.team;
        saveConfig(patch);
        logger.info('后台配置已保存');
        setTimeout(() => core.reload().catch((error) => logger.error(`重载失败: ${error.message}`)), 200);
        return ok(res, publicConfig());
      }

      if (method === 'POST' && pathname === '/api/password') {
        const session = requireAuth(req, res);
        if (!session) return;
        const body = await readBody(req);
        const password = String(body?.password || '');
        if (password.length < 8) return fail(res, 400, '密码至少 8 位');
        saveConfig({ auth: { passwordHash: hashPassword(password), mustChange: false } });
        for (const [token, value] of sessions) {
          if (token !== session.token) sessions.delete(token);
        }
        logger.info('后台密码已修改');
        return ok(res, { changed: true });
      }

      if (method === 'GET' && pathname === '/api/agents') {
        if (!requireAuth(req, res)) return;
        return ok(res, getTeam());
      }

      if (method === 'POST' && pathname === '/api/agents/reveal-key') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const id = String(body?.id || '');
        const agent = getAgentInternal(id);
        if (!agent) return fail(res, 404, '员工不存在');
        if (!agent.apiKey) return fail(res, 400, '该员工没有配置 API Key');
        logger.info(`查看 API Key: ${agent.id}`);
        return ok(res, { id: agent.id, apiKey: decryptSecret(agent.apiKey) });
      }

      if (method === 'POST' && pathname === '/api/agents') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const result = createAgent(body || {});
        logger.info(`新增员工: ${result.agent.name} (${result.agent.id})`);
        core.syncAgentProfileById(result.agent.id).catch((error) => logger.warn(`Hermes profile 同步失败: ${error.message}`));
        return ok(res, result);
      }

      const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (agentMatch && method === 'PUT') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const result = updateAgent(decodeURIComponent(agentMatch[1]), body || {});
        logger.info(`更新员工: ${result.agent.name}`);
        core.syncAgentProfileById(result.agent.id).catch((error) => logger.warn(`Hermes profile 同步失败: ${error.message}`));
        return ok(res, result);
      }
      if (agentMatch && method === 'DELETE') {
        if (!requireAuth(req, res)) return;
        const removed = deleteAgent(decodeURIComponent(agentMatch[1]));
        logger.info(`删除员工: ${removed.name}`);
        core.hermes.deleteAgentProfile(removed).catch((error) => logger.warn(`删除 Hermes profile 失败: ${error.message}`));
        return ok(res, removed);
      }

      if (method === 'POST' && pathname === '/api/agents/test') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const current = body?.id ? getAgentInternal(body.id) : null;
        const merged = {
          ...(current || {}),
          ...(body || {}),
          apiKey: body?.apiKey && !body.apiKey?.includes?.('****')
            ? body.apiKey
            : current?.apiKey || ''
        };
        const result = await testAgentConnection(merged);
        return ok(res, result);
      }

      if (method === 'PUT' && pathname === '/api/captain') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const result = updateCaptain(body || {});
        logger.info('主管配置已更新');
        core.syncAgentProfileById('captain').catch((error) => logger.warn(`主管 Hermes profile 同步失败: ${error.message}`));
        return ok(res, result);
      }

      if (method === 'POST' && pathname === '/api/captain/test') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const current = getAgentInternal('captain');
        const merged = {
          ...current,
          ...(body || {}),
          apiKey: body?.apiKey && !body.apiKey?.includes?.('****')
            ? body.apiKey
            : current?.apiKey || ''
        };
        const result = await testAgentConnection(merged);
        return ok(res, result);
      }

      if (method === 'GET' && pathname === '/api/runs') {
        if (!requireAuth(req, res)) return;
        const limit = Number(url.searchParams.get('limit') || 50);
        return ok(res, core.listRuns(limit));
      }

      const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch && method === 'GET') {
        if (!requireAuth(req, res)) return;
        const run = core.getRun(decodeURIComponent(runMatch[1]));
        if (!run) return fail(res, 404, '任务不存在');
        return ok(res, run);
      }

      if (method === 'POST' && pathname === '/api/chat') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const reply = await core.handleWebChat(body?.text || '');
        return ok(res, { reply });
      }

      if (method === 'GET' && pathname === '/api/logs') {
        if (!requireAuth(req, res)) return;
        const service = url.searchParams.get('svc') || 'core';
        const lines = Number(url.searchParams.get('lines') || 200);
        const q = url.searchParams.get('q') || '';
        return ok(res, { service, lines: readLogs(service, lines, q) });
      }

      if (method === 'POST' && pathname === '/api/models') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        let apiKey = String(body?.apiKey || '');
        if ((!apiKey || apiKey.includes('****')) && body?.id) {
          const agent = getAgentInternal(String(body.id));
          apiKey = agent ? decryptSecret(agent.apiKey || '') : '';
        }
        if (!apiKey && !String(body?.provider || '').toLowerCase().includes('edge')) {
          return fail(res, 400, '请先填写 API Key');
        }
        const result = await listModels({
          provider: body?.provider,
          baseUrl: body?.baseUrl,
          apiKey,
          kind: body?.kind
        });
        return ok(res, result);
      }

      if (method === 'GET' && pathname === '/api/hermes/health') {
        if (!requireAuth(req, res)) return;
        return ok(res, await core.hermes.health());
      }

      if (method === 'GET' && pathname === '/api/hermes/models') {
        if (!requireAuth(req, res)) return;
        try {
          return ok(res, await core.hermes.models());
        } catch (error) {
          return fail(res, 502, error.message);
        }
      }

      if (method === 'GET' && pathname === '/api/export') {
        if (!requireAuth(req, res)) return;
        const full = url.searchParams.get('secrets') === 'full';
        const cfg = exportConfig({ includeSecrets: full });
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="captain-config.json"',
          'cache-control': 'no-store'
        });
        res.end(JSON.stringify(cfg, null, 2));
        return;
      }

      if (method === 'POST' && pathname === '/api/import') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req, 5 * 1024 * 1024);
        saveConfig(body || {}, { merge: false });
        logger.info('配置已导入');
        setTimeout(() => core.reload().catch((error) => logger.error(`重载失败: ${error.message}`)), 200);
        return ok(res, publicConfig());
      }

      if (method === 'POST' && pathname === '/api/restart') {
        if (!requireAuth(req, res)) return;
        ok(res, { restarting: true });
        logger.warn('后台请求重启进程');
        setTimeout(() => process.exit(0), 300);
        return;
      }

      return fail(res, 404, 'API 不存在');
    })().catch((error) => {
      logger.error(`API 错误 ${req.method} ${url.pathname}: ${error.stack || error.message}`);
      fail(res, error.statusCode || 500, error.message);
    });
  }

  const server = http.createServer((req, res) => {
    securityHeaders(res);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/healthz') {
      return ok(res, { ok: true, service: 'captain-admin' });
    }
    if (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/index.html') {
      return serveStatic(res, path.join(WEB_ROOT, 'index.html'));
    }
    if (url.pathname.startsWith('/napcat')) {
      if (!requireAuth(req, res)) return;
      return proxyNapcat(req, res);
    }
    if (url.pathname.startsWith('/api/')) {
      return routeApi(req, res, url);
    }
    if (url.pathname.startsWith('/assets/')) {
      return serveStatic(res, path.join(WEB_ROOT, url.pathname.replace(/^\/+/, '')));
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    return serveStatic(res, path.join(WEB_ROOT, 'index.html'));
  });

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (session.expiresAt < now) sessions.delete(token);
    }
  }, 10 * 60000);
  cleanup.unref?.();

  return {
    server,
    ensureAdminPassword,
    sessions
  };
}
