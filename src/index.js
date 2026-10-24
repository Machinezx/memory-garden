// memory-garden —— 给 AI 机器人用的「会生长的记忆」。
//
// 把"学到的知识"做成一张张知识卡，让它们像花园里的植物一样：
//   · 新种下的卡进【临时区】，滚动迭代 —— 没人碰的最先枯掉，被碰过的按"最久没被碰"枯掉；
//   · 被【真正用上】的卡（跨天累计）会被移栽进【长期记忆区】，永不淘汰；
//   · 长期没人提起的长期记忆也不会永生 —— 比临时区整批卡还冷清时，降回临时区重新考验。
// 每一环都由"使用"说了算，这就是它的全部规则，也是它唯一的主张。
//
// 设计取舍（为什么这样写）：
//   · 纯逻辑、零依赖、不用任何 Node 内置模块 —— 存储落盘、检索实现、真实时间
//     全部由调用方注入（storage 在调用方，时间用 now 选项），因此它可以在
//     任何 JS 运行时里跑，也可以在单测里毫秒级模拟一百天；
//   · 数据形态刻意保持扁平（两张卡片数组 + 卡上的几个计数字段），JSON 进 JSON 出，
//     便于宿主把它塞进任何 KV 存储（我们的第一个使用者是 QQ 机器人插件的
//     api.storage，一个 ≤1MB 的 JSON 文件）；
//   · 不内置任何"语义向量 / embedding"—— 它管的是记忆的生命周期，不是检索算法。
//     tags 匹配是有意为之的简单方案：可解释、可预测、零成本，且便于宿主换成更强的检索。
//     ⚠️ associate 只按 tags 匹配，不读卡片正文 —— 没有 tags 的卡不会被联想命中
//     （search 不受此限，正文和标题都参与打分）。
//
// 生物学对应（设计初心，供理解，不宣称学术严格性）：
//   临时区 ≈ 海马体的短期缓冲；升格 ≈ 巩固成长时记忆；闲置降格 ≈ 提取失败导致的淡化。

/** 默认容量与阈值。全部可通过构造参数 limits 覆盖。 */
export const DEFAULT_LIMITS = {
  temporaryMax: 100,          // 临时区容量
  permanentMax: 30,           // 长期记忆区容量（满了暂停升格）
  promoteUses: 3,             // 跨天累计被用满这么多次，升格为长期记忆
  cardUseGapMs: 24 * 3600000, // 同一张卡两次"被用过"记账的最小间隔（隔天累计）
  demoteIdleDays: 45,         // 长期记忆闲置超过这么多天，进入降格体检
  demoteMinTempAgeDays: 30,   // 临时区最老一张卡达到这个年龄后，"比临时区还冷清"的比较线才启用
  demoteGraceDays: 7          // 降格重入临时区后的保护期：期间不参与淘汰（"降格≠立刻消失"）
};

/** 默认的注入式文本粗过滤：只拦祈使句式的指令劫持；对"谈论注入"的正当知识不误伤。可整体关闭或替换。 */
export const DEFAULT_INJECTION_RE =
  /忽略(?:之前|上面|以上|前面|系统|指令)|无视(?:之前|上面|以上|系统)|ignore\s+(?:all\s+)?previous|disregard|你现在是|从现在开始你是/i;

const DAY = 86400000;

function djb2(s) {
  const str = String(s ?? '');
  let h = 5381;
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export class MemoryGarden {
  /**
   * @param {object} [opts]
   * @param {object}   [opts.limits]            容量与阈值，键见 DEFAULT_LIMITS
   * @param {()=>number} [opts.now]             时间注入：返回当前毫秒（单测里可以拨快）
   * @param {(...a:any[])=>void} [opts.log]     日志注入
   * @param {(e:object)=>void} [opts.onEvent]   生命周期事件回调：
   *   { type:'added'|'rejected'|'promoted'|'evicted'|'demoted', card?, cards?, reason?, text? }
   * @param {RegExp|null} [opts.injectionRe]    卡片入库过滤正则；传 null 关闭过滤（/g 标志会被剥掉）
   * @param {number} [opts.associateThreshold]  联想触发的最低得分（默认 2）
   */
  constructor(opts = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    const checks = [
      ['temporaryMax', this.limits.temporaryMax, 1],
      ['permanentMax', this.limits.permanentMax, 0],
      ['promoteUses', this.limits.promoteUses, 1],
      ['cardUseGapMs', this.limits.cardUseGapMs, 0],
      ['demoteIdleDays', this.limits.demoteIdleDays, 1],
      ['demoteMinTempAgeDays', this.limits.demoteMinTempAgeDays, 0],
      ['demoteGraceDays', this.limits.demoteGraceDays, 0]
    ];
    for (const [name, v, min] of checks) {
      if (!Number.isFinite(v) || v < min) {
        throw new TypeError(`memory-garden：limits.${name} 必须是 ≥ ${min} 的数字（收到 ${v}）`);
      }
    }
    this.now = typeof opts.now === 'function' ? opts.now : (() => Date.now());
    this.log = opts.log || (() => {});
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    // /g 正则的 test() 会推进 lastIndex，第二次同样的内容就漏判 —— 剥掉全局标志
    if (opts.injectionRe === null) this.injectionRe = null;
    else if (opts.injectionRe instanceof RegExp) {
      this.injectionRe = opts.injectionRe.flags.includes('g')
        ? new RegExp(opts.injectionRe.source, opts.injectionRe.flags.replace(/g/g, ''))
        : opts.injectionRe;
    } else this.injectionRe = DEFAULT_INJECTION_RE;
    this.associateThreshold = Number(opts.associateThreshold ?? 2);
    this.cards = [];      // 临时区：约定 index 0 最新（load 时按 at 排序恢复这个不变量）
    this.permanent = [];  // 长期区：index 0 最新
  }

  _emit(type, detail = {}) {
    if (this.onEvent) {
      try { this.onEvent({ type, ...detail }); } catch { /* 回调出错不影响记忆本身 */ }
    }
  }

  // 主键只由"内容 + 来源链接"决定，与入库时间无关 —— 否则同一张卡隔一秒再入库就是新 id，查重形同虚设
  _idOf(text, url) {
    return `mg_${djb2(`${String(url ?? '')}|${String(text ?? '')}`)}`;
  }

  /** 按 id 或对象引用取卡（先查长期区再查临时区）。 */
  get(cardOrId) {
    if (!cardOrId) return null;
    if (typeof cardOrId === 'object') {
      return this.permanent.includes(cardOrId) || this.cards.includes(cardOrId)
        ? cardOrId
        : this.get(cardOrId.id);
    }
    return this.permanent.find((c) => c.id === cardOrId) || this.cards.find((c) => c.id === cardOrId) || null;
  }

  /** 是否为长期记忆卡。 */
  isPermanent(card) {
    return (this.permanent || []).includes(card);
  }

  /**
   * 新种下一张知识卡。会做：文本校验（≤200字）→ 注入式文本过滤 → 查重 → 入临时区 → 满员淘汰。
   * 查重按"内容+链接"判定，跨时间有效。
   * @returns {{ ok: true, card: object } | { ok: false, reason: string, duplicate?: boolean, card?: object }}
   */
  addCard({ text, tags, title, source, url } = {}) {
    const now = this.now();
    const body = String(text ?? '').trim().slice(0, 200);
    if (!body) return { ok: false, reason: 'text 为空' };
    if (this.injectionRe && this.injectionRe.test(body)) {
      this._emit('rejected', { reason: 'injection', text: body.slice(0, 60) });
      return { ok: false, reason: '疑似指令式内容（提示词注入过滤）' };
    }
    const id = this._idOf(body, url);
    const exists = this.get(id)
      || [...this.permanent, ...this.cards].find((c) => (c.url || '') === String(url ?? '') && c.text === body);
    if (exists) return { ok: false, reason: '同样的知识卡已存在', duplicate: true, card: exists };
    const cleanTags = (Array.isArray(tags) ? tags : [])
      .map((x) => String(x ?? '').trim())
      .filter((x) => x.length >= 2 && x.length <= 20)
      .slice(0, 4);
    const card = {
      id,
      at: now,
      text: body,
      tags: cleanTags,
      title: String(title ?? '').slice(0, 120),
      source: String(source ?? ''),
      url: String(url ?? ''),
      used: 0,
      lastUsedAt: 0
    };
    this.cards.unshift(card);
    this._emit('added', { card });
    const evicted = this.evict();
    if (evicted.length) this._emit('evicted', { cards: evicted });
    return { ok: true, card };
  }

  /**
   * 记一笔"这张卡被真正用上了"（联想带出、检索讲给用户听过……由调用方定义"用上"）。
   * 同一张卡 24 小时内（cardUseGapMs）只记一次 —— 升格要的是跨天累计的真实用处。
   * 临时区的卡记满 promoteUses 次自动移栽进长期记忆区。
   * @returns {{ counted: boolean, promoted: boolean }}
   */
  markUsed(card) {
    if (!card) return { counted: false, promoted: false };
    const now = this.now();
    const last = Number(card.lastUsedAt) || 0;
    if (last && now - last < this.limits.cardUseGapMs) return { counted: false, promoted: false };
    card.used = (Number(card.used) || 0) + 1;
    card.lastUsedAt = now;
    let promoted = false;
    const idx = this.cards.indexOf(card);
    if (idx >= 0 && Number(card.used) >= this.limits.promoteUses && this.permanent.length < this.limits.permanentMax) {
      this.cards.splice(idx, 1);
      this.permanent.unshift(card);
      promoted = true;
      this._emit('promoted', { card });
    }
    return { counted: true, promoted };
  }

  /**
   * 临时区超容时的淘汰（温故知新）：
   * ① 优先淘汰「从没被用过」的卡，其中按卡龄最旧的先走（新种下的卡天然安全）；
   * ② 不够才动用过的卡 —— 最久没被用过的先走（LRU）；
   * ③ 刚降格重入的卡有 demoteGraceDays 天保护期（"降格≠立刻消失"，它得先被考验）。
   * @returns {object[]} 被淘汰的卡
   */
  evict() {
    const cards = this.cards;
    if (cards.length <= this.limits.temporaryMax) return [];
    const now = this.now();
    const graceMs = this.limits.demoteGraceDays * DAY;
    const ageOf = (c) => Number(c.readmittedAt) || Number(c.at) || 0;
    const protectedCard = (c) => Number(c.readmittedAt) > 0 && now - Number(c.readmittedAt) < graceMs;
    const excess = cards.length - this.limits.temporaryMax;
    const order = [];
    for (let i = cards.length - 1; i >= 0; i -= 1) order.push(i);
    const unused = order.filter((i) => !(Number(cards[i].used) > 0) && !protectedCard(cards[i]))
      .sort((a, b) => ageOf(cards[a]) - ageOf(cards[b]));
    const used = order.filter((i) => Number(cards[i].used) > 0)
      .sort((a, b) => (Number(cards[a].lastUsedAt) || 0) - (Number(cards[b].lastUsedAt) || 0));
    const evictIdx = unused.concat(used).slice(0, excess);
    const evicted = evictIdx.map((i) => cards[i]);
    evictIdx.sort((a, b) => b - a);
    for (const i of evictIdx) cards.splice(i, 1);
    return evicted;
  }

  /**
   * 每天一次的记忆体检：长期记忆若①闲置超过 demoteIdleDays 天，且②比临时区整批卡
   * 还冷清（上次被用的时间比临时区最老一张卡的入册/重入时刻还早），降回临时区、
   * 使用次数清零重新考验。临时区最老卡不足 demoteMinTempAgeDays 天时，比较线不启用。
   * 重入的卡享受 demoteGraceDays 天淘汰保护期 —— 降格是"重新考验"，不是"立刻抹掉"。
   * @returns {object[]} 被降格的卡
   */
  checkup() {
    const perm = this.permanent;
    if (!perm.length) return [];
    const now = this.now();
    const temp = this.cards;
    const entryAt = (c) => Number(c.readmittedAt) || Number(c.at) || now;
    const tempAge = temp.length ? now - Math.min(...temp.map(entryAt)) : 0;
    const compareReady = temp.length > 0 && tempAge >= this.limits.demoteMinTempAgeDays * DAY;
    const compareLine = temp.length ? Math.min(...temp.map(entryAt)) : 0;
    const demote = [];
    for (const card of perm) {
      // lastUsedAt 缺失的卡（外部导入）用入册时间兜底，避免 now-0 恒超期导致一上来就被降格
      const last = Number(card.lastUsedAt) || Number(card.at) || 0;
      if (now - last < this.limits.demoteIdleDays * DAY) continue;   // ① 绝对底线
      if (compareReady && last > compareLine) continue;              // ② 临时区够老时：还没比它冷清
      demote.push(card);
    }
    for (const card of demote) {
      const i = perm.indexOf(card);
      if (i >= 0) perm.splice(i, 1);
      card.used = 0;
      card.lastUsedAt = 0;
      card.readmittedAt = now;      // 重入时刻：淘汰保护期的起点，也是下一次比较线的基准
      this.cards.push(card);        // 排回最旧位置：重新接受迭代考验
    }
    const evicted = this.evict();
    if (demote.length) this._emit('demoted', { cards: demote });
    if (evicted.length) this._emit('evicted', { cards: evicted });
    return demote;
  }

  /**
   * 联想：拿一条用户消息，在两区里找最相关的知识卡。
   * ⚠️ 只按 tags 匹配（长词 2 分、短词 1 分），不读卡片正文 —— 没有 tags 的卡联想不到
   * （需要正文参与时请用 search，或两路并用）。同分时长期区优先。
   * 冷却去重是"频道"问题，留给调用方。
   * @returns {{ card: object, score: number } | null}
   */
  associate(text) {
    const s = String(text ?? '');
    const cards = [...this.permanent, ...this.cards];
    if (!s || !cards.length) return null;
    let best = null;
    let bestScore = 0;
    for (const card of cards) {
      let score = 0;
      for (const tag of card.tags || []) {
        if (tag && s.includes(tag)) score += String(tag).length >= 3 ? 2 : 1;
      }
      if (score > bestScore) { bestScore = score; best = card; }
    }
    if (!best || bestScore < this.associateThreshold) return null;
    return { card: best, score: bestScore };
  }

  /**
   * 检索：按关键词查卡。tags 双向包含记 2 分，正文/标题命中记 1 分；
   * 得分相同时长期区的卡优先出场。空查询返回"最近记录"（按最近使用/入册时间排序）。
   * @returns {object[]}
   */
  search(query, { limit = 8 } = {}) {
    const q = String(query ?? '').trim();
    const pools = [this.permanent, this.cards];
    if (!q) {
      return pools.flat()
        .sort((a, b) => (Number(b.lastUsedAt) || Number(b.at) || 0) - (Number(a.lastUsedAt) || Number(a.at) || 0))
        .slice(0, Math.max(1, limit));
    }
    const scored = [];
    pools.forEach((cards, poolIdx) => {
      for (const card of cards) {
        let score = 0;
        for (const tag of card.tags || []) {
          if (tag && (q.includes(tag) || tag.includes(q))) score += 2;
        }
        if (card.text.includes(q)) score += 1;
        if (String(card.title || '').includes(q)) score += 1;
        if (score > 0) scored.push({ card, score, perm: poolIdx === 0 });
      }
    });
    scored.sort((a, b) => (b.score - a.score) || ((b.perm ? 1 : 0) - (a.perm ? 1 : 0)));
    return scored.slice(0, Math.max(1, limit)).map((x) => x.card);
  }

  /** 容量与计数概览。 */
  stats() {
    return {
      temporary: this.cards.length,
      permanent: this.permanent.length,
      limits: { ...this.limits }
    };
  }

  /** 序列化快照（卡片数组按引用返回：可直接 JSON.stringify 后落盘）。 */
  export() {
    return { cards: this.cards, permanent: this.permanent };
  }

  /**
   * 从快照恢复（或首次接入宿主的已有数据）。按 at 降序恢复"index 0 最新"的不变量，
   * 之后请用 export() 把内部数组取回并交给你的存储层。
   */
  load({ cards, permanent } = {}) {
    const clean = (arr, max) => (Array.isArray(arr) ? arr : [])
      .filter((c) => c && typeof c === 'object' && typeof c.text === 'string')
      .slice(0, max)
      .map((c) => ({
        ...c,
        id: String(c.id || '') || `mg_${djb2(`${c.url || ''}|${c.text}`)}`,
        tags: Array.isArray(c.tags) ? c.tags.map(String).slice(0, 4) : [],
        used: Number(c.used) || 0,
        lastUsedAt: Number(c.lastUsedAt) || 0
      }));
    this.cards = clean(cards, this.limits.temporaryMax)
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    this.permanent = clean(permanent, this.limits.permanentMax)
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    return this;
  }
}

export default MemoryGarden;
