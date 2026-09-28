/* 规格生成 + 定价引擎：把 1688 商品数据变成可上架的变种清单和定价
 * 口径与「跨境定价计算器」完全一致：运费 = 成本的固定百分比（换算成固定金额），
 * 毛利率默认 = 利润 ÷ 实际到手价，K = (1−还价%)×(1−折扣%)。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VariantEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULTS = {
    unitCost: 10,        // 拿货价（元/件）
    freightRate: 10,     // 运费 = 成本的 10%（固定值）
    accessoryCost: 1.5,  // 收纳盒/配件成本（元/单，只对含配件变种生效）
    bargain: 20,         // 前端还价 %
    discount: 15,        // 活动折扣 %
    stackMode: 'mul',    // mul 乘性 / add 相加
    margin: 33,          // 目标毛利率 %
    marginBase: 'net',   // net 利润÷到手价 / list 利润÷标价 / cost 利润=成本×倍数
    costMode: 'spec',    // spec 各规格自己的标价 / param 统一用 unitCost
    fxRate: 7.8,         // 人民币 → 欧元（自行按当天汇率改）
    lowPriceThreshold: 3,// 低价兜底阈值（元）：只要有规格定价低于它
    lowPriceAdd: 3,      // 就给「所有」规格统一加这么多
    maxColors: 12,
    maxDims: 3,          // 表格里最多显示几级规格（父/子/孙），避免列太多挤不下——可手工调大
    maxVariants: 36     // 变种总数封顶（多级规格组合会变多，页面上会说明被截断）
  };

  const COLOR_EN = {
    '粉色': 'Pink', '绿色': 'Green', '紫色': 'Purple', '蓝色': 'Blue', '黑色': 'Black',
    '白色': 'White', '红色': 'Red', '黄色': 'Yellow', '橙色': 'Orange', '灰色': 'Grey',
    '玫红': 'Rose Red', '酒红': 'Wine Red', '天蓝': 'Sky Blue', '藏青': 'Navy',
    '米色': 'Beige', '米白': 'Off-White', '透明': 'Clear', '银色': 'Silver', '金色': 'Gold',
    '棕色': 'Brown', '咖啡色': 'Coffee', '卡其': 'Khaki', '墨绿': 'Dark Green', '浅蓝': 'Light Blue'
  };
  const cn = (s) => (typeof enOf === 'function' ? enOf(s) : (COLOR_EN[s] || s));   // 未知词保留中文，避免编造

  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };

  function discountFactor(p) {
    const b = n(p.bargain) / 100, d = n(p.discount) / 100;
    return p.stackMode === 'add' ? Math.max(0, 1 - b - d) : Math.max(0, (1 - b) * (1 - d));
  }

  /* 单个变种定价：成本 = 拿货价×件数 + 配件；运费 = 成本 × 运费率
   * boost = 低价兜底加价（整单统一，见 floorDetail） */
  function priceVariant(v, params, boost) {
    const p = Object.assign({}, DEFAULTS, params || {});
    // 行自带拿货价时用它（= 这个规格自己的标价）；否则用参数里的拿货价
    const unit = (v.unitCost != null && Number.isFinite(Number(v.unitCost))) ? Number(v.unitCost) : n(p.unitCost);
    const goods = unit * n(v.pcs);
    const accessory = v.accessory ? n(p.accessoryCost) : 0;
    const baseCost = goods + accessory;
    const freight = baseCost * n(p.freightRate) / 100;
    const totalCost = baseCost + freight;
    const K = discountFactor(p), m = n(p.margin) / 100;
    let price;
    if (p.marginBase === 'list') price = totalCost / (K - m);
    else if (p.marginBase === 'cost') price = totalCost * (1 + m) / K;
    else price = totalCost / (K * (1 - m));
    const ok = K > 0 && Number.isFinite(price) && price > 0 && (p.marginBase !== 'list' || K - m > 0);
    const priceSolved = ok ? price : NaN;                   // 公式解出来的原定价
    const priceBoost = ok && n(boost) > 0 ? n(boost) : 0;   // 低价兜底：整单统一加价
    if (ok) price += priceBoost;
    const net = K * price;
    const profit = net - totalCost;
    const raw = price / n(p.fxRate);
    return {
      ok, reason: ok ? '' : (K <= 0 ? '折扣吃光了售价' : '当前折扣下无解'),
      goods, accessory, baseCost, freight, totalCost, factor: K, priceSolved, priceBoost, price, net, profit,
      marginOnNet: net > 0 ? profit / net : 0,
      marginOnList: price > 0 ? profit / price : 0,
      unitProfit: n(v.pcs) > 0 ? profit / n(v.pcs) : 0,
      priceEur: ok ? Math.round(raw * 100) / 100 : NaN,
      priceEur99: ok ? (Math.ceil(raw) - 0.01) : NaN
    };
  }

  /* 常见规格词的英文。表里没有的词**原样保留**并在页面上标「英文名待补」——不瞎翻译。
   * 要改词就改这一张表（或点页面 ② 里生成的英文名直接改）。 */
  const EN_WORDS = {
    粉色: 'Pink', 粉红: 'Pink', 紫色: 'Purple', 黑色: 'Black', 白色: 'White', 红色: 'Red', 蓝色: 'Blue',
    绿色: 'Green', 黄色: 'Yellow', 橙色: 'Orange', 灰色: 'Grey', 棕色: 'Brown', 肤色: 'Nude', 米色: 'Beige',
    银色: 'Silver', 金色: 'Gold', 透明: 'Clear', 混色: 'Mixed', 单色: 'Single',
    英文版: 'English Ver.', 中文版: 'Chinese Ver.', 英文: 'English', 中文: 'Chinese',
    欧规: 'EU', 美规: 'US', 英规: 'UK', 日规: 'JP', 国标: 'CN Std', 澳规: 'AU', 韩规: 'KR',
    全自动: 'Automatic', 半自动: 'Semi-Auto', 手持: 'Handheld', 便携: 'Portable', 负离子: 'Negative Ion',
    卷发棒: 'Curling Iron', 卷发器: 'Curler', 直发器: 'Hair Straightener', 不伤发: 'Damage-Free',
    收纳盒: 'Travel Case', 大波: 'Big Wave', 小波: 'Small Wave', 深波: 'Deep Wave', 常波: 'Regular Wave',
    牛角: 'Horn', 侧标: 'Side Tag', 清仓: 'Clearance', 随机款: 'Random', 随机: 'Random', 可指定: 'Selectable',
    适合: 'Fits', 尺码: 'Size', 码: 'Size', 拖鞋: 'Slippers', 棉拖鞋: 'Cotton Slippers', 加绒: 'Fleece', 保暖: 'Warm',
    居家: 'Home', 厚底: 'Thick Sole', 情侣: 'Couple', 室内: 'Indoor', 秋冬: 'Autumn Winter'
  };
  function enOf(s) {
    let out = String(s == null ? '' : s)
      .replace(/[【】]/g, ' ').replace(/[·.]/g, '. ').replace(/[／/]/g, ' / ').replace(/[，、]/g, ', ');
    Object.keys(EN_WORDS).sort((a, b) => b.length - a.length)
      .forEach(k => { out = out.split(k).join(EN_WORDS[k] + ' '); });
    // 中文词夹在数字/字母旁边会被粘成 "3411Horn"、"35-36Size" —— 补空格
    out = out.replace(/([0-9a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])([0-9])/g, '$1 $2');
    return out.replace(/(\.\s*){2,}/g, '. ').replace(/\s*\.\s*/g, '. ').replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
  }
  const hasCJK = s => /[\u4e00-\u9fa5]/.test(String(s == null ? '' : s));

  /* 规格维度：可能是多级（父规格 + 子规格），标签来自页面（颜色/尺码/型号/功率…），不写死 */
  function specDims(product) {
    const fromSpecs = ((product && product.specs) || []).filter(d => d && d.values && d.values.length);
    if (fromSpecs.length) return fromSpecs;
    if (product && product.colors && product.colors.length) return [{ label: '规格', values: product.colors }];
    return [{ label: '规格', values: [{ name: '单色', code: 'NA' }] }];
  }

  /* 一行变种的规格格子：整维是组合值（【父】子）就出「父规格/子规格」两列，否则一维一列 */
  const CELL_MAX = 64;
  function specOfValues(vals, dims, combo) {
    const o = {};
    const primary = dims[0];
    // 一格塞太多值会把表撑爆：超过 3 个就写「前 2 个 等 N 款」
    const join = list => (list.length > 3 ? list.slice(0, 2).join('/') + ` 等${list.length}款` : list.join('/'));
    if (primary && primary.partLabels) {
      primary.partLabels.forEach((lab, pi) => {
        const t = join(vals.map(v => (v && v.parts && v.parts[pi]) || '').filter(Boolean));
        o[lab] = t.length > CELL_MAX ? t.slice(0, CELL_MAX - 1) + '…' : t;
      });
    } else if (primary) {
      const t = join(vals.map(v => (v ? v.name : '')).filter(Boolean));
      o[primary.label] = t.length > CELL_MAX ? t.slice(0, CELL_MAX - 1) + '…' : t;
    }
    (combo || []).forEach(x => { o[x.dim.label] = x.value.name; });
    return o;
  }

  /* 这一行的拿货价：优先用「这个规格自己的标价」。
   * 1688 一维多值时常写成打包阶梯（单片 2.12 / 5片装 11.5 / 10片装 23），
   * 用一个平均价/众数糊到所有行上就是错的 —— 所以：
   *   行里各值同一个价 → 就是它（再由件数乘上去）
   *   行里是「各值各一支」的不同价（混合装）→ 取均价，乘件数后正好等于各值价相加
   *   价不一样又说不清件数（六支装/九支装）→ 用参数里的拿货价（不瞎算）
   */
  function rowUnitCost(vals, pcs, fallback) {
    const fb = (fallback != null && Number.isFinite(Number(fallback))) ? Number(fallback) : null;
    const ps = (vals || []).map(v => (v && v.price != null && Number.isFinite(Number(v.price)) ? Number(v.price) : null));
    if (!ps.length || ps.some(x => x === null)) return fb;                 // 有值没标价 → 参数里的拿货价
    const uniq = Array.from(new Set(ps));
    if (uniq.length === 1) return uniq[0];                                 // 同一个价 → 用它
    if (ps.length === n(pcs)) return ps.reduce((a, b) => a + b, 0) / ps.length;  // 各一支 → 均价 × 件数 = 各值相加
    return fb;
  }

  /* 按商品规格排变种：父规格走原来的业务计划，子规格逐组合展开；每种组合都是一组确定的规格值 */
  function buildVariants(product, params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    const allDims = specDims(product);
    const maxDims = Math.max(1, Math.min(3, n(p.maxDims) || 3));   // 默认 3 级，多了表格挤不下
    const dims = allDims.slice(0, maxDims);
    const primary = dims[0];
    const colorsAll = primary.values;                          // 真实规格行用**全部**值（上架要覆盖每个规格）
    const colors = colorsAll.slice(0, p.maxColors);            // 上限只约束「混合装/囤货装」这类包装行，避免行数爆掉
    const tag = (product && product.source && product.source.offerId) ? String(product.source.offerId).slice(-4) : '0000';

    // 子规格的笛卡尔组合（每个组合 = 一组具体规格值）；没有子规格时就是一个空组合
    const combos = dims.slice(1).reduce((acc, d, di) => acc.flatMap(a =>
      d.values.map((v, vi) => a.concat([{ dim: d, value: v, code: v.code || `V${di + 1}${vi + 1}` }]))
    ), [[]]).slice(0, 6);
    // SKU 的规格段：优先用页面自带的编码；页面没给就按页面顺序编 S1..Sn（不写死「颜色」）
    const pcode = (c, i) => c.code || 'S' + (i + 1);
    const skuOf = (head, combo) => `YQ-${tag}-${[head].concat(combo.map(x => x.code)).join('-')}`;
    const mixHead = vals => 'MIX' + (vals.length > 1 ? vals.length : '');
    const cCn = (combo) => combo.map(x => x.value.name).join('');
    const cEn = (combo) => combo.map(x => enOf(x.value.name)).join(' ');
    // 中文名：1~2 个值直接写值名，更多值写「N 款规格混合装 …」（N 来自真实数据）
    const cnMix = (vals, tail) => (vals.length <= 2
      ? `${vals.map(v => v.name).join('+')} ${tail}`
      : `${vals.length} 款规格混合装 ${tail}`);
    const enMix = (vals, tail) => `${vals.length} Specs ${tail}`;

    const base = [], extra = [];                             // 先排「真实规格」行，再排包装组合行
    const add = (o, isBase, vals) => {
      // 成本价怎么取：默认「按各规格自己的标价」（1688 常写成打包阶梯：单片/5片装/10片装价不一样）
      o.unitCost = (p.costMode === 'param') ? n(p.unitCost) : rowUnitCost(vals, o.pcs, p.unitCost);
      o.enPending = hasCJK(o.nameEn);
      (isBase ? base : extra).push(o);
    };
    /* ---- AI（DeepSeek）计划：它挑规格组合 / 件数 / 配件 / 英文名；价格与成本仍由这里算 ----
     * p.aiPlan = { rows:[{kind, values:[规格值原文], pcs, accessory, nameEn}], skipped, notes }
     * 值名对不上页面数据的行直接跳过（ai-plan.cjs 已硬校验过，这里是第二道保险） */
    const aiRows = (p.aiPlan && Array.isArray(p.aiPlan.rows) && p.aiPlan.rows.length) ? p.aiPlan.rows : null;
    if (aiRows) {
      const nameIdx = new Map();
      dims.forEach(d => (d.values || []).forEach(v => { if (!nameIdx.has(v.name)) nameIdx.set(v.name, { dim: d, value: v }); }));
      aiRows.forEach(r => {
        const picked = (r.values || []).map(nm => nameIdx.get(String(nm).trim())).filter(Boolean);
        if (!picked.length) return;
        const vals = picked.map(x => x.value);
        const cnVals = vals.filter((v, i) => vals.indexOf(v) === i);
        const prim = picked.find(x => x.dim === primary) || picked[0];
        const combo = picked.filter(x => x.dim !== primary).map(x => ({
          dim: x.dim, value: x.value,
          code: x.value.code || 'V' + dims.indexOf(x.dim) + (x.dim.values.indexOf(x.value) + 1)
        }));
        const head = picked.length > 1 ? mixHead(vals) : pcode(prim.value, primary.values.indexOf(prim.value));
        const pcs = Math.max(1, Math.round(n(r.pcs) || 1));
        const nameCn = r.nameCn || ((r.kind === '原规格' && pcs === 1)
          ? `${prim.value.name}单支（原规格）`
          : cnMix(cnVals, `${pcs} 支装`) + (r.accessory ? ' + 便携收纳盒' : ''));
        const nameEn = String(r.nameEn || '').trim() ||
          (`${cnVals.map(v => enOf(v.name)).join(' + ')} - ${pcs} Pack` + (r.accessory ? ' with Case' : ''));
        add({
          sku: skuOf(head, combo) + '-' + pcs + 'P' + (r.accessory ? '-C' : ''),
          nameCn, nameEn,
          spec: specOfValues(vals, dims, combo),
          colorSpec: cnVals.map(v => v.name).join('/'),
          pcs, accessory: !!r.accessory, kind: r.kind || '组合装', ai: true
        }, r.kind === '原规格', vals);
      });
    } else combos.forEach(combo => {
      const cnTail = combo.length ? `｜${cCn(combo)}` : '';       // 子规格写进中文名，避免同名行
      const enTail = combo.length ? ` ${cEn(combo)}` : '';        // 英文名同理
      const others = colors.slice(1);
      // 1) 原厂规格：父规格每个值一支（值是页面上的原文，不是模板词）—— 这是「真实规格」行，先排
      colorsAll.forEach((c, i) => add({
        sku: skuOf(pcode(c, i), combo) + '-1P',
        nameCn: `${c.name}单支（原规格）${cnTail}`,
        nameEn: `${enOf(c.name)}${enTail} - 1 Pack`,
        spec: specOfValues([c], dims, combo),
        colorSpec: c.name + (c.code ? ' #' + c.code + '#' : ''),
        pcs: 1, accessory: false, kind: '原规格', source: c
      }, true, [c]));
      // 2) 首个值双支装
      add({ sku: skuOf(pcode(colors[0], 0), combo) + '-2P', nameCn: `${colors[0].name}双支装${cnTail}`,
        nameEn: `${enOf(colors[0].name)}${enTail} - 2 Pack`, spec: specOfValues([colors[0]], dims, combo),
        colorSpec: colors[0].name, pcs: 2, accessory: false, kind: '组合装' }, false, [colors[0]]);
      // 3) 两种规格各一支
      if (others[0]) add({ sku: skuOf(mixHead(colors.slice(0, 2)), combo) + '-2P',
        nameCn: cnMix(colors.slice(0, 2), '混合双支装') + cnTail,
        nameEn: enMix(colors.slice(0, 2), '- 2 Pack') + enTail,
        spec: specOfValues(colors.slice(0, 2), dims, combo),
        colorSpec: colors.slice(0, 2).map(c => c.name).join('+'), pcs: 2, accessory: false, kind: '组合装' }, false, colors.slice(0, 2));
      // 4) 三种规格各一支
      if (others[1]) add({ sku: skuOf(mixHead(colors.slice(0, 3)), combo) + '-3P',
        nameCn: cnMix(colors.slice(0, 3), '三支装') + cnTail,
        nameEn: enMix(colors.slice(0, 3), '- 3 Pack') + enTail,
        spec: specOfValues(colors.slice(0, 3), dims, combo),
        colorSpec: colors.slice(0, 3).map(c => c.name).join('/'), pcs: 3, accessory: false, kind: '组合装' }, false, colors.slice(0, 3));
      // 5) 六支装
      add({ sku: skuOf(mixHead(colors), combo) + '-6P', nameCn: cnMix(colors, '六支装') + cnTail,
        nameEn: enMix(colors, '- 6 Pack') + enTail, spec: specOfValues(colors, dims, combo),
        colorSpec: colors.map(c => c.name).join('/'), pcs: 6, accessory: false, kind: '囤货装' }, false, colors);
      // 6) 九支装（多件折扣）
      add({ sku: skuOf(mixHead(colors), combo) + '-9P', nameCn: cnMix(colors, '九支装（多件折扣）') + cnTail,
        nameEn: `All ${colors.length} Specs${enTail} - 9 Pack`, spec: specOfValues(colors, dims, combo),
        colorSpec: colors.map(c => c.name).join('/'), pcs: 9, accessory: false, kind: '囤货装' }, false, colors);
      // 7) 含收纳盒（配件）款
      add({ sku: skuOf(pcode(colors[0], 0), combo) + '-1P-C', nameCn: `${colors[0].name}单支 + 便携收纳盒${cnTail}`,
        nameEn: `${enOf(colors[0].name)}${enTail} with Travel Case`, spec: specOfValues([colors[0]], dims, combo),
        colorSpec: colors[0].name, pcs: 1, accessory: true, kind: '带配件' }, false, [colors[0]]);
      if (others[0]) add({ sku: skuOf(pcode(others[0], 1), combo) + '-2P-C', nameCn: `${others[0].name}双支 + 收纳盒${cnTail}`,
        nameEn: `${enOf(others[0].name)}${enTail} - 2 Pack with Case`, spec: specOfValues([others[0]], dims, combo),
        colorSpec: others[0].name, pcs: 2, accessory: true, kind: '带配件' }, false, [others[0]]);
      add({ sku: skuOf(mixHead(colors.slice(0, 3)), combo) + '-3P-C', nameCn: cnMix(colors.slice(0, 3), '三支 + 收纳盒') + cnTail,
        nameEn: enMix(colors.slice(0, 3), '- 3 Pack with Case') + enTail, spec: specOfValues(colors.slice(0, 3), dims, combo),
        colorSpec: colors.slice(0, 3).map(c => c.name).join('/'), pcs: 3, accessory: true, kind: '带配件' }, false, colors.slice(0, 3));
    });

    // 真实规格行在前、包装组合行在后：封顶时先丢包装行，实打实的规格组合不丢
    const rows = base.concat(extra);

    // SKU 必须唯一（重复的 SKU 上传会被平台拒掉）——万一规格编码撞车，追加序号兜住
    const seen = new Map();
    rows.forEach(r => {
      const n = seen.get(r.sku) || 0;
      seen.set(r.sku, n + 1);
      if (n) r.sku = `${r.sku}-${n + 1}`;
    });

    // 规格维度太多时封顶，避免表被撑爆（页面上会说明被截断）
    const total = rows.length;
    if (p.maxVariants && total > p.maxVariants) {
      rows.length = p.maxVariants;
      rows[rows.length - 1].truncated = { total, kept: p.maxVariants };
    }
    rows.dims = dims;
    rows.allDims = allDims;                                   // 页面用来提示「还有 N 级规格没显示」
    rows.dimsShown = dims.length;
    rows.combos = combos.length;

    const rows2 = rows.map((r, i) => Object.assign({ idx: i + 1 }, r));
    const floor = floorDetail(rows2, p);                      // 低价兜底按整单判定，不逐行
    const out = rows2.map(r => Object.assign({}, r, { pricing: priceVariant(r, p, floor.boost), floor }));
    out.dims = dims;
    out.allDims = allDims;
    out.dimsShown = dims.length;
    return out;
  }

  /* 低价兜底：只要有规格的「原定价」低于阈值，就给所有规格统一加价
   * 口径（用户定）：任一规格定价 < 3 元 → 所有规格定价 +3 元 */
  function floorDetail(rows, params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    const add = n(p.lowPriceAdd), threshold = n(p.lowPriceThreshold);
    const enabled = add > 0 && threshold > 0;
    let lowCount = 0;
    if (enabled) {
      lowCount = (rows || []).filter(r => {
        const x = priceVariant(r, p, 0);
        return x.ok && x.price < threshold;
      }).length;
    }
    const applied = enabled && lowCount > 0;
    return { enabled, threshold, add, lowCount, applied, boost: applied ? add : 0 };
  }
  const variantPriceBoost = (rows, params) => floorDetail(rows, params).boost;

  /* 公式展示：带代入数值，便于核对 */
  function formulaLines(v, params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    const r = v.pricing || priceVariant(v, p);
    const K = discountFactor(p);
    const Kexpr = p.stackMode === 'add' ? `1−${p.bargain}%−${p.discount}%` : `(1−${p.bargain}%)×(1−${p.discount}%)`;
    const f4 = (x) => (Number.isFinite(x) ? Number(x.toFixed(4)) : '—');
    const f2 = (x) => (Number.isFinite(x) ? Number(x.toFixed(2)) : '—');
    const numExpr = p.marginBase === 'list' ? `[K − 毛利率]` : p.marginBase === 'cost' ? `[K ÷ (1+毛利率)]` : `[K × (1 − 毛利率)]`;
    const den = p.marginBase === 'list' ? K - n(p.margin) / 100 : p.marginBase === 'cost' ? K / (1 + n(p.margin) / 100) : K * (1 - n(p.margin) / 100);
    const solved = Number.isFinite(r.priceSolved) ? r.priceSolved : r.price;   // 兜底前的原定价
    const lines = [
      `折扣系数 K = ${Kexpr} = ${f4(K)}`,
      `拿货成本 = 拿货价 ${f2(p.unitCost)} × ${v.pcs} 件${v.accessory ? ` + 配件 ${f2(p.accessoryCost)}` : ''} = ${f2(r.baseCost)} 元`,
      `运费 = 成本 × 运费率 = ${f2(r.baseCost)} × ${f2(p.freightRate)}% = ${f2(r.freight)} 元`,
      `总成本 = ${f2(r.baseCost)} + ${f2(r.freight)} = ${f2(r.totalCost)} 元`,
      `定价 = 总成本 ÷ ${numExpr} = ${f2(r.totalCost)} ÷ ${f4(den)} = ${f2(solved)} 元` + (r.priceBoost > 0 ? ` → 低价兜底 +${f2(r.priceBoost)} = ${f2(r.price)} 元` : ''),
      `到手价 = 定价 × K = ${f2(r.price)} × ${f4(K)} = ${f2(r.net)} 元`,
      `单件利润 = (到手价 − 总成本) ÷ ${v.pcs} = ${f2(r.profit)} ÷ ${v.pcs} = ${f2(r.unitProfit)} 元`,
      `毛利率复核 = 利润 ÷ 到手价 = ${f2(r.profit)} ÷ ${f2(r.net)} = ${(r.marginOnNet * 100).toFixed(1)}%`,
      `欧元价 = 定价 ÷ 汇率 = ${f2(r.price)} ÷ ${f2(p.fxRate)} = €${Number(r.priceEur).toFixed(2)}（凑整 €${Number(r.priceEur99).toFixed(2)}）`
    ];
    const fl = v.floor;
    if (fl && fl.applied) {
      lines.push(`低价兜底：本单有 ${fl.lowCount} 个规格的原定价低于 ${f2(fl.threshold)} 元 → 所有规格定价统一 +${f2(fl.add)} 元（上表定价、到手价、利润、欧元价均已按兜底后计算）`);
    }
    return lines;
  }

  return { DEFAULTS, discountFactor, priceVariant, buildVariants, rowUnitCost, floorDetail, variantPriceBoost, formulaLines, COLOR_EN, specDims, specOfValues, enOf, hasCJK };
});
