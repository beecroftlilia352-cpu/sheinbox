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
const { packQtyOf, naturalPcsOf } = require('./app.js');   // 「5片装」→5 等口径与定价引擎共用，别各写一套

const MAX_ROWS = 36;
const MAX_PCS = 12;
const MAX_NOTE = 500;          // 用户在「补充条件」里最多能写多少字（够了，也免得把提示词撑爆）
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

/* 用户写的补充条件：去标签、压空白、截断。空/没写 → 空串（等于没有这条参考条件） */
function cleanNote(x) {
  return String(x == null ? '' : x).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
}

/* ---------- 提示词 ---------- */
const SYS = `你是跨境电商 SHEIN 欧洲站的变种规划师。只做一件事：根据给定的 1688 商品规格数据，排出一份「上架变种清单」。
铁律：
1) 规格值只能从给定数据里逐字复制，绝不新增、改写、翻译规格值本身（不要发明颜色/尺码/型号）。
2) 不要给任何价格、成本、利润数字——定价由系统另算。
3) **你的核心产出是「变种设计」，不是把页面规格抄一遍。** 抄一遍等于没干活。三件事都必须做到：
   a. 覆盖（底线）：**每个基础规格值都必须有它自己的一件装行** —— values 里「每个可见规格维度各取一个值」
      （也就是页面上那个 SKU 本身），pcs = 这一件：规格值名自带件数（如「5片装」）就写它自带的数，
      没有自带件数就是 1。**只有这种行才算覆盖了这个值。**
      · **绝不许把基础行改成多件装（pcs>1）或往一行里塞同一维度的两个值来充当覆盖** ——
        那样整张表里就没有一件装可上架了，卖家会以为件数被凭空翻了倍。
      · 确实不该上架的（如「清仓随机款」这类不确定款）才放进 skipped 并写原因。
   b. 差异化（这是重点，**必须做**）：在覆盖行**之外额外追加**真正不一样的卖法，让同一件货有几档。
      **至少要有 3~5 行是「设计出来的」**（多件装 / 混搭 / 大包装 / 套装），不管规格值多少 —— 一个商品只给
      「每个规格值一行」等于没设计。手段按商品自己判断（别生搬）：
      · 多件装：pcs 写 2 / 3 / 5 / 6 / 9 …（易耗品、低单价小件优先；单价高的别硬凑）
      · 混搭/组合：一行里选 2 个以上规格值（如 A 色 + B 色 各一件），values 写全它们
      · 大包装/囤货档：件数更多的那一档
      · 套装/配件：**只有这份商品确实带配件时**（标题或规格里提到收纳盒/赠品/套装等）才写 accessory=true
   c. 行数预算：**先排满覆盖行（一件装），再有空间才加设计款**；多件装/混搭是额外的行，不是覆盖的替代品。
      行数不够时宁可少加设计款，也不要动覆盖行。规格值多的商品，一件装行就是会占掉大部分行数，这是对的。
   d. 总量：尽量排到 6~maxRows 个变种；宁少勿乱、宁精勿堆。
4) 件数与组合完全由你判断（这正是叫你来思考的原因），但：
   - pcs = 这一行卖几件（1~12），要符合商品实际；
   - 规格值名里自带件数的（如「5片装」）→ pcs 就按它写（5），不要把整包当成 1 件；
   - kind = 你自己给这一行起一个 ≤8 字的短标签，说明这行是什么（单品 / 多件装 / 混搭 / 套装…随便你起）。不要写价格。
   - **名字里写了几件，就必须跟 pcs 一致**：pcs=3 就写「×3 / 3件装」，不要出现 pcs=10 而名字写「×20」这种对不上的情况。
   - **这一行天然几件，由你列了哪些值决定**：同一维度列了多个值，每个值各算一件，再与其它维度的值相乘。
     列 2 色 + 1 码 = 2 件；列 2 色 + 2 码 = 4 件；列 4 色 + 1 码 = 4 件。pcs **只能是这个数的整数倍**。
     常见错误：想做「2 件情侣装/两双装」却列了 4 个颜色 —— 那已经是 4 件了；要 2 件就只列 2 个值。
5) 行的顺序 = 上架顺序，最想主推的排前面；总行数不超过 maxRows。
6) 每个变种给两个名字，都要能看出这一行到底卖的是什么：
   nameEn = 英文名，必须纯英文（可含数字、x、-、+、尺寸与型号编码），用欧洲买家看得懂的说法，不要拼音、不要中文；
            件数与配件要写清（如「Grey 30cm*30cm x5 with Case」）；规格值里的型号/数字编码（如 3411、30cm*30cm）要保留。
   nameCn = 中文名（内部用、给运营看），≤40 字，带上本行用到的规格值原文；件数写件数（如「×5」「5件装」）、
            配件写配件（如「+收纳盒」）、混搭写清哪几款（值多时可写「N 款混搭」，N 用真实款数）。
            不要价格/成本/元/折扣数字，不要发明规格值，也不要同一件事说两遍。
7) 输入里如果带了 extra_conditions（用户自己写的补充要求）→ **必须把它当作参考条件一起考虑**：
   比如只上某几个规格值、主推几件装、某个值这单先不做、名字要简短等等。
   但它压不翻上面任何一条铁律：规格值仍只能逐字来自数据、不要给价格、不要自己造数据里没有的单位或配件名。
   做不到的要求就忽略，并在 notes 里写一句为什么。
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
  // 用户在界面上写的「补充条件」：是参考条件之一，但不能违反上面的铁律（值仍逐字来自数据、不许给价格、
  // 不许自己造单位/配件词）。所以它进的是 payload，而不是 system 提示词 —— 模型改不了规矩。
  const note = cleanNote(p.note);
  if (note) payload.extra_conditions = note;
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

/* 名字里自称的件数（「×3」「3件装」「x5 Pack」）。
 * ⚠ 千万别把尺寸/型号里的数字当件数：「30cm*30cm」「3411牛角」「C20侧标」都不是件数，
 *   所以只认「×/x + 数字」或「数字 + 件装/片装/双装/Pack」这两种明确写法。 */
const PCS_CLAIM_RE = /(?:×|✕|\bx)\s*(\d{1,2})(?![\d.])|(\d{1,2})\s*(?:件装|件套|双装|条装|片装|枚装|支装|套装|Pack)/i;
function claimedPcs(name) {
  const m = PCS_CLAIM_RE.exec(String(name == null ? '' : name));
  if (!m) return 0;
  const n = Number(m[1] || m[2]);
  return n >= 1 && n <= 99 ? n : 0;
}
function clampCountInName(name, cap) {
  return String(name).replace(PCS_CLAIM_RE, (whole, a, b) => (a ? whole.replace(a, String(cap)) : whole.replace(b, String(cap))));
}

/* ---------- 硬校验：AI 只许用页面上的值，钱不归它管 ---------- */
function validatePlan(product, plan) {
  const errs = [];
  const all = new Map();                       // 值名 → 值对象（允许重名不同编码：按名字比对即可）
  ((product && product.specs) || []).forEach(d => (d.values || []).forEach(v => all.set(String(v.name).trim(), v)));
  // 每个「可见规格维度」的值集合：用来判断一行是不是页面上的一个 SKU（每个维度各取一个值）
  const dimSets = ((product && product.specs) || [])
    .map(d => new Set((d.values || []).map(v => String(v.name).trim()))).filter(s => s.size);
  if (!dimSets.length && Array.isArray(product && product.colors)) {
    const cs = new Set(product.colors.map(c => String(c.name).trim()).filter(Boolean));
    if (cs.size) dimSets.push(cs);
  }
  const onePerDim = vals => dimSets.length ? (vals.length === dimSets.length && dimSets.every(s => vals.filter(v => s.has(v)).length === 1))
    : vals.length === 1;
  // 一行的「天然件数」：同一维度内相加、维度之间相乘（颜色 1 件 × 尺码 1 件 = 1 件，不是 2 件）
  const inherentPcs = vals => naturalPcsOf(dimSets.map(s => vals.filter(v => s.has(v))).filter(g => g.length));
  if (!all.size) errs.push('这个商品没有规格数据，AI 计划无从校验');
  if (!plan || !Array.isArray(plan.plan)) { errs.push('返回里没有 plan 数组'); return { errs, rows: [], used: new Set(), skipped: [], nameCnDropped: [] }; }

  const rows = [], used = new Set(), badValues = new Set(), nameCnDropped = [];
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
    // 只挡「不该模型碰的东西」：价格数字、超长、HTML。变种名怎么写（多件装/混搭/套装/配件）是模型的活，
    // 不再拿一份词表去卡它 —— 之前用词表卡掉「双支装/收纳盒」这类词，等于禁止它设计变种，AI 档就变成了抄写员。
    const cnBad = /[¥￥]|\d\s*元|价格|成本|利润|定价|进价|售价/i.test(nameCn);
    if (cnBad) { nameCn = ''; nameCnDropped.push(i + 1); }
    // 名字里写了几件就得跟 pcs 一致：写成「×20 件装」而 pcs=10，卖家看到的就是件数错乱
    let pcsFinal = Math.round(pcs);
    const claim = claimedPcs(nameCn || '') || claimedPcs(nameEn || '');
    if (claim && claim !== pcsFinal) {
      if (claim <= MAX_PCS) { pcsFinal = claim; pcsAligned++; }
      else {                                   // 名字吹到超过上限 → 件数夹到上限，并把名字里的数字同步改掉
        pcsFinal = MAX_PCS;
        if (nameCn) nameCn = clampCountInName(nameCn, MAX_PCS);
        nameEn = clampCountInName(nameEn, MAX_PCS);
        pcsClamped++;
      }
    }
    // 这一行「天然几件」由它列的值决定：同一维度列了多个值就各算一件，维度之间相乘。
    // 件数只能是它的整数倍 —— 否则就会出现「名字写 2 件装、值里却有 4 个颜色」这种自相矛盾的行
    // （用户报的「情侣混搭两双怎么算成 4 件」就是：4 色 × 1 码 = 4 件，模型却按 2 件命名）。
    const natural = inherentPcs(vals);
    if (natural > 0 && pcsFinal % natural !== 0) {
      errs.push(`第 ${i + 1} 行：你列的规格值本身就有 ${natural} 件（${vals.join('+')} 的组合数），` +
        `但件数写的是 ${pcsFinal} —— 件数必须是 ${natural} 的整数倍。` +
        `想要 ${pcsFinal} 件就减少值（例如只保留一个颜色/尺码），想要 ${natural} 件就把件数写成 ${natural}。`);
    }
    if (unknown.length || !vals.length) return;
    rows.push({
      kind, values: vals, pcs: pcsFinal, accessory,
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
  const note = cleanNote(o.note);
  if (note) notes.push(`已把你写的补充条件作为参考条件（${note.length} 字）`);
  return {
    ok: true,
    source: 'deepseek',
    note,                              // 这次生成用到的补充条件（前端原样回显，证明它真传进去了）
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
  const note = cleanNote(params && params.note);        // 用户写的补充条件（没有就是空串）
  const scoped = scope(product, params && params.maxDims);
  if (!scoped.specs.length) return { ok: false, error: '这个商品没有规格数据，AI 没有可排的东西' };
  const attempts = [];
  let hint = '';
  const MAX_TRIES = 3;      // 模型偶尔整份答歪（比如返回的不是 JSON）→ 多给一次机会，别两次就放弃
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const t0 = Date.now();
    let res;
    try { res = await ask(c, buildMessages(scoped, { maxRows, note }, hint)); }
    catch (e) { return { ok: false, error: '调用 DeepSeek 失败：' + (e.name === 'AbortError' ? '超时（90 秒）' : e.message) }; }
    if (res.http !== 200 || !res.content.trim()) {
      return { ok: false, error: `DeepSeek 返回异常（HTTP ${res.http}）${res.raw ? '：' + res.raw.slice(0, 160) : ''}` };
    }
    const parsed = parseJsonLoose(res.content);
    if (!parsed) {
      hint = '上一次返回的不是合法 JSON。只输出那个 JSON 对象本身，别加解释、别包代码块。';
      attempts.push({ attempt: attempt + 1, ms: Date.now() - t0, bad: '返回的不是合法 JSON（没解析出 plan）' });
      continue;
    }
    const norm = normalize(scoped, parsed, { maxRows, note });
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
  /* 失败原因必须说清楚：以前只取最后一条的 errs，而「返回不是 JSON」这类失败没有 errs
   * → 界面上只剩一个冒号（用户看到的「两次都没通过校验：」后面什么都没有，等于没说）。 */
  const last = attempts[attempts.length - 1] || {};
  const why = (last.errs && last.errs.length) ? last.errs.join('；') : (last.bad || '模型没有按要求的格式返回');
  const parts = [why];
  const firstBad = attempts.find(a => a.errs && a.errs.length);
  if (firstBad && firstBad !== last) {
    const o = firstBad.errs.join('；');
    if (o && o !== why) parts.push('另一次：' + o);
  }
  return { ok: false, error: `DeepSeek 的计划 ${attempts.length} 次都没通过：` + parts.join(' ／ '), attempts };
}

module.exports = { loadConfig, buildMessages, validatePlan, normalize, plan, parseJsonLoose, scope, MAX_ROWS, SYS, cleanNote };

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
