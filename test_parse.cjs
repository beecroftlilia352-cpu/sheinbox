/* 解析层回归：用真实抓下来的 1688 页面文本（fixtures/offer-1063828892516.md）验证
 * 运行：node test_parse.cjs
 */
const fs = require('fs');
const path = require('path');
const P = require('./parse-1688.js');

const fx = fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-1063828892516.md'), 'utf8');
const prod = P.parse(fx, { url: 'https://detail.1688.com/offer/1063828892516.html' });

let bad = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`); if (!cond) bad++; };
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `实际=${JSON.stringify(got)}`);

eq('offerId 提取正确', prod.source.offerId, '1063828892516');
check('标题提取（含"刮毛刀"）', !!prod.title && /刮毛刀/.test(prod.title), prod.title);
eq('品牌 = 纳合', prod.brand, '纳合');
eq('产品类别 = 刮毛刀', prod.category, '刮毛刀');
eq('单件重量 = 13 g', prod.weight_g, 13);
eq('箱装数量 = 1000', prod.box_qty, 1000);
eq('刀片数 = 1', prod.bladeCount, 1);
eq('是否进口 = false', prod.isImported, false);
eq('是否跨境出口专供货源 = false（比价风险信号）', prod.crossBorderOnly, false);
eq('是否有专利 = false', prod.hasPatent, false);
eq('颜色 3 个', prod.colors.map(c => c.name), ['粉色', '绿色', '紫色']);
eq('颜色编码正确', prod.colors.map(c => c.code), ['C1Y1P', 'C1Y1Q', 'C1Y1R']);
eq('三色库存', prod.colors.map(c => c.stock), [6853667, 6853766, 6853617]);
check('抓到价格档 ≥2 个', prod.priceTiers.length >= 2, JSON.stringify(prod.priceTiers.map(t => t.type + ':' + t.price)));
check('含 0.34 代发价档', prod.priceTiers.some(t => t.price === 0.34), JSON.stringify(prod.priceTiers.map(t => t.price)));
check('含 0.03 活动/混批价档', prod.priceTiers.some(t => t.price === 0.03));
eq('建议拿货价 = 0.34（默认取规格标价）', prod.suggestedUnitCost, 0.34);
eq('拿货价来源标注为规格标价', prod.suggestedUnitCostSource, '规格标价（≥4件）');
eq('三个颜色的规格标价一致 = 0.34', prod.colors.map(c => c.price), [0.34, 0.34, 0.34]);
eq('规格标价字段 = 0.34', prod.specPrice, 0.34);
eq('候选档位第一位是规格标价', prod.priceCandidates[0].type, '规格标价');
check('规格标价排在活动价之前', prod.priceCandidates[0].price === 0.34,
  JSON.stringify(prod.priceCandidates.map(c => c.type + ':' + c.price)));
check('置信度全绿', prod.missing.length === 0, 'missing=' + JSON.stringify(prod.missing));
check('运费提示抓到', /¥?\s*1\s*起/.test(prod.freightNote || ''), prod.freightNote);

// 空输入不能崩、不能编数据
const empty = P.parse('', { url: null });
check('空输入：字段为空而非编造', empty.title === null && empty.colors.length === 0 && empty.priceTiers.length === 0);
check('空输入：缺失字段被标记', empty.missing.length === 5, JSON.stringify(empty.missing));

// HTML 输入走另一条路径
const html = `<html><head><meta property="og:title" content="测试商品 刮毛刀"></head><body>
<div>颜色</div><div>粉色#C1Y1P#</div><div>¥0.34库存1234件</div><div>¥0.03 10件混批</div>
<table><tr><td>品牌</td><td>纳合</td></tr><tr><td>箱装数量</td><td>1000</td></tr></table>
<img src="https://cbu01.alicdn.com/img/ibank/O1CN01rkyu6A28iUD6o3jM0_!!948387966-0-cib.jpg_.webp">
</body></html>`;
const h = P.parse(html, { url: 'https://detail.1688.com/offer/9999999999999.html' });
eq('HTML：标题来自 og:title', h.title, '测试商品 刮毛刀');
eq('HTML：颜色与库存', [h.colors[0].name, h.colors[0].stock], ['粉色', 1234]);
eq('HTML：箱装数量', h.box_qty, 1000);
check('HTML：抓到主图', h.images.length === 1 && /cbu01\.alicdn/.test(h.images[0]), h.images[0]);
eq('HTML：offerId', h.source.offerId, '9999999999999');

// ── 第二个真实样本：规格块**不带页面编码**的商品（黑/肤两色，件重尺是"表头一行+数值一行"）
const fx2 = fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-778887421078.txt'), 'utf8');
const p2 = P.parse(fx2, { url: 'https://detail.1688.com/offer/778887421078.html' });
eq('无编码样本：offerId', p2.source.offerId, '778887421078');
eq('无编码样本：读到 2 个规格（不是 0）', p2.colors.map(c => c.name), ['黑色', '肤色']);
eq('无编码样本：code 留 null（不编造页面编码）', p2.colors.map(c => c.code), [null, null]);
eq('无编码样本：规格价 0.65', p2.colors.map(c => c.price), [0.65, 0.65]);
eq('无编码样本：规格库存', p2.colors.map(c => c.stock), [976593, 967708]);
eq('无编码样本：重量 = 10 g（件重尺表数值在下一行）', p2.weight_g, 10);
eq('无编码样本：拿货价 = 0.65 规格标价', [p2.suggestedUnitCost, p2.suggestedUnitCostSource], [0.65, '规格标价']);
check('无编码样本：colors 置信度为真', p2.confidence.colors === true && !p2.missing.includes('colors'),
  'missing=' + JSON.stringify(p2.missing));

// 反例：只有"颜色"字样、没有「名字→价→库存」三件套 → 不能瞎编颜色
const noSpec = P.parse('商品属性\n颜色\n肤色,黑色\n品牌\n无\n代发价 ¥0.65\n', { url: null });
eq('无规格块时颜色为空（不瞎编）', noSpec.colors.length, 0);

// 反例：推荐位的「¥1.04 已售8万+个」不能被当成规格
const noise = P.parse('¥1.04\n已售8万+个\n库存999件\n', { url: null });
eq('推荐位噪声不成规格', noise.colors.length, 0);

// ── 规格维度：不写死「颜色」，父规格/子规格各成一维 ──
eq('腋毛刀：规格维度标签 = 颜色', prod.specs.map(d => d.label), ['颜色']);
eq('腋毛刀：父规格 3 个值', prod.specs[0].values.map(v => v.name), ['粉色', '绿色', '紫色']);
eq('腋毛刀：父规格值带编码', prod.specs[0].values.map(v => v.code), ['C1Y1P', 'C1Y1Q', 'C1Y1R']);
eq('鞋垫（无编码页）：维度标签也是 颜色', p2.specs.map(d => d.label), ['颜色']);
const two = ['# 纯棉短袖T恤男', '分销代发 ≥10件 ¥12.80',
  '### 颜色', '黑色#C10Y1#', '¥12.80库存8200件', '白色#C11Y1#', '¥12.80库存7900件',
  '### 尺码', 'S#S1Y1#', '¥12.80库存1200件', 'M#S1Y2#', '¥12.80库存1500件', 'L#S1Y3#', '¥12.80库存900件',
  '| 重量(g) | 180 |'].join('\n');
const t2 = P.parse(two, { url: 'https://detail.1688.com/offer/123456789012.html' });
eq('两级规格：维度 = 颜色 + 尺码（顺序即父/子）', t2.specs.map(d => d.label), ['颜色', '尺码']);
eq('两级规格：父规格 2 个值', t2.specs[0].values.map(v => v.name), ['黑色', '白色']);
eq('两级规格：子规格 3 个值', t2.specs[1].values.map(v => v.name), ['S', 'M', 'L']);
eq('两级规格：子规格也带编码与库存', [t2.specs[1].values[0].code, t2.specs[1].values[2].stock], ['S1Y1', 900]);
eq('两级规格：兼容字段 colors = 父规格', t2.colors.map(c => c.name), ['黑色', '白色']);
eq('两级规格：specLabel = 父规格标签', t2.specLabel, '颜色');

// ── 第三种页面：组合值规格（【英文版.欧规】紫色全自动32mm），9 个值 + 拆成父/子两列 ──
const curl = P.parse(require('fs').readFileSync(require('path').join(__dirname, 'fixtures/offer-897021596330.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/897021596330.html' });
eq('卷发棒：读到 1 个规格维度', curl.specs.map(d => d.label), ['功率']);
eq('卷发棒：9 个规格值全读到（值长 17 字符，旧正则卡 16 会全丢）', curl.specs[0].values.length, 9);
eq('卷发棒：每个值都带价格', curl.specs[0].values.every(v => v.price === 25.5), true);
eq('卷发棒：组合值拆成父/子两列', curl.specs[0].partLabels, ['父规格', '子规格']);
eq('卷发棒：父规格 = 【】里的部分', curl.specs[0].values[0].parts, ['英文版.欧规', '紫色全自动32mm']);
eq('卷发棒：值不超过 64 字符，原样不加工', curl.specs[0].values[8].name, '【英文版.日规】粉色全自动32mm');
eq('卷发棒：拿货价取规格标价 25.5', curl.suggestedUnitCost, 25.5);
eq('卷发棒：颜色兼容层 = 第一个维度', curl.colors.length, 9);

// ── 第四个页面：双规格（颜色 11 值 + 尺码 2 值），价+库存只挂在最后一个维度上 ──
const sl = P.parse(require('fs').readFileSync(require('path').join(__dirname, 'fixtures/offer-841299382846.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/841299382846.html' });
eq('棉拖鞋：读到 2 个规格维度（颜色 + 尺码）', sl.specs.map(d => d.label), ['颜色', '尺码']);
eq('棉拖鞋：颜色 11 个值', sl.specs[0].values.length, 11);
eq('棉拖鞋：颜色这一维没有价/库存（页面就没给）', sl.specs[0].values.every(v => v.price === null), true);
eq('棉拖鞋：尺码带规格标价 11.5', sl.specs[1].values.map(v => v.price), [11.5, 11.5]);
eq('棉拖鞋：拿货价按「规格标价」= 11.5（不是促销估算）', sl.suggestedUnitCost, 11.5);
eq('棉拖鞋：促销估算（新人价/首件预估）归到活动价', sl.priceTiers.filter(t => t.type === '活动价').map(t => t.price), [2.8, 5.8]);
eq('棉拖鞋：推荐位的垃圾档位已过滤（2/4/5/8.5/3.9 一个都不要）',
  sl.priceTiers.every(t => ![2, 4, 5, 6, 8.5, 3.9].includes(t.price)), true);
eq('棉拖鞋：firstSpec label 写全（specLabel）', sl.specLabel, '颜色');

// ── 第五个页面：一维多值 + 每个值自带价（打包阶梯：单片 2.12 / 5片装 11.5 / 10片装 23）──
const pd = P.parse(require('fs').readFileSync(require('path').join(__dirname, 'fixtures/offer-922794624735.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/922794624735.html' });
eq('拼接地板：读到 1 个规格维度、15 个值', [(pd.specs || []).length, ((pd.specs || [])[0] || {}).values.length], [1, 15]);
eq('拼接地板：规格标价取最低那一档（单片 2.12），不是众数 23', pd.specPrice, 2.12);
eq('拼接地板：标价不一致要留区间信息', pd.specPriceSpread && [pd.specPriceSpread.min, pd.specPriceSpread.max], [2.12, 23]);
eq('拼接地板：source 文案说明是「最低的一档」', /最低的一档/.test(pd.specPriceSource || ''), true);
eq('拼接地板：10片装那个值自己带 23 的标价', ((pd.specs[0].values || []).find(v => /10片装/.test(v.name)) || {}).price, 23);
eq('拼接地板：推荐位里别的商品的价格不许进档位（¥35 是别人的）', (pd.priceTiers || []).every(t => t.price !== 35), true);
eq('拼接地板：拿货价 = 2.12（单件出货成本）', pd.suggestedUnitCost, 2.12);

// ── 第六个页面：纯数字尺码（36~45）+ 标签被备注粘住（「尺码按包起批，每包5双」）+ 件重尺表头没有长(cm) ──
const sp = P.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-791436406391.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/791436406391.html' });
eq('除臭鞋垫：读到 2 个规格维度（颜色 + 尺码）', sp.specs.map(d => d.label), ['颜色', '尺码']);
eq('除臭鞋垫：颜色 8 值', sp.specs[0].values.length, 8);
eq('除臭鞋垫：尺码 10 值且是纯数字 36~45（旧逻辑「纯数字不是规格值」会让整单 0 维度）',
  sp.specs[1].values.map(v => v.name), ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45']);
eq('除臭鞋垫：尺码值带标价 0.3 与库存', [sp.specs[1].values[0].price, sp.specs[1].values[9].stock], [0.3, 96929]);
eq('除臭鞋垫：重量 20（表头没有长(cm)，靠「件重尺」路标 + 重量(g) 列读）', sp.weight_g, 20);
eq('除臭鞋垫：colors 兼容字段 = 颜色维 8 值', sp.colors.length, 8);
// 纯数字尺码的最小复现（不依赖整页）
const dg = P.parse('颜色\n红色\n蓝色\n尺码\n36\n¥0.3\n库存10件\n37\n¥0.3\n库存20件\n', { url: null });
eq('纯数字尺码（36/37）能当规格值，且不并进颜色维', dg.specs.map(d => d.label), ['颜色', '尺码']);
eq('纯数字尺码：值名与价都在', dg.specs[1].values.map(v => v.name + '/' + v.price), ['36/0.3', '37/0.3']);

// ── 第八个页面：长尺码名带「，」+ 定制加价项（+¥0.2/0.3…）+ 主价旁就是「已售/对比」——整单价格曾被读错成 0.20 ──
const yx = P.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-1070076236814.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/1070076236814.html' });
eq('雨鞋套：维度 = 颜色 + 规格（顺序不颠倒）', yx.specs.map(d => d.label), ['颜色', '规格']);
eq('雨鞋套：颜色 4 值 / 规格 4 值（「靴子拍大两码」不许被劈成独立规格值）',
  [yx.specs[0].values.length, yx.specs[1].values.length], [4, 4]);
eq('雨鞋套：尺码值 = 整段原文（含「，靴子拍大两码」）', yx.specs[1].values[0].name,
  'M【适合尺码37-38】运动鞋/厚底鞋建议拍大一码，靴子拍大两码');
eq('雨鞋套：没有「靴子拍大两码」这种被劈出来的假值',
  yx.specs[1].values.every(v => v.name !== '靴子拍大两码'), true);
eq('雨鞋套：尺码带标价 12.8 与库存（之前全 null → 表里成本错成 0.20）',
  [yx.specs[1].values[0].price, yx.specs[1].values.map(v => v.stock)], [12.8, [3779, 2401, 632, 1195]]);
eq('雨鞋套：规格标价 = 12.8', yx.specPrice, 12.8);
eq('雨鞋套：拿货价默认 = 12.8', yx.suggestedUnitCost, 12.8);
eq('雨鞋套：定制加价项（+¥0.2/0.3/0.4…）不许进价格档位', (yx.priceTiers || []).some(t => t.price < 5), false);
eq('雨鞋套：档位里只有真价 12.8（推荐区 6.00/6.21/14.1… 全在规格块之后，已被 zone 切掉）',
  (yx.priceTiers || []).map(t => t.price), [12.8]);
eq('雨鞋套：件重尺表重量 350g', yx.weight_g, 350);
eq('雨鞋套：主价旁有「已售/对比」也要能读到（NOISE 窗口不许误杀主价）', (yx.priceTiers || []).length > 0, true);

/* 已售罄的规格值不抓取（用户要求）：库存 0 / 名字里写着售罄的，都不进规格；
 * 库存数据本身没有的（页面没写）必须保留 —— 不猜。 */
// 直接改真实 fixture（卷发棒 897021596330，功率 9 个值）：把第 1 个值改成库存 0、
// 第 2 个值名字加上「【已售罄】」，看它们是不是都被踢掉，而没写库存的照旧保留
const baseFx = fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-897021596330.txt'), 'utf8');
const soText = baseFx.replace(/库存8678个/, '库存0个')
  .replace('【英文版.美规】紫色全自动32mm', '【英文版.美规】紫色全自动32mm【已售罄】');
const soProd = P.parse(soText, { url: 'https://detail.1688.com/offer/897021596330.html' });
eq('已售罄：库存 0 的规格值不进规格（9 个值 → 7 个）', (soProd.specs[0].values || []).length, 7);
eq('已售罄：名字里带「已售罄」的也不进规格', (soProd.specs[0].values || []).some(v => /已售罄/.test(v.name)), false);
check('已售罄：库存 0 那个值记在 soldOut 里（页面会提示，不许悄悄消失）',
  (soProd.soldOut || []).some(n => /欧规.*紫色/.test(n)), JSON.stringify(soProd.soldOut));
check('已售罄：页面没写库存的值照旧保留（不猜）',
  (soProd.specs[0].values || []).some(v => /欧规/.test(v.name)), (soProd.specs[0].values || []).map(v => v.name).join(' / ').slice(0, 80));

// 整维都售罄 → 这一维不列（否则表里会出现一列空规格）
const aoProd = P.parse(baseFx.replace(/库存\d+个/g, '库存0个'), { url: 'https://detail.1688.com/offer/897021596330.html' });
eq('已售罄：整维都售罄 → 不列这一维', (aoProd.specs || []).length, 0);

/* 尺寸信息：件重尺表（按表头列名定位，多规格 → 区间）+ 属性行「尺寸」原文 */
const sz1 = P.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-1002135913894.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/1002135913894.html' }).size || {};
check('尺寸：件重尺表读出长宽高（多规格 → 区间）',
  sz1.l === '27.5–32' && sz1.w === '24.5–27' && sz1.h === '9–14',
  JSON.stringify(sz1));
const sz2 = P.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-778887421078.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/778887421078.html' }).size || {};
check('尺寸：没有颜色/尺码前置列的表也读对（8/7/2）', sz2.l === '8' && sz2.w === '7' && sz2.h === '2' && sz2.volume === '112', JSON.stringify(sz2));
check('尺寸：属性行的「尺寸」原文也带上（7*7.5）', sz2.text === '7*7.5', JSON.stringify(sz2.text));
const sz3 = P.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-1081733292371.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/1081733292371.html' }).size;
check('尺寸：页面上没有尺寸信息 → 不给（不编）', sz3 === null, JSON.stringify(sz3));

/* 商品材质：两种排版都要读对（属性表带制表符；详情区是「值在上、标签在下」），SEO 长句里的不算 */
const mt1 = P.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-1081733292371.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/1081733292371.html' });
const mt1s = (mt1.material || []).map(x => x.label + '=' + x.value);
check('材质：拖鞋页读到 鞋底/鞋面/内里/鞋垫 四项',
  mt1s.includes('鞋底材质=EVA') && mt1s.includes('鞋面材质=人造毛绒') && mt1s.includes('内里材质=人造短毛绒'),
  mt1s.join(' ｜ '));
const mt2 = P.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-1002135913894.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/1002135913894.html' });
const mt2s = (mt2.material || []).map(x => x.label + '=' + x.value);
check('材质：另一双拖鞋 鞋面材质=皮毛一体（不是隔壁那行的值）', mt2s.includes('鞋面材质=皮毛一体'), mt2s.join(' ｜ '));
const mt3 = P.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-922794624735.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/922794624735.html' });
const mt3s = (mt3.material || []).map(x => x.label + '=' + x.value);
check('材质：「材质」单独成行也认（地板 → 材质=木塑）', mt3s.includes('材质=木塑'), mt3s.join(' ｜ '));
const mt4 = P.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-778887421078.txt'), 'utf8'),
  { url: 'https://detail.1688.com/offer/778887421078.html' });
check('材质：只有 SEO 长句里出现「材质」→ 不算（不许编）', (mt4.material || []).length === 0, JSON.stringify(mt4.material));

/* 规格组合价（页面内嵌 skuInfoMap）：正文里只有默认组合的价，必须靠它才能算出「每个规格不一样」的价 */
const fx108 = fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-1081733292371.txt'), 'utf8');
const SEP = '\u0000';
const skuInfo = {};
skuInfo[['黄色【小花豹】', '36-37【建议拍大一码】'].join(SEP)] = { price: 18.41, net: 18.41, stock: 3482 };
skuInfo[['黄色【小花豹】', '38-39【建议拍大一码】'].join(SEP)] = { price: 18.41, net: 18.41, stock: 3478 };
skuInfo[['咖啡【小熊-情侣款】', '36-37【建议拍大一码】'].join(SEP)] = { price: 12.20, net: 11.35, stock: 3485 };
skuInfo[['咖啡【小熊-情侣款】', '38-39【建议拍大一码】'].join(SEP)] = { price: 12.20, net: 11.35, stock: 0 };
const p108 = P.parse(fx108, { url: 'https://detail.1688.com/offer/1081733292371.html', skuInfo });
eq('组合价：规格维度 2 级（颜色 + 尺码）', (p108.specs || []).length, 2);
eq('组合价：读到 4 个组合', p108.skuComboCount, 4);
eq('组合价：黄色【小花豹】取它两个组合里最低的价', p108.specs[0].values.find(v => v.name === '黄色【小花豹】').price, 18.41);
eq('组合价：咖啡【小熊-情侣款】= 11.35（折后价优先，不是 12.20）', p108.specs[0].values.find(v => v.name === '咖啡【小熊-情侣款】').price, 11.35);
check('组合价：同一颜色仅一个组合售罄时不算售罄（库存取最大）', (() => {
  const v = p108.specs[0].values.find(x => x.name === '咖啡【小熊-情侣款】');
  return !!v && v.stock === 3485;
})());
eq('组合价：按组合算的每行价（价格表本身）',
  p108.skuPrices[['黄色【小花豹】', '36-37【建议拍大一码】'].join(SEP)], 18.41);
check('组合价：没进组合表的值保持原样（不瞎填）',
  (p108.specs[0].values.find(v => v.name === '粉色【小猫咪】') || {}).price == null);
check('组合价：正文里那个 18.41 的尺码价被组合里的更低值修正（11.35）',
  (p108.specs[1].values.find(v => v.name === '36-37【建议拍大一码】') || {}).price === 11.35,
  JSON.stringify((p108.specs[1].values || []).map(v => [v.name, v.price])));

/* 规格写在属性表里的商品（颜色/尺码是一整行逗号值，尺码值还带全角括号）：
 * 用户报过「有BUG规格都抓不全」—— 整单退化成「单色兜底」。两条坑：带括号的值被当句子扔掉、
 * 正文弹层只列默认那几档（尺码只有 3 档，实际 5 档）。 */
const fx100 = fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-1002135913894.txt'), 'utf8');
const p100 = P.parse(fx100, { url: 'https://detail.1688.com/offer/1002135913894.html' });
eq('属性表商品：读到两个规格维度', (p100.specs || []).length, 2);
eq('属性表商品：颜色 9 个值', ((p100.specs || [])[0] || { values: [] }).values.length, 9);
eq('属性表商品：尺码 5 个值（正文弹层只有 3 档，表里有 5 档）', ((p100.specs || [])[1] || { values: [] }).values.length, 5);
check('属性表商品：带全角括号的尺码没被当句子扔掉（¥17 留住）',
  ((p100.specs || [])[1] || { values: [] }).values.some(v => v.name === '36/37（标准尺码）' && v.price === 17),
  JSON.stringify(((p100.specs || [])[1] || { values: [] }).values.map(v => [v.name, v.price])));
check('属性表商品：42/43、44/45 这两档补上了（只在件重尺表里出现）',
  ['42/43（标准尺码）', '44/45（标准尺码）'].every(n => ((p100.specs || [])[1] || { values: [] }).values.some(v => v.name === n)));
eq('属性表商品：单件重量用件重尺表最轻一档兜底', p100.weight_g, 365);
check('属性表商品：不再退化成「单色兜底」', (p100.colors || []).length === 9, String((p100.colors || []).length));

/* 页面写明的计价单位（「1双起批 / 库存879587双 / ≥1000双」）——变种名后缀要用它，不许写死「件」。
 * 用户报过：单位是双的商品，变种名却全显示成 6件装/12件装。 */
const fx725 = fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-725837664482.txt'), 'utf8');
const p725 = P.parse(fx725, { url: 'https://detail.1688.com/offer/725837664482.html' });
eq('足弓垫(725837664482)：单位识别为 双（1双起批 + 库存879587双 + 100-999双 + ≥1000双）', p725.unit, '双');
eq('没有单位证据 → 回落 件（不编造）', P.parse('某商品标题\n规格说明文字 2件以内 现在付款，预计明天达', { url: 'https://detail.1688.com/offer/1.html' }).unit, '件');
eq('件装商品：单位 件', P.parse('某商品标题\n1件起批\n库存500件\n100-999件', { url: 'https://detail.1688.com/offer/2.html' }).unit, '件');
eq('同一套代码按页面文字取不同单位：卷（1卷起批/库存900卷）', P.parse('胶带标题\n1卷起批\n库存900卷', { url: 'https://detail.1688.com/offer/4.html' }).unit, '卷');
eq('同一套代码按页面文字取不同单位：对（1对起批/库存500对）', P.parse('耳钉标题\n1对起批\n库存500对', { url: 'https://detail.1688.com/offer/5.html' }).unit, '对');
/* 用户报障：902902556556 交易单位是「卡」（1卡起批/已售800+卡/库存164071卡）但商家规格值写「6个/卡」——
 * 可数的单品单位 = 斜杠前的「个」。别再翻推荐区（那里有别的商品的「已售2万+瓶」）。 */
const fx902 = fs.readFileSync(path.join(__dirname, 'fixtures', 'offer-902902556556.txt'), 'utf8');
eq('除臭球(902902556556)：规格值「6个/卡」→ 单位取 个（不是 瓶/卡）', P.parse(fx902, { url: 'https://detail.1688.com/offer/902902556556.html' }).unit, '个');
eq('陷阱：主面板单位不认识（卡）、推荐区有别家单位 → 不许翻找，回落 件',
  P.parse('标题\n1卡起批\n已售800+卡\n库存500卡\n同款推荐\n已售2万+瓶\n已售17万+袋', { url: 'https://detail.1688.com/offer/3.html' }).unit, '件');

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
