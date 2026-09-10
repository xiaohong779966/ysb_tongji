'use strict';

/**
 * 端到端接口测试：启动真实服务，逐条验证报名规则。
 * 运行： node tests/api.test.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.TEST_PORT || 3111);
const BASE = 'http://127.0.0.1:' + PORT;
const PASSWORD = 'test-pass-123';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-test-'));

// 在当前进程内直接启动服务，测试真实 HTTP 接口
process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.DATA_DIR = dataDir;
process.env.ADMIN_PASSWORD = PASSWORD;
process.env.ACCESS_CODE = '';
require(path.join(__dirname, '..', 'server.js'));

let fails = 0;
function ok(cond, label, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (cond || extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
  if (!cond) fails++;
}

async function req(method, p, body, headers) {
  const opt = { method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(BASE + p, opt);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  return { status: res.status, body: json, cookie: res.headers.get('set-cookie') };
}
const post = (p, b, h) => req('POST', p, b, h);
const get = (p, h) => req('GET', p, undefined, h);

const ME = { name: '张三' };
const signup = (o) => post('/api/signup', o);

(async function run() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch (e) { }
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log('\n[1] 基础接口');
  const board0 = await get('/api/board');
  ok(board0.status === 200 && board0.body.ok, 'GET /api/board 可用');
  ok(board0.body.days.length === 10, '返回 10 个值班日', board0.body.days && board0.body.days.length);
  ok(board0.body.totalLimit === 3, '每天上限 3 人');
  ok(board0.body.shifts.map((s) => s.key + s.limit).join() === '中班2,晚班1', '班次配置为 中班2人、晚班1人');

  console.log('\n[2] 正常报名');
  const r1 = await signup({ date: '2026-09-25', shift: '中班', name: ME.name });
  ok(r1.status === 200 && r1.body.ok, '张三报名 9月25日 中班成功', r1.body);
  const r2 = await signup({ date: '2026-09-25', shift: '中班', name: '李四' });
  ok(r2.status === 200 && r2.body.ok, '李四报名 9月25日 中班成功（中班满 2 人）');

  console.log('\n[3] 班次已满');
  const r3 = await signup({ date: '2026-09-25', shift: '中班', name: '王五' });
  ok(r3.status === 409 && r3.body.code === 'SHIFT_FULL', '第 3 个报中班被拒绝（409 SHIFT_FULL）', r3.body);
  ok(r3.body.message === '该班次报名人数已满，请选择其他班次', '班次已满提示语正确：' + r3.body.message);
  const r4 = await signup({ date: '2026-09-25', shift: '晚班', name: '王五' });
  ok(r4.status === 200 && r4.body.ok, '王五改报晚班成功（此时当天 3 人已满）');

  console.log('\n[4] 当天已满');
  const r5 = await signup({ date: '2026-09-25', shift: '中班', name: '赵六' });
  ok(r5.status === 409 && r5.body.code === 'DATE_FULL', '当天满员后报名被拒绝（409 DATE_FULL）', r5.body);
  ok(r5.body.message === '该日期报名人数已满，请选择其他日期', '当天已满提示语正确：' + r5.body.message);

  console.log('\n[5] 同一人同一天只能报一个班次');
  const r6 = await signup({ date: '2026-09-25', shift: '晚班', name: ME.name });
  ok(r6.status === 409 && r6.body.code === 'DUPLICATE', '张三同日再报晚班被拒绝', r6.body);
  const r7 = await signup({ date: '2026-10-01', shift: '晚班', name: ME.name });
  ok(r7.status === 200 && r7.body.ok, '张三换一天（10月1日）可以报名');

  console.log('\n[6] 输入校验');
  const b1 = await signup({ date: '2026-12-25', shift: '中班', name: '测试' });
  ok(b1.status === 400 && b1.body.code === 'BAD_DATE', '不在安排内的日期被拒绝');
  const b2 = await signup({ date: '2026-09-26', shift: '夜班', name: '测试' });
  ok(b2.status === 400 && b2.body.code === 'BAD_SHIFT', '不存在的班次被拒绝');
  const b3 = await signup({ date: '2026-09-26', shift: '中班', name: 'x'.repeat(21) });
  ok(b3.status === 400 && b3.body.code === 'BAD_NAME', '姓名过长被拒绝');
  const b4 = await signup({ date: '2026-09-26', shift: '中班', name: '   ' });
  ok(b4.status === 400 && b4.body.code === 'BAD_NAME', '空姓名被拒绝');
  const b5 = await signup({ date: '2026-09-26', shift: '中班', name: ' 李 四 ' });
  ok(b5.status === 200 && b5.body.ok, '姓名前后空格会被自动去掉');
  const b6 = await signup({ date: '2026-09-26', shift: '中班', name: '李四' });
  ok(b6.body.code === 'DUPLICATE', '去空格后能正确识别为同一人（李四 与  “ 李 四 ” 视为同一人）', b6.body);

  console.log('\n[7] 公开看板不泄露手机号');
  const board1 = await get('/api/board');
  const day = board1.body.board['2026-09-25'];
  ok(day.中班.length === 2 && day.晚班.length === 1, '9月25日 中班2人、晚班1人');
  ok(day.中班[0].phone === undefined && day.中班[0].dept === undefined, '公开接口只返回编号和姓名');
  ok(day.中班[0].name === '张三', '公开接口返回姓名');

  console.log('\n[8] 我的报名 / 取消');
  const mine = await post('/api/my', { name: ME.name });
  ok(mine.body.list.length === 2, '张三查到 2 条报名', mine.body.list);
  const wrong = await post('/api/cancel', { id: mine.body.list[0].id, name: '别人' });
  ok(wrong.status === 403, '姓名不符不能取消报名');
  const cancel = await post('/api/cancel', { id: mine.body.list[0].id, name: ME.name });
  ok(cancel.body.ok, '本人取消报名成功：' + cancel.body.message);

  console.log('\n[9] 管理后台');
  const noauth = await get('/api/admin/board');
  ok(noauth.status === 401, '未登录访问管理接口被拒绝');
  const badpw = await post('/api/admin/login', { password: 'wrong' });
  ok(badpw.status === 401, '错误密码被拒绝');
  const good = await post('/api/admin/login', { password: PASSWORD });
  ok(good.status === 200 && !!good.cookie && good.cookie.indexOf('admin=') === 0, '正确密码登录成功并下发会话 cookie');
  const cookie = good.cookie.split(';')[0];

  const adminBoard = await get('/api/admin/board', { Cookie: cookie });
  ok(adminBoard.status === 200, '管理接口带会话可访问');
  const aDay = adminBoard.body.board['2026-09-25'];
  ok(aDay.中班[0].at && aDay.中班[0].at.length === 19, '记录报名时间：' + aDay.中班[0].at);
  ok(aDay.total === 2, '9月25日 当前 2 人（张三已在第 8 步取消报名）', aDay.total);

  const csv = await fetch(BASE + '/api/admin/export.csv', { headers: { Cookie: cookie } });
  const csvText = await csv.text();
  ok(csv.status === 200 && csvText.indexOf('"班次","姓名"') > 0, 'CSV 导出成功且含表头');
  ok(csvText.split('\r\n').length >= 3, 'CSV 含数据行');

  const delId = aDay.晚班[0].id;
  const del = await post('/api/admin/delete', { id: delId }, { Cookie: cookie });
  ok(del.body.ok, '管理员删除报名成功：' + del.body.message);
  const afterDel = await get('/api/admin/board', { Cookie: cookie });
  ok(afterDel.body.board['2026-09-25'].晚班.length === 0, '删除后晚班空出名额');
  ok(afterDel.body.board['2026-09-25'].total === 1, '删除后当天总人数变为 1');

  const reAdd = await post('/api/admin/add', { date: '2026-09-25', shift: '中班', name: '陈七' }, { Cookie: cookie });
  ok(reAdd.body.ok, '管理员代报名成功（中班满 2 人）');
  const overShift = await post('/api/admin/add', { date: '2026-09-25', shift: '中班', name: '新人' }, { Cookie: cookie });
  ok(overShift.body.code === 'SHIFT_FULL' && overShift.body.message === '该班次报名人数已满，请选择其他班次', '代报名同样受班次上限约束');
  const fillLate = await post('/api/admin/add', { date: '2026-09-25', shift: '晚班', name: '王五' }, { Cookie: cookie });
  ok(fillLate.body.ok, '补报晚班成功（当天 3 人满员）');
  const overDate = await post('/api/admin/add', { date: '2026-09-25', shift: '晚班', name: '新人' }, { Cookie: cookie });
  ok(overDate.body.code === 'DATE_FULL' && overDate.body.message === '该日期报名人数已满，请选择其他日期', '当天满员后提示“该日期报名人数已满，请选择其他日期”');

  const logout = await post('/api/admin/logout', {}, { Cookie: cookie });
  ok(logout.status === 200, '退出登录接口可用');

  console.log('\n[10] 数据持久化');
  ok(fs.existsSync(path.join(dataDir, 'duty.db')), 'SQLite 数据文件已生成');

  console.log('\n' + (fails === 0 ? '全部通过 ✅' : fails + ' 项失败 ❌'));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* Windows 下数据库句柄未释放，忽略 */ }
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
