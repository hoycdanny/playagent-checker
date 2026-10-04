import { Fragment, useEffect, useMemo, useState } from 'react';
import type { CheckItem, CheckResult, EvidenceStep, L10n } from './reportTypes.ts';
import { STATUS_TEXT, tr, txt, type RLang } from './reportText.ts';

export type CheckFilter = 'all' | CheckResult;
type KindFilter = 'all' | 'milestone' | 'step';
type GroupBy = 'module' | 'result' | 'none';

const FILTERS: CheckFilter[] = ['all', 'fail', 'unclear', 'pass', 'skipped'];
const RESULT_ORDER: CheckResult[] = ['fail', 'unclear', 'pass', 'skipped'];
const MS_GROUP = '__milestone';
const NO_GROUP = '__none';

/**
 * 判定明細表:每一列 = 一次通過/失敗判定。點擊列展開動作前後截圖、判定依據與修正建議。
 * 篩選由父層控制(執行摘要的 KPI 點擊會切換篩選並捲動到這裡)。
 */
export function VerdictMatrix({
  checks,
  evidence,
  lang,
  filter,
  onFilter,
  notes,
  onOpenImage,
  onGoFinding,
  modules = [],
  moduleFilter = null,
  onModuleFilter,
  focus,
}: {
  checks: CheckItem[];
  evidence: EvidenceStep[];
  lang: RLang;
  filter: CheckFilter;
  onFilter: (f: CheckFilter) => void;
  notes?: Record<string, L10n>;
  onOpenImage: (url: string) => void;
  onGoFinding: (id: string) => void;
  /** 功能模組定義(id → 名稱),用於「歸類」分組標題。 */
  modules?: Array<{ id: string; label: L10n }>;
  /** 只看某個模組(由「模組結果」表的數字點擊帶入);null = 不限。 */
  moduleFilter?: string | null;
  onModuleFilter?: (m: string | null) => void;
  /** 指定要展開並捲動到的判定(n 每次點擊遞增,同一列重複點也會觸發)。 */
  focus?: { id: string; n: number } | null;
}) {
  const [kind, setKind] = useState<KindFilter>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('module');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!focus) return;
    setKind('all');
    setOpen((prev) => new Set(prev).add(focus.id));
    // 等展開列渲染後再捲動。
    const t = window.setTimeout(() => {
      const el = document.getElementById(`vm-r-${focus.id}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('is-flash');
      window.setTimeout(() => el.classList.remove('is-flash'), 1600);
    }, 60);
    return () => window.clearTimeout(t);
  }, [focus]);
  const byIndex = useMemo(() => new Map(evidence.map((s) => [s.index, s])), [evidence]);
  const moduleLabel = useMemo(() => new Map(modules.map((m) => [m.id, m.label])), [modules]);
  const inScope = (c: CheckItem) => (kind === 'all' || c.kind === kind) && (!moduleFilter || c.module === moduleFilter);
  const count = (f: CheckFilter) => checks.filter((c) => (f === 'all' || c.result === f) && inScope(c)).length;
  const rows = checks.filter((c) => (filter === 'all' || c.result === filter) && inScope(c));
  const groupKey = (c: CheckItem): string =>
    groupBy === 'none' ? NO_GROUP
      : groupBy === 'result' ? c.result
        : c.kind === 'milestone' ? MS_GROUP : c.module ?? '';
  const groupTitle = (k: string): string => {
    if (k === MS_GROUP) return txt('overallMilestones', lang);
    if (k === '') return txt('uncategorized', lang);
    if (groupBy === 'result') return tr(STATUS_TEXT[k], lang) || k;
    const l = moduleLabel.get(k);
    return l ? tr(l, lang) : k;
  };
  // 分組(保持原順序;依結果分組時失敗排最前,方便先看問題)。
  const groups = (() => {
    const m = new Map<string, CheckItem[]>();
    for (const c of rows) {
      const k = groupKey(c);
      const list = m.get(k);
      if (list) list.push(c);
      else m.set(k, [c]);
    }
    const entries = [...m.entries()];
    if (groupBy === 'result') entries.sort((a, b) => RESULT_ORDER.indexOf(a[0] as CheckResult) - RESULT_ORDER.indexOf(b[0] as CheckResult));
    else if (groupBy === 'module') entries.sort((a, b) => (a[0] === MS_GROUP ? -1 : b[0] === MS_GROUP ? 1 : a[0] === '' ? 1 : b[0] === '' ? -1 : 0));
    return entries;
  })();
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const shot = (step?: number) => {
    if (step === undefined) return undefined;
    const s = byIndex.get(step);
    return s ? s.annotatedUrl ?? s.screenshotUrl : undefined;
  };
  const label = (f: CheckFilter) => (f === 'all' ? txt('all', lang) : tr(STATUS_TEXT[f], lang));

  return (
    <div className="vm">
      <div className="vm__bar">
        <div className="vm__tabs" role="tablist" aria-label={txt('verdicts', lang)}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`vm__tab vm__tab--${f} ${filter === f ? 'is-active' : ''}`}
              onClick={() => onFilter(f)}
            >
              {label(f)} <span className="vm__tab-count">{count(f)}</span>
            </button>
          ))}
        </div>
        <div className="vm__controls">
          {moduleFilter && (
            <span className="vm__chip">
              {txt('filteredBy', lang)}:{groupTitleFor(moduleFilter, moduleLabel, lang)}
              <button type="button" className="vm__chip-x" onClick={() => onModuleFilter?.(null)} aria-label={txt('clearFilter', lang)}>×</button>
            </span>
          )}
          <label className="vm__kind">
            <span className="vm__kind-label">{txt('groupBy', lang)}</span>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
              <option value="module">{txt('groupCategory', lang)}</option>
              <option value="result">{txt('groupResult', lang)}</option>
              <option value="none">{txt('groupNone', lang)}</option>
            </select>
          </label>
          <label className="vm__kind">
            <span className="visually-hidden">{txt('checkItem', lang)}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)}>
              <option value="all">{txt('all', lang)}</option>
              <option value="milestone">{txt('milestone', lang)}</option>
              <option value="step">{txt('stepCheck', lang)}</option>
            </select>
          </label>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="srep__muted vm__empty">{txt('noChecks', lang)}</p>
      ) : (
        <div className="srep__table-wrap">
          <table className="srep__table vm__table">
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">{txt('result', lang)}</th>
                <th scope="col">{txt('checkItem', lang)}</th>
                <th scope="col">{txt('screen', lang)}</th>
                <th scope="col">{txt('action', lang)}</th>
                <th scope="col">{txt('actual', lang)}</th>
                <th scope="col">{txt('basisCol', lang)}</th>
                <th scope="col">{txt('evidenceCol', lang)}</th>
                <th scope="col">{txt('suggestion', lang)}</th>
              </tr>
            </thead>
            {groups.map(([gk, list]) => (
            <tbody key={gk} className="vm__group">
              {gk !== NO_GROUP && (
                <tr className="vm__group-row">
                  <th scope="rowgroup" colSpan={9}>
                    <span className="vm__group-title">{groupTitle(gk)}</span>
                    <span className="vm__group-counts">
                      {RESULT_ORDER.map((res) => {
                        const n = list.filter((c) => c.result === res).length;
                        return n ? <span key={res} className={`vm__gc vm__gc--${res}`}>{tr(STATUS_TEXT[res], lang)} {n}</span> : null;
                      })}
                    </span>
                  </th>
                </tr>
              )}
              {list.map((c) => {
                const isOpen = open.has(c.id);
                const before = shot(c.step);
                const after = shot(c.afterStep);
                const sug = c.suggestion ? tr(c.suggestion, lang) : '';
                const note = notes?.[c.id];
                return (
                  <Fragment key={c.id}>
                    <tr id={`vm-r-${c.id}`} className={`vm__row vm__row--${c.result} ${isOpen ? 'is-open' : ''}`}>
                      <td className="srep__mono">
                        <button
                          type="button"
                          className="vm__toggle"
                          aria-expanded={isOpen}
                          aria-controls={`vm-d-${c.id}`}
                          onClick={() => toggle(c.id)}
                        >
                          <span aria-hidden="true" className="vm__caret">{isOpen ? '▾' : '▸'}</span>
                          {c.id}
                          <span className="visually-hidden">{isOpen ? txt('hideDetails', lang) : txt('viewDetails', lang)}</span>
                        </button>
                      </td>
                      <td><ResultPill r={c.result} lang={lang} /></td>
                      <td className="vm__wrap vm__item">
                        <span className={`srep__tag ${c.kind === 'milestone' ? 'vm__tag-ms' : ''}`}>{c.kind === 'milestone' ? txt('milestone', lang) : `#${c.step}`}</span>{' '}
                        {c.title ? tr(c.title, lang) : c.expected}
                        {c.module && <span className="srep__tag">{c.module}</span>}
                      </td>
                      <td className="vm__wrap vm__clip">{c.screen}</td>
                      <td className="srep__mono">{c.action}</td>
                      <td className="vm__wrap vm__clip">{c.actual ?? '—'}</td>
                      <td className="vm__wrap"><span className="vm__clamp">{c.reason ?? '—'}</span></td>
                      <td>
                        <div className="vm__thumbs">
                          {before && (
                            <button type="button" className="vm__thumb" onClick={() => onOpenImage(before)} aria-label={`${txt('before', lang)} #${c.step}`}>
                              <img src={before} alt="" loading="lazy" />
                            </button>
                          )}
                          {after && (
                            <button type="button" className="vm__thumb" onClick={() => onOpenImage(after)} aria-label={`${txt('after', lang)} #${c.afterStep}`}>
                              <img src={after} alt="" loading="lazy" />
                            </button>
                          )}
                          {!before && !after && '—'}
                        </div>
                      </td>
                      <td className="vm__wrap"><span className="vm__clamp">{sug || (c.result === 'pass' ? '—' : '')}</span></td>
                    </tr>
                    {isOpen && (
                      <tr className="vm__detail-row" id={`vm-d-${c.id}`}>
                        <td colSpan={9}>
                          <div className="vm__detail">
                            <div className="vm__shots">
                              <Shot url={before} caption={`${txt('before', lang)} · #${c.step}`} onOpen={onOpenImage} />
                              {c.afterStep !== undefined && <span className="vm__arrow" aria-hidden="true">→</span>}
                              {c.afterStep !== undefined && <Shot url={after} caption={`${txt('after', lang)} · #${c.afterStep}`} onOpen={onOpenImage} />}
                            </div>
                            <div className="vm__facts">
                              <dl className="vm__dl">
                                <div><dt>{txt('expected', lang)}</dt><dd>{c.expected}</dd></div>
                                <div><dt>{txt('actual', lang)}</dt><dd>{c.actual ?? '—'}</dd></div>
                                <div><dt>{txt('basisCol', lang)}</dt><dd>{c.reason ?? '—'}</dd></div>
                                <div>
                                  <dt>{txt('certainty', lang)}</dt>
                                  <dd>
                                    {tr(STATUS_TEXT[c.basis], lang)}
                                    {typeof c.confidence === 'number' && ` · ${txt('confidence', lang)} ${c.confidence.toFixed(2)}`}
                                    {typeof c.effective === 'boolean' && ` · ${txt('screenChanged', lang)}: ${c.effective ? txt('yes', lang) : txt('no', lang)}`}
                                  </dd>
                                </div>
                                {c.relatedFinding && (
                                  <div>
                                    <dt>{txt('relatedFinding', lang)}</dt>
                                    <dd><button type="button" className="vm__link" onClick={() => onGoFinding(c.relatedFinding!)}>{c.relatedFinding}</button></dd>
                                  </div>
                                )}
                              </dl>
                              {(sug || note) && (
                                <div className="vm__fix">
                                  {sug && (<><strong>{txt('suggestion', lang)}</strong><p>{sug}</p></>)}
                                  {note && (<><strong>{txt('aiNote', lang)}</strong><p>{tr(note, lang)}</p></>)}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

function groupTitleFor(id: string, labels: Map<string, L10n>, lang: RLang): string {
  const l = labels.get(id);
  return l ? tr(l, lang) : id;
}

export function ResultPill({ r, lang }: { r: string; lang: RLang }) {
  return <span className={`vm__pill vm__pill--${r}`}>{tr(STATUS_TEXT[r], lang) || r}</span>;
}

function Shot({ url, caption, onOpen }: { url?: string; caption: string; onOpen: (u: string) => void }) {
  return (
    <figure className="vm__shot">
      {url ? (
        <button type="button" className="vm__shot-btn" onClick={() => onOpen(url)} aria-label={caption}>
          <img src={url} alt="" loading="lazy" />
        </button>
      ) : (
        <div className="vm__shot-none" aria-hidden="true">—</div>
      )}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
