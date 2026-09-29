/* 规格生成 + 定价引擎回归：口径必须和「跨境定价计算器」算出来的数一致
 * 运行：node test_app.cjs
 */
const fs = require('fs');
const path = require('path');
const P = require('./parse-1688.js');
const V = require('./app.js');

const fx = fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-1063828892516.md'), 'utf8');
const prod = P.parse(fx, { url: 'https://detail.1688.com/offer/1063828892516.html' });

let bad = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`); if (!cond) bad++; };
const near = (name, got, want, tol = 0.01) => check(name, Math.abs(got - want) < tol, `实际=${Number(got).toFixed(4)} 期望=${want}`);

// 1) 与计算器口径一致性：成本10 / 运费成本10% / 还价20% / 折扣15% / 毛利33% ÷到手价 → 24.144
const base = V.priceVariant({ pcs: 1, accessory: false }, { unitCost: 10 });
near('单支：定价 24.144（与计算器一致）', base.price, 24.1440);
near('单支：到手 16.4179', base.net, 16.4179);
near('单支：利润 5.4179', base.profit, 5.4179);
near('单支：运费 = 成本10% = 1元', base.freight, 1.0);
near('单支：毛利率回代 33%', base.marginOnNet * 100, 33.0, 0.05);

// 2) 多件装线性放大
const three = V.priceVariant({ pcs: 3, accessory: false }, { unitCost: 10 });
near('三支：成本 33 元', three.totalCost, 33.0);
near('三支：定价 72.432', three.price, 72.4320);
near('三支：毛利率仍 33%', three.marginOnNet * 100, 33.0, 0.05);
const nine = V.priceVariant({ pcs: 9, accessory: false }, { unitCost: 10 });
near('九支：定价 = 单支 × 9', nine.price, base.price * 9);

// 3) 配件成本只影响带配件变种
const withCase = V.priceVariant({ pcs: 1, accessory: true }, { unitCost: 10, accessoryCost: 1.5 });
near('带盒单支：成本 12.65（含运费）', withCase.totalCost, 12.65);
near('带盒单支：定价 27.766', withCase.price, 27.7656);
const noCase = V.priceVariant({ pcs: 1, accessory: false }, { unitCost: 10, accessoryCost: 1.5 });
near('不带盒的变种不受配件成本影响', noCase.price, 24.1440);

// 4) 欧元换算
near('欧元价 = 定价 ÷ 7.8', withCase.priceEur, 27.7656 / 7.8, 0.005);
check('凑整欧元价以 .99 结尾', /\.99$/.test(withCase.priceEur99.toFixed(2)), withCase.priceEur99.toFixed(2));

// 5) 用真实商品数据生成规格
const rows = V.buildVariants(prod, { unitCost: prod.suggestedUnitCost });
check('行数 = 页面规格值数（3 个颜色 → 3 行），不再凭空多出组合行', rows.length === 3, `实际 ${rows.length} 行`);
check('每个值一行、都是页面上的原文',
  rows.map(r => r.nameCn).join('、') === '粉色、绿色、紫色', rows.map(r => r.nameCn).join('、'));
/* 用户原话：「不许给我写死任何单位和组合」。下面这条就是那句话的看门测试：
 * 引擎档输出的名字里只允许出现页面抓到的值原文（+ 子规格原文），一个自己编的词都不许有。 */
const UNIT_WORDS = /支装|片装装|收纳盒|囤货|多件折扣|混合装|款规格|组合装|套装|单支|Pack|Specs|with Case/i;
const valueTexts = (prod.specs || []).flatMap(d => d.values.map(v => v.name));
check('引擎输出的名字里只有页面上的值原文（没有任何我编的单位/组合词）',
  rows.every(r => !UNIT_WORDS.test(r.nameCn) && !/with Case|Specs/i.test(r.nameEn)),
  rows.map(r => r.nameCn + ' | ' + r.nameEn).join(' ;; '));
check('也不含页面数据里没有的字', rows.every(r => valueTexts.some(v => r.nameCn.includes(v))), rows.map(r => r.nameCn).join('、'));
check('没有配件款（引擎不再自己发明「带收纳盒」）', rows.every(r => r.accessory === false));
check('没有多件装（件数一律等于值名自带的件数）', rows.every(r => r.pcs === V.packQtyOf(r.nameCn)));
check('SKU 全部唯一', new Set(rows.map(r => r.sku)).size === rows.length);
check('英文变种名齐全且无中文', rows.every(r => r.nameEn && !/[\u4e00-\u9fa5]/.test(r.nameEn)),
  rows.map(r => r.nameEn).join(' | '));
check('每个变种都有定价', rows.every(r => r.pricing.ok && r.pricing.price > 0));
check('拿货价取自页面规格标价 0.34', rows[0].pricing.goods === 0.34, String(rows[0].pricing.goods));

// 6) 单色商品：就只有那一行（引擎不靠编组合凑数）
const mono = V.buildVariants({ colors: [{ name: '粉色', code: 'C1Y1P' }] }, {});
check('单色商品 → 1 行，名字就是值原文', mono.length === 1 && mono[0].nameCn === '粉色', `${mono.length} 行：${mono.map(r => r.nameCn).join(',')}`);

// 7) 无解必须被标记而不是给负数/NaN
const dead = V.priceVariant({ pcs: 1 }, { margin: 80, marginBase: 'list' });
check('毛利率高于折扣系数时标记无解', dead.ok === false && !!dead.reason, dead.reason);

// 8) 公式文本可核对（含代入数值）
const lines = V.formulaLines(rows[0], { unitCost: 0.34 });
check('公式行数 ≥8', lines.length >= 8, `${lines.length} 行`);
check('公式含 K 展开式', lines[0].includes('(1−20%)×(1−15%)'), lines[0]);
check('公式含定价代入值', /定价 = 总成本 ÷ .* = /.test(lines[4]), lines[4]);
console.log('\n--- 公式示例（第一个变种）---');
lines.forEach(l => console.log('   ' + l));

// 9) 低价兜底：任一规格原定价 < 3 元 → 所有规格统一定价 +3 元（阈值/加价可改，0 = 关闭）
const cheap = V.buildVariants(prod, { unitCost: 0.34 });
check('低价兜底：整单判定为已触发', cheap[0].floor.applied === true, JSON.stringify(cheap[0].floor));
check('低价兜底：低于阈值的规格数 = 实测条数', cheap[0].floor.lowCount === cheap.filter(r => r.pricing.priceSolved < 3).length,
  `兜底判定 ${cheap[0].floor.lowCount} / 实测低于阈值 ${cheap.filter(r => r.pricing.priceSolved < 3).length} / 共 ${cheap.length}`);
check('低价兜底：每个规格都 +3（整单统一，不是只加触发那一行）',
  cheap.every(r => Math.abs(r.pricing.price - (r.pricing.priceSolved + 3)) < 1e-9),
  cheap.map(r => r.pricing.priceSolved.toFixed(2) + '→' + r.pricing.price.toFixed(2)).join(' '));
// 兜底是「整单统一」的：一个便宜值触发后，贵的那行也要 +3（配一个自带件数的贵值来验）
const cheapMix = V.buildVariants({ source: { offerId: '8888' }, specs: [{ label: '规格', values: [
  { name: '灰色30cm*30cm', code: null, price: 0.34, stock: 1 },
  { name: '灰色*5片装', code: null, price: 11.5, stock: 1 }] }] }, { unitCost: 0.34 });
check('低价兜底：高于阈值的规格也照样 +3，且原解保留在 priceSolved',
  cheapMix[0].floor.applied === true && cheapMix.filter(r => r.pricing.priceSolved >= 3).length > 0 &&
  cheapMix.every(r => Number.isFinite(r.pricing.priceSolved) && Math.abs(r.pricing.price - r.pricing.priceSolved - 3) < 1e-9),
  `高于阈值的 ${cheapMix.filter(r => r.pricing.priceSolved >= 3).length} 个规格也加了 3`);
check('低价兜底：到手价按兜底后定价重算',
  cheap.every(r => Math.abs(r.pricing.net - r.pricing.factor * r.pricing.price) < 1e-9),
  `首行 net=${cheap[0].pricing.net.toFixed(4)}`);
check('低价兜底：公式文本里写明这一行', V.formulaLines(cheap[0], { unitCost: 0.34 }).some(l => /低价兜底/.test(l)));
const pricey = V.buildVariants(prod, { unitCost: 50, costMode: 'param' });   // 这条用例测的是「参数拿货价」驱动的兜底
check('拿货价够高 → 兜底不触发，定价 = 原解',
  pricey.every(r => r.floor.applied === false && r.pricing.priceBoost === 0 && Math.abs(r.pricing.price - r.pricing.priceSolved) < 1e-9),
  `示例原解=${pricey[0].pricing.priceSolved.toFixed(2)}`);
check('阈值填 0 = 关闭兜底', V.floorDetail([{ pcs: 1 }], { unitCost: 0.34, lowPriceThreshold: 0 }).boost === 0);
check('加价填 0 = 关闭兜底', V.floorDetail([{ pcs: 1 }], { unitCost: 0.34, lowPriceAdd: 0 }).boost === 0);
check('原定价高于阈值 → 不触发', V.variantPriceBoost([{ pcs: 1 }], { unitCost: 10, lowPriceThreshold: 24, lowPriceAdd: 3 }) === 0);
check('原定价低于阈值 → 触发', V.variantPriceBoost([{ pcs: 1 }], { unitCost: 10, lowPriceThreshold: 25, lowPriceAdd: 3 }) === 3);
check('阈值/加价自定义生效（阈值 5、加价 2）',
  V.variantPriceBoost([{ pcs: 1 }], { unitCost: 0.34, lowPriceThreshold: 5, lowPriceAdd: 2 }) === 2);

// ── 页面不给颜色编码的商品（真实案例 778887421078：只有「名字→¥价→库存」）──
const noCode = { source: { offerId: '778887421078' }, colors: [{ name: '肤色', code: null, price: 0.65 }, { name: '黑色', code: null, price: 0.65 }] };
const nc = V.buildVariants(noCode, { unitCost: 0.65 });
check('无编码两色：SKU 全部唯一', new Set(nc.map(r => r.sku)).size === nc.length,
  JSON.stringify(nc.map(r => r.sku)));
check('无编码两色：原规格 SKU 按页面顺序编 S1/S2（不再全撞成 NA）',
  nc.slice(0, 2).every((r, i) => r.sku === `YQ-1078-S${i + 1}-1P`), JSON.stringify(nc.slice(0, 2).map(r => r.sku)));
check('无编码两色：颜色规格列不写假编码', nc.slice(0, 2).every((r, i) => r.colorSpec === ['肤色', '黑色'][i]),
  JSON.stringify(nc.slice(0, 2).map(r => r.colorSpec)));
check('无编码两色：名字就是两个值原文，没有我编的单位/组合',
  nc.map(r => r.nameCn).join('、') === '肤色、黑色', JSON.stringify(nc.map(r => r.nameCn)));
check('无编码两色：不再出现「三色」或「混色」字样', nc.every(r => !/混色/.test(r.nameCn + r.nameEn)),
  JSON.stringify(nc.filter(r => /三色/.test(r.nameCn + r.nameEn)).map(r => r.nameCn)));
// 三色有编码的商品：命名与 SKU 保持原样（不能被上面的改动带偏）
const tri = V.buildVariants(prod, { unitCost: 0.34 });
check('有编码三色：每行就是值原文（3 行）', tri.length === 3 && tri.map(r => r.nameCn).join('、') === '粉色、绿色、紫色',
  JSON.stringify(tri.map(r => r.nameCn)));
check('有编码三色：SKU 仍用页面编码', tri[0].sku === 'YQ-2516-C1Y1P-1P' && tri[2].sku === 'YQ-2516-C1Y1R-1P',
  JSON.stringify(tri.slice(0, 3).map(r => r.sku)));
check('有编码三色：SKU 唯一', new Set(tri.map(r => r.sku)).size === tri.length);

// ── 多级规格（父规格 × 子规格）：按组合生成，SKU 唯一，规格列动态 ──
const twoDim = { source: { offerId: '123456789012' }, specs: [
  { label: '颜色', values: [{ name: '黑色', code: 'C10Y1', price: 12.8, stock: 8200 }, { name: '白色', code: 'C11Y1', price: 12.8, stock: 7900 }] },
  { label: '尺码', values: [{ name: 'S', code: 'S1Y1' }, { name: 'M', code: 'S1Y2' }, { name: 'L', code: 'S1Y3' }] }] };
const td = V.buildVariants(twoDim, { unitCost: 12.8 });
check('两级规格：维度原样传出（颜色 + 尺码）', td.dims.map(d => d.label).join(',') === '颜色,尺码',
  JSON.stringify(td.dims.map(d => d.label)));
check('两级规格：行数 = 2 个颜色 × 3 个尺码 = 6 行（不再乘上一套编好的组合）', td.length === 6, `${td.length} 行`);
check('两级规格：SKU 唯一', new Set(td.map(r => r.sku)).size === td.length, `${td.length} 行`);
check('两级规格：SKU 同时带父/子编码（真实规格行排在最前）',
  td[0].sku === 'YQ-9012-C10Y1-S1Y1-1P' && td[2].sku === 'YQ-9012-C10Y1-S1Y2-1P',
  td.slice(0, 3).map(r => r.sku).join(' '));
check('两级规格：每行都有两维的确定值（不空着）',
  td.every(r => r.spec && r.spec['颜色'] && r.spec['尺码']), JSON.stringify(td[0].spec));
check('两级规格：英文名 = 值原文翻译 + 子规格，不带编出来的包装词',
  td.map(r => r.nameEn).join(',') === 'Black S,White S,Black M,White M,Black L,White L',
  td.map(r => r.nameEn).join(','));
check('两级规格：中文名 = 值原文 ｜子规格原文',
  td[0].nameCn === '黑色｜S', td[0].nameCn);
check('两级规格：封顶生效并标注本来有多少行',
  V.buildVariants(twoDim, { unitCost: 12.8, maxVariants: 4 }).length === 4 &&
  V.buildVariants(twoDim, { unitCost: 12.8, maxVariants: 4 })[3].truncated.total === 6);

// ── 9 个组合值规格（用户实际那个卷发棒页）：规格格子拆父/子两列，SKU/名字全来自页面数据 ──
const curlV = V.buildVariants({
  source: { offerId: '897021596330' },
  specs: [{ label: '功率', partLabels: ['父规格', '子规格'], values: [
    { name: '【英文版.欧规】紫色全自动32mm', code: null, price: 25.5, stock: 8678, parts: ['英文版.欧规', '紫色全自动32mm'] },
    { name: '【英文版.美规】紫色全自动32mm', code: null, price: 25.5, stock: 9568, parts: ['英文版.美规', '紫色全自动32mm'] },
    { name: '【英文版.英规】紫色全自动32mm', code: null, price: 25.5, stock: 10000, parts: ['英文版.英规', '紫色全自动32mm'] },
    { name: '【中文版.国标】粉色全自动32mm', code: null, price: 25.5, stock: 9999, parts: ['中文版.国标', '粉色全自动32mm'] },
    { name: '【英文版.日规】粉色全自动32mm', code: null, price: 25.5, stock: 10000, parts: ['英文版.日规', '粉色全自动32mm'] }
  ] }]
}, { unitCost: 25.5 });
check('卷发棒：5 个规格值都有原规格行', curlV.filter(r => r.kind === '原规格').length === 5,
  JSON.stringify(curlV.filter(r => r.kind === '原规格').map(r => r.nameCn)));
check('卷发棒：规格格子拆成 父规格 + 子规格（不写死「颜色规格」）',
  curlV[0].spec['父规格'] === '英文版.欧规' && curlV[0].spec['子规格'] === '紫色全自动32mm',
  JSON.stringify(curlV[0].spec));
check('卷发棒：SKU 用页面顺序 S1..S5 + 包装后缀', curlV[0].sku === 'YQ-6330-S1-1P', JSON.stringify(curlV.slice(0, 3).map(r => r.sku)));
check('卷发棒：SKU 全部唯一', new Set(curlV.map(r => r.sku)).size === curlV.length,
  JSON.stringify(curlV.map(r => r.sku)));
check('卷发棒：中文名 = 页面规格值原文（不加任何我编的东西）',
  curlV[0].nameCn === '【英文版.欧规】紫色全自动32mm', curlV[0].nameCn);
check('卷发棒：英文名把已知词换成英文（EU/Purple/Automatic）',
  /EU/.test(curlV[0].nameEn) && /Purple/.test(curlV[0].nameEn) && /Automatic 32mm/.test(curlV[0].nameEn),
  curlV[0].nameEn);
check('卷发棒：无中文残留（词表已覆盖这些词）', curlV.every(r => !r.enPending), JSON.stringify(curlV.filter(r => r.enPending).map(r => r.nameEn)));
check('卷发棒：混合行不写「混色」', curlV.every(r => !/混色/.test(r.nameCn)), JSON.stringify(curlV.map(r => r.nameCn).filter(n => /混色/.test(n))));

// ── 双规格（颜色 11 × 尺码 2）：真实规格组合先排满，封顶时先丢包装行 ──
const slProd = { source: { offerId: '841299382846' }, specs: [
  { label: '颜色', values: Array.from({ length: 11 }, (_, i) => ({ name: '色' + (i + 1), code: null, price: null, stock: null })) },
  { label: '尺码', values: [
    { name: '36-37适合35-36码', code: null, price: 11.5, stock: 3 },
    { name: '40-41适合39-40码', code: null, price: 11.5, stock: 59 }
  ] }
] };
const sv = V.buildVariants(slProd, { unitCost: 11.5 });
check('双规格：11 × 2 = 22 个真实规格组合全在', sv.filter(r => r.kind === '原规格').length === 22,
  `${sv.filter(r => r.kind === '原规格').length} 行 / 共 ${sv.length} 行`);
check('双规格：格子同时有 颜色 和 尺码 两个维度',
  sv[0].spec['颜色'] === '色1' && sv[0].spec['尺码'] === '36-37适合35-36码', JSON.stringify(sv[0].spec));
check('双规格：SKU 带父+子编码', sv[0].sku === 'YQ-2846-S1-V11-1P', JSON.stringify(sv.slice(0, 3).map(r => r.sku)));
check('双规格：SKU 全部唯一', new Set(sv.map(r => r.sku)).size === sv.length);
check('双规格：封顶 24 行时，真实规格组合一个都没丢',
  V.buildVariants(slProd, { unitCost: 11.5, maxVariants: 24 }).filter(r => r.kind === '原规格').length === 22);
check('规格列上限=1 → 只按颜色排（11 个父规格 + 封顶）',
  V.buildVariants(slProd, { unitCost: 11.5, maxDims: 1 }).filter(r => r.kind === '原规格').length === 11);
check('规格列上限相关的元信息（allDims / dimsShown）',
  V.buildVariants(slProd, { unitCost: 11.5, maxDims: 1 }).allDims.length === 2 &&
  V.buildVariants(slProd, { unitCost: 11.5, maxDims: 1 }).dimsShown === 1);

// ── 打包阶梯价（单片 2.12 / 5片装 11.5 / 10片装 23）：成本价按各自规格的标价，不混用一个平均价 ──
const ladder = { source: { offerId: '922794624735' }, specs: [{ label: '颜色', values: [
  { name: '灰色30cm*30cm', code: null, price: 2.12, stock: 1 },
  { name: '咖啡色30cm*30cm', code: null, price: 2.21, stock: 1 },
  { name: '灰色*5片装', code: null, price: 11.5, stock: 1 },
  { name: '灰色*10片装', code: null, price: 23, stock: 1 }] }] };
const lv = V.buildVariants(ladder, { unitCost: 5, maxVariants: 40 });
const costOf = (pred) => ((lv.find(pred) || {}).pricing || {}).baseCost;
const t = (x, want) => Math.abs(x - want) < 1e-9;
check('阶梯价：单片行用自己规格的标价 2.12（不是参数里的 5）',
  t(costOf(r => r.idx === 1), 2.12), costOf(r => r.idx === 1));
check('阶梯价：5片装行用 11.5',
  t(costOf(r => r.kind === '原规格' && /5片装/.test(r.nameCn)), 11.5), costOf(r => r.kind === '原规格' && /5片装/.test(r.nameCn)));
check('阶梯价：10片装行用 23',
  t(costOf(r => r.kind === '原规格' && /10片装/.test(r.nameCn)), 23), costOf(r => r.kind === '原规格' && /10片装/.test(r.nameCn)));
// 引擎档不会自己排出「一行两个值」「一个值卖多件」这种行 —— 只有 AI 档才可能排。
// 这类行的成本口径仍要正确，所以用一份 AI 计划去验（不是靠引擎编组合）。
const mixPlan = { rows: [
  { kind: '混搭', values: ['灰色30cm*30cm', '咖啡色30cm*30cm'], pcs: 2, accessory: false,
    nameCn: '灰色30cm*30cm + 咖啡色30cm*30cm ×2', nameEn: 'Grey 30cm*30cm + Coffee 30cm*30cm x2' },
  { kind: '多件', values: ['灰色*5片装'], pcs: 5, accessory: false,
    nameCn: '灰色*5片装', nameEn: 'Grey 5-Piece Pack' }
] };
const lm = V.buildVariants(ladder, { unitCost: 5, maxVariants: 40, aiPlan: mixPlan });
check('引擎档没有组合行（没有 AI 计划时只有 4 个真实规格行）', lv.length === 4, `${lv.length} 行`);
check('AI 档：一行用两个规格值 → 成本 = 各自标价相加 2.12+2.21 = 4.33',
  t(lm.find(r => /\+/.test(r.nameCn)).pricing.baseCost, 4.33),
  JSON.stringify(lm.map(r => [r.nameCn, (r.pricing || {}).baseCost])));
check('AI 档：值自带件数（5片装）→ 用整包标价 11.5，不用参数里的 5',
  t(lm.find(r => /5片装/.test(r.nameCn)).pricing.baseCost, 11.5),
  JSON.stringify(lm.map(r => [r.nameCn, (r.pricing || {}).baseCost])));
const lp = V.buildVariants(ladder, { unitCost: 5, maxVariants: 40, costMode: 'param' });
check('切成「统一拿货价」时 5片装行也用参数值（5 元/件 × 5 件 = 25）',
  Math.abs((((lp.find(r => r.kind === '原规格' && /5片装/.test(r.nameCn)) || {}).pricing || {}).baseCost) - 25) < 1e-9,
  ((lp.find(r => r.kind === '原规格' && /5片装/.test(r.nameCn)) || {}).pricing || {}).baseCost);

// ── 值名自带件数（5片装/10片装）：整包价不许再被件数乘一遍（曾经出现 11.5 → 57.5 的 25 倍错价）──
const packRow = lv.find(r => r.kind === '原规格' && /5片装/.test(r.nameCn)) || {};
check('5片装行：件数取整包 5（不是 1）', packRow.pcs === 5, packRow.pcs);
check('5片装行：成本 = 整包价 11.5（每件 2.30 × 5 件），不是 57.5',
  t((packRow.pricing || {}).baseCost, 11.5), (packRow.pricing || {}).baseCost);
check('5片装行：每件成本 = 11.5 ÷ 5 = 2.30', t(packRow.unitCost, 2.3), packRow.unitCost);
check('5片装行：名字不重复叠「5 支装」（值名里已经有）',
  /5片装/.test(packRow.nameCn) && !/5\s*支装/.test(packRow.nameCn), packRow.nameCn);
check('5片装行：SKU 件数段是 -5P', /-5P$/.test(packRow.sku || ''), packRow.sku);
const tenRow = lv.find(r => r.kind === '原规格' && /10片装/.test(r.nameCn)) || {};
check('10片装行：件数 10、成本 23', tenRow.pcs === 10 && t((tenRow.pricing || {}).baseCost, 23),
  `${tenRow.pcs} 件 / ${(tenRow.pricing || {}).baseCost}`);
check('引擎档的名字就是值原文（自造词一个都没有）',
  lv.every(r => !UNIT_WORDS.test(r.nameCn)) && lv.map(r => r.nameCn).join('|') === '灰色30cm*30cm|咖啡色30cm*30cm|灰色*5片装|灰色*10片装',
  lv.map(r => r.nameCn).join(' | '));

// packQtyOf：只认「值名里明确写了件数」，说不清就不猜
check('packQtyOf：5片装 → 5', V.packQtyOf('灰色*5片装') === 5);
check('packQtyOf：10片装 → 10', V.packQtyOf('灰色*10片装') === 10);
check('packQtyOf：3件套 → 3', V.packQtyOf('三色3件套') === 3);
check('packQtyOf：普通颜色 → 1', V.packQtyOf('灰色30cm*30cm') === 1);
check('packQtyOf：尺码值 → 1（36-37 不是件数）', V.packQtyOf('36-37适合35-36码') === 1);
check('packQtyOf：型号 → 1（3411 不是件数）', V.packQtyOf('白色【3411牛角】') === 1);
check('packQtyOf：2件起批 → 1（起批数不是包装件数）', V.packQtyOf('2件起批') === 1);
check('packQtyOf：一个值里写了多个不同件数 → 1（不猜）', V.packQtyOf('5片装/10片装') === 1);

// 值名里的「N片装 / 深灰色 / 砖红色」要能出干净的英文（否则英文名里留中文被标黄）
check('enOf：5片装 → 5-Piece Pack（不留中文）',
  /5-Piece Pack/.test(V.enOf('灰色30cm*30cm*5片装')) && !V.hasCJK(V.enOf('灰色30cm*30cm*5片装')),
  V.enOf('灰色30cm*30cm*5片装'));
check('enOf：10片装 → 10-Piece Pack',
  /10-Piece Pack/.test(V.enOf('深灰色30cm*30cm*10片装')) && !V.hasCJK(V.enOf('深灰色30cm*30cm*10片装')),
  V.enOf('深灰色30cm*30cm*10片装'));
check('enOf：砖红色 → Brick Red', /Brick Red/.test(V.enOf('砖红色30cm*30cm')), V.enOf('砖红色30cm*30cm'));
check('enOf：咖啡色 → Coffee', /Coffee/.test(V.enOf('咖啡色30cm*30cm*5片装')), V.enOf('咖啡色30cm*30cm*5片装'));
check('enOf：深绿/浅绿 → Dark/Light Green', /Dark Green/.test(V.enOf('深绿色')) && /Light Green/.test(V.enOf('浅绿色')),
  `${V.enOf('深绿色')} / ${V.enOf('浅绿色')}`);

// 真实规格行不被「混合装规格值上限」砍掉：15 个规格值就必须有 15 行原规格
const many = { source: { offerId: '9999' }, specs: [{ label: '颜色',
  values: Array.from({ length: 15 }, (_, i) => ({ name: '色' + (i + 1), code: null, price: 2 + i, stock: 1 })) }] };
const mv = V.buildVariants(many, { unitCost: 2, maxVariants: 60 });
check('15 个规格值 → 15 行「原规格」（上限只约束混合装/囤货装行）',
  mv.filter(r => r.kind === '原规格').length === 15, `${mv.filter(r => r.kind === '原规格').length} 行`);

/* AI（DeepSeek）排的变种计划：组合/件数/英文名听它的，价格与成本仍由引擎算 */
const aiProd = { source: { offerId: '2846' }, specs: [{ label: '颜色', values: [
  { name: '白色【3411牛角】', code: null, price: 11.5, stock: 3 },
  { name: '粉红【3411牛角】', code: null, price: 11.5, stock: 3 },
  { name: '【清仓随机款，尺码可指定】', code: null, price: 11.5, stock: 1 }] }] };
const aiPlan = { ok: true, model: 'deepseek-flash', rows: [
  { kind: '原规格', values: ['白色【3411牛角】'], pcs: 1, accessory: false, nameEn: 'White 3411 Horn' },
  { kind: '原规格', values: ['粉红【3411牛角】'], pcs: 1, accessory: false, nameEn: 'Pink 3411 Horn' },
  { kind: '组合装', values: ['白色【3411牛角】', '粉红【3411牛角】'], pcs: 2, accessory: false, nameEn: 'White + Pink - 2 Pack' },
  { kind: '带配件', values: ['白色【3411牛角】'], pcs: 1, accessory: true, nameEn: 'White 3411 Horn with Case' }
] };
const air = V.buildVariants(aiProd, { unitCost: 11.5, costMode: 'spec', aiPlan });
// 4 行 AI 计划 + 追加的组合套装款（1 件装与 AI 的单品行同 SKU，跳过；2/3/6/12 + 多色混搭 = 5 行）
check('AI 计划 4 行 + 追加组合套装 5 行 = 9 行', air.length === 9, air.length + ' 行');
// 用户补充条件限了「名字不超过 9 个字」→ 追加款名字也守这条（服务端解析出来挂在计划上）
const airNm = V.buildVariants(aiProd, { unitCost: 9, costMode: 'spec', marginPct: 33, bargainPct: 20, discountPct: 15, freightPct: 10, marginBase: 'net', aiPlan: { rows: [{ kind: '单件装', values: ['白色'], pcs: 1, accessory: false, nameEn: 'White', nameCn: '白色' }], nameLimit: 9 } });
check('计划带 nameLimit=9 → 追加款名字也不超过 9 字（逐级压缩成 白色×2 这种）',
  airNm.filter(r => r.appended).length > 0 && airNm.filter(r => r.appended).every(r => String(r.nameCn).length <= 9),
  airNm.filter(r => r.appended).map(r => String(r.nameCn).length + ':' + r.nameCn).join(' | '));
check('追加款在：2/3/6/12 件装 + 多色混搭，且 1 件装没有重复出现',
  ['2件装', '3件装', '6件装', '12件装', '多色混搭'].every(k => air.some(r => r.kind === k && r.appended)) &&
  air.filter(r => r.pcs === 1 && !r.accessory).length === 2,
  air.map(r => r.kind + ':' + r.pcs).join(' '));
check('追加款 SKU 唯一（1 件装撞 SKU 时跳过，不是加个 -2 后缀）',
  new Set(air.map(r => r.sku)).size === air.length, air.map(r => r.sku).join(' '));
check('AI 给的英文名直接用（不再走词表、不标黄）',
  air.every(r => !r.enPending) && /White 3411 Horn/.test(air[0].nameEn), air.map(r => r.nameEn).join(' | '));
check('AI 排的组合装件数=2 被保留', air.some(r => r.pcs === 2 && /2 Pack/.test(r.nameEn)));
check('成本仍由引擎按各行自己标价算（11.5）', air.every(r => Math.abs(r.unitCost - 11.5) < 1e-9), air.map(r => r.unitCost).join(','));
const pricedAi = air.map(r => V.priceVariant(r, { unitCost: 11.5 }));
check('定价仍由引擎算：2 件装定价 = 单支 × 2（AI 插不进去）',
  Math.abs(pricedAi[2].price - pricedAi[0].price * 2) < 0.01,
  `${pricedAi[2].price.toFixed(3)} vs ${(pricedAi[0].price * 2).toFixed(3)}`);
check('SKU 仍按引擎规则生成且唯一', new Set(air.map(r => r.sku)).size === air.length, air.map(r => r.sku).join(','));
const guard = V.buildVariants(aiProd, { unitCost: 11.5, aiPlan: { rows: [
  { kind: '原规格', values: ['页面上没有的颜色'], pcs: 1, nameEn: 'Ghost' },
  { kind: '原规格', values: ['白色【3411牛角】'], pcs: 1, nameEn: 'White' }] } });
check('AI 行里的值在表里找不到 → 该行被丢掉（第二道保险）',
  guard.filter(r => !r.appended).length === 1 && guard.filter(r => !r.appended)[0].nameEn === 'White',
  guard.filter(r => !r.appended).map(r => r.nameEn).join(','));

/* AI 写的中文名：用它的；它没写 → 回落成**值原文**（不是模板）。
 * 用户原话「这尾巴的变种名是被你写死了吗」「不许给我写死任何单位和组合」——
 * 所以「名字是谁写的」和「引擎会不会偷偷补词」这两件事都要有测试盯着。 */
const aiPlanCn = { rows: [
  { kind: '单品', values: ['白色【3411牛角】'], pcs: 1, accessory: false, nameCn: '白色牛角款', nameEn: 'White Horn' },
  { kind: '单品', values: ['粉红【3411牛角】'], pcs: 1, accessory: false, nameEn: 'Pink Horn' },
  { kind: '一组', values: ['白色【3411牛角】'], pcs: 1, accessory: true, nameCn: '白色牛角款（含配件）', nameEn: 'White Horn' }
] };
const cnRows = V.buildVariants(aiProd, { unitCost: 11.5, aiPlan: aiPlanCn });
check('AI 写的中文名直接用', cnRows[0].nameCn === '白色牛角款', cnRows[0].nameCn);
check('那一行标明「中文名来自 AI」（aiCn=true）', cnRows[0].aiCn === true && cnRows[1].aiCn === false,
  JSON.stringify(cnRows.map(r => r.aiCn)));
check('AI 没给中文名 → 回落成值原文，一个多余的字都不加',
  cnRows[1].nameCn === '粉红【3411牛角】', cnRows[1].nameCn);
check('引擎绝不替模型补「便携收纳盒」这类配件词（名字里没有就没有）',
  !/收纳盒|支装/.test(cnRows.map(r => r.nameCn).join(' ')), cnRows.map(r => r.nameCn).join(' | '));
check('配件这件事只落在数据列上（accessory=true / SKU 带 -C），不进名字',
  (cnRows.find(r => r.accessory) || {}).accessory === true && /-C$/.test((cnRows.find(r => r.accessory) || {}).sku),
  (cnRows.find(r => r.accessory) || {}).sku);

/* 值名自带件数时，模型又写一遍件数 → 去掉重复的那段（但单件值行不许动：「双支装」是必要信息） */
const packProd = { source: { offerId: '1' }, specs: [{ label: '颜色', values: [
  { name: '灰色30cm*30cm*5片装', code: null, price: 11.5, stock: 9 },
  { name: '白色30cm*30cm*5片装', code: null, price: 11.5, stock: 9 }] }] };
const dupRows = V.buildVariants(packProd, { unitCost: 11.5, costMode: 'spec', aiPlan: { rows: [
  { kind: '原规格', values: ['灰色30cm*30cm*5片装'], pcs: 5, nameCn: '灰色30cm*30cm*5片装 五片装', nameEn: 'Grey 5-Piece Pack' },
  { kind: '组合装', values: ['灰色30cm*30cm*5片装', '白色30cm*30cm*5片装'], pcs: 5, nameCn: '2 款颜色 30cm*30cm*5片装 五支装 混合装', nameEn: 'Grey + White 5-Piece Mix' }
] } });
check('值名里已有件数、模型又说一遍 → 去掉重复那段', dupRows[0].nameCn === '灰色30cm*30cm*5片装', dupRows[0].nameCn);
check('混装行同理（去掉重复件数、保留组合说明）', !/五支装/.test(dupRows[1].nameCn) && /混合装/.test(dupRows[1].nameCn), dupRows[1].nameCn);

const singleProd = { source: { offerId: '2' }, specs: [{ label: '颜色', values: [
  { name: '灰色30cm*30cm', code: null, price: 2.12, stock: 9 }] }] };
const keepDbl = V.buildVariants(singleProd, { unitCost: 2.12, costMode: 'spec', aiPlan: { rows: [
  { kind: '组合装', values: ['灰色30cm*30cm'], pcs: 2, nameCn: '灰色30cm*30cm 双支装', nameEn: 'Grey 2 Pack' }] } });
check('单件值行里的「双支装」不会被误删（那是必要信息）',
  keepDbl.some(r => !r.appended && /双支装/.test(r.nameCn)),
  keepDbl.filter(r => !r.appended).map(r => r.nameCn).join(' | '));
check('不传 AI 计划时走引擎规则：3 个规格值 → 3 行，全是值原文',
  V.buildVariants(aiProd, { unitCost: 11.5 }).length === 3 &&
  V.buildVariants(aiProd, { unitCost: 11.5 }).every(r => !UNIT_WORDS.test(r.nameCn)));

/* ---------- 天然件数：同一维度内相加、维度之间相乘 ----------
 * 用户报的「件数为什么翻倍了」就是这里算错：颜色 1 件 + 尺码 1 件 = 2 件（应该相乘 = 1 件）。
 * 双规格商品上一双鞋被当成两件卖，成本 11.5 变 23、定价跟着翻倍。 */
const V_ = V;
near('天然件数：颜色 1 件 × 尺码 1 件 = 1 件（不是 2 件）',
  V_.naturalPcsOf([[{ name: '白色' }], [{ name: '36-37适合35-36码' }]]), 1);
near('天然件数：2 色 × 1 码 = 2 件',
  V_.naturalPcsOf([[{ name: '白色' }, { name: '黑色' }], [{ name: '36-37' }]]), 2);
near('天然件数：2 色 × 2 码 = 4 件',
  V_.naturalPcsOf([[{ name: '白色' }, { name: '黑色' }], [{ name: '36-37' }, { name: '40-41' }]]), 4);
near('天然件数：单个「5片装」值 = 5 件', V_.naturalPcsOf([[{ name: '灰色30cm*30cm*5片装' }]]), 5);
near('天然件数：空行兜底 = 1 件', V_.naturalPcsOf([]), 1);
near('天然件数：尺寸里的数字不被当件数（30cm*30cm → 1）',
  V_.naturalPcsOf([[{ name: '灰色30cm*30cm' }]]), 1);

// 双规格 + AI 计划：模型给 pcs=1 的一件装行，件数就必须是 1、成本就是单件价
const twoDimProd = {
  source: { offerId: '841299382846' }, suggestedUnitCost: 11.5,
  specs: [
    { label: '颜色', values: [{ name: '白色【3411牛角】', code: null, price: 11.5 }, { name: '粉红【3411牛角】', code: null, price: 11.5 }] },
    { label: '尺码', values: [{ name: '36-37适合35-36码', code: null, price: 11.5 }, { name: '40-41适合39-40码', code: null, price: 11.5 }] }
  ]
};
const aiTwo = V.buildVariants(twoDimProd, { unitCost: 11.5, costMode: 'spec', aiPlan: { rows: [
  { kind: '单品', values: ['白色【3411牛角】', '36-37适合35-36码'], pcs: 1, accessory: false, nameEn: 'White 36-37' },
  { kind: '两件装', values: ['白色【3411牛角】', '36-37适合35-36码'], pcs: 2, accessory: false, nameEn: 'White 36-37 x2' },
  { kind: '混搭', values: ['白色【3411牛角】', '粉红【3411牛角】', '36-37适合35-36码'], pcs: 2, accessory: false, nameEn: 'White+Pink 36-37' }
] } });
  // 追加的组合套装款也在这张表里；这几条断言说的是 AI 自己排的那几行 → 只看非追加行
const aiTwoPure = aiTwo.filter(r => !r.appended);
check('双规格 AI 行：一件装行的件数 = 1（不是 2）', aiTwoPure[0] && aiTwoPure[0].pcs === 1, aiTwoPure[0] && aiTwoPure[0].pcs);
near('双规格 AI 行：一件装行的每件成本 = 11.5（不是 23）',
  aiTwoPure[0] && aiTwoPure[0].unitCost, 11.5);
// 11.5 + 运费 10% = 12.65 总成本 → 12.65 ÷ (0.68×0.67) = 27.77（曾被算成约两倍）
near('双规格 AI 行：一件装行的定价 = 27.77（不是按两件算的 55.53）', aiTwoPure[0] && aiTwoPure[0].pricing.price, 27.77);
check('双规格 AI 行：两件装行件数 = 2', aiTwoPure[1] && aiTwoPure[1].pcs === 2, aiTwoPure[1] && aiTwoPure[1].pcs);
check('双规格 AI 行：2 色混搭行件数 = 2（同维度两个值相加）', aiTwoPure[2] && aiTwoPure[2].pcs === 2, aiTwoPure[2] && aiTwoPure[2].pcs);

// 混搭行：同一维度里挑了多个值 → 那一列必须把值都列出来（否则表里看不到，件数看着莫名其妙）
const mixTwo = V.buildVariants(twoDimProd, { unitCost: 11.5, costMode: 'spec', aiPlan: { rows: [
  { kind: '混搭', values: ['白色【3411牛角】', '粉红【3411牛角】', '36-37适合35-36码', '40-41适合39-40码'],
    pcs: 4, accessory: false, nameEn: 'Mix x4' }
] } });
check('混搭行：4 个值（2 色 × 2 码）→ 件数 = 4', mixTwo[0] && mixTwo[0].pcs === 4, mixTwo[0] && mixTwo[0].pcs);
check('混搭行：颜色列把两个颜色都列出来', /白色.*粉红|粉红.*白色/.test((mixTwo[0] && mixTwo[0].spec['颜色']) || ''),
  mixTwo[0] && mixTwo[0].spec['颜色']);
check('混搭行：尺码列把两个尺码都列出来（以前只显示第一个，看不出为什么是 4 件）',
  /36-37.*40-41|40-41.*36-37/.test((mixTwo[0] && mixTwo[0].spec['尺码']) || ''), mixTwo[0] && mixTwo[0].spec['尺码']);

/* ---- 规格组合价（页面内嵌 skuInfoMap → prod.skuPrices）：不同颜色不同价，每行按自己那组算 ---- */
const SKU_SEP = '\u0000';
const skuProd = {
  source: { offerId: '1081733292371' },
  specs: [
    { label: '颜色', values: [
      { name: '黄色【小花豹】', code: null, price: 18.41, stock: 3482 },
      { name: '咖啡【小熊-情侣款】', code: null, price: 11.35, stock: 3485 } ] },
    { label: '尺码', values: [
      { name: '36-37【建议拍大一码】', code: null, price: 11.35, stock: 3482 },
      { name: '38-39【建议拍大一码】', code: null, price: 11.35, stock: 3478 } ] }
  ],
  skuPrices: {
    [['黄色【小花豹】', '36-37【建议拍大一码】'].join(SKU_SEP)]: 18.41,
    [['黄色【小花豹】', '38-39【建议拍大一码】'].join(SKU_SEP)]: 18.41,
    [['咖啡【小熊-情侣款】', '36-37【建议拍大一码】'].join(SKU_SEP)]: 11.35,
    [['咖啡【小熊-情侣款】', '38-39【建议拍大一码】'].join(SKU_SEP)]: 11.35,
  },
  skuComboCount: 4,
};
const baseRows = V.buildVariants(skuProd, { unitCost: 9.99, costMode: 'spec' });
const costOfRow = (rows, name) => { const r = rows.find(x => x.nameCn === name); return r ? r.unitCost : null; };
near('组合价：黄色行 = 18.41（不是默认尺码价）', costOfRow(baseRows, '黄色【小花豹】｜36-37【建议拍大一码】'), 18.41);
near('组合价：咖啡行 = 11.35（同尺码不同颜色，价不一样）', costOfRow(baseRows, '咖啡【小熊-情侣款】｜36-37【建议拍大一码】'), 11.35);
check('组合价：不同色的两行价真的不同（用户报的「列表里价格都一样」就该消失）',
  new Set(baseRows.map(r => r.unitCost)).size === 2,
  [...new Set(baseRows.map(r => r.unitCost))].join(' / '));
const mixRows = V.buildVariants(skuProd, { unitCost: 9.99, costMode: 'spec', aiPlan: { rows: [
  { kind: '混搭', values: ['黄色【小花豹】', '咖啡【小熊-情侣款】', '36-37【建议拍大一码】'], pcs: 2, accessory: false, nameEn: 'Mix x2' },
  { kind: '多件装', values: ['黄色【小花豹】', '36-37【建议拍大一码】'], pcs: 3, accessory: false, nameEn: 'x3' },
] } });
const mixRow = mixRows.find(r => r.kind === '混搭');
near('组合价：混搭 2 色 × 1 码的每件成本 = (18.41+11.35)/2', mixRow.unitCost, (18.41 + 11.35) / 2);
near('组合价：混搭行总成本 = 两份相加', mixRow.unitCost * mixRow.pcs, 18.41 + 11.35);
const comboPackRow = mixRows.find(r => r.kind === '多件装');
near('组合价：同一组合买 3 件 → 每件还是那一份的价（不会被除成 1/3）', comboPackRow.unitCost, 18.41);
near('组合价：没有 skuPrices 时行为照旧（回落参数价）',
  costOfRow(V.buildVariants({ source: { offerId: '1' }, specs: [
    { label: '颜色', values: [{ name: '黄', code: null, price: null, stock: 1 }] }] }, { unitCost: 9.99, costMode: 'spec' }), '黄'),
  9.99);

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
