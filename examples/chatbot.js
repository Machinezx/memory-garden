// 聊天机器人接入示例：展示一个真实机器人如何把 memory-garden 接进
// 「收消息 → 组装提示词 → 调模型 → 回复」的流程。
// 这份示例是伪代码骨架（收发消息的部分换成你自己的框架），记忆部分是真用法。
//
// 运行（只是演示数据流，不需要真的接机器人）：node examples/chatbot.js
import { MemoryGarden } from 'memory-garden';

// ── 持久化：存哪里随你（这里是 JSON 文件，也可是 KV/数据库）──────────────
import fs from 'node:fs';
const FILE = './my-bot-memory.json';

const garden = new MemoryGarden({
  log: console.log,
  onEvent(e) {
    if (e.type === 'promoted') console.log(`[记忆] 📌 「${e.card.text}」升格为长期记忆`);
  }
});
if (fs.existsSync(FILE)) garden.load(JSON.parse(fs.readFileSync(FILE, 'utf8')));
const persist = () => fs.writeFileSync(FILE, JSON.stringify(garden.export()));

// ── 每次收消息都会走的三个钩子 ──────────────────────────────────────────

/** ① 组装提示词时：先联想，把相关旧知识递给模型（让它学以致用）。 */
function buildSystemNotes(userText) {
  const notes = [];
  const hit = garden.associate(userText);
  if (hit) {
    notes.push(`你之前学到过：「${hit.card.text}」（来自 ${hit.card.source}）。`
      + '如果和当前话题贴合就自然带上一句，别生硬复述。');
    garden.markUsed(hit.card);   // 被真正用上 → 记一笔（库内部隔天累计，防刷）
    persist();
  }
  return notes;
}

/** ② 模型学完新东西后：让它自己判断值不值得记（你只负责解析它的 JSON）。 */
function onModelLearned(material, meta) {
  // material：模型读到的资料；meta：{ title, source, url }
  // 这里省略模型调用 —— 你把资料发给模型，让它输出 {"remember":bool,"cards":[...]}
  const parsed = JSON.parse(material);   // 示例：假设模型返回了 {"remember":true,"cards":[...]}
  if (!parsed.remember) return;
  for (const c of parsed.cards) {
    const r = garden.addCard({ text: c.text, tags: c.tags, ...meta });
    if (r.ok) console.log(`[记忆] 记下了：「${c.text}」`);
  }
  persist();
}

/** ③ 每天一次：记忆体检（长期记忆降格检查，纯本地比对）。 */
const checkupTimer = setInterval(() => {
  const demoted = garden.checkup();
  if (demoted.length) persist();
}, 24 * 3600 * 1000);
checkupTimer.unref?.();   // 演示脚本：不让这个定时器把进程挂住

// ── 下面是演示数据流 ────────────────────────────────────────────────────
onModelLearned(
  JSON.stringify({
    remember: true,
    cards: [{ text: 'B站的推荐算法把完播率看得比点赞更重', tags: ['B站', '推荐算法'] }]
  }),
  { title: '讲推荐算法的文章', source: 'example.com', url: 'https://example.com/1' }
);

const userText = '你了解B站的推荐算法吗？';
console.log('系统备注（会塞进提示词）：', buildSystemNotes(userText));
