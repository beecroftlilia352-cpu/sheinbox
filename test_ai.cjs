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
check('提示词带上 maxRows，且不再规定任何组合类别（kinds 白名单已删）',
  payload.rules.maxRows === 30 && payload.rules.kinds === undefined, JSON.stringify(payload.rules));
check('提示词明说 kind 由模型自己起短标签（引擎不规定类别）', /你自己给这一行起/.test(msgs[0].content));
check('提示词把「设计变种」写成核心职责（不是把规格抄一遍）',
  /核心产出是「变种设计」/.test(msgs[0].content) && /抄一遍等于没干活/.test(msgs[0].content));
check('提示词列出差异化的手段（多件装/混搭/大包装/套装）',
  /多件装/.test(msgs[0].content) && /混搭/.test(msgs[0].content) && /大包装/.test(msgs[0].content) && /套装\/配件/.test(msgs[0].content));
check('提示词要求覆盖 + 差异化两件事都做，并给出总量下限（6~maxRows）',
  /覆盖（底线）/.test(msgs[0].content) && /尽量排到 6~maxRows/.test(msgs[0].content));
check('提示词把「覆盖」定义成必须有它自己的一件装行（每个可见规格维度各取一个值）',
  /每个基础规格值都必须有它自己的一件装行/.test(msgs[0].content) && /只有这种行才算覆盖/.test(msgs[0].content));
check('提示词明令禁止拿覆盖行去凑多件装/混搭（否则整表没有一件装，用户看到的就是「件数翻倍」）',
  /绝不许把基础行改成多件装/.test(msgs[0].content) && /翻了倍/.test(msgs[0].content));
check('提示词要求名字里写的件数必须与 pcs 一致', /名字里写了几件，就必须跟 pcs 一致/.test(msgs[0].content));
check('提示词不再禁止模型写多件装/配件这类词（那是设计，不是模板）',
  !/绝对不要在名字里加数据里没有的单位或配件名/.test(msgs[0].content) && /件数写件数/.test(msgs[0].content));
check('提示词里没有密钥、也没有要求它算钱', !/apiKey|sk-/.test(msgs[1].content));
check('提示词要模型写中文变种名（nameCn）与英文名（nameEn）', /nameCn/.test(msgs[0].content) && /nameEn/.test(msgs[0].content));
check('提示词明确中文名不许带价格/成本', /不要价格\/成本/.test(msgs[0].content));
check('提示词的范本里不再出现我旧模板的词（双支装/混合装/收纳盒）',
  !/双支装|混合双支装|三支装|九支装|收纳盒/.test(msgs[0].content.replace(/不要自己造[^。]*。/, '')) ||
  /不要自己造/.test(msgs[0].content), '提示词还在教它写旧模板词');

/* 1b) 用户写的「补充条件」：作为参考条件进 payload（不是 system 提示词，模型改不了规矩） */
const withNote = A.buildMessages(prod, { maxRows: 30, note: '主推 2 件装；只上深色系' });
const notePayload = JSON.parse(withNote[1].content);
check('补充条件进了请求（extra_conditions）', notePayload.extra_conditions === '主推 2 件装；只上深色系',
  JSON.stringify(notePayload.extra_conditions));
check('没填补充条件 → 请求里就没有这个字段', !('extra_conditions' in JSON.parse(A.buildMessages(prod, { maxRows: 30 })[1].content)));
check('提示词里写明「必须把 extra_conditions 当参考条件」', /extra_conditions/.test(A.SYS) && /必须把它当作参考条件/.test(A.SYS));
check('提示词同时写明它压不翻铁律（值仍逐字来自数据、不许给价格、不许造单位）',
  /压不翻上面任何一条铁律/.test(A.SYS));
check('补充条件是参考条件，不是规矩 → 它进 payload，不进 system 提示词',
  !/主推 2 件装/.test(withNote[0].content), '补充条件漏进了 system');
const dirty = A.buildMessages(prod, { note: '<b>只上</b>\n\n   深色系' + '啊'.repeat(600) })[1].content;
const dirtyNote = JSON.parse(dirty).extra_conditions;
check('补充条件去标签、压空白、截到 500 字', !/[<>]/.test(dirtyNote) && dirtyNote.length <= 500,
  dirtyNote.length + ' 字：' + dirtyNote.slice(0, 30));

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

/* 4b) 补充条件不许被当借口绕过校验：用户说「加一个隐藏款」也不行（值只能是页面上的） */
const noteAbuse = A.normalize(prod, { plan: [{ kind: 'x', values: ['隐藏款'], pcs: 1, nameEn: 'Secret' }] },
  { note: '用户要求加一个隐藏款，别管数据里有没有' });
check('补充条件说要编造规格值 → 照样拒绝（参考条件不是免死金牌）',
  noteAbuse.ok === false && /数据里没有的规格值/.test(noteAbuse.error || ''), String(noteAbuse.error).slice(0, 80));
const noteEcho = A.normalize(prod, { plan: [
  { kind: 'x', values: ['灰色30cm*30cm'], pcs: 1, nameEn: 'Grey' },
  { kind: 'x', values: ['白色30cm*30cm'], pcs: 1, nameEn: 'White' },
  { kind: 'x', values: ['36-37适合35-36码'], pcs: 1, nameEn: 'Size' },
  { kind: 'x', values: ['【清仓随机款，尺码可指定】'], pcs: 1, nameEn: 'Random' }
] }, { note: '主推 2 件装' });
check('结果里带回这次用到的补充条件（前端要回显）', noteEcho.ok && noteEcho.note === '主推 2 件装', String(noteEcho.note));
check('说明里写一句「已把补充条件当参考条件」', noteEcho.ok && noteEcho.notes.some(x => /补充条件/.test(x)),
  (noteEcho.notes || []).join(' / '));

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
check('kind 随便起（引擎不再有类别白名单）→ 放行', A.normalize(prod, { plan: [
  { kind: '随便什么标签', values: ['灰色30cm*30cm'], pcs: 1, nameEn: 'Grey' },
  { kind: '另一个', values: ['白色30cm*30cm'], pcs: 1, nameEn: 'White' },
  { kind: '', values: ['36-37适合35-36码'], pcs: 1, nameEn: 'Size' },
  { kind: 'x', values: ['【清仓随机款，尺码可指定】'], pcs: 1, nameEn: 'Random' }
] }).ok === true);
check('kind 里塞价格/成本 → 拒绝', !A.normalize(prod, { plan: [
  { kind: '¥2.3 一支', values: ['灰色30cm*30cm'], pcs: 1, nameEn: 'Grey' }] }).ok);
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

  /* 11) 中文变种名：模型写就用模型的；带价格 / 编造单位配件词的丢掉那一栏（回落成值原文），并如实报数 */
  const withCn = { plan: [
    { kind: '单品', values: ['灰色30cm*30cm'], pcs: 1, nameCn: '灰色30cm*30cm 单片', nameEn: 'Grey 30cm*30cm' },
    { kind: '两组', values: ['灰色30cm*30cm', '白色30cm*30cm'], pcs: 2, nameCn: '灰色30cm*30cm + 白色30cm*30cm ×2', nameEn: 'Grey 30cm*30cm + White 30cm*30cm x2' },
    { kind: '主推', values: ['36-37适合35-36码'], pcs: 1, nameCn: '36-37适合35-36码 主推', nameEn: 'Size 36-37' },
    { kind: '单品', values: ['【清仓随机款，尺码可指定】'], pcs: 1, nameCn: '清仓随机款 只要 ¥2.3 一支', nameEn: 'Random' }
  ] };
  const cn = A.normalize(prod, withCn, { maxRows: 20 });
  check('中文名照搬模型写的', cn.ok && cn.rows[0].nameCn === '灰色30cm*30cm 单片', cn.rows && cn.rows[0].nameCn);
  check('多值行也照搬模型的中文名（不强行套引擎模板）', cn.ok && /×2/.test(cn.rows[1].nameCn), cn.rows && cn.rows[1].nameCn);
  check('带价格的中文名被丢掉 → 那一栏留空（回落成值原文）', cn.ok && cn.rows[3].nameCn === null, cn.rows && cn.rows[3].nameCn);
  check('如实报数：几行用了模型名、几行丢掉了', cn.ok && cn.nameCnUsed === 3 && cn.nameCnDropped === 1,
    JSON.stringify({ used: cn.nameCnUsed, dropped: cn.nameCnDropped }));
  check('说明里写清「有行中文名不合规」', cn.ok && (cn.notes || []).some(x => /中文名不合规/.test(x)), (cn.notes || []).join(' / '));

  /* 11b) 模型自己设计的变种名（多件装/混搭/套装/配件）必须原样放行 ——
   *      这些词是**它的设计**，不是我写死的模板。曾经的错误做法是拿一份词表把它们卡掉，
   *      结果 AI 档只能把页面规格抄一遍（用户当场指出：「你只是让deepseek给你重新排序？我需要的是变种规格」）。 */
  const designed = { plan: [
    { kind: '多件装', values: ['灰色30cm*30cm'], pcs: 5, nameCn: '灰色30cm*30cm 5件装', nameEn: 'Grey 30cm*30cm x5 Pack' },
    { kind: '混搭', values: ['灰色30cm*30cm', '白色30cm*30cm'], pcs: 2, nameCn: '灰色+白色 各1支 混搭双支装', nameEn: 'Grey + White 2-Piece Mix' },
    { kind: '套装', values: ['36-37适合35-36码'], pcs: 1, accessory: true, nameCn: '36-37适合35-36码 + 便携收纳盒', nameEn: 'Size 36-37 with Travel Case' },
    { kind: '单品', values: ['【清仓随机款，尺码可指定】'], pcs: 1, nameCn: '清仓随机款', nameEn: 'Random Clearance' }
  ] };
  const dz = A.normalize(prod, designed, {});
  check('模型设计的变种名（多件装/混搭/套装/配件词）全部原样通过',
    dz.ok && dz.rows[0].nameCn === '灰色30cm*30cm 5件装' && /混搭双支装/.test(dz.rows[1].nameCn) && /收纳盒/.test(dz.rows[2].nameCn),
    dz.ok ? JSON.stringify(dz.rows.map(r => r.nameCn)) : dz.error);
  check('设计出来的件数/配件标记原样保留（件数与成本口径靠它）',
    dz.ok && dz.rows[0].pcs === 5 && dz.rows[2].accessory === true,
    dz.ok ? JSON.stringify(dz.rows.map(r => [r.pcs, r.accessory])) : dz.error);
  const leakCase = A.normalize(prod, { plan: [
    { kind: 'x', values: ['灰色30cm*30cm'], pcs: 2, nameCn: '灰色30cm*30cm ×2', nameEn: 'Grey with Case' },
    { kind: 'x', values: ['白色30cm*30cm'], pcs: 1, nameCn: '白色30cm*30cm', nameEn: 'White' },
    { kind: 'x', values: ['36-37适合35-36码'], pcs: 1, nameCn: '36-37适合35-36码', nameEn: 'Size 36-37' },
    { kind: 'x', values: ['【清仓随机款，尺码可指定】'], pcs: 1, nameCn: '清仓随机款', nameEn: 'Random' }
  ] }, {});
  check('英文名硬说带配件但没标配件 → 那句被去掉',
    leakCase.ok && leakCase.rows[0].nameEn === 'Grey' && leakCase.rows[0].accessory === false,
    leakCase.ok ? leakCase.rows[0].nameEn : leakCase.error);

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
