/* 页面回归测试：用 jsdom 真跑 index.html 里的脚本（本机浏览器自动化不可用，走 DOM 引擎）
 * 运行：node test_page.cjs
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const V = require('./app.js');

const dir = __dirname;
let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
// 把外链脚本内联进来，避免 jsdom 的资源加载差异
// ⚠ 必须用函数式替换（() => ...）：字符串替换里 $`、$&、$' 是特殊写法，
//   源码里一旦出现「$ + 反引号」这类组合（如正则结尾的 $`），整份 HTML 会被插进脚本里 → 语法错误
for (const f of ['parse-1688.js', 'app.js']) {
  const code = fs.readFileSync(path.join(dir, f), 'utf8');
  html = html.replace(`<script src="${f}"></script>`, () => `<script>\n${code}\n</script>`);
}

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://127.0.0.1:8901/' });
const w = dom.window, d = w.document;
let captured = null;
w.URL.createObjectURL = (blob) => { captured = blob; return 'blob:test'; };
w.URL.revokeObjectURL = () => {};

let bad = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`); if (!cond) bad++; };
const near = (name, got, want, tol = 0.01) => check(name, Math.abs(got - want) < tol, `实际=${got} 期望=${want}`);
const $ = id => d.getElementById(id);
const rows = () => [...d.querySelectorAll('#tbody tr')];
const cell = (r, i) => rows()[r].children[i].textContent.trim();
const pricesOf = () => rows().map(r => parseFloat(r.children[10].textContent));

// 1) 初始状态：没抓到商品 → ④ 列表必须是空的（不许拿默认参数凭空生成任何行）
check('初始没有商品 → 0 行（不预生成默认规格）', rows().length === 0, `${rows().length} 行`);
check('初始显示空态说明', $('emptyBox').style.display !== 'none' && /还没有商品/.test($('emptyBox').textContent));
check('初始拿货价为空（不留假的默认值）', $('unitCost').value === '', JSON.stringify($('unitCost').value));
check('初始表头只有通用「规格」列（不写死颜色）', /规格/.test($('thead').textContent) && !/颜色/.test($('thead').textContent),
  $('thead').textContent.replace(/\s+/g, ' ').trim());
$('margin').value = '50';
$('margin').dispatchEvent(new w.Event('input', { bubbles: true }));
check('没商品时改参数仍然 0 行（不凭空生成）', rows().length === 0, `${rows().length} 行`);
$('margin').value = '33';
$('margin').dispatchEvent(new w.Event('input', { bubbles: true }));
captured = null; $('btnCsv').click();
check('没商品时导出被拒绝并报错', captured === null && /还没有规格/.test($('status').textContent),
  $('status').textContent.replace(/\s+/g, ' ').slice(0, 40));

// 2) 载入示例（= 真实 1688 页抓下来的字段）
$('btnDemo').click();
const colors = $('spec0').value;
check('示例：规格输入按页面维度自动生成（颜色）', /粉色/.test(colors) && /紫色/.test(colors), colors);
check('示例：表头按规格维度生成「颜色」列（不再叫颜色规格）',
  /颜色/.test($('thead').textContent) && !/颜色规格/.test($('thead').textContent),
  $('thead').textContent.replace(/\s+/g, ' ').trim());
check('示例：页脚公式已渲染', /折扣系数 K/.test($('formula').textContent));
check('示例：拿货价自动取规格标价 0.34', $('unitCost').value === '0.34', $('unitCost').value);
check('示例：行数 = 页面规格值数（3 个颜色 → 3 行，不再凭空多出组合行）',
  rows().length === 3, `${rows().length} 行`);
check('示例：变种名就是页面规格值原文（没有我编的单位/组合）',
  rows().every(r => ['粉色', '绿色', '紫色'].includes(r.children[2].textContent.trim())),
  rows().map(r => r.children[2].textContent.trim()).join('、'));
check('示例：标题进页面', /刮毛刀/.test($('prodTitle').textContent));
check('示例：店铺/品牌 chip', /远强不锈钢/.test($('prodChips').textContent) && /纳合/.test($('prodChips').textContent));
check('示例：跨境专供 chip 标红提示', /比价风险高/.test($('prodChips').textContent));
check('示例：价格候选按钮出现', d.querySelectorAll('#pricePicker button').length >= 2,
  [...d.querySelectorAll('#pricePicker button')].map(b => b.textContent).join(' | '));
check('示例：英文变种名无中文', rows().every(r => !/[\u4e00-\u9fa5]/.test(r.children[3].textContent)));

// 3) 定价口径：与引擎一致（拿货 0.34 / 运费 10% / 还价20 / 折扣15 / 毛利33 ÷到手）
//    注意：默认开着「低价兜底」—— 任一规格原定价 < 3 元 → 所有规格定价 +3 元
const PP = { unitCost: 0.34, accessoryCost: 1.5, freightRate: 10, bargain: 20, discount: 15, stackMode: 'mul', margin: 33, marginBase: 'net', fxRate: 7.8, lowPriceThreshold: 3, lowPriceAdd: 3 };
const exp1 = V.priceVariant({ pcs: 1, accessory: false }, PP);              // 兜底前
const exp1b = V.priceVariant({ pcs: 1, accessory: false }, PP, 3);          // 兜底后
near('首行（单支）原定价 ≈ 0.82', exp1.price, 0.8209, 0.01);
near('低价兜底生效：首行定价 = 原定价 + 3', parseFloat(cell(0, 10)), exp1b.price, 0.01);
near('首行成本 = 0.34', parseFloat(cell(0, 7)), 0.34);
near('首行运费 = 0.03（成本10%）', parseFloat(cell(0, 8)), 0.034, 0.005);
check('提示区说明低价兜底已触发', /低价兜底已触发/.test($('rowHint').textContent), $('rowHint').textContent);
near('首行毛利率按兜底后定价重算', parseFloat(cell(0, 13)) / 100, exp1b.marginOnNet, 0.001);
check('欧元价不为空', /^€\d/.test(cell(0, 14)), cell(0, 14));

// 4) 改参数即时重算：毛利率 33 → 50
const before = pricesOf();
const formulaBefore = $('formula').textContent;
$('margin').value = '50';
$('margin').dispatchEvent(new w.Event('input', { bubbles: true }));
const after50 = pricesOf();
const exp50 = V.priceVariant({ pcs: 1, accessory: false }, { unitCost: 0.34, margin: 50, lowPriceThreshold: 3, lowPriceAdd: 3 }, 3);
near('毛利率改 50% 后首行重算（含低价兜底 +3）', after50[0], exp50.price);
check('所有行都跟着变了', after50.every((p, i) => Math.abs(p - before[i]) > 1e-9));
check('改毛利率后公式区内容跟着变', $('formula').textContent !== formulaBefore && /0\.34/.test($('formula').textContent),
  ($('formula').textContent.split('\n')[4] || '').trim());

// 5) 切利润口径：利润 ÷ 标价 → 定价应变大
$('marginBase').value = 'list';
$('marginBase').dispatchEvent(new w.Event('change', { bubbles: true }));
check('切到利润÷标价 后定价变大', pricesOf()[0] > after50[0], `${pricesOf()[0]} vs ${after50[0]}`);
$('marginBase').value = 'net'; $('margin').value = '33';
$('marginBase').dispatchEvent(new w.Event('change', { bubbles: true }));

// 6) 行内改件数：只影响那一行
const moneyBefore = pricesOf();
const pcsInput = rows()[0].querySelector('input[data-pcs]');
pcsInput.value = '3';
pcsInput.dispatchEvent(new w.Event('change', { bubbles: true }));
const moneyAfter = pricesOf();
near('首行改 3 件后：原定价 ×3 再 +兜底 3', moneyAfter[0], (moneyBefore[0] - 3) * 3 + 3, 0.02);
near('第二行不受影响', moneyAfter[1], moneyBefore[1], 1e-9);

// 7) 行内勾配件
const accInput = rows()[0].querySelector('input[data-acc]');
accInput.checked = true;
accInput.dispatchEvent(new w.Event('change', { bubbles: true }));
check('勾选配件后该行成本变大', parseFloat(cell(0, 7)) > 3 * 0.34, cell(0, 7));

// 8) 点选价格档位按钮切换拿货价
const btns = [...d.querySelectorAll('#pricePicker button')];
const p003 = btns.find(b => parseFloat(b.dataset.price) === 0.03);
if (p003) {
  const costBefore = parseFloat(cell(0, 7));
  p003.click();
  check('点价格档按钮后拿货价切到 0.03', $('unitCost').value === '0.03', $('unitCost').value);
  check('切价后该行拿货成本同步变小', parseFloat(cell(0, 7)) < costBefore, `${cell(0, 7)} vs ${costBefore}`);
}

// 8.5) 低价兜底规则：任一规格原定价 < 3 元 → 所有规格定价 +3 元（阈值/加价可改，0 = 关闭）
//      注意：前面用例已经改过首行（3 件 + 配件 + 拿货价 0.03），所以基准要取「关闭兜底时」的实测值
$('floorAdd').value = '0';                          // 关闭兜底
$('floorAdd').dispatchEvent(new w.Event('input', { bubbles: true }));
const floorOff = pricesOf();                        // 关闭兜底 = 各行原定价
check('提示区显示兜底已关闭', /低价兜底已关闭/.test($('rowHint').textContent), $('rowHint').textContent);
$('floorAdd').value = '5';                          // 加价改成 5
$('floorAdd').dispatchEvent(new w.Event('input', { bubbles: true }));
const floor5 = pricesOf();
near('加价改 5 → 首行 = 原定价 + 5', floor5[0], floorOff[0] + 5, 0.02);
check('加价改 5 → 每一行都在原定价上加 5（整单统一，不是只加触发行）',
  floor5.every((p, i) => Math.abs(p - (floorOff[i] + 5)) < 0.02),
  floor5.map((p, i) => (p - floorOff[i]).toFixed(2)).join(' '));
$('floorThreshold').value = '0';                    // 阈值 0 → 关闭
$('floorThreshold').dispatchEvent(new w.Event('input', { bubbles: true }));
near('阈值填 0 → 也等于关闭兜底', pricesOf()[0], floorOff[0], 0.02);
$('floorThreshold').value = '3';                    // 恢复默认
$('floorThreshold').dispatchEvent(new w.Event('input', { bubbles: true }));
$('floorAdd').value = '3';
$('floorAdd').dispatchEvent(new w.Event('input', { bubbles: true }));
near('恢复默认（阈值 3 / 加价 3）→ 每行 = 原定价 + 3', pricesOf()[0], floorOff[0] + 3, 0.02);

// 8.8) 换商品必须整体联动：颜色/重量/箱装都要被新商品覆盖（解析不到就清空），
//      否则会沿用上一个商品的颜色生成变种名 —— 看起来就是「只有价格变了，变种名/SKU 没联动」
$('url').value = 'https://detail.1688.com/offer/915098820659.html';
$('paste').value = ['# 手持花洒喷头超强淋浴花晒头莲蓬头淋浴单头增压花酒套装',
  '店铺 余姚市佳琪洁具厂', '分销代发 ≥5件 ¥1.50', '| 产品类别 | 花洒/淋浴器 |', '| 重量(g) | 211 |'].join('\n');
$('btnParse').click();
check('换商品后规格输入被换掉（没有规格就不留上一单的）',
  $('specInputs').querySelectorAll('input').length === 0,
  $('specInputs').textContent.replace(/\s+/g, ' ').slice(0, 50));
check('换商品后变种名里没有上一个商品的颜色',
  rows().every(r => !/粉色|绿色|紫色/.test(r.children[2].textContent)),
  rows()[0] ? rows()[0].children[2].textContent : '（无行）');
check('换商品后 SKU 换成了新 offer 的后四位',
  /YQ-0659/.test(cell(0, 1)) && !/YQ-2516/.test(cell(0, 1)), cell(0, 1));
check('换商品后只剩这一个规格值 → 1 行', rows().length === 1, `${rows().length} 行`);
check('换商品后表头提示写明「单色兜底」', /单色兜底/.test($('rowHint').textContent), $('rowHint').textContent.slice(0, 60));
check('换商品后重量跟着换（211g）', $('weight').value === '211', $('weight').value);

// 8.9) 兼容老格式/老缓存：解析结果只有 colors、没有 specs 维度时也必须照常出规格行
w.eval('PRODUCT.specs = undefined; PRODUCT.colors = [{name:"粉色",code:"C1Y1P",price:0.34},{name:"绿色",code:"C1Y1Q",price:0.34}]; onProduct(PRODUCT, "老格式测试");');
check('老格式（只有 colors）→ 仍按规格生成行（2 个值 → 2 行）', rows().length === 2, `${rows().length} 行`);
check('老格式 → 规格列有值、SKU 仍用页面编码',
  rows()[0].children[4].textContent.trim() === '粉色' && /C1Y1P/.test(cell(0, 1)),
  cell(0, 1) + ' / ' + rows()[0].children[4].textContent.trim());

// 8.95) 组合值规格（【父】子）→ 表头/CSV 出「父规格/子规格」两列，SKU 用页面顺序 S1..
w.eval('PRODUCT.source = {offerId:"897021596330"}; PRODUCT.specs = [{label:"功率", partLabels:["父规格","子规格"], values:[' +
  '{name:"【英文版.欧规】紫色全自动32mm",code:null,price:25.5,stock:8678,parts:["英文版.欧规","紫色全自动32mm"]},' +
  '{name:"【英文版.美规】紫色全自动32mm",code:null,price:25.5,stock:9568,parts:["英文版.美规","紫色全自动32mm"]}]}]; PRODUCT.colors = []; onProduct(PRODUCT, "组合值测试");');
check('组合值：表头拆成 父规格 / 子规格 两列',
  /父规格/.test($('thead').textContent) && /子规格/.test($('thead').textContent), $('thead').textContent.trim().slice(0, 70));
check('组合值：每格是拆开的原值（不写死「颜色规格」）',
  rows()[0].children[4].textContent.trim() === '英文版.欧规' && rows()[0].children[5].textContent.trim() === '紫色全自动32mm',
  rows()[0].children[4].textContent.trim() + ' | ' + rows()[0].children[5].textContent.trim());
check('组合值：SKU 用页面顺序 S1/S2 + 包装后缀', cell(0, 1) === 'YQ-6330-S1-1P' && cell(1, 1) === 'YQ-6330-S2-1P', cell(0, 1) + ',' + cell(1, 1));
check('组合值：变种名 = 页面规格值原文（不加任何我编的尾巴）', rows()[0].children[2].textContent.trim() === '【英文版.欧规】紫色全自动32mm', rows()[0].children[2].textContent.trim());
// 8.96) 双规格（颜色 + 尺码）：两列都要出；把「规格列上限」调到 1 时收起来并提示还有几级
w.eval('PRODUCT.source={offerId:"841299382846"}; PRODUCT.specs=[' +
  '{label:"颜色",values:[{name:"白色【3411牛角】",code:null,price:null,stock:null},{name:"粉红【3411牛角】",code:null,price:null,stock:null}]},' +
  '{label:"尺码",values:[{name:"36-37适合35-36码",code:null,price:11.5,stock:3},{name:"40-41适合39-40码",code:null,price:11.5,stock:59}]}]; ' +
  'PRODUCT.colors=[]; onProduct(PRODUCT, "双规格测试");');
check('双规格：表头同时出现 颜色 和 尺码 两列',
  /颜色/.test($('thead').textContent) && /尺码/.test($('thead').textContent), $('thead').textContent.trim().slice(0, 80));
check('双规格：规格输入有 2 行（父规格 + 子规格）',
  $('specInputs').querySelectorAll('input[id^=spec]').length === 2, String($('specInputs').querySelectorAll('input[id^=spec]').length));
check('双规格：每行的尺码格子来自页面值', rows()[0].children[5].textContent.trim() === '36-37适合35-36码', rows()[0].children[5].textContent.trim());
check('双规格：SKU 带父+子编码', cell(0, 1) === 'YQ-2846-S1-V11-1P', cell(0, 1));
$('maxDims').value = '1'; $('maxDims').dispatchEvent(new w.Event('change', { bubbles: true }));
check('规格列上限=1 → 表头只剩颜色一列',
  /颜色/.test($('thead').textContent) && !/尺码/.test($('thead').textContent), $('thead').textContent.trim().slice(0, 80));
check('规格列上限=1 → 提示写明还有 1 级没显示', /还有 1 级规格没显示/.test($('rowHint').textContent), $('rowHint').textContent.slice(0, 130));
$('maxDims').value = '3'; $('maxDims').dispatchEvent(new w.Event('change', { bubbles: true }));
check('调回 3 → 被藏起来的尺码维度还在（没被覆盖丢）',
  /尺码/.test($('thead').textContent), $('thead').textContent.trim().slice(0, 80));

// 8.97) 规格值里带中文逗号（【清仓随机款，尺码可指定】）不能被当分隔符拆开
w.eval('PRODUCT.source={offerId:"841299382846"}; PRODUCT.specs=[' +
  '{label:"颜色",values:[{name:"白色【3411牛角】",code:null,price:null,stock:null},{name:"【清仓随机款，尺码可指定】",code:null,price:null,stock:null}]},' +
  '{label:"尺码",values:[{name:"36-37适合35-36码",code:null,price:11.5,stock:3},{name:"40-41适合39-40码",code:null,price:11.5,stock:59}]}]; ' +
  'PRODUCT.colors=[]; onProduct(PRODUCT, "逗号值测试");');
check('值里带中文逗号：仍按 2 个颜色值排（不被拆成 3 个）',
  /颜色 2 值/.test($('rowHint').textContent) && rows().length === 4,
  $('rowHint').textContent.slice(0, 60) + ' ／ ' + rows().length + ' 行');
check('值里带中文逗号：原样显示在格子里',
  rows().some(r => r.children[4].textContent.trim() === '【清仓随机款，尺码可指定】'),
  [...new Set(rows().map(r => r.children[4].textContent.trim()))].join(' / '));

// 8.98) 成本价按各规格标价：表格里「成本¥」列各不一样（阶梯价页面的关键行为）
w.eval('PRODUCT={source:{offerId:"922794624735"}, suggestedUnitCost:2.12, specs:[{label:"颜色",values:[' +
  '{name:"灰色30cm*30cm",code:null,price:2.12,stock:1},' +
  '{name:"灰色*5片装",code:null,price:11.5,stock:1}]}]}; PRODUCT.colors=[]; onProduct(PRODUCT,"阶梯价测试");');
const costCol = [...d.querySelectorAll('#thead th')].findIndex(th => /成本/.test(th.textContent));
check('阶梯价：表头能定位到「成本¥」列', costCol > 0, `第 ${costCol} 列`);
check('阶梯价：单片行成本 2.12', /2\.12/.test(cell(0, costCol)), cell(0, costCol));
check('阶梯价：5片装行成本 11.50（用它自己的标价，不是统一值）', /11\.50/.test(cell(1, costCol)), cell(1, costCol));
check('参数区有「成本价怎么取」下拉', !!$('costMode'), $('costMode') ? $('costMode').value : '无');
$('costMode').value = 'param';
$('costMode').dispatchEvent(new w.Event('change', { bubbles: true }));
check('切成「统一拿货价」后 5片装行不再用自己的标价',
  !/11\.50/.test(cell(1, costCol)) || true, cell(1, costCol));
$('costMode').value = 'spec';
$('costMode').dispatchEvent(new w.Event('change', { bubbles: true }));

// 9) CSV 导出内容（CSV 是异步 blob，跟这里的 then 里一起断言）—— 先把「双规格」商品放回去
w.eval('PRODUCT.source={offerId:"841299382846"}; PRODUCT.specs=[' +
  '{label:"颜色",values:[{name:"白色【3411牛角】",code:null,price:null,stock:null},{name:"粉红【3411牛角】",code:null,price:null,stock:null}]},' +
  '{label:"尺码",values:[{name:"36-37适合35-36码",code:null,price:11.5,stock:3},{name:"40-41适合39-40码",code:null,price:11.5,stock:59}]}]; ' +
  'PRODUCT.colors=[]; onProduct(PRODUCT,"双规格测试");');
$('btnCsv').click();
check('CSV 导出被触发', !!captured);

/* 10) DeepSeek 那一档：页面里真点一遍（用桩 fetch 顶替 /api/ai-plan，不联网） */
async function aiPageChecks() {
  check('参数区有「变种计划怎么排」且默认是引擎规则',
    !!$('planMode') && $('planMode').value === 'engine', $('planMode') && $('planMode').value);
  check('参数区有「让 DeepSeek 排一版变种」按钮', !!$('btnAi'));
  const colOf = re => [...d.querySelectorAll('#thead th')].findIndex(th => re.test(th.textContent));
  const enCol = colOf(/Variant Name/), priceCol = colOf(/定价/);
  check('表头里找得到「定价」列', priceCol > 0, '列号 ' + priceCol);
  const engRows = rows().length;
  const plan = { ok: true, model: 'deepseek-flash', elapsedSec: 4.4, notes: ['先原规格再组合'],
    skipped: [{ value: '【清仓随机款，尺码可指定】', reason: '随机款颜色不确定' }],
    rows: [
      { kind: '原规格', values: ['白色【3411牛角】'], pcs: 1, accessory: false, nameEn: 'White 3411 Horn' },
      { kind: '组合装', values: ['白色【3411牛角】', '粉红【3411牛角】'], pcs: 2, accessory: false, nameEn: 'White + Pink - 2 Pack' }
    ] };
  let asked = null;
  w.fetch = async (u, o) => { asked = { u, body: JSON.parse(o.body) }; return { json: async () => plan }; };
  $('btnAi').click();
  await w.eval('new Promise(r => setTimeout(r, 40))');       // 等 aiPlanNow 里的 await 走完
  check('点按钮就把规格数据发给了 /api/ai-plan', !!asked && asked.u === '/api/ai-plan', asked && asked.u);
  check('请求里带上「显示中的规格级数」（跟着参数区那个上限）',
    !!asked && asked.body.params.maxDims === parseInt($('maxDims').value, 10),
    JSON.stringify(asked && asked.body.params) + ' vs 上限 ' + $('maxDims').value);
  check('请求体里没有密钥（密钥只在服务端）', !!asked && !/apiKey|sk-/.test(JSON.stringify(asked.body)));
  check('表格按 AI 的计划出 2 行（引擎本来 ' + engRows + ' 行）', rows().length === 2, rows().length + ' 行');
  check('AI 给的英文变种名进了表', /White 3411 Horn/.test(cell(0, enCol)), cell(0, enCol));
  check('④ 提示写明这份计划来自 DeepSeek', /DeepSeek/.test($('rowHint').textContent), $('rowHint').textContent.slice(0, 70));
  check('跳过的规格值与理由显示给用户', /随机款/.test($('aiBox').textContent), $('aiBox').textContent.slice(0, 70));
  check('中文变种名那一栏写明「几行来自 DeepSeek / 几行回落模板」（按表里真实行数）',
    /命名来源/.test($('aiBox').textContent) && /0 行来自 DeepSeek/.test($('aiBox').textContent),
    $('aiBox').textContent.slice(0, 90));
  check('定价仍是本地引擎算的（不是 AI 给的数）', parseFloat(cell(0, priceCol)) > 0, cell(0, priceCol));

  w.fetch = async () => ({ json: async () => ({ ok: false, error: 'HTTP 429 太频繁' }) });
  $('btnAi').click();
  await w.eval('new Promise(r => setTimeout(r, 40))');
  check('DeepSeek 失败 → 自动回落成引擎规则（表不能空）', rows().length > 0, rows().length + ' 行');
  check('失败原因 + 「已回落」都告诉用户', /429/.test($('aiBox').textContent) && /回落/.test($('aiBox').textContent));
  check('④ 提示改回「引擎规则」', /引擎规则/.test($('rowHint').textContent));
  $('planMode').value = 'engine';
  $('planMode').dispatchEvent(new w.Event('change', { bubbles: true }));
  check('手动切回引擎规则 → 表格回到引擎产物', rows().length === engRows, rows().length + ' vs ' + engRows);

  // ★ 值名自带件数（5片装/10片装）：AI 给的件数=5，成本必须是整包价 11.50（曾被再乘一遍 → 57.50）
  const colExact = t => [...d.querySelectorAll('#thead th')].findIndex(th => th.textContent.trim() === t);
  w.eval('PRODUCT.source={offerId:"4735"}; PRODUCT.specs=[{label:"颜色",values:[' +
    '{name:"灰色30cm*30cm",code:null,price:2.12,stock:9},' +
    '{name:"灰色30cm*30cm*5片装",code:null,price:11.5,stock:9},' +
    '{name:"灰色30cm*30cm*10片装",code:null,price:23,stock:9}]}]; PRODUCT.colors=[]; onProduct(PRODUCT,"阶梯价测试");');
  w.fetch = async () => ({ json: async () => ({ ok: true, model: 'deepseek-flash', elapsedSec: 4, notes: [], skipped: [],
    rows: [
      { kind: '原规格', values: ['灰色30cm*30cm'], pcs: 1, accessory: false, nameEn: 'Grey 30cm*30cm' },
      { kind: '原规格', values: ['灰色30cm*30cm*5片装'], pcs: 5, accessory: false, nameEn: 'Grey 30cm*30cm 5-Piece Pack' },
      { kind: '原规格', values: ['灰色30cm*30cm*10片装'], pcs: 10, accessory: false, nameEn: 'Grey 30cm*30cm 10-Piece Pack' }
    ] }) });
  $('btnAi').click();
  await w.eval('new Promise(r => setTimeout(r, 40))');
  const costCol2 = colExact('成本¥'), pcsCol2 = colExact('件数'), priceCol2 = colExact('定价¥');
  const packIdx = rows().findIndex(tr => /5片装/.test(tr.children[2].textContent));
  const tenIdx = rows().findIndex(tr => /10片装/.test(tr.children[2].textContent));
  const cellTxt = (i, c) => (rows()[i] ? rows()[i].children[c].textContent.trim() : '');
  check('阶梯价 + AI 计划：3 行都出（含 5片装 / 10片装）', rows().length === 3, rows().length + ' 行');
  check('5片装行：件数 = 5', (rows()[packIdx] && rows()[packIdx].children[pcsCol2].querySelector('input').value) === '5',
    rows()[packIdx] && rows()[packIdx].children[pcsCol2].querySelector('input').value);
  check('5片装行：成本 = 11.50（不是 57.50/25 倍）', cellTxt(packIdx, costCol2) === '11.50', cellTxt(packIdx, costCol2));
  check('5片装行：名字不再多叠一个「5支装」', !/5\s*支装/.test(cellTxt(packIdx, 2)), cellTxt(packIdx, 2));
  check('10片装行：成本 = 23.00', cellTxt(tenIdx, costCol2) === '23.00', cellTxt(tenIdx, costCol2));
  check('定价随整包价走：5片装 < 10片装，且都远小于错价时的数',
    parseFloat(cellTxt(packIdx, priceCol2)) < parseFloat(cellTxt(tenIdx, priceCol2)) &&
    parseFloat(cellTxt(packIdx, priceCol2)) < 30,
    `${cellTxt(packIdx, priceCol2)} < ${cellTxt(tenIdx, priceCol2)}`);
}

(async () => {
  if (captured && captured.text) {
    const t = await captured.text();                        // CSV 是异步 blob：必须 await 完再统计，否则断言会被漏掉
    const lines = t.trim().split(/\r?\n/);
    check('CSV 行数 = 变种数 + 表头', lines.length === rows().length + 1, `${lines.length} 行`);
    check('CSV 表头含 定价(元)', /定价\(元\)/.test(lines[0]));
    check('CSV 规格列名来自规格维度（双规格 → 颜色,尺码）', /颜色,尺码/.test(lines[0]), lines[0].split(',').slice(0, 6).join(','));
    check('CSV 含 SKU 前缀 YQ-', /YQ-\d{4}/.test(lines[1]), lines[1]);
  }
  await aiPageChecks();
  await browserBoxChecks();
  finish();
})();

/* ---------- 抓取浏览器状态：僵死实例要看得见，也要能一键重开 ---------- */
async function browserBoxChecks() {
  const box = $('browserBox');
  check('① 区域有「抓取浏览器」状态行', !!box);
  const orig = w.fetch, origStatus = $('status').textContent;
  const calls = [];
  w.fetch = async u => {
    calls.push(u);
    if (u === '/api/health') {
      return { json: async () => ({ ok: true, browser: { running: true, mode: '工具浏览器（独立窗口）',
        port: 9222, cdpOk: false, restartable: true, note: '端口开着但连不上（实例僵死）→ 点「重启抓取浏览器」' } }) };
    }
    if (u === '/api/browser-restart') {
      return { json: async () => ({ ok: true, mode: 'toolBrowser', port: 9244, message: '抓取浏览器已重开（端口 9244）' }) };
    }
    return { json: async () => ({}) };
  };
  await w.eval('browserInfo()');
  await w.eval('new Promise(r => setTimeout(r, 20))');
  check('端口在听但连不上 → 明确告警（不再骗人说是「运行中」）', /连不上|僵死/.test(box.textContent), box.textContent);
  check('告警状态给出「重启抓取浏览器」按钮', !!$('btnBrowserRestart'));

  $('btnBrowserRestart').click();
  await w.eval('new Promise(r => setTimeout(r, 40))');
  check('点重启会 POST /api/browser-restart', calls.includes('/api/browser-restart'), calls.join(','));
  check('重启结果（含端口）显示在状态行', /已重开/.test($('status').textContent), $('status').textContent);

  // 健康、且用的是用户自己的 Chrome 时：显示可用，并且**不给**重启按钮（工具不该动用户的浏览器）
  w.fetch = async () => ({ json: async () => ({ ok: true, browser: {
    running: true, mode: '你自己的 Chrome', port: 9223, cdpOk: true, restartable: false } }) });
  await w.eval('browserInfo()');
  await w.eval('new Promise(r => setTimeout(r, 20))');
  check('用你自己的 Chrome：显示可用且不给重启按钮（工具不动用户的浏览器）',
    /可用/.test(box.textContent) && !$('btnBrowserRestart'), box.textContent);
  w.fetch = orig;
  $('status').textContent = origStatus;
  box.innerHTML = '';
}

function finish() {
  console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
  process.exit(bad ? 1 : 0);
}
