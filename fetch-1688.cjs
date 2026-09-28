/* 1688 商品页抓取（可见浏览器）：被验证码拦住时暂停等人工过验证，过完自动继续抓取
 * 用法: node fetch-1688.cjs <url> [--profile <dir>] [--timeout 600] [--headless]
 * 输出协议（每行一个 JSON，便于宿主进程解析）:
 *   @@STATUS  {"state":"opening|waiting|captcha|ready|timeout|error", "hint":"...", "elapsed":n}
 *   @@PRODUCT {...解析后的商品数据...}
 */
const path = require('path');
const fs = require('fs');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const URL_ARG = process.argv[2];
const OFFER_ID = (String(URL_ARG).match(/offer\/(\d+)\.html/) || [])[1] || '';
const HEADLESS = process.argv.includes('--headless');
const TIMEOUT = parseInt(arg('timeout', '600'), 10);
const PROFILE = arg('profile', path.join(__dirname, '.chrome-profile'));
// 自己管一份 cookie（见下方说明）：Chrome 的 cookie 库要它从容退出才落盘，
// 而抓取进程常被 taskkill /F 强杀（换链接、超时、点“重新读取”都会），登录态就这么丢了。
const COOKIES_FILE = arg('cookies', path.join(__dirname, '.chrome-cookies.json'));
// cookie 清洗成 Playwright 认的形状（Chrome 给的对象有些字段直接塞回去会被拒）
const cleanCookies = list => (Array.isArray(list) ? list : []).map(c => ({
  name: String(c.name), value: String(c.value == null ? '' : c.value),
  domain: String(c.domain), path: String(c.path || '/'),
  expires: typeof c.expires === 'number' ? c.expires : -1,
  httpOnly: !!c.httpOnly, secure: !!c.secure,
  sameSite: ['Strict', 'Lax', 'None'].indexOf(c.sameSite) >= 0 ? c.sameSite : 'Lax'
}));
let CTX = null, _savedCookies = '';
async function saveCookies() {
  if (!CTX) return;
  try {
    const s = JSON.stringify(cleanCookies(await CTX.cookies()));
    if (s !== _savedCookies && s !== '[]') { fs.writeFileSync(COOKIES_FILE, s); _savedCookies = s; }
  } catch (e) {}
}

const say = (o) => process.stdout.write('@@STATUS ' + JSON.stringify(o) + '\n');
const emit = (tag, o) => process.stdout.write(tag + ' ' + JSON.stringify(o) + '\n');

/* ---------- 拟人化小工具 ----------
 * 对 1688 来说，"请求太密、节奏太齐、动作太机械"都是机器特征。
 * 所以：所有等待都带随机抖动；到位后先滚动/移动鼠标再读内容。 */
const rnd = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pause = (a, b) => sleep(Math.round(rnd(a, b)));
async function humanTouch(page, times) {
  for (let i = 0; i < times; i++) {
    try {
      await page.mouse.move(Math.round(rnd(180, 1100)), Math.round(rnd(120, 700)), { steps: Math.round(rnd(8, 22)) });
      await pause(200, 700);
      await page.mouse.wheel(0, Math.round(rnd(200, 760)));
      await pause(400, 1400);
    } catch (e) {}
  }
}

if (!URL_ARG || !/^https?:\/\//.test(URL_ARG)) {
  say({ state: 'error', hint: '缺少合法的商品链接' });
  process.exit(2);
}

// 找到本机 Chrome / Edge（用真实浏览器内核，避免被识别为脚本）
function findBrowser() {
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ];
  return cands.find(p => { try { return p && fs.existsSync(p); } catch (e) { return false; } }) || null;
}

(async () => {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (e) {
    say({ state: 'error', hint: '未找到 playwright，请确认 NODE_PATH 指向 Hermes 的 node_modules：' + e.message });
    process.exit(3);
  }

  const exe = findBrowser();
  const started = Date.now();
  let ctx, ATTACHED = false, PAGE = null;
  try {
    say({ state: 'opening', hint: '正在准备抓取浏览器…' });
    fs.mkdirSync(PROFILE, { recursive: true });
    // 先试着连上「常驻抓取浏览器」：窗口一直留着，所以你验证一次就够，
    // 而且人还在过验证码时不会被抓取结束、换链接、停服务之类的事把窗口关掉。
    const tb = require('./tool-browser.cjs');
    const ens = await tb.ensure(chromium, {
      profile: PROFILE, headless: HEADLESS, exe,
      log: m => say({ state: 'opening', hint: m, elapsed: 0 })
    });
    if (ens.attached) {
      ctx = ens.ctx;
      ATTACHED = true;
    } else {
      // 回退：常驻浏览器没起来（Chrome 路径异常 / profile 被别的实例占着），还是自己开一个
      ctx = await chromium.launchPersistentContext(PROFILE, {
        headless: HEADLESS,
        executablePath: exe || undefined,
        // viewport 必须是 null：固定 viewport 会把页面锁在 1280×900、还把 dpr 压成 1，
        // 窗口最大化后比例就全乱了（实测：null → 窗口 1920×1152、页面 1920×1009、dpr 1.5）。
        viewport: null,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        ignoreHTTPSErrors: true,
        // 必须去掉 --enable-automation：否则地址栏挂着"正受到自动测试软件的控制"，风控直接判自动化
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
        args: ['--disable-blink-features=AutomationControlled', '--start-maximized',
               '--no-first-run', '--no-default-browser-check', '--lang=zh-CN']
      });
    }
    // 抹掉最容易被查的自动化指纹（缺一个风控就可能一直"验证失败"）
    await ctx.addInitScript(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
      try { Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] }); } catch (e) {}
      try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch (e) {}
      try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}
    });
    if (ATTACHED) {
      // 一定新开标签页，**绝不动你已有的标签页**（不按 URL 复用：那个会把你正在看的页面重新导航，
      // 你正在登录/扫码时尤其不能碰）。
      PAGE = await ctx.newPage();
      say({ state: 'opening', hint: '新开了一个标签页（你已有的标签页一律不动）', elapsed: 0 });
    }
    if (!PAGE) PAGE = ctx.pages()[0] || await ctx.newPage();

    // ★ 登录态自己管：每 8 秒把 cookie 落盘，启动时先注入上次的 ——
    //   即使抓取进程被强杀（taskkill /F），下一个窗口也还是已登录状态。
    CTX = ctx;
    let injected = 0;
    // 常驻浏览器里已经是活着的登录态，不要再灌旧 cookie 覆盖它；
    // 只有回退路径（自己开的临时窗口）才需要注入。
    if (!ATTACHED) {
      try {
        const list = cleanCookies(JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')));
        for (let i = 0; i < list.length; i += 20) {
          try { await ctx.addCookies(list.slice(i, i + 20)); injected += Math.min(20, list.length - i); } catch (e) {}
        }
      } catch (e) { /* 第一次运行还没这个文件 */ }
    } else {
      try { injected = (await ctx.cookies('https://www.1688.com')).length; } catch (e) {}
      if (injected) say({ state: 'opening', hint: `这个窗口里已有 ${injected} 条 1688 cookie（登录态就在窗口里，验证一次长期有效）`, elapsed: 0 });
    }
    if (injected && !ATTACHED) say({ state: 'opening', hint: `已带上上次保存的 ${injected} 条登录 cookie（正常情况不用再验证）`, elapsed: 0 });
    setInterval(saveCookies, 8000).unref();   // unref：定时器不阻止进程退出
    // 像真人一样：新访客先落到 1688 首页逛一下，再"点进"商品页（带上 Referer）
    let hasCookies = false;
    try { hasCookies = (await ctx.cookies('https://www.1688.com')).length >= 3; } catch (e) {}
    if (!hasCookies) {
      say({ state: 'opening', hint: '先打开 1688 首页看一下（新访客直接怼商品页太像脚本）…', elapsed: 0 });
      try {
        await PAGE.goto('https://www.1688.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await pause(2200, 4800);
        await humanTouch(PAGE, 2);
        await pause(1300, 3200);
      } catch (e) { /* 首页打不开就直接进商品页 */ }
    }
    await PAGE.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 90000, referer: 'https://www.1688.com/' });
    await pause(1300, 3000);                 // 等页面自然铺开，别一落地就抽内容
    await humanTouch(PAGE, 1);
  } catch (e) {
    say({ state: 'error', hint: '打开失败：' + e.message });
    await saveCookies();
    // 常驻浏览器是独立进程，就算这次抓取失败也别去关它（关了下次又得重新登录）
    if (!ATTACHED) { try { await ctx.close(); } catch (_) {} }
    else if (PAGE) { try { await PAGE.close(); } catch (_) {} }
    process.exit(4);
  }

  const page = PAGE;
  const parse = require('./parse-1688.js');
  const CAPTCHA = /请按住滑块|拖动滑块|滑动验证|安全验证|验证码|slide to verify|Please slide|verify to ensure normal access|x5sec|访问受限|行为验证|点击完成验证|滑块|拖动|异常流量|human/i;
  const PRICEY = /[¥￥]\s*\d/;
  let announced = '';
  let lastProd = null;
  let stableCount = 0;
  let lastShot = 0;
  let warnedClosing = false;

  while (Date.now() - started < TIMEOUT * 1000) {
    await pause(1800, 3600);                 // 随机间隔，固定 2 秒太有规律
    let text = '', html = '', title = '';
    try {
      text = await page.evaluate(() => document.body ? document.body.innerText || '' : '');
      title = await page.title();
    } catch (e) {
      say({ state: 'waiting', hint: '页面正在跳转…', elapsed: Math.round((Date.now() - started) / 1000) });
      continue;
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    // 关窗前先打招呼：突然消失最让人抓狂，尤其人还在过验证码
    if (!warnedClosing && TIMEOUT - elapsed <= 60) {
      warnedClosing = true;
      say({ state: 'waiting', elapsed,
            hint: ATTACHED
              ? `还剩 ${TIMEOUT - elapsed} 秒这次抓取就先放弃。窗口和标签页都留着 —— 验证完回来点一次「读取商品」就接着用这个页面。`
              : `还剩 ${TIMEOUT - elapsed} 秒这个窗口会自动关闭。验证还没过完的话：关掉后重新点「读取商品」再开一次，会带上已保存的登录状态。` });
    }
    const INTERCEPT_URL = /login\.1688|sec\.1688|passport\.|punish|verify|captcha|callback=|x5sec/i;
    const curUrl = (() => { try { return page.url() || ''; } catch (e) { return ''; } })();
    // 只要页面已经跳到验证/登录地址，就绝不判成功 —— 哪怕页面里有价格，
    // 那些多半是推荐位或残留的商品内容（把验证页当成功，会产出假上架表）。
    const urlIntercepted = INTERCEPT_URL.test(curUrl);
    const onOfferPage = !OFFER_ID || curUrl.includes(OFFER_ID) || /offer\/\d+\.html/.test(curUrl);
    if (urlIntercepted || !onOfferPage) {
      if (announced !== 'verify') {
        announced = 'verify';
        say({ state: 'captcha', elapsed,
              hint: (urlIntercepted ? '页面在验证/登录地址上（' + curUrl.slice(0, 60) + '）—— 请在这个窗口里处理，我在这儿等你，不会判成功也不会关窗。'
                                    : '页面不在商品页上（可能还在跳转）——继续等。') });
      }
      continue;
    }
    // 被拦截的页面里也有"猜你喜欢"之类带价格的推荐商品 —— 必须先按拦截判死，
    // 否则会把拦截页当成商品页，用户拿到一份假数据（这比抓不到更糟）。
    const BLOCK = /验证码拦截|请按照说明进行验证|滑动验证|安全验证|行为验证|请完成验证|访问受限|操作异常|unusual traffic|punish|verify/i;
    const blocked = BLOCK.test(title + ' ' + text.slice(0, 4000)) || /verify|x5sec|punish|captcha/i.test(page.url());
    const captchaShown = CAPTCHA.test(text.slice(0, 4000)) || blocked;
    const hasProduct = text.length > 600 && PRICEY.test(text) && !blocked;

    // 自诊断：默认 30 秒才落一次截图；状态一变（发现验证码/登录页）立刻落一张。
    // 原先是 6 秒一张 —— 那会在用户拖滑块时不断重绘并抢焦点，人根本拖不过去。
    const needShot = Date.now() - lastShot > 30000;
    if (needShot) {
      lastShot = Date.now();
      try { await page.screenshot({ path: path.join(__dirname, '.last-page.png') }); } catch (_) {}
      try { fs.writeFileSync(path.join(__dirname, '.last-page.txt'), title + '\n' + text, 'utf8'); } catch (_) {}
    }
    const LOGIN = /密码登录|短信登录|扫码登录|免费注册|请登录|立即登录/;
    const snippet = (title + ' | ' + text.slice(0, 100)).replace(/\s+/g, ' ').trim();

    if (LOGIN.test(text.slice(0, 600)) && !hasProduct && text.length < 400) {
      if (announced !== 'login') {
        announced = 'login';
        lastShot = Date.now();
        try { await page.screenshot({ path: path.join(__dirname, '.last-page.png') }); } catch (_) {}
        try { fs.writeFileSync(path.join(__dirname, '.last-page.txt'), title + '\n' + text, 'utf8'); } catch (_) {}
        say({ state: 'login', hint: '窗口里是 1688 登录页（不是滑块）。请在这个窗口里登录（推荐用 1688/淘宝 App 扫码）——窗口不会再被自动截图/刷新打扰，慢慢来；登录成功后我会自动继续，不用再点任何按钮。', elapsed, snippet, title, textLen: text.length });
      }
      continue;
    }
    if (captchaShown && !hasProduct) {
      if (announced !== 'captcha') {
        announced = 'captcha';
        lastShot = Date.now();
        try { await page.screenshot({ path: path.join(__dirname, '.last-page.png') }); } catch (_) {}
        say({ state: 'captcha', hint: '窗口里出现了滑块/验证码。请手动拖一下完成验证 —— 这个窗口现在不会再被自动截图/重绘打扰，可以慢慢拖，我会一直等，验证通过后自动继续。', elapsed, snippet, title, textLen: text.length });
      }
      continue;
    }
    if (!hasProduct) {
      if (Date.now() - lastShot < 2200) {
        announced = 'waiting';
        say({ state: 'waiting', hint: '页面加载中（当前页面还没有出现价格）…', elapsed, snippet, title, textLen: text.length });
      }
      continue;
    }

    // 价格已出现：连续两次解析结果一致（或价格块稳定）才算抓稳，避免抓到骨架屏
    try {
      html = await page.content();
    } catch (e) { html = ''; }
    const prod = parse.parse(text + '\n' + '', { url: page.url(), pageTitle: title });
    // 正文这一轮有没有价格（规格值上的标价也算真价格）
    const textPriced = prod.priceTiers.length > 0 ||
      prod.colors.some(c => c.price != null) ||
      (prod.specs || []).some(d => (d.values || []).some(v => v.price != null));
    // DOM 里如果有主图/属性，用 HTML 再补一轮
    const prodHtml = html ? parse.parse(html, { url: page.url(), pageTitle: title }) : null;
    if (prodHtml) {
      // 标题优先用 DOM 里的 h1/<title>：正文里最长的那条往往是活动说明/声明，会把标题抓成一段文案
      if (prodHtml.title && prodHtml.title.length <= 90 && !/[。；;]/.test(prodHtml.title)) prod.title = prodHtml.title;
      else if (!prod.title) prod.title = prodHtml.title;
      if (!prod.images.length) prod.images = prodHtml.images;
      for (const k of ['brand', 'category', 'weight_g', 'box_qty', 'bladeCount']) if (prod[k] === null && prodHtml[k] !== null) prod[k] = prodHtml[k];
      if (!prod.colors.length) prod.colors = prodHtml.colors;
      // HTML 这一轮的档位没走过「同款推荐之后一律不要」的界线过滤，容易把别家商品的价格带进来 →
      // 只有在正文完全没价时才借它兜底（有价时宁可用规格标价，也别塞一堆假档位）
      if (!textPriced && prodHtml.priceTiers.length) prod.priceTiers = prodHtml.priceTiers;
    }
    prod.source.url = page.url();
    prod.source.offerId = (page.url().match(/offer\/(\d+)\.html/) || [])[1] || prod.source.offerId;

    // 「抓稳」判据：价格类数据出现了并且连续两次一致。
    // 注意**不能只认 priceTiers**：像「一维多值、每个值自带价」的页面，档位里可能一个常规价都没有
    // （推荐位的价被过滤掉后为空），但规格值上的标价就是真价格 —— 只认档位会一直等不到、白等半小时。
    const priced = prod.priceTiers.length > 0 ||
      prod.colors.some(c => c.price != null) ||
      (prod.specs || []).some(d => (d.values || []).some(v => v.price != null));
    const key = JSON.stringify([prod.title, prod.priceTiers, prod.colors.map(c => [c.name, c.stock]),
      (prod.specs || []).map(d => (d.values || []).map(v => [v.name, v.price]))]);
    if (key === JSON.stringify(lastProd)) stableCount++; else stableCount = 0;
    lastProd = JSON.parse(key);

    if (stableCount >= 1 && priced) {
      parse.finalize(prod);                                    // 与页面共用同一套收口逻辑
      delete prod.rawText;                                     // 不回传整页文本
      say({ state: 'ready', hint: '抓取完成', elapsed });
      emit('@@PRODUCT', prod);
      await saveCookies();          // 收尾前把这次会话的 cookie 落盘
      // 标签页留着不关：抓取开的这一页就放在那儿，你想看就看，想关自己关
      // （以前抓完就关，正在看的人会觉得「页面被刷没了」）
      if (!ATTACHED) { await ctx.close(); }
      process.exit(0);
    }
    if (announced !== 'waiting') { announced = 'waiting'; say({ state: 'waiting', hint: '已读到页面，正在确认价格与规格…', elapsed }); }
  }

  say({ state: 'timeout', hint: ATTACHED
    ? `等了 ${TIMEOUT} 秒还没拿到商品数据。**浏览器窗口没有关** —— 你可以在里面慢慢过验证/登录，弄完回来点一次「读取商品」，会接着用这个标签页（不用从头再来）。`
    : `等了 ${TIMEOUT} 秒还是没拿到商品数据（可能一直在等人工验证）。这个窗口现在会自动关闭 —— 重新点一次「读取商品」就再开一个（已保存的登录状态会自动带上，不用从头再来）。` });
  await saveCookies();              // 收尾前先把 cookie 落盘
  if (!ATTACHED) { try { await ctx.close(); } catch (_) {} }
  process.exit(5);
})();
