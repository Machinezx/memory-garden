// memory-garden 类型定义（手写，随实现同步维护）

export interface MemoryCard {
  id: string;
  /** 入册时间（毫秒时间戳） */
  at: number;
  text: string;
  tags: string[];
  title?: string;
  source?: string;
  url?: string;
  /** 跨天累计"被用上"的次数（升格依据） */
  used?: number;
  /** 最近一次被用上的时间戳 */
  lastUsedAt?: number;
  /** 最近一次从长期记忆降回临时区的时刻（淘汰保护期与比较线的基准） */
  readmittedAt?: number;
  [key: string]: unknown;
}

export interface MemoryGardenLimits {
  temporaryMax?: number;
  permanentMax?: number;
  promoteUses?: number;
  cardUseGapMs?: number;
  demoteIdleDays?: number;
  demoteMinTempAgeDays?: number;
  demoteGraceDays?: number;
}

export type GardenEventType = 'added' | 'rejected' | 'promoted' | 'evicted' | 'demoted';

export interface GardenEvent {
  type: GardenEventType;
  card?: MemoryCard;
  cards?: MemoryCard[];
  reason?: string;
  text?: string;
}

export interface MemoryGardenOptions {
  limits?: MemoryGardenLimits;
  /** 时间注入：返回当前毫秒（测试里可拨快时钟）；默认 Date.now */
  now?: () => number;
  log?: (...args: unknown[]) => void;
  onEvent?: (e: GardenEvent) => void;
  /** 入库过滤正则；传 null 关闭；/g 标志会被自动剥掉。默认拦祈使句式指令劫持 */
  injectionRe?: RegExp | null;
  /** 联想触发的最低得分，默认 2 */
  associateThreshold?: number;
}

export interface AddCardResult {
  ok: boolean;
  card?: MemoryCard;
  reason?: string;
  duplicate?: boolean;
}

export interface Snapshot {
  cards: MemoryCard[];
  permanent: MemoryCard[];
}

export declare class MemoryGarden {
  constructor(opts?: MemoryGardenOptions);

  load(snapshot?: Partial<Snapshot>): this;
  export(): Snapshot;
  stats(): { temporary: number; permanent: number; limits: Required<MemoryGardenLimits> };

  addCard(input: { text: string; tags?: unknown[]; title?: string; source?: string; url?: string }): AddCardResult;
  markUsed(card: MemoryCard | string): { counted: boolean; promoted: boolean };

  /** 临时区超容淘汰：未用过的按卡龄最旧先走 → 用过的按 LRU；降格保护期内豁免 */
  evict(): MemoryCard[];
  /** 每日记忆体检：长期记忆闲置超限且比临时区整批卡冷清 → 降回临时区清零重考 */
  checkup(): MemoryCard[];

  /** 联想：只按 tags 匹配（≥3字 2 分、<3 字 1 分），达到阈值才返回；同分长期区优先 */
  associate(text: string): { card: MemoryCard; score: number } | null;
  /** 检索：tags 双向包含 2 分 + 正文/标题命中 1 分；同分长期区优先；空查询返回最近记录 */
  search(query: string, opts?: { limit?: number }): MemoryCard[];

  get(cardOrId: MemoryCard | string): MemoryCard | null;
  isPermanent(card: MemoryCard): boolean;
}

export declare const DEFAULT_LIMITS: Required<MemoryGardenLimits>;
export declare const DEFAULT_INJECTION_RE: RegExp;
export default MemoryGarden;
