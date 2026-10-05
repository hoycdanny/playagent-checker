import { useMemo, useState } from 'react';
import type { RLang } from '../report/reportText.ts';
import { parseScript } from './scriptSteps.ts';

const T = {
  title: ['測試腳本', 'Test script'],
  steps: ['{n} 個步驟', '{n} steps'],
  empty: ['這次測試沒有指定腳本(自主探索)。', 'No script for this run (free exploration).'],
  show: ['展開', 'Show'],
  hide: ['收合', 'Hide'],
  version: ['版本', 'Version'],
} as const;
const tx = (k: keyof typeof T, lang: RLang) => T[k][lang === 'zh' ? 0 : 1];

/** 測試腳本:把案例 task 原文轉成編號條列,一眼看懂這次要測什麼。 */
export function ScriptPanel({ script, caseName, caseVersion, lang }: { script?: string; caseName?: string; caseVersion?: string; lang: RLang }) {
  const parsed = useMemo(() => parseScript(script), [script]);
  const [open, setOpen] = useState(false); // 預設收合:執行中專注在下指令與畫面
  const bodyId = 'detail-script-body';

  return (
    <section className="dscript" aria-labelledby="detail-script-title">
      <header className="dscript__head">
        <h2 id="detail-script-title" className="dscript__title">
          {tx('title', lang)}
          {parsed.steps.length > 0 && <span className="dscript__count">{tx('steps', lang).replace('{n}', String(parsed.steps.length))}</span>}
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
      </div>
    </section>
  );
}
