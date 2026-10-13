/**
 * 記憶地圖的「看圖邏輯」(純函式,無 React)。
 *
 * 原則:圖上每一條線都必須對得上真實記錄 —— 寧可多顯示一個載入畫面,也不畫出沒發生過的捷徑。
 *  1. 隱藏載入畫面時,只有「進來的只有一處」或「出去的只有一處」才把前後接起來(連續多個載入畫面一路接通);
 *     同一個載入畫面被好幾條流程共用時,無法確定誰接誰,就保留它,不產生假路徑。
 *  2. 同名畫面自動補上原本的描述(AI 命名中 `-` 後面那段),再不行用模組名、最後用序號。
 *  3. 依「第一次發現的順序」由左到右排;往回走的線另外標示,從卡片下方繞回。
 */
import type { RLang } from '../report/reportText.ts';

export interface GraphPage {
  id: string;
  name: string;
  visitCount: number;
  aliases?: Record<string, number>;
  module?: string;
  transient?: boolean;
  renamed?: boolean;
  firstSeenAt?: string;
}
export interface GraphEdge {
  fromPageId: string;
  toPageId: string;
  trigger?: { kind?: string; label?: string; target?: string };
  hitCount: number;
  missCount: number;
  manual?: boolean;
  /** 隱藏載入畫面時接起來的虛擬邊(不能刪)。 */
  synthetic?: boolean;
  /** 虛擬邊經過的載入畫面名稱(說明用)。 */
  via?: string[];
}

// ───────────── 1. 隱藏載入畫面(不產生假路徑) ─────────────

export interface HideLoadingResult<P extends GraphPage, E extends GraphEdge> {
  pages: P[];
  edges: E[];
  /** 因為接到多條流程、無法安全隱藏而保留的載入畫面數。 */
  keptLoading: number;
}

export function hideLoadingScreens<P extends GraphPage, E extends GraphEdge>(pages: P[], edges: E[]): HideLoadingResult<P, E> {
  const isTr = new Set(pages.filter((p) => p.transient).map((p) => p.id));
  if (!isTr.size) return { pages, edges, keptLoading: 0 };
  const nameOf = new Map(pages.map((p) => [p.id, p.name]));

  // 載入畫面之間互相連著的,視為同一段載入過程(連通元件)。
  const comp = new Map<string, number>();
  let next = 0;
  for (const id of isTr) {
    if (comp.has(id)) continue;
    const stack = [id];
    comp.set(id, next);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of edges) {
        const other = e.fromPageId === cur ? e.toPageId : e.toPageId === cur ? e.fromPageId : null;
        if (other && isTr.has(other) && !comp.has(other)) { comp.set(other, next); stack.push(other); }
      }
    }
    next++;
  }

  const hidden = new Set<string>();
  const bridged: E[] = [];
  for (let c = 0; c < next; c++) {
    const members = new Set([...comp].filter(([, v]) => v === c).map(([k]) => k));
    const ins = edges.filter((e) => members.has(e.toPageId) && !isTr.has(e.fromPageId));
    const outs = edges.filter((e) => members.has(e.fromPageId) && !isTr.has(e.toPageId));
    const sources = new Set(ins.map((e) => e.fromPageId));
    const targets = new Set(outs.map((e) => e.toPageId));
    // 多個來源又有多個去處 = 無法確定誰接誰 → 保留這段載入畫面。
    if (sources.size > 1 && targets.size > 1) continue;
    for (const m of members) hidden.add(m);
    for (const inE of ins) {
      // 只接「在這段載入過程裡真的走得到」的去處。
      const reach = new Set([inE.toPageId]);
      const queue = [inE.toPageId];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const e of edges) {
          if (e.fromPageId === cur && members.has(e.toPageId) && !reach.has(e.toPageId)) { reach.add(e.toPageId); queue.push(e.toPageId); }
        }
      }
      for (const outE of outs) {
        if (!reach.has(outE.fromPageId) || outE.toPageId === inE.fromPageId) continue;
        const via = [...reach].filter((id) => id === inE.toPageId || id === outE.fromPageId).map((id) => nameOf.get(id) ?? id);
        bridged.push({
          ...inE,
          toPageId: outE.toPageId,
          hitCount: Math.min(inE.hitCount, outE.hitCount),
          missCount: inE.missCount,
          manual: false,
          synthetic: true,
          via,
        });
      }
    }
  }
  if (!hidden.size) return { pages, edges, keptLoading: isTr.size };
  return {
    pages: pages.filter((p) => !hidden.has(p.id)),
    edges: [...edges.filter((e) => !hidden.has(e.fromPageId) && !hidden.has(e.toPageId)), ...bridged],
    keptLoading: isTr.size - hidden.size,
  };
}

// ───────────── 2. 畫面名稱:同名自動區分 ─────────────

const SEP_RE = /\s*[-–—:：|/／>→+]\s*/;

/** 去掉狀態描述/括號/尾端數字後的名稱(與 runner 的 displayName 規則一致)。 */
export function baseName(name: string): string {
  let s = String(name ?? '').trim();
  const orig = s;
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.split(SEP_RE)[0] ?? s;
    s = s.replace(/[（(\[【「].*$/, '');
    s = s.replace(/\s*(剩|第)?\s*[\d,.]+\s*(次|步|關|关|波|k|K|m|M)?\s*$/, '');
    s = s.trim();
    if (s === before) break;
  }
  return s || orig;
}

/** AI 命名中被 baseName 去掉、但能分辨畫面的描述(「轉軸畫面-EXTRA BET 彈窗」→「EXTRA BET 彈窗」)。 */
export function descriptorOf(raw: string, base: string): string {
  let s = String(raw ?? '').trim();
  // 只有「同名 + 補充說明」的命名才有描述;換了說法(「主轉軸畫面」)不是描述。
  if (!base || !s.startsWith(base)) return '';
  s = s.slice(base.length);
  s = s.replace(/^[\s\-–—:：|/／>→+]+/, '').trim();
  // 「(教學指引)」這種只有括號的描述,去掉括號本身。
  s = s.replace(/^[（(\[【「]\s*(.*?)\s*[）)\]】」]$/, '$1').trim();
  // 純計數/序號(「第1次結果」「3/7」)不是分辨畫面的資訊。
  if (!s || /^(第\s*)?[\d\s,./]+(次|步|關|关|波)?(結果|结果)?$/.test(s)) return '';
  return s.length > 24 ? `${s.slice(0, 23)}…` : s;
}

/** 依次數排序的命名清單(次數相同時依名稱,結果穩定)。 */
function rankedAliases(p: GraphPage): string[] {
  return Object.entries(p.aliases ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([n]) => n);
}

/** AI 用過、且和顯示名「確實是不同說法」的命名(只差狀態描述/計數的不算)。 */
export function distinctAliases(p: GraphPage): string[] {
  const base = baseName(p.name);
  return rankedAliases(p).filter((n) => baseName(n) !== base && n !== p.name);
}

export interface ScreenLabel { title: string; subtitle: string }

/** 每個畫面的顯示標題 + 用來區分同名畫面的副標。 */
export function screenLabels(pages: GraphPage[], moduleName: (id: string) => string): Map<string, ScreenLabel> {
  const out = new Map<string, ScreenLabel>();
  const byName = new Map<string, GraphPage[]>();
  for (const p of pages) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  for (const [name, group] of byName) {
    if (group.length === 1) { out.set(group[0]!.id, { title: name, subtitle: '' }); continue; }
    const subs = new Map<string, string>();
    for (const p of group) {
      let sub = '';
      if (!p.renamed) {
        for (const raw of rankedAliases(p)) { sub = descriptorOf(raw, baseName(p.name)); if (sub) break; }
      }
      if (!sub && p.module) sub = moduleName(p.module);
      subs.set(p.id, sub);
    }
    // 描述仍然重複(或都沒有)時,依發現順序補序號。
    const ordered = [...group].sort((a, b) => String(a.firstSeenAt ?? '').localeCompare(String(b.firstSeenAt ?? '')));
    const count = new Map<string, number>();
    for (const p of ordered) count.set(subs.get(p.id)!, (count.get(subs.get(p.id)!) ?? 0) + 1);
    const seq = new Map<string, number>();
    for (const p of ordered) {
      const sub = subs.get(p.id)!;
      if (sub && count.get(sub) === 1) { out.set(p.id, { title: name, subtitle: sub }); continue; }
      const n = (seq.get(sub) ?? 0) + 1;
      seq.set(sub, n);
      out.set(p.id, { title: name, subtitle: sub ? `${sub} #${n}` : `#${n}` });
    }
  }
  return out;
}

/** 遊戲模組 id → 看得懂的名稱(與報告模組定義一致;未知 id 原樣顯示)。 */
const MODULES: Record<string, [string, string]> = {
  launch: ['啟動/載入', 'Launch'],
  login: ['登入', 'Login'],
  lobby: ['大廳', 'Lobby'],
  tutorial: ['新手教學', 'Tutorial'],
  gameplay: ['核心玩法', 'Gameplay'],
  result: ['結算', 'Result'],
  shop: ['商店', 'Shop'],
  settings: ['設定', 'Settings'],
  popup: ['彈窗', 'Popup'],
  character: ['角色養成', 'Character'],
  inventory: ['背包', 'Inventory'],
  quest: ['任務', 'Quest'],
  battle: ['戰鬥', 'Battle'],
  stage_select: ['關卡選擇', 'Stage Select'],
  machine_select: ['機台選擇', 'Machine Select'],
  reels: ['轉軸', 'Reels'],
  bet: ['下注', 'Bet'],
  bonus: ['免費遊戲', 'Bonus'],
  paytable: ['賠付表', 'Paytable'],
  autospin: ['自動旋轉', 'Auto Spin'],
  table_select: ['桌台選擇', 'Table Select'],
  round: ['牌局', 'Round'],
  history: ['遊戲紀錄', 'History'],
  responsible_gaming: ['負責任博弈', 'Responsible Gaming'],
  server: ['伺服器連線', 'Server'],
  social: ['社交', 'Social'],
  trade: ['交易', 'Trade'],
};
export function moduleLabel(id: string, lang: RLang): string {
  const m = MODULES[id];
  return m ? m[lang === 'zh' ? 0 : 1] : id;
}

// ───────────── 3. 線上的文字 ─────────────

const ACTIONS: Record<string, [string, string]> = {
  tap: ['點擊', 'Tap'],
  swipe: ['滑動', 'Swipe'],
  back: ['返回鍵', 'Back'],
  launch: ['重新啟動遊戲', 'Relaunch game'],
  type: ['輸入', 'Type'],
  move: ['移動', 'Move'],
  auto: ['自動切換', 'Auto'],
};

/** 一個觸發 → 一般人看得懂的動作(「點擊 PLAY」「自動切換」「重新啟動遊戲」)。 */
export function actionText(trigger: GraphEdge['trigger'], lang: RLang): string {
  const raw = trigger?.kind ?? trigger?.label ?? 'auto';
  const kind = raw === 'auto' || trigger?.label === 'auto' ? 'auto' : raw;
  const verb = ACTIONS[kind]?.[lang === 'zh' ? 0 : 1] ?? kind;
  const target = kind === 'auto' || kind === 'launch' ? '' : String(trigger?.target ?? '').trim();
  return target ? `${verb} ${target}` : verb;
}

export function isAutoEdge(e: GraphEdge): boolean {
  return (e.trigger?.kind ?? e.trigger?.label) === 'auto';
}

/** 一組同方向的邊 → 線上的文字(最多列 3 種動作,其餘以 +N 表示)。 */
export function edgeCaption(list: GraphEdge[], lang: RLang): string {
  const acts = [...new Set(list.map((x) => actionText(x.trigger, lang)).filter(Boolean))];
  const shown = acts.slice(0, 3).join(' / ') + (acts.length > 3 ? ` +${acts.length - 3}` : '');
  const hit = list.reduce((a, x) => a + x.hitCount, 0);
  const miss = list.reduce((a, x) => a + x.missCount, 0);
  const zh = lang === 'zh';
  const counts = [
    hit ? (zh ? `${hit} 次` : `×${hit}`) : '',
    miss ? (zh ? `無效 ${miss} 次` : `✗${miss}`) : '',
  ].filter(Boolean).join(' · ');
  const via = list.some((x) => x.synthetic) ? (zh ? '經載入' : 'via loading') : '';
  return [shown, counts, via].filter(Boolean).join(' · ');
}

// ───────────── 4. 排版順序 ─────────────

/**
 * 依「第一次發現」排序的畫面順序(起點永遠最前)。沒有時間的舊資料以 BFS 從起點補順序。
 * 用來決定哪些線是「往前走」(交給排版)、哪些是「往回走」(從下方繞回)。
 */
export function discoveryOrder(pages: GraphPage[], edges: GraphEdge[], rootId: string | null): Map<string, number> {
  const bfs = new Map<string, number>();
  if (rootId) {
    bfs.set(rootId, 0);
    const queue = [rootId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of edges) {
        if (e.fromPageId === cur && !bfs.has(e.toPageId)) { bfs.set(e.toPageId, bfs.get(cur)! + 1); queue.push(e.toPageId); }
      }
    }
  }
  const sorted = [...pages].sort((a, b) => {
    if (a.id === rootId) return -1;
    if (b.id === rootId) return 1;
    const ta = a.firstSeenAt ?? '';
    const tb = b.firstSeenAt ?? '';
    if (ta && tb && ta !== tb) return ta.localeCompare(tb);
    return (bfs.get(a.id) ?? 1e9) - (bfs.get(b.id) ?? 1e9) || b.visitCount - a.visitCount;
  });
  return new Map(sorted.map((p, i) => [p.id, i]));
}
