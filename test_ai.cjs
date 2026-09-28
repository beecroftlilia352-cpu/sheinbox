/* DeepSeek 变种规划器回归：只测「它不许越界」的部分（硬校验 / 回落 / 不碰钱）
 * 全部离线跑（不联网、不用真 key）：网络那一步靠 CLI 手测。
 * 运行：node test_ai.cjs
 */
const A = require('./ai-plan.cjs');

let bad = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  → ' + extra : ''}`); if (!cond) bad++; };

const prod = {
  title: '防水防潮拼接地板',
  source: { offerId: '922794624735' },
  specs: [
    { label: '颜色', values: [
      { name: '灰色30cm*30cm', code: 'C1', price: 2.12, stock: 100 },
      { name: '白色30cm*30cm', code: 'C2', price: 2.21, stock: 90 },
      { name: '【清仓随机款，尺码可指定】', code: null, price: 2.3, stock: 5 }
    ] },
    { label: '尺码', values: [{ name: '36-37适合35-36码', code: null, price: 11.5, stock: 3 }] }
  ]
};

/* 1) 提示词：规格值一个不少、带上规则、不带价格指令 */
const msgs = A.buildMessages(prod, { maxRows: 30 }, '');
check('提示词带 system + user 两条', msgs.length === 2 && msgs[0].role === 'system');
const payload = JSON.parse(msgs[1].content);
const sentValues = payload.product.specs.flatMap(d => d.values.map(v => v.name));
check('提示词里 4 个规格值全都在', sentValues.length === 4, sentValues.join(' / '));
check('提示词明确「不要给价格/成本数字」', /不要给任何价格/.test(msgs[0].content));
check('提示词要求逐字复制规格值', /逐字复制/.test(msgs[0].content));
check('提示词带上 kinds / maxRows', payload.rules.kinds.length === 4 && payload.rules.maxRows === 30);
check('提示词里没有密钥、也没有要求它算钱', !/apiKey|sk-/.test(msgs[1].content));
check('提示词要模型写中文变种名（nameCn）与英文名（nameEn）', /nameCn/.test(msgs[0].content) && /nameEn/.test(msgs[0].content));
check('提示词明确中文名不许带价格/成本', /不要价格\/成本/.test(msgs[0].content));

/* 2) 只把「表格显示的那几级」给它：藏起来的维度不进计划（否则行会撞车） */
const scoped = A.scope(prod, 1);
check('规格列上限=1 → 只给第一级，并记下藏了几级', scoped.specs.length === 1 && scoped.hiddenDims === 1,
  scoped.specs.length + ' 级 / 藏 ' + scoped.hiddenDims + ' 级');

/* 3) 硬校验：编造规格值 → 整份计划作废 */
const invented = { plan: [{ kind: '原规格', values: ['紫色'], pcs: 1, nameEn: 'Purple' }] };
const iv = A.validatePlan(prod, invented);
check('编造页面上没有的规格值 → 拒绝', iv.errs.some(e => /数据里没有的规格值：紫色/.test(e)), iv.errs.join('；'));
check('编造值 → normalize 也不放行', A.normalize(prod, invented).ok === false);

/* 4) 漏掉规格值又没说跳过 → 拒绝（绝不静默丢规格） */
const missing = { plan: [{ kind: '原规格', values: ['灰色30cm*30cm'], pcs: 1, nameEn: 'Grey' }] };
const mv = A.validatePlan(prod, missing);
check('漏了规格值且没写 skipped → 拒绝', mv.errs.some(e => /既没上架也没说明跳过/.test(e)), mv.errs.join('；'));

/* 5) 说清楚跳过 → 放行，并且跳过理由要带出来 */
const withSkip = { plan: [
  { kind: '原规格', values: ['灰色30cm*30cm'], pcs: 1, nameEn: 'Grey 30x30cm' },
  { kind: '原规格', values: ['白色30cm*30cm'], pcs: 1, nameEn: 'White 30x30cm' },
  { kind: '原规格', values: ['36-37适合35-36码'], pcs: 1, nameEn: 'Size 36-37' },
  { kind: '组合装', values: ['灰色30cm*30cm', '白色30cm*30cm'], pcs: 2, nameEn: 'Grey + White - 2 Pack' }
], skipped: [{ value: '【清仓随机款，尺码可指定】', reason: '随机款颜色不确定' }], notes: ['先原规格再组合'] };
const ws = A.normalize(prod, withSkip);
check('每个值都覆盖 / 有跳过理由 → 通过', ws.ok === true, ws.ok ? '' : ws.error);
check('跳过的值与理由带出来', ws.ok && ws.skipped.length === 1 && /不确定/.test(ws.skipped[0].reason));
check('AI 排的件数原样保留（2 件装那行）', ws.ok && !!ws.rows.find(r => r.pcs === 2),
  ws.ok ? ws.rows.map(r => r.pcs).join(',') : '');

/* 6) LLM 不碰钱：它就算硬塞价格/成本字段，也不许进到行里 */
const moneyTrap = { plan: [
  { kind: '原规格', values: ['灰色30cm*30cm'], pcs: 1, nameEn: 'Grey', price: 99, cost: 0.01, unitCost: 0.02 },
  { kind: '原规格', values: ['白色30cm*30cm'], pcs: 1, nameEn: 'White', profit: 50 },
  { kind: '原规格', values: ['36-37适合35-36码'], pcs: 1, nameEn: 'Size 36-37' }
], skipped: [{ value: '【清仓随机款，尺码可指定】', reason: '随机款' }] };
const mt = A.normalize(prod, moneyTrap);
check('塞进来的价格/成本字段被剥掉（钱只由引擎算）',
  mt.ok && mt.rows.every(r => ['price', 'cost', 'unitCost', 'profit', 'net'].every(k => !(k in r))),
  mt.ok ? JSON.stringify(Object.keys(mt.rows[0])) : mt.error);

/* 7) 件数越界 / kind 不认 / 空计划 → 拒绝 */
check('件数 13 → 拒绝', !A.normalize(prod, { plan: [{ kind: '原规格', values: ['灰色30cm*30cm'], pcs: 13, nameEn: 'X' }] }).ok);
check('件数 0 → 拒绝', !A.normalize(prod, { plan: [{ kind: '原规格', values: ['灰色30cm*30cm'], pcs: 0, nameEn: 'X' }] }).ok);
check('kind 不认识 → 拒绝', !A.normalize(prod, { plan: [{ kind: '随便装', values: ['灰色30cm*30cm'], pcs: 1, nameEn: 'X' }] }).ok);
check('没有英文名 → 拒绝', !A.normalize(prod, { plan: [{ kind: '原规格', values: ['灰色30cm*30cm'], pcs: 1, nameEn: '' }] }).ok);
check('不是 JSON 对象 → 拒绝', !A.normalize(prod, null).ok);

/* 8) 行数封顶：AI 排再多也只能给到 maxRows，并说明砍了多少 */
const many = { plan: Array.from({ length: 8 }, () => ({ kind: '原规格', values: ['灰色30cm*30cm'], pcs: 1, nameEn: 'Grey' }))
  .concat([{ kind: '原规格', values: ['白色30cm*30cm'], pcs: 1, nameEn: 'White' },
           { kind: '原规格', values: ['36-37适合35-36码'], pcs: 1, nameEn: 'Size 36-37' },
           { kind: '原规格', values: ['【清仓随机款，尺码可指定】'], pcs: 1, nameEn: 'Random' }]) };
const mr = A.normalize(prod, many, { maxRows: 5 });
check('行数封顶到 5 行', mr.ok && mr.rows.length === 5, mr.ok ? mr.rows.length + ' 行' : mr.error);
check('说明本来有多少行', mr.ok && mr.truncated && mr.truncated.total === 11, JSON.stringify(mr.truncated));

/* 9) 没配 key → 不联网、直接回落（noKey 标记让前端显示「已按引擎规则排」） */
(async () => {
  const res = await A.plan(prod, {}, { baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: '', hasKey: false });
  check('没配 key → ok=false 且标记 noKey（不联网）', res.ok === false && res.noKey === true, JSON.stringify(res));
  check('没有规格数据 → 明确说明，不去联网', (await A.plan({ specs: [] }, {}, { apiKey: 'x', hasKey: true })).ok === false);

  /* 10) 容错解析：模型爱套 ```json 代码块 */
  check('能从 ```json 代码块里抠出 JSON', !!A.parseJsonLoose('```json\n{"plan":[]}\n```'));
  check('能从一段解释文字里抠出 JSON', !!A.parseJsonLoose('好的，这是计划：{"plan":[]} 以上。'));
  check('不是 JSON 就返回 null', A.parseJsonLoose('我不知道') === null);

  /* 11) 中文变种名：模型写就用模型的；带价格/超长的丢掉那一栏（回落引擎模板），并如实报数 */
  const withCn = { plan: [
    { kind: '原规格', values: ['灰色30cm*30cm'], pcs: 1, nameCn: '灰色30cm*30cm 单支装', nameEn: 'Grey 30cm*30cm - 1 Pack' },
    { kind: '组合装', values: ['灰色30cm*30cm', '白色30cm*30cm'], pcs: 2, nameCn: '灰白两色各一支 双片装', nameEn: 'Grey + White - 2 Pack' },
    { kind: '带配件', values: ['36-37适合35-36码'], pcs: 1, nameCn: '尺码 36-37 单支 + 便携收纳盒', nameEn: 'Size 36-37 with Case' },
    { kind: '原规格', values: ['【清仓随机款，尺码可指定】'], pcs: 1, nameCn: '清仓随机款 只要 ¥2.3 一支', nameEn: 'Random Clearance - 1 Pack' }
  ] };
  const cn = A.normalize(prod, withCn, { maxRows: 20 });
  check('中文名照搬模型写的', cn.ok && cn.rows[0].nameCn === '灰色30cm*30cm 单支装', cn.rows && cn.rows[0].nameCn);
  check('混装行也照搬模型的中文名（不强行套模板）', cn.ok && /两色各一支/.test(cn.rows[1].nameCn), cn.rows && cn.rows[1].nameCn);
  check('带价格的中文名被丢掉 → 那一栏留空，回落引擎模板', cn.ok && cn.rows[3].nameCn === null, cn.rows && cn.rows[3].nameCn);
  check('如实报数：几行用了模型名、几行丢掉了', cn.ok && cn.nameCnUsed === 3 && cn.nameCnDropped === 1,
    JSON.stringify({ used: cn.nameCnUsed, dropped: cn.nameCnDropped }));
  check('说明里写清「有行回落引擎模板」', cn.ok && (cn.notes || []).some(x => /中文名不合规/.test(x)), (cn.notes || []).join(' / '));

  const longCn = { plan: [
    { kind: '原规格', values: ['灰色30cm*30cm'], pcs: 1, nameCn: '灰'.repeat(60), nameEn: 'Grey' },
    { kind: '原规格', values: ['白色30cm*30cm'], pcs: 1, nameEn: 'White' },
    { kind: '原规格', values: ['36-37适合35-36码'], pcs: 1, nameEn: 'Size 36-37' },
    { kind: '原规格', values: ['【清仓随机款，尺码可指定】'], pcs: 1, nameEn: 'Random' }
  ] };
  const lc = A.normalize(prod, longCn, {});
  check('超长中文名截到 40 字', lc.ok && lc.rows[0].nameCn.length === 40, lc.rows && lc.rows[0].nameCn.length);

  const noCn = { plan: [
    { kind: '原规格', values: ['灰色30cm*30cm'], pcs: 1, nameEn: 'Grey' },
    { kind: '原规格', values: ['白色30cm*30cm'], pcs: 1, nameEn: 'White' },
    { kind: '原规格', values: ['36-37适合35-36码'], pcs: 1, nameEn: 'Size 36-37' },
    { kind: '原规格', values: ['【清仓随机款，尺码可指定】'], pcs: 1, nameEn: 'Random' }
  ] };
  const nc = A.normalize(prod, noCn, {});
  check('模型没给中文名 → 那一栏留空（由前端回落引擎模板）',
    nc.ok && nc.rows[0].nameCn === null && nc.nameCnUsed === 0, JSON.stringify({ cn: nc.ok && nc.rows[0].nameCn, used: nc.nameCnUsed }));

  console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
  process.exit(bad ? 1 : 0);
})();
