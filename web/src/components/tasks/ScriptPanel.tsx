import { useEffect, useMemo, useState } from 'react';
import type { ScriptProgress } from '../../api/useJobStream.ts';
import type { RLang } from '../report/reportText.ts';
import { parseScript } from './scriptSteps.ts';
import { pick5 } from '../../i18n/locale5.ts';

const T = {
  title: ['測試腳本', 'Test script', '测试脚本', 'テストスクリプト', '테스트 스크립트'],
  steps: ['{n} 個步驟', '{n} steps', '{n} 个步骤', '{n} ステップ', '{n}단계'],
  progress: ['已完成 {d}/{n}', '{d}/{n} done', '已完成 {d}/{n}', '完了 {d}/{n}', '완료 {d}/{n}'],
  empty: ['這次測試沒有指定腳本(自主探索)。', 'No script for this run (free exploration).', '这次测试没有指定脚本(自主探索)。', 'このテストにはスクリプトが指定されていません(自由探索)。', '이번 테스트에는 스크립트가 지정되지 않았습니다(자유 탐색).'],
  show: ['展開', 'Show', '展开', '表示', '펼치기'],
  hide: ['收合', 'Hide', '收合', '閉じる', '접기'],
  version: ['版本', 'Version', '版本', 'バージョン', '버전'],
  done: ['已完成', 'Done', '已完成', '完了', '완료'],
  current: ['進行中', 'In progress', '进行中', '進行中', '진행 중'],
  pending: ['未開始', 'Not started', '未开始', '未開始', '시작 전'],
  stopped: ['停在這一步', 'Stopped here', '停在这一步', 'ここで停止', '여기서 멈춤'],
  progressHint: ['打勾依決策 Agent 回報的腳本進度,測試通過時全部打勾。', 'Ticks follow the script progress reported by the Decision Agent; all are ticked when the test passes.', '打勾依决策 Agent 回报的脚本进度,测试通过时全部打勾。', 'チェックは判断エージェントが報告したスクリプトの進捗に従い、テスト合格時にはすべてチェックされます。', '체크 표시는 판단 에이전트가 보고한 스크립트 진행에 따르며, 테스트가 통과하면 모두 체크됩니다.'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => pick5(T[k], lang);

export type ItemState = 'done' | 'current' | 'stopped' | 'pending';

/** 第 i 項(0 起)的狀態:前 done 項完成;執行中標「進行中」,結束但沒完成標「停在這一步」。 */
export function itemState(i: number, progress: ScriptProgress, live: boolean): ItemState {
  if (i < progress.done) return 'done';
  if (i === progress.current - 1) return live ? 'current' : 'stopped';
  return 'pending';
}

/**
 * 測試腳本:把案例 task 原文轉成編號條列,一眼看懂這次要測什麼。
 * 有 progress(runner 即時回報)時,用 runner 的同一份編號逐項打勾。
 */
export function ScriptPanel({ script, caseName, caseVersion, lang, progress, live = false }: {
  script?: string;
  caseName?: string;
  caseVersion?: string;
  lang: RLang;
  progress?: ScriptProgress;
  /** 任務執行中(目前這一項標「進行中」;結束後標「停在這一步」)。 */
  live?: boolean;
}) {
  const parsed = useMemo(() => parseScript(script), [script]);
  // 預設收合:執行中專注在下指令與畫面;有即時進度時展開,才看得到打勾。
  const [open, setOpen] = useState(!!progress);
  const hasProgress = !!progress;
  useEffect(() => { if (hasProgress) setOpen(true); }, [hasProgress]);
  const bodyId = 'detail-script-body';
  const count = progress ? progress.items.length : parsed.steps.length;

  return (
    <section className="dscript" aria-labelledby="detail-script-title">
      <header className="dscript__head">
        <h2 id="detail-script-title" className="dscript__title">
          {tx('title', lang)}
          {progress ? (
            <span className={`dscript__count ${progress.done >= progress.items.length ? 'is-complete' : ''}`}>
              {tx('progress', lang).replace('{d}', String(progress.done)).replace('{n}', String(progress.items.length))}
            </span>
          ) : count > 0 && <span className="dscript__count">{tx('steps', lang).replace('{n}', String(count))}</span>}
        </h2>
        <button type="button" className="dscript__toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
          {open ? tx('hide', lang) : tx('show', lang)}
        </button>
      </header>
      {(caseName || caseVersion) && (
        <p className="dscript__case">
          {caseName && <span className="dscript__case-name">{caseName}</span>}
          {caseVersion && <span className="dscript__case-ver">{tx('version', lang)} {caseVersion}</span>}
        </p>
      )}
      <div id={bodyId} hidden={!open}>
        {progress ? (
          <>
            <ol className="dscript__list" aria-live="polite">
              {progress.items.map((text, i) => {
                const st = itemState(i, progress, live);
                return (
                  <li key={i} className={`dscript__step is-${st}`}>
                    <span className="dscript__num" aria-hidden="true">{st === 'done' ? '✓' : i + 1}</span>
                    <div className="dscript__text">
                      {text}
                      <span className="visually-hidden"> ({tx(st, lang)})</span>
                      {(st === 'current' || st === 'stopped') && <span className="dscript__now" aria-hidden="true">{tx(st, lang)}</span>}
                    </div>
                  </li>
                );
              })}
            </ol>
            <p className="dscript__hint">{tx('progressHint', lang)}</p>
          </>
        ) : (
          <>
            {parsed.intro.length > 0 && (
              <p className="dscript__intro">{parsed.intro.join(' ')}</p>
            )}
            {parsed.steps.length > 0 ? (
              <ol className="dscript__list">
                {parsed.steps.map((s, i) => (
                  <li key={i} className="dscript__step">
                    <span className="dscript__num" aria-hidden="true">{i + 1}</span>
                    <div className="dscript__text">
                      {s.text}
                      {s.sub.length > 0 && (
                        <ul className="dscript__sub">
                          {s.sub.map((x, k) => <li key={k}>{x}</li>)}
                        </ul>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            ) : parsed.intro.length === 0 ? (
              <p className="dscript__empty">{tx('empty', lang)}</p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
