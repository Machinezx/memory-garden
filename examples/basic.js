// 基础示例：用假时间走完一张知识卡的一生（种下 → 常用 → 升格 → 荒废 → 降格）。
// 运行：node examples/basic.js
import { MemoryGarden } from 'memory-garden';

const DAY = 86400000;
let t = Date.now();

const garden = new MemoryGarden({
  now: () => t,   // 时间可注入：生产环境省略此选项即可
  onEvent(e) {
    if (e.type === 'promoted') console.log(`📌 「${e.card.text}」升格为长期记忆（累计被用 ${e.card.used} 次）`);
    if (e.type === 'demoted') console.log(`🍂 长期记忆「${e.cards.map((c) => c.text).join('、')}」久未提起，降回临时区重考`);
    if (e.type === 'evicted') console.log(`✂️ 淘汰了 ${e.cards.length} 张最冷的卡`);
  }
});

// 第 1 天：记下一条知识
const { card } = garden.addCard({
  text: 'B站的推荐算法把完播率看得比点赞更重',
  tags: ['B站', '推荐算法', '完播率'],
  title: '讲推荐算法的文章',
  source: 'example.com',
  url: 'https://example.com/post/1'
});

// 第 1、2、3 天：主人聊到相关话题，联想命中、真正被用上
for (let day = 0; day < 3; day += 1) {
  const hit = garden.associate('你说B站的推荐算法是怎么回事？');
  if (hit) {
    console.log(`第 ${day + 1} 天：联想到「${hit.card.text}」（得分 ${hit.score}）`);
    garden.markUsed(hit.card);
  }
  t += DAY;
}

// 第 4 天：它已经是长期记忆了
console.log('第 4 天：', garden.isPermanent(card) ? '📌 它在长期记忆区' : '还在临时区');

// 三个月后：没人再提起这个话题……
t += 90 * DAY;
garden.checkup();
console.log('体检后：', garden.isPermanent(card) ? '仍留在长期区' : '已降回临时区，重新接受考验');
