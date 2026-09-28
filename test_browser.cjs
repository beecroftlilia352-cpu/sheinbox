/**
 * 抓取浏览器助手（tool-browser.cjs）的回归测试。
 * 只碰「不会真的开窗口、也不会杀任何进程」的路径：
 *  - 状态识别（没有标记 / 标记指向一个「端口开着但不是浏览器」的端口 = 僵死特征）
 *  - 「用你自己 Chrome」模式下 restart() 必须直接拒绝，绝不重启用户的浏览器
 * 真的去起 Chrome 的那条路不在这里测（会弹窗口），由页面上的「重启抓取浏览器」按钮人工验收。
 */
const fs = require('fs');
const path = require('path');
const net = require('net');

const tb = require('./tool-browser.cjs');
const MARK = tb.MARK;
const USER_MARK = tb.USER_MARK;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const backup = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };
const restore = async (p, was) => {
  // 只把「看起来还活着」的旧标记放回去：备份里若不是真在监听的端口（上一次测试留下的假标记），
  // 放回去只会有害 —— 下次真抓取会去连一个不存在的端口。
  try {
    if (was === null) { if (fs.existsSync(p)) fs.unlinkSync(p); return; }
    const j = JSON.parse(was);
    if (j && j.port && (await tb.portOpen(j.port))) fs.writeFileSync(p, was);
    else if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {}
};

(async () => {
  const wasTool = backup(MARK), wasUser = backup(USER_MARK);
  let fakePort = 0;
  let srv = null;
  const cleanup = async () => {
    if (srv) {
      // 不能 await close()：srv 上还挂着测试留下的连接时，回调可能永远不来，
      // 事件循环空了以后 node 会直接静默退出 —— 于是「收尾」根本没跑，假标记就留在了磁盘上。
      try { if (srv.closeAllConnections) srv.closeAllConnections(); } catch (e) {}
      try { srv.close(); } catch (e) {}
      srv = null;
    }
    await restore(MARK, wasTool);
    await restore(USER_MARK, wasUser);
    // 兜底：哪条路径要是在假端口上写了标记（说明没被拦住），也要清掉，别把假端口留给真实抓取
    for (const p of [MARK, USER_MARK]) {
      try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (fakePort && Number(j.port) === fakePort) fs.unlinkSync(p); } catch (e) {}
    }
  };
  try {
  // 1) 干净状态：没有标记 → 明确说「还没开过」，不要报 running
  try { if (fs.existsSync(MARK)) fs.unlinkSync(MARK); } catch (e) {}
  try { if (fs.existsSync(USER_MARK)) fs.unlinkSync(USER_MARK); } catch (e) {}
  let st = await tb.status();
  check('没有标记时 status(): running=false', st.running === false, st);
  check('没有标记时 status(): cdpOk=false / restartable=false', st.cdpOk === false && st.restartable === false, st);

  // 2) 标记指向一个「端口开着、但不是浏览器调试端口」的端口 —— 这正是僵死实例的特征：
  //    TCP 连得上，所以旧的探活会误报「运行中」，抓取却连不上。
  srv = net.createServer(s => { s.on('error', () => {}); s.end('nope'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  fakePort = srv.address().port;
  fs.writeFileSync(MARK, JSON.stringify({ port: fakePort, pid: process.pid, profile: 'x' }));

  st = await tb.status();
  check('端口开着但不是浏览器 → 仍判 running=true（端口在监听）', st.running === true, st);
  check('端口开着但不是浏览器 → cdpOk=false（关键：不能再说「可用」）', st.cdpOk === false, st);
  check('僵死状态 → restartable=true（必须能一键重开，否则用户只能干等）', st.restartable === true, st);
  check('僵死状态 → note 说清了怎么办', /重启|僵死/.test(st.note || ''), st.note);
  check('普通 TCP 端口不会被当成 CDP（/json/version 必须返回浏览器版本）', (await tb.ping(fakePort)) === null);
  check('正常监听的端口 portOpen=true', (await tb.portOpen(fakePort)) === true);
  check('没人听的端口 portOpen=false', (await tb.portOpen(1)) === false);
  check('listenerPid 能认出端口上的进程', tb.listenerPid(fakePort) === process.pid, tb.listenerPid(fakePort));

  // 3) 「用你自己 Chrome」模式：restart() 必须拒绝动手（用户明确要求过：不许动他的浏览器）
  fs.writeFileSync(USER_MARK, JSON.stringify({ port: fakePort, pid: process.pid, profile: 'u' }));
  const rs = await tb.restart(null, { profile: 'x' });
  check('myChrome 模式下 restart() 不动手（ok=false）', rs.ok === false && rs.mode === 'myChrome', rs);
  check('myChrome 模式下 restart() 说清了该怎么办', /use-my-chrome/.test(rs.message || ''), rs.message);
  check('myChrome 模式下没被误删标记', fs.existsSync(USER_MARK));
  check('工具浏览器的标记也还在（没被顺手删掉）', fs.existsSync(MARK));

  } catch (e) {
    fail++;
    console.log('FAIL  测试自身异常：' + (e && e.message));
  } finally {
    await cleanup();
  }

  console.log('\n' + (fail ? fail + ' 项失败' : '全部通过') + '  (PASS ' + pass + ' / FAIL ' + fail + ')');
  process.exit(fail ? 1 : 0);
})();
