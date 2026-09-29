/* 1688 商品页解析：输入页面文本/源码，输出结构化商品数据
 * 兼容三种输入：① 浏览器取回的纯文本(innerText) ② markdown ③ HTML 源码
 * 设计原则：每个字段独立解析 + 置信度标记，缺失就报 missing，绝不编造。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Parse1688 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CN = '\\u4e00-\\u9fa5';
  // 导航/法务/推荐位噪声：出现这些词的候选标题一律不要
  const NAV = /阿里|备案|许可证|价格说明|优惠|平台活动|侵权|举报|声明|登录|规格|库存|运费|协议|隐私|服务条款|热线|客服|导航|热门推荐|已售|反馈|插件/;
  // 推荐位的价格（"¥1.04已售8万+个"）不是本商品价格
  const NOISE_AROUND = /已售|offer\/\d+|热门推荐|猜你喜欢|同款|推荐|对比/;

  function stripTags(s) {
    return s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/[ \t]+/g, ' ');
  }
  // markdown 降噪：图片、链接语法、强调符（真实页面转出来的 md 里 ¥ 和数字之间常夹 **）
  function demd(s) {
    return s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|`{1,3}/g, '')
      .replace(/\\/g, '');
  }
  function toText(input) {
    if (!input) return '';
    const looksHtml = /<\/(div|span|html|body|table)>/i.test(input);
    return looksHtml ? stripTags(input) : demd(input);
  }
  const num = (s) => { const v = parseFloat(String(s).replace(/,/g, '')); return Number.isFinite(v) ? v : null; };

  function pickTitle(text, html, meta) {
    const SUFFIX = /\s*[-–—_|]\s*(阿里巴巴|1688\.com|1688|Alibaba\.com|阿里巴巴中国站)\s*$/i;
    // 页面里到处是活动说明/法律声明这类长句，它们比商品名还长 —— 不排掉就会抓成标题
    const PROSE = /[。；;]|活动前|预热|爆发期|说明|声明|优惠|津贴|红包|返利|举报|版权所有|条款|请|提醒|注意|示例|近\d+天/;
    const COMPANY = /有限公司|商行|工厂|商贸|经营部|电子商务|旗舰店|专营店|个体工商户/;   // 1688 的 <h1> 常常是店铺名
    const clean = (s) => (s || '').replace(/\s+/g, ' ').replace(SUFFIX, '').trim();
    if (html) {
      const cands = [];
      if (meta && meta.pageTitle) cands.push(clean(meta.pageTitle));    // 浏览器标题最贴商品名
      const push = (re) => { const m = html.match(re); if (m) cands.push(clean(m[1])); };
      push(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{4,200})["']/i);
      push(/<title[^>]*>([\s\S]{4,200}?)<\/title>/i);
      push(/<h1[^>]*>([\s\S]{4,200}?)<\/h1>/i);                          // 只作最后备选（h1 多为店铺名）
      const good = cands.filter(t => t.length >= 4 && !PROSE.test(t) && !COMPANY.test(t));
      if (good.length) return good[0];
      const ok2 = cands.filter(t => t.length >= 4 && !PROSE.test(t));
      if (ok2.length) return ok2[0];
    }
    const ok = (h) => h.length >= 12 && h.length <= 90 && new RegExp(`[${CN}]`).test(h) && !NAV.test(h) && !PROSE.test(h);
    const heads = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].trim()).filter(ok);
    if (heads.length) return clean(heads[0]);
    // 页面顺序上商品名在最靠前的位置，所以取第一条合格的，而不是最长的一条（最长的那条往往是法务/活动文案）
    const cands = text.split('\n').map(s => s.trim()).filter(ok);
    return cands.length ? clean(cands[0]) : null;
  }

  function pickPrices(text, specEnd) {
    // 1688 的价格面板会把数字拆行：「¥ / 11 / .50」→ 先并回同一行再找价，否则 11.50 会被读成 11
    // 顺手记下每次合并吃掉的那一个换行的位置：算好的规格块位置（原文本坐标）要换算到这里的坐标才能比大小
    const cuts1 = [];
    const s1 = text.replace(/([¥￥])[ \t]*\r?\n[ \t]*/g, (m0, g1, off) => { cuts1.push(off + 1); return g1; });
    const cuts2 = [];
    const t = s1.replace(/(\d)[ \t]*\r?\n[ \t]*(\.\d+)/g, (m0, g1, g2, off) => { cuts2.push(off + 1); return g1 + g2; });
    const lt = (arr, x) => { let c = 0; for (const v of arr) { if (v < x) c++; } return c; };
    const shift = (p) => { const p1 = p - lt(cuts1, p); return p1 - lt(cuts2, p1); };
    const hits = [];
    let m;
    const rePrice = /[¥￥]\*{0,2}\s*(\d+(?:\.\d+)?)/g;   // 兼容 ￥**0.34**
    while ((m = rePrice.exec(t))) {
      const price = num(m[1]);
      if (price === null || price <= 0) continue;
      const around = t.slice(Math.max(0, m.index - 100), m.index + 100).replace(/\s+/g, ' ');
      const near35 = t.slice(Math.max(0, m.index - 35), m.index + 35).replace(/\s+/g, ' ');
      const after25 = t.slice(m.index + m[0].length, m.index + m[0].length + 25).replace(/\s+/g, ' ').trim();
      if (NOISE_AROUND.test(near35)) continue;             // 推荐位/其他商品的价格（窗口收紧，别把本商品面板误杀）
      if (/^(已售|售)[\s|]*[\d一二三四五六七八九十]/.test(after25)) continue;   // 推荐卡片的「¥4.50 售 1万+件」（数字也常被拆行 → 允许分隔符）
      const pre = t.slice(Math.max(0, m.index - 14), m.index);
      if (/运费|邮费|包邮/.test(pre)) continue;            // 运费不是货价
      // 「新人价 / 首件预估到手价 / 60天老客价」是促销估算，不是拿货价（只看紧挨着价格的那几个字，别把上一个价格的关键词带进来）
      if (/新人价|首件|预估|老客价/.test(pre)) {
        hits.push({ price, type: '活动价', minQty: null, note: around.slice(0, 70).trim(), pos: m.index });
        continue;
      }
      // 规格弹层里的「¥0.34库存6853667件」是单色价，不是价格档位（pickColors 会单独收）
      if (/库存/.test(t.slice(Math.max(0, m.index - 12), m.index + 12).replace(/\s+/g, ' '))) continue;
      const qty = around.match(/≥\s*(\d+)\s*件|(\d+)\s*件混批|(\d+)\s*件起批|起批\s*(\d+)/);
      const minQty = qty ? num(qty[1] || qty[2] || qty[3] || qty[4]) : null;
      // 关键词取「离价格最近」的那个，而不是窗口里出现过就算（页面里代发/混批/限时经常挨在一起）
      const kwStart = Math.max(0, m.index - 50);
      const win = t.slice(kwStart, m.index + 50).replace(/\s+/g, ' ');
      const pos = t.slice(kwStart, m.index).replace(/\s+/g, ' ').length;
      const spots = [];
      const scan = (re, tt) => { const r = new RegExp(re, 'g'); let mm; while ((mm = r.exec(win))) spots.push({ t: tt, d: Math.abs(mm.index - pos) }); };
      scan('代发', '代发价'); scan('混批|起批', '混批价'); scan('限时|1折|折后|活动|促销', '活动价');
      spots.sort((a, b) => a.d - b.d);
      const type = spots.length ? spots[0].t : '页面价';
      // 「限时1折」这类促销价再近也不当作常规拿货价
      const near = t.slice(Math.max(0, m.index - 25), m.index + 15).replace(/\s+/g, ' ');
      const finalType = /限时|1折|折后|促销|秒杀/.test(near) ? '活动价' : type;
      hits.push({ price, type: finalType, minQty, note: around.slice(0, 70).trim(), pos: m.index });
    }
    const rank = { '代发价': 4, '混批价': 3, '活动价': 2, '页面价': 1 };
    const byPrice = new Map();
    for (const h of hits) {
      const cur = byPrice.get(h.price);
      if (!cur || rank[h.type] > rank[cur.type]) byPrice.set(h.price, h);
    }
    const out = [...byPrice.values()].sort((a, b) => a.price - b.price);
    // 「同款推荐/热门推荐…」之后的价格都是别的商品。界线必须从**规格块之后**开始找：
    // 这些词在页头/导航里也有（页头那条命中过，会把真正的价格面板一起误杀）→ 以前这条界线判错，档位会整段丢空。
    const from = specEnd > 0 ? shift(specEnd) : -1;
    const mi = from > 0 ? t.slice(from).search(/同款推荐|猜你喜欢|热门推荐|看了又看|为你推荐|相关推荐|相似商品/) : -1;
    out.zoneStart = mi >= 0 ? from + mi : -1;
    return out;
  }

  /* ---------- 规格维度：不写死「颜色」 ----------
   * 1688 的规格可以多级（父规格 + 子规格），标签随商品而变（颜色/尺码/型号/款式/尺寸…）。
   * 结构上都是「短标签行 → 一个或多个规格值，每个值后面跟 ¥价 + 库存」，所以按结构识别标签。
   * 两种值写法都认：① 带页面编码 粉色#C1Y1P#  ② 不带编码 黑色 / ¥0.65 / 库存976593双
   * 返回 [{ label, values:[{name, code, price, stock}] }]，顺序 = 页面顺序（第一个当父规格）。
   */
  const NOISE_LABEL = /选择|商品规格/;
  const clean = (l) => String(l == null ? '' : l).replace(/^#{1,6}\s*/, '').replace(/[|\s]+/g, ' ').trim();
  /* 常见的规格维度标签词。只用来「判断这行不是规格值」（值块在这里收住），
   * 维度名本身仍然按结构取，不写死。 */
  const LABEL_WORD = /^(颜色|色彩|色系|颜色分类|尺码|尺寸|鞋码|规格|型号|款式|版本|容量|功率|套餐|数量|材质|口味|净含量|重量|长度|宽度|高度|直径|适用|尺寸码数)$/;
  /* 界面上会出现的按钮/服务文案 —— 不能当成规格值收进来 */
  const UI_VALUE = /^(立即|加入|加采购|加铺货|跨境|代发|密文|收藏|对比|关注|分享|举报|包装定制|贴标签|展开|收起|送至|运费|包邮|退货|退货包运费|包赔|必赔|开票|保障|服务|说明|参数|详情|评价|推荐|看了|销量|库存|客户|买家|采购|批发|同行|相似|更多|全部|月销|累计|发货|产地|品牌|货号|起批|首单|先采|现在付款|预计|全网|品质|严选|极速|严选晚发必赔|品质不符包赔|敢赔付|达人|代发价|混批价|分销|优惠|领券|满减|新人|关注店铺|进入店铺|联系客服)/;
  const VALUE_SEP = /^[-—=*_·•]+$/;
  /* 后面不带价格/库存的纯规格值行（1688 常把价+库存只挂在最后一个维度上） */
  function isBareValueLine(t) {
    if (!t || t.length > 24) return false;
    if (/[¥￥]|库存|已售|销量/.test(t)) return false;
    if (/^!\[/.test(t) || VALUE_SEP.test(t)) return false;
    if (LABEL_WORD.test(t) || UI_VALUE.test(t)) return false;
    if (/^[\d.\s]+$/.test(t) && !/^[1-9]\d{0,2}(\.\d)?$/.test(t)) return false;   // 纯数字：像尺码（36/45/36.5）才当值
    if (/[。；;]$/.test(t)) return false;                       // 句子
    return true;
  }
  /* 尺寸：两个来源都读，逐字/逐数来自页面：
   *   ① 件重尺表（表头含「长(cm) 宽(cm) 高(cm)」，数值在下一行；有的表前面还有颜色/尺码两列）——
   *      按表头列名定位，逐行取值；多行规格不同 → 取 min~max 区间（如实反映「按规格不同」）。
   *   ② 属性行「尺寸 / 商品尺寸 / 规格尺寸 → 值」（如 7*7.5），逐字保留。 */
  function pickSize(text) {
    const lines = String(text || '').split(/\r?\n/);
    let table = null, text_ = '';
    for (let i = 0; i < lines.length && !table; i++) {
      const head = lines[i];
      if (!/长\s*\(cm\)/.test(head) || !/宽\s*\(cm\)/.test(head) || !/\t/.test(head)) continue;
      const cols = head.split('\t').map(s => s.trim());
      const at = k => cols.findIndex(c => c.indexOf(k) >= 0);
      const ix = { l: at('长'), w: at('宽'), h: at('高'), v: at('体积'), g: at('重量') };
      const rows = [];
      for (let j = i + 1; j < lines.length && j <= i + 60; j++) {
        const raw = lines[j];
        if (!raw.trim()) { if (rows.length) break; continue; }
        if (/\(cm\)/.test(raw)) break;                       // 下一张表
        const cells = raw.split('\t').map(s => s.trim());
        const num = k => (ix[k] >= 0 && cells[ix[k]] != null && /^-?\d+(?:\.\d+)?$/.test(cells[ix[k]])) ? Number(cells[ix[k]]) : null;
        const l = num('l'), w = num('w'), h = num('h');
        if (l == null && w == null) { if (rows.length) break; continue; }
        rows.push({ l, w, h, v: num('v'), g: num('g') });
        if (rows.length >= 60) break;
      }
      if (rows.length) table = rows;
    }
    const bend = (k) => {
      const vals = (table || []).map(r => r[k]).filter(n => n != null);
      if (!vals.length) return null;
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const f = n => (Math.round(n * 1000) / 1000).toString();
      return lo === hi ? f(lo) : f(lo) + '–' + f(hi);
    };
    /* 属性行「尺寸」：标签行（可带 \t）→ 值在下一行 */
    for (let i = 0; i < lines.length && !text_; i++) {
      const L = lines[i].trim();
      if (!/^(?:商品|规格|产品|外形|包装)?尺寸(?:（[^）]{1,6}）)?$/.test(L)) continue;
      const cand = (lines[i + 1] || '').trim();
      if (!cand || cand.length > 20) continue;
      if (/^[\d.]+\s*[*×xX]/.test(cand) || /^(?:长|宽|高)/.test(cand)) text_ = cand;   // 形如 7*7.5 / 30cm*30cm
    }
    const out = {};
    const l = bend('l'), w = bend('w'), h = bend('h'), v = bend('v');
    if (l != null || w != null || h != null) { out.l = l; out.w = w; out.h = h; if (v != null) out.volume = v; }
    if (text_) out.text = text_;
    return (out.l != null || out.text) ? out : null;
  }

  /* 材质：页面上是「鞋底材质 / 鞋面材质 / 内里材质 / 主面料成分…」这类属性行。两种排版都见过：
   *   a) 属性表（标签行带 \t）    → 值在下一行（最可靠，优先）
   *   b) 详情区的纯文本行          → 值可能在上、也可能在下（各页不一，当兜底）
   * 同名标签以 (a) 为准；值必须短、不含顿号/逗号（那种是「功能」之类别的属性的值），也不能又是一个材质标签。 */
  const MAT_LABEL_RE = /^[\u4e00-\u9fa5A-Za-z]{0,6}(?:材质|面料|成分|里料|帮面)$/;   // 前缀 0 个字也对：「材质」单独一行很常见
  const MAT_NOISE_RE = /[、,，;；|]|\d{3,}|cm|CM|克\/|功能|款式|颜色|尺码|属性/;
  function pickMaterials(text) {
    const lines = String(text || '').split(/\r?\n/);
    const isLabel = s => MAT_LABEL_RE.test(String(s || '').trim());   // 「材质」单独一行也算（很多页面就这么写），长句里的不算
    const okValue = s => {
      const v = String(s == null ? '' : s).trim();
      if (!v || v.length > 14) return '';
      if (isLabel(v)) return '';
      if (MAT_NOISE_RE.test(v)) return '';
      if (!/[A-Za-z0-9\u4e00-\u9fa5]/.test(v)) return '';   // 纯标点/空白不是值（注意：JS 的 \W 不认汉字，不能用它判断）
      return v;
    };
    const tab = new Map(), bare = new Map();              // 带制表符的可靠；纯文本行的兜底
    lines.forEach((raw, i) => {
      const L = raw.trim();
      if (!isLabel(L)) return;
      const hasTab = /\t/.test(raw);
      const cells = raw.split('\t').map(t => t.trim()).filter(Boolean);
      /* 两种排版各自一致（两个夹具都对得上）：
       *   属性表（带 \t）：标签行 → 值在下一行；
       *   纯文本行        ：值在上一行、标签在下（「EVA \n 鞋底材质」）。 */
      let v = cells.length > 1 ? okValue(cells[cells.length - 1]) : '';   // 值和标签同一行
      if (!v) v = hasTab ? okValue(lines[i + 1]) : okValue(lines[i - 1]);
      if (!v) v = hasTab ? okValue(lines[i - 1]) : okValue(lines[i + 1]); // 兜底：换另一侧再试
      if (!v) return;
      (hasTab ? tab : bare).set(L, v);
    });
    const out = [], seen = new Set();
    [...tab.keys(), ...bare.keys()].forEach(k => {        // 制表符版优先
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ label: k, value: tab.has(k) ? tab.get(k) : bare.get(k) });
    });
    return out.slice(0, 4);
  }

  function labelBefore(lines, i) {
    for (let k = i - 1; k >= 0 && k >= i - 6; k--) {
      const t = (lines[k] || '').replace(/^#{1,6}\s*/, '').replace(/[|\s]+/g, ' ').trim();
      if (!t) continue;
      if (/^!\[/.test(t) || /^[-—=*_]+$/.test(t)) continue;      // 图片行、分隔线
      if (/[¥￥]|库存/.test(t)) break;                             // 撞到上一个值的价格行 → 这组没有独立标签
      if (t.length <= 8 && !NOISE_LABEL.test(t)) return t;
      // 标签行有时被备注粘住：「尺码按包起批，每包5双」「颜色分类 8 种可选」——
      // 取开头的维度词当标签（限 20 字内，免得长句被误判成标签）。不这么干，尺寸值会并进颜色维度。
      const pref = t.match(/^(颜色|色彩|色系|尺码|尺寸|鞋码|规格|型号|款式|版本|容量|功率|套餐|口味|净含量|重量|长度|宽度|高度|直径)/);
      if (pref && t.length <= 20) return pref[1];
      return null;
    }
    return null;
  }
  /* 【英文版.欧规】紫色全自动32mm → ['英文版.欧规', '紫色全自动32mm']（父规格 / 子规格，原样拆分不加工） */
  function splitParts(name) {
    const m = String(name || '').match(/^【([^】]{1,24})】\s*(.{1,24})$/);
    return m ? [m[1].trim(), m[2].trim()] : null;
  }

  /* 有些页面把规格写在属性区（颜色 / 尺码 各是一整行逗号分隔的值），规格弹层里只有默认那几档，
     甚至压根不在正文里 —— 这时按这两张表补全：
       · 「件重尺」表的表头（如「颜色 尺码 长(cm) … 重量(g)」）就是「页面上哪些属性是规格」的判据，
         表头里 长(cm) 之前的列名即维度名（页面自己的词，不写死）；
       · 每行列出的组合把各维度的值收全（含那些没出现在弹层里的档位）；
       · 属性区「标签 → 逗号值行」的值更全、顺序更权威，放在前面。
     一律只做「补齐」，已有维度不重建；补不到就返回 null，行为照旧。 */
  function dimsFromTables(text) {
    const lines = String(text || '').split(/\r?\n/);
    let hdr = -1, cols = [];
    for (let i = 0; i < lines.length; i++) {
      const cells = lines[i].split('\t').map(s => s.trim());
      let cut = cells.findIndex(c => /^长\s*\(cm\)$/i.test(c));
      let minCells = cut + 2;
      if (cut < 0) {
        // 有些商品（如鞋垫）的表头是「颜色 尺码 重量(g)」——没有长(cm)列，整张表会被跳过（重量也丢）。
        // 兜底必须窄：① 表头上方有「件重尺」路标；② 表头里没有任何测量列（长/宽/高/体积/尺寸）。
        // 长(cm) 排在第一个（cut==0）的表是「前面没有规格列」的尺寸表，原逻辑本来就跳过，别接回来。
        const near = lines.slice(Math.max(0, i - 5), i).join(' ');
        const hasMeasureCol = cells.some(c => /^(长|宽|高|体积|尺寸)\s*[（(]/.test(c));
        if (/件重尺/.test(near) && !hasMeasureCol) {
          cut = cells.findIndex(c => /^(重量|重)\s*(\(g\))?$/i.test(c));
          minCells = cut + 1;
        }
      }
      if (cut > 0 && cells.length >= minCells) { hdr = i; cols = cells.slice(0, cut); break; }
    }
    if (hdr < 0 || !cols.length) return null;
    const seen = cols.map(() => new Set()), vals = cols.map(() => []);
    const push = (j, nm) => { nm = String(nm || '').trim(); if (!nm || seen[j].has(nm)) return; seen[j].add(nm); vals[j].push(nm); };
    const filled = cols.map(() => '');
    let minW = null;
    for (let i = hdr + 1; i < lines.length; i++) {
      const cells = lines[i].split('\t').map(s => s.trim());
      if (cells.length < cols.length + 1) break;                 // 不是这张表了
      let any = false;
      cols.forEach((c, j) => { if (cells[j]) { filled[j] = cells[j]; any = true; } });   // 合并单元格：沿用上一行
      if (!any) break;
      cols.forEach((c, j) => push(j, filled[j]));
      const w = cells.filter(x => x).map(x => parseFloat(x)).filter(x => Number.isFinite(x) && x > 0).pop();
      if (w != null) minW = (minW == null) ? w : Math.min(minW, w);
    }
    if (!cols.some((c, j) => vals[j].length)) return null;
    const attrVals = col => {                                    // 属性区：标签单独一行、下一行是逗号值
      for (let i = 0; i < lines.length - 1; i++) {
        if (clean(lines[i]) !== col) continue;
        const parts = clean(lines[i + 1]).split(/[,，]/).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) return parts;
      }
      return [];
    };
    const dims = cols.map((c, j) => {
      const extra = attrVals(c);
      const all = extra.concat(vals[j].filter(v => extra.indexOf(v) < 0));
      return { label: c, values: all.map(nm => ({ name: nm, code: null, price: null, stock: null })) };
    }).filter(d => d.values.length);
    return dims.length ? { dims, minWeight: minW } : null;
  }

  function pickSpecs(text) {
    const lines = text.split('\n');
    const offs = [];                                            // 每行起始位置，用来把匹配位置换算成行号
    let acc = 0;
    for (const l of lines) { offs.push(acc); acc += l.length + 1; }
    const lineOf = (pos) => { let lo = 0, hi = offs.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };

    const vals = [];                                            // 按页面顺序收集，带各自的标签
    const valuePair = [];                                       // ① 带编码（沿用已验证的取值合并逻辑）
    const found = new Map();
    const re = new RegExp(`([${CN}]{1,6})\\s*#([A-Za-z0-9]{2,12})#`, 'g');
    let m;
    while ((m = re.exec(text))) {
      const key = m[2], name = m[1];
      const at = m.index + m[0].indexOf(name);                  // 值本身的位置（不是匹配起点，否则标签会算到上一行）
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 160).replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\s+/g, ' ');
      const cur = found.get(key) || { name, code: key, stock: null, price: null, pos: at, label: labelBefore(lines, lineOf(at)) };
      // 规格弹层里「¥0.34库存6853667件」价与库存成对出现 —— 这一对才是「规格标价」
      const paired = after.match(/[¥￥]\*{0,2}\s*(\d+(?:\.\d+)?)\s*库存\s*([\d,]+)\s*件/);
      if (paired) {
        cur.price = num(paired[1]);
        cur.stock = num(paired[2]);
        // 属性表格里也会写「| 颜色 | 粉色#C1Y1P#、… |」，那里的标签不是规格维度；
        // 真正的规格块（价+库存成对）出现时，用它的位置和标签覆盖
        cur.pos = at;
        const lab = labelBefore(lines, lineOf(at));
        if (lab) cur.label = lab;
      } else {
        const stock = after.match(/库存\s*([\d,]+)\s*件/);
        const loose = after.match(/[¥￥]\*{0,2}\s*(\d+(?:\.\d+)?)/);
        if (cur.stock === null && stock) cur.stock = num(stock[1]);
        if (cur.price === null && loose && !NOISE_AROUND.test(after)) cur.price = num(loose[1]);
      }
      found.set(key, cur);
    }
    found.forEach(v => valuePair.push(v));

    // ② 没有页面编码的规格块，两种排法都认：
    //    多行「值 → ¥价 → 库存N」；或同一行「值 ¥价 库存N」。
    //    值的长度上限放到 40：真实规格值可能是「【英文版.欧规】紫色全自动32mm」这种 17 字符的组合值，
    //    以前卡 16 字符 → 一个都读不到 → 整单退化成「单色兜底」（用户报过）。
    const NAME_RE = `([^\\r\\n|¥￥]{1,40}?)`;
    const pats = [
      new RegExp(`(?:^|\\r?\\n)[ \\t]*${NAME_RE}[ \\t]*\\r?\\n[ \\t]*[¥￥]\\*{0,2}[ \\t]*(\\d+(?:\\.\\d+)?)[ \\t]*\\r?\\n?[ \\t]*库存[ \\t]*([\\d,]+)`, 'g'),
      new RegExp(`(?:^|\\r?\\n)[ \\t]*${NAME_RE}[ \\t]*[¥￥]\\*{0,2}[ \\t]*(\\d+(?:\\.\\d+)?)[ \\t]*库存[ \\t]*([\\d,]+)`, 'g')
    ];
    for (const re of pats) {
      while ((m = re.exec(text))) {
        let name = (m[1] || '').trim();
        const price = num(m[2]), stock = num(m[3]);
        if (price === null || price <= 0) continue;
        const cm = name.match(/^(.*?)#([A-Za-z0-9]{2,12})#$/);
        const code = cm ? cm[2] : null;
        if (cm) name = cm[1].trim();
        if (!name) continue;
        // 干净的规格值，不是句子。注意**不能连括号一起扔**：1688 的尺码常写成
        // 「36/37（标准尺码）」—— 一扔就是「每个尺码都读不到 → 整单退化成单色兜底」。
        if (/[¥￥、，,。；;：:]/.test(name)) continue;
        if (/已售|运费|包邮|登录|选择|说明/.test(name)) continue;
        // 纯数字的规格值是真实存在的（尺码 36~45、码数 6/7/8、半码 36.5）——「纯数字一律不是规格值」
        // 会把整单的规格丢空（791436406391 报障：尺码 36~45 全是数字 → 0 个规格维度）。
        // 只挡「不像规格值的数字」：0 开头 / 小数点开头（价格拆分残留，如 0.3、.10）、超过 3 位（如 89602）。
        if (/^[\d.]+$/.test(name) && !/^[1-9]\d{0,2}(\.\d)?$/.test(name)) continue;
        if (valuePair.some(c => (code ? c.code === code : c.name === name))) continue;
        const at = m.index + m[0].indexOf(m[1]);
        valuePair.push({ name, code, stock, price, parts: splitParts(name), pos: at, label: labelBefore(lines, lineOf(at)) });
      }
    }

    // ③ 没带价格的维度：1688 常把「¥价 + 库存」只挂在**最后一个**维度上（如「颜色」12 个值一行价格都没有，
    //    下面「尺码」才有）。以有价格那一维的标签行为锚，向上把连续的值块整段收进来。
    const ordered = valuePair.slice().sort((a, b) => a.pos - b.pos);
    if (ordered.length) {
      const anchor = lineOf(ordered[0].pos);
      let labelIdx = anchor - 1;                                  // 有价格那一维的标签行
      for (let k = anchor - 1; k >= 0 && k >= anchor - 5; k--) {
        const t = clean(lines[k]);
        if (t && t === ordered[0].label) { labelIdx = k; break; }
      }
      const bare = [];
      let k = labelIdx - 1;
      for (; k >= 0 && k >= labelIdx - 40; k--) {
        const t = clean(lines[k]);
        if (!t) { k = -1; break; }                                // 空行 = 规格块边界
        if (!isBareValueLine(t)) break;                            // 撞到标签/界面文字 = 值块上界
        bare.unshift(t);
      }
      if (bare.length >= 2) {
        // 值块上面那行不一定是维度名（常夹着一行界面词，如「收藏代发」）→ 往上找 3 行内像标签的
        let lab = '';
        for (let kk = k; kk >= 0 && kk >= k - 3; kk--) {
          const t = clean(lines[kk]);
          if (!t) break;
          if (LABEL_WORD.test(t)) { lab = t; break; }
          if (t.length <= 8 && !UI_VALUE.test(t) && !isBareValueLine(t)) { lab = t; break; }
        }
        if (!lab) lab = (k >= 0 ? clean(lines[k]) : '') || '规格';
        const firstPos = offs[Math.max(0, labelIdx - bare.length)] || 0;
        bare.forEach((nm, ii) => {
          if (valuePair.some(v => v.name === nm && (v.code || null) === null)) return;
          valuePair.push({ name: nm, code: null, stock: null, price: null, parts: splitParts(nm), pos: firstPos + ii, label: lab });
        });
      }
    }

    // 按标签分组 → 维度（同名值合进同一维；标签没识别出来就沿用上一维，兜底标签「规格」）
    const dims = [];
    valuePair.sort((a, b) => a.pos - b.pos).forEach(v => {
      const label = v.label || (dims.length ? dims[dims.length - 1].label : '规格');
      let d = dims[dims.length - 1];
      if (!d || d.label !== label) { d = { label, values: [] }; dims.push(d); }
      if (d.values.some(x => x.name === v.name && (x.code || null) === (v.code || null))) return;
      d.values.push({ name: v.name, code: v.code || null, price: v.price, stock: v.stock, parts: v.parts || null });
    });
    /* 正文里常常只有「默认那几档」的值（这个商品正文只列 3 个尺码，实际 5 档）→ 用属性表/件重尺表补齐 */
    const fromTab = dimsFromTables(text);
    if (fromTab) {
      fromTab.dims.forEach(fd => {
        const names = new Set(fd.values.map(v => v.name));
        const d = dims.find(x => x.label === fd.label) ||
          dims.find(x => (x.values || []).filter(v => names.has(v.name)).length >= Math.max(2, Math.ceil((x.values || []).length / 2)));
        if (!d) { dims.push({ label: fd.label, values: fd.values.slice() }); return; }
        fd.values.forEach(v => { if (!d.values.some(x => x.name === v.name)) d.values.push(v); });
      });
      if (fromTab.minWeight != null) dims.minWeight = fromTab.minWeight;
    }

    /* 已售罄的规格值不列入（用户要求：抓取规格的时候，已售罄的规格不抓取）。
     * 判定只认页面上写明的：库存明确是 0，或者值名里带售罄/无货/缺货。
     * 库存数据本身没有（null）的一律保留 —— 页面没写清楚就不猜，宁可多列也不漏。 */
    const soldOut = [];
    dims.forEach(d => {
      d.values = d.values.filter(v => {
        const out = v.stock === 0 || /已?售罄|无货|缺货|暂无库存|已下架/.test(String(v.name || ''));
        if (out) soldOut.push(v.name);
        return !out;
      });
    });
    for (let i = dims.length - 1; i >= 0; i--) if (!dims[i].values.length) dims.splice(i, 1);   // 整维都没货 → 不列这一维
    // 组合值（【父】子）：整维都能拆开时，格子按「父规格 / 子规格」两列显示（拆的是页面原值，不交叉、不新造组合）
    dims.forEach(d => {
      if (d.values.length && d.values.every(v => v.parts)) d.partLabels = ['父规格', '子规格'];
    });
    dims.soldOut = soldOut;
    // 规格块在整页文本里的结束位置（给 pickPrices 当界线用：这之后的价格都是「同款推荐」里别的商品）
    dims.blockEnd = valuePair.reduce((mx, v) => Math.max(mx, (v.pos || 0) + String(v.name || '').length), 0);
    return dims;
  }

  /* 兼容旧入口：第一个维度（父规格）的值就是以前说的「颜色」 */
  function pickColors(text) {
    const d = pickSpecs(text);
    return d.length ? d[0].values : [];
  }

  function pickAttr(text, label) {
    const t = text.replace(/\r/g, '');
    const t1 = t.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*([^|\\n]{1,40}?)\\s*\\|`));
    if (t1) return t1[1].trim();
    const t2 = t.match(new RegExp(`${label}\\s*[:：]?\\s*([^\\s|｜,，]{1,30})`));
    return t2 ? t2[1].trim() : null;
  }

  function pickNumber(text, patterns) {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) { const v = num(m[1]); if (v !== null) return v; }
    }
    return null;
  }

  function pickImages(html) {
    if (!html) return [];
    const imgs = [];
    const re = /(https?:\/\/[^"'\s)]*(?:img\.alicdn|cbu01\.alicdn)[^"'\s)]*(?:\.jpg|\.png|\.webp)[^"'\s)]*)/gi;
    let m;
    while ((m = re.exec(html))) {
      const u = m[1].replace(/\.webp$/, '');
      if (/gg_dtc|tps-|logo|icon/i.test(u)) continue;
      if (!imgs.includes(u)) imgs.push(u);
    }
    return imgs.slice(0, 20);
  }

  /* 众数：规格区每个颜色都带同一个标价时，它就是「规格标价」 */
  function mode(nums) {
    const m = new Map();
    nums.forEach(v => m.set(v, (m.get(v) || 0) + 1));
    let best = null, bestN = 0;
    for (const [v, n] of m) {
      if (n > bestN || (n === bestN && best !== null && v > best)) { best = v; bestN = n; }
    }
    return best;
  }

  /* 统一收口：置信度、建议拿货价（默认=规格标价）、候选档位 —— parse() 与抓取器共用，避免两处逻辑跑偏 */
  function finalize(product) {
    // 推荐位/相关商品的价格混进档位里会误导人：只保留「商品主体」里出现的价位。
    // 界线由 pickPrices 算好（zoneStart = 同款推荐/猜你喜欢… 在同一个文本里的位置）
    const zoneStart = num((product.priceTiers && product.priceTiers.zoneStart));
    if (zoneStart > 0) {
      product.priceTiers = (product.priceTiers || []).filter(t => t.pos == null || t.pos < zoneStart);
    }
    product.variantsAvailable = (product.colors || []).length;
    product.confidence = {
      title: !!product.title,
      price: (product.priceTiers || []).length > 0,
      colors: (product.colors || []).length > 0,
      weight: product.weight_g !== null,
      boxQty: product.box_qty !== null
    };
    product.missing = Object.keys(product.confidence).filter(k => !product.confidence[k]);

    // 规格标价：规格弹层里每个规格值显示的价格。
    // 两种页面写法：
    //   ① 各值同一个价（最常见）→ 就是它；
    //   ② 各值价不一样（单片 2.12 / 5片装 11.5 / 10片装 23 这种打包阶梯）→ 默认取**最低**那个，
    //      也就是 1688 页面上展示的起价、单件出货的成本；每个值自己的价留在值上，
    //      定价时按各自规格的标价算（app.js 的 rowUnitCost），绝不拿众数/平均值糊上去。
    const allSpecVals = ((product.specs && product.specs.length)
      ? product.specs.reduce((a, d) => a.concat(d.values || []), [])
      : (product.colors || []));
    const colorPrices = allSpecVals.map(c => c.price).filter(p => p !== null && p > 0);
    const uniqPrices = Array.from(new Set(colorPrices)).sort((a, b) => a - b);
    const specPrice = uniqPrices.length ? uniqPrices[0] : null;
    product.specPrice = specPrice;
    product.specPriceSpread = uniqPrices.length > 1
      ? { min: uniqPrices[0], max: uniqPrices[uniqPrices.length - 1], distinct: uniqPrices.length, values: colorPrices.length }
      : null;
    product.specPriceSource = specPrice === null ? null
      : (uniqPrices.length > 1
        ? `规格标价里最低的一档（各规格标价不一：${uniqPrices[0]}~${uniqPrices[uniqPrices.length - 1]} 元，共 ${colorPrices.length} 个值）`
        : `规格标价（${colorPrices.length} 个规格值一致）`);

    /* 页面内嵌的「规格组合 → 价/库存」表（抓取时从页面 script 里读的 prod.skuInfo）。
     * 为什么必须有它：正文里只渲染**默认选中那一个组合**的价，其它颜色的价根本不出现 ——
     * 「每个规格价格不一样」的多规格商品，只按正文抓就会变成「每行同一个价」。
     * 折成两样东西（拿不到 skuInfo 时一切照旧）：
     *   ① product.skuPrices = {"值1\u0000值2": 每件价} → app.js 按一行自己的组合算成本；
     *   ② 每个规格值的 price/stock 换成它在各组合里的最优值（价取最低、库存取最大）。 */
    const skuInfo = (product.skuInfo && typeof product.skuInfo === 'object') ? product.skuInfo : null;
    if (skuInfo) {
      const SEP = '\u0000';
      const numOr = x => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x))) ? null : Number(x);
      const prices = {}, best = new Map();
      let combos = 0;
      for (const key of Object.keys(skuInfo)) {
        const rec = skuInfo[key] || {};
        const net = numOr(rec.net) != null ? numOr(rec.net) : numOr(rec.price);   // 页面价（折后）优先
        if (net == null || net <= 0) continue;
        combos++;
        prices[key] = net;
        for (const nm of String(key).split(SEP)) {
          const cur = best.get(nm) || { price: null, stock: null };
          cur.price = (cur.price == null || net < cur.price) ? net : cur.price;
          const st = numOr(rec.stock);
          if (st != null) cur.stock = (cur.stock == null) ? st : Math.max(cur.stock, st);   // 有一档有货就不算售罄
          best.set(nm, cur);
        }
      }
      if (combos) {
        product.skuPrices = prices;
        product.skuComboCount = combos;
        const applyV = v => {
          const b = best.get(v.name);
          if (!b) return;
          if (b.price != null) v.price = b.price;
          if (b.stock != null) v.stock = b.stock;
        };
        (product.specs || []).forEach(d => (d.values || []).forEach(applyV));
        (product.colors || []).forEach(applyV);
        // 组合价说明某些值其实售罄了（正文里那个价是默认组合的，看不出别的）→ 补一次过滤
        const soldNow = [];
        (product.specs || []).forEach(d => {
          d.values = (d.values || []).filter(v => {
            const out = v.stock === 0 || /已?售罄|无货|缺货|暂无库存/.test(String(v.name || ''));
            if (out) soldNow.push(v.name);
            return !out;
          });
        });
        for (let i = (product.specs || []).length - 1; i >= 0; i--) if (!(product.specs[i].values || []).length) product.specs.splice(i, 1);
        if (soldNow.length && !product.soldOut) product.soldOut = [];
        if (soldNow.length) product.soldOut = (product.soldOut || []).concat(soldNow);
        if ((product.colors || []).length && (product.specs || []).length) product.colors = product.specs[0].values.slice();
        product.variantsAvailable = (product.specs || []).length ? (product.specs[0].values || []).length : (product.colors || []).length;
      }
    }

    const rt = product.rawText || '';
    const qm = rt.match(/选择商品规格[\s\S]{0,300}?≥\s*(\d+)\s*件/) || rt.match(/≥\s*(\d+)\s*件/);
    const specQty = qm ? parseInt(qm[1], 10) : null;

    const tiers = product.priceTiers || [];
    const find = (t, withQty) => tiers.find(x => x.type === t && (!withQty || x.minQty !== null)) || null;
    const ql = (t) => t.minQty ? `（≥${t.minQty}件）` : '';
    const t1 = find('代发价', true), t2 = find('混批价', true), t3 = find('代发价'), t4 = tiers[0] || null;
    const chain = [
      specPrice !== null ? { price: specPrice, label: '规格标价' + (specQty ? `（≥${specQty}件）` : '') } : null,
      t1 ? { price: t1.price, label: '代发价' + ql(t1) } : null,
      t2 ? { price: t2.price, label: '混批价' + ql(t2) } : null,
      t3 ? { price: t3.price, label: '代发价' } : null,
      t4 ? { price: t4.price, label: t4.type } : null
    ];
    const chosen = chain.find(c => c && c.price > 0) || null;
    product.suggestedUnitCost = chosen ? chosen.price : null;
    product.suggestedUnitCostSource = chosen ? chosen.label : null;

    // 候选档位：规格标价排第一，其余按价格升序，同价只留信息量最大的那个
    const cands = [];
    if (specPrice !== null) cands.push({ price: specPrice, type: '规格标价', minQty: specQty });
    tiers.slice().sort((a, b) => a.price - b.price).forEach(t => {
      if (!cands.some(c => c.price === t.price)) cands.push({ price: t.price, type: t.type, minQty: t.minQty });
    });
    product.priceCandidates = cands;
    return product;
  }

  function parse(input, meta) {
    meta = meta || {};
    const html = /<\/(div|span|html|body|table)>/i.test(input || '') ? input : '';
    const text = toText(input);
    const flat = text.replace(/\s+/g, ' ');
    const specs = pickSpecs(text);      // 动态规格维度（可能是多级：父规格 + 子规格，标签来自页面）
    const tabWeight = (specs && specs.minWeight != null) ? specs.minWeight : null;   // 件重尺表里最轻的一档

    const product = {
      source: { url: meta.url || null, offerId: (meta.url || '').match(/offer\/(\d+)\.html/)?.[1] || null, parsedAt: new Date().toISOString() },
      skuInfo: meta.skuInfo || null,          // 页面内嵌的「规格组合 → 价/库存」表（抓取时读出来，解析时折成 skuPrices）
      title: pickTitle(text, html, meta),
      shop: (flat.match(/([\u4e00-\u9fa5]{2,20}(?:有限公司|商行|工厂|商贸|经营部|电子商务))/)?.[1]) || pickAttr(text, '店铺') || null,
      brand: pickAttr(text, '品牌'),
      category: pickAttr(text, '产品类别') || (flat.match(/产品类别\s*([\u4e00-\u9fa5]{2,10})/)?.[1] || null),
      weight_g: pickNumber(text, [
        // 件重尺表：表头一行「…重量(g)」，数值在下一行（长 宽 高 体积 重量，制表符/空格分隔）→ 取第 5 个
        /重量\s*\(?g\)?[^\n]*\r?\n(?:[\d.]+[\t ]+){4}([\d.]+)/,
        // 数值跟表头同一行的情况
        /重量\s*\(?g\)?[\t ]+(\d{1,5})(?![\d.])/,
        /重量\s*\(?g\)?[\s\S]{0,120}?\|\s*(\d+)\s*\|/,
        /重量\s*\(?g\)?[^\\d\n]{0,20}(\d{1,5})\s*(?:g|克)/i,
        /重量[^\d]{0,20}(\d+)\s*g/i]) ?? tabWeight,
      box_qty: pickNumber(text, [/箱装数量\s*\|?\s*(\d+)/, /参考装箱数[^\d]{0,20}(\d+)/, /(\d+)\s*个\s*\/?\s*箱/]),
      material: pickMaterials(text),                    // 商品材质（鞋底材质/鞋面材质/主面料成分…），逐字来自页面
      size: pickSize(text),                             // 尺寸（件重尺表的长/宽/高 + 属性行「尺寸」原文）
      bladeCount: pickNumber(text, [/剃须刀刀片\s*\|?\s*(\d+)/]),
      isImported: /是否进口\s*\|?\s*是/.test(text) ? true : (/是否进口\s*\|?\s*否/.test(text) ? false : null),
      crossBorderOnly: /是否跨境出口专供货源\s*\|?\s*是/.test(text) ? true : (/是否跨境出口专供货源\s*\|?\s*否/.test(text) ? false : null),
      hasPatent: /是否有专利\s*\|?\s*是/.test(text) ? true : (/是否有专利\s*\|?\s*否/.test(text) ? false : null),
      specs,
      soldOut: specs.soldOut || [],                     // 已售罄、没列入的规格值（页面会提示，别让它们悄悄消失）
      colors: specs.length ? specs[0].values : [],      // 兼容：父规格的值 = 以前说的「颜色」
      specLabel: specs.length ? specs[0].label : null,
      priceTiers: pickPrices(text, specs.blockEnd),
      freightNote: (flat.match(/运费\s*[¥￥]\s*\d+(?:\.\d+)?\s*起?/) || [])[0] || null,
      shipFrom: (flat.match(/([\u4e00-\u9fa5]{2,10}(?:省)?[\u4e00-\u9fa5]{2,10}市?)送至/) || [])[1] || null,
      images: pickImages(html),
      rawText: text
    };
    product.variantsAvailable = product.colors.length;
    finalize(product);
    return product;
  }

  return { parse, finalize, toText, pickColors, pickSpecs, pickPrices, pickTitle };
});
