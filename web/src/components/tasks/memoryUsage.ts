/**
 * 執行軌跡的「記憶使用」(資料由 runner 的 memoryTrace 寫在每步 step.memory)。
 * 純函式:每步標籤文字 + 整場統計 + 白話結論(證明記憶有沒有在運作)。
 */
import type { RLang } from '../report/reportText.ts';

export interface MemoryBaseline {
  pages: number;
  verifiedPaths: number;
  hints: number;
  routes: number;
  navInjected: boolean;
  navTruncated?: boolean;
}
export interface StepMemory {
  baseline?: MemoryBaseline;
  screen?: 'known' | 'learned' | 'new' | 'unnamed';
  page?: { name?: string; priorVisits?: number; verifiedExits?: number; loading?: boolean };
  arrival?: { from?: string; kind?: string; target?: string; expected?: string[]; result?: 'followed' | 'diverged' | 'no_effect'; hit?: number; miss?: number; manual?: boolean };
  plan?: { kind?: string; target?: string; to?: string; hit?: number; miss?: number; manual?: boolean };
  hints?: Array<{ id?: string; text?: string; matched?: boolean }>;
  route?: Array<{ name?: string; step?: number; total?: number; branch?: boolean }>;
}

const L = {
  known: ['已知畫面', 'Known screen'],
  knownTip: ['這個畫面在本次測試開始前就已在記憶中(先前到訪 {n} 次)', 'This screen was already in memory before this run ({n} earlier visits)'],
  learned: ['本次稍早見過', 'Seen earlier this run'],
  learnedTip: ['這個畫面是本次測試才第一次記住的,不算命中舊記憶', 'First learned during this run; not a hit on earlier memory'],
  newScreen: ['新畫面', 'New screen'],
  newTip: ['記憶中沒有這個畫面,本次會把它記下來', 'Not in memory yet; it is being recorded now'],
  followed: ['記憶預測應驗', 'Memory prediction held'],
  diverged: ['與記憶不符', 'Differs from memory'],
  noEffect: ['記憶路徑這次沒反應', 'Remembered path had no effect'],
  arrivalTip: ['記憶說:在「{from}」{how} 會到「{to}」(先前 {rec})', 'Memory says: {how} on "{from}" leads to "{to}" ({rec} before)'],
  plan: ['照已驗證路徑', 'Following a verified path'],
  planTip: ['AI 這一步選的操作,正是記憶中這個畫面已驗證的路徑(先前 {rec})', 'The AI chose a path already verified on this screen ({rec} before)'],
  hints: ['套用教學 {n} 條', '{n} tester tip(s) applied'],
  route: ['路線 {r}', 'Route {r}'],
  branch: ['支線', 'branch'],
  manual: ['人工標註', 'marked by a tester'],
  rec: ['成功 {h} / 失敗 {m}', '{h} worked / {m} failed'],
  auto: ['自動切換', 'auto'],
  tap: ['點擊', 'tap'],
  swipe: ['滑動', 'swipe'],
  back: ['返回鍵', 'back'],
  launch: ['重新啟動遊戲', 'relaunch'],
  type: ['輸入', 'type'],
  move: ['移動', 'move'],
} as const;
type Key = keyof typeof L;
const tx = (k: Key, lang: RLang) => L[k][lang === 'zh' ? 0 : 1];

function how(kind: string | undefined, target: string | undefined, lang: RLang): string {
  const k = (kind && kind in L ? kind : 'auto') as Key;
  const verb = tx(k, lang);
  return target && kind !== 'auto' && kind !== 'launch' ? `${verb} ${target}` : verb;
}
function rec(x: { hit?: number; miss?: number; manual?: boolean }, lang: RLang): string {
  return x.manual ? tx('manual', lang) : tx('rec', lang).replace('{h}', String(x.hit ?? 0)).replace('{m}', String(x.miss ?? 0));
}

/** icon = InfoIcon 名稱(畫面記憶 / 新畫面 / 不符 / 已驗證路徑 / 教學 / 路線)。 */
export interface MemoryChip { text: string; tip: string; tone: 'hit' | 'info' | 'warn' | 'new'; icon: 'db' | 'sparkle' | 'alert' | 'compass' | 'pin' | 'route' }

/** 一步的記憶標籤。 */
export function memoryChips(m: StepMemory | undefined, lang: RLang): MemoryChip[] {
  if (!m) return [];
  const out: MemoryChip[] = [];
  if (m.screen === 'known') {
    out.push({ text: tx('known', lang), tip: tx('knownTip', lang).replace('{n}', String(m.page?.priorVisits ?? 0)), tone: 'hit', icon: 'db' });
  } else if (m.screen === 'learned') {
    out.push({ text: tx('learned', lang), tip: tx('learnedTip', lang), tone: 'info', icon: 'db' });
  } else if (m.screen === 'new') {
    out.push({ text: tx('newScreen', lang), tip: tx('newTip', lang), tone: 'new', icon: 'sparkle' });
  }
  if (m.arrival) {
    const a = m.arrival;
    const key: Key = a.result === 'followed' ? 'followed' : a.result === 'no_effect' ? 'noEffect' : 'diverged';
    const to = (a.expected ?? []).join(' / ');
    out.push({
      text: tx(key, lang),
      tip: tx('arrivalTip', lang).replace('{from}', a.from ?? '').replace('{how}', how(a.kind, a.target, lang)).replace('{to}', to).replace('{rec}', rec(a, lang)),
      tone: a.result === 'followed' ? 'hit' : 'warn',
      icon: a.result === 'followed' ? 'db' : 'alert',
    });
  }
  if (m.plan) {
    out.push({
      text: `${tx('plan', lang)}:${how(m.plan.kind, m.plan.target, lang)} → ${m.plan.to ?? ''}`,
      tip: tx('planTip', lang).replace('{rec}', rec(m.plan, lang)),
      tone: 'hit',
      icon: 'compass',
    });
  }
  if (m.hints?.length) {
    out.push({
      text: tx('hints', lang).replace('{n}', String(m.hints.length)),
      tip: m.hints.map((h) => `${h.matched ? '✓' : '·'} ${h.text ?? ''}`).join('\n'),
      tone: m.hints.some((h) => h.matched) ? 'hit' : 'info',
      icon: 'pin',
    });
  }
  if (m.route?.length) {
    const r = m.route.map((x) => (x.branch ? `${x.name} ${tx('branch', lang)}` : `${x.name} ${x.step}/${x.total}`)).join('、');
    out.push({ text: tx('route', lang).replace('{r}', r), tip: r, tone: 'hit', icon: 'route' });
  }
  return out;
}

export interface MemoryUsage {
  baseline: MemoryBaseline | null;
  namedSteps: number;
  knownSteps: number;
  learnedSteps: number;
  newScreens: number;
  predictions: number;
  followed: number;
  diverged: number;
  noEffect: number;
  guided: number;
  hintSteps: number;
  routeSteps: number;
}

/** 整場統計(任務進行中也能即時算)。沒有任何記憶資料(舊任務)回 null。 */
export function summarizeMemory(steps: ReadonlyArray<Record<string, unknown>>): MemoryUsage | null {
  const list = steps.map((s) => s.memory as StepMemory | undefined).filter((m): m is StepMemory => Boolean(m && typeof m === 'object'));
  if (!list.length) return null;
  const u: MemoryUsage = {
    baseline: list.find((m) => m.baseline)?.baseline ?? null,
    namedSteps: 0, knownSteps: 0, learnedSteps: 0, newScreens: 0,
    predictions: 0, followed: 0, diverged: 0, noEffect: 0, guided: 0, hintSteps: 0, routeSteps: 0,
  };
  for (const m of list) {
    if (m.screen && m.screen !== 'unnamed') u.namedSteps++;
    if (m.screen === 'known') u.knownSteps++;
    if (m.screen === 'learned') u.learnedSteps++;
    if (m.screen === 'new') u.newScreens++;
    if (m.arrival) {
      u.predictions++;
      if (m.arrival.result === 'followed') u.followed++;
      else if (m.arrival.result === 'no_effect') u.noEffect++;
      else u.diverged++;
    }
    if (m.plan) u.guided++;
    if (m.hints?.length) u.hintSteps++;
    if (m.route?.length) u.routeSteps++;
  }
  return u;
}

const V = {
  first: ['這是這個 App 第一次測試(記憶是空的):本次會建立記憶,下一次測試才會開始命中。', 'This is the first run for this app (memory is empty): this run builds memory, and the next run will start using it.'],
  notInjected: ['記憶中已有畫面,但導覽圖沒有給到 AI(背景知識過長被截掉)。AI 這次等於沒看過記憶。', 'Memory has screens, but the map was not given to the AI (background knowledge too long). The AI effectively ran without memory.'],
  working: ['記憶運作正常:AI 認得先前看過的畫面,而且記憶對「做了什麼會到哪」的預測大多應驗。', 'Memory is working: the AI recognises earlier screens, and memory mostly predicts correctly where each action leads.'],
  drift: ['記憶的預測常常不符:遊戲畫面或流程可能改版了,建議到記憶地圖檢查或清掉過時的路徑。', 'Memory predictions often miss: the game may have changed. Check the memory map and remove outdated paths.'],
  recognised: ['AI 認得先前看過的畫面;這次還沒走到可以驗證「預測」的路徑。', 'The AI recognises earlier screens; no remembered path has been tested yet in this run.'],
  waiting: ['尚未有足夠步數判斷。', 'Not enough steps yet.'],
} as const;

/** 白話結論 + 語氣(給任務頁摘要用)。 */
export function memoryVerdict(u: MemoryUsage, lang: RLang): { text: string; tone: 'hit' | 'warn' | 'info' } {
  const t = (k: keyof typeof V) => V[k][lang === 'zh' ? 0 : 1];
  const b = u.baseline;
  if (b && b.pages === 0) return { text: t('first'), tone: 'info' };
  if (b && b.pages > 0 && !b.navInjected) return { text: t('notInjected'), tone: 'warn' };
  if (u.predictions >= 3) {
    const rate = u.followed / u.predictions;
    if (rate >= 0.6) return { text: t('working'), tone: 'hit' };
    if (rate < 0.4) return { text: t('drift'), tone: 'warn' };
  }
  if (u.knownSteps > 0) return { text: t('recognised'), tone: 'hit' };
  return { text: t('waiting'), tone: 'info' };
}
