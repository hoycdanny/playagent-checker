import type { RLang } from '../report/reportText.ts';
import { memoryChips, memoryVerdict, summarizeMemory, type StepMemory } from './memoryUsage.ts';
import { InfoIcon } from './InfoIcon.tsx';
import { pick5 } from '../../i18n/locale5.ts';
import './MemoryUsagePanel.css';

const T = {
  title: ['記憶使用', 'Memory use', '记忆使用', 'メモリの使用状況', '메모리 사용 현황'],
  baseline: ['本次開始時可用記憶', 'Memory available at start', '本次开始时可用记忆', '開始時に利用可能なメモリ', '시작 시점에 사용 가능한 기억'],
  pages: ['已知畫面 {n}', '{n} known screens', '已知画面 {n}', '既知の画面 {n}', '알려진 화면 {n}개'],
  paths: ['已驗證路徑 {n}', '{n} verified paths', '已验证路径 {n}', '検証済みの経路 {n}', '검증된 경로 {n}개'],
  hints: ['教學 {n}', '{n} tips', '教学 {n}', 'ヒント {n}', '가르침 {n}개'],
  routes: ['路線 {n}', '{n} routes', '路线 {n}', 'ルート {n}', '경로 {n}개'],
  injected: ['導覽圖已給 AI', 'Map given to AI', '导览图已给 AI', 'マップを AI に提供済み', '지도를 AI에 제공함'],
  notInjected: ['導覽圖未給 AI', 'Map NOT given to AI', '导览图未给 AI', 'マップを AI に未提供', '지도를 AI에 제공하지 않음'],
  known: ['認得的畫面', 'Recognised screens', '认得的画面', '認識した画面', '알아본 화면'],
  knownSub: ['{a} / {b} 步', '{a} / {b} steps', '{a} / {b} 步', '{a} / {b} ステップ', '{a} / {b}단계'],
  predict: ['記憶預測應驗', 'Memory predictions held', '记忆预测应验', 'メモリの予測が的中', '기억의 예측 적중'],
  predictSub: ['{a} / {b} 次', '{a} / {b}', '{a} / {b} 次', '{a} / {b} 回', '{a} / {b}회'],
  predictTip: ['上一步的操作,記憶中有「做了會到哪」的已驗證路徑時,實際有沒有到那裡。這是記憶正確的直接證據。', 'When memory had a verified result for the previous action, did the game actually go there? Direct evidence that memory is correct.', '上一步的操作,记忆中有「做了会到哪」的已验证路径时,实际有没有到那里。这是记忆正确的直接证据。', '直前の操作について、メモリに「実行するとどこへ行くか」の検証済み結果があった場合、実際にそこへ遷移したか。メモリが正しいことの直接的な証拠です。', '직전 동작에 대해 기억에 \'실행하면 어디로 가는지\' 검증된 결과가 있었을 때 실제로 그곳으로 이동했는지입니다. 기억이 정확하다는 직접적인 증거입니다.'],
  guided: ['照已驗證路徑操作', 'Actions on verified paths', '照已验证路径操作', '検証済みの経路での操作', '검증된 경로로 수행한 동작'],
  guidedTip: ['AI 選的操作正是記憶中已驗證的路徑。證明 AI 有在用記憶。', 'The AI picked a path memory had already verified, showing it uses memory.', 'AI 选的操作正是记忆中已验证的路径。证明 AI 有在用记忆。', 'AI が選んだ操作がメモリで検証済みの経路そのものだった回数。AI がメモリを使っている証拠です。', 'AI가 고른 동작이 기억에서 검증된 경로 그대로였던 횟수입니다. AI가 기억을 활용한다는 증거입니다.'],
  tipsUsed: ['教學提醒', 'Tip reminders', '教学提醒', 'ヒントのリマインド', '가르침 알림'],
  stepsSub: ['{n} 步', '{n} steps', '{n} 步', '{n} ステップ', '{n}단계'],
  newScreens: ['新發現畫面', 'New screens found', '新发现画面', '新たに見つかった画面', '새로 발견한 화면'],
} as const;
const t = (k: keyof typeof T, lang: RLang) => pick5(T[k], lang);
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

/** 執行軌跡上方的整場記憶摘要(舊任務沒有記憶資料時不顯示)。 */
export function MemoryUsagePanel({ steps, lang }: { steps: ReadonlyArray<Record<string, unknown>>; lang: RLang }) {
  const u = summarizeMemory(steps);
  if (!u) return null;
  const v = memoryVerdict(u, lang);
  const b = u.baseline;
  return (
    <section className="memuse" aria-label={t('title', lang)}>
      <div className="memuse__head">
        <h3 className="memuse__title"><InfoIcon name="db" size={15} className="memuse__ico" /> {t('title', lang)}</h3>
        {b && (
          <span className="memuse__baseline">
            {t('baseline', lang)}:{t('pages', lang).replace('{n}', String(b.pages))} · {t('paths', lang).replace('{n}', String(b.verifiedPaths))}
            {' · '}{t('hints', lang).replace('{n}', String(b.hints))} · {t('routes', lang).replace('{n}', String(b.routes))}
            {b.pages > 0 && (
              <span className={`memuse__flag ${b.navInjected ? 'is-hit' : 'is-warn'}`}>
                {b.navInjected ? `✓ ${t('injected', lang)}` : `✕ ${t('notInjected', lang)}`}
              </span>
            )}
          </span>
        )}
      </div>
      <p className={`memuse__verdict is-${v.tone}`} role="status">{v.text}</p>
      <dl className="memuse__stats">
        <div><dt>{t('known', lang)}</dt><dd>{pct(u.knownSteps, u.namedSteps)}<small>{t('knownSub', lang).replace('{a}', String(u.knownSteps)).replace('{b}', String(u.namedSteps))}</small></dd></div>
        <div title={t('predictTip', lang)}><dt>{t('predict', lang)}</dt><dd>{pct(u.followed, u.predictions)}<small>{t('predictSub', lang).replace('{a}', String(u.followed)).replace('{b}', String(u.predictions))}</small></dd></div>
        <div title={t('guidedTip', lang)}><dt>{t('guided', lang)}</dt><dd>{u.guided}</dd></div>
        <div><dt>{t('tipsUsed', lang)}</dt><dd>{u.hintSteps}<small>{t('stepsSub', lang).replace('{n}', String(u.hintSteps))}</small></dd></div>
        <div><dt>{t('newScreens', lang)}</dt><dd>{u.newScreens}</dd></div>
      </dl>
    </section>
  );
}

/** 單一步驟的記憶標籤列。 */
export function StepMemoryChips({ memory, lang }: { memory: unknown; lang: RLang }) {
  const chips = memoryChips(memory as StepMemory | undefined, lang);
  if (!chips.length) return null;
  return (
    <div className="memuse__chips">
      {chips.map((c, i) => (
        <span key={i} className={`memuse__chip is-${c.tone}`} title={c.tip}><InfoIcon name={c.icon} size={12} className="memuse__ico" />{c.text}</span>
      ))}
    </div>
  );
}
