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
const { spawn } = require('child_process');

const MARK = path.join(__dirname, '.tool-browser.json');
const USER_MARK = path.join(__dirname, '.use-my-chrome.json');

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
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function readMark() { return readJson(MARK); }

/** 「用我自己的 Chrome」模式现在可用吗（标记在 + pid 活着 + 端口通） */
async function userChrome() {
  const m = readJson(USER_MARK);
  if (!m || !m.port) return null;
  if (m.pid && !alive(m.pid)) return null;
  const info = await ping(m.port);
  return info ? { port: m.port, pid: m.pid, browser: info.Browser || '', profile: m.profile || '' } : null;
}

/** 当前的常驻浏览器信息（没在跑就返回 null） */
async function current() {
  const m = readMark();
  if (!m || !m.port) return null;
  if (m.pid && !alive(m.pid)) return null;
  if (!(await ping(m.port))) return null;
  return m;
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
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${own.port}`);
      const ctx = browser.contexts()[0] || (await browser.newContext());
      say('用你自己的 Chrome：这次会在你当前那个浏览器里新开一个标签页');
      return { ctx, attached: true, reused: true, mode: 'myChrome', port: own.port };
    } catch (e) {
      say('连你自己的 Chrome 失败，改用工具自己的浏览器：' + e.message);
    }
  }

  // B) 工具自己的常驻浏览器
  const have = await current();
  if (have) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${have.port}`);
      const ctx = browser.contexts()[0] || (await browser.newContext());
      say('复用工具自己的抓取浏览器（独立窗口，不占用你的浏览器）');
      return { ctx, attached: true, reused: true, mode: 'toolBrowser', port: have.port };
    } catch (e) {
      say('连已有浏览器失败，重新开一个：' + e.message);
    }
  }

  // C) 起一个工具自己的常驻浏览器
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
      try { fs.writeFileSync(MARK, JSON.stringify({ port, pid: p.pid, profile })); } catch (e) {}
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const ctx = browser.contexts()[0] || (await browser.newContext());
      say('已打开工具抓取浏览器（想改成「在你自己的 Chrome 里开标签页」：双击 use-my-chrome.cmd）');
      return { ctx, attached: true, reused: false, mode: 'toolBrowser', port };
    }
    if (!alive(p.pid)) break;                          // 进程没了：多半是有实例占着这个 profile
  }
  return { ctx: null, attached: false, reused: false, mode: 'oneshot' };
}

module.exports = { ensure, current, userChrome, findChrome, MARK, USER_MARK };
