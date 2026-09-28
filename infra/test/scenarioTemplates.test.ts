import { describe, it, expect } from 'vitest';
import { generateScenarioTemplates } from '../lambda/api/scenarioTemplates.js';
import type { MemStructure } from '../lambda/api/memoryStructure.js';

/** 建一個最小 MemStructure(只填生成邏輯會用到的欄位)。 */
function struct(partial: Partial<MemStructure>): MemStructure {
  return {
    schemaVersion: 1,
    appName: 'test',
    rootPageId: null,
    pages: {},
    edges: [],
    lastUpdatedAt: null,
    ...partial,
  };
}

function page(id: string, name: string) {
  return {
    id,
    name,
    pHash: '0'.repeat(64),
    screenshotRef: `screenshots/${id}.png`,
    knownControlLabels: [],
    visitCount: 1,
    hitCount: 1,
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
  };
}

describe('generateScenarioTemplates', () => {
  it('空地圖回空陣列', () => {
    expect(generateScenarioTemplates(struct({}))).toEqual([]);
  });

  it('線性地圖:主選單→關卡→戰鬥,生成到達各畫面的範本', () => {
    const s = struct({
      rootPageId: 'p1',
      pages: {
        p1: page('p1', '主選單'),
        p2: page('p2', '關卡選擇'),
        p3: page('p3', '戰鬥中'),
      },
      edges: [
        { fromPageId: 'p1', toPageId: 'p2', trigger: { kind: 'tap', label: '點開始' }, hitCount: 1, missCount: 0 },
        { fromPageId: 'p2', toPageId: 'p3', trigger: { kind: 'tap', label: '選第一關' }, hitCount: 1, missCount: 0 },
      ],
    });
    const tpls = generateScenarioTemplates(s);
    expect(tpls.length).toBeGreaterThan(0);
    // 應有一條到達「戰鬥中」的完整路徑(葉節點,深度最深)。
    const battle = tpls.find((t) => t.targetScreen === '戰鬥中');
    expect(battle).toBeDefined();
    // 途經畫面序列:主選單 → 關卡選擇 → 戰鬥中
    expect(battle!.steps.map((st) => st.screen)).toEqual(['主選單', '關卡選擇', '戰鬥中']);
    // 起點無操作;後續帶 edge label
    expect(battle!.steps[0]!.action).toBeNull();
    expect(battle!.steps[1]!.action).toBe('點開始');
    expect(battle!.steps[2]!.action).toBe('選第一關');
    // task 與 yaml 含目標畫面名
    expect(battle!.task).toContain('戰鬥中');
    expect(battle!.yaml).toContain('task:');
    expect(battle!.yaml).toContain('到達「戰鬥中」');
  });

  it('無 rootPageId 時以 visitCount 最高者為起點', () => {
    const s = struct({
      rootPageId: null,
      pages: {
        a: { ...page('a', '冷門頁'), visitCount: 1 },
        b: { ...page('b', '主畫面'), visitCount: 99 },
        c: page('c', '子頁'),
      },
      edges: [
        { fromPageId: 'b', toPageId: 'c', trigger: { kind: 'tap', label: '進入' }, hitCount: 1, missCount: 0 },
      ],
    });
    const tpls = generateScenarioTemplates(s);
    // 從主畫面(b)可達子頁(c)
    const t = tpls.find((x) => x.targetScreen === '子頁');
    expect(t).toBeDefined();
    expect(t!.steps[0]!.screen).toBe('主畫面');
  });

  it('跳過懸空邊與自環,不當機', () => {
    const s = struct({
      rootPageId: 'p1',
      pages: { p1: page('p1', '主選單'), p2: page('p2', '設定') },
      edges: [
        { fromPageId: 'p1', toPageId: 'p1', trigger: { kind: 'tap' }, hitCount: 1, missCount: 0 }, // 自環
        { fromPageId: 'p1', toPageId: 'ghost', trigger: { kind: 'tap' }, hitCount: 1, missCount: 0 }, // 懸空
        { fromPageId: 'p1', toPageId: 'p2', trigger: { kind: 'tap', label: '開設定' }, hitCount: 1, missCount: 0 },
      ],
    });
    const tpls = generateScenarioTemplates(s);
    expect(tpls.some((t) => t.targetScreen === '設定')).toBe(true);
  });
});
