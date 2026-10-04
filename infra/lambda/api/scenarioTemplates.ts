/**
 * 場景範本生成 —— 從記憶地圖(structure.json)的可達路徑,推導出「測試場景範本」。
 *
 * 對應 9 步流程步驟 4:探索建出記憶地圖後,依地圖上「從起始畫面可達的路徑」自動產生
 * 一批測試場景範本供使用者挑選(再進步驟 5 用 AI/自然語言編修成正式案例)。
 *
 * 演算法:以 rootPageId 為起點做 BFS,對每個「值得測」的目標畫面產生一條最短路徑範本:
 *  - 目標畫面 = 葉節點(無出邊)或距起點較遠(有語意深度)的畫面。
 *  - 每條路徑轉成:途經畫面序列 + 對應操作(edge trigger label)+ 一句 task 目標 + 可執行 YAML 草稿。
 * 純函式,無 I/O,方便單元測試。
 */

import type { MemStructure } from './memoryStructure.js';

export interface ScenarioStep {
  /** 目標畫面名稱。 */
  screen: string;
  /** 到達此畫面所做的操作(來自 edge 的 trigger label;起點為 null)。 */
  action: string | null;
}

export interface ScenarioTemplate {
  /** 穩定 id(依目標 pageId,方便前端 key 與去重)。 */
  id: string;
  /** 範本標題(人可讀)。 */
  title: string;
  /** 目標畫面名稱(路徑終點)。 */
  targetScreen: string;
  /** 途經畫面 → 操作序列。 */
  steps: ScenarioStep[];
  /** 一句話測試目標(供 agent 執行的 task)。 */
  task: string;
  /** 可執行 YAML 草稿(name + task + 途經畫面註解)。 */
  yaml: string;
}

/** 每次最多產生的範本數(避免地圖大時範本爆量)。 */
const MAX_TEMPLATES = 12;
/** 單條路徑最多途經畫面數(過長的路徑不利於當測試案例)。 */
const MAX_PATH_LEN = 8;

/** 畫面名正規化(去除多餘空白)。 */
function cleanName(name: string | undefined): string {
  return (name ?? '').trim() || '未命名畫面';
}

/**
 * 從記憶地圖生成場景範本。無 rootPageId 或無 pages 時回空陣列。
 */
export function generateScenarioTemplates(structure: MemStructure): ScenarioTemplate[] {
  const pages = structure.pages ?? {};
  const pageIds = Object.keys(pages);
  if (pageIds.length === 0) return [];

  // 起點:優先 rootPageId;無則挑 visitCount 最高者當起點(通常是主畫面)。
  let root = structure.rootPageId;
  if (!root || !pages[root]) {
    root =
      pageIds
        .map((id) => pages[id]!)
        .sort((a, b) => (b.visitCount ?? 0) - (a.visitCount ?? 0))[0]?.id ?? null;
  }
  if (!root) return [];

  // 建鄰接表:fromPageId → [{ toPageId, label }]。
  const adj = new Map<string, Array<{ to: string; label: string }>>();
  const outDegree = new Map<string, number>();
  for (const e of structure.edges ?? []) {
    if (!pages[e.fromPageId] || !pages[e.toPageId]) continue; // 跳過懸空邊
    if (e.fromPageId === e.toPageId) continue; // 跳過自環
    if ((e.missCount ?? 0) > (e.hitCount ?? 0)) continue; // 不可靠路徑不拿來產範本
    if (!adj.has(e.fromPageId)) adj.set(e.fromPageId, []);
    const rawLabel = (e.trigger?.label ?? '').trim();
    adj.get(e.fromPageId)!.push({ to: e.toPageId, label: rawLabel === 'auto' ? '等待自動轉場' : rawLabel });
    outDegree.set(e.fromPageId, (outDegree.get(e.fromPageId) ?? 0) + 1);
  }

  // BFS 求 root 到每個可達畫面的最短路徑(記錄 parent 與到達操作)。
  const parent = new Map<string, { from: string; label: string } | null>();
  parent.set(root, null);
  const order: string[] = [];
  const queue: string[] = [root];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const { to, label } of adj.get(cur) ?? []) {
      if (!parent.has(to)) {
        parent.set(to, { from: cur, label });
        queue.push(to);
      }
    }
  }

  /** 回溯 root→target 的路徑(page id 序列)。 */
  const pathTo = (target: string): string[] => {
    const rev: string[] = [];
    let cur: string | undefined = target;
    let guard = 0;
    while (cur && guard++ < MAX_PATH_LEN + 2) {
      rev.push(cur);
      const p = parent.get(cur);
      if (!p) break;
      cur = p.from;
    }
    return rev.reverse();
  };

  // 選「目標畫面」:可達、非 root、且是葉節點(無出邊)或路徑最深的畫面。
  // 以「路徑長度」由深到淺排序,取前 MAX_TEMPLATES,讓範本涵蓋較完整的流程。
  const candidates = order
    .filter((id) => id !== root && !pages[id]?.transient) // 載入/過場畫面不當測試目標
    .map((id) => ({ id, depth: pathTo(id).length, isLeaf: (outDegree.get(id) ?? 0) === 0 }))
    .filter((c) => c.depth <= MAX_PATH_LEN)
    // 葉節點優先(完整流程終點),其次深度較深者。
    .sort((a, b) => (Number(b.isLeaf) - Number(a.isLeaf)) || (b.depth - a.depth));

  const templates: ScenarioTemplate[] = [];
  const seenPathKey = new Set<string>();
  for (const c of candidates) {
    if (templates.length >= MAX_TEMPLATES) break;
    const path = pathTo(c.id);
    if (path.length < 2) continue; // 至少 root→1 步才有意義
    // 去重:相同途經畫面序列只留一條。
    const key = path.join('>');
    if (seenPathKey.has(key)) continue;
    seenPathKey.add(key);

    const steps: ScenarioStep[] = path.map((pid, idx) => {
      const screen = cleanName(pages[pid]?.name);
      if (idx === 0) return { screen, action: null };
      const label = parent.get(pid)?.label ?? '';
      return { screen, action: label || '前往下一畫面' };
    });

    const targetScreen = cleanName(pages[c.id]?.name);
    const viaScreens = steps.slice(1, -1).map((s) => s.screen);
    const viaText = viaScreens.length > 0 ? `(途經:${viaScreens.join(' → ')})` : '';
    const task = `從起始畫面出發,操作進入「${targetScreen}」${viaText},並驗證該畫面可正常到達與顯示。`;

    // YAML 草稿:name + task + 途經畫面/操作註解(供步驟 5 AI 編修的起點)。
    const stepLines = steps
      .map((s, i) =>
        i === 0
          ? `#   ${i + 1}. 起點:${s.screen}`
          : `#   ${i + 1}. ${s.action} → ${s.screen}`,
      )
      .join('\n');
    const yaml =
      `name: 到達「${targetScreen}」\n` +
      `task: ${task}\n` +
      `# 由記憶地圖自動生成的場景範本,建議路徑:\n${stepLines}\n`;

    templates.push({
      id: `tpl-${c.id}`,
      title: `到達「${targetScreen}」`,
      targetScreen,
      steps,
      task,
      yaml,
    });
  }

  return templates;
}
