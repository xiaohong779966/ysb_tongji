'use strict';

/**
 * 节假日值班报名系统 —— 零依赖 Node.js 服务
 * 运行环境：Node.js >= 22（使用内置 node:sqlite，无需 npm install）
 */

// node:sqlite 需要 Node.js 23.4 以上（推荐 Node.js 24 LTS）
const [nMajor, nMinor] = process.versions.node.split('.').map(Number);
if (nMajor < 23 || (nMajor === 23 && nMinor < 4)) {
  console.error('运行环境需要 Node.js 23.4 或更高版本（推荐 Node.js 24 LTS），当前版本：' + process.versions.node);
  console.error('请升级 Node.js 后重试。');
  process.exit(1);
}

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config.js');

/* ===================== 基础配置 ===================== */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim(); // 可选：设置后查看/报名需要邀请码
const TRUST_PROXY = process.env.TRUST_PROXY === '1';       // 放在 Nginx 后面时设为 1，用于取真实 IP

fs.mkdirSync(DATA_DIR, { recursive: true });

function readOrCreateSecret(file, bytes) {
  const p = path.join(DATA_DIR, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  const v = crypto.randomBytes(bytes).toString('base64url');
  fs.writeFileSync(p, v, { mode: 0o600 });
  return v;
}

const SESSION_SECRET = process.env.SESSION_SECRET || readOrCreateSecret('session-secret.txt', 32);

const ADMIN_PASSWORD = (() => {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const p = path.join(DATA_DIR, 'admin-password.txt');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  const v = crypto.randomBytes(8).toString('base64url');
  fs.writeFileSync(p, v, { mode: 0o600 });
  console.log('[初始化] 已生成管理密码，保存在 ' + p);
  console.log('[初始化] 本次管理密码：' + v);
  return v;
})();

/* ===================== 日期 / 班次规则 ===================== */

const SHIFTS = config.shifts.map((s) => ({ key: s.key, limit: Number(s.limit) }));
const SHIFT_KEYS = SHIFTS.map((s) => s.key);
const TOTAL_LIMIT = SHIFTS.reduce((sum, s) => sum + s.limit, 0); // 每天总人数上限 = 3

const DAYS = [];
config.groups.forEach((g) => g.days.forEach((d) => DAYS.push({ ...d, group: g.name })));
const DAY_MAP = new Map(DAYS.map((d) => [d.date, d]));

const MSG = {
  SHIFT_FULL: '该班次报名人数已满，请选择其他班次',
  DATE_FULL: '该日期报名人数已满，请选择其他日期'
};

/* ===================== 数据库 ===================== */

const db = new DatabaseSync(path.join(DATA_DIR, 'duty.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS signups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL,
    shift      TEXT NOT NULL,
    name       TEXT NOT NULL,
    dept       TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    ip         TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_signups_date_name ON signups(date, name);
  CREATE INDEX IF NOT EXISTS idx_signups_date_shift ON signups(date, shift);
`);

const stmt = {
  insert: db.prepare('INSERT INTO signups (date, shift, name, dept, phone, created_at, ip) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  byDate: db.prepare('SELECT id, date, shift, name, dept, phone, created_at, ip FROM signups WHERE date = ? ORDER BY shift, id'),
  all: db.prepare('SELECT id, date, shift, name, dept, phone, created_at, ip FROM signups ORDER BY date, shift, id'),
  find: db.prepare('SELECT id, shift, phone FROM signups WHERE date = ? AND name = ?'),
  countDate: db.prepare('SELECT COUNT(*) AS n FROM signups WHERE date = ?'),
  countShift: db.prepare('SELECT COUNT(*) AS n FROM signups WHERE date = ? AND shift = ?'),
  byId: db.prepare('SELECT id, date, shift, name, phone FROM signups WHERE id = ?'),
  del: db.prepare('DELETE FROM signups WHERE id = ?'),
  delAll: db.prepare('DELETE FROM signups'),
  mine: db.prepare('SELECT id, date, shift, name, dept FROM signups WHERE name = ? AND phone = ? ORDER BY date')
};

/* ===================== 工具函数 ===================== */

function clean(v, max) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
}

function validPhone(p) {
  return /^1[3-9]\d{9}$/.test(p);
}

function nowText() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/* ---- 会话（HMAC 签名 cookie，无状态） ---- */

const SESSION_MS = 12 * 3600 * 1000;

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function newSession() {
  const exp = String(Date.now() + SESSION_MS);
  return exp + '.' + sign(exp);
}

function sessionValid(token) {
  if (!token || token.indexOf('.') < 0) return false;
  const [exp, sig] = token.split('.');
  const expect = sign(exp);
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  return Number(exp) > Date.now();
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isAdmin(req) {
  return sessionValid(parseCookies(req).admin);
}

/* ---- 简易限流 ---- */

const hits = new Map();
function rateLimited(ip, key, max, windowMs) {
  const k = key + '|' + ip;
  const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(k, arr);
  return arr.length > max;
}
setInterval(() => {
  const now = Date.now();
  hits.forEach((arr, k) => { if (!arr.some((t) => now - t < 60 * 60 * 1000)) hits.delete(k); });
}, 10 * 60 * 1000).unref();

/* ---- 响应 ---- */

function sendJson(res, code, obj, headers) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, securityHeaders(), headers || {}));
  res.end(body);
}

function fail(res, code, msg, extra) {
  sendJson(res, code, Object.assign({ ok: false, message: msg }, extra || {}));
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 32 * 1024)) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('请求格式不正确')); }
    });
    req.on('error', reject);
  });
}

/* ===================== 报名核心逻辑 ===================== */

/**
 * 唯一的报名入口，所有规则都在这里校验（前端只是提示，服务端说了算）。
 * 返回 { ok:true } 或 { ok:false, code, message }
 */
function createSignup(input, ip) {
  const date = clean(input.date, 10);
  const shift = clean(input.shift, 10);
  const name = clean(input.name, 20);
  const dept = clean(input.dept, 30);
  const phone = clean(input.phone, 20);

  if (!DAY_MAP.has(date)) return { ok: false, code: 'BAD_DATE', message: '报名日期不在本次值班安排范围内' };
  if (SHIFT_KEYS.indexOf(shift) < 0) return { ok: false, code: 'BAD_SHIFT', message: '请选择要报名的班次' };
  if (!name) return { ok: false, code: 'BAD_NAME', message: '请填写姓名' };
  if (name.length > 20) return { ok: false, code: 'BAD_NAME', message: '姓名过长' };
  if (!validPhone(phone)) return { ok: false, code: 'BAD_PHONE', message: '请填写正确的 11 位手机号' };

  const shiftDef = SHIFTS.find((s) => s.key === shift);

  db.exec('BEGIN IMMEDIATE');
  try {
    // 规则一：同一员工同一日期只能报名一个班次
    const dup = stmt.find.get(date, name);
    if (dup) {
      db.exec('COMMIT');
      return { ok: false, code: 'DUPLICATE', message: '同一员工同一日期只能报名一个班次，' + name + ' 已报名' + DAY_MAP.get(date).text + '的' + dup.shift };
    }

    // 规则二：整个日期已满（中班2人 + 晚班1人）
    if (stmt.countDate.get(date).n >= TOTAL_LIMIT) {
      db.exec('COMMIT');
      return { ok: false, code: 'DATE_FULL', message: MSG.DATE_FULL };
    }

    // 规则三：该班次已满
    if (stmt.countShift.get(date, shift).n >= shiftDef.limit) {
      db.exec('COMMIT');
      return { ok: false, code: 'SHIFT_FULL', message: MSG.SHIFT_FULL };
    }

    stmt.insert.run(date, shift, name, dept, phone, nowText(), ip || '');
    db.exec('COMMIT');
    return { ok: true, message: '报名成功：' + DAY_MAP.get(date).text + ' ' + shift, day: DAY_MAP.get(date), shift };
  } catch (e) {
    db.exec('ROLLBACK');
    if (String(e.message).indexOf('UNIQUE') >= 0) {
      return { ok: false, code: 'DUPLICATE', message: '同一员工同一日期只能报名一个班次' };
    }
    throw e;
  }
}

function buildBoard(includePersonal) {
  const rows = stmt.all.all();
  const byDate = {};
  DAYS.forEach((d) => {
    byDate[d.date] = { total: 0 };
    SHIFTS.forEach((s) => { byDate[d.date][s.key] = []; });
  });
  rows.forEach((r) => {
    if (!byDate[r.date]) return;
    const item = includePersonal
      ? { id: r.id, name: r.name, dept: r.dept, phone: r.phone, at: r.created_at, ip: r.ip }
      : { id: r.id, name: r.name, dept: r.dept };
    byDate[r.date][r.shift].push(item);
    byDate[r.date].total++;
  });
  return { groups: config.groups, shifts: SHIFTS, totalLimit: TOTAL_LIMIT, days: DAYS, board: byDate };
}

function csvEscape(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}

function exportCsv() {
  const rows = stmt.all.all();
  const head = ['节日', '日期', '星期', '班次', '姓名', '科室', '手机号', '报名时间'].map(csvEscape).join(',');
  if (!rows.length) return '\ufeff' + head;
  const lines = rows.map((r) => {
    const d = DAY_MAP.get(r.date) || {};
    return [d.group || '', d.text || r.date, d.week || '', r.shift, r.name, r.dept, r.phone, r.created_at].map(csvEscape).join(',');
  });
  return '\ufeff' + head + '\r\n' + lines.join('\r\n');
}

/* ===================== 静态文件 ===================== */

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, securityHeaders())); res.end('未找到页面'); return; }
    res.writeHead(200, Object.assign({
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache'
    }, securityHeaders()));
    res.end(buf);
  });
}

/* ===================== 路由 ===================== */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  const ip = clientIp(req);

  try {
    /* ---- 页面 ---- */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    if (req.method === 'GET' && (p === '/admin' || p === '/admin.html')) return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    /* ---- 邀请码校验 ---- */
    const needCode = ACCESS_CODE && p.indexOf('/api/') === 0 && !isAdmin(req);
    if (needCode) {
      const given = String(req.headers['x-access-code'] || url.searchParams.get('code') || '');
      if (given !== ACCESS_CODE) return fail(res, 401, '需要邀请码才能查看和报名', { code: 'NEED_CODE' });
    }

    /* ---- 公开接口 ---- */
    if (req.method === 'GET' && p === '/api/health') return sendJson(res, 200, { ok: true, time: nowText() });

    if (req.method === 'GET' && p === '/api/board') {
      const data = buildBoard(false);
      data.ok = true;
      data.title = config.siteTitle;
      return sendJson(res, 200, data);
    }

    if (req.method === 'POST' && p === '/api/signup') {
      if (rateLimited(ip, 'signup', 30, 60 * 1000)) return fail(res, 429, '操作过于频繁，请稍后再试');
      const body = await readBody(req);
      const r = createSignup(body, ip);
      return sendJson(res, r.ok ? 200 : (r.code === 'SHIFT_FULL' || r.code === 'DATE_FULL' || r.code === 'DUPLICATE' ? 409 : 400), r);
    }

    if (req.method === 'POST' && p === '/api/my') {
      if (rateLimited(ip, 'my', 60, 60 * 1000)) return fail(res, 429, '操作过于频繁，请稍后再试');
      const body = await readBody(req);
      const name = clean(body.name, 20);
      const phone = clean(body.phone, 20);
      if (!name || !validPhone(phone)) return fail(res, 400, '请填写姓名和报名时使用的手机号');
      const list = stmt.mine.all(name, phone).map((r) => {
        const d = DAY_MAP.get(r.date) || {};
        return { id: r.id, date: r.date, text: d.text || r.date, week: d.week || '', shift: r.shift };
      });
      return sendJson(res, 200, { ok: true, list });
    }

    // 本人取消报名：姓名 + 手机号必须与报名时一致
    if (req.method === 'POST' && p === '/api/cancel') {
      if (rateLimited(ip, 'cancel', 30, 60 * 1000)) return fail(res, 429, '操作过于频繁，请稍后再试');
      const body = await readBody(req);
      const id = Number(body.id);
      const name = clean(body.name, 20);
      const phone = clean(body.phone, 20);
      const row = stmt.byId.get(id);
      if (!row || row.name !== name || row.phone !== phone) return fail(res, 403, '取消失败：姓名或手机号与报名时不一致');
      stmt.del.run(id);
      const d = DAY_MAP.get(row.date) || {};
      return sendJson(res, 200, { ok: true, message: '已取消 ' + (d.text || row.date) + ' 的' + row.shift + '报名' });
    }

    /* ---- 管理接口 ---- */
    if (req.method === 'POST' && p === '/api/admin/login') {
      if (rateLimited(ip, 'login', 10, 5 * 60 * 1000)) return fail(res, 429, '尝试次数过多，请 5 分钟后再试');
      const body = await readBody(req);
      const pass = String(body.password || '');
      const ok = pass.length === ADMIN_PASSWORD.length &&
                 crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(ADMIN_PASSWORD));
      if (!ok) return fail(res, 401, '管理密码不正确');
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': 'admin=' + newSession() + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (SESSION_MS / 1000) + (req.socket.encrypted ? '; Secure' : '')
      });
    }

    if (req.method === 'POST' && p === '/api/admin/logout') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
    }

    if (p.indexOf('/api/admin/') === 0) {
      if (!isAdmin(req)) return fail(res, 401, '请先登录管理后台', { code: 'NEED_LOGIN' });

      if (req.method === 'GET' && p === '/api/admin/board') {
        const data = buildBoard(true);
        data.ok = true;
        data.title = config.siteTitle;
        return sendJson(res, 200, data);
      }

      if (req.method === 'GET' && p === '/api/admin/export.csv') {
        const csv = Buffer.from(exportCsv(), 'utf8');
        res.writeHead(200, Object.assign({
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Length': csv.length,
          'Content-Disposition': 'attachment; filename="duty-2026.csv"',
          'Cache-Control': 'no-store'
        }, securityHeaders()));
        return res.end(csv);
      }

      if (req.method === 'POST' && p === '/api/admin/add') {
        const body = await readBody(req);
        return sendJson(res, 200, createSignup(body, ip));
      }

      if (req.method === 'POST' && p === '/api/admin/delete') {
        const body = await readBody(req);
        const row = stmt.byId.get(Number(body.id));
        if (!row) return fail(res, 404, '记录不存在');
        stmt.del.run(row.id);
        const d = DAY_MAP.get(row.date) || {};
        return sendJson(res, 200, { ok: true, message: '已删除 ' + (d.text || row.date) + ' ' + row.shift + ' ' + row.name });
      }

      if (req.method === 'POST' && p === '/api/admin/clear') {
        const body = await readBody(req);
        if (clean(body.confirm, 20) !== '清空') return fail(res, 400, '请输入“清空”两个字确认');
        stmt.delAll.run();
        return sendJson(res, 200, { ok: true, message: '已清空全部报名数据' });
      }
    }

    return fail(res, 404, '接口不存在');
  } catch (e) {
    console.error('[错误]', p, e);
    return fail(res, 500, '服务器处理出错：' + e.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log('值班报名系统已启动: http://' + HOST + ':' + PORT);
  console.log('  报名页   /');
  console.log('  管理后台 /admin');
  console.log('  数据目录 ' + DATA_DIR);
  if (ACCESS_CODE) console.log('  已启用邀请码访问');
});

function shutdown() {
  server.close(() => { try { db.close(); } catch (e) { /* ignore */ } process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
