/**
 * 執行軌跡的「記憶使用」(資料由 runner 的 memoryTrace 寫在每步 step.memory)。
 * 純函式:每步標籤文字 + 整場統計 + 白話結論(證明記憶有沒有在運作)。
 */
import type { RLang } from '../report/reportText.ts';
import { listSep, pick5 } from '../../i18n/locale5.ts';

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
  known: ['已知畫面', 'Known screen', '已知画面', '既知の画面', '알려진 화면'],
  knownTip: ['這個畫面在本次測試開始前就已在記憶中(先前到訪 {n} 次)', 'This screen was already in memory before this run ({n} earlier visits)', '这个画面在本次测试开始前就已在记忆中(先前到访 {n} 次)', 'この画面は今回のテスト開始前からメモリにありました(過去の訪問 {n} 回)', '이 화면은 이번 테스트 시작 전부터 메모리에 있었습니다(이전 방문 {n}회)'],
  learned: ['本次稍早見過', 'Seen earlier this run', '本次稍早见过', '今回、先ほど確認済み', '이번에 앞서 확인됨'],
  learnedTip: ['這個畫面是本次測試才第一次記住的,不算命中舊記憶', 'First learned during this run; not a hit on earlier memory', '这个画面是本次测试才第一次记住的,不算命中旧记忆', 'この画面は今回のテストで初めて記憶されたため、過去のメモリへの一致には数えません', '이 화면은 이번 테스트에서 처음 기억된 것이므로 기존 기억에 대한 적중으로 세지 않습니다'],
  newScreen: ['新畫面', 'New screen', '新画面', '新しい画面', '새 화면'],
  newTip: ['記憶中沒有這個畫面,本次會把它記下來', 'Not in memory yet; it is being recorded now', '记忆中没有这个画面,本次会把它记下来', 'メモリにまだない画面のため、今回記録します', '아직 기억에 없는 화면이라 이번에 기록합니다'],
  followed: ['記憶預測應驗', 'Memory prediction held', '记忆预测应验', 'メモリの予測どおり', '기억의 예측 적중'],
  diverged: ['與記憶不符', 'Differs from memory', '与记忆不符', 'メモリと不一致', '기억과 불일치'],
  noEffect: ['記憶路徑這次沒反應', 'Remembered path had no effect', '记忆路径这次没反应', '記憶したルートで反応なし', '기억한 경로에서 반응 없음'],
  arrivalTip: ['記憶說:在「{from}」{how} 會到「{to}」(先前 {rec})', 'Memory says: {how} on "{from}" leads to "{to}" ({rec} before)', '记忆说:在「{from}」{how} 会到「{to}」(先前 {rec})', 'メモリ:「{from}」で {how} すると「{to}」に遷移(過去 {rec})', '기억: \'{from}\'에서 {how} 하면 \'{to}\'(으)로 이동(이전 {rec})'],
  plan: ['照已驗證路徑', 'Following a verified path', '照已验证路径', '検証済みの経路に従う', '검증된 경로를 따름'],
  planTip: ['AI 這一步選的操作,正是記憶中這個畫面已驗證的路徑(先前 {rec})', 'The AI chose a path already verified on this screen ({rec} before)', 'AI 这一步选的操作,正是记忆中这个画面已验证的路径(先前 {rec})', 'AI がこのステップで選んだ操作は、この画面でメモリにある検証済みの経路そのものです(過去 {rec})', 'AI가 이 단계에서 고른 동작은 이 화면에서 기억에 있는 검증된 경로 그대로입니다(이전 {rec})'],
  hints: ['套用教學 {n} 條', '{n} tester tip(s) applied', '套用教学 {n} 条', 'ヒントを {n} 件適用', '가르침 {n}개 적용'],
  route: ['路線 {r}', 'Route {r}', '路线 {r}', 'ルート {r}', '경로 {r}'],
  branch: ['支線', 'branch', '支线', '分岐', '분기'],
  manual: ['人工標註', 'marked by a tester', '人工标注', 'テスターが手動で付与', '테스터가 수동 표시'],
  rec: ['成功 {h} / 失敗 {m}', '{h} worked / {m} failed', '成功 {h} / 失败 {m}', '成功 {h} / 失敗 {m}', '성공 {h} / 실패 {m}'],
  auto: ['自動切換', 'auto', '自动切换', '自動切替', '자동'],
  tap: ['點擊', 'tap', '点击', 'タップ', '탭'],
  swipe: ['滑動', 'swipe', '滑动', 'スワイプ', '스와이프'],
  back: ['返回鍵', 'back', '返回键', '戻るキー', '뒤로 키'],
  launch: ['重新啟動遊戲', 'relaunch', '重新启动游戏', 'ゲームを再起動', '게임 재시작'],
  type: ['輸入', 'type', '输入', '入力', '입력'],
  move: ['移動', 'move', '移动', '移動', '이동'],
} as const;
type Key = keyof typeof L;
const tx = (k: Key, lang: RLang) => pick5(L[k], lang);

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
    const r = m.route.map((x) => (x.branch ? `${x.name} ${tx('branch', lang)}` : `${x.name} ${x.step}/${x.total}`)).join(listSep(lang));
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
  first: ['這是這個 App 第一次測試(記憶是空的):本次會建立記憶,下一次測試才會開始命中。', 'This is the first run for this app (memory is empty): this run builds memory, and the next run will start using it.', '这是这个 App 第一次测试(记忆是空的):本次会创建记忆,下一次测试才会开始命中。', 'このアプリでの初回テストです(メモリが空)。今回のテストでメモリを作成し、次回のテストから一致が始まります。', '이 앱의 첫 테스트입니다(기억이 비어 있음). 이번 테스트에서 기억을 만들고, 다음 테스트부터 적중이 시작됩니다.'],
  notInjected: ['記憶中已有畫面,但導覽圖沒有給到 AI(背景知識過長被截掉)。AI 這次等於沒看過記憶。', 'Memory has screens, but the map was not given to the AI (background knowledge too long). The AI effectively ran without memory.', '记忆中已有画面,但导览图没有给到 AI(背景知识过长被截掉)。AI 这次等于没看过记忆。', 'メモリに画面はありますが、マップが AI に渡されていません(背景知識が長すぎて切り捨てられた)。今回の AI は実質メモリを見ていません。', '기억에 화면은 있지만 지도가 AI에게 전달되지 않았습니다(배경 지식이 너무 길어 잘림). 이번 AI는 사실상 기억을 보지 못했습니다.'],
  working: ['記憶運作正常:AI 認得先前看過的畫面,而且記憶對「做了什麼會到哪」的預測大多應驗。', 'Memory is working: the AI recognises earlier screens, and memory mostly predicts correctly where each action leads.', '记忆运作正常:AI 认得先前看过的画面,而且记忆对「做了什么会到哪」的预测大多应验。', 'メモリは正常に機能しています。AI は過去に見た画面を認識し、「何をするとどこへ行くか」というメモリの予測の大半が的中しています。', '기억이 정상적으로 작동하고 있습니다. AI가 이전에 본 화면을 알아보며, \'무엇을 하면 어디로 가는지\'에 대한 기억의 예측이 대부분 적중합니다.'],
  drift: ['記憶的預測常常不符:遊戲畫面或流程可能改版了,建議到記憶地圖檢查或清掉過時的路徑。', 'Memory predictions often miss: the game may have changed. Check the memory map and remove outdated paths.', '记忆的预测常常不符:游戏画面或流程可能改版了,建议到记忆地图检查或清掉过时的路径。', 'メモリの予測が頻繁に外れています。ゲームの画面やフローが変更された可能性があります。メモリマップを確認するか、古い経路を削除してください。', '기억의 예측이 자주 빗나갑니다. 게임 화면이나 흐름이 개편되었을 수 있습니다. 기억 지도를 확인하거나 오래된 경로를 지우세요.'],
  recognised: ['AI 認得先前看過的畫面;這次還沒走到可以驗證「預測」的路徑。', 'The AI recognises earlier screens; no remembered path has been tested yet in this run.', 'AI 认得先前看过的画面;这次还没走到可以验证「预测」的路径。', 'AI は過去に見た画面を認識しています。今回は「予測」を検証できる経路にまだ到達していません。', 'AI가 이전에 본 화면을 알아보고 있습니다. 이번에는 \'예측\'을 검증할 수 있는 경로에 아직 도달하지 못했습니다.'],
  waiting: ['尚未有足夠步數判斷。', 'Not enough steps yet.', '尚未有足够步数判断。', '判断に十分なステップ数がまだありません。', '판단하기에 단계 수가 아직 충분하지 않습니다.'],
} as const;

/** 白話結論 + 語氣(給任務頁摘要用)。 */
export function memoryVerdict(u: MemoryUsage, lang: RLang): { text: string; tone: 'hit' | 'warn' | 'info' } {
  const t = (k: keyof typeof V) => pick5(V[k], lang);
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
