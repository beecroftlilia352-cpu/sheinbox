/**
 * 常驻「抓取用浏览器」——两种模式，自动挑优先级。
 *
 * 模式 A（优先）：**用户自己的 Chrome**（由 use-my-chrome.cmd 带调试端口重开的那个）
 *   在用户自己浏览器的窗口里新开标签页，用他的登录态与历史，不另起窗口。
 *   代价：Chrome 必须启动时带 --remote-debugging-port，所以要先完全退出 Chrome 一次。
 *
 * 模式 B（回退）：工具自己的常驻浏览器（独立 profile `.chrome-profile`）
 *   自己带调试端口起一个独立 Chrome 进程，抓取端用 CDP 连上去、只开一个标签页，
 *   抓完只关标签页、窗口一直留着。好处：不依赖用户的浏览器、验证态长期有效；
 *   坏处：是另一个窗口。
 *
 * 端口/pid 记在 .tool-browser.json（模式 A 的记在 .use-my-chrome.json，由 PowerShell 写）。
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const MARK = path.join(__dirname, '.tool-browser.json');
const USER_MARK = path.join(__dirname, '.use-my-chrome.json');

/* 连一个「没反应的」浏览器最多等这么久。曾经用 Playwright 默认的 30 秒：实例僵死时用户要盯着转圈
 * 半分钟才得到一句「连已有浏览器失败」，在他眼里就是「抓不到浏览器」。改成 8 秒，
 * 并且下面会把僵死实例自动清掉重开。 */
const ATTACH_TIMEOUT = 8000;
const PING_TIMEOUT = 1200;

function findChrome() {
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ];
  return cands.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };

async function ping(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(PING_TIMEOUT) });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function readMark() { return readJson(MARK); }

/** 真正在监听这个端口的进程号。Chrome 会把启动命令行转交给已有实例，启动器的 pid 可能早就没了，
 *  所以「标记里的 pid 还活着吗」不能用来判断浏览器是否可用 —— 端口上的听众才是权威。 */
function listenerPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 8000 }) || '';
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === Number(port)) return Number(m[2]);
    }
  } catch (e) { /* netstat 不可用：返回 null，ping 仍然有效 */ }
  return null;
}

/** 端口上有人在听吗（TCP 层面；只看「有没有实例」，不代表那个实例的调试协议还能用） */
function portOpen(port, timeout = 300) {
  return new Promise(resolve => {
    if (!port) return resolve(false);
    const s = require('net').connect({ host: '127.0.0.1', port: Number(port) });
    const done = ok => { try { s.destroy(); } catch (e) {} resolve(ok); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

/** 端口上的浏览器（只看端口答不答话） */
async function liveBrowser(port) {
  const info = await ping(port);
  if (!info) return null;
  return { port: Number(port), browser: info.Browser || '', pid: listenerPid(port), cdpOk: true };
}

async function waitGone(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!(await ping(port))) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return !(await ping(port));
}

/** 强杀掉工具自己的那一个浏览器实例（**用户自己的 Chrome 一律不动**）。 */
async function killStale(m, { say = () => {} } = {}) {
  const port = Number(m && m.port) || null;
  if (!port) return false;
  const pid = listenerPid(port) || Number(m.pid) || null;
  say(`正在清掉没反应的抓取浏览器（端口 ${port}${pid ? '，pid ' + pid : ''}）…`);
  for (const p of [pid, Number(m.pid) || null]) {
    if (!p) continue;
    try { execFileSync('taskkill', ['/PID', String(p), '/T'], { stdio: 'ignore', timeout: 10000 }); } catch (e) {}
  }
  await new Promise(r => setTimeout(r, 1200));
  if (!(await waitGone(port, 4000))) {
    const p2 = listenerPid(port);
    if (p2) { try { execFileSync('taskkill', ['/PID', String(p2), '/T', '/F'], { stdio: 'ignore', timeout: 10000 }); } catch (e) {} }
    await waitGone(port, 4000);
  }
  try { fs.unlinkSync(MARK); } catch (e) {}
  return !(await ping(port));
}

/** 「用我自己的 Chrome」模式现在可用吗（标记在 + 端口有人在听；pid 只作参考） */
async function userChrome() {
  const m = readJson(USER_MARK);
  if (!m || !m.port) return null;
  if (!(await portOpen(m.port))) return null;
  const info = await ping(m.port);
  return { port: Number(m.port), pid: listenerPid(m.port) || m.pid,
           browser: (info && info.Browser) || '', cdpOk: !!info, profile: m.profile || '' };
}

/** 当前的常驻（工具）浏览器（没在跑就返回 null）。
 *  注意：**端口有人在听就算「在」** —— 实例僵死时端口照样听着，只报「已退出」会误导用户。 */
async function current() {
  const m = readMark();
  if (!m || !m.port) return null;
  if (!(await portOpen(m.port))) return null;
  const info = await ping(m.port);
  const pid = listenerPid(m.port) || m.pid;
  const fixed = { port: Number(m.port), pid, profile: m.profile, browser: (info && info.Browser) || '', cdpOk: !!info };
  if (pid && Number(pid) !== Number(m.pid)) {           // 顺手修掉「启动器 pid 已死」的错记录
    try { fs.writeFileSync(MARK, JSON.stringify({ port: fixed.port, pid, profile: m.profile })); } catch (e) {}
  }
  return fixed;
}

/**
 * 拿到一个已经连着登录态的浏览器上下文。
 * @returns {Promise<{ctx: object|null, attached: boolean, reused: boolean}>}
 *   attached=false 表示没搞定常驻浏览器，调用方应该回退到自己开一个（老行为）。
 */
async function ensure(chromium, { profile, headless, exe, log } = {}) {
  const say = log || (() => {});

  // A) 用户自己的 Chrome：不另起窗口，直接在他当前浏览器里开标签页
  const own = await userChrome();
  if (own) {
    if (!own.cdpOk) {
      // 端口在听但协议不答话：连上去只会干等，不如直接说清楚并退到工具浏览器
      say('你自己的 Chrome 调试端口（' + own.port + '）不答话了 —— 工具不会去动你的浏览器。'
        + '这次先用工具自己的浏览器抓；想继续用你自己的 Chrome：完全退出它，再双击一次 use-my-chrome.cmd');
    } else {
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${own.port}`, { timeout: ATTACH_TIMEOUT });
        const ctx = browser.contexts()[0] || (await browser.newContext());
        say('用你自己的 Chrome：这次会在你当前那个浏览器里新开一个标签页');
        return { ctx, attached: true, reused: true, mode: 'myChrome', port: own.port };
      } catch (e) {
        // 用户自己的浏览器工具不能杀，只能把话说清楚，然后退到工具浏览器
        say('连你自己的 Chrome 失败（' + String(e.message).split('\n')[0] + '）—— 先用工具自己的浏览器抓，'
          + '你的浏览器我一个窗口都没动。想继续用你自己的 Chrome：完全退出它，再双击一次 use-my-chrome.cmd');
      }
    }
  }

  // B) 工具自己的常驻浏览器
  const have = await current();
  if (have) {
    if (have.cdpOk) {
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${have.port}`, { timeout: ATTACH_TIMEOUT });
        const ctx = browser.contexts()[0] || (await browser.newContext());
        say('复用工具自己的抓取浏览器（独立窗口，不占用你的浏览器）');
        return { ctx, attached: true, reused: true, mode: 'toolBrowser', port: have.port };
      } catch (e) {
        // 端口答话但会话连不上 = 实例僵死。它是工具自己的，清掉重开，别让用户每次干等
        say('现有抓取浏览器没反应（' + String(e.message).split('\n')[0] + '），清掉重开一个');
        await killStale(have, { say });
      }
    } else {
      // 端口开着、调试协议已不答话：这就是「抓不到浏览器」。不浪费 8 秒硬连，直接清掉重开。
      say('现有抓取浏览器僵死了（端口 ' + have.port + ' 在听，但连不上），清掉重开一个');
      await killStale(have, { say });
    }
  }

  // C) 起一个工具自己的常驻浏览器
  return await launch(chromium, { profile, headless, exe, say });
}

/** 起一个新的工具浏览器并连上去 */
async function launch(chromium, { profile, headless, exe, say = () => {} } = {}) {
  // 没有 playwright 客户端就别开浏览器：开了也没人能连上去，只会留下一堆孤儿窗口
  if (!chromium) return { ctx: null, attached: false, reused: false, mode: 'oneshot' };
  const chrome = exe || findChrome();
  if (!chrome) return { ctx: null, attached: false, reused: false, mode: 'oneshot' };

  const port = 9222 + Math.floor(Math.random() * 40);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--start-maximized', '--no-first-run', '--no-default-browser-check', '--lang=zh-CN',
    '--disable-blink-features=AutomationControlled', 'about:blank'
  ];
  if (headless) args.splice(args.length - 1, 0, '--headless=new');

  const p = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  p.unref();
  for (let i = 0; i < 40; i++) {                       // 最多等 20 秒
    await new Promise(r => setTimeout(r, 500));
    if (await ping(port)) {
      const pid = listenerPid(port) || p.pid;
      try { fs.writeFileSync(MARK, JSON.stringify({ port, pid, profile })); } catch (e) {}
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: ATTACH_TIMEOUT });
        const ctx = browser.contexts()[0] || (await browser.newContext());
        say('已打开工具抓取浏览器（想改成「在你自己的 Chrome 里开标签页」：双击 use-my-chrome.cmd）');
        return { ctx, attached: true, reused: false, mode: 'toolBrowser', port };
      } catch (e) {
        say('新开的抓取浏览器连不上（' + String(e.message).split('\n')[0] + '），改成一次性窗口抓这一单');
        return { ctx: null, attached: false, reused: false, mode: 'oneshot', port };
      }
    }
    if (!alive(p.pid) && !listenerPid(port)) break;    // 进程没了：多半是有实例占着这个 profile
  }
  return { ctx: null, attached: false, reused: false, mode: 'oneshot' };
}

/** 服务端「重启抓取浏览器」按钮用：清掉僵死实例 + 起一个新的（不动用户的 Chrome） */
async function restart(chromium, { profile, headless, exe, log } = {}) {
  const say = log || (() => {});
  const own = await userChrome();
  if (own) {
    return { ok: false, mode: 'myChrome', port: own.port,
             message: '现在用的是你自己的 Chrome，工具不会去动它。想重来：完全退出 Chrome，再双击 use-my-chrome.cmd。' };
  }
  const before = await current();
  if (before) await killStale(before, { say });
  const r = await launch(chromium, { profile, headless, exe, say });
  const ok = !!(r && r.attached && r.mode === 'toolBrowser');
  return { ok, mode: r && r.mode, port: r && r.port,
           message: ok ? ('抓取浏览器已重开（端口 ' + r.port + '）') : '重开没成功，请看下面日志' };
}

/** 浏览器现状（给健康检查/前端看）：端口在听 = 有实例；cdpOk = 那个实例真的能用 */
async function status() {
  const own = await userChrome();
  if (own) {
    return { running: true, mode: 'myChrome', port: own.port, browser: own.browser || '',
             cdpOk: own.cdpOk, restartable: false,
             note: own.cdpOk ? '' : '调试端口不答话（工具不会去重启你的浏览器）→ 完全退出 Chrome 后重跑 use-my-chrome.cmd' };
  }
  const cur = await current();
  if (cur) {
    return { running: true, mode: 'toolBrowser', port: cur.port, browser: cur.browser || '',
             cdpOk: cur.cdpOk, restartable: true,
             note: cur.cdpOk ? '' : '端口开着但连不上（实例僵死）→ 点「重启抓取浏览器」' };
  }
  const m = readMark();
  if (m && m.port) {
    return { running: false, mode: 'toolBrowser', port: m.port, cdpOk: false, restartable: false,
             note: '上次的抓取浏览器已经退出，下次抓取会自动开一个' };
  }
  return { running: false, mode: null, port: null, cdpOk: false, restartable: false, note: '还没开过抓取浏览器' };
}

module.exports = { ensure, current, userChrome, findChrome, killStale, launch, restart, status,
                   listenerPid, ping, portOpen, MARK, USER_MARK, ATTACH_TIMEOUT };

if (require.main === module) {
  (async () => {
    const arg = process.argv[2] || '--status';
    if (arg === '--restart') {
      let chromium = null;
      try { chromium = require('playwright').chromium; } catch (e) {
        console.log(JSON.stringify({ ok: false, message: 'playwright 没装，重启不了：' + e.message }));
        process.exit(0);
      }
      const r = await restart(chromium, { profile: path.join(__dirname, '.chrome-profile'),
                                          log: m => console.error('[browser] ' + m) });
      console.log(JSON.stringify(r));
      process.exit(0);
    }
    console.log(JSON.stringify(await status()));
  })().catch(e => { console.log(JSON.stringify({ ok: false, message: String((e && e.message) || e) })); });
}
