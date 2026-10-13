import type { RLang } from '../report/reportText.ts';
import { memoryChips, memoryVerdict, summarizeMemory, type StepMemory } from './memoryUsage.ts';
import './MemoryUsagePanel.css';

const T = {
  title: ['記憶使用', 'Memory use'],
  baseline: ['本次開始時可用記憶', 'Memory available at start'],
  pages: ['已知畫面 {n}', '{n} known screens'],
  paths: ['已驗證路徑 {n}', '{n} verified paths'],
  hints: ['教學 {n}', '{n} tips'],
  routes: ['路線 {n}', '{n} routes'],
  injected: ['導覽圖已給 AI', 'Map given to AI'],
  notInjected: ['導覽圖未給 AI', 'Map NOT given to AI'],
  known: ['認得的畫面', 'Recognised screens'],
  knownSub: ['{a} / {b} 步', '{a} / {b} steps'],
  predict: ['記憶預測應驗', 'Memory predictions held'],
  predictSub: ['{a} / {b} 次', '{a} / {b}'],
  predictTip: ['上一步的操作,記憶中有「做了會到哪」的已驗證路徑時,實際有沒有到那裡。這是記憶正確的直接證據。', 'When memory had a verified result for the previous action, did the game actually go there? Direct evidence that memory is correct.'],
  guided: ['照已驗證路徑操作', 'Actions on verified paths'],
  guidedTip: ['AI 選的操作正是記憶中已驗證的路徑。證明 AI 有在用記憶。', 'The AI picked a path memory had already verified, showing it uses memory.'],
  tipsUsed: ['教學提醒', 'Tip reminders'],
  stepsSub: ['{n} 步', '{n} steps'],
  newScreens: ['新發現畫面', 'New screens found'],
} as const;
const t = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];
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
        <h3 className="memuse__title">🧠 {t('title', lang)}</h3>
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
        <span key={i} className={`memuse__chip is-${c.tone}`} title={c.tip}>{c.text}</span>
      ))}
    </div>
  );
}
