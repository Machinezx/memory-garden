# memory-garden · 记忆花园

**给 AI 机器人用的「会生长的记忆」**：把你希望机器人长期记住的知识做成一张张"知识卡"，让它们像花园里的植物一样——常用常新、荒废淡忘、真正有用的会扎根。

> **English (short)**: A tiny, zero-dependency usage-driven memory lifecycle for LLM chatbots.
> Knowledge cards live in a rotating temporary zone; cards actually used across days get
> promoted to a never-evicted long-term zone; long-term memories that nobody touches
> fade back for re-examination. Pure logic, injectable time & storage, fully testable.

---

## 为什么是「花园」

大多数机器人记忆方案只回答"记什么"。memory-garden 回答的是接下来那个更难的问题：**记下来之后，它的一生怎么过？**

它把每条知识当作一棵植物，用三个规则管理一生——这三条规则全部由"使用"驱动：

| 阶段 | 规则 | 对应的直觉 |
|---|---|---|
| 🌱 **临时区**（默认 100 张，滚动） | 满了以后：**从没被用过的卡**里最旧的先走；不够时才动用过的——**最久没被用**的先走（LRU） | 短期记忆的自然消退 |
| 🌳 **升格进长期区**（默认 30 张上限） | 一张卡被**跨天累计用满 3 次**（同一天重复命中只记一次）→ 移入长期区，永不淘汰 | 反复提取的记忆被巩固 |
| 🍂 **降格回临时区** | 长期记忆**闲置超过 45 天**、且**比临时区整批卡还冷清**（自校准比较线，见下）→ 降回去、使用次数清零、重新考验（降格后有 7 天淘汰保护期——"重新考验"，不是"立刻抹掉"） | 长期不提取的记忆也会淡化 |

**为什么长期记忆不设成"永生"**：降格规则让"巩固"始终需要新的使用证据——长期记忆如果荒废，就该回到花园里和其他植物一起竞争。这既是诚实的设计（防止笔记本被一次性热点塞满永不褪色的垃圾），也更接近真实记忆的"再巩固"。

**"自校准比较线"**（这套设计里最得意的一处）：降格的第二条件不是写死的天数，而是"它上次被用的时间，比临时区最老一张卡的入册时间还早"。临时区轮换得越快，这条线就越严——**判定标准跟着主人的使用节奏自动伸缩**。

## 安装

```bash
npm install memory-garden
```

零依赖，纯 ESM，Node ≥ 18。源码就一个文件（`src/index.js`，约 300 行，中文注释），可以直接抄进任何项目（我们自己的 QQ 机器人插件就是这么干的）。

## 快速上手

```js
import { MemoryGarden } from 'memory-garden';

// 时间可注入：单测里可以拨快时钟；生产环境用默认值即可
const garden = new MemoryGarden({
  log: console.log,
  onEvent(e) {
    // 想在卡片升格/降格/被淘汰时做点什么（比如告诉主人），在这里接
    if (e.type === 'promoted') console.log('📌 有一条知识升格为长期记忆了');
  }
});

// ① 学完东西后记卡（"记不记"由你的模型判断，库只负责一生）
garden.addCard({
  text: 'B站的推荐算法把完播率看得比点赞更重',
  tags: ['B站', '推荐算法', '完播率'],
  title: '一篇讲推荐算法的文章',
  source: 'example.com',
  url: 'https://example.com/post/1'
});

// ② 收到用户消息时先"联想"：话题相关就把旧知识递给模型
const hit = garden.associate(userMessageText);
if (hit) {
  systemNotes.push(`你之前学到过：「${hit.card.text}」（可自然引用，别生硬复述）`);
  garden.markUsed(hit.card);   // 被真正用上 → 记一笔，攒升格
}

// ③ 主人主动查："你学过什么关于XX的？" → 检索
const hits = garden.search('推荐算法');

// ④ 每天一次记忆体检（长期记忆的降格检查，纯本地比对，零模型开销）
garden.checkup();
```

完整可运行的例子见 [`examples/`](examples/)。

## 持久化

库是纯逻辑：**数据进数据出都走 `export()` / `load()`**，存哪里由你决定（JSON 文件、KV 存储、数据库都行）：

```js
// 读取
garden.load(JSON.parse(fs.readFileSync('./memory.json', 'utf8')));
// 保存（卡片数组按引用返回，可以攒批落盘）
fs.writeFileSync('./memory.json', JSON.stringify(garden.export()));
```

数据形态刻意保持扁平——两张卡片数组 + 卡上的几个计数字段。我们自己的插件把它塞进一个 1MB 上限的 JSON 文件里，100 多张卡只占几十 KB。

## 测试

时间可注入是这个库最重要的工程决定：单测里拨一下时钟，就能毫秒级模拟一百天。

```bash
npm test   # 26 个用例：升格/降格/淘汰/联想/检索/序列化/事件，全绿
```

```js
let t = 0;
const garden = new MemoryGarden({ now: () => t });
const { card } = garden.addCard({ text: '卡', tags: [] });
garden.markUsed(card); t += 86400000 + 1;
garden.markUsed(card); t += 86400000 + 1;
garden.markUsed(card);   // 三个不同的天 → 升格 📌
```

## API 一览

| 方法 | 说明 |
|---|---|
| `addCard({ text, tags, title, source, url })` | 新卡入临时区；内置提示词注入粗过滤、查重（按"内容+链接"，跨时间有效）、满员淘汰。正文超 200 字截断，id 按截断后内容计算。返回 `{ok, card}` 或 `{ok:false, reason}` |
| `markUsed(card)` | 记一次"被用上"（同卡 24h 内只记一次——升格要的是跨天累计）；临时区卡跨天攒满 `promoteUses` 次自动升格 |
| `associate(text)` | 联想：**只按 tags 匹配**（≥3 字 2 分、<3 字 1 分），凑满阈值才触发；返回 `{card, score}` 或 `null`。没有 tags 的卡联想不到——需要正文参与请用 `search` |
| `search(query, { limit })` | 检索：tags 双向包含 + 正文/标题命中打分；同分时长期区优先；空查询返回最近记录（按最近使用/入册时间排序） |
| `checkup()` | 记忆体检：长期记忆闲置 + 冷清 → 降回临时区清零重考（重入的卡有 7 天淘汰保护期）。返回被降格的卡 |
| `evict()` | 手动触发一次临时区淘汰。返回被淘汰的卡 |
| `load(snapshot)` / `export()` | 持久化进出（load 会按 at 降序恢复"最新的在前"） |
| `stats()` | `{ temporary, permanent, limits }` |
| `get(id)` / `isPermanent(card)` | 取卡 / 判断是否长期记忆 |

构造选项：`limits`（所有阈值，非法值构造时直接抛错）、`now`（时间注入）、`log`、`onEvent`（生命周期事件：`added` / `promoted` / `demoted` / `evicted` / `rejected`）、`injectionRe`（入库过滤，传 `null` 关闭，`/g` 标志自动剥离）、`associateThreshold`（联想阈值，默认 2）。

## 出身与边界

诚实交代，帮助你判断它适不适合你：

- **出身**：这是 QQ 机器人插件「自主学习（洛版）」的记忆内核——它在那台真实机器人上跑了很久，插件本身就是这个库的第一个使用者（`plugins/web-learner/` 内置了 vendored 副本）；
- **不是新发明**：分级记忆（Letta/MemGPT）、记忆管理（Mem0）、间隔重复（Anki）、ACT-R 激活模型都做过类似的事。这里的差异化是把"**用进废退的完整生命周期**"做成一个 ~300 行、零依赖、可整文件抄走的实现，规则可解释、行为可单测；
- **检索是刻意简陋的**：tags 关键词匹配，可解释且零成本。要语义检索，请把 `search` 的结果与你的向量检索做融合——库不管这件事；
- **"被用上"由你定义**：库只在 `markUsed` 被调用时记账。什么算"用上"（被模型引用？被主人点赞？）是你的产品判断。

## License

MIT
