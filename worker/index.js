/* ============================================================
   《了凡四训》逐句精读 —— Cloudflare Worker

   职责：
   1. 托管静态站点（Vite 无关，纯静态，由 tools/build_site.py 组装到 dist/）
   2. /api/auth/*    ：账号注册、登录、登出、查询会话
   3. /api/reading   ：同步阅读进度与个人笔记

   与 ESAT（esatmock.redwallen.cn）共用同一套账号：
   - 绑定同一个 D1 数据库 esat-account-data，直接读写它已有的 users / sessions 表
   - 会话 Cookie 同名（esat_session）、同域（.redwallen.cn）
   因此任一站登录，另一站即为已登录状态。

   密码哈希参数必须与 ESAT 完全一致，否则无法互相登录：
   PBKDF2-SHA256 / 100000 次迭代 / 每人 16 字节随机盐 / 输出 32 字节
   ============================================================ */

import { gateState, blockPage, blockedResponse, isBlockPagePath } from './region-gate.js';

const COOKIE = 'esat_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const SESSION_LIMIT_PER_USER = 10;

/** 账号体系所在域，两个站点共享 */
const SHARED_COOKIE_DOMAIN = '.redwallen.cn';

const SECTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_SECTIONS = 400;
const MAX_NOTE_LENGTH = 20000;
const MAX_REVEALED = 500;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------ 基础工具 ------------------------------ */

function json(data, status = 200, headers) {
  const h = new Headers(headers);
  h.set('Content-Type', 'application/json; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(data), { status, headers: h });
}

function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(value) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) throw new Error('Invalid hex value');
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function randomHex(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function hashPassword(password, saltHex, iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new ApiError(400, '请输入有效的邮箱地址。');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, '请输入有效的邮箱地址。');
  }
  return email;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new ApiError(400, '密码长度需为 8 到 128 个字符。');
  }
  return value;
}

async function readJson(request, maxBytes = 16384) {
  if (!(request.headers.get('Content-Type') || '').toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, '请使用 application/json 提交。');
  }
  const declared = Number(request.headers.get('Content-Length') || '0');
  if (declared > maxBytes) throw new ApiError(413, '请求内容过大。');
  const reader = request.body && request.body.getReader();
  if (!reader) throw new ApiError(400, '请求内容不是合法的 JSON。');
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, '请求内容过大。');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, '请求内容不是合法的 JSON。');
  }
}

/* ------------------------------ 会话与 Cookie ------------------------------ */

function cookieValue(request) {
  const header = request.headers.get('Cookie') || '';
  for (const item of header.split(';')) {
    const [name, ...rest] = item.trim().split('=');
    if (name === COOKIE) return rest.join('=') || null;
  }
  return null;
}

/** 只有在 redwallen.cn 及其子域下才加 Domain，本地开发时保持 host-only */
function sharedDomainSuffix(request) {
  const host = new URL(request.url).hostname;
  if (host === 'redwallen.cn' || host.endsWith('.redwallen.cn')) {
    return '; Domain=' + SHARED_COOKIE_DOMAIN;
  }
  return '';
}

function sessionCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return COOKIE + '=' + token + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + sharedDomainSuffix(request) + secure;
}

// 与 ESAT 约定好的标记 Cookie，让两边都能一眼看出「共享域的会话已经下发过了」
const SHARED_MARKER = 'esat_shared';

function markerCookie(request, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return SHARED_MARKER + '=1; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + sharedDomainSuffix(request) + secure;
}

function publicUser(row) {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

async function createSession(env, request, user) {
  const token = randomHex(32);
  const tokenHash = await sha256(token);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare(
      'DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)',
    ).bind(user.id, user.id, SESSION_LIMIT_PER_USER - 1),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(tokenHash, user.id, now, now + SESSION_TTL_MS),
  ]);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const response = json({ user: publicUser(user) });
  response.headers.append('Set-Cookie', sessionCookie(request, token, maxAge));
  response.headers.append('Set-Cookie', markerCookie(request, maxAge));
  return response;
}

async function authenticatedUser(env, request) {
  const token = cookieValue(request);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT users.id, users.email, users.created_at
       FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  ).bind(tokenHash, Date.now()).first();
  return row || null;
}

async function requireUser(env, request) {
  const user = await authenticatedUser(env, request);
  if (!user) throw new ApiError(401, '请先登录。');
  return user;
}

/* ------------------------------ 认证接口 ------------------------------ */

async function signup(env, request) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  const salt = randomHex(16);
  const passwordHash = await hashPassword(password, salt);
  const user = { id: crypto.randomUUID(), email, created_at: Date.now() };
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, password_salt, password_algorithm, password_iterations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(user.id, user.email, passwordHash, salt, 'PBKDF2-SHA256', PBKDF2_ITERATIONS, user.created_at).run();
  } catch (error) {
    if (String(error).toLowerCase().includes('unique')) {
      throw new ApiError(409, '这个邮箱已经注册过了，直接登录即可。');
    }
    throw error;
  }
  return createSession(env, request, user);
}

async function login(env, request) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  const row = await env.DB.prepare(
    `SELECT id, email, password_hash, password_salt, password_algorithm, password_iterations, created_at
       FROM users WHERE email = ?`,
  ).bind(email).first();
  if (!row || row.password_algorithm !== 'PBKDF2-SHA256') throw new ApiError(401, '邮箱或密码不正确。');
  const candidate = await hashPassword(password, row.password_salt, row.password_iterations);
  if (!constantTimeEqual(candidate, row.password_hash)) throw new ApiError(401, '邮箱或密码不正确。');
  return createSession(env, request, row);
}

async function logout(env, request) {
  const token = cookieValue(request);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  }
  const response = json({ ok: true });
  response.headers.append('Set-Cookie', sessionCookie(request, '', 0));
  response.headers.append('Set-Cookie', markerCookie(request, 0));
  return response;
}

/* ------------------------------ 阅读进度同步 ------------------------------ */

function parseSectionId(value) {
  if (typeof value !== 'string' || !SECTION_ID_PATTERN.test(value)) return null;
  return value;
}

function parseTimestamp(value) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return null;
  return Math.floor(value);
}

function parseRevealed(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const n of value) {
    if (!Number.isInteger(n) || n < 0 || n > 999) continue;
    if (!out.includes(n)) out.push(n);
    if (out.length >= MAX_REVEALED) break;
  }
  return out;
}

/** 把请求里的增量整理成可写入的行；非法条目直接忽略而不是整单失败 */
function normalizeProgressPatch(raw) {
  const rows = [];
  if (!raw || typeof raw !== 'object') return rows;
  for (const [id, value] of Object.entries(raw)) {
    if (rows.length >= MAX_SECTIONS) break;
    const sectionId = parseSectionId(id);
    if (!sectionId || !value || typeof value !== 'object') continue;
    const updatedAt = parseTimestamp(value.updatedAt);
    if (updatedAt === null) continue;
    const pos = Number.isInteger(value.pos) && value.pos >= 0 && value.pos < 1000 ? value.pos : 0;
    rows.push({
      sectionId,
      done: value.done ? 1 : 0,
      pos,
      revealed: JSON.stringify(parseRevealed(value.revealed)),
      updatedAt,
    });
  }
  return rows;
}

function normalizeNotesPatch(raw) {
  const rows = [];
  if (!raw || typeof raw !== 'object') return rows;
  for (const [id, value] of Object.entries(raw)) {
    if (rows.length >= MAX_SECTIONS) break;
    const sectionId = parseSectionId(id);
    if (!sectionId || !value || typeof value !== 'object') continue;
    const updatedAt = parseTimestamp(value.updatedAt);
    if (updatedAt === null) continue;
    const text = typeof value.text === 'string' ? value.text.slice(0, MAX_NOTE_LENGTH) : '';
    rows.push({ sectionId, text, updatedAt });
  }
  return rows;
}

/** 读取该用户的全部数据，整理成前端使用的形状 */
async function readAll(env, userId) {
  const [progressResult, notesResult] = await Promise.all([
    env.DB.prepare('SELECT section_id, done, pos, revealed, updated_at FROM lf_progress WHERE user_id = ?')
      .bind(userId).all(),
    env.DB.prepare('SELECT section_id, text, updated_at FROM lf_notes WHERE user_id = ?')
      .bind(userId).all(),
  ]);

  const progress = {};
  for (const row of progressResult.results || []) {
    let revealed = [];
    try { revealed = parseRevealed(JSON.parse(row.revealed)); } catch { revealed = []; }
    progress[row.section_id] = {
      done: !!row.done,
      pos: row.pos,
      revealed,
      updatedAt: row.updated_at,
    };
  }
  const notes = {};
  for (const row of notesResult.results || []) {
    notes[row.section_id] = { text: row.text, updatedAt: row.updated_at };
  }
  return { progress, notes };
}

async function getReading(env, request) {
  const user = await requireUser(env, request);
  return json(await readAll(env, user.id));
}

/** 清除该用户的全部阅读进度与笔记（前端「清除全部」按钮用） */
async function clearReading(env, request) {
  const user = await requireUser(env, request);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM lf_progress WHERE user_id = ?').bind(user.id),
    env.DB.prepare('DELETE FROM lf_notes WHERE user_id = ?').bind(user.id),
  ]);
  return json({ progress: {}, notes: {} });
}

async function saveReading(env, request) {
  const user = await requireUser(env, request);
  const body = await readJson(request, 524288);
  const progressRows = normalizeProgressPatch(body.progress);
  const noteRows = normalizeNotesPatch(body.notes);

  const statements = [];

  for (const row of progressRows) {
    // 逐节「较新者胜」，避免多设备之间互相覆盖
    statements.push(env.DB.prepare(
      `INSERT INTO lf_progress (user_id, section_id, done, pos, revealed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, section_id) DO UPDATE SET
         done = excluded.done,
         pos = excluded.pos,
         revealed = excluded.revealed,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > lf_progress.updated_at`,
    ).bind(user.id, row.sectionId, row.done, row.pos, row.revealed, row.updatedAt));
  }

  for (const row of noteRows) {
    // 空文本保留为「已删除」的墓碑记录，否则另一台设备会把旧笔记又传回来
    statements.push(env.DB.prepare(
      `INSERT INTO lf_notes (user_id, section_id, text, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, section_id) DO UPDATE SET
         text = excluded.text,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at > lf_notes.updated_at`,
    ).bind(user.id, row.sectionId, row.text, row.updatedAt));
  }

  if (statements.length) await env.DB.batch(statements);

  // 回传合并后的完整状态，前端直接以此为准
  return json(await readAll(env, user.id));
}

/* ------------------------------ 路由 ------------------------------ */

function verifySameOrigin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError(403, '已拒绝跨站请求。');
  }
}

async function api(env, request) {
  verifySameOrigin(request);
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (method === 'POST' && (path === '/api/auth/login' || path === '/api/auth/signup')) {
    // 绑定了速率限制就用；没绑定（本地开发等）则跳过
    if (env.AUTH_RATE_LIMITER) {
      const actor = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.AUTH_RATE_LIMITER.limit({ key: path + ':' + actor });
      if (!success) throw new ApiError(429, '尝试次数过多，请稍后再试。');
    }
  }

  if (method === 'GET' && path === '/api/auth/session') {
    const user = await authenticatedUser(env, request);
    return json({ user: user ? publicUser(user) : null });
  }
  if (method === 'POST' && path === '/api/auth/signup') return signup(env, request);
  if (method === 'POST' && path === '/api/auth/login') return login(env, request);
  if (method === 'POST' && path === '/api/auth/logout') return logout(env, request);

  if (method === 'GET' && path === '/api/reading') return getReading(env, request);
  if (method === 'POST' && path === '/api/reading') return saveReading(env, request);
  if (method === 'DELETE' && path === '/api/reading') return clearReading(env, request);

  throw new ApiError(404, '接口不存在。');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 地区门禁：只放行中国大陆，其他地区跳到 /unavailable。
    // 必须在 ASSETS 之前判断，所以 wrangler.jsonc 用 run_worker_first: true。
    const state = gateState(request, env);
    if (isBlockPagePath(url.pathname)) return blockPage(state);
    if (state.blocked) return blockedResponse(request, state);

    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(env, request);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: '服务暂时不可用，请稍后再试。' }, 500);
    }
  },
};
