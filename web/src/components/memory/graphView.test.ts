import { describe, expect, test } from 'vitest';
import {
  actionText,
  baseName,
  descriptorOf,
  discoveryOrder,
  distinctAliases,
  edgeCaption,
  hideLoadingScreens,
  moduleLabel,
  screenLabels,
  type GraphEdge,
  type GraphPage,
} from './graphView.ts';

/**
 * 實際案例(拉霸遊戲,2026-10 新環境):AI 命名、模組、轉場都照 structure.json 收斂後的內容,只縮短 id。
 * 真實流程:相容彈窗 →OK→ Logo 載入 → 登入 →PLAY→ 遊戲載入 → 新手任務載入 → 大廳·新手拉霸機
 *           → 大廳·機台選擇 →XING ZHAO 3→ 新手任務載入 → EXTRA BET 彈窗 →OK→ 轉軸;轉軸 →重啟→ 遊戲載入 → 轉軸。
 */
const t = (m: number) => `2026-10-12T10:${String(m).padStart(2, '0')}:00.000Z`;
const pages: GraphPage[] = [
  { id: 'start', name: '啟動登入畫面', module: 'launch', visitCount: 1, aliases: { 啟動登入畫面: 1 }, firstSeenAt: t(0) },
  { id: 'compat', name: '相容性提示彈窗', module: 'popup', visitCount: 1, aliases: { 相容性提示彈窗: 1 }, firstSeenAt: t(1) },
  { id: 'logo', name: '品牌Logo載入畫面', module: 'launch', transient: true, visitCount: 1, aliases: { 品牌Logo載入畫面: 1 }, firstSeenAt: t(2) },
  { id: 'login', name: '登入畫面', module: 'login', visitCount: 1, aliases: { 登入畫面: 1 }, firstSeenAt: t(3) },
  { id: 'gameLoad', name: '遊戲', module: 'launch', transient: true, visitCount: 2, aliases: { 遊戲載入中: 1, 載入中: 1 }, firstSeenAt: t(4) },
  { id: 'missionLoad', name: '新手任務載入畫面', module: 'launch', transient: true, visitCount: 2, aliases: { 新手任務載入畫面: 1, 機台載入中: 1 }, firstSeenAt: t(5) },
  { id: 'lobbySlot', name: '大廳', module: 'reels', visitCount: 2, aliases: { '大廳-新手拉霸機': 1, '大廳-新手拉霸機中獎演出': 1 }, firstSeenAt: t(6) },
  { id: 'lobby', name: '大廳', module: 'machine_select', visitCount: 1, aliases: { '大廳-機台選擇(教學指引)': 1 }, firstSeenAt: t(7) },
  { id: 'betPopup', name: '轉軸畫面', module: 'popup', visitCount: 1, aliases: { '轉軸畫面-EXTRA BET 彈窗': 1 }, firstSeenAt: t(8) },
  { id: 'reels', name: '轉軸畫面', module: 'reels', visitCount: 42, aliases: { 轉軸畫面: 34, '轉軸畫面-第1次結果': 1, '轉軸畫面-第2次結果': 1, '轉軸畫面-第3次結果': 1, 主轉軸畫面: 5 }, firstSeenAt: t(9) },
];
const e = (from: string, to: string, kind: string, target = ''): GraphEdge => ({
  fromPageId: from, toPageId: to, hitCount: 1, missCount: 0,
  trigger: { kind, label: kind === 'auto' ? 'auto' : `${kind} ${target}`.trim(), ...(target ? { target } : {}) },
});
const edges: GraphEdge[] = [
  e('compat', 'logo', 'tap', 'OK'),
  e('logo', 'login', 'auto'),
  e('login', 'gameLoad', 'tap', 'PLAY'),
  e('gameLoad', 'missionLoad', 'auto'),
  e('missionLoad', 'lobbySlot', 'auto'),
  e('lobbySlot', 'lobby', 'auto'),
  e('lobby', 'missionLoad', 'tap', 'XING ZHAO 3 機台'),
  e('missionLoad', 'betPopup', 'auto'),
  e('betPopup', 'reels', 'tap', 'OK'),
  e('reels', 'gameLoad', 'launch'),
  e('gameLoad', 'reels', 'auto'),
];
const pairs = (list: GraphEdge[]) => list.map((x) => `${x.fromPageId}>${x.toPageId}`);

describe('隱藏載入畫面不產生假路徑', () => {
  const r = hideLoadingScreens(pages, edges);

  test('只有單一前後關係的載入畫面被隱藏並接起來', () => {
    expect(r.pages.some((p) => p.id === 'logo')).toBe(false);
    expect(pairs(r.edges)).toContain('compat>login');
    const bridged = r.edges.find((x) => x.fromPageId === 'compat' && x.toPageId === 'login')!;
    expect(bridged.synthetic).toBe(true);
    expect(actionText(bridged.trigger, 'zh')).toBe('點擊 OK');
  });

  test('被多條流程共用的載入畫面保留,不畫出沒發生過的捷徑', () => {
    // 舊版會畫出:登入 →PLAY→ 轉軸、機台選擇 →XING ZHAO→ 新手拉霸機(都沒發生過)。
    expect(pairs(r.edges)).not.toContain('login>reels');
    expect(pairs(r.edges)).not.toContain('lobby>lobbySlot');
    expect(r.pages.some((p) => p.id === 'gameLoad')).toBe(true);
    expect(r.pages.some((p) => p.id === 'missionLoad')).toBe(true);
    expect(r.keptLoading).toBe(2);
    // 保留的載入畫面,真實的線全部還在。
    expect(pairs(r.edges)).toEqual(expect.arrayContaining(['login>gameLoad', 'gameLoad>missionLoad', 'missionLoad>lobbySlot', 'lobby>missionLoad']));
  });

  test('連續的載入畫面在可確定時一路接通', () => {
    const chain: GraphPage[] = [
      { id: 'a', name: '登入', visitCount: 1 },
      { id: 'l1', name: '遊戲載入', transient: true, visitCount: 1 },
      { id: 'l2', name: '新手任務載入', transient: true, visitCount: 1 },
      { id: 'b', name: '大廳', visitCount: 1 },
    ];
    const r2 = hideLoadingScreens(chain, [e('a', 'l1', 'tap', 'PLAY'), e('l1', 'l2', 'auto'), e('l2', 'b', 'auto')]);
    expect(r2.pages.map((p) => p.id)).toEqual(['a', 'b']);
    expect(pairs(r2.edges)).toEqual(['a>b']);
    expect(r2.edges[0]!.via).toEqual(['遊戲載入', '新手任務載入']);
    expect(edgeCaption(r2.edges, 'zh')).toBe('點擊 PLAY · 1 次 · 經載入');
  });
});

describe('同名畫面自動區分', () => {
  const labels = screenLabels(pages, (m) => moduleLabel(m, 'zh'));

  test('補上 AI 命名中能分辨畫面的描述', () => {
    expect(labels.get('betPopup')).toEqual({ title: '轉軸畫面', subtitle: 'EXTRA BET 彈窗' });
    expect(labels.get('lobbySlot')).toEqual({ title: '大廳', subtitle: '新手拉霸機' });
    expect(labels.get('lobby')).toEqual({ title: '大廳', subtitle: '機台選擇(教學指引)' });
  });

  test('沒有描述時改用遊戲模組名稱', () => {
    expect(labels.get('reels')).toEqual({ title: '轉軸畫面', subtitle: '轉軸' });
  });

  test('不重複的名稱不加副標', () => {
    expect(labels.get('login')).toEqual({ title: '登入畫面', subtitle: '' });
  });

  test('描述也相同時依發現順序補序號', () => {
    const twins: GraphPage[] = [
      { id: 'x', name: '商店', visitCount: 1, firstSeenAt: t(2) },
      { id: 'y', name: '商店', visitCount: 1, firstSeenAt: t(1) },
    ];
    const l = screenLabels(twins, (m) => m);
    expect(l.get('y')!.subtitle).toBe('#1');
    expect(l.get('x')!.subtitle).toBe('#2');
  });

  test('只差計數/結果的命名不算描述,也不算別名', () => {
    expect(descriptorOf('轉軸畫面-第1次結果', '轉軸畫面')).toBe('');
    expect(baseName('轉軸畫面(第 3 次 Spin)')).toBe('轉軸畫面');
    expect(distinctAliases(pages.find((p) => p.id === 'reels')!)).toEqual(['主轉軸畫面']);
    expect(distinctAliases(pages.find((p) => p.id === 'login')!)).toEqual([]);
  });
});

describe('線上的文字一般人看得懂', () => {
  test('動作翻成白話,重新啟動不顯示目標', () => {
    expect(actionText({ kind: 'tap', target: 'XING ZHAO 3 機台' }, 'zh')).toBe('點擊 XING ZHAO 3 機台');
    expect(actionText({ kind: 'auto', label: 'auto' }, 'zh')).toBe('自動切換');
    expect(actionText({ kind: 'launch' }, 'zh')).toBe('重新啟動遊戲');
    expect(actionText({ kind: 'tap', target: 'PLAY' }, 'en')).toBe('Tap PLAY');
  });

  test('成功與無效次數分開寫', () => {
    const list: GraphEdge[] = [{ ...e('a', 'b', 'tap', 'SPIN'), hitCount: 5, missCount: 2 }];
    expect(edgeCaption(list, 'zh')).toBe('點擊 SPIN · 5 次 · 無效 2 次');
    expect(edgeCaption(list, 'en')).toBe('Tap SPIN · ×5 · ✗2');
  });

  test('模組 id 顯示成名稱', () => {
    expect(moduleLabel('reels', 'zh')).toBe('轉軸');
    expect(moduleLabel('machine_select', 'en')).toBe('Machine Select');
    expect(moduleLabel('custom_mod', 'zh')).toBe('custom_mod');
  });
});

describe('排版依發現順序', () => {
  test('起點最前,其餘照第一次出現的時間', () => {
    const order = discoveryOrder(pages, edges, 'start');
    expect(order.get('start')).toBe(0);
    expect(order.get('compat')).toBe(1);
    expect(order.get('reels')).toBe(9);
    // 往回走的線:EXTRA BET 彈窗 → 轉軸 是往前;轉軸 → 遊戲載入 是往回。
    expect(order.get('betPopup')!).toBeLessThan(order.get('reels')!);
    expect(order.get('reels')!).toBeGreaterThan(order.get('gameLoad')!);
  });

  test('沒有時間的舊資料以從起點走的距離排序', () => {
    const old = pages.map(({ firstSeenAt: _f, ...p }) => p);
    const order = discoveryOrder(old, edges, 'compat');
    expect(order.get('compat')).toBe(0);
    expect(order.get('logo')!).toBeLessThan(order.get('login')!);
    expect(order.get('login')!).toBeLessThan(order.get('gameLoad')!);
  });
});
