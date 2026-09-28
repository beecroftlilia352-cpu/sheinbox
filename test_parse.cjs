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

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
