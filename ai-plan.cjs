/* DeepSeek 变种规划器（定价台的「AI 思考」那一档）
 *
 * 分工（用户定的口径）：
 *   - DeepSeek 只负责「变种计划」这一层：选哪些规格组合上架、件数、配件、顺序、英文变种名、哪些值不上架（要给理由）。
 *   - 价格/成本/利润一律由 app.js 的引擎算，AI 给的任何数字都被丢掉（LLM 不碰钱）。
 *   - 规格值必须逐字来自抓取数据：出现数据里没有的值 → 整份计划作废（回落到引擎规则），
 *     漏了值又没写进 skipped → 带纠错提示重问一次，还漏就作废（不静默丢规格）。
 *
 * 用法：
 *   node ai-plan.cjs            ← stdin 收 {"product":…,"params":…}，stdout 回 {"ok":true,"rows":[…],"notes":[…]}
 *   node ai-plan.cjs --check    ← 自检（不联网）：跑内置样例的校验逻辑
 * 密钥：<项目>/.ai.json 或环境变量 AI_BASE_URL / AI_MODEL / DEEPSEEK_API_KEY（绝不回显、不写日志）
 */
const fs = require('fs');
const path = require('path');

const MAX_ROWS = 36;
const MAX_PCS = 12;
/* 「打包单位 / 配件」这类词：只有在这份商品的数据里本来就有，才允许出现在变种名里。
 * 以前这些是我写死在引擎里的模板词（双支装/九支装/便携收纳盒…）—— 现在一律当违规词：
 * 模型照着旧模板学舌、或者谁再往代码里塞模板，都会在校验里被挡掉。 */
const UNIT_RE = /(双支装|混合双支装|单支装|单支|三支装|六支装|九支装|混合装|款规格|多件折扣|囤货装|囤货|便携收纳盒|收纳盒|带配件|配件|[0-9一二三四五六七八九十两]+\s*[支片个条双枚件]\s*装|with\s+(?:travel\s+)?case|with\s+box)/gi;
const DEFAULT_MODEL = 'deepseek-flash';           // 快（实测 5s 左右）且在真实页面上给出的计划最完整
const TIMEOUT_MS = 90000;

function loadConfig(dir) {
  const env = (k) => (process.env[k] || '').trim();
  let file = {};
  try {
    const p = path.join(dir || __dirname, '.ai.json');
    if (fs.existsSync(p)) file = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { file = {}; }
  return {
    baseUrl: env('AI_BASE_URL') || file.baseUrl || 'https://api.deepseek.com',
    model: env('AI_MODEL') || file.model || DEFAULT_MODEL,
    apiKey: env('DEEPSEEK_API_KEY') || file.apiKey || '',
    hasKey: !!(env('DEEPSEEK_API_KEY') || file.apiKey)
  };
}

/* ---------- 提示词 ---------- */
const SYS = `你是跨境电商 SHEIN 欧洲站的变种规划师。只做一件事：根据给定的 1688 商品规格数据，排出一份「上架变种清单」。
铁律：
1) 规格值只能从给定数据里逐字复制，绝不新增、改写、翻译规格值本身（不要发明颜色/尺码/型号）。
2) 不要给任何价格、成本、利润数字——定价由系统另算。
3) 每个基础规格值都必须出现在计划里：要么有它自己的一行（pcs=1、accessory=false），要么放进 skipped 并写原因。
   确实不该上架的（如「清仓随机款」这类不确定款）才放 skipped。
4) 这一行卖几件、要不要多件/混搭、要不要带配件，由你按这份数据判断（这是你的活）：
   - pcs = 这一行卖几件（1~12）。要符合商品实际（易耗品可以多件，单价高的别硬凑）。
   - 规格值名里自带件数的（如「5片装」）→ pcs 就按它写（5），不要把整包当成 1 件。
   - 只有这份商品真的带配件时才写 accessory=true；不确定就别写。
   - kind = 你自己给这一行起一个 ≤8 字的短标签，说明这行是什么（单品 / 一组 / 带配件…随便你起）。不要写价格。
5) 行的顺序 = 上架顺序，最想主推的排前面；总行数不超过 maxRows。
6) 每个变种给两个名字：
   nameEn = 英文名，必须纯英文（可含数字、x、-、+、尺寸与型号编码），用欧洲买家看得懂的说法，不要拼音、不要中文；
            规格值里的型号/数字编码（如 3411、30cm*30cm）要保留。
   nameCn = 中文名（内部用、给运营看），≤40 字，必须带上本行真实规格值原文（值多时可以写「N 款 …」，N 用真实款数）。
            **绝对不要在名字里加数据里没有的单位或配件名**：不要自己造「双支装 / 混合双支装 / 九支装 / 便携收纳盒」
            这类词。要表示多件就写真实件数（如「×5」）；要表示包装就照抄值名里本来就有的写法（如「5片装」）。
            不要价格/成本/元/折扣数字，不要发明规格值。
只输出 JSON，不要解释文字、不要 markdown 代码块。格式：
{"plan":[{"kind":"你自己起的一行短标签","values":["规格值原文"],"pcs":1,"accessory":false,
          "nameCn":"中文变种名","nameEn":"English variant name"}],
 "skipped":[{"value":"规格值","reason":"原因"}],
 "specNameEn":{"规格值原文":"English"},
 "notes":["一句话说明你的排法理由"]}`;

function buildMessages(product, params, fixHint) {
  const p = params || {};
  const specs = ((product && product.specs) || []).map(d => ({
    label: d.label,
    values: (d.values || []).map(v => ({ name: v.name, code: v.code || null, price: v.price, stock: v.stock }))
  }));
  const payload = {
    product: {
      title: (product && product.title) || null,
      offerId: (product && product.source && product.source.offerId) || null,
      weight_g: (product && product.weight_g) || null,
      minQty: (product && product.minQty) || null,
      specs
    },
    rules: { maxRows: p.maxRows || MAX_ROWS, maxValuesPerMix: p.maxValuesPerMix || 12 },
    facts: '成本与定价由系统按每个规格自己的标价计算，你不需要关心价格'
  };
  const msgs = [
    { role: 'system', content: SYS },
    { role: 'user', content: JSON.stringify(payload) }
  ];
  if (fixHint) msgs.push({ role: 'user', content: `上一版计划不合格：${fixHint}。请只补上这些内容后重新输出完整 JSON（其余保持不变）。` });
  return msgs;
}

/* ---------- 调用 ---------- */
async function ask(cfg, messages, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || TIMEOUT_MS);
  try {
    const r = await fetch(String(cfg.baseUrl).replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      // thinking 必须显式关掉、max_tokens 要够大，否则这个接口会 HTTP 200 但 content 为空（踩过）
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: 4000, temperature: 0.2, thinking: { type: 'disabled' } }),
      signal: ac.signal
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_) { json = {}; }
    const content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
    return { http: r.status, content, usage: json.usage || null, raw: text.slice(0, 400) };
  } finally { clearTimeout(timer); }
}

function parseJsonLoose(txt) {
  const s = String(txt || '').replace(/^\s*```(?:json)?/gmi, '').replace(/```\s*$/gm, '').trim();
  try { return JSON.parse(s); } catch (_) { /* 继续 */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; } }
  return null;
}

/* ---------- 硬校验：AI 只许用页面上的值，钱不归它管 ---------- */
function validatePlan(product, plan) {
  const errs = [];
  const all = new Map();                       // 值名 → 值对象（允许重名不同编码：按名字比对即可）
  ((product && product.specs) || []).forEach(d => (d.values || []).forEach(v => all.set(String(v.name).trim(), v)));
  if (!all.size) errs.push('这个商品没有规格数据，AI 计划无从校验');
  if (!plan || !Array.isArray(plan.plan)) { errs.push('返回里没有 plan 数组'); return { errs, rows: [], used: new Set(), skipped: [], nameCnDropped: [] }; }

  const rows = [], used = new Set(), badValues = new Set(), nameCnDropped = [];
  // 这份商品里真实出现过的文字（所有规格值 + 标题）：名字里要用的词必须能在里面找到
  const dataText = [...all.keys(), String((product && product.title) || '')].join(' ');
  plan.plan.forEach((r, i) => {
    const kind = String((r && r.kind) || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8);
    if (/[¥￥]|\d\s*元|价格|成本|利润|定价/i.test(kind)) errs.push(`第 ${i + 1} 行的 kind 里带了价格/成本，这不该你写`);
    const vals = (r && Array.isArray(r.values) ? r.values : []).map(v => String(v).trim()).filter(Boolean);
    if (!vals.length) errs.push(`第 ${i + 1} 行没有规格值`);
    const unknown = vals.filter(v => !all.has(v));
    if (unknown.length) { unknown.forEach(v => badValues.add(v)); errs.push(`第 ${i + 1} 行出现数据里没有的规格值：${unknown.join('、')}`); }
    vals.filter(v => all.has(v)).forEach(v => used.add(v));
    const pcs = Number(r && r.pcs);
    if (!(pcs >= 1 && pcs <= MAX_PCS)) errs.push(`第 ${i + 1} 行件数不合法：${r && r.pcs}`);
    let nameEn = String((r && r.nameEn) || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!nameEn) errs.push(`第 ${i + 1} 行没有英文名`);
    const accessory = !!(r && r.accessory);
    // 英文名里说带了配件，但这一行并没标配件 → 那句话是模型硬凑的，去掉
    if (!accessory && /with\s+(?:a\s+)?(?:travel\s+)?(?:case|box|cover|pouch)\b/i.test(nameEn)) {
      nameEn = nameEn.replace(/\s*(?:,|with)\s*with\s+(?:a\s+)?(?:travel\s+)?(?:case|box|cover|pouch)\b/i, '')
        .replace(/\s+with\s+(?:a\s+)?(?:travel\s+)?(?:case|box|cover|pouch)\b/i, '').replace(/\s{2,}/g, ' ').trim();
    }
    // 中文名交给模型写。不合规的（带价格/超长/HTML/编造的单位与配件词）就丢掉这一栏，回落成值原文 —— 名字出错比名字平淡糟糕
    let nameCn = String((r && r.nameCn) || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (nameCn.length > 40) nameCn = nameCn.slice(0, 40).trim();
    let cnBad = /[¥￥]|\d\s*元|价格|成本|利润|定价|进价|售价/i.test(nameCn);
    const invented = (nameCn.match(UNIT_RE) || []).filter(w => !dataText.includes(w.trim()));
    if (invented.length) cnBad = true;
    if (cnBad) { nameCn = ''; nameCnDropped.push(i + 1); }
    if (unknown.length || !vals.length) return;
    rows.push({
      kind, values: vals, pcs: Math.round(pcs), accessory,
      nameCn: nameCn || null, nameEn
    });
  });

  const skipped = (Array.isArray(plan.skipped) ? plan.skipped : []).map(s => ({
    value: String((s && s.value) || '').trim(), reason: String((s && s.reason) || '').trim() || '未说明'
  })).filter(s => s.value);
  const skipSet = new Set(skipped.map(s => s.value));
  const missing = [...all.keys()].filter(v => !used.has(v) && !skipSet.has(v));
  if (missing.length) errs.push('这些规格值既没上架也没说明跳过：' + missing.join('、'));
  const bogusSkip = skipped.filter(s => !all.has(s.value)).map(s => s.value);
  if (bogusSkip.length) errs.push('skipped 里出现数据里没有的规格值：' + bogusSkip.join('、'));

  return { errs, rows, used, skipped, nameCnDropped };
}

/* 把 AI 的计划翻译成引擎能直接用的行（价格/成本/利润仍由 app.js 算） */
function normalize(product, plan, opts) {
  const o = opts || {};
  const v = validatePlan(product, plan);
  const maxRows = o.maxRows || MAX_ROWS;
  if (v.errs.length) return { ok: false, error: v.errs.join('；'), errs: v.errs, fixHint: v.errs.join('；') };
  if (!v.rows.length) return { ok: false, error: 'AI 没排出任何变种行', errs: ['空计划'], fixHint: '没有排出任何行' };
  const rows = v.rows.slice(0, maxRows);
  const truncated = v.rows.length > maxRows ? { total: v.rows.length, kept: maxRows } : null;
  const en = {};
  const specNameEn = plan.specNameEn && typeof plan.specNameEn === 'object' ? plan.specNameEn : {};
  Object.keys(specNameEn).forEach(k => {
    const kk = String(k).trim();
    const vv = String(specNameEn[k] || '').trim().slice(0, 80);
    if (kk && vv) en[kk] = vv;
  });
  const notes = (Array.isArray(plan.notes) ? plan.notes : []).map(x => String(x).slice(0, 300)).slice(0, 6);
  const rowsNoCn = (v.nameCnDropped || []).length;
  const rowsWithCn = rows.filter(r => r.nameCn).length;
  if (rowsNoCn) notes.push(`有 ${rowsNoCn} 行的中文名不合规（带价格或太长），这 ${rowsNoCn} 行的中文名改用引擎模板`);
  return {
    ok: true,
    source: 'deepseek',
    rows,
    skipped: v.skipped,
    notes,
    specNameEn: en,
    truncated,
    nameCnUsed: rowsWithCn,           // 中文名里有多少行是模型自己写的（其余走引擎模板）
    nameCnDropped: rowsNoCn
  };
}

/* 只把「表格里显示的那几级规格」交给 AI：藏起来的维度不能出现在计划里（否则行会撞车） */
function scope(product, maxDims) {
  const lim = Math.max(1, Math.min(3, Number(maxDims) || 3));
  const all = (product && product.specs) || [];
  return Object.assign({}, product, { specs: all.slice(0, lim), hiddenDims: Math.max(0, all.length - lim) });
}

/* ---------- 主流程：问 → 校验 → 不合格带纠错重问一次 → 再不合格就作废 ---------- */
async function plan(product, params, cfg) {
  const c = cfg || loadConfig();
  if (!c.hasKey) return { ok: false, error: '没配 DeepSeek 密钥（缺 .ai.json 或 DEEPSEEK_API_KEY）—— 已按引擎规则生成', noKey: true };
  const maxRows = (params && params.maxRows) || MAX_ROWS;
  const scoped = scope(product, params && params.maxDims);
  if (!scoped.specs.length) return { ok: false, error: '这个商品没有规格数据，AI 没有可排的东西' };
  const attempts = [];
  let hint = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    let res;
    try { res = await ask(c, buildMessages(scoped, { maxRows }, hint)); }
    catch (e) { return { ok: false, error: '调用 DeepSeek 失败：' + (e.name === 'AbortError' ? '超时（90 秒）' : e.message) }; }
    if (res.http !== 200 || !res.content.trim()) {
      return { ok: false, error: `DeepSeek 返回异常（HTTP ${res.http}）${res.raw ? '：' + res.raw.slice(0, 160) : ''}` };
    }
    const parsed = parseJsonLoose(res.content);
    if (!parsed) { hint = '返回的不是合法 JSON'; attempts.push({ attempt: attempt + 1, ms: Date.now() - t0, bad: 'JSON 解析失败' }); continue; }
    const norm = normalize(scoped, parsed, { maxRows });
    attempts.push({ attempt: attempt + 1, ms: Date.now() - t0, rows: (norm.rows || []).length, errs: norm.errs || [] });
    if (norm.ok) {
      norm.model = c.model;
      norm.ms = Date.now() - t0;
      norm.attempts = attempts;
      if (scoped.hiddenDims) norm.notes = (norm.notes || []).concat([`页面上还有 ${scoped.hiddenDims} 级规格没交给 AI（表格只显示前 ${scoped.specs.length} 级）`]);
      return norm;
    }
    hint = norm.error;
  }
  return { ok: false, error: 'DeepSeek 的计划两次都没通过校验：' + (attempts[attempts.length - 1].errs || []).join('；'), attempts };
}

module.exports = { loadConfig, buildMessages, validatePlan, normalize, plan, parseJsonLoose, scope, MAX_ROWS, SYS, UNIT_RE };

/* ---------- CLI ---------- */
if (require.main === module) {
  const readStdin = () => new Promise(res => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { s += d; });
    process.stdin.on('end', () => res(s));
  });
  (async () => {
    if (process.argv.includes('--check')) {
      const prod = { specs: [{ label: '颜色', values: [{ name: '红色', price: 1.5 }, { name: '蓝色', price: 1.6 }] }] };
      const good = { plan: [{ kind: '单品', values: ['红色'], pcs: 1, nameEn: 'Red' }, { kind: '单品', values: ['蓝色'], pcs: 1, nameEn: 'Blue' }] };
      const bad = { plan: [{ kind: '单品', values: ['绿色'], pcs: 1, nameEn: 'Green' }] };
      console.log(JSON.stringify({ good: normalize(prod, good).ok, bad: normalize(prod, bad).ok, cfgHasKey: loadConfig().hasKey }, null, 2));
      return;
    }
    let input = {};
    try { input = JSON.parse(await readStdin() || '{}'); } catch (_) { input = {}; }
    const out = await plan(input.product, input.params || {});
    process.stdout.write(JSON.stringify(out));
  })().catch(e => { process.stdout.write(JSON.stringify({ ok: false, error: 'ai-plan 内部错误：' + e.message })); });
}
